/**
 * Prismer Runtime — PARA Events Tailer
 *
 * Polls ~/.prismer/para/events.jsonl and uploads new lines to the cloud
 * ingest endpoint POST /api/im/para/events.
 *
 * Features:
 * - Atomic offset persistence (tmp + rename) — survives daemon crashes
 * - Rotation handling: if file shrinks below offset, reads events.jsonl.1
 *   from old offset, then resets to 0 on the current file
 * - Exponential back-off on 5xx / network errors (5s→10s→20s→60s max)
 * - 4xx responses advance offset (bad data is skipped to avoid infinite loop)
 * - Batch size cap (maxBatchSize, default 100)
 *
 * @see docs/version190/v190-docker-closure-design.md §T3 daemon side
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EventsTailerOptions {
  /** Path to the JSONL events file (default ~/.prismer/para/events.jsonl) */
  eventsFilePath?: string;
  /** Path to the offset sidecar file (default ~/.prismer/para/tailer-offset.json) */
  offsetFilePath?: string;
  /** Cloud API base URL (required, e.g. https://prismer.cloud) */
  cloudApiBase: string;
  /** Prismer API key (required, passed as Bearer token) */
  apiKey: string;
  /** Poll interval in ms (default 5000) */
  pollIntervalMs?: number;
  /** Maximum events per POST batch (default 100) */
  maxBatchSize?: number;
  /**
   * Injectable fetch implementation — defaults to global fetch.
   * Useful for testing without network.
   */
  fetchImpl?: typeof fetch;
}

interface Offset {
  position: number;
}

// ─── EventsTailer ──────────────────────────────────────────────────────────

export class EventsTailer {
  private readonly eventsFilePath: string;
  private readonly offsetFilePath: string;
  private readonly cloudApiBase: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly fetchImpl: typeof fetch;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private currentBackoffMs = 0;
  private readonly backoffSteps = [5000, 10000, 20000, 60000];

  constructor(opts: EventsTailerOptions) {
    const paraDir = path.join(os.homedir(), '.prismer', 'para');
    this.eventsFilePath = opts.eventsFilePath ?? path.join(paraDir, 'events.jsonl');
    this.offsetFilePath = opts.offsetFilePath ?? path.join(paraDir, 'tailer-offset.json');
    this.cloudApiBase = opts.cloudApiBase.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxBatchSize = opts.maxBatchSize ?? 100;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[EventsTailer] Starting — polling', this.eventsFilePath);
    this._scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[EventsTailer] Stopped');
  }

  /** Force a single poll tick immediately (useful for tests). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this._tick();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private _scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this._tick();
      const nextDelay = this.currentBackoffMs > 0 ? this.currentBackoffMs : this.pollIntervalMs;
      this._scheduleNext(nextDelay);
    }, delayMs);
  }

  private async _tick(): Promise<void> {
    try {
      let offset = this._loadOffset();

      // Rotation detection: if file is smaller than our offset, the file was rotated.
      // Read unread lines from events.jsonl.1 first, then reset to 0.
      const fileSize = this._fileSize(this.eventsFilePath);
      if (fileSize !== null && fileSize < offset) {
        console.log(`[EventsTailer] Rotation detected (size=${fileSize} < offset=${offset}), reading .1`);
        const rotated = this.eventsFilePath + '.1';
        const rotatedLines = this._readLinesFrom(rotated, offset);
        if (rotatedLines.lines.length > 0) {
          const rotatedOk = await this._uploadBatches(rotatedLines.lines);
          if (!rotatedOk) {
            // 5xx/network on rotated-batch upload — hold offset where it is so
            // we retry the .1 drain on the next tick. Do NOT reset to 0 here,
            // otherwise the .1 lines would be silently dropped.
            return;
          }
        }
        // Rotated drain succeeded (or was empty). Now safe to reset offset.
        offset = 0;
        this._persistOffset(0);
      }

      // Read new lines from current position
      const read = this._readLinesFrom(this.eventsFilePath, offset);
      if (read.lines.length === 0) return; // nothing new

      const success = await this._uploadBatches(read.lines);
      if (success) {
        this._persistOffset(read.newPosition);
        this.currentBackoffMs = 0; // reset back-off on success
      }
      // On failure (5xx/network): _uploadBatches returned false and already
      // set the backoff. Offset is NOT persisted, so we retry these same
      // bytes on the next tick. On 4xx: _postBatch returned true (skip-bad),
      // so success=true and offset advances normally.
    } catch (err) {
      console.error('[EventsTailer] Tick error:', (err as Error).message);
    }
  }

  /**
   * Upload lines in batches.
   * Returns true if all batches succeeded (2xx or 4xx).
   * Returns false if a 5xx or network error occurred (offset should not advance).
   */
  private async _uploadBatches(lines: string[]): Promise<boolean> {
    for (let i = 0; i < lines.length; i += this.maxBatchSize) {
      const batch = lines.slice(i, i + this.maxBatchSize);
      const events = this._parseLines(batch);

      const ok = await this._postBatch(events);
      if (!ok) {
        return false;
      }
    }
    return true;
  }

