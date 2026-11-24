import { localize, locale, resolveLocale, setLocale, t } from './i18n.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { FileWorkspace } from './file-workspace.js';
import type { DesktopApi, PasswordUpdate, Profile, ProfileGroup, SessionEvent, SessionStatus, Settings, WindowsPty } from './protocol.js';

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

interface SessionTabBase {
  id: string;
  owner: WorkspacePane;
  profileId: string;
  number: number;
  status: SessionStatus;
  detail?: string;
  destination: string;
  pane: HTMLElement;
}

interface TerminalTab extends SessionTabBase {
  kind: 'terminal';
  attempt: number;
  retryAt?: number;
  passwordReady?: boolean;
  terminal: Terminal;
  fit: FitAddon;
}

interface FileTab extends SessionTabBase {
  kind: 'files';
  files: FileWorkspace;
}

type SessionTab = TerminalTab | FileTab;

interface ProfileTab {
  id: string;
  tabs: SessionTab[];
  active: string | null;
  nextNumber: number;
  nextFileNumber: number;
}

interface WorkspacePane {
  root: HTMLElement;
  profileTabs: HTMLElement;
  terminalTabs: HTMLElement;
  terminalArea: HTMLElement;
  workspace: HTMLElement;
  empty: HTMLElement;
  emptyHint: HTMLElement;
  emptyAdd: HTMLButtonElement;
  statusLabel: HTMLElement;
  destinationLabel: HTMLElement;
  interrupt: HTMLButtonElement;
  reconnect: HTMLButtonElement;
  usePassword: HTMLButtonElement;
  layout: HTMLButtonElement;
  observer: ResizeObserver;
  openProfiles: Map<string, ProfileTab>;
  collapsedGroups: Set<string | null>;
  activeProfile: string | null;
}

function element<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

function button(label: string, action: () => void, className?: string) {
  const item = document.createElement('button');
  item.type = 'button';
  item.textContent = label;
  if (className) item.className = className;
  item.addEventListener('click', action);
  return item;
}

const api = window.desktop;
const sidebar = element('profiles');
const paneContainer = element('workspace-panes');
const paneTemplate = element<HTMLTemplateElement>('workspace-pane-template');
const notice = element('notice');
let noticeTimer: ReturnType<typeof setTimeout>;

let profiles: Profile[] = [];
let groups: ProfileGroup[] = [];
let sidebarGroup: string | null | undefined = null;
let settings: Settings = { copyOnSelection: true, rightClickPaste: true };
let windowsPty: WindowsPty | undefined;
const tabs = new Map<string, SessionTab>();
const panes: WorkspacePane[] = [];
let activePane: WorkspacePane;
let paneCount = 0;

const statusText = {
  connecting: 'Подключение…',
  connected: 'Подключено',
  waiting: 'Связь потеряна',
  ended: 'Сеанс завершён',
  failed: 'Ошибка подключения',
} as const satisfies Record<SessionStatus, string>;

function terminalNotice(message: string) {
  return message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

function showError(error: unknown) {
  clearTimeout(noticeTimer);
  notice.textContent = errorText(error);
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500);
}

function address(profile: Profile) {
  const host = profile.host.includes(':') && profile.port !== null ? '[' + profile.host + ']' : profile.host;
  return (profile.username ? profile.username + '@' : '') + host + (profile.port === null ? '' : ':' + profile.port);
}

function selectedProfile(pane: WorkspacePane) {
  return pane.activeProfile ? pane.openProfiles.get(pane.activeProfile) : undefined;
}

function selectedTab(pane = activePane) {
  if (!pane) return undefined;
  const group = selectedProfile(pane);
  return group?.active ? tabs.get(group.active) : undefined;
}

function activatePane(pane: WorkspacePane) {
  if (activePane === pane) return;
  activePane?.root.classList.remove('is-active');
  activePane = pane;
  pane.root.classList.add('is-active');
  sidebar.querySelectorAll<HTMLElement>('.profile-item').forEach((row) => {
    row.classList.toggle('active', row.dataset.profileId === pane.activeProfile);
  });
}

