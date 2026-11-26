import { localize, locale, t } from './i18n.js';
import type { CopyProgress, PermissionChanges, RemotePermissions } from './protocol.js';

function formatBytes(bytes: number) {
  const units = [t('B'), t('KiB'), t('MiB'), t('GiB'), t('TiB')];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    index++;
    bytes /= 1024;
  }
  return bytes.toLocaleString(locale(), { maximumFractionDigits: 1 }) + ' ' + units[index];
}

function formatTime(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join(':');
}

export class CopyWindow {
  readonly element = document.createElement('section');
  private readonly name: HTMLElement;
  private readonly bar: HTMLProgressElement;
  private readonly counts: HTMLElement;
  private readonly eta: HTMLElement;

  constructor() {
    this.element.className = 'file-copy-progress';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', t('Copy progress'));
    this.element.innerHTML = '<h2><span data-i18n>Copying</span></h2><p class="copy-name"></p>' +
      '<progress aria-label="Copied" data-i18n-aria-label></progress><p class="copy-counts"></p><p class="copy-eta"></p>';
    localize(this.element);
    this.name = this.element.querySelector('.copy-name')!;
    this.bar = this.element.querySelector('progress')!;
    this.counts = this.element.querySelector('.copy-counts')!;
    this.eta = this.element.querySelector('.copy-eta')!;
  }

  open() {
    this.update({ phase: 'scan' });
    this.element.hidden = false;
  }

  update(state: CopyProgress) {
    if (state.phase === 'scan') {
      this.name.textContent = t('Counting files and calculating size…');
      this.bar.removeAttribute('value');
      this.counts.textContent = '';
      this.eta.textContent = '';
      return;
    }
    this.name.textContent = state.name || t('Preparing the transfer…');
    this.name.title = state.name;
    if (state.totalBytes > 0 || state.totalFiles > 0) {
      this.bar.max = state.totalBytes || state.totalFiles;
      this.bar.value = state.totalBytes ? state.bytes : state.files;
    } else {
      this.bar.removeAttribute('value');
    }
    this.counts.textContent = t('{bytes} of {totalBytes} · {files} of {totalFiles} files', {
      bytes: formatBytes(state.bytes), totalBytes: formatBytes(state.totalBytes),
      files: state.files, totalFiles: state.totalFiles,
    });
    if (state.remaining !== null) this.eta.textContent = t('About {time} remaining', { time: formatTime(state.remaining) });
    else if (state.bytes >= state.totalBytes && state.files < state.totalFiles) {
      this.eta.textContent = t('Finishing writes…');
    } else if (!state.totalFiles) this.eta.textContent = t('Creating folders…');
    else this.eta.textContent = t('Estimating time…');
  }

  close() {
    this.element.hidden = true;
  }
}

const permissions = [
  ['Owner', 0o400, 0o200, 0o100, 0o4000, 'Set UID'],
  ['Group', 0o040, 0o020, 0o010, 0o2000, 'Set GID'],
  ['Others', 0o004, 0o002, 0o001, 0o1000, 'Sticky bit'],
] as const;

export class PermissionsWindow {
  readonly element = document.createElement('dialog');
  private readonly path: HTMLElement;
  private readonly uid: HTMLInputElement;
  private readonly gid: HTMLInputElement;
  private readonly oct: HTMLInputElement;
  private readonly recursive: HTMLInputElement;
  private readonly bits: HTMLInputElement[];
  private pending = false;

