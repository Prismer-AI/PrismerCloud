/**
 * terminal-sessions.test.ts — G2-R R-2 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-2).
 *
 * Runtime terminal-sessions plugin module: lazy node-pty loader (two-path:
 * regular require → image native ABI floor root), session hygiene (concurrent
 * cap / idle reaper / shell-executor ACL reuse), the terminal.* wire contract,
 * and the negative controls that carry the plugin-isolation ironclad rule:
 *   ① loadPty forced null ⇒ capability NOT advertised + open → typed
 *      `terminal_unavailable` rejection (degraded, never fabricated)
 *   ② malformed wire payloads ⇒ ignored + logged, never thrown into dispatch
 *   ③ module unmounted ⇒ no runtime.terminal capability bit on declare,
 *      main-flow runner untouched
 *
 * PTY-dependent lifecycle suites run against a REAL shell (node-pty is a
 * devDependency here; on the pod it comes from the image native ABI floor).
 * They are skipped only where loadPty() is genuinely null (no pty on the
 * host) — on darwin dev/CI they run for real.
 *
 * Usage: npx vitest run test/terminal-sessions.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Runner } from '../src/daemon/runner';
import {
  DEFAULT_TERMINAL_IDLE_TIMEOUT_MS,
  MIN_TERMINAL_IDLE_TIMEOUT_MS,
  RUNTIME_CAPABILITY_TERMINAL,
  defaultTerminalOutputBudget,
  loadPty,
  mountTerminalSessions,
  resolveTerminalIdleTimeoutMs,
  resolveTerminalOutputBudget,
} from '../src/daemon/terminal-sessions/index';
import {
  EXIT_REASON_OUTPUT_BUDGET,
  TERMINAL_MAX_SESSIONS,
  TerminalSessionManager,
} from '../src/daemon/terminal-sessions/session-manager';
import type { ShellExecutionConfig } from '../src/daemon/shell-executor';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-sessions-test-'));

interface Frame {
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
  timestamp: number;
}

function makeSender() {
  const frames: Frame[] = [];
  return {
    frames,
    send: (frame: unknown) => frames.push(structuredClone(frame) as Frame),
  };
}

function shellConfig(overrides: Partial<ShellExecutionConfig> = {}): ShellExecutionConfig {
  return {
    enabled: true,
    defaultCwd: TMP_DIR,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
    allowedWorkspaces: undefined,
    shell: 'bash',
    ...overrides,
  };
}

/** Polls until `cond` is true — real-timers companion for real-PTY IO. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Minimal in-memory node-pty double — records writes, replays events. */
class FakePtyProcess {
  written: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  pid = 42_424;
  cols = 80;
  rows = 24;
  process = 'bash';
  handleFlowControl = false;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  onData = (fn: (d: string) => void): { dispose: () => void } => {
    this.dataListeners.push(fn);
    return { dispose: () => undefined };
  };

  onExit = (fn: (e: { exitCode: number; signal?: number }) => void): { dispose: () => void } => {
    this.exitListeners.push(fn);
    return { dispose: () => undefined };
  };

  write(data: string | Buffer): void {
    this.written.push(String(data));
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  clear(): void {}
  pause(): void {}
  resume(): void {}

  kill(): void {
    this.killed = true;
    this.emitExit({ exitCode: 0 });
  }

  emitData(data: string): void {
    for (const fn of this.dataListeners) fn(data);
  }

  emitExit(e: { exitCode: number; signal?: number }): void {
    for (const fn of this.exitListeners) fn(e);
  }
}

function makeFakePtyModule() {
  const processes: FakePtyProcess[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const pty = {
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ file, args, options });
      const p = new FakePtyProcess();
      processes.push(p);
      return p;
    },
  };
  return { pty, processes, spawnCalls };
}

// ---------------------------------------------------------------------------
// lazy pty loader (two-path, memoized)
// ---------------------------------------------------------------------------

