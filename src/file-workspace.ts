import { locale, t } from './i18n.js';
import { CopyWindow, PermissionsWindow } from './file-dialogs.js';
import type { CopyProgress, FileCommand, FileEntry, FileListing, FileSide, FilesApi, SessionStatus } from './protocol.js';

type PanelOperation = Exclude<FileCommand['type'], 'permissions'>;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function action(label: string, callback: () => void) {
  const button = make('button', label);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

const sides: FileSide[] = ['local', 'remote'];

function opposite(side: FileSide): FileSide {
  return side === 'local' ? 'remote' : 'local';
}

function errorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

class Panel {
  private readonly collator = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
  private readonly dateFormat = new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'short' });
  readonly element = make('section', undefined, 'file-panel');
  readonly path = make('input');
  readonly list = make('div', undefined, 'file-list');
  readonly empty = make('p', '', 'file-empty');
  readonly selection = new Set<string>();
  listing?: FileListing;
  rows: (FileEntry | null)[] = [];
  cursor = 0;

  constructor(readonly side: FileSide, workspace: FileWorkspace) {
    const local = side === 'local';
    const heading = make('h2', local ? t('Computer') : t('Server'));
    const controls = make('div', undefined, 'file-path');
    this.path.setAttribute('aria-label', local ? t('Local folder') : t('Remote folder'));
    this.path.spellcheck = false;
    this.path.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void workspace.navigate(this, this.path.value);
      }
    });
    controls.append(this.path, action('↑', () => workspace.up(this)));
    if (local) controls.append(action(t('Browse…'), () => void workspace.chooseLocal()));
    const columns = make('div', undefined, 'file-columns');
    columns.append(make('span', t('Name')), make('span', t('Size')), make('span', t('Modified')));
    this.list.tabIndex = 0;
    this.list.setAttribute('aria-label', heading.textContent);
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.list.addEventListener('focus', () => workspace.activate(this.side));
    this.list.addEventListener('keydown', (event) => workspace.listKey(event, this));
    this.element.append(heading, controls, columns, this.list, this.empty);
  }

  display(listing: FileListing, workspace: FileWorkspace, restore?: string) {
    const previousName = restore ?? (this.listing?.path === listing.path ? this.rows[this.cursor]?.name : undefined);
    if (this.listing?.path !== listing.path) this.selection.clear();
    this.listing = listing;
    this.path.value = listing.path;
    this.rows = listing.entries.toSorted((left, right) => Number(right.kind === 'directory') -
      Number(left.kind === 'directory') || this.collator.compare(left.name, right.name));
    if (listing.parent) this.rows.unshift(null);
    const available = new Set(listing.entries.map((item) => item.name));
    for (const name of this.selection) if (!available.has(name)) this.selection.delete(name);
    this.cursor = Math.max(0, this.rows.findIndex((row) => row?.name === previousName));
    this.empty.textContent = this.rows.length ? '' : t('Folder is empty');
    const fragment = document.createDocumentFragment();
    this.rows.forEach((row, index) => {
      const line = make('div', undefined, 'file-row');
      line.id = workspace.id + '-' + this.side + '-' + index;
      line.setAttribute('role', 'option');
      const title = make('span', (row?.kind === 'directory' || !row ? '▸ ' : row.kind === 'link' ? '↗ ' : '') + (row?.name ?? '..'));
      title.title = row?.name ?? t('Up one level');
      const modified = row?.modified && Number.isFinite(row.modified) ? new Date(row.modified) : undefined;
      line.append(title, make('span', row?.kind === 'file' ? row.size.toLocaleString() : ''),
        make('span', modified && !Number.isNaN(modified.valueOf()) ? this.dateFormat.format(modified) : ''));
      line.addEventListener('click', (event) => {
        workspace.activate(this.side);
        this.list.focus();
        this.cursor = index;
        if (row && (event.ctrlKey || event.metaKey)) this.toggle(row.name);
        else this.selection.clear();
        this.paint();
      });
      line.addEventListener('dblclick', () => workspace.enter(this));
      if (this.side === 'remote' && row) {
        line.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          this.cursor = index;
          this.paint();
          workspace.openRemoteMenu(row, event.clientX, event.clientY);
        });
      }
      fragment.append(line);
    });
    this.list.replaceChildren(fragment);
    this.paint();
  }

  move(index: number) {
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, index));
    this.paint();
    this.list.children[this.cursor]?.scrollIntoView({ block: 'nearest' });
  }

  names() {
    const row = this.rows[this.cursor];
    return this.selection.size ? [...this.selection] : row ? [row.name] : [];
  }

  toggle(name: string) {
    if (!this.selection.delete(name)) this.selection.add(name);
  }

  paint() {
    const cursor = this.list.children[this.cursor];
    if (cursor) this.list.setAttribute('aria-activedescendant', cursor.id);
    else this.list.removeAttribute('aria-activedescendant');
    Array.from(this.list.children).forEach((row, index) => {
      const item = this.rows[index];
      const marked = item !== null && this.selection.has(item.name);
      row.classList.toggle('file-cursor', index === this.cursor);
      row.classList.toggle('file-marked', marked);
      row.setAttribute('aria-selected', String(marked || (this.selection.size === 0 && index === this.cursor)));
    });
  }
}

