import { t } from './i18n.js';
import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client, type Attributes, type SFTPWrapper, type Stats } from 'ssh2';
import type { CopyProgress, FileCommand, FileEntry, FileListing, FileSide, PermissionChanges, Profile, RemotePermissions } from './protocol.js';
import type { Profiles } from './profiles.js';
import { connectSftp } from './sftp-connection.js';
import type { ConfirmKeyChange } from './known-hosts.js';

function value<T>(call: (done: (error: Error | undefined | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => call((error, result) => error ? reject(error) : resolve(result)));
}

function done(call: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => call((error) => error ? reject(error) : resolve()));
}

function sideOf(side: FileSide): FileSide {
  if (side !== 'local' && side !== 'remote') throw new Error(t('Unknown file pane.'));
  return side;
}

function validName(name: string, side: FileSide) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\0]/.test(name)) {
    throw new Error(t('Invalid file name.'));
  }
  if (side === 'local' && process.platform === 'win32' &&
    (/[<>:"\\|?*\x00-\x1f]|[. ]$/u.test(name) ||
      /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?: *\.|$)/iu.test(name))) {
    throw new Error(t('The name is incompatible with Windows: {name}', { name }));
  }
  return name;
}

function kind(mode: number): FileEntry['kind'] {
  switch (mode & constants.S_IFMT) {
    case constants.S_IFDIR: return 'directory';
    case constants.S_IFREG: return 'file';
    case constants.S_IFLNK: return 'link';
    default: return 'other';
  }
}

function remoteEntry(name: string, info: Attributes): FileEntry {
  return { name, size: info.size ?? 0, modified: info.mtime * 1000 || 0, kind: kind(info.mode) };
}

function localEntry(name: string, info: import('node:fs').Stats): FileEntry {
  return {
    name, size: info.size, modified: info.mtimeMs,
    kind: info.isSymbolicLink() ? 'link' : kind(info.mode),
  };
}

interface CopyItem {
  source: string;
  target: string;
  size: number | null;
}

function accountId(id: number) {
  return Number.isInteger(id) && id >= 0 && id < 0xffffffff;
}

export class FilesSession {
  private readonly client = new Client();
  private readonly stop = new AbortController();
  private readonly folders: Partial<Record<FileSide, string>> = {};
  private sftp?: SFTPWrapper;
  private busy = false;
  private closed = false;
  private disconnected?: Promise<void>;

  constructor(
    private readonly profile: Profile, private readonly profiles: Profiles,
    private readonly initialFolders: Partial<Record<FileSide, string>> = {},
  ) {
    this.client.on('close', () => { this.closed = true; this.sftp = undefined; });
  }

