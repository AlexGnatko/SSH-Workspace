import { t } from './i18n.js';
import { closeSync, fstatSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import type { Profile, SessionEvent, SessionStatus, Size } from './protocol.js';
import type { ConfirmKeyChange } from './known-hosts.js';
import { openSsh, readSshConfig, sshDestination } from './ssh-config.js';
import { isChangedHostKey, replaceTerminalHostKey } from './terminal-host-key.js';

type Attempt = {
  pty: IPty;
  log: string;
  monitor: NodeJS.Timeout;
  queue: string[];
  queued: number;
  sequence: number;
  inFlight: number | null;
  exitCode?: number;
  line: string;
  passwordReady: boolean;
  sawOutput: boolean;
  ipv4: boolean;
};

const chunkSize = 16 * 1024;
const queueLimit = 256 * 1024;
const transportError = /(?:connection (?:timed out|refused|reset|aborted)|network is (?:unreachable|down)|no route to host|broken pipe|operation timed out|server .+ not responding|temporary failure in name resolution|could not resolve hostname|connection(?: to .+)? closed by .+)/i;
const windows = process.platform === 'win32';
const executable = openSsh('ssh');

function readLog(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const length = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(length, 64 * 1024));
    const read = readSync(fd, buffer, 0, buffer.length, length - buffer.length);
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class SshSession {
  private attempt = 0;
  private failures = 0;
  private current?: Attempt;
  private retry?: NodeJS.Timeout;
  private ipv4Check?: Promise<boolean>;
  private rotation?: AbortController;
  private status: SessionStatus = 'connecting';

  constructor(
    private readonly id: string,
    private readonly profile: Profile,
    private size: Size,
    private readonly logDirectory: string,
    private readonly emit: (event: SessionEvent) => void,
    private readonly readPassword: (profile: Profile) => Promise<string>,
    private readonly confirmKeyChange?: ConfirmKeyChange,
  ) {}

  start(ipv4 = false) {
    if (this.current || this.rotation) return;
    this.cancelRetry();
    this.attempt++;
    this.setStatus('connecting');
    const log = join(this.logDirectory, this.id + '-' + this.attempt + '.log');
    const args = [
      '-v', '-tt',
      '-o', 'ConnectionAttempts=1',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-o', 'StrictHostKeyChecking=ask',
    ];
    if (ipv4) args.push('-4');
    if (this.profile.hasPassword) args.push('-o', 'PreferredAuthentications=password,keyboard-interactive,publickey');
    args.push(...sshDestination(this.profile));
    if (this.profile.tmux) args.push('tmux new -As work');

    const env = { ...process.env, TERM: 'xterm-256color', SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C' };
    try {
      // Windows OpenSSH locks files opened via -E for the lifetime of ssh.exe.
      const pty = spawn(
        windows ? join(__dirname, 'ssh-windows.exe') : executable,
        windows ? [executable, log, ...args] : ['-E', log, ...args],
        {
          ...this.size,
          name: 'xterm-256color',
          cwd: homedir(),
          env,
        },
      );
      const run: Attempt = {
        pty, log, monitor: setInterval(() => this.inspect(run), 250), queue: [],
        queued: 0, sequence: 0, inFlight: null, line: '', passwordReady: false, sawOutput: false, ipv4,
      };
      this.current = run;
      pty.onData((data) => this.output(run, data));
      pty.onExit(({ exitCode }) => {
        if (this.current !== run) return;
        run.exitCode = exitCode;
        clearInterval(run.monitor);
        this.flush(run);
      });
    } catch (error) {
      this.setStatus('failed', t('Не удалось запустить системный OpenSSH. {detail}', { detail: String(error) }));
    }
  }

  cancelRetry() {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.ipv4Check = undefined;
  }

  reconnect() {
    if (this.current || this.rotation) return;
    this.failures = 0;
    if (this.retry) {
      clearTimeout(this.retry);
      void this.retryConnection(this.retry);
    } else {
      this.start();
    }
  }

  private async canRetryIPv4() {
    try {
      const config = await readSshConfig(this.profile);
      return config.get('addressfamily') === 'any' && !config.proxy;
    } catch {
      return false;
    }
  }

  private async retryConnection(timer: NodeJS.Timeout) {
    const ipv4 = await (this.ipv4Check ?? false);
    if (this.retry === timer) this.start(ipv4);
  }

  async close() {
    this.cancelRetry();
    this.rotation?.abort();
    const run = this.current;
    this.current = undefined;
    if (!run) return;
    clearInterval(run.monitor);
    const request = run.log + '.close';
    try {
      if (run.exitCode === undefined) await this.disconnect(run, request);
    } finally {
      this.removeLog(request);
      this.removeLog(run.log);
    }
  }

  private disconnect(run: Attempt, request: string) {
    return new Promise<void>((resolve) => {
      const exited = run.pty.onExit(() => finish());
      const deadline = setTimeout(force, 2200);

      function finish() {
        clearTimeout(deadline);
        exited.dispose();
        resolve();
      }

      function force() {
        try {
          run.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
          if (process.platform === 'win32' && !run.sawOutput && run.pty.pid > 0) {
            // Windows node-pty defers kill until the first terminal output.
            process.kill(run.pty.pid);
          }
        } catch {
          // The process may have exited just before the timeout callback.
        }
        finish();
      }

      try {
        run.pty.resume();
        if (process.platform === 'win32') writeFileSync(request, '', { mode: 0o600 });
        else run.pty.kill('SIGTERM');
      } catch {
        force();
      }
    });
  }

  input(attempt: number, data: string) {
    const run = this.current;
    if (!run || this.attempt !== attempt || run.exitCode !== undefined) return;
    this.clearPasswordPrompt(run);
    run.pty.write(data);
  }

  async usePassword(attempt: number) {
    const run = this.current;
    if (!run || this.attempt !== attempt || !run.passwordReady || run.exitCode !== undefined) return;
    const password = await this.readPassword(this.profile);
    this.inspect(run);
    if (this.current === run && this.status === 'connecting' && run.passwordReady && run.exitCode === undefined) {
      this.input(attempt, password + '\r');
    }
  }

  resize(size: Size) {
    this.size = size;
    if (this.current?.exitCode === undefined) this.current?.pty.resize(size.cols, size.rows);
  }

  acknowledge(attempt: number, sequence: number) {
    const run = this.current;
    if (!run || this.attempt !== attempt || run.inFlight !== sequence) return;
    run.inFlight = null;
    this.flush(run);
  }

  private clearPasswordPrompt(run: Attempt) {
    run.line = '';
    if (run.passwordReady) {
      run.passwordReady = false;
      this.setStatus('connecting');
    }
  }

  private inspect(run: Attempt) {
    if (this.current !== run || this.status !== 'connecting') return;
    const log = readLog(run.log);
    if (/^Authenticated to .+ using "[^"]+"\./m.test(log) || /^debug1: Authentication succeeded /m.test(log)) {
      this.failures = 0;
      clearInterval(run.monitor);
      this.setStatus('connected');
      return;
    }
    if (!this.profile.hasPassword) return;
    const method = [...log.matchAll(/^debug1: Next authentication method: (\S+)/gm)].at(-1)?.[1];
    const ready = method === 'password' && /'s password:\s*$/i.test(run.line);
    if (run.passwordReady !== ready) {
      run.passwordReady = ready;
      this.setStatus('connecting', undefined, undefined, ready);
    }
  }

  private output(run: Attempt, data: string) {
    if (this.current !== run || !data) return;
    run.sawOutput = true;
    if (this.status === 'connecting' && this.profile.hasPassword) {
      const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      run.line = (run.line + plain.replace(/[\r\n]/g, '')).slice(-1024);
    }
    if (run.queued + data.length > queueLimit) {
      void this.close();
      this.setStatus('failed', t('Поток вывода превысил лимит очереди терминала.'));
      return;
    }
    if (run.inFlight === null) run.pty.pause();
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + chunkSize);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      run.queue.push(data.slice(offset, end));
      offset = end;
    }
    run.queued += data.length;
    this.flush(run);
  }

  private flush(run: Attempt) {
    if (run.inFlight !== null) return;
    const data = run.queue.shift();
    if (data !== undefined) {
      run.queued -= data.length;
      run.inFlight = ++run.sequence;
      this.emit({ id: this.id, attempt: this.attempt, type: 'output', sequence: run.inFlight, data });
      return;
    }
    if (run.exitCode === undefined) {
      run.pty.resume();
    } else {
      this.finish(run);
    }
  }

  private finish(run: Attempt) {
    const log = readLog(run.log);
    this.current = undefined;
    this.removeLog(run.log);
    if (this.status === 'connecting' && this.confirmKeyChange && isChangedHostKey(log)) {
      void this.handleKeyChange(log, run.ipv4, this.confirmKeyChange);
      return;
    }
    const lines = log.split(/\r?\n/).filter((line) =>
      line && !/^(?:debug\d+:|Authenticated to |Transferred:|Bytes per second:|Connection to .+ closed\.$)/.test(line));
    const detail = lines.at(-1)?.slice(0, 350);
    const remoteStatus = /^debug1: Exit status (\d+)\r?$/m.exec(log)?.[1];
    const remoteExit = remoteStatus !== undefined || /^debug1: client_input_channel_req: .* rtype exit-signal /m.test(log);
    const unexpected = !remoteExit && (run.exitCode !== 0 || /^debug1: Exit status -1\r?$/m.test(log));
    const networkDetail = lines.findLast((line) => transportError.test(line))?.slice(0, 350);
    if (unexpected && networkDetail &&
        !lines.some((line) => /host key verification failed|permission denied|authentication failed/i.test(line))) {
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(this.failures++, 4));
      const lastAddress = [...log.matchAll(/^debug1: Connecting to .* \[([^\]]+)\] port /gm)].at(-1)?.[1];
      if (run.ipv4 && this.status === 'connected') {
        this.ipv4Check = Promise.resolve(true);
      } else if (!run.ipv4 && lastAddress && isIP(lastAddress) === 6 && !isIP(this.profile.host) && this.status !== 'connected') {
        this.ipv4Check = this.canRetryIPv4();
      }
      const timer = setTimeout(() => void this.retryConnection(timer), delay);
      this.retry = timer;
      const diagnostic = /could not resolve hostname|temporary failure in name resolution/i.test(networkDetail)
        ? t('Не удалось разрешить имя сервера. {detail}', { detail: networkDetail }) : networkDetail;
      this.setStatus('waiting', diagnostic, Date.now() + delay);
      return;
    }
    this.setStatus(unexpected ? 'failed' : 'ended', unexpected && detail ? detail : t('Код выхода {code}', { code: remoteStatus ?? run.exitCode ?? '—' }));
  }

  private async handleKeyChange(log: string, ipv4: boolean, confirm: ConfirmKeyChange) {
    const rotation = new AbortController();
    this.rotation = rotation;
    this.setStatus('connecting', t('Сверка сменившегося ключа сервера…'));
    let retry = false;
    try {
      retry = await replaceTerminalHostKey(this.profile, log, confirm, rotation.signal);
      if (!retry && !rotation.signal.aborted) this.setStatus('failed', t('Новый ключ сервера не подтверждён.'));
    } catch (error) {
      if (!rotation.signal.aborted) {
        this.setStatus('failed', t('Ключ сервера изменился. {detail}', { detail: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      this.rotation = undefined;
    }
    if (retry && !rotation.signal.aborted) {
      this.failures = 0;
      this.start(ipv4);
    }
  }

  private removeLog(log: string) {
    try {
      rmSync(log, { force: true });
    } catch {
      // Windows can briefly keep the log open after terminating a process.
    }
  }

  private setStatus(status: SessionStatus, detail?: string, retryAt?: number, passwordReady?: boolean) {
    this.status = status;
    this.emit({ id: this.id, attempt: this.attempt, type: 'status', status, detail, retryAt, passwordReady });
  }
}
