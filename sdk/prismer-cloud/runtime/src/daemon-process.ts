import * as fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Types
// ============================================================

export type DaemonState = 'starting' | 'running' | 'shutting_down' | 'stopped';

export interface DaemonOptions {
  pidFile?: string;
  dataDir?: string;
  logFile?: string;
  installSignalHandlers?: boolean;
}

export interface ShutdownHandler {
  name: string;
  handler: () => Promise<void> | void;
}

// ============================================================
// Errors
// ============================================================

export class DaemonAlreadyRunningError extends Error {
  readonly existingPid: number;
  readonly pidFile: string;

  constructor(pid: number, pidFile: string) {
    super(`Another daemon instance is already running (PID ${pid}, PID file: ${pidFile})`);
    this.name = 'DaemonAlreadyRunningError';
    this.existingPid = pid;
    this.pidFile = pidFile;
  }
}

// ============================================================
// DaemonProcess
// ============================================================

export class DaemonProcess {
  private _state: DaemonState = 'starting';
  private readonly _pidFile: string;
  private readonly _dataDir: string;
  private readonly _logFile: string;
  private readonly _installSignalHandlers: boolean;
  private readonly _shutdownHandlers: ShutdownHandler[] = [];
  private readonly _signalHistory: Array<{ signal: string; ts: number }> = [];
  private _shutdownInProgress = false;

  private _sigTermHandler: (() => void) | null = null;
  private _sigIntHandler: (() => void) | null = null;
  private _sigHupHandler: (() => void) | null = null;
  // Second-signal guard: if SIGTERM/SIGINT fires while we're already shutting
  // down, the operator wants to hard-kill. process.exit(1) to avoid hanging.
  private _signalReceived = false;

  constructor(opts?: DaemonOptions) {
    const home = os.homedir();
    this._pidFile = opts?.pidFile ?? path.join(home, '.prismer', 'daemon.pid');
    this._dataDir = opts?.dataDir ?? path.join(home, '.prismer');
    this._logFile = opts?.logFile ?? path.join(home, '.prismer', 'daemon.log');
    this._installSignalHandlers = opts?.installSignalHandlers ?? true;
  }

  get state(): DaemonState {
    return this._state;
  }

  get pid(): number {
    return process.pid;
  }

  get pidFile(): string {
    return this._pidFile;
  }

  get dataDir(): string {
    return this._dataDir;
  }

  get signalHistory(): ReadonlyArray<{ signal: string; ts: number }> {
    return this._signalHistory;
  }