function createPane() {
  const root = paneTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const pane: WorkspacePane = {
    root, profileTabs: find('profile-tabs'), terminalTabs: find('terminal-tabs'),
    terminalArea: find('terminal-area'), workspace: find('workspace'), empty: find('empty'),
    emptyHint: find('empty-hint'), emptyAdd: find('empty-add'), statusLabel: find('status'),
    destinationLabel: find('destination'), interrupt: find('interrupt'), reconnect: find('reconnect'),
    usePassword: find('use-password'), layout: find('pane-layout'),
    observer: new ResizeObserver(() => fitPane(pane)), openProfiles: new Map(),
    collapsedGroups: new Set(), activeProfile: null,
  };
  pane.emptyAdd.addEventListener('click', () => editProfile());
  pane.layout.addEventListener('click', () => {
    if (panes.length === 1) {
      activatePane(createPane());
      showWorkspace();
    } else {
      closePane(pane);
    }
  });
  find('new-terminal').addEventListener('click', () => {
    const group = selectedProfile(pane);
    if (group) addTerminal(pane, group);
  });
  find('new-files').addEventListener('click', () => {
    const group = selectedProfile(pane);
    if (group) addFiles(pane, group);
  });
  pane.interrupt.addEventListener('click', () => {
    const tab = selectedTab(pane);
    if (tab?.kind !== 'terminal' || !canInput(tab)) return;
    api.input(tab.id, tab.attempt, '\x03');
    tab.terminal.focus();
  });
  pane.reconnect.addEventListener('click', () => {
    const tab = selectedTab(pane);
    if (tab?.kind !== 'terminal') return;
    api.reconnect(tab.id);
    tab.terminal.focus();
  });
  pane.usePassword.addEventListener('click', async () => {
    const tab = selectedTab(pane);
    if (tab?.kind !== 'terminal') return;
    pane.usePassword.disabled = true;
    try {
      await api.usePassword(tab.id, tab.attempt);
      if (selectedTab() === tab) tab.terminal.focus();
    } catch (error) {
      if (tabs.has(tab.id)) showError(error);
    } finally {
      pane.usePassword.disabled = false;
    }
  });
  paneCount++;
  if (paneCount > 1) root.querySelectorAll<HTMLElement>('[id]').forEach((child) => { child.id += '-' + paneCount; });
  root.addEventListener('pointerdown', () => activatePane(pane), true);
  root.addEventListener('focusin', () => activatePane(pane));
  paneContainer.append(root);
  panes.push(pane);
  pane.observer.observe(pane.terminalArea);
  return pane;
}

function fitPane(pane: WorkspacePane) {
  const tab = selectedTab(pane);
  if (tab?.kind === 'terminal' && !tab.pane.hidden) tab.fit.fit();
}

function closePane(pane: WorkspacePane) {
  const remaining = panes.find((item) => item !== pane);
  if (!remaining) return;
  for (const profile of pane.openProfiles.values()) {
    for (const tab of profile.tabs) disposeTab(tab);
  }
  pane.observer.disconnect();
  pane.root.remove();
  panes.splice(panes.indexOf(pane), 1);
  activatePane(remaining);
  showWorkspace();
}

function restoreTerminalFocus() {
  const tab = selectedTab();
  if (tab?.kind === 'terminal' && document.hasFocus() &&
      (document.activeElement === document.body || document.activeElement === document.documentElement) &&
      !document.querySelector('dialog[open]')) {
    tab.terminal.focus();
  }
}

function navigationTab(label: string, active: boolean, select: () => void, close: () => void, status?: SessionStatus) {
  const tab = document.createElement('div');
  tab.className = active ? 'tab active' : 'tab';
  const main = button('', select, 'tab-select');
  const text = document.createElement('span');
  text.className = 'tab-label';
  text.textContent = label;
  main.title = status ? label + ' · ' + t(statusText[status]) : label;
  if (active) main.setAttribute('aria-current', 'true');
  if (status) {
    const dot = document.createElement('span');
    dot.className = 'dot ' + status;
    dot.setAttribute('aria-hidden', 'true');
    main.append(dot);
  }
  main.append(text);
  const dismiss = button('×', close, 'tab-close');
  dismiss.title = t('Закрыть «{name}»', { name: label });
  dismiss.setAttribute('aria-label', dismiss.title);
  tab.append(main, dismiss);
  return tab;
}

function profileRow(profile: Profile) {
  const row = document.createElement('div');
  row.className = profile.id === activePane.activeProfile ? 'profile-item active' : 'profile-item';
  row.dataset.profileId = profile.id;
  const item = button('', () => openProfile(profile), 'profile-open');
  const title = document.createElement('span');
  title.textContent = profile.name;
  const description = document.createElement('span');
  description.className = 'profile-address';
  description.textContent = address(profile);
  item.append(title, description);
  item.title = profile.name + ' · ' + address(profile);
  const edit = button('⋯', () => editProfile(profile), 'profile-edit');
  edit.title = t('Изменить «{name}»', { name: profile.name });
  edit.setAttribute('aria-label', edit.title);
  row.append(item, edit);
  return row;
}

