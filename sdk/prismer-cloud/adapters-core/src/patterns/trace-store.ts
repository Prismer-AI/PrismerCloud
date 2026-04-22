/**
 * Pre-compaction Trace Store (Patterns P8 + P12, v1.9.0).
 *
 * PARA §4.8 P8 requires adapters to persist the complete PARA event trace —
 * including events that get dropped by the host agent's compaction — so that
 * Arena Replay and post-hoc debugging can reconstruct the full timeline.
 *
 * Layout:
 *   ~/.prismer/trace/<sessionId>.jsonl   (append-only, one JSON event per line)
 *
 * v1.9.0 MVP ships plaintext .jsonl. The spec mentions zstd compression
 * (.jsonl.zst) but that requires a compression dependency; v1.9.1 adds it
 * via an optional `fflate` peer dep. For now we document the path so tooling
 * can migrate without touching producer code.
 *
 * Invariants (P12 Compaction Boundary):
 *   - Every event the adapter emits is appended to the trace BEFORE any
 *     compact.pre processing runs. This means after compact.post the trace
 *     still contains the pre-compaction view.
 *   - Flushes are line-at-a-time with O_APPEND semantics — concurrent
 *     adapters for the same session (e.g. parent + subagent) don't corrupt.
 *   - On crash, the trace is readable up to the last complete line.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TraceStoreOptions {
  /** Override trace dir. Defaults to ~/.prismer/trace */
  traceDir?: string;
  /** Override homedir — test-only hook. */
  home?: string;
}

export class TraceStore {
  private readonly dir: string;

  constructor(opts: TraceStoreOptions = {}) {
    const home = opts.home ?? os.homedir();
    this.dir = opts.traceDir ?? path.join(home, '.prismer', 'trace');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path to the trace file for a given sessionId. */
  pathFor(sessionId: string): string {
    // Sanitize: allow only [A-Za-z0-9._-]; replace everything else with _.
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /**
   * Append a single event to the session's trace. Synchronous + O_APPEND
   * atomic per-line on POSIX (the event must serialize to < PIPE_BUF to
   * guarantee atomicity; we enforce < 4KB as a safe upper bound).
   *
   * Events that are too large to serialize inline are truncated with a
   * `__truncated: true` marker — the full content is lost but the trace
   * structure survives.
   */
  append(sessionId: string, event: unknown): void {
    let line: string;
    try {
      line = JSON.stringify(event);
    } catch {
      line = JSON.stringify({ __traceError: 'json-serialize-failed' });
    }
    if (line.length > 4096) {
      line = JSON.stringify({ __truncated: true, approxSize: line.length });
    }
    fs.appendFileSync(this.pathFor(sessionId), line + '\n', { encoding: 'utf-8' });
  }

  /** Read back the full trace for a session, one event per array entry.
   *  Used by Arena Replay and `prismer trace export`. */
  read(sessionId: string): unknown[] {
    const p = this.pathFor(sessionId);
    if (!fs.existsSync(p)) return [];
    const text = fs.readFileSync(p, 'utf-8');
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines (partial write on crash) rather than error out.
      }
    }
    return events;
  }

  /** Delete a session's trace. Used by `prismer trace clear <sid>`. */
  remove(sessionId: string): boolean {
    const p = this.pathFor(sessionId);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  /** List all session IDs with traces on disk. */
  list(): string[] {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length));
    } catch {
      return [];
    }
  }
}