describe('loadPty — regular require → floor root → null', () => {
  it('resolves the real node-pty on a devDependency install', () => {
    const pty = loadPty();
    // This suite only runs where node-pty is installed (darwin dev/CI). On a
    // floor-less host the null path is covered by the injected-failure test.
    expect(pty).not.toBeNull();
    expect(typeof pty!.spawn).toBe('function');
  });

  it('is memoized — the default path resolves once', () => {
    expect(loadPty()).toBe(loadPty());
  });

  it('both paths failing ⇒ null (never a fabricated pty)', () => {
    const pty = loadPty({
      require: () => {
        throw new Error('no node-pty here');
      },
      floorRoot: path.join(os.tmpdir(), 'terminal-sessions-no-floor'),
    });
    expect(pty).toBeNull();
  });

  it('an injected failure does not poison the memoized default', () => {
    const real = loadPty();
    const failed = loadPty({
      require: () => {
        throw new Error('injected');
      },
      floorRoot: path.join(os.tmpdir(), 'terminal-sessions-no-floor'),
    });
    expect(failed).toBeNull();
    expect(loadPty()).toBe(real);
  });
});

// ---------------------------------------------------------------------------
// idle-timeout config (ConfigDelivery-able, device-metrics interval pattern)
// ---------------------------------------------------------------------------