function sidebarSection(group: ProfileGroup | null, members: Profile[]) {
  const id = group?.id ?? null;
  const name = group?.name ?? t('Без группы');
  const container = document.createElement('section');
  container.className = 'sidebar-group';
  const header = document.createElement('div');
  header.className = 'group-heading';
  const opened = sidebarGroup === id;
  const toggle = button((opened ? '▾ ' : '▸ ') + name, () => {
    sidebarGroup = opened ? undefined : id;
    renderSidebar();
    sidebar.querySelector<HTMLElement>('[data-group="' + (id ?? 'ungrouped') + '"]')?.focus();
  }, 'group-toggle');
  toggle.dataset.group = id ?? 'ungrouped';
  toggle.title = name;
  toggle.setAttribute('aria-expanded', String(opened));
  header.append(toggle);
  if (group) {
    const edit = button('⋯', () => editGroup(group), 'profile-edit');
    edit.title = t('Изменить группу «{name}»', { name });
    edit.setAttribute('aria-label', edit.title);
    header.append(edit);
  }
  container.append(header);
  if (opened) {
    const items = document.createElement('div');
    items.className = 'group-items';
    items.append(...members.map(profileRow));
    if (!members.length) {
      const empty = document.createElement('p');
      empty.textContent = t('Нет подключений');
      items.append(empty);
    }
    container.append(items);
  }
  return container;
}

function renderSidebar() {
  if (!groups.length) {
    sidebar.replaceChildren(...profiles.map(profileRow));
    return;
  }
  const sections = groups.map((group) => sidebarSection(group, profiles.filter((profile) => profile.groupId === group.id)));
  const ungrouped = profiles.filter((profile) => !profile.groupId);
  if (ungrouped.length) sections.push(sidebarSection(null, ungrouped));
  sidebar.replaceChildren(...sections);
}

function renderProfileTabs(pane: WorkspacePane) {
  const { profileTabs, openProfiles, activeProfile, collapsedGroups } = pane;
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const buildTab = (id: string) => navigationTab(profilesById.get(id)?.name ?? t('Профиль'),
    activeProfile === id, () => activateProfile(pane, id), () => closeProfile(pane, id));
  const openedIds = [...openProfiles.keys()];
  if (!groups.length) {
    profileTabs.replaceChildren(...openedIds.map(buildTab));
    return;
  }
  const visible = [...groups, { id: null, name: t('Без группы') }].flatMap((group) => {
    const ids = openedIds.filter((id) => (profilesById.get(id)?.groupId ?? null) === group.id);
    if (!ids.length) return [];
    const container = document.createElement('div');
    container.className = 'top-group';
    container.classList.toggle('top-group-active', activeProfile !== null && ids.includes(activeProfile));
    const opened = !collapsedGroups.has(group.id);
    const toggle = button((opened ? '▾ ' : '▸ ') + group.name, () => {
      if (opened) collapsedGroups.add(group.id);
      else collapsedGroups.delete(group.id);
      renderProfileTabs(pane);
      profileTabs.querySelector<HTMLElement>('[data-group="' + (group.id ?? 'ungrouped') + '"]')?.focus();
    }, 'top-group-toggle');
    toggle.dataset.group = group.id ?? 'ungrouped';
    toggle.title = group.name;
    toggle.setAttribute('aria-expanded', String(opened));
    container.append(toggle);
    if (opened) container.append(...ids.map(buildTab));
    return [container];
  });
  profileTabs.replaceChildren(...visible);
}

function renderNavigation() {
  renderSidebar();
  for (const pane of panes) renderPaneNavigation(pane);
}

function renderPaneNavigation(pane: WorkspacePane) {
  renderProfileTabs(pane);
  const group = selectedProfile(pane);
  pane.terminalTabs.replaceChildren(...(group?.tabs ?? []).map((tab) =>
    navigationTab(tab.kind === 'terminal' ? t('Терминал {number}', { number: tab.number }) : 'SFTP ' + tab.number, group?.active === tab.id, () => {
      if (!group) return;
      activatePane(pane);
      group.active = tab.id;
      showWorkspace();
    }, () => { if (group) closeTab(group, tab); }, tab.status)));
}