  async start(): Promise<void> {
    if (this._state !== 'starting') {
      throw new Error(`Cannot start: current state is '${this._state}', expected 'starting'`);
    }

    const subdirs = [
      this._dataDir,
      path.join(this._dataDir, 'logs'),
      path.join(this._dataDir, 'sandbox'),
      path.join(this._dataDir, 'data'),
      path.join(this._dataDir, 'config'),
    ];
    for (const dir of subdirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._atomicPidWrite();

    if (this._installSignalHandlers) {
      // Signal handlers await shutdown() then process.exit(0). We don't rely
      // on the event loop draining on its own — upstream deps (ws, keep-alive
      // sockets, node-fetch) leak timers that keep the process alive past
      // shutdown, which caused every `daemon stop` to fall through to the
      // 10s SIGKILL path.
      const handleTerm = (signal: 'SIGTERM' | 'SIGINT') => async (): Promise<void> => {
        if (this._signalReceived) {
          // Operator hit Ctrl+C twice / kill -TERM a second time. Hard-exit.
          process.exit(1);
        }
        this._signalReceived = true;
        this._recordSignal(signal);
        try {
          await this.shutdown(signal);
        } catch {
          // Shutdown errors are already logged by shutdown() handler loop.
        }
        process.exit(0);
      };
      this._sigTermHandler = (): void => { void handleTerm('SIGTERM')(); };
      this._sigIntHandler = (): void => { void handleTerm('SIGINT')(); };
      this._sigHupHandler = () => {
        this._recordSignal('SIGHUP');
        void this.reload();
      };
      process.on('SIGTERM', this._sigTermHandler);
      process.on('SIGINT', this._sigIntHandler);
      process.on('SIGHUP', this._sigHupHandler);
    }

    this._state = 'running';
  }

  onShutdown(h: ShutdownHandler): void {
    this._shutdownHandlers.push(h);
  }

  async shutdown(signal?: NodeJS.Signals | 'manual'): Promise<void> {
    if (this._state === 'stopped' || this._state === 'shutting_down') {
      return;
    }
    if (this._state !== 'running') {
      throw new Error(`Cannot shutdown: current state is '${this._state}', expected 'running'`);
    }

    if (this._shutdownInProgress) {
      return;
    }
    this._shutdownInProgress = true;

    this._state = 'shutting_down';

    const reversed = [...this._shutdownHandlers].reverse();
    for (const { name, handler } of reversed) {
      try {
        await handler();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[DaemonProcess] Shutdown handler '${name}' failed: ${msg}`);
      }
    }

    try {
      fs.rmSync(this._pidFile, { force: true });
    } catch {
      // Best effort
    }

    if (this._installSignalHandlers) {
      if (this._sigTermHandler) process.off('SIGTERM', this._sigTermHandler);
      if (this._sigIntHandler) process.off('SIGINT', this._sigIntHandler);
      if (this._sigHupHandler) process.off('SIGHUP', this._sigHupHandler);
      this._sigTermHandler = null;
      this._sigIntHandler = null;
      this._sigHupHandler = null;
    }

    this._state = 'stopped';
    console.log(`[DaemonProcess] Stopped (signal=${signal ?? 'manual'})`);
  }

  async reload(): Promise<void> {
    console.log('[DaemonProcess] SIGHUP received — reload requested');
  }

  static isRunning(pidFile: string): boolean {
    if (!fs.existsSync(pidFile)) {
      return false;
    }
    try {
      const raw = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = parseInt(raw, 10);
      if (isNaN(pid) || pid <= 0) {
        return false;
      }
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  static cleanupStalePidFile(pidFile: string): boolean {
    if (DaemonProcess.isRunning(pidFile)) {
      return false;
    }
    try {
      fs.rmSync(pidFile, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private _atomicPidWrite(): void {
    let fd: number;
    let cleanedStale = false;

    const openExclusive = (): number => {
      return fs.openSync(
        this._pidFile,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o644,
      );
    };

    try {
      fd = openExclusive();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw e;

      // PID file exists — check whether the owning process is still alive.
      if (DaemonProcess.isRunning(this._pidFile)) {
        const pid = this._readPidFromFile(this._pidFile) ?? 0;
        throw new DaemonAlreadyRunningError(pid, this._pidFile);
      }

      // Stale — remove and retry exactly once.
      fs.rmSync(this._pidFile, { force: true });
      cleanedStale = true;

      try {
        fd = openExclusive();
      } catch (retryErr) {
        const e2 = retryErr as NodeJS.ErrnoException;
        if (e2.code === 'EEXIST') {
          // Another process raced in and recreated the pidfile between our rm and retry.
          if (DaemonProcess.isRunning(this._pidFile)) {
            const pid = this._readPidFromFile(this._pidFile) ?? 0;
            throw new DaemonAlreadyRunningError(pid, this._pidFile);
          }
          throw new Error(`Race on PID file ${this._pidFile}; retry start`);
        }
        throw retryErr;
      }
    }

    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }

    if (cleanedStale) {
      console.log('[DaemonProcess] Cleaned stale PID file');
    }
  }

  private _recordSignal(signal: string): void {
    this._signalHistory.push({ signal, ts: Date.now() });
  }

  private _readPidFromFile(pidFile: string): number | null {
    try {
      const raw = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = parseInt(raw, 10);
      return isNaN(pid) || pid <= 0 ? null : pid;
    } catch {
      return null;
    }
  }
}
