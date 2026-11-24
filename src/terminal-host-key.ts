import { t } from './i18n.js';
import { isIP } from 'node:net';
import { Client, type ServerHostKeyAlgorithm } from 'ssh2';
import { fingerprint, keyType, planKnownReplacement, readKnownHosts, sameKnownFile, type ConfirmKeyChange } from './known-hosts.js';
import type { Profile } from './protocol.js';
import { readSshConfig } from './ssh-config.js';

export function isChangedHostKey(log: string) {
  return /^@+\s*WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\s*@+\r?$/m.test(log) &&
    /^Host key verification failed\.\r?$/m.test(log);
}

function readPresentedKey(host: string, port: number, type: string, signal: AbortSignal) {
  const algorithms: ServerHostKeyAlgorithm[] = type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256']
    : [type as ServerHostKeyAlgorithm];
  return new Promise<Buffer>((resolve, reject) => {
    signal.throwIfAborted();
    const client = new Client();
    let key: Buffer | undefined;
    const abort = () => {
      client.destroy();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    client.on('error', (error) => { if (!key) reject(error); });
    client.once('close', () => {
      signal.removeEventListener('abort', abort);
      if (key) resolve(key);
      else reject(new Error(t('Не удалось получить открытый ключ сервера.')));
    });
    try {
      client.connect({
        host, port, username: 'host-key-check', readyTimeout: 5000,
        algorithms: { serverHostKey: algorithms },
        authHandler: () => false,
        hostVerifier: (presented: Buffer) => {
          key = Buffer.from(presented);
          return false; // Abort before user authentication.
        },
      });
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

export async function replaceTerminalHostKey(
  profile: Profile, log: string, confirm: ConfirmKeyChange, signal: AbortSignal,
) {
  const stored = /^Offending \S+ key in (.+):(\d+)\r?$/m.exec(log);
  const offered = /^debug1: Server host key: (\S+) (SHA256:[A-Za-z0-9+/]+)\r?$/m.exec(log);
  const connection = [...log.matchAll(/^debug1: Connecting to .* \[([^\]]+)\] port (\d+)\.\r?$/gm)].at(-1);
  const address = connection?.[1];
  const port = Number(connection?.[2]);
  const type = offered?.[1];
  if (!stored || !offered || !address || !isIP(address) || !type ||
      !/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))$/.test(type)) {
    throw new Error(t('Не удалось однозначно определить старый и новый ключи OpenSSH.'));
  }
  const config = await readSshConfig(profile, signal);
  if (config.proxy || config.configured('revokedhostkeys') || config.configured('knownhostscommand')) {
    throw new Error(t('В этой конфигурации OpenSSH автоматическая замена ключа недоступна.'));
  }
  const host = config.get('hostname') ?? profile.host;
  const configuredPort = Number(config.get('port') ?? profile.port ?? 22);
  const lookup = config.get('hostkeyalias') ?? (port === 22 ? host : '[' + host + ']:' + port);
  const all = [...config.userKnownHosts, ...config.globalKnownHosts];
  const known = await readKnownHosts(lookup, all, signal);
  const entry = known.records.find((record) => record.line === Number(stored[2]) && sameKnownFile(record.file, stored[1]));
  if (port !== configuredPort || !entry || entry.marker || known.certificateAuthority ||
      !config.userKnownHosts.some((file) => sameKnownFile(file, entry.file)) ||
      config.globalKnownHosts.some((file) => sameKnownFile(file, entry.file))) {
    throw new Error(t('Ключ нельзя заменить в пользовательском known_hosts для этого сервера.'));
  }
  const key = await readPresentedKey(address, port, type, signal);
  const next = fingerprint(key);
  const previous = fingerprint(entry.key);
  if (keyType(key) !== type || next !== offered[2] || previous === next || known.revoked.has(key.toString('base64'))) {
    throw new Error(t('Ключ при повторной проверке отличается или отозван. Подключитесь снова.'));
  }
  const replace = planKnownReplacement(entry, lookup, key);
  if (!await confirm({ endpoint: lookup, previous, next }, signal)) return false;
  signal.throwIfAborted();
  replace();
  return true;
}