function updateStatus(pane: WorkspacePane) {
  const tab = selectedTab(pane);
  if (!tab) return;
  const { statusLabel, destinationLabel, usePassword, reconnect, interrupt } = pane;
  const terminal = tab.kind === 'terminal' ? tab : undefined;
  const status = terminal?.passwordReady ? t('OpenSSH запрашивает пароль') : t(statusText[tab.status]);
  const retry = terminal?.retryAt ? ' · ' + t('Повтор через {seconds} с', {
    seconds: Math.max(0, Math.ceil((terminal.retryAt - Date.now()) / 1000)),
  }) : '';
  const message = status + retry + (tab.detail ? ' · ' + tab.detail : '');
  if (message !== statusLabel.textContent) statusLabel.textContent = message;
  statusLabel.title = message;
  destinationLabel.textContent = tab.destination;
  destinationLabel.title = tab.destination;
  usePassword.hidden = !terminal?.passwordReady;
  reconnect.hidden = !terminal || (tab.status !== 'ended' && tab.status !== 'failed' && tab.status !== 'waiting');
  reconnect.textContent = tab.status === 'waiting' ? t('Повторить сейчас') : t('Подключить');
  interrupt.disabled = tab.status !== 'connected' && tab.status !== 'connecting';
  interrupt.hidden = !terminal;
}

function showWorkspace(focus = true) {
  const split = panes.length === 2;
  paneContainer.classList.toggle('is-split', split);
  for (const [index, pane] of panes.entries()) {
    const selected = selectedTab(pane);
    for (const profile of pane.openProfiles.values()) {
      for (const tab of profile.tabs) {
        tab.pane.hidden = tab !== selected;
        if (tab.kind === 'files' && tab.pane.hidden) tab.files.dismissContext(false);
      }
    }
    pane.root.setAttribute('aria-label', split ? (index === 0 ? t('Левая панель') : t('Правая панель')) : t('Рабочая панель'));
    pane.layout.textContent = split ? '×' : '◫';
    pane.layout.title = split ? (index === 0 ? t('Закрыть левую панель') : t('Закрыть правую панель')) : t('Разделить на две панели');
    pane.layout.setAttribute('aria-label', pane.layout.title);
    pane.workspace.hidden = !selected;
    pane.empty.hidden = Boolean(selected);
    pane.emptyAdd.hidden = profiles.length !== 0;
    pane.emptyHint.textContent = profiles.length
      ? split ? t('Выберите профиль слева. Активная панель выделена.') : t('Выберите сохранённый профиль слева.')
      : t('Сохраните адрес сервера и логин в профиле.');
    updateStatus(pane);
  }
  renderNavigation();
  for (const pane of panes) fitPane(pane);
  if (!focus) return;
  const selected = selectedTab();
  if (selected?.kind === 'terminal') selected.terminal.focus();
  else if (selected?.kind === 'files') selected.files.focus();
  else activePane.root.focus();
}

function activateProfile(pane: WorkspacePane, id: string) {
  activatePane(pane);
  pane.activeProfile = id;
  sidebarGroup = profiles.find((profile) => profile.id === id)?.groupId ?? null;
  pane.collapsedGroups.delete(sidebarGroup);
  showWorkspace();
}

function openProfile(profile: Profile) {
  const pane = activePane;
  const existing = pane.openProfiles.get(profile.id);
  if (existing) {
    activateProfile(pane, profile.id);
    return;
  }
  const group: ProfileTab = { id: profile.id, tabs: [], active: null, nextNumber: 1, nextFileNumber: 1 };
  pane.openProfiles.set(profile.id, group);
  pane.activeProfile = profile.id;
  sidebarGroup = profile.groupId;
  pane.collapsedGroups.delete(profile.groupId);
  addTerminal(pane, group);
}

function closeProfile(pane: WorkspacePane, id: string) {
  const group = pane.openProfiles.get(id);
  if (!group) return;
  for (const tab of group.tabs) disposeTab(tab);
  const ids = [...pane.openProfiles.keys()];
  pane.openProfiles.delete(id);
  const wasActive = pane.activeProfile === id;
  if (wasActive) pane.activeProfile = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1] ?? null;
  showWorkspace(wasActive && pane === activePane);
}

function disposeTab(tab: SessionTab) {
  tabs.delete(tab.id);
  if (tab.kind === 'files') tab.files.close();
  else {
    api.close(tab.id);
    tab.terminal.dispose();
    tab.pane.remove();
  }
}

