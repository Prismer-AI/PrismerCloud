/**
 * terminal-sessions/index.ts — G2-R R-2 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-2).
 *
 * Plugin module assembly for the workspace 终端: composes the lazy pty loader
 * + session manager behind one surface and owns the terminal.* wire contract:
 *
 *   inbound  terminal.open   { workspaceId?, cols?, rows?, cwd? } + requestId
 *   inbound  terminal.write  { sessionId, data }
 *   inbound  terminal.resize { sessionId, cols, rows }
 *   inbound  terminal.close  { sessionId }
 *   outbound terminal.opened { sessionId }                          (echoes requestId)
 *   outbound terminal.data   { sessionId, data }
 *   outbound terminal.exit   { sessionId, exitCode }
 *   outbound terminal.error  { code, message }                      (echoes requestId)
 *
 * PLUGIN ISOLATION (the ironclad rule): `mountTerminalSessions` is the only
 * thing the runner calls. It is fail-safe BY CONTRACT — any throw during
 * assembly is logged and answered with `null`; the runner then simply runs
 * without terminals. Dispatch / declare / sync / OTA never observe the
 * module, mounted or not.
 *
 * DEGRADED PATH (never fabricate): when loadPty() returns null the module
 * still mounts but `available` is false — NO `runtime.terminal` capability
 * claim on agent.host.declare, and terminal.open is answered with the typed
 * `terminal_unavailable` rejection so the cloud UI degrades instead of
 * hanging.
 */

import { envelope } from '../../envelope.js';
import type { ShellExecutionConfig } from '../shell-executor.js';
import {
  DEFAULT_TERMINAL_IDLE_TIMEOUT_MS,
  MIN_TERMINAL_IDLE_TIMEOUT_MS,
  resolveTerminalIdleTimeoutMs,
} from './timeout.js';
import type { TerminalOutputBudget } from './timeout.js';
import { loadPty, type PtyModule } from './pty-loader.js';
import {
  TERMINAL_MAX_SESSIONS,
  TerminalSessionManager,
  type TerminalOpenResult,
} from './session-manager.js';

/**
 * Capability bit declared on `agent.host.declare` (runtimeCapabilities[])
 * when — and only when — the module mounted AND loadPty() actually produced
 * a pty (G2-R R-2; cloud-side consumers treat an absent claim as "terminal
 * not offered", same seam as `runtime.metrics`).
 */
export const RUNTIME_CAPABILITY_TERMINAL = 'runtime.terminal';

export { loadPty, NATIVE_FLOOR_ROOT, type LoadPtyDeps, type PtyModule } from './pty-loader.js';
export {
  DEFAULT_TERMINAL_IDLE_TIMEOUT_MS,
  MIN_TERMINAL_IDLE_TIMEOUT_MS,
  resolveTerminalIdleTimeoutMs,
  resolveTerminalOutputBudget,
  defaultTerminalOutputBudget,
  disabledTerminalOutputBudget,
} from './timeout.js';
export type { TerminalOutputBudget } from './timeout.js';
export { TERMINAL_MAX_SESSIONS, TerminalSessionManager } from './session-manager.js';
export type { TerminalOpenResult, TerminalRejectionCode } from './session-manager.js';

export interface TerminalSessionsModuleOptions {
  /** Outbound transport — the runner passes `(frame) => this.ws.send(frame)`. */
  send: (frame: unknown) => void;
  /** Shell-executor ACL config (resolveShellConfig output) — reused verbatim. */
  shellConfig: ShellExecutionConfig;
  /** Idle reaper timeout; pre-resolve PRISMER_TERMINAL_IDLE_TIMEOUT_MS at the runner. */
  terminalIdleTimeoutMs?: number;
  /**
   * Daemon-side windowed output budget (spec §T-5 follow-up). Runner
   * pre-resolves PRISMER_TERMINAL_OUTPUT_BUDGET_BYTES /
   * PRISMER_TERMINAL_OUTPUT_BUDGET_WINDOW_MS; 缺省 = 32MiB/10s。
   */
  terminalOutputBudget?: TerminalOutputBudget;
  maxSessions?: number;
  /** Loader seam — injection point for the degraded-path negative control. */
  loadPty?: () => PtyModule | null;
  /**
   * Assembly override — injection seam for the runner-wiring negative
   * control (a throwing factory proves the mount is fail-safe). Production
   * callers never set it.
   */
  createModule?: (opts: TerminalSessionsModuleOptions) => TerminalSessionsModule;
}

