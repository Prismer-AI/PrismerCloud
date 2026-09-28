/**
 * terminal-sessions/timeout.ts — G2-R R-2 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-2).
 *
 * Idle-reaper timeout resolution for the terminal-sessions plugin module.
 *
 * The timeout is ConfigDelivery-able (device-metrics interval.ts pattern):
 * cloud can hand the daemon `PRISMER_TERMINAL_IDLE_TIMEOUT_MS` through the
 * runtime env surface. Resolution is pure so unit tests pin the contract:
 * default 10min (spec T-1 会话卫生: 空闲 10min 自动回收), hard floor 30s
 * (a misconfigured 1s reaper would kill interactive shells mid-command),
 * garbage falls back to the default instead of throwing.
 */

export const DEFAULT_TERMINAL_IDLE_TIMEOUT_MS = 10 * 60_000;
export const MIN_TERMINAL_IDLE_TIMEOUT_MS = 30_000;

export function resolveTerminalIdleTimeoutMs(raw?: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TERMINAL_IDLE_TIMEOUT_MS;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_IDLE_TIMEOUT_MS;
  if (n < MIN_TERMINAL_IDLE_TIMEOUT_MS) return MIN_TERMINAL_IDLE_TIMEOUT_MS;
  return n;
}

// ─── Daemon-side windowed output budget (spec §T-5 follow-up) ───────────────
//
// 与 idle timeout 同一条 ConfigDelivery 面:cloud 通过 runtime env 下发
// PRISMER_TERMINAL_OUTPUT_BUDGET_BYTES / PRISMER_TERMINAL_OUTPUT_BUDGET_WINDOW_MS。
// 缺省 32MiB / 10s(足够正常大输出命令,卡死/失控洪水在窗口内封顶);
// windowMs 有 100ms 硬下限(1ms 窗会让任何 burst 误杀)。解析纯函数便于单测。

import { DEFAULT_OUTPUT_BUDGET_BYTES, DEFAULT_OUTPUT_BUDGET_WINDOW_MS } from './session-manager';

export const MIN_TERMINAL_OUTPUT_BUDGET_WINDOW_MS = 100;

export interface TerminalOutputBudget {
  windowMs: number;
  maxBytes: number;
}

/**
 * Resolve `{PRISMER_TERMINAL_OUTPUT_BUDGET_BYTES, PRISMER_TERMINAL_OUTPUT_BUDGET_WINDOW_MS}`.
 *
 * 返回值语义(评审 F3 定版):env 完全缺省 ⇒ null(runner 落默认 32MiB/10s,
 * 帽子常开);显式 `0` / `off` / `disabled` ⇒ 明确关闭(哨兵);垃圾值 ⇒ null
 * (保持常开默认,不因配置错把保护关掉)。manager 层 `windowMs<=0` 即不 armed。
 */
export function resolveTerminalOutputBudget(raw?: {
  bytes?: unknown;
  windowMs?: unknown;
}): TerminalOutputBudget | { disabled: true } | null {
  const bytesRaw = raw?.bytes;
  if (bytesRaw === undefined || bytesRaw === null || bytesRaw === '') return null;
  const bytesRawStr = String(bytesRaw).trim().toLowerCase();
  // 显式关闭哨兵:0 / '0' / 'off' / 'disabled' / 'no'
  if (bytesRawStr === '0' || bytesRawStr === 'off' || bytesRawStr === 'disabled' || bytesRawStr === 'no') {
    return { disabled: true };
  }
  const bytes = Number(bytesRawStr);
  if (!Number.isFinite(bytes) || bytes <= 0) return null; // 垃圾值 = 保持默认(不因配错关保护)
  const windowRaw = raw?.windowMs;
  const windowMs =
    windowRaw === undefined || windowRaw === null || windowRaw === ''
      ? DEFAULT_OUTPUT_BUDGET_WINDOW_MS
      : typeof windowRaw === 'number'
        ? windowRaw
        : Number(String(windowRaw).trim());
  if (!Number.isFinite(windowMs)) return { windowMs: DEFAULT_OUTPUT_BUDGET_WINDOW_MS, maxBytes: bytes };
  if (windowMs < MIN_TERMINAL_OUTPUT_BUDGET_WINDOW_MS) {
    return { windowMs: MIN_TERMINAL_OUTPUT_BUDGET_WINDOW_MS, maxBytes: bytes };
  }
  return { windowMs, maxBytes: bytes };
}

/** 缺省预算(env 全缺省时的装配值——runner 恒显式传,函数供测试/文档)。 */
export function defaultTerminalOutputBudget(): TerminalOutputBudget {
  return { windowMs: DEFAULT_OUTPUT_BUDGET_WINDOW_MS, maxBytes: DEFAULT_OUTPUT_BUDGET_BYTES };
}

/** 关闭哨兵 → manager 的禁用形态(windowMs<=0 即不 armed)。 */
export function disabledTerminalOutputBudget(): { windowMs: 0; maxBytes: 0 } {
  return { windowMs: 0, maxBytes: 0 };
}