export class FileWorkspace {
  readonly pane = make('div', undefined, 'file-workspace');
  private readonly panels: Record<FileSide, Panel>;
  private readonly dialog = make('dialog');
  private readonly copyWindow = new CopyWindow();
  private readonly permissionsWindow = new PermissionsWindow();
  private readonly contextMenu = make('div', undefined, 'context-menu file-context-menu');
  private contextEvents?: AbortController;
  private readonly retry: HTMLButtonElement;
  private readonly password: HTMLButtonElement;
  private active: FileSide = 'local';
  private busy = false;
  private closed = false;
  private questionPending = false;

  constructor(
    readonly id: string, private readonly profile: string, private readonly api: FilesApi,
    private readonly report: (status: SessionStatus, detail?: string) => void,
    private readonly error: (reason: unknown) => void,
    private readonly clipboard: (text: string) => void,
  ) {
    this.panels = { local: new Panel('local', this), remote: new Panel('remote', this) };
    const columns = make('div', undefined, 'file-panels');
    columns.append(this.panels.local.element, this.panels.remote.element);
    const toolbar = make('div', undefined, 'file-actions');
    this.retry = action(t('Connect'), () => void this.connect());
    this.password = action(t('Enter password'), () => void this.enterPassword());
    this.retry.hidden = this.password.hidden = true;
    toolbar.append(action(t('F2 Rename'), () => void this.operation('rename')),
      action(t('F5 Copy'), () => void this.operation('copy')),
      action(t('F7 New folder'), () => void this.operation('mkdir')),
      action(t('F8 Delete'), () => void this.operation('delete')),
      action(t('Refresh'), () => void this.refresh()), this.retry, this.password);
    this.contextMenu.hidden = true;
    this.contextMenu.setAttribute('role', 'menu');
    this.contextMenu.setAttribute('aria-label', t('Remote file actions'));
    this.contextMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.dismissContext();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const choices = Array.from(this.contextMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const selected = choices.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowUp' ? -1 : 1;
        choices[(selected + choices.length + step) % choices.length]?.focus();
      }
    });
    this.pane.append(columns, toolbar, this.dialog, this.copyWindow.element, this.permissionsWindow.element, this.contextMenu);
    this.pane.addEventListener('keydown', (event) => {
      if (this.dialog.open || this.permissionsWindow.element.open || !this.contextMenu.hidden) return;
      const type = ({ F2: 'rename', F5: 'copy', F7: 'mkdir', F8: 'delete' } as const)[event.key as 'F2' | 'F5' | 'F7' | 'F8'];
      if (type) {
        event.preventDefault();
        if (!event.repeat) void this.operation(type);
      }
    });
    this.activate('local');
  }

  focus() {
    this.panels[this.active].list.focus();
  }

  close() {
    this.closed = true;
    this.dialog.close();
    this.permissionsWindow.close();
    this.dismissContext(false);
    this.api.close(this.id);
    this.pane.remove();
  }

  copyProgress(progress: CopyProgress) {
    this.copyWindow.update(progress);
  }

  dismissContext(focus = true) {
    if (this.contextMenu.hidden) return;
    this.contextMenu.hidden = true;
    this.contextEvents?.abort();
    this.contextEvents = undefined;
    if (focus && !this.closed && !this.pane.hidden) this.focus();
  }

  openRemoteMenu(entry: FileEntry, x: number, y: number) {
    if (this.busy || this.closed || this.dialog.open || this.permissionsWindow.element.open) return;
    const directory = this.panels.remote.listing?.path;
    if (!directory) return;
    this.dismissContext(false);
    this.activate('remote');
    const absolute = directory.replace(/\/$/, '') + '/' + entry.name;
    const copy = action(t('Copy path'), () => {
      this.clipboard(absolute);
      this.dismissContext();
    });
    const permissions = action(t('Permissions…'), () => {
      this.dismissContext();
      void this.editPermissions(entry.name, absolute);
    });
    permissions.disabled = entry.kind !== 'file' && entry.kind !== 'directory';
    for (const choice of [copy, permissions]) choice.setAttribute('role', 'menuitem');
    this.contextMenu.replaceChildren(copy, permissions);
    this.contextMenu.hidden = false;
    const box = this.pane.getBoundingClientRect();
    const fit = (value: number, size: number, menuSize: number) => Math.max(0, Math.min(value, size - menuSize));
    this.contextMenu.style.left = fit(x - box.left, box.width, this.contextMenu.offsetWidth) + 'px';
    this.contextMenu.style.top = fit(y - box.top, box.height, this.contextMenu.offsetHeight) + 'px';
    this.contextEvents = new AbortController();
    const options = { signal: this.contextEvents.signal };
    document.addEventListener('pointerdown', (event) => {
      if (!this.contextMenu.contains(event.target as Node)) this.dismissContext(false);
    }, options);
    window.addEventListener('blur', () => this.dismissContext(false), options);
    copy.focus();
  }

  async connect(password?: string) {
    if (this.busy || this.closed) return;
    this.setBusy(true);
    this.report('connecting');
    this.retry.hidden = this.password.hidden = true;
    this.panels.remote.empty.textContent = t('Connecting…');
    try {
      const remote = this.api.open(this.id, this.profile, password);
      const local = this.api.list(this.id, 'local').then((listing) => {
        if (!this.closed) this.panels.local.display(listing, this);
      }).catch((error) => { if (!this.closed) this.error(error); });
      try {
        const listing = await remote;
        if (this.closed) return;
        this.panels.remote.display(listing, this);
        this.report('connected');
      } finally {
        await local;
      }
    } catch (error) {
      if (!this.closed) {
        const detail = errorMessage(error);
        this.panels.remote.empty.textContent = detail;
        this.retry.hidden = false;
        this.password.hidden = !/authentication|password|permission denied/i.test(detail);
        this.report('failed', detail);
      }
    } finally {
      this.setBusy(false);
    }
  }

  activate(side: FileSide) {
    this.active = side;
    for (const name of sides) this.panels[name].element.classList.toggle('file-active', side === name);
  }

  listKey(event: KeyboardEvent, panel: Panel) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const row = panel.rows[panel.cursor];
      const node = panel.list.children[panel.cursor];
      if (panel.side === 'remote' && row && node) {
        event.preventDefault();
        const box = node.getBoundingClientRect();
        this.openRemoteMenu(row, box.left + 12, box.bottom);
      }
      return;
    }
    switch (event.key) {
      case 'Tab': this.panels[opposite(panel.side)].list.focus(); break;
      case 'ArrowDown': panel.move(panel.cursor + 1); break;
      case 'ArrowUp': panel.move(panel.cursor - 1); break;
      case 'PageDown': panel.move(panel.cursor + Math.max(1, Math.floor(panel.list.clientHeight / 27))); break;
      case 'PageUp': panel.move(panel.cursor - Math.max(1, Math.floor(panel.list.clientHeight / 27))); break;
      case 'Home': panel.move(0); break;
      case 'End': panel.move(panel.rows.length - 1); break;
      case 'Enter': this.enter(panel); break;
      case 'Backspace': this.up(panel); break;
      case 'Insert': {
        const row = panel.rows[panel.cursor];
        if (row) panel.toggle(row.name);
        panel.move(panel.cursor + 1);
        break;
      }
      case ' ':
        if (panel.rows[panel.cursor]) panel.toggle(panel.rows[panel.cursor]!.name);
        panel.paint();
        break;
      default: return;
    }
    event.preventDefault();
  }

  enter(panel: Panel) {
    if (!panel.rows.length) return;
    const row = panel.rows[panel.cursor];
    if (!row) this.up(panel);
    else if (row.kind === 'directory' || row.kind === 'link') void this.navigate(panel, row.name);
  }

  up(panel: Panel) {
    if (panel.listing?.parent) {
      const name = panel.listing.path.split(panel.side === 'local' ? /[\\/]/ : '/').filter(Boolean).at(-1);
      void this.navigate(panel, panel.listing.parent, name);
    }
  }

  async navigate(panel: Panel, path?: string, restore?: string) {
    if (this.busy || this.closed) {
      panel.path.value = panel.listing?.path ?? '';
      return;
    }
    await this.withBusy(async () => {
      try {
        const listing = await this.api.list(this.id, panel.side, path);
        if (this.closed) return;
        panel.display(listing, this, restore);
        if (!this.pane.hidden) {
          this.activate(panel.side);
          panel.list.focus();
        }
      } catch (error) {
        panel.path.value = panel.listing?.path ?? '';
        throw error;
      }
    });
  }

  async chooseLocal() {
    await this.withBusy(async () => {
      const listing = await this.api.chooseLocal(this.id);
      if (listing && !this.closed) {
        this.panels.local.display(listing, this);
        this.activate('local');
        this.focus();
      }
    });
  }

  private async refresh() {
    await this.withBusy(() => this.refreshListings());
  }

  private async refreshListings() {
    await Promise.all(sides.map(async (side) => {
      if (!this.panels[side].listing || this.closed) return;
      const listing = await this.api.list(this.id, side);
      if (!this.closed) this.panels[side].display(listing, this);
    }));
  }

  private async enterPassword() {
    const value = await this.ask(t('SFTP password'), t('The password will only be used for this connection.'), t('Connect'), 'password');
    if (value) await this.connect(value);
  }

  private async editPermissions(name: string, fullPath: string) {
    await this.withBusy(async () => {
      const info = await this.api.permissions(this.id, name);
      if (this.closed || this.pane.hidden) return;
      const changes = await this.permissionsWindow.open(fullPath, info);
      if (!changes || this.closed) return;
      try {
        await this.api.run(this.id, { type: 'permissions', side: 'remote', name, changes });
      } finally {
        await this.refreshListings().catch((error) => { if (!this.closed) this.error(error); });
      }
    });
    if (!this.pane.hidden && !this.closed) this.focus();
  }

  private async operation(type: PanelOperation) {
    if (this.busy || this.dialog.open || this.closed) return;
    const side = this.active;
    const panel = this.panels[side];
    if (!panel.listing) return;
    const names = panel.names();
    let command: FileCommand;
    if (type === 'mkdir') {
      const name = await this.ask(t('New folder'), panel.listing.path, t('Create'), 'text');
      if (!name) return;
      command = { type, side, name };
    } else {
      if (!names.length) return;
      if (type === 'rename') {
        if (names.length !== 1) { this.error(t('Select one item.')); return; }
        const newName = await this.ask(t('Rename'), names[0], t('Rename'), 'text', names[0]);
        if (!newName || newName === names[0]) return;
        command = { type, side, name: names[0], newName };
      } else {
        const description = names.length === 1 ? '«' + names[0] + '»' : t('Items: {count}', { count: names.length });
        if (type === 'copy' && !this.panels[opposite(side)].listing) { this.error(t('Open the destination folder first.')); return; }
        const target = type === 'copy' ? this.panels[opposite(side)].listing?.path : panel.listing.path;
        const verb = type === 'copy' ? t('Copy') : t('Delete');
        const detail = description + '\n' + target + (type === 'delete' ? t('\nFolder contents will also be permanently deleted.') : '');
        if (await this.ask(verb + '?', detail, verb, undefined, undefined, type === 'delete') === null) return;
        command = { type, side, names };
      }
    }
    await this.withBusy(async () => {
      if (command.type === 'copy') this.copyWindow.open();
      try {
        await this.api.run(this.id, command);
        panel.selection.clear();
      } finally {
        if (command.type === 'copy') this.copyWindow.close();
        await this.refreshListings().catch((error) => { if (!this.closed) this.error(error); });
      }
    });
    if (!this.pane.hidden && !this.closed) this.focus();
  }

  private async withBusy(task: () => Promise<void>) {
    if (this.busy || this.closed) return;
    this.setBusy(true);
    try { await task(); }
    catch (error) {
      if (!this.closed) {
        if (errorMessage(error) === t('The SFTP connection is closed. Connect again.')) {
          this.retry.hidden = false;
          this.report('failed', errorMessage(error));
        }
        this.error(error);
      }
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.pane.classList.toggle('file-busy', busy);
    this.pane.setAttribute('aria-busy', String(busy));
  }

  private ask(title: string, message: string, label: string, field?: 'text' | 'password', initial = '', danger = false) {
    if (this.closed || this.questionPending) return Promise.resolve(null);
    const form = make('form');
    form.method = 'dialog';
    const heading = make('h2', title);
    this.dialog.setAttribute('aria-label', title);
    form.append(heading, make('p', message, 'file-confirm-detail'));
    const input = make('input');
    if (field) {
      input.type = field;
      input.value = initial;
      input.required = true;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', title);
      form.append(input);
    }
    const actions = make('div', undefined, 'dialog-actions');
    const cancel = action(t('Cancel'), () => this.dialog.close('cancel'));
    const confirm = make('button', label, danger ? 'danger' : 'primary');
    confirm.value = 'yes';
    actions.append(cancel, confirm);
    form.append(actions);
    this.dialog.replaceChildren(form);
    this.dialog.returnValue = 'cancel';
    this.questionPending = true;
    this.dialog.showModal();
    if (field) { input.focus(); input.select(); }
    else (danger ? cancel : confirm).focus();
    return new Promise<string | null>((resolve) => this.dialog.addEventListener('close', () => {
      this.questionPending = false;
      const result = this.dialog.returnValue === 'yes' && !this.closed ? field ? input.value : '' : null;
      input.value = '';
      resolve(result);
    }, { once: true }));
  }
}
