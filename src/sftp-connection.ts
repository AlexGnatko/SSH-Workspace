import { t } from './i18n.js';
import { readFile, stat } from 'node:fs/promises';
import { Client, utils, type AuthMethod, type KeyboardInteractiveAuthMethod, type SFTPWrapper } from 'ssh2';
import { fingerprint, keyType, planKnownReplacement, readKnownHosts, sameKnownFile, type ConfirmKeyChange } from './known-hosts.js';
import type { Profile } from './protocol.js';
import type { Profiles } from './profiles.js';
import { expandSshPath, readSshConfig } from './ssh-config.js';

export async function connectSftp(
  client: Client, profile: Profile, profiles: Profiles, signal: AbortSignal,
  confirm: (endpoint: string, fingerprint: string, signal: AbortSignal) => Promise<boolean>,
  confirmChange: ConfirmKeyChange, inputPassword?: string,
): Promise<SFTPWrapper> {
  const { get, values, configured, proxy, globalKnownHosts, userKnownHosts } = await readSshConfig(profile, signal);
  if (proxy) throw new Error(t('SFTP via ProxyJump or ProxyCommand is not yet supported.'));
  if (configured('revokedhostkeys') || configured('knownhostscommand')) {
    throw new Error(t('SFTP with RevokedHostKeys or KnownHostsCommand configured is not yet supported.'));
  }
  const host = get('hostname') ?? profile.host;
  const port = Number(get('port') ?? profile.port ?? 22);
  const username = get('user') ?? profile.username;
  const endpoint = port === 22 ? host : '[' + host + ']:' + port;
  const lookup = get('hostkeyalias') ?? endpoint;
  const files = [...userKnownHosts, ...globalKnownHosts];
  const password = inputPassword ?? (profile.hasPassword ? await profiles.password(profile) : undefined);

  const methods: AuthMethod[] = [{ type: 'none', username }];
  if (password && get('passwordauthentication') !== 'no') methods.push(Object.assign({ type: 'password' as const, username }, { password }));
  if (!['no', 'false'].includes(get('pubkeyauthentication') ?? '')) {
    for (const path of values.get('identityfile') ?? []) {
      try {
        const file = expandSshPath(path);
        if ((await stat(file)).size > 1024 * 1024) continue;
        const parsed = utils.parseKey(await readFile(file));
        if (!(parsed instanceof Error) && !Array.isArray(parsed) && parsed.isPrivateKey()) {
          methods.push(Object.assign({ type: 'publickey' as const, username }, { key: parsed }));
        }
      } catch {
        // OpenSSH's default key list also contains files that may not exist.
      }
    }
    const configuredAgent = get('identityagent');
    const agent = configuredAgent && configuredAgent !== 'SSH_AUTH_SOCK' ? expandSshPath(configuredAgent)
      : process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    if (agent && configuredAgent !== 'none' && get('identitiesonly') !== 'yes') {
      methods.push(Object.assign({ type: 'agent' as const, username }, { agent }));
    }
  }
  if (password && get('kbdinteractiveauthentication') !== 'no') {
    const keyboard: KeyboardInteractiveAuthMethod = {
      type: 'keyboard-interactive', username,
      prompt: (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.length === 1 && !prompts[0].echo && /^(?:.*[’']s )?password:\s*$/i.test(prompts[0].prompt.trim())
          ? [password] : []);
      },
    };
    methods.push(keyboard);
  }
  signal.throwIfAborted();

  const disconnected = new AbortController();
  const verification = AbortSignal.any([signal, disconnected.signal]);
  let trustError: Error | undefined;
  const verifyKey = async (key: Buffer) => {
    const known = await readKnownHosts(lookup, files, verification);
    const encoded = key.toString('base64');
    if (known.revoked.has(encoded)) throw new Error(t('The host key is revoked in known_hosts.'));
    const pinned = profiles.sftpKey(profile, endpoint);
    const next = fingerprint(key);
    if (known.keys.has(encoded) || (!known.keys.size && pinned === encoded)) return true;
    if (known.certificateAuthority) throw new Error(t('This host uses an SSH certificate authority. SFTP certificate verification is not yet supported.'));
    if (known.keys.size) {
      const regular = known.records.filter((entry) => !entry.marker);
      const matchingType = regular.filter((entry) => entry.type === keyType(key));
      const candidates = matchingType.length ? matchingType : regular;
      const entry = candidates[0];
      if (candidates.length !== 1 || !userKnownHosts.some((file) => sameKnownFile(file, entry.file)) ||
          globalKnownHosts.some((file) => sameKnownFile(file, entry.file))) {
        throw new Error(t('The host key changed. No unique known_hosts entry could be selected for replacement.'));
      }
      const replace = planKnownReplacement(entry, lookup, key);
      if (!await confirmChange({ endpoint: lookup, previous: fingerprint(entry.key), next }, verification)) {
        throw new Error(t('The new host key was not confirmed.'));
      }
      verification.throwIfAborted();
      replace();
      if (pinned && profiles.sftpKey(profile, endpoint) === pinned) profiles.replaceSftpKey(profile, endpoint, pinned, encoded);
      return true;
    }
    if (pinned) {
      if (!await confirmChange({ endpoint: lookup, previous: fingerprint(pinned), next }, verification)) {
        throw new Error(t('The new host key was not confirmed.'));
      }
      verification.throwIfAborted();
      profiles.replaceSftpKey(profile, endpoint, pinned, encoded);
      return true;
    }
    if (get('stricthostkeychecking') === 'yes') throw new Error(t('Add the host key to known_hosts first.'));
    if (!await confirm(lookup, next, verification)) throw new Error(t('The host key was not confirmed.'));
    verification.throwIfAborted();
    profiles.trustSftpKey(profile, endpoint, encoded);
    return true;
  };

  return new Promise((resolve, reject) => {
    client.on('error', (error) => reject(trustError ?? error));
    client.once('close', () => {
      disconnected.abort();
      reject(trustError ?? new Error(t('The SFTP connection closed.')));
    });
    client.once('ready', () => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
    client.connect({
      host, port, username, authHandler: methods,
      readyTimeout: 120_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        void verifyKey(key).then(verify, (error: Error) => { trustError = error; verify(false); });
      },
    });
  });
}
