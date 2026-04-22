/**
 * PARA L8 — Session Export Trace Writer
 *
 * Per PARA spec §4.2 L8 (docs/version190/03-para-spec.md):
 *   session export 必须是 pre-compaction 的原始 trace。compaction 会把历史消息替换为 summary——
 *   这种 adapter 必须额外持久化原始 trace 到 `.prismer/trace/<sessionId>.jsonl.zst`
 *   （append-only + zstd 压缩），compaction 只影响 working memory，不动 trace。
 *
 * Implementation:
 *   - Each `append()` JSON-stringifies the envelope, adds '\n', zstd-compresses it,
 *     then sync-appends the compressed bytes to the trace file.
 *   - zstd supports concatenated frames — multiple independent compressed blobs
 *     catenated together decompress back to the concatenation of their inputs.
 *     This is what makes append-only valid without holding a long-lived stream.
 *   - File mode 0o600 (trace may contain sensitive payloads).
 *   - Node 22+ gives us native `zlib.zstdCompressSync`. Older Node: append is a no-op
 *     and a single stderr warning is emitted at construction time. We do NOT throw
 *     or crash the daemon — daemon must still start on Node 20.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { EventBusEnvelope } from './event-bus.js';

// ──────────────────────────────────────────────────────────
// Runtime capability detection (Node 22+ required for zstd)
// ──────────────────────────────────────────────────────────

type ZstdCompressSync = (buf: Buffer | Uint8Array) => Buffer;

function detectZstdCompressSync(): ZstdCompressSync | undefined {
  const anyZlib = zlib as unknown as { zstdCompressSync?: ZstdCompressSync };
  if (typeof anyZlib.zstdCompressSync === 'function') {
    return anyZlib.zstdCompressSync.bind(zlib);
  }
  return undefined;
}

// Session ID path-safety: allow [a-zA-Z0-9_.-]+ but require an alnum/underscore
// at the start (blocks '..', '.hidden', '-flag', '.', '-', etc. from becoming
// path traversal or hidden files). Max 128 chars as a sanity bound.
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

/**
 * Validate a session id against the TraceWriter's path-safety rules.
 *
 * Rules: must match `SESSION_ID_PATTERN` (first char alnum/underscore, then
 * alnum/underscore/dot/dash, 1–128 chars) AND must not contain `..`.
 *
 * Exported so CLI surfaces (e.g. `prismer session export <id>`) can reject
 * hostile input with the exact same policy the core writer uses — no
 * asymmetry between core and CLI.
 *
 * @internal — not part of the stable public API; do not re-export from
 * `src/index.ts`. Callers inside this package may import directly.
 */
export function isValidSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string') return false;
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  // Explicitly reject '..' anywhere in the id even though the anchor above
  // already blocks it at position 0.
  if (sessionId.includes('..')) return false;
  return true;
}

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface TraceWriterOptions {
  sessionId: string;
  /**
   * Override home directory; trace file will live at
   * `<homeDir>/.prismer/trace/<sessionId>.jsonl.zst`. Defaults to `os.homedir()`.
   */
  homeDir?: string;
  /**
   * Explicit trace directory. Overrides homeDir if provided. Useful when the
   * daemon runs with a non-default `dataDir`.
   */
  traceDir?: string;
}

// ──────────────────────────────────────────────────────────
// TraceWriter
// ──────────────────────────────────────────────────────────

export class TraceWriter {
  private readonly _sessionId: string;
  private readonly _filePath: string;
  private readonly _compress: ZstdCompressSync | undefined;
  private _bytesWritten = 0;
  private _warnedAppendError = false;
  private _closed = false;

