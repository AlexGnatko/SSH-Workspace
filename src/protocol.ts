import type { Locale } from './i18n.js';

export interface Profile {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number | null;
  tmux: boolean;
  hasPassword: boolean;
  groupId: string | null;
}

export type ProfileDraft = Omit<Profile, 'id' | 'hasPassword' | 'groupId'> & { groupId?: string | null };
export interface ProfileGroup {
  id: string;
  name: string;
}
export type PasswordUpdate = { kind: 'keep' | 'remove' } | { kind: 'store'; value: string };

export interface Settings {
  copyOnSelection: boolean;
  rightClickPaste: boolean;
  language?: Locale;
}

export interface Size {
  cols: number;
  rows: number;
}

export interface WindowsPty {
  backend: 'conpty' | 'winpty';
  buildNumber: number;
}

export type FileSide = 'local' | 'remote';

export interface FileEntry {
  name: string;
  kind: 'directory' | 'file' | 'link' | 'other';
  size: number;
  modified: number;
}

export interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface RemotePermissions {
  mode: number;
  uid: number | null;
  gid: number | null;
  directory: boolean;
}

export interface PermissionChanges {
  mode: number;
  uid: number | null;
  gid: number | null;
  recursive: boolean;
}

export type CopyProgress =
  | { phase: 'scan' }
  | {
      phase: 'copy';
      name: string;
      bytes: number;
      totalBytes: number;
      files: number;
      totalFiles: number;
      remaining: number | null;
    };

export type FileCommand =
  | { type: 'copy' | 'delete'; side: FileSide; names: string[] }
  | { type: 'mkdir'; side: FileSide; name: string }
  | { type: 'rename'; side: FileSide; name: string; newName: string }
  | { type: 'permissions'; side: 'remote'; name: string; changes: PermissionChanges };

export interface FilesApi {
  open(id: string, profileId: string, password?: string): Promise<FileListing>;
  close(id: string): void;
  list(id: string, side: FileSide, path?: string): Promise<FileListing>;
  chooseLocal(id: string): Promise<FileListing | null>;
  permissions(id: string, name: string): Promise<RemotePermissions>;
  run(id: string, command: FileCommand): Promise<void>;
  onCopyProgress(callback: (id: string, progress: CopyProgress) => void): void;
}

export type SessionStatus = 'connecting' | 'connected' | 'waiting' | 'ended' | 'failed';

export type SessionEvent =
  | { id: string; attempt: number; type: 'status'; status: SessionStatus; detail?: string; retryAt?: number; passwordReady?: boolean }
  | { id: string; attempt: number; type: 'output'; sequence: number; data: string };

export interface DesktopApi {
  files: FilesApi;
  load(): Promise<{ profiles: Profile[]; groups: ProfileGroup[]; settings: Settings; windowsPty?: WindowsPty; version: string }>;
  openProjectSite(): Promise<void>;
  showLicenses(): Promise<void>;
  saveGroup(id: string | null, name: string): Promise<ProfileGroup>;
  deleteGroup(id: string): Promise<void>;
  saveProfile(id: string | null, profile: ProfileDraft, password: PasswordUpdate): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  start(id: string, profileId: string, size: Size): Promise<void>;
  reconnect(id: string): void;
  usePassword(id: string, attempt: number): Promise<void>;
  close(id: string): void;
  input(id: string, attempt: number, data: string): void;
  resize(id: string, size: Size): void;
  acknowledge(id: string, attempt: number, sequence: number): void;
  readClipboard(): Promise<string>;
  writeClipboard(data: string): void;
  onSessionEvent(callback: (event: SessionEvent) => void): void;
}

