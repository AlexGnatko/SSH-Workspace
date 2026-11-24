import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Profile } from './protocol.js';

const exec = promisify(execFile);

export function openSsh(name: string) {
  return process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', name + '.exe') : name;
}

export function expandSshPath(file: string) {
  return file.replace(/^~(?=[\\/])/, homedir())
    .replace(/^__PROGRAMDATA__(?=[\\/])/i, process.env.ProgramData ?? 'C:\\ProgramData');
}

export function sshDestination(profile: Profile) {
  const args: string[] = [];
  if (profile.username) args.push('-l', profile.username);
  if (profile.port !== null) args.push('-p', String(profile.port));
  return [...args, '--', profile.host];
}

export async function readSshConfig(profile: Profile, signal?: AbortSignal) {
  const { stdout } = await exec(openSsh('ssh'), ['-G', ...sshDestination(profile)], { timeout: 5000, windowsHide: true, signal });
  const values = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+) (.*)$/.exec(line);
    if (match) values.set(match[1], [...(values.get(match[1]) ?? []), match[2]]);
  }
  const get = (key: string) => values.get(key)?.[0];
  const configured = (key: string) => Boolean(get(key) && get(key) !== 'none');
  const knownFiles = (key: string) => (get(key)?.match(/"[^"]+"|\S+/g) ?? [])
    .map((file) => file.replace(/^"|"$/g, ''))
    .filter((file) => file !== 'none')
    .map(expandSshPath);
  return {
    values, get, configured,
    userKnownHosts: knownFiles('userknownhostsfile'),
    globalKnownHosts: knownFiles('globalknownhostsfile'),
    proxy: configured('proxycommand') || configured('proxyjump'),
  };
}