/** Composed plugin module: lazy-loaded pty host behind the terminal.* surface. */
export class TerminalSessionsModule {
  /** True only when a pty was actually loaded — gates the capability claim. */
  readonly available: boolean;
  private readonly manager: TerminalSessionManager | null;
  private readonly send: (frame: unknown) => void;

  constructor(opts: TerminalSessionsModuleOptions) {
    if (typeof opts.send !== 'function') {
      throw new TypeError('TerminalSessionsModule: send must be a function');
    }
    if (!opts.shellConfig || typeof opts.shellConfig !== 'object') {
      throw new TypeError('TerminalSessionsModule: shellConfig is required');
    }
    this.send = opts.send;
    const pty = (opts.loadPty ?? loadPty)();
    this.available = pty !== null;
    this.manager = pty
      ? new TerminalSessionManager({
          pty,
          config: opts.shellConfig,
          send: opts.send,
          idleTimeoutMs: opts.terminalIdleTimeoutMs,
          outputBudget: opts.terminalOutputBudget,
          maxSessions: opts.maxSessions,
        })
      : null;
  }

  /**
   * terminal.open — validates, delegates to the manager and answers with
   * `terminal.opened` / `terminal.error` (both echoing the requestId).
   * Malformed payloads get the typed `terminal_open_failed` error frame;
   * they never throw into dispatch.
   */
  handleOpen(payload: unknown, requestId?: string): TerminalOpenResult {
    const req =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const result = this.answer(req, requestId);
    if (result.ok) this.safeSend(envelope('terminal.opened', { sessionId: result.sessionId }, requestId));
    else this.safeSend(envelope('terminal.error', { code: result.code, message: result.message }, requestId));
    return result;
  }

  /** terminal.write — unknown/malformed frames are ignored + logged. */
  handleWrite(payload: unknown): void {
    const req = asRecord(payload);
    if (!req || typeof req.sessionId !== 'string' || typeof req.data !== 'string') {
      this.ignore('terminal.write');
      return;
    }
    this.manager?.write({ sessionId: req.sessionId, data: req.data });
  }

  /** terminal.resize — unknown/malformed frames are ignored + logged. */
  handleResize(payload: unknown): void {
    const req = asRecord(payload);
    if (!req || typeof req.sessionId !== 'string') {
      this.ignore('terminal.resize');
      return;
    }
    this.manager?.resize({ sessionId: req.sessionId, cols: req.cols, rows: req.rows });
  }

  /** terminal.close — unknown/malformed frames are ignored + logged. */
  handleClose(payload: unknown): void {
    const req = asRecord(payload);
    if (!req || typeof req.sessionId !== 'string') {
      this.ignore('terminal.close');
      return;
    }
    this.manager?.close({ sessionId: req.sessionId });
  }

  stop(): void {
    this.manager?.stop();
  }

  private answer(req: Record<string, unknown> | null, requestId?: string): TerminalOpenResult {
    if (!this.manager) {
      return { ok: false, code: 'terminal_unavailable', message: 'node-pty unavailable on this host — terminal degraded' };
    }
    if (!req) {
      return { ok: false, code: 'terminal_open_failed', message: 'malformed terminal.open payload' };
    }
    return this.manager.open({
      workspaceId: req.workspaceId,
      cols: req.cols,
      rows: req.rows,
      cwd: req.cwd,
    });
  }

  private ignore(type: string): void {
    process.stderr.write(`[TerminalSessions] ${type} dropped — malformed payload or no session\n`);
  }

  private safeSend(frame: unknown): void {
    try {
      this.send(frame);
    } catch (err) {
      process.stderr.write(`[TerminalSessions] send failed (non-fatal): ${(err as Error).message}\n`);
    }
  }
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/**
 * Fail-safe mount — the runner's ONLY entry point into this module.
 * Returns the mounted module, or null when assembly failed (the failure is
 * logged to stderr and swallowed: plugin stays off, startup continues
 * untouched).
 */
export function mountTerminalSessions(opts: TerminalSessionsModuleOptions): TerminalSessionsModule | null {
  try {
    return (opts.createModule ?? ((o) => new TerminalSessionsModule(o)))(opts);
  } catch (err) {
    process.stderr.write(
      `[TerminalSessions] mount failed (non-fatal — plugin stays off, startup unaffected): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}