  async connect(
    confirm: (endpoint: string, fingerprint: string, signal: AbortSignal) => Promise<boolean>,
    confirmChange: ConfirmKeyChange, password?: string,
  ) {
    try {
      this.sftp = await connectSftp(this.client, this.profile, this.profiles, this.stop.signal, confirm, confirmChange, password);
      return await this.list('remote');
    } catch (error) {
      if (!this.stop.signal.aborted) this.client.destroy();
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.disconnected) return this.disconnected;
    this.stop.abort();
    this.sftp = undefined;
    if (this.closed) return Promise.resolve();
    this.disconnected = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.client.removeListener('close', finish);
        resolve();
      };
      const timeout = setTimeout(() => { this.client.destroy(); finish(); }, 1500);
      this.client.once('close', finish);
      this.client.end();
    });
    return this.disconnected;
  }

  locations(profile: Profile) {
    const sameServer = profile.host === this.profile.host && profile.port === this.profile.port &&
      profile.username === this.profile.username;
    return sameServer ? { ...this.folders } : { local: this.folders.local };
  }

  async list(side: FileSide, input?: string): Promise<FileListing> {
    sideOf(side);
    if (this.busy) throw new Error(t('Wait until the file operation finishes.'));
    this.stop.signal.throwIfAborted();
    if (input !== undefined && (typeof input !== 'string' || !input || input.length > 32768 || input.includes('\0'))) {
      throw new Error(t('Invalid path.'));
    }
    const fallback = side === 'local' ? homedir() : '.';
    const previous = this.folders[side];
    const saved = previous ?? this.initialFolders[side] ?? this.profiles.folders(this.profile.id)[side];
    let listing: FileListing;
    try {
      listing = await this.readFolder(side, input ?? saved ?? fallback);
    } catch (error) {
      if (input !== undefined || previous || !saved) throw error;
      listing = await this.readFolder(side, fallback);
    }
    this.stop.signal.throwIfAborted();
    this.folders[side] = listing.path;
    if (!previous || input !== undefined) this.profiles.rememberFolder(this.profile, side, listing.path);
    return listing;
  }

  async permissions(name: string): Promise<RemotePermissions> {
    this.stop.signal.throwIfAborted();
    const target = this.child('remote', this.folder('remote'), name);
    const info = await this.remoteStat(target);
    if (!info.isDirectory() && !info.isFile()) throw new Error(t('Permissions are available for files and folders.'));
    return { mode: info.mode & 0o7777, uid: accountId(info.uid) ? info.uid : null,
      gid: accountId(info.gid) ? info.gid : null, directory: info.isDirectory() };
  }

  async run(command: FileCommand, progress: (state: CopyProgress) => void) {
    this.stop.signal.throwIfAborted();
    const side = sideOf(command.side);
    const root = this.folder(side);
    if (this.busy) throw new Error(t('A file operation is already running.'));
    this.busy = true;
    try {
      if (command.type === 'mkdir') {
        await this.mkdir(side, this.child(side, root, command.name));
      } else if (command.type === 'rename') {
        const source = this.child(side, root, command.name);
        const target = this.child(side, root, command.newName);
        if (source !== target) {
          await this.checkMissing(side, target);
          await this.rename(side, source, target);
        }
      } else if (command.type === 'permissions' && side === 'remote') {
        const changes = command.changes;
        if (!changes || !Number.isInteger(changes.mode) || changes.mode < 0 || changes.mode > 0o7777 ||
          (changes.uid !== null && !accountId(changes.uid)) || (changes.gid !== null && !accountId(changes.gid)) ||
          typeof changes.recursive !== 'boolean') {
          throw new Error(t('Invalid permissions, UID, or GID.'));
        }
        const target = this.child('remote', root, command.name);
        if (!(await this.permissions(command.name)).directory && changes.recursive) {
          throw new Error(t('Recursive changes are available for folders only.'));
        }
        await this.applyPermissions(target, changes);
      } else if (command.type === 'copy' || command.type === 'delete') {
        if (!Array.isArray(command.names) || !command.names.length || command.names.length > 10000) {
          throw new Error(t('Select files or folders.'));
        }
        const names = [...new Set(command.names)];
        const sources = names.map((name) => this.child(side, root, name));
        if (command.type === 'delete') {
          for (const source of sources) await this.remove(side, source);
        } else {
          const opposite = side === 'local' ? 'remote' : 'local';
          const destination = this.folder(opposite);
          const targets = names.map((name) => this.child(opposite, destination, name));
          await this.copyBatch(side, sources, opposite, targets, progress);
        }
      } else {
        throw new Error(t('Unknown file operation.'));
      }
    } finally {
      this.busy = false;
    }
  }

  private folder(side: FileSide) {
    const folder = this.folders[side];
    if (!folder) throw new Error(t('Open a folder first.'));
    return folder;
  }

  private remote() {
    if (!this.sftp) throw new Error(t('The SFTP connection is closed. Connect again.'));
    return this.sftp;
  }

  private child(side: FileSide, parent: string, name: string) {
    const paths = side === 'local' ? path : path.posix;
    return paths.join(parent, validName(name, side));
  }

  private async readFolder(side: FileSide, input: string): Promise<FileListing> {
    const paths = side === 'local' ? path : path.posix;
    const requested = paths.isAbsolute(input) ? input : paths.join(this.folders[side] ?? (side === 'local' ? homedir() : '.'), input);
    const canonical = side === 'local' ? await fs.realpath(requested)
      : await value<string>((callback) => this.remote().realpath(requested, callback));
    const entries = await this.children(side, canonical);
    const parent = paths.dirname(canonical);
    return { path: canonical, parent: parent === canonical ? null : parent, entries };
  }

  private async children(side: FileSide, dir: string): Promise<FileEntry[]> {
    if (side === 'remote') {
      const rows = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => {
        this.remote().readdir(dir, (error, data) => error ? reject(error) : resolve(data));
      });
      return rows.filter(({ filename }) => filename && filename !== '.' && filename !== '..' && !/[\/\0]/.test(filename))
        .map((item) => remoteEntry(item.filename, item.attrs));
    }
    const rows = await fs.readdir(dir);
    const entries: FileEntry[] = [];
    for (let offset = 0; offset < rows.length; offset += 32) {
      this.stop.signal.throwIfAborted();
      const batch = await Promise.all(rows.slice(offset, offset + 32).map(async (name) => {
        try { return localEntry(name, await fs.lstat(path.join(dir, name))); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        }
      }));
      entries.push(...batch.filter((item) => item !== undefined));
    }
    return entries;
  }

  private stat(side: FileSide, target: string) {
    return side === 'local' ? fs.lstat(target) : this.remoteStat(target);
  }

  private remoteStat(target: string) {
    return value<Stats>((callback) => this.remote().lstat(target, callback));
  }

  private async checkMissing(side: FileSide, target: string) {
    try {
      await this.stat(side, target);
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 'ENOENT' || (side === 'remote' && code === 2)) return;
      throw error;
    }
    throw new Error(t('“{name}” already exists in the destination folder.', { name: (side === 'local' ? path : path.posix).basename(target) }));
  }

  private mkdir(side: FileSide, target: string) {
    return side === 'local' ? fs.mkdir(target) : done((callback) => this.remote().mkdir(target, callback));
  }

  private rename(side: FileSide, source: string, target: string) {
    return side === 'local' ? fs.rename(source, target) : done((callback) => this.remote().rename(source, target, callback));
  }

  private unlink(side: FileSide, target: string) {
    return side === 'local' ? fs.unlink(target) : done((callback) => this.remote().unlink(target, callback));
  }

  private async remove(side: FileSide, target: string) {
    this.stop.signal.throwIfAborted();
    const info = await this.stat(side, target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      await this.unlink(side, target);
      return;
    }
    for (const row of await this.children(side, target)) await this.remove(side, this.child(side, target, row.name));
    if (side === 'local') await fs.rmdir(target);
    else await done((callback) => this.remote().rmdir(target, callback));
  }

  private async applyPermissions(target: string, changes: PermissionChanges) {
    this.stop.signal.throwIfAborted();
    const info = await this.remoteStat(target);
    if (info.isSymbolicLink()) return;
    if (changes.recursive && info.isDirectory()) {
      for (const entry of await this.children('remote', target)) {
        await this.applyPermissions(this.child('remote', target, entry.name), changes);
      }
    }
    this.stop.signal.throwIfAborted();
    const uid = changes.uid ?? info.uid;
    const gid = changes.gid ?? info.gid;
    const changeOwner = (changes.uid !== null && changes.uid !== info.uid) ||
      (changes.gid !== null && changes.gid !== info.gid);
    try {
      if (changeOwner) {
        if (!accountId(uid) || !accountId(gid)) throw new Error(t('The server did not provide the current UID or GID. Specify both.'));
        await done((callback) => this.remote().chown(target, uid, gid, callback));
      }
      if (changeOwner || (info.mode & 0o7777) !== changes.mode) {
        await done((callback) => this.remote().chmod(target, changes.mode, callback));
      }
    } catch (error) {
      throw new Error(target + ' — ' + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }

  private async planCopy(from: FileSide, source: string, to: FileSide, target: string, plan: CopyItem[]) {
    this.stop.signal.throwIfAborted();
    const info = await this.stat(from, source);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      plan.push({ source, target, size: null });
      for (const row of await this.children(from, source)) {
        await this.planCopy(from, this.child(from, source, row.name), to, this.child(to, target, row.name), plan);
      }
      return;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(t('Copying links and special files is not supported.'));
    plan.push({ source, target, size: info.size ?? 0 });
  }

  private async copyBatch(
    from: FileSide, sources: string[], to: FileSide, targets: string[], progress: (state: CopyProgress) => void,
  ) {
    progress({ phase: 'scan' });
    const plan: CopyItem[] = [];
    for (let index = 0; index < sources.length; index++) {
      await this.checkMissing(to, targets[index]);
      await this.planCopy(from, sources[index], to, targets[index], plan);
    }
    let expected = 0;
    let totalFiles = 0;
    for (const item of plan) {
      if (item.size !== null) { expected += item.size; totalFiles++; }
    }
    let bytes = 0;
    let files = 0;
    let name = '';
    let lastReport = -Infinity;
    const started = performance.now();
    const report = (current: number, force = false) => {
      const now = performance.now();
      if (!force && now - lastReport < 125) return;
      lastReport = now;
      const copied = bytes + current;
      const totalBytes = Math.max(expected, copied);
      const elapsed = (now - started) / 1000;
      const remaining = copied > 0 && elapsed >= 0.2 && totalBytes > copied
        ? Math.ceil((totalBytes - copied) * elapsed / copied) : null;
      progress({ phase: 'copy', name, bytes: copied, totalBytes, files, totalFiles, remaining });
    };
    report(0, true);
    for (const item of plan) {
      this.stop.signal.throwIfAborted();
      name = (from === 'local' ? path : path.posix).basename(item.source);
      const info = await this.stat(from, item.source);
      if (info.isSymbolicLink() || (item.size === null ? !info.isDirectory() : !info.isFile())) {
        throw new Error(t('The item type changed during copying: {name}', { name }));
      }
      if (item.size === null) {
        await this.mkdir(to, item.target);
        report(0);
      } else {
        expected += (info.size ?? 0) - item.size;
        const written = await this.copyFile(from, item.source, to, item.target, report);
        expected += written - (info.size ?? 0);
        bytes += written;
        files++;
        report(0);
      }
    }
    report(0, true);
  }

  private async copyFile(from: FileSide, source: string, to: FileSide, target: string, report: (bytes: number) => void) {
    const sftp = this.remote();
    const paths = to === 'local' ? path : path.posix;
    const temp = paths.join(paths.dirname(target), '.ssh-workspace-' + randomUUID() + '.part');
    const reader = from === 'local' ? createReadStream(source) : sftp.createReadStream(source);
    const writer = to === 'local' ? createWriteStream(temp, { flags: 'wx' })
      // ssh2 updates bytesWritten once the server acknowledges a write.
      : sftp.createWriteStream(temp, { flags: 'wx' }) as ReturnType<SFTPWrapper['createWriteStream']> & { bytesWritten: number };
    let created = false;
    writer.once('open', () => { created = true; });
    const timer = setInterval(() => report(writer.bytesWritten), 150);
    try {
      await pipeline(reader, writer, { signal: this.stop.signal });
      this.stop.signal.throwIfAborted();
      if (to === 'local') await fs.copyFile(temp, target, constants.COPYFILE_EXCL);
      else await this.rename(to, temp, target);
      return writer.bytesWritten;
    } finally {
      clearInterval(timer);
      if (created) {
        if (to === 'local') await fs.unlink(temp).catch(() => {});
        else await done((callback) => sftp.unlink(temp, callback)).catch(() => {});
      }
    }
  }
}