function closeTab(group: ProfileTab, tab: SessionTab) {
  if (group.tabs.length === 1) {
    closeProfile(tab.owner, group.id);
    return;
  }
  const wasSelected = selectedTab() === tab;
  const index = group.tabs.indexOf(tab);
  group.tabs.splice(index, 1);
  if (group.active === tab.id) group.active = (group.tabs[index] ?? group.tabs[index - 1]).id;
  disposeTab(tab);
  showWorkspace(wasSelected);
}

function addFiles(pane: WorkspacePane, group: ProfileTab) {
  const profile = profiles.find((item) => item.id === group.id);
  if (!profile) return;
  const id = crypto.randomUUID();
  const files = new FileWorkspace(id, profile.id, api.files, (status, detail) => {
    if (!tabs.has(id)) return;
    tab.status = status;
    tab.detail = detail;
    renderPaneNavigation(pane);
    updateStatus(pane);
  }, showError, api.writeClipboard);
  const tab: FileTab = {
    kind: 'files', id, owner: pane, profileId: group.id, number: group.nextFileNumber++, status: 'connecting',
    destination: address(profile), pane: files.pane, files,
  };
  group.tabs.push(tab);
  group.active = id;
  tabs.set(id, tab);
  pane.terminalArea.append(tab.pane);
  activatePane(pane);
  showWorkspace();
  void files.connect();
}

function addTerminal(owner: WorkspacePane, group: ProfileTab) {
  const profile = profiles.find((item) => item.id === group.id);
  if (!profile) return;
  const terminal = new Terminal({
    scrollback: 5000,
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    macOptionIsMeta: true,
    windowsPty,
    minimumContrastRatio: 1,
    theme: {
      foreground: '#bfbfbf', background: '#131719', cursor: '#bfbfbf', selectionBackground: '#00594f',
      black: '#000000', red: '#c02020', green: '#008000', yellow: '#a08000',
      blue: '#0020c0', magenta: '#a800a8', cyan: '#00a89a', white: '#bfbfbf',
      brightBlack: '#808080', brightRed: '#f20000', brightGreen: '#00f200', brightYellow: '#f2f200',
      brightBlue: '#546dff', brightMagenta: '#f200f2', brightCyan: '#00f2f2', brightWhite: '#ffffff',
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  owner.terminalArea.append(pane);
  const tab: TerminalTab = {
    kind: 'terminal', id: crypto.randomUUID(), owner, profileId: group.id, number: group.nextNumber++, attempt: 0, status: 'connecting',
    destination: address(profile), pane, terminal, fit,
  };
  group.tabs.push(tab);
  group.active = tab.id;
  tabs.set(tab.id, tab);
  owner.workspace.hidden = false;
  terminal.open(pane);
  wireTerminal(tab);
  activatePane(owner);
  showWorkspace();
  const { cols, rows } = terminal;
  void api.start(tab.id, profile.id, { cols, rows }).catch((error) => {
    if (!tabs.has(tab.id)) return;
    tab.status = 'failed';
    tab.detail = errorText(error);
    renderPaneNavigation(owner);
    updateStatus(owner);
  });
}

function canInput(tab: TerminalTab) {
  return tab.attempt > 0 && (tab.status === 'connecting' || tab.status === 'connected');
}

const pasteDialog = element<HTMLDialogElement>('paste-dialog');

async function paste(tab: TerminalTab, supplied?: string) {
  if (selectedTab() !== tab || !canInput(tab) || pasteDialog.open) return;
  const attempt = tab.attempt;
  const data = supplied ?? await api.readClipboard();
  const isCurrent = () => selectedTab() === tab && tab.attempt === attempt && canInput(tab);
  if (!data || !isCurrent() || pasteDialog.open) return;
  if (data.length > 1024 * 1024) throw new Error(t('Размер вставки превышает 1 МБ текста.'));
  if (/[\r\n]/.test(data) && !tab.terminal.modes.bracketedPasteMode) {
    element('paste-preview').textContent = data.slice(0, 1000) + (data.length > 1000 ? '…' : '');
    pasteDialog.returnValue = 'cancel';
    pasteDialog.showModal();
    await new Promise<void>((resolve) => pasteDialog.addEventListener('close', () => resolve(), { once: true }));
    element('paste-preview').textContent = '';
    if (pasteDialog.returnValue !== 'paste' || !isCurrent()) return;
  }
  tab.terminal.paste(data);
  tab.terminal.focus();
}

function wireTerminal(tab: TerminalTab) {
  const { terminal, pane } = tab;
  terminal.onData((data) => { if (canInput(tab)) api.input(tab.id, tab.attempt, data); });
  terminal.onResize((size) => api.resize(tab.id, size));
  const copy = () => {
    const data = terminal.getSelection();
    if (data) api.writeClipboard(data);
  };
  terminal.onSelectionChange(() => { if (settings.copyOnSelection) copy(); });
  const readClipboard = () => { void paste(tab).catch(showError); };
  pane.addEventListener('mousedown', (event) => {
    if (event.button !== 2 || !settings.rightClickPaste) return;
    event.preventDefault();
    event.stopPropagation();
    terminal.focus();
  }, true);
  pane.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (settings.rightClickPaste) readClipboard();
  }, true);
  pane.addEventListener('paste', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void paste(tab, event.clipboardData?.getData('text/plain')).catch(showError);
  }, true);
  terminal.attachCustomKeyEventHandler((event) => {
    const key = event.key.toLowerCase();
    const copyPasteModifier = event.metaKey || (event.ctrlKey && event.shiftKey);
    const clipboardAction = (key === 'v' && (copyPasteModifier || event.ctrlKey)) ||
      (key === 'c' && copyPasteModifier);
    if (!clipboardAction || event.altKey) return true;
    event.preventDefault();
    if (event.type === 'keydown') {
      if (key === 'c') copy();
      else readClipboard();
    }
    return false;
  });
}