  constructor() {
    this.element.className = 'file-permissions';
    this.element.setAttribute('aria-label', t('Remote permissions'));
    this.element.innerHTML = '<form method="dialog"><h2><span data-i18n>Remote permissions</span></h2><p class="permissions-path"></p>' +
      '<div class="permission-ids"><label><span data-i18n>Owner UID</span><input name="uid" inputmode="numeric" pattern="[0-9]+" maxlength="10"></label>' +
      '<label><span data-i18n>Group GID</span><input name="gid" inputmode="numeric" pattern="[0-9]+" maxlength="10"></label></div>' +
      '<p class="permission-hint"><span data-i18n>Leave a field empty to keep the current owner or group.</span></p>' +
      '<fieldset><legend><span data-i18n>Permissions</span></legend><div class="permission-grid">' +
      permissions.map(([label, read, write, execute, special, specialLabel]) =>
        '<span>' + t(label) + '</span>' +
        [[read, 'R'], [write, 'W'], [execute, 'X'], [special, specialLabel]].map(([bit, text]) =>
          '<label><input type="checkbox" data-bit="' + bit + '" aria-label="' + t(label) + ' ' + text + '">' + text + '</label>'
        ).join('')).join('') +
      '</div></fieldset>' +
      '<label class="permission-oct">Oct<input name="oct" required inputmode="numeric" pattern="[0-7]{3,4}" maxlength="4"></label>' +
      '<label class="checkbox permission-recursive"><input type="checkbox" name="recursive"><span data-i18n>Apply to folder contents</span></label>' +
      '<div class="dialog-actions"><button type="button" class="permission-cancel"><span data-i18n>Cancel</span></button>' +
      '<button type="submit" value="apply" class="primary"><span data-i18n>Apply</span></button></div></form>';
    localize(this.element);
    this.path = this.element.querySelector('.permissions-path')!;
    this.uid = this.element.querySelector('[name="uid"]')!;
    this.gid = this.element.querySelector('[name="gid"]')!;
    this.oct = this.element.querySelector('[name="oct"]')!;
    this.recursive = this.element.querySelector('[name="recursive"]')!;
    this.bits = Array.from(this.element.querySelectorAll('[data-bit]'));
    this.element.querySelector('.permission-cancel')!.addEventListener('click', () => this.element.close('cancel'));
    for (const input of [this.uid, this.gid]) {
      input.addEventListener('input', () => {
        input.setCustomValidity(Number(input.value) >= 0xffffffff ? t('Enter a value between 0 and 4294967294.') : '');
      });
    }
    this.oct.addEventListener('input', () => {
      if (/^[0-7]{3,4}$/.test(this.oct.value)) this.paintBits(Number.parseInt(this.oct.value, 8));
    });
    for (const bit of this.bits) {
      bit.addEventListener('change', () => {
        const mode = this.bits.reduce((mode, item) => mode | (item.checked ? Number(item.dataset.bit) : 0), 0);
        this.oct.value = mode.toString(8).padStart(4, '0');
      });
    }
  }

  open(path: string, info: RemotePermissions): Promise<PermissionChanges | null> {
    if (this.pending) return Promise.resolve(null);
    this.pending = true;
    this.path.textContent = path;
    this.uid.value = this.gid.value = '';
    this.uid.setCustomValidity('');
    this.gid.setCustomValidity('');
    this.uid.placeholder = info.uid === null ? '—' : String(info.uid);
    this.gid.placeholder = info.gid === null ? '—' : String(info.gid);
    this.oct.value = info.mode.toString(8).padStart(4, '0');
    this.recursive.checked = false;
    this.recursive.disabled = !info.directory;
    this.recursive.parentElement!.hidden = !info.directory;
    this.paintBits(info.mode);
    this.element.returnValue = 'cancel';
    return new Promise((resolve) => {
      this.element.addEventListener('close', () => {
        this.pending = false;
        resolve(this.element.returnValue === 'apply' ? {
          mode: Number.parseInt(this.oct.value, 8),
          uid: this.uid.value ? Number(this.uid.value) : null,
          gid: this.gid.value ? Number(this.gid.value) : null,
          recursive: this.recursive.checked,
        } : null);
      }, { once: true });
      this.element.showModal();
      this.oct.focus();
      this.oct.select();
    });
  }

  close() {
    this.element.close('cancel');
  }

  private paintBits(mode: number) {
    for (const item of this.bits) item.checked = Boolean(mode & Number(item.dataset.bit));
  }
}
