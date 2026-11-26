import { resolveLocale, t } from './i18n.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { safeStorage } from 'electron';
import type { FileSide, PasswordUpdate, Profile, ProfileDraft, ProfileGroup, Settings } from './protocol.js';

type StoredProfile = ProfileDraft & {
  id: string;
  encryptedPassword?: string;
  folders?: Partial<Record<FileSide, string>>;
  sftpHost?: { endpoint: string; key: string };
};

const defaults: Settings = { copyOnSelection: true, rightClickPaste: true };

function publicProfile({ encryptedPassword, folders: _folders, sftpHost: _sftpHost, ...profile }: StoredProfile): Profile {
  return { ...profile, groupId: profile.groupId ?? null, hasPassword: Boolean(encryptedPassword) };
}

function validate(draft: ProfileDraft): ProfileDraft {
  const name = draft.name.trim();
  const host = draft.host.trim().replace(/^\[([\da-f:.]+(?:%[\w.-]+)?)\]$/i, '$1');
  const username = draft.username.trim();
  const { port } = draft;
  if (!name || name.length > 80) throw new Error(t('Enter a name of up to 80 characters.'));
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,252}$/u.test(host) &&
      !/^(?=[\da-f:]*:)[\da-f:.]+(?:%[\w.-]+)?$/i.test(host)) {
    throw new Error(t('Enter a hostname, an alias from ssh_config, or an IP address.'));
  }
  if (username.length > 128 || /[\s\x00-\x1f\x7f]/u.test(username)) throw new Error(t('Check the username.'));
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(t('The port must be an integer between 1 and 65535.'));
  }
  return { name, host, username, port, tmux: draft.tmux === true, groupId: draft.groupId ?? null };
}

export class Profiles {
  private data: { profiles: StoredProfile[]; settings: Settings; groups?: ProfileGroup[] };

  constructor(private readonly file: string) {
    this.data = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { profiles: [], settings: defaults };
  }

  load() {
    return { profiles: this.data.profiles.map(publicProfile), settings: this.data.settings, groups: this.data.groups ?? [] };
  }

  get(id: string): Profile {
    return publicProfile(this.stored(id));
  }

  async save(id: string | null, draft: ProfileDraft, password: PasswordUpdate): Promise<Profile> {
    const values = validate(draft);
    let encryptedPassword: string | undefined;
    if (password.kind === 'store') {
      if (!values.username) throw new Error(t('Enter a username to save the password.'));
      if (!password.value || password.value.length > 4096 || /[\x00-\x1f\x7f]/u.test(password.value)) {
        throw new Error(t('The password must contain 1 to 4096 characters and no control characters.'));
      }
      if (!await safeStorage.isAsyncEncryptionAvailable() ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error(t('The system password store is unavailable.'));
      }
      encryptedPassword = (await safeStorage.encryptStringAsync(password.value)).toString('base64');
    }

    const previous = id ? this.stored(id) : undefined;
    const groupId = draft.groupId === undefined ? previous?.groupId ?? null : values.groupId;
    if (groupId && !this.data.groups?.some((group) => group.id === groupId)) throw new Error(t('Group not found.'));
    const sameServer = previous && values.host === previous.host &&
      values.username === previous.username && values.port === previous.port;
    if (sameServer && password.kind === 'keep') encryptedPassword = previous.encryptedPassword;
    const profile: StoredProfile = {
      ...values, groupId, id: id ?? randomUUID(), encryptedPassword,
      folders: sameServer ? previous.folders : { local: previous?.folders?.local },
      sftpHost: sameServer ? previous.sftpHost : undefined,
    };
    const profiles = id
      ? this.data.profiles.map((item) => item.id === id ? profile : item)
      : [...this.data.profiles, profile];
    this.commit({ ...this.data, profiles });
    return publicProfile(profile);
  }

  delete(id: string) {
    this.commit({ ...this.data, profiles: this.data.profiles.filter((profile) => profile.id !== id) });
  }