  /**
   * POST a batch to the cloud. Returns true on 2xx or 4xx (advance offset).
   * Returns false on 5xx or network error (hold offset, back off).
   */
  private async _postBatch(events: unknown[]): Promise<boolean> {
    const url = `${this.cloudApiBase}/api/im/para/events`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ events }),
      });

      if (res.status >= 200 && res.status < 300) {
        return true; // success
      }

      if (res.status >= 400 && res.status < 500) {
        // Client error — log and advance offset to avoid infinite loop
        const body = await res.text().catch(() => '');
        console.error(`[EventsTailer] 4xx from cloud (${res.status}), skipping batch: ${body.slice(0, 200)}`);
        return true; // treat as "advance offset"
      }

      // 5xx or unexpected — back off
      console.error(`[EventsTailer] Server error ${res.status}, backing off`);
      this._increaseBackoff();
      return false;
    } catch (err) {
      console.error(`[EventsTailer] Network error: ${(err as Error).message}, backing off`);
      this._increaseBackoff();
      return false;
    }
  }

  // ─── File helpers ─────────────────────────────────────────────────────────

  private _fileSize(filePath: string): number | null {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return null;
    }
  }

  private _readLinesFrom(
    filePath: string,
    offset: number,
  ): { lines: string[]; newPosition: number } {
    try {
      const size = this._fileSize(filePath);
      if (size === null || size <= offset) return { lines: [], newPosition: offset };

      // Read only the new bytes
      const bytesToRead = size - offset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buf, 0, bytesToRead, offset);
      } finally {
        fs.closeSync(fd);
      }

      const chunk = buf.toString('utf-8');
      // Drop the last element of the split — it's either empty (chunk ended
      // with '\n') or a partial line (not yet terminated). Either way we
      // only commit bytes up to the last newline via lastNewlineIdx below.
      const parts = chunk.split('\n');
      const completeLines = parts.slice(0, -1);
      const lastNewlineIdx = chunk.lastIndexOf('\n');
      const bytesConsumed = lastNewlineIdx >= 0 ? lastNewlineIdx + 1 : 0;
      const newPosition = offset + bytesConsumed;

      const nonEmpty = completeLines.filter((l) => l.trim().length > 0);
      return { lines: nonEmpty, newPosition };
    } catch (err) {
      console.warn(`[EventsTailer] Cannot read ${filePath}: ${(err as Error).message}`);
      return { lines: [], newPosition: offset };
    }
  }

  private _parseLines(lines: string[]): unknown[] {
    const events: unknown[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        console.warn(`[EventsTailer] Skipping malformed JSON line: ${line.slice(0, 80)}`);
        // Skip malformed lines but do NOT stop processing
      }
    }
    return events;
  }

  // ─── Offset persistence ──────────────────────────────────────────────────

  private _loadOffset(): number {
    try {
      const raw = fs.readFileSync(this.offsetFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Offset;
      return typeof parsed.position === 'number' ? parsed.position : 0;
    } catch {
      return 0;
    }
  }

  private _persistOffset(position: number): void {
    try {
      const dir = path.dirname(this.offsetFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.offsetFilePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ position }), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.offsetFilePath);
    } catch (err) {
      console.error('[EventsTailer] Failed to persist offset:', (err as Error).message);
    }
  }

  // ─── Back-off ────────────────────────────────────────────────────────────

  private _increaseBackoff(): void {
    const idx = this.backoffSteps.indexOf(this.currentBackoffMs);
    if (idx < 0 || idx >= this.backoffSteps.length - 1) {
      this.currentBackoffMs = this.backoffSteps[this.backoffSteps.length - 1];
    } else {
      this.currentBackoffMs = this.backoffSteps[idx + 1];
    }
  }
}