function handleSessionEvent(event: SessionEvent) {
  const tab = tabs.get(event.id);
  if (tab?.kind !== 'terminal' || event.attempt < tab.attempt) return;
  if (event.type === 'output') {
    tab.terminal.write(event.data, () => api.acknowledge(event.id, event.attempt, event.sequence));
    return;
  }
  if (event.status === 'ended') {
    const group = tab.owner.openProfiles.get(tab.profileId);
    if (group) closeTab(group, tab);
    return;
  }
  if (tab.attempt > 0 && event.attempt > tab.attempt) {
    tab.terminal.reset();
    if (tab.detail) tab.terminal.writeln(terminalNotice(t('Предыдущая попытка: {detail}', { detail: tab.detail })));
  }
  tab.attempt = event.attempt;
  tab.status = event.status;
  tab.detail = event.detail;
  tab.retryAt = event.retryAt;
  tab.passwordReady = event.passwordReady;
  if (event.detail && (event.status === 'failed' || event.status === 'waiting')) {
    tab.terminal.writeln('\r\n' + terminalNotice(event.detail));
  }
  renderPaneNavigation(tab.owner);
  updateStatus(tab.owner);
}

const profileDialog = element<HTMLDialogElement>('profile-dialog');
const profileForm = element<HTMLFormElement>('profile-form');
const profileName = element<HTMLInputElement>('profile-name');
const profileGroup = element<HTMLSelectElement>('profile-group');
const profileHost = element<HTMLInputElement>('profile-host');
const profilePort = element<HTMLInputElement>('profile-port');
const profileUser = element<HTMLInputElement>('profile-user');
const profilePassword = element<HTMLInputElement>('profile-password');
const profileTmux = element<HTMLInputElement>('profile-tmux');
const forgetPassword = element<HTMLInputElement>('forget-password');
const deleteProfile = element<HTMLButtonElement>('delete-profile');
const saveProfile = element<HTMLButtonElement>('save-profile');
const formError = element('form-error');
let editing: Profile | undefined;