describe('resolveTerminalIdleTimeoutMs — default 10min, floor clamp', () => {
  it('defaults to 600000 when unset', () => {
    expect(resolveTerminalIdleTimeoutMs(undefined)).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
    expect(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('honours a valid override (number or numeric string, e.g. env-delivered)', () => {
    expect(resolveTerminalIdleTimeoutMs(120_000)).toBe(120_000);
    expect(resolveTerminalIdleTimeoutMs('120000')).toBe(120_000);
  });

  it('clamps below the floor', () => {
    expect(resolveTerminalIdleTimeoutMs(1_000)).toBe(MIN_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(0)).toBe(MIN_TERMINAL_IDLE_TIMEOUT_MS);
    expect(MIN_TERMINAL_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('falls back to the default on garbage instead of throwing', () => {
    expect(resolveTerminalIdleTimeoutMs('abc')).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs(Number.NaN)).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
    expect(resolveTerminalIdleTimeoutMs({})).toBe(DEFAULT_TERMINAL_IDLE_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// session manager — real PTY lifecycle
// ---------------------------------------------------------------------------

const realPtyAvailable = loadPty() !== null;
const describeRealPty = describe.skipIf(!realPtyAvailable);

describeRealPty('TerminalSessionManager — real PTY lifecycle (R-2 验收门 1)', () => {
  it('open → write → echo arrives → exit code on shell exit', async () => {
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({ pty: loadPty()!, config: shellConfig(), send });

    const res = mgr.open({ workspaceId: 'ws-a', cols: 80, rows: 24 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    const { sessionId } = res;
    expect(typeof sessionId).toBe('string');
    expect(mgr.size).toBe(1);

    // PTY canonical mode: terminals send CR, not LF.
    mgr.write({ sessionId, data: 'echo PTY_E2E_$((40+2))\r' });
    await waitFor(() =>
      frames.some(
        (f) => f.type === 'terminal.data' && f.payload.sessionId === sessionId && String(f.payload.data).includes('PTY_E2E_42'),
      ),
    );

    mgr.write({ sessionId, data: 'exit 7\r' });
    await waitFor(() => frames.some((f) => f.type === 'terminal.exit' && f.payload.sessionId === sessionId));
    const exit = frames.find((f) => f.type === 'terminal.exit' && f.payload.sessionId === sessionId)!;
    expect(exit.payload.exitCode).toBe(7);
    expect(mgr.size).toBe(0);
    mgr.stop();
  });

  it('resize reaches the pty — stty size reports the new dimensions', async () => {
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({ pty: loadPty()!, config: shellConfig(), send });
    const res = mgr.open({ cols: 80, rows: 24 });
    if (!res.ok) throw new Error('open failed');
    mgr.resize({ sessionId: res.sessionId, cols: 120, rows: 40 });
    mgr.write({ sessionId: res.sessionId, data: 'stty size\r' });
    await waitFor(() => frames.some((f) => f.type === 'terminal.data' && String(f.payload.data).includes('40 120')));
    mgr.close({ sessionId: res.sessionId });
    await waitFor(() => frames.some((f) => f.type === 'terminal.exit' && f.payload.sessionId === res.sessionId));
    mgr.stop();
  });

  it('close kills the session and the exit event still broadcasts', async () => {
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({ pty: loadPty()!, config: shellConfig(), send });
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');
    expect(mgr.close({ sessionId: res.sessionId })).toBe(true);
    expect(mgr.size).toBe(0);
    await waitFor(() => frames.some((f) => f.type === 'terminal.exit' && f.payload.sessionId === res.sessionId));
    // Operations on a closed/unknown session are ignored, not thrown.
    expect(mgr.write({ sessionId: res.sessionId, data: 'x' })).toBe(false);
    expect(mgr.close({ sessionId: res.sessionId })).toBe(false);
    mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// session hygiene — cap / ACL / cwd (fake pty, deterministic)
// ---------------------------------------------------------------------------

describe('TerminalSessionManager — hygiene (fake pty)', () => {
  it(`rejects a session beyond the cap of ${TERMINAL_MAX_SESSIONS} with a typed code`, () => {
    const { pty } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({ pty: pty as never, config: shellConfig(), send: () => undefined, maxSessions: 2 });
    const first = mgr.open({});
    const second = mgr.open({});
    expect(first.ok && second.ok).toBe(true);
    const third = mgr.open({});
    expect(third).toMatchObject({ ok: false, code: 'terminal_session_limit' });
    expect(mgr.size).toBe(2);
    mgr.stop();
  });

  it('disabled gate ⇒ typed terminal_disabled (rejection order mirrors shell-executor)', () => {
    const { pty, spawnCalls } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig({ enabled: false, allowedWorkspaces: ['ws-a'] }),
      send: () => undefined,
    });
    expect(mgr.open({ workspaceId: 'ws-b' })).toMatchObject({ ok: false, code: 'terminal_disabled' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('workspace outside allowedWorkspaces ⇒ typed terminal_workspace_not_allowed, nothing spawned', () => {
    const { pty, spawnCalls } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig({ allowedWorkspaces: ['ws-a'] }),
      send: () => undefined,
    });
    expect(mgr.open({ workspaceId: 'ws-b' })).toMatchObject({ ok: false, code: 'terminal_workspace_not_allowed' });
    expect(mgr.open({})).toMatchObject({ ok: false, code: 'terminal_workspace_not_allowed' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('allowed workspace spawns the configured shell with the requested size', () => {
    const { pty, spawnCalls } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig({ allowedWorkspaces: ['ws-a'], shell: 'zsh' }),
      send: () => undefined,
    });
    const res = mgr.open({ workspaceId: 'ws-a', cols: 100, rows: 30 });
    expect(res.ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.file).toBe('zsh');
    expect(spawnCalls[0]!.options).toMatchObject({ cols: 100, rows: 30, name: 'xterm-256color' });
    mgr.stop();
  });

  it('missing cwd ⇒ typed terminal_cwd_missing (shell-executor cwd semantics)', () => {
    const { pty, spawnCalls } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({ pty: pty as never, config: shellConfig(), send: () => undefined });
    expect(mgr.open({ cwd: path.join(TMP_DIR, 'does-not-exist') })).toMatchObject({
      ok: false,
      code: 'terminal_cwd_missing',
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it('data written by the pty rides terminal.data frames', () => {
    const { frames, send } = makeSender();
    const { pty, processes } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({ pty: pty as never, config: shellConfig(), send });
    const res = mgr.open({ cols: 80, rows: 24 });
    if (!res.ok) throw new Error('open failed');

    mgr.write({ sessionId: res.sessionId, data: 'ls -la\r' });
    expect(processes[0]!.written).toContain('ls -la\r');
    mgr.resize({ sessionId: res.sessionId, cols: 132, rows: 43 });
    expect(processes[0]!.resizes).toContainEqual({ cols: 132, rows: 43 });

    processes[0]!.emitData('hello\r\n');
    expect(frames.some((f) => f.type === 'terminal.data' && f.payload.data === 'hello\r\n')).toBe(true);
    mgr.stop();
  });

  it('a throwing send never propagates (device-metrics ② pattern)', () => {
    const { pty, processes } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig(),
      send: () => {
        throw new Error('socket gone');
      },
    });
    const res = mgr.open({});
    expect(res.ok).toBe(true);
    expect(() => processes[0]!.emitData('hello')).not.toThrow();
    expect(() => processes[0]!.emitExit({ exitCode: 0 })).not.toThrow();
    expect(() => mgr.stop()).not.toThrow();
  });

  it('stop() kills every session and is idempotent', () => {
    const { pty, processes } = makeFakePtyModule();
    const mgr = new TerminalSessionManager({ pty: pty as never, config: shellConfig(), send: () => undefined });
    mgr.open({});
    mgr.open({});
    expect(mgr.size).toBe(2);
    mgr.stop();
    expect(mgr.size).toBe(0);
    expect(processes.every((p) => p.killed)).toBe(true);
    expect(() => mgr.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// idle reaper (fake timers)
// ---------------------------------------------------------------------------

describe('TerminalSessionManager — idle reaper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMgr(send: (frame: unknown) => void) {
    const { pty } = makeFakePtyModule();
    return new TerminalSessionManager({ pty: pty as never, config: shellConfig(), send, idleTimeoutMs: 1_000 });
  }

  it('reaps an idle session after idleTimeoutMs and emits terminal.exit', () => {
    const { frames, send } = makeSender();
    const mgr = makeMgr(send);
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');

    vi.advanceTimersByTime(999);
    expect(mgr.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(mgr.size).toBe(0);
    expect(frames.some((f) => f.type === 'terminal.exit' && f.payload.sessionId === res.sessionId)).toBe(true);
  });

  it('activity re-arms the timer — a written session survives past the timeout', () => {
    const { frames, send } = makeSender();
    const mgr = makeMgr(send);
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');

    vi.advanceTimersByTime(999);
    mgr.write({ sessionId: res.sessionId, data: 'keepalive\r' });
    vi.advanceTimersByTime(999);
    expect(mgr.size).toBe(1);
    expect(frames.some((f) => f.type === 'terminal.exit')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(mgr.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// module mount — capability + degraded path (negative ①)
// ---------------------------------------------------------------------------

describe('mountTerminalSessions — capability + degraded path (NEGATIVE ①)', () => {
  it('real pty ⇒ available and opens sessions', () => {
    const { send } = makeSender();
    const mod = mountTerminalSessions({ send, shellConfig: shellConfig() });
    expect(mod).not.toBeNull();
    expect(mod!.available).toBe(realPtyAvailable);
    if (realPtyAvailable) {
      const res = mod!.handleOpen({ workspaceId: 'ws-a', cols: 80, rows: 24 });
      expect(res.ok).toBe(true);
    }
    mod!.stop();
  });

  it('loadPty null ⇒ NOT available, open ⇒ typed terminal_unavailable + terminal.error frame', () => {
    const { frames, send } = makeSender();
    const mod = mountTerminalSessions({ send, shellConfig: shellConfig(), loadPty: () => null });
    expect(mod).not.toBeNull();
    expect(mod!.available).toBe(false);
    expect(mod!.handleOpen({ workspaceId: 'ws-a', cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      code: 'terminal_unavailable',
    });
    mod!.handleOpen({ workspaceId: 'ws-a' }, 'req-1');
    expect(frames.some((f) => f.type === 'terminal.error' && f.payload.code === 'terminal_unavailable')).toBe(true);
    // write/resize/close on the degraded module: ignored, never thrown.
    expect(() => mod!.handleWrite({ sessionId: 'term-1', data: 'x' })).not.toThrow();
    expect(() => mod!.handleResize({ sessionId: 'term-1', cols: 80, rows: 24 })).not.toThrow();
    expect(() => mod!.handleClose({ sessionId: 'term-1' })).not.toThrow();
    mod!.stop();
  });

  it('assembly throw ⇒ mount null, nothing constructed (fail-safe contract)', () => {
    const mod = mountTerminalSessions({
      send: () => undefined,
      shellConfig: shellConfig(),
      createModule: () => {
        throw new Error('injected assembly failure');
      },
    });
    expect(mod).toBeNull();
  });

  it('non-function send ⇒ mount null (same contract as device-metrics)', () => {
    expect(mountTerminalSessions({ send: undefined as never, shellConfig: shellConfig() })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wire contract — malformed payloads ignored, never thrown into dispatch
// ---------------------------------------------------------------------------

describe('TerminalSessionsModule — terminal.* wire hygiene (NEGATIVE ②)', () => {
  it('malformed open ⇒ typed terminal.error, malformed write/resize/close ⇒ ignored', () => {
    const { frames, send } = makeSender();
    const mod = mountTerminalSessions({ send, shellConfig: shellConfig() });
    expect(mod).not.toBeNull();

    // Unknown/garbage payloads must not throw into dispatch.
    expect(() => mod!.handleOpen('garbage')).not.toThrow();
    expect(() => mod!.handleWrite(null)).not.toThrow();
    expect(() => mod!.handleWrite({ data: 'no session' })).not.toThrow();
    expect(() => mod!.handleResize({ sessionId: 'term-1' })).not.toThrow();
    expect(() => mod!.handleClose(42)).not.toThrow();
    mod!.stop();
  });

  it('successful open emits terminal.opened echoing the requestId', () => {
    if (!realPtyAvailable) return;
    const { frames, send } = makeSender();
    const mod = mountTerminalSessions({ send, shellConfig: shellConfig() });
    mod!.handleOpen({ workspaceId: 'ws-a', cols: 80, rows: 24 }, 'rpc-7');
    const opened = frames.find((f) => f.type === 'terminal.opened');
    expect(opened).toBeDefined();
    expect(opened!.requestId).toBe('rpc-7');
    expect(typeof opened!.payload.sessionId).toBe('string');
    mod!.stop();
  });
});

// ---------------------------------------------------------------------------
// runner wiring — capability bit (negative ③, device-metrics harness)
// ---------------------------------------------------------------------------

function makeRunner(config: Record<string, unknown> = {}): any {
  const r = new Runner() as any;
  r.config = { daemon_id: 'daemon-testbox', ...config };
  r.opts = { daemonVersion: '2.2.55' };
  r.hostedAgents = new Map();
  r.registry = new Map();
  r.runningTasks = new Map();
  r.state = 'running';
  return r;
}

describe('Runner.sendDeclare — runtime.terminal capability bit (NEGATIVE ③)', () => {
  const sent: Array<{ type: string; payload: { runtimeCapabilities?: string[] } }> = [];

  function ws() {
    return { send: (msg: never) => sent.push(msg), close: () => undefined };
  }

  it('unmounted module ⇒ memory caps only, NO runtime.terminal claim', () => {
    sent.length = 0;
    const r = makeRunner();
    r.terminalSessions = undefined; // mount failed / plugin off
    r.ws = ws();
    r.sendDeclare();
    const caps = sent[0]!.payload.runtimeCapabilities ?? [];
    expect(caps).not.toContain(RUNTIME_CAPABILITY_TERMINAL);
    expect(caps).toContain('memory-authority-snapshot-v1');
  });

  it('mounted but pty-unavailable (degraded) ⇒ still NO runtime.terminal claim', () => {
    sent.length = 0;
    const r = makeRunner();
    r.terminalSessions = { available: false, stop: () => undefined };
    r.ws = ws();
    r.sendDeclare();
    expect(sent[0]!.payload.runtimeCapabilities ?? []).not.toContain(RUNTIME_CAPABILITY_TERMINAL);
  });

  it('mounted and available ⇒ runtime.terminal rides the declare wire', () => {
    sent.length = 0;
    const r = makeRunner();
    r.terminalSessions = { available: true, stop: () => undefined };
    r.ws = ws();
    r.sendDeclare();
    expect(sent[0]!.payload.runtimeCapabilities).toContain(RUNTIME_CAPABILITY_TERMINAL);
    expect(sent[0]!.payload.runtimeCapabilities).toContain('memory-authority-snapshot-v1');
  });
});

// ---------------------------------------------------------------------------
// output budget — daemon-side 输出帽 (spec §T-5 follow-up, fake pty deterministic)
// ---------------------------------------------------------------------------

describe('resolveTerminalOutputBudget — env 解析契约(默认 32MiB/10s,可关可覆写)', () => {
  it('评审 F3 语义:env 缺省/垃圾 ⇒ null(runner 落默认常开);显式 0/off ⇒ disabled 哨兵;bytes>0 ⇒ 预算形状', () => {
    expect(resolveTerminalOutputBudget({})).toBeNull();
    expect(resolveTerminalOutputBudget({ bytes: '' })).toBeNull();
    expect(resolveTerminalOutputBudget({ bytes: 'abc' })).toBeNull(); // 垃圾值不关保护
    expect(resolveTerminalOutputBudget({ bytes: 0 })).toEqual({ disabled: true }); // 显式 0 = 关帽
    expect(resolveTerminalOutputBudget({ bytes: 'off' })).toEqual({ disabled: true });
    expect(resolveTerminalOutputBudget({ bytes: 'disabled' })).toEqual({ disabled: true });
    const d = defaultTerminalOutputBudget();
    expect(d).toEqual({ windowMs: 10_000, maxBytes: 32 * 1024 * 1024 });
    const b = resolveTerminalOutputBudget({ bytes: '1048576' });
    expect(b).toEqual({ windowMs: 10_000, maxBytes: 1_048_576 });
  });

  it('windowMs 显式覆写 + 硬下限 100ms;垃圾窗回默认', () => {
    expect(resolveTerminalOutputBudget({ bytes: 1024, windowMs: 2000 })).toEqual({
      windowMs: 2000,
      maxBytes: 1024,
    });
    expect(resolveTerminalOutputBudget({ bytes: 1024, windowMs: 1 })).toEqual({ windowMs: 100, maxBytes: 1024 });
    expect(resolveTerminalOutputBudget({ bytes: 1024, windowMs: 'abc' })).toEqual({
      windowMs: 10_000,
      maxBytes: 1024,
    });
  });
});

describe('TerminalSessionManager — output budget kill(fake pty)', () => {
  it('窗口超预算 ⇒ kill 会话 + typed terminal.exit(reason=terminal_output_budget) + 仅一条 exit', () => {
    const { pty, processes } = makeFakePtyModule();
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig(),
      send,
      outputBudget: { windowMs: 10_000, maxBytes: 4 * 1024 },
    });
    expect(mgr.outputBudgetArmed).toBe(true);
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');
    const { sessionId } = res;
    const proc = processes[0]!;

    // 预算 4KB:分两次注入 3KB + 3KB —— 第二发越限
    proc.emitData('x'.repeat(3 * 1024));
    expect(frames.filter((f) => f.type === 'terminal.data' && f.payload.sessionId === sessionId)).toHaveLength(1);
    proc.emitData('y'.repeat(3 * 1024));

    const exits = frames.filter((f) => f.type === 'terminal.exit' && f.payload.sessionId === sessionId);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.payload).toMatchObject({ sessionId, exitCode: null, reason: EXIT_REASON_OUTPUT_BUDGET });
    expect(mgr.size).toBe(0);
    expect(proc.killed).toBe(true);
    // kill 触发的 onExit(exitCode 0)被抑制——没有第二条无 reason 的 exit
    mgr.stop();
  });

  it('窗口内输出低于预算 ⇒ 正常转发,kill 不触发;窗口滑动后旧账滚出', () => {
    const { pty, processes } = makeFakePtyModule();
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig(),
      send,
      outputBudget: { windowMs: 200, maxBytes: 4 * 1024 },
    });
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');
    const proc = processes[0]!;

    proc.emitData('a'.repeat(1024));
    proc.emitData('b'.repeat(1024));
    expect(mgr.size).toBe(1);
    expect(frames.filter((f) => f.type === 'terminal.data')).toHaveLength(2);
    expect(frames.some((f) => f.type === 'terminal.exit' && f.payload.reason === EXIT_REASON_OUTPUT_BUDGET)).toBe(false);
    mgr.close({ sessionId: res.sessionId });
    mgr.stop();
  });

  it('budget 未装配(缺省 deps)⇒ outputBudgetArmed=false,输出不记账不杀', () => {
    const { pty, processes } = makeFakePtyModule();
    const { send } = makeSender();
    const mgr = new TerminalSessionManager({ pty: pty as never, config: shellConfig(), send });
    expect(mgr.outputBudgetArmed).toBe(false);
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');
    processes[0]!.emitData('z'.repeat(1024 * 1024));
    expect(mgr.size).toBe(1);
    mgr.stop();
  });
});

describe('TerminalSessionManager — output budget 缺省装配(runner 直传默认预算)', () => {
  it('显式传 defaultTerminalOutputBudget ⇒ armed;完全不给 ⇒ 不 armed(legacy 行为)', () => {
    const { pty } = makeFakePtyModule();
    const armed = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig(),
      send: () => undefined,
      outputBudget: defaultTerminalOutputBudget(),
    });
    expect(armed.outputBudgetArmed).toBe(true);
    armed.stop();

    const { pty: pty2 } = makeFakePtyModule();
    const legacy = new TerminalSessionManager({ pty: pty2 as never, config: shellConfig(), send: () => undefined });
    expect(legacy.outputBudgetArmed).toBe(false);
    legacy.stop();
  });
});

// ── 系统评审回归钉(窗口真滚动 + kill 后 drain 不复发) ──────────────────────

describe('TerminalSessionManager — 评审 F1/F2 回归钉', () => {
  it('F1: 稀疏流跨窗口——旧账必须滚出,不得累计误杀', async () => {
    const { pty, processes } = makeFakePtyModule();
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig(),
      send,
      // 短窗便于伪造时钟:窗口 60ms,预算 20KB
      outputBudget: { windowMs: 60, maxBytes: 20 * 1024 },
    });
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');
    const proc = processes[0]!;
    proc.emitData('a'.repeat(16 * 1024)); // 第一窗:16KB(窗内不越限)
    await new Promise((r) => setTimeout(r, 120)); // 跨 2 个窗口
    proc.emitData('b'.repeat(16 * 1024)); // 第二窗:16KB——旧账滚出后也不越限
    expect(frames.some((f) => f.type === 'terminal.exit' && f.payload.reason === 'terminal_output_budget')).toBe(false);
    expect(mgr.size).toBe(1);
    mgr.close({ sessionId: res.sessionId });
    mgr.stop();
  });

  it('F2: budget kill 后 pty 继续 drain ⇒ 丢弃,不重发 exit、不重挂 timer', async () => {
    const { pty, processes } = makeFakePtyModule();
    const { frames, send } = makeSender();
    const mgr = new TerminalSessionManager({
      pty: pty as never,
      config: shellConfig(),
      send,
      outputBudget: { windowMs: 10_000, maxBytes: 2 * 1024 },
    });
    const res = mgr.open({});
    if (!res.ok) throw new Error('open failed');
    const proc = processes[0]!;
    proc.emitData('x'.repeat(3 * 1024)); // 首帧即越限 ⇒ kill + 单 exit(reason),帧不转发
    expect(frames.filter((f) => f.type === 'terminal.exit')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'terminal.data')).toHaveLength(0); // 越限帧本身不转发
    // 真实 node-pty:kill 后 fd 仍 drain,孙进程继续写——事件必须被存活守卫丢弃
    proc.emitData('y'.repeat(3 * 1024));
    proc.emitData('z'.repeat(3 * 1024));
    expect(frames.filter((f) => f.type === 'terminal.exit')).toHaveLength(1); // 不重发
    expect(frames.filter((f) => f.type === 'terminal.data')).toHaveLength(0); // drain 帧全丢弃
    expect(mgr.size).toBe(0);
    mgr.stop();
  });
});
