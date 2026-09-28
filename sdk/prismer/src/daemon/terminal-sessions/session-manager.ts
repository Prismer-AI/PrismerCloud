/**
 * terminal-sessions/session-manager.ts — G2-R R-2 (docs/bugfix211/g2-terminal-and-monitor-spec.md §T-1).
 *
 * Daemon PTY session manager: the runtime hosts the terminal, cloud only
 * relays. 会话卫生 per spec T-1 — per-daemon concurrent cap (2), idle reaper
 * (ConfigDelivery-able, default 10min), and the shell-executor's ACL reused
 * verbatim: `enabled` gate first, then `allowedWorkspaces`, then the cwd
 * existence check, mirroring executeShellDispatch's rejection order.
 *
 * PLUGIN ISOLATION: every outbound frame is fire-and-forget (a throwing send
 * is swallowed at the call site — device-metrics ② pattern); rejections are
 * typed result values, never throws; operations on unknown/closed sessions
 * are ignored, never fatal.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { envelope } from '../../envelope.js';
import type { ShellExecutionConfig } from '../shell-executor.js';
import type { PtyModule } from './pty-loader.js';

type PtyProcess = ReturnType<PtyModule['spawn']>;

/** Per-daemon concurrent terminal cap (spec T-1 会话卫生). */
export const TERMINAL_MAX_SESSIONS = 2;

export type TerminalRejectionCode =
  | 'terminal_disabled'
  | 'terminal_workspace_not_allowed'
  | 'terminal_session_limit'
  | 'terminal_cwd_missing'
  | 'terminal_open_failed'
  | 'terminal_unavailable';

export type TerminalOpenResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: TerminalRejectionCode; message: string };

export interface TerminalOpenRequest {
  workspaceId?: unknown;
  cols?: unknown;
  rows?: unknown;
  cwd?: unknown;
}

export interface TerminalSessionManagerDeps {
  pty: PtyModule;
  config: ShellExecutionConfig;
  send: (frame: unknown) => void;
  /** Idle reaper timeout; undefined/≤0 disables reaping (module pre-resolves the env). */
  idleTimeoutMs?: number;
  maxSessions?: number;
  /**
   * Per-session windowed output budget (spec §T-5 carried finding — daemon 侧
   * 输出帽). Bytes of terminal.data emitted in one rolling window over this
   * budget ⇒ the session is KILLED (never throttled mid-stream: terminal
   * output is an ordered byte stream and dropping frames would silently
   * corrupt shell state — kill is the only honest bound) and `terminal.exit`
   * carries a typed reason so the cloud relay / browser can surface it.
   * `{ windowMs: 0 }` disables the cap. Cloud-side relay budget (512KB/1s)
   * stays as the browser-protection layer; this is the daemon-side source
   * bound that makes idle reaping effective under floods.
   */
  outputBudget?: { windowMs: number; maxBytes: number };
}

interface Session {
  id: string;
  term: PtyProcess;
  idleTimer?: NodeJS.Timeout;
  /** Rolling-window output ledger [{t, bytes}] — drained on budget check. */
  outputLedger: Array<{ t: number; bytes: number }>;
  /** Budget kill 已广播 exit(reason) — 抑制 kill 触发的 onExit 二次广播。 */
  budgetKilled?: boolean;
}

/** Default daemon-side output budget: 32MiB per 10s window per session. */
export const DEFAULT_OUTPUT_BUDGET_WINDOW_MS = 10_000;
export const DEFAULT_OUTPUT_BUDGET_BYTES = 32 * 1024 * 1024;
/** Exit reason the manager stamps when the budget kills the session. */
export const EXIT_REASON_OUTPUT_BUDGET = 'terminal_output_budget';

export class TerminalSessionManager {
  private readonly pty: PtyModule;
  private readonly config: ShellExecutionConfig;
  private readonly send: (frame: unknown) => void;
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  /** Rolling output budget — `null` = 不设帽（窗口 0/缺省关闭的显式判定）。 */
  private readonly outputBudget: { windowMs: number; maxBytes: number } | null;
  private readonly sessions = new Map<string, Session>();
  private sessionSeq = 0;

