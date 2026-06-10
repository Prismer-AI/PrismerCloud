/**
 * release201/30 §7 — frontend traceId mint + propagation.
 *
 * Frontend 起一个 trace id, 通过 X-Prismer-Trace-Id header 带给 cloud；
 * cloud 透传给 daemon, daemon dispatch 期间 stderr 行带 `[trace=<id>]`
 * 前缀。调试任何"文件去哪了 / 消息没到 / 上传失败"问题时, 一个 traceId
 * grep 即可拉出全链。
 *
 * Usage（最常用 3 个 entrypoint）:
 *   1. compose → messages.send
 *   2. file upload (presign / confirm / upload)
 *   3. drag-drop attach
 *
 * 每个 user-facing action mint 一个 traceId, 通过 `imFetch({ traceId })`
 * 传下去；同一 action 内多次 RPC 共享同 id。
 */

const TRACE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Header carried over HTTP / WS / SSE; mirrored at cloud + daemon layers. */
export const TRACE_HEADER = 'X-Prismer-Trace-Id';

/**
 * Generate a short, human-grep-able trace id.
 *
 * Format: `<prefix>_<6-char base36-ish suffix>` — collisions are not unique
 * across global time but are vanishingly rare within a single user session,
 * which is the only scope we use it for. The header is allowed to be
 * re-stamped by cloud if the client did not supply one.
 */
export function generateTraceId(prefix = 'trace'): string {
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += TRACE_ALPHABET[Math.floor(Math.random() * TRACE_ALPHABET.length)];
  }
  return `${prefix}_${rand}`;
}

/**
 * Validate a candidate trace id matches our wire shape. Used by the cloud
 * middleware (mirrored as a server-side regex) to refuse oversized /
 * structured headers (`/^[a-z0-9_]{6,40}$/i`); the same shape works for any
 * frontend-mint to ease grep.
 */
export function isValidTraceId(value: string): boolean {
  return /^[a-z0-9_]{6,40}$/i.test(value);
}