  saveGroup(id: string | null, input: string): ProfileGroup {
    const name = typeof input === 'string' ? input.trim() : '';
    if (!name || name.length > 60) throw new Error(t('Enter a group name of up to 60 characters.'));
    const groups = this.data.groups ?? [];
    if (id && !groups.some((group) => group.id === id)) throw new Error(t('Group not found.'));
    if (groups.some((group) => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(t('A group with that name already exists.'));
    }
    const group = { id: id ?? randomUUID(), name };
    this.commit({ ...this.data, groups: id ? groups.map((item) => item.id === id ? group : item) : [...groups, group] });
    return group;
  }

  deleteGroup(id: string) {
    const groups = (this.data.groups ?? []).filter((group) => group.id !== id);
    const profiles = this.data.profiles.map((profile) => profile.groupId === id ? { ...profile, groupId: null } : profile);
    this.commit({ ...this.data, groups, profiles });
  }

  settings(settings: Settings) {
    this.commit({
      ...this.data,
      settings: {
        copyOnSelection: settings.copyOnSelection === true,
        rightClickPaste: settings.rightClickPaste === true,
        language: resolveLocale(settings.language),
      },
    });
  }

  folders(id: string) {
    return this.stored(id).folders ?? {};
  }

  rememberFolder(profile: Profile, side: FileSide, path: string) {
    const current = this.stored(profile.id);
    if (side === 'remote' && !this.sameEndpoint(current, profile)) return;
    if (current.folders?.[side] !== path) this.update(current, { folders: { ...current.folders, [side]: path } });
  }

  sftpKey(profile: Profile, endpoint: string) {
    const current = this.stored(profile.id);
    return this.sameEndpoint(current, profile) && current.sftpHost?.endpoint === endpoint
      ? current.sftpHost.key : undefined;
  }

  trustSftpKey(profile: Profile, endpoint: string, key: string) {
    const current = this.stored(profile.id);
    if (!this.sameEndpoint(current, profile)) throw new Error(t('The profile changed. Open a new SFTP tab.'));
    const known = this.sftpKey(profile, endpoint);
    if (known && known !== key) throw new Error(t('The host key changed.'));
    if (!known) this.update(current, { sftpHost: { endpoint, key } });
  }

  replaceSftpKey(profile: Profile, endpoint: string, previous: string, key: string) {
    const current = this.stored(profile.id);
    if (this.sftpKey(profile, endpoint) !== previous) {
      throw new Error(t('The saved key or profile changed. Connect again.'));
    }
    this.update(current, { sftpHost: { endpoint, key } });
  }

  async password(profile: Profile): Promise<string> {
    const current = this.stored(profile.id);
    if (!current.encryptedPassword || current.host !== profile.host ||
        current.username !== profile.username || current.port !== profile.port) {
      throw new Error(t('This connection has no saved password.'));
    }
    const result = await safeStorage.decryptStringAsync(Buffer.from(current.encryptedPassword, 'base64'));
    const latest = this.stored(profile.id);
    if (latest.encryptedPassword !== current.encryptedPassword) {
      throw new Error(t('The password changed. Try again.'));
    }
    return result.result;
  }

  private stored(id: string): StoredProfile {
    const profile = this.data.profiles.find((item) => item.id === id);
    if (!profile) throw new Error(t('Profile not found.'));
    return profile;
  }

  private sameEndpoint(profile: StoredProfile, other: Profile) {
    return profile.host === other.host && profile.username === other.username && profile.port === other.port;
  }

  private update(profile: StoredProfile, changes: Partial<StoredProfile>) {
    const profiles = this.data.profiles.map((item) => item.id === profile.id ? { ...item, ...changes } : item);
    this.commit({ ...this.data, profiles });
  }

  private commit(next: typeof this.data) {
    const temp = this.file + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(temp, this.file);
      this.data = next;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