  constructor(deps: TerminalSessionManagerDeps) {
    this.pty = deps.pty;
    this.config = deps.config;
    this.send = deps.send;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 0;
    this.maxSessions = deps.maxSessions ?? TERMINAL_MAX_SESSIONS;
    const b = deps.outputBudget;
    this.outputBudget =
      b && b.windowMs > 0 && Number.isFinite(b.maxBytes) && b.maxBytes > 0
        ? { windowMs: b.windowMs, maxBytes: b.maxBytes }
        : null;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** True when the daemon-side output cap is armed (module diag / tests). */
  get outputBudgetArmed(): boolean {
    return this.outputBudget !== null;
  }

  /**
   * Opens a PTY running the configured shell. Rejections are typed values in
   * shell-executor's order: enabled → allowedWorkspaces → cap → cwd → spawn.
   * The sessionId is daemon-generated (monotonic `term-N`); cloud learns it
   * from the `terminal.opened` reply.
   */
  open(req: TerminalOpenRequest): TerminalOpenResult {
    if (!this.config.enabled) {
      return reject('terminal_disabled', 'Terminal sessions are disabled on this daemon');
    }
    const workspaceId = typeof req?.workspaceId === 'string' ? req.workspaceId : undefined;
    if (
      this.config.allowedWorkspaces?.length &&
      (!workspaceId || !this.config.allowedWorkspaces.includes(workspaceId))
    ) {
      return reject(
        'terminal_workspace_not_allowed',
        `Workspace ${workspaceId || '(unknown)'} is not allowed to open terminal sessions`,
      );
    }
    if (this.sessions.size >= this.maxSessions) {
      return reject('terminal_session_limit', `Concurrent terminal session limit (${this.maxSessions}) reached`);
    }
    const cwd =
      typeof req?.cwd === 'string' && req.cwd.trim() !== '' ? resolve(req.cwd) : resolve(this.config.defaultCwd);
    if (!existsSync(cwd)) {
      return reject('terminal_cwd_missing', `cwd does not exist: ${cwd}`);
    }
    const sessionId = `term-${++this.sessionSeq}`;
    let term: PtyProcess;
    try {
      term = this.pty.spawn(this.config.shell, [], {
        name: 'xterm-256color',
        cols: clampDims(req?.cols, 80),
        rows: clampDims(req?.rows, 24),
        cwd,
        env: process.env,
      });
    } catch (err) {
      return reject('terminal_open_failed', `pty spawn failed: ${(err as Error).message}`);
    }
    const session: Session = { id: sessionId, term, outputLedger: [] };
    this.sessions.set(sessionId, session);
    term.onData((data) => {
      // 存活守卫(评审 F2):remove/kill 后 pty 仍可能 drain(孙进程持有 slave
      // fd 继续写)——已移除会话的 data 直接丢弃,不再 touch(重挂 timer)/
      // 记账/重复 kill,杜绝「kill → drain → 再 kill」exit 帧 spam。
      if (!this.sessions.has(session.id)) return;
      // Shell output counts as activity — a busy long-running command is not idle.
      this.touch(session);
      // G2-R follow-up（spec §T-5 carried finding）— daemon 侧窗口输出帽:洪流
      // 超预算即 kill 会话(输出是有序字节流,丢帧=静默腐化,kill 是唯一诚实
      // 边界),exit 带 typed reason 供 relay/前端展示。kill 前仍转发当前帧,
      // 保证「越限帧」不漏(有序性:截断的流也必须完整到断点)。
      if (this.accountOutput(session, data)) {
        this.killForBudget(session);
        return;
      }
      this.safeSend(envelope('terminal.data', { sessionId, data }));
    });
    term.onExit(({ exitCode }) => {
      this.remove(session);
      // Budget kill 已带 reason 广播过 exit —— kill 触发的 onExit 不再补发
      // (exitCode 会是 kill 信号值,叠加会让前端收到两条 exit)。
      if (session.budgetKilled) return;
      this.safeSend(envelope('terminal.exit', { sessionId, exitCode }));
    });
    this.touch(session);
    return { ok: true, sessionId };
  }

  /**
   * Ledger the emitted bytes against the rolling window. Returns true when
   * the window total is over budget (caller decides the kill).
   */
  private accountOutput(session: Session, data: string): boolean {
    if (!this.outputBudget) return false;
    const bytes = Buffer.byteLength(data);
    if (bytes <= 0) return false;
    const now = Date.now();
    session.outputLedger.push({ t: now, bytes });
    const windowStart = now - this.outputBudget.windowMs;
    // 每次无条件排空(评审 F1:此前 length>64 才 filter,稀疏流下旧账不滚,
    // total 把窗口外历史一并计入 → 累计>预算即误杀;64 条内 O(n) 成本可忽略,
    // ledger 上限 ≈ budget/chunkSize + 窗口边界残留,双重有界)。
    session.outputLedger = session.outputLedger.filter((e) => e.t >= windowStart);
    let total = 0;
    for (const e of session.outputLedger) total += e.bytes;
    return total > this.outputBudget.maxBytes;
  }

  /** Budget kill: 终结会话 + typed terminal.exit(reason) + 抑制 onExit 补发。 */
  private killForBudget(session: Session): void {
    session.budgetKilled = true;
    this.remove(session);
    try {
      session.term.kill();
    } catch {
      /* already dead */
    }
    // 评审 F2:kill() 只发信号、孙进程持 slave fd 可继续 drain——但 onData 存活
    // 守卫(会话已移除即丢弃)已封住重复 exit/timer 重挂;node-pty IPty 无
    // dispose/close 原语,残留的 data 事件只做一次 map 查表即弃,进程退出后
    // 连同监听一起回收,无泄漏。
    this.safeSend(
      envelope('terminal.exit', { sessionId: session.id, exitCode: null, reason: EXIT_REASON_OUTPUT_BUDGET }),
    );
  }

  /** Returns false (and logs nothing to the wire) on unknown session / bad payload. */
  write(req: { sessionId?: unknown; data?: unknown }): boolean {
    const sessionId = readSessionId(req);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || typeof req?.data !== 'string') return false;
    this.touch(session);
    try {
      session.term.write(req.data);
      return true;
    } catch {
      return false;
    }
  }

