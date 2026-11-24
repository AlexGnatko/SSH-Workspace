import { setLocale, t } from './i18n.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { Profiles } from './profiles.js';
import { SshSession } from './session.js';
import { FilesSession } from './files-session.js';
import type { ConfirmKeyChange } from './known-hosts.js';
import type { FileCommand, FileSide, PasswordUpdate, ProfileDraft, Settings, Size, WindowsPty } from './protocol.js';

app.setName('SSH Workspace');
if (process.platform === 'win32') app.setAppUserModelId('org.sshworkspace.desktop');

const index = join(__dirname, 'index.html');
const indexUrl = pathToFileURL(index).href;
const sessions = new Map<string, SshSession>();
const files = new Map<string, FilesSession>();
const pendingClosures = new Set<Promise<void>>();
let quitting = false;
let window: BrowserWindow | undefined;
let profiles: Profiles;
let logs: string;

function ownsFrame(event: IpcMainEvent | IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  return event.sender === window?.webContents && frame?.parent === null && frame.url === indexUrl;
}

function handle<Args extends unknown[], Result>(channel: string, action: (...args: Args) => Result) {
  ipcMain.handle(channel, (event, ...args: Args) => {
    if (!ownsFrame(event)) throw new Error(t('Недоступно.'));
    return action(...args);
  });
}

function on<Args extends unknown[]>(channel: string, action: (...args: Args) => void) {
  ipcMain.on(channel, (event, ...args: Args) => {
    if (!ownsFrame(event)) return;
    try {
      action(...args);
    } catch (error) {
      console.error(channel, error);
    }
  });
}

function size(value: Size): Size {
  return {
    cols: Number.isInteger(value?.cols) ? Math.min(500, Math.max(2, value.cols)) : 80,
    rows: Number.isInteger(value?.rows) ? Math.min(300, Math.max(1, value.rows)) : 24,
  };
}

function closeSession(id: string) {
  const session = sessions.get(id);
  sessions.delete(id);
  if (session) trackClose(session.close());
}

function fileSession(id: string) {
  const session = files.get(id);
  if (!session) throw new Error(t('Вкладка SFTP закрыта.'));
  return session;
}

function closeFiles(id: string) {
  const session = files.get(id);
  files.delete(id);
  if (session) trackClose(session.close());
}

function trackClose(close: Promise<void>) {
  pendingClosures.add(close);
  void close.then(() => pendingClosures.delete(close), (error: unknown) => {
    pendingClosures.delete(close);
    console.warn(t('Не удалось закрыть соединение.'), error);
  });
}

function closeConnections() {
  sessions.forEach((_, id) => closeSession(id));
  files.forEach((_, id) => closeFiles(id));
}

const confirmKeyChange: ConfirmKeyChange = async ({ endpoint, previous, next }, signal) => {
  const owner = window;
  if (!owner || signal.aborted) return false;
  const result = await dialog.showMessageBox(owner, {
    type: 'warning', title: t('Ключ SSH-сервера изменился'),
    message: t('Заменить сохранённый ключ для {endpoint}?', { endpoint }),
    detail: t('Старый отпечаток\n{previous}\n\nНовый отпечаток\n{next}\n\nСверьте новый отпечаток через панель хостинга или с администратором сервера.', { previous, next }),
    buttons: [t('Отмена'), t('Заменить и подключиться')], defaultId: 0, cancelId: 0, noLink: true, signal,
  });
  return result.response === 1 && !signal.aborted;
};