  constructor(opts: TraceWriterOptions) {
    if (!isValidSessionId(opts.sessionId)) {
      throw new Error(
        `[TraceWriter] Invalid sessionId "${opts.sessionId}": must match ${SESSION_ID_PATTERN} and cannot contain '..'`,
      );
    }

    this._sessionId = opts.sessionId;

    const traceDir = opts.traceDir ?? path.join(opts.homeDir ?? os.homedir(), '.prismer', 'trace');
    this._filePath = path.join(traceDir, `${opts.sessionId}.jsonl.zst`);

    this._compress = detectZstdCompressSync();

    if (!this._compress) {
      // Emit one-shot warning. Daemon must not crash on Node 20.
      try {
        process.stderr.write(
          '[TraceWriter] Session trace disabled: requires Node 22+ (zstdCompressSync unavailable)\n',
        );
      } catch {
        // ignore — stderr unreachable
      }
      return;
    }

    // Ensure parent directory exists. Permissions kept to user default for dir
    // (so users can `ls` / copy); files themselves are 0o600.
    const parentDir = path.dirname(this._filePath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      // mkdir failure is non-fatal; first append() will surface the problem once.
      try {
        process.stderr.write(
          `[TraceWriter] Failed to create trace dir ${parentDir}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      } catch { /* ignore */ }
    }
  }

  /** Absolute path of the trace file: `<home>/.prismer/trace/<sessionId>.jsonl.zst`. */
  get filePath(): string {
    return this._filePath;
  }

  /** Session ID this writer is bound to. */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Total compressed bytes appended since construction. */
  get bytesWritten(): number {
    return this._bytesWritten;
  }

  /** True if zstd is unavailable (Node < 22); append() is a no-op. */
  get disabled(): boolean {
    return this._compress === undefined;
  }

  /**
   * Synchronously append one event envelope to the trace as a new zstd frame.
   * Safe to call after close() — becomes a no-op. Errors are logged once and swallowed.
   */
  append(event: EventBusEnvelope): void {
    if (this._closed) return;
    if (!this._compress) return;

    let compressed: Buffer;
    try {
      const line = JSON.stringify(event) + '\n';
      compressed = this._compress(Buffer.from(line, 'utf8'));
    } catch (err) {
      if (!this._warnedAppendError) {
        this._warnedAppendError = true;
        try {
          process.stderr.write(
            `[TraceWriter] Failed to serialize/compress event for session ${this._sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        } catch { /* ignore */ }
      }
      return;
    }

    try {
      fs.appendFileSync(this._filePath, compressed, { mode: 0o600 });
      this._bytesWritten += compressed.byteLength;
    } catch (err) {
      if (!this._warnedAppendError) {
        this._warnedAppendError = true;
        try {
          process.stderr.write(
            `[TraceWriter] Failed to append trace for session ${this._sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Close the writer. Currently a no-op because we use sync append with one
   * self-contained zstd frame per event. The API exists so callers can switch to
   * a streaming implementation later without changing integration code.
   */
  close(): void {
    this._closed = true;
  }
}

// ──────────────────────────────────────────────────────────
// TraceWriterManager — one writer per active session
// ──────────────────────────────────────────────────────────

export interface TraceWriterManagerOptions {
  /** Override home directory (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Explicit trace directory — takes precedence over homeDir when set. */
  traceDir?: string;
}

/**
 * Routes events from the EventBus (`bus.subscribe('*', ...)`) to the per-session
 * TraceWriter.
 *
 *   agent.session.started → open writer for payload.sessionId
 *   agent.session.ended   → close + remove writer
 *   any other event       → pick the writer by payload.sessionId if present;
 *                           events without sessionId are skipped (not guessed)
 */
export class TraceWriterManager {
  private readonly _writers = new Map<string, TraceWriter>();
  private readonly _homeDir: string | undefined;
  private readonly _traceDir: string | undefined;
  // Dedup per-sessionId — a misbehaving adapter spamming the same bad
  // sessionId must not flood stderr. Each distinct sessionId warns at most once.
  private readonly _warnedOpenFailures = new Set<string>();

  constructor(opts?: TraceWriterManagerOptions) {
    this._homeDir = opts?.homeDir;
    this._traceDir = opts?.traceDir;
  }

  /** Event-bus subscription handler. Pass via `bus.subscribe('*', mgr.handle)`. */
  readonly handle = (ev: EventBusEnvelope): void => {
    const sessionId = extractSessionId(ev);

    if (ev.topic === 'agent.session.started') {
      if (sessionId) {
        this._openWriter(sessionId);
        const writer = this._writers.get(sessionId);
        if (writer) writer.append(ev);
      }
      return;
    }

    if (ev.topic === 'agent.session.ended') {
      if (sessionId) {
        const writer = this._writers.get(sessionId);
        if (writer) writer.append(ev);
        this._closeWriter(sessionId);
      }
      return;
    }

    if (!sessionId) {
      // No session association — skip (do not guess).
      return;
    }

    const writer = this._writers.get(sessionId);
    if (writer) {
      writer.append(ev);
    }
  };

  /** Close all writers — call on daemon shutdown. */
  shutdown(): void {
    for (const writer of this._writers.values()) {
      writer.close();
    }
    this._writers.clear();
  }

  /** Test / introspection helper. */
  activeSessions(): string[] {
    return [...this._writers.keys()];
  }

  private _openWriter(sessionId: string): void {
    if (this._writers.has(sessionId)) return;
    try {
      const writer = new TraceWriter({
        sessionId,
        ...(this._homeDir !== undefined ? { homeDir: this._homeDir } : {}),
        ...(this._traceDir !== undefined ? { traceDir: this._traceDir } : {}),
      });
      this._writers.set(sessionId, writer);
    } catch (err) {
      // Invalid session id or similar — skip but log once *per sessionId*.
      // A misbehaving adapter that repeatedly sends the same bad id must not
      // flood stderr; only the first occurrence warns.
      if (!this._warnedOpenFailures.has(sessionId)) {
        this._warnedOpenFailures.add(sessionId);
        try {
          process.stderr.write(
            `[TraceWriterManager] Failed to open writer for session ${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        } catch { /* ignore */ }
      }
    }
  }

  private _closeWriter(sessionId: string): void {
    const writer = this._writers.get(sessionId);
    if (writer) {
      writer.close();
      this._writers.delete(sessionId);
    }
  }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function extractSessionId(ev: EventBusEnvelope): string | undefined {
  const payload = ev.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const candidate = p['sessionId'] ?? p['session'];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return undefined;
}
