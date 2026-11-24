import { t } from './i18n.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { openSsh } from './ssh-config.js';

const exec = promisify(execFile);

interface RecordEntry {
  file: string;
  line: number;
  marker?: string;
  hosts: string;
  type: string;
  key: string;
}

export interface KeyChange {
  endpoint: string;
  previous: string;
  next: string;
}

export type ConfirmKeyChange = (change: KeyChange, signal: AbortSignal) => Promise<boolean>;

export function fingerprint(key: string | Buffer) {
  return 'SHA256:' + createHash('sha256').update(typeof key === 'string' ? Buffer.from(key, 'base64') : key)
    .digest('base64').replace(/=+$/, '');
}

export function keyType(key: Buffer) {
  if (key.length < 5) return '';
  const length = key.readUInt32BE(0);
  if (length > 100 || length > key.length - 4) return '';
  return key.toString('ascii', 4, length + 4);
}

export function sameKnownFile(left: string, right: string) {
  try {
    const canonical = (file: string) => {
      const path = realpathSync.native(file);
      return process.platform === 'win32' ? path.toLowerCase() : path;
    };
    return canonical(left) === canonical(right);
  } catch {
    return false;
  }
}

export async function readKnownHosts(host: string, files: string[], signal: AbortSignal) {
  const records: RecordEntry[] = [];
  for (const file of [...new Set(files)]) {
    signal.throwIfAborted();
    try {
      lstatSync(file);
      const { stdout } = await exec(openSsh('ssh-keygen'), ['-F', host, '-f', file], { timeout: 4000, windowsHide: true, signal });
      let number = 0;
      for (const line of stdout.split(/\r?\n/)) {
        const header = /^# Host .+ found: line (\d+)\s*$/.exec(line);
        if (header) number = Number(header[1]);
        else if (number && line && !line.startsWith('#')) {
          const parts = line.trim().split(/\s+/);
          const marker = parts[0].startsWith('@') ? parts.shift() : undefined;
          const [hosts, type, key] = parts;
          if (hosts && type && key) records.push({ file, line: number, marker, hosts, type, key });
          number = 0;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      const failure = error as { code?: number | string; stderr?: string };
      if (failure.code !== 'ENOENT' && (failure.code !== 1 || failure.stderr?.trim())) {
        throw new Error(t('Не удалось прочитать known_hosts.'), { cause: error });
      }
    }
  }
  return {
    records,
    keys: new Set(records.filter((record) => !record.marker).map((record) => record.key)),
    revoked: new Set(records.filter((record) => record.marker === '@revoked').map((record) => record.key)),
    certificateAuthority: records.some((record) => record.marker === '@cert-authority'),
  };
}

export function planKnownReplacement(record: RecordEntry, lookup: string, newKey: Buffer) {
  const file = realpathSync.native(record.file);
  const stats = lstatSync(file);
  const entries = record.hosts.split(',');
  const hashed = entries.length === 1 && /^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(entries[0]);
  const index = entries.findIndex((host) => host.toLowerCase() === lookup.toLowerCase());
  const type = keyType(newKey);
  if (record.marker || !stats.isFile() || !/^[a-zA-Z0-9._@%:\[\]-]+$/.test(lookup) ||
      (!hashed && (index < 0 || entries.some((host) => /[!*?]/.test(host)))) ||
      !/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))$/.test(type)) {
    throw new Error(t('Эту запись known_hosts нельзя безопасно заменить из клиента.'));
  }
  const original = readFileSync(file);
  // Latin-1 preserves untouched bytes, including non-ASCII comments.
  const lines = original.toString('latin1').split(/(\r?\n)/);
  const position = (record.line - 1) * 2;
  const parts = /^(\s*)(\S+)(\s+\S+\s+\S+)(.*)$/.exec(lines[position] ?? '');
  if (!parts || parts[2] !== record.hosts || parts[3].trim().split(/\s+/).join(' ') !== record.type + ' ' + record.key) {
    throw new Error(t('known_hosts изменился. Подключитесь снова, чтобы обновить отпечатки.'));
  }
  const separator = lines[position + 1] || (lines.includes('\r\n') ? '\r\n' : '\n');
  const replacement = parts[1] + (hashed ? record.hosts : entries[index]) + ' ' + type + ' ' + newKey.toString('base64') + parts[4];
  const otherHosts = hashed ? [] : entries.filter((_, entry) => entry !== index);
  lines[position] = otherHosts.length
    ? parts[1] + otherHosts.join(',') + parts[3] + parts[4] + separator + replacement : replacement;
  return () => {
    if (!readFileSync(file).equals(original)) throw new Error(t('known_hosts изменился. Подключитесь снова, чтобы обновить отпечатки.'));
    const temp = join(dirname(file), '.ssh-workspace-' + randomUUID());
    try {
      writeFileSync(temp, Buffer.from(lines.join(''), 'latin1'), { flag: 'wx', mode: stats.mode & 0o777 });
      if (!readFileSync(file).equals(original)) throw new Error(t('known_hosts изменился. Подключитесь снова, чтобы обновить отпечатки.'));
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  };
}