function registerIpc() {
  const buildNumber = Number(release().split('.')[2]);
  const windowsPty: WindowsPty | undefined = process.platform === 'win32' && Number.isInteger(buildNumber)
    ? { backend: buildNumber >= 18309 ? 'conpty' : 'winpty', buildNumber }
    : undefined;
  handle('profiles:load', () => ({ ...profiles.load(), windowsPty, version: app.getVersion() }));
  handle('app:open-site', () => shell.openExternal('https://ssh-workspace.ag38.ru/'));
  handle('app:show-licenses', async () => {
    const error = await shell.openPath(join(__dirname, 'licenses'));
    if (error) throw new Error(error);
  });
  handle('profiles:save-group', (id: string | null, name: string) => profiles.saveGroup(id, name));
  handle('profiles:delete-group', (id: string) => profiles.deleteGroup(id));
  handle('profiles:save', (id: string | null, draft: ProfileDraft, password: PasswordUpdate) => profiles.save(id, draft, password));
  handle('profiles:delete', (id: string) => profiles.delete(id));
  handle('settings:save', (settings: Settings) => profiles.settings(settings));
  handle('session:start', (id: string, profileId: string, initialSize: Size) => {
    if (typeof id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id) || sessions.has(id)) {
      throw new Error(t('Неверный идентификатор терминала.'));
    }
    const session = new SshSession(id, profiles.get(profileId), size(initialSize), logs, (event) => {
      if (!window?.webContents.isDestroyed()) window?.webContents.send('session:event', event);
    }, (profile) => profiles.password(profile), confirmKeyChange);
    sessions.set(id, session);
    session.start();
  });
  handle('session:password', (id: string, attempt: number) => sessions.get(id)?.usePassword(attempt));
  on('session:reconnect', (id: string) => sessions.get(id)?.reconnect());
  on('session:close', closeSession);
  on('session:input', (id: string, attempt: number, data: string) => {
    if (typeof data === 'string' && data.length <= 1024 * 1024 + 16) sessions.get(id)?.input(attempt, data);
  });
  on('session:resize', (id: string, nextSize: Size) => sessions.get(id)?.resize(size(nextSize)));
  on('session:ack', (id: string, attempt: number, sequence: number) => sessions.get(id)?.acknowledge(attempt, sequence));
  handle('clipboard:read', () => clipboard.readText());
  on('clipboard:write', (data: string) => {
    if (typeof data === 'string' && data.length <= 8 * 1024 * 1024) clipboard.writeText(data);
  });
  handle('files:open', (id: string, profileId: string, password?: string) => {
    if (typeof id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id) ||
        (password !== undefined && (typeof password !== 'string' || password.length > 4096))) {
      throw new Error(t('Неверные параметры SFTP.'));
    }
    const profile = profiles.get(profileId);
    const previous = files.get(id)?.locations(profile);
    closeFiles(id);
    const session = new FilesSession(profile, profiles, previous);
    files.set(id, session);
    return session.connect(async (endpoint, fingerprint, signal) => {
      const owner = window;
      if (!owner || signal.aborted) return false;
      const result = await dialog.showMessageBox(owner, {
        type: 'question', title: t('Ключ сервера SFTP'),
        message: t('Доверять ключу сервера {endpoint}?', { endpoint }),
        detail: t('Сверьте отпечаток с администратором сервера.\n{fingerprint}', { fingerprint }),
        buttons: [t('Отмена'), t('Доверять')], defaultId: 0, cancelId: 0, noLink: true, signal,
      });
      return result.response === 1;
    }, confirmKeyChange, password);
  });
  on('files:close', closeFiles);
  handle('files:list', (id: string, side: FileSide, path?: string) => fileSession(id).list(side, path));
  handle('files:permissions', (id: string, name: string) => fileSession(id).permissions(name));
  handle('files:run', (id: string, command: FileCommand) => fileSession(id).run(command, (progress) => {
    const target = window?.webContents;
    if (target && !target.isDestroyed()) target.send('files:progress', id, progress);
  }));
  handle('files:choose-local', async (id: string) => {
    const current = window;
    if (!current) return null;
    const session = fileSession(id);
    const result = await dialog.showOpenDialog(current, { title: t('Папка на компьютере'), properties: ['openDirectory'] });
    return result.filePaths[0] ? session.list('local', result.filePaths[0]) : null;
  });
}

function openWindow() {
  const current = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 720,
    minHeight: 490,
    backgroundColor: '#131719',
    title: 'SSH Workspace',
    icon: join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window = current;
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event) => event.preventDefault());
  current.webContents.on('render-process-gone', closeConnections);
  current.once('closed', () => {
    closeConnections();
    window = undefined;
  });
  void current.loadFile(index);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null);
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    profiles = new Profiles(join(directory, 'profiles.json'));
    setLocale(profiles.load().settings.language);
    logs = mkdtempSync(join(app.getPath('temp'), 'ssh-workspace-'));
    registerIpc();
    openWindow();
    app.on('activate', () => {
      if (!window) openWindow();
    });
  }).catch((error: unknown) => {
    dialog.showErrorBox('SSH Workspace', String(error));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting || (!sessions.size && !files.size && !pendingClosures.size)) return;
    event.preventDefault();
    quitting = true;
    closeConnections();
    void Promise.allSettled([...pendingClosures]).then(() => app.quit());
  });
  app.on('will-quit', () => {
    try {
      if (logs) rmSync(logs, { force: true, recursive: true, maxRetries: 3 });
    } catch (error) {
      console.warn(t('Не удалось удалить временные журналы OpenSSH.'), error);
    }
  });
}