function editProfile(profile?: Profile) {
  editing = profile;
  profileForm.reset();
  element('profile-title').textContent = profile ? t('Настройки профиля') : t('Новый профиль');
  profileName.value = profile?.name ?? '';
  const ungrouped = new Option(t('Без группы'), '');
  profileGroup.replaceChildren(ungrouped, ...groups.map((group) => new Option(group.name, group.id)));
  profileGroup.value = (profile ? profile.groupId : sidebarGroup) ?? '';
  profileHost.value = profile?.host ?? '';
  profilePort.value = profile?.port == null ? '' : String(profile.port);
  profileUser.value = profile?.username ?? '';
  profilePassword.placeholder = profile?.hasPassword ? t('Пароль сохранён') : t('Вводить при подключении');
  profileTmux.checked = profile?.tmux ?? false;
  element('forget-row').hidden = !profile?.hasPassword;
  deleteProfile.hidden = !profile;
  formError.hidden = true;
  profileDialog.showModal();
  profileName.focus();
}

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveProfile.disabled) return;
  const password: PasswordUpdate = profilePassword.value
    ? { kind: 'store', value: profilePassword.value }
    : { kind: forgetPassword.checked ? 'remove' : 'keep' };
  saveProfile.disabled = true;
  try {
    const saved = await api.saveProfile(editing?.id ?? null, {
      name: profileName.value,
      host: profileHost.value,
      port: profilePort.value ? profilePort.valueAsNumber : null,
      username: profileUser.value,
      tmux: profileTmux.checked,
      groupId: profileGroup.value || null,
    }, password);
    const index = profiles.findIndex((profile) => profile.id === saved.id);
    if (index >= 0) profiles[index] = saved;
    else profiles.push(saved);
    sidebarGroup = saved.groupId;
    for (const pane of panes) {
      if (pane.openProfiles.has(saved.id)) pane.collapsedGroups.delete(saved.groupId);
    }
    profileDialog.close();
    showWorkspace(false);
  } catch (error) {
    formError.textContent = errorText(error);
    formError.hidden = false;
  } finally {
    saveProfile.disabled = false;
  }
});

const groupDialog = element<HTMLDialogElement>('group-dialog');
const groupName = element<HTMLInputElement>('group-name');
const groupError = element('group-error');
const saveGroup = element<HTMLButtonElement>('save-group');
const deleteGroup = element('delete-group');
let editingGroup: ProfileGroup | undefined;

function editGroup(group?: ProfileGroup) {
  editingGroup = group;
  element('group-title').textContent = group ? t('Настройки группы') : t('Новая группа');
  groupName.value = group?.name ?? '';
  groupError.hidden = true;
  deleteGroup.hidden = !group;
  groupDialog.showModal();
  groupName.focus();
  groupName.select();
}

function groupFailure(error: unknown) {
  groupError.textContent = errorText(error);
  groupError.hidden = false;
}

element('new-group').addEventListener('click', () => editGroup());
element('cancel-group').addEventListener('click', () => { if (!saveGroup.disabled) groupDialog.close(); });
groupDialog.addEventListener('cancel', (event) => { if (saveGroup.disabled) event.preventDefault(); });
element('group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveGroup.disabled) return;
  saveGroup.disabled = true;
  try {
    const group = await api.saveGroup(editingGroup?.id ?? null, groupName.value);
    const index = groups.findIndex((item) => item.id === group.id);
    if (index < 0) groups.push(group);
    else groups[index] = group;
    sidebarGroup = group.id;
    groupDialog.close();
    renderNavigation();
  } catch (error) {
    groupFailure(error);
  } finally {
    saveGroup.disabled = false;
  }
});
deleteGroup.addEventListener('click', async () => {
  const group = editingGroup;
  if (!group || saveGroup.disabled || !window.confirm(t('Удалить группу «{name}»? Её профили перейдут в «Без группы».', { name: group.name }))) return;
  saveGroup.disabled = true;
  try {
    await api.deleteGroup(group.id);
    groups = groups.filter((item) => item.id !== group.id);
    profiles = profiles.map((profile) => profile.groupId === group.id ? { ...profile, groupId: null } : profile);
    sidebarGroup = null;
    for (const pane of panes) {
      pane.collapsedGroups.delete(group.id);
      pane.collapsedGroups.delete(null);
    }
    groupDialog.close();
    renderNavigation();
  } catch (error) {
    groupFailure(error);
  } finally {
    saveGroup.disabled = false;
  }
});

profileDialog.addEventListener('cancel', (event) => { if (saveProfile.disabled) event.preventDefault(); });
profileDialog.addEventListener('close', () => { profilePassword.value = ''; });
profilePassword.addEventListener('input', () => { if (profilePassword.value) forgetPassword.checked = false; });
forgetPassword.addEventListener('change', () => { if (forgetPassword.checked) profilePassword.value = ''; });
element('cancel-profile').addEventListener('click', () => { if (!saveProfile.disabled) profileDialog.close(); });
deleteProfile.addEventListener('click', async () => {
  const profile = editing;
  if (!profile || saveProfile.disabled || !window.confirm(t('Удалить профиль «{name}» и закрыть его сеансы в обеих панелях?', { name: profile.name }))) return;
  try {
    await api.deleteProfile(profile.id);
    profiles = profiles.filter((item) => item.id !== profile.id);
    profileDialog.close();
    for (const pane of panes) closeProfile(pane, profile.id);
    showWorkspace(false);
  } catch (error) {
    formError.textContent = errorText(error);
    formError.hidden = false;
  }
});