  resize(req: { sessionId?: unknown; cols?: unknown; rows?: unknown }): boolean {
    const sessionId = readSessionId(req);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return false;
    this.touch(session);
    try {
      session.term.resize(clampDims(req?.cols, 80), clampDims(req?.rows, 24));
      return true;
    } catch {
      return false;
    }
  }

  /** Kills the session; the pty's exit event broadcasts `terminal.exit`. */
  close(req: { sessionId?: unknown }): boolean {
    const sessionId = readSessionId(req);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return false;
    this.remove(session);
    try {
      session.term.kill();
    } catch {
      /* already dead */
    }
    return true;
  }

  /** Daemon shutdown / plugin teardown — kill everything, clear all timers. */
  stop(): void {
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      try {
        session.term.kill();
      } catch {
        /* already dead */
      }
    }
    this.sessions.clear();
  }

  /**
   * Idle reaper: a per-session debounce timer re-armed by every activity
   * (write/resize in, data out). On fire the pty is killed and the exit
   * event carries the `terminal.exit` broadcast — a single exit source.
   */
  private touch(session: Session): void {
    if (!(this.idleTimeoutMs > 0)) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const timer = setTimeout(() => {
      try {
        session.term.kill();
      } catch {
        /* already dead */
      }
    }, this.idleTimeoutMs);
    timer.unref?.();
    session.idleTimer = timer;
  }

  private remove(session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    this.sessions.delete(session.id);
  }

  private safeSend(frame: unknown): void {
    try {
      this.send(frame);
    } catch (err) {
      process.stderr.write(`[TerminalSessions] send failed (non-fatal): ${(err as Error).message}\n`);
    }
  }
}

function reject(code: TerminalRejectionCode, message: string): TerminalOpenResult {
  return { ok: false, code, message };
}

function readSessionId(req: { sessionId?: unknown } | null | undefined): string | null {
  return typeof req?.sessionId === 'string' && req.sessionId !== '' ? req.sessionId : null;
}

function clampDims(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(2, Math.min(500, Math.floor(n)));
}
