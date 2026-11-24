import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from './protocol.js';

const api: DesktopApi = {
  files: {
    open: (id, profileId, password) => ipcRenderer.invoke('files:open', id, profileId, password),
    close: (id) => ipcRenderer.send('files:close', id),
    list: (id, side, path) => ipcRenderer.invoke('files:list', id, side, path),
    chooseLocal: (id) => ipcRenderer.invoke('files:choose-local', id),
    permissions: (id, name) => ipcRenderer.invoke('files:permissions', id, name),
    run: (id, command) => ipcRenderer.invoke('files:run', id, command),
    onCopyProgress: (callback) => ipcRenderer.on('files:progress', (_event, id, progress) => callback(id, progress)),
  },
  load: () => ipcRenderer.invoke('profiles:load'),
  openProjectSite: () => ipcRenderer.invoke('app:open-site'),
  showLicenses: () => ipcRenderer.invoke('app:show-licenses'),
  saveGroup: (id, name) => ipcRenderer.invoke('profiles:save-group', id, name),
  deleteGroup: (id) => ipcRenderer.invoke('profiles:delete-group', id),
  saveProfile: (id, profile, password) => ipcRenderer.invoke('profiles:save', id, profile, password),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  start: (id, profileId, size) => ipcRenderer.invoke('session:start', id, profileId, size),
  reconnect: (id) => ipcRenderer.send('session:reconnect', id),
  usePassword: (id, attempt) => ipcRenderer.invoke('session:password', id, attempt),
  close: (id) => ipcRenderer.send('session:close', id),
  input: (id, attempt, data) => ipcRenderer.send('session:input', id, attempt, data),
  resize: (id, size) => ipcRenderer.send('session:resize', id, size),
  acknowledge: (id, attempt, sequence) => ipcRenderer.send('session:ack', id, attempt, sequence),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (data) => ipcRenderer.send('clipboard:write', data),
  onSessionEvent: (callback) => ipcRenderer.on('session:event', (_event, message) => callback(message)),
};

contextBridge.exposeInMainWorld('desktop', api);