const settingsDialog = element<HTMLDialogElement>('settings-dialog');
const language = element<HTMLSelectElement>('app-language');
const copySelection = element<HTMLInputElement>('copy-selection');
const rightClickPaste = element<HTMLInputElement>('right-click-paste');
const appMenu = element('app-menu');
const menuToggles = [element<HTMLButtonElement>('brand-menu-toggle'), element<HTMLButtonElement>('app-menu-toggle')];
const aboutDialog = element<HTMLDialogElement>('about-dialog');
let menuTrigger = menuToggles[1];

const menuIcon = element<HTMLCanvasElement>('app-menu-icon');
const menuIconContext = menuIcon.getContext('2d');
new ResizeObserver(([entry]) => {
  if (!menuIconContext) return;
  const { inlineSize: width, blockSize: height } = entry.devicePixelContentBoxSize[0];
  if (!width || height < 5) return;
  menuIcon.width = width;
  menuIcon.height = height;
  const thickness = Math.max(1, Math.round(2 * devicePixelRatio));
  const gap = Math.floor((height - thickness * 3) / 2);
  const top = Math.floor((height - thickness * 3 - gap * 2) / 2);
  menuIconContext.fillStyle = getComputedStyle(menuIcon).color;
  for (let row = 0; row < 3; row++) {
    menuIconContext.fillRect(0, top + row * (thickness + gap), width, thickness);
  }
}).observe(menuIcon, { box: 'device-pixel-content-box' });

function showAppMenu(open: boolean) {
  appMenu.hidden = !open;
  for (const toggle of menuToggles) toggle.setAttribute('aria-expanded', String(open));
  if (open) appMenu.querySelector('button')?.focus();
}

for (const toggle of menuToggles) {
  toggle.addEventListener('click', () => {
    menuTrigger = toggle;
    showAppMenu(appMenu.hidden);
  });
}
document.addEventListener('click', (event) => {
  if (!appMenu.hidden && event.target instanceof Node && !appMenu.parentElement?.contains(event.target)) showAppMenu(false);
});
appMenu.parentElement?.addEventListener('focusout', (event) => {
  if (event.relatedTarget instanceof Node && !appMenu.parentElement?.contains(event.relatedTarget)) showAppMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (appMenu.hidden || event.key !== 'Escape') return;
  event.preventDefault();
  menuTrigger.focus();
  showAppMenu(false);
});

element('settings').addEventListener('click', () => {
  menuTrigger.focus();
  showAppMenu(false);
  copySelection.checked = settings.copyOnSelection;
  rightClickPaste.checked = settings.rightClickPaste;
  language.value = resolveLocale(settings.language);
  settingsDialog.showModal();
});
element('about').addEventListener('click', () => {
  menuTrigger.focus();
  showAppMenu(false);
  aboutDialog.showModal();
});
element('project-site').addEventListener('click', (event) => {
  event.preventDefault();
  void api.openProjectSite().catch(showError);
});
element('show-licenses').addEventListener('click', () => void api.showLicenses().catch(showError));
element('cancel-settings').addEventListener('click', () => settingsDialog.close());
element('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const updated: Settings = {
    copyOnSelection: copySelection.checked,
    rightClickPaste: rightClickPaste.checked,
    language: resolveLocale(language.value),
  };
  try {
    await api.saveSettings(updated);
    settings = updated;
    settingsDialog.close();
  } catch (error) {
    settingsDialog.close();
    showError(error);
  }
});

element('new-profile').addEventListener('click', () => editProfile());

window.addEventListener('focus', () => requestAnimationFrame(restoreTerminalFocus));
setInterval(() => {
  for (const pane of panes) updateStatus(pane);
  restoreTerminalFocus();
}, 500);
api.onSessionEvent(handleSessionEvent);
api.files.onCopyProgress((id, progress) => {
  const tab = tabs.get(id);
  if (tab?.kind === 'files') tab.files.copyProgress(progress);
});
void api.load().then((data) => {
  ({ profiles, settings, windowsPty } = data);
  groups = data.groups ?? [];
  sidebarGroup = groups[0]?.id ?? null;
  element('app-version').textContent = data.version;
}).catch(showError).finally(() => {
  setLocale(settings.language);
  document.documentElement.lang = locale();
  localize(document);
  localize(paneTemplate.content);
  activatePane(createPane());
  showWorkspace(false);
});
