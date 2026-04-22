/**
 * Prismer daemon-side outbox + timeline (v1.9.0)
 *
 * Closes docs/version190/07-remote-control.md §5.6.5. Every outgoing data-plane
 * frame the daemon sends to the cloud relay is appended to an append-only
 * SQLite timeline with a monotonic seq. When the WS disconnects we also
 * buffer undelivered frames in a separate outbox table — reconnect drains
 * the outbox (replay), and incoming backfill-request opcodes from the cloud
 * replay timeline events above lastSeq.
 *
 * Scope bound: timeline <= 10k rows (auto-trimmed), outbox <= 10k rows.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Types

export interface TimelineEntry {
  seq: number;
  opcode: number;
  slot: number;
  payload: Buffer;
  createdAt: number;
}

export interface OutboxEntry {
  id: number;
  seq: number;
  frame: Buffer;
  createdAt: number;
  attempts: number;
}

export interface DeadLetterEntry {
  id: number;
  originalId: number;
  seq: number;
  createdAt: number;
  failedAt: number;
  attempts: number;
}

export interface DroppedFrame {
  id: number;
  seq: number;
  attempts: number;
}

export interface DaemonOutboxOptions {
  bindingId: string;
  dataDir?: string;
  timelineCap?: number;
  outboxCap?: number;
  maxAttempts?: number;
  onDrop?: (entries: DroppedFrame[]) => void;
}

const DEFAULT_CAP = 10000;
const DEFAULT_MAX_ATTEMPTS = 50;

export class DaemonOutbox {
  private db: Database.Database;
  private bindingId: string;
  private timelineCap: number;
  private outboxCap: number;
  private maxAttempts: number;
  private onDrop?: (entries: DroppedFrame[]) => void;
  private currentSeq: number = 0;
  private droppedCount: number = 0;

  constructor(opts: DaemonOutboxOptions) {
    this.bindingId = opts.bindingId;
    this.timelineCap = opts.timelineCap ?? DEFAULT_CAP;
    this.outboxCap = opts.outboxCap ?? DEFAULT_CAP;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.onDrop = opts.onDrop;

    const baseDir = opts.dataDir ?? path.join(os.homedir(), '.prismer', 'daemon', opts.bindingId);
    fs.mkdirSync(baseDir, { recursive: true });

    const dbPath = path.join(baseDir, 'outbox.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();

    const row = this.db.prepare('SELECT seq FROM timeline ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number }
      | undefined;
    this.currentSeq = row?.seq ?? 0;
  }

  private initSchema(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS timeline (' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'opcode INTEGER NOT NULL,' +
        'slot INTEGER NOT NULL,' +
        'payload BLOB NOT NULL,' +
        'createdAt INTEGER NOT NULL' +
        '); ' +
        'CREATE INDEX IF NOT EXISTS idx_timeline_createdAt ON timeline(createdAt); ' +
        'CREATE TABLE IF NOT EXISTS outbox (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'seq INTEGER NOT NULL,' +
        'frame BLOB NOT NULL,' +
        'createdAt INTEGER NOT NULL,' +
        'attempts INTEGER NOT NULL DEFAULT 0' +
        '); ' +
        'CREATE INDEX IF NOT EXISTS idx_outbox_seq ON outbox(seq); ' +
        'CREATE TABLE IF NOT EXISTS outbox_dead_letter (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'originalId INTEGER NOT NULL,' +
        'seq INTEGER NOT NULL,' +
        'frame BLOB NOT NULL,' +
        'createdAt INTEGER NOT NULL,' +
        'failedAt INTEGER NOT NULL,' +
        'attempts INTEGER NOT NULL' +
        ');',
    );
  }

  appendSent(opcode: number, slot: number, payload: Buffer): number {
    const now = Date.now();
    const result = this.db
      .prepare('INSERT INTO timeline (opcode, slot, payload, createdAt) VALUES (?, ?, ?, ?)')
      .run(opcode, slot, payload, now);
    this.currentSeq = Number(result.lastInsertRowid);
    this.enforceTimelineCap();
    return this.currentSeq;
  }

  getTimelineSince(lastSeq: number, limit = 500): TimelineEntry[] {
    return this.db
      .prepare('SELECT seq, opcode, slot, payload, createdAt FROM timeline WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(lastSeq, limit) as TimelineEntry[];
  }

  getCurrentSeq(): number {
    return this.currentSeq;
  }

  private enforceTimelineCap(): void {
    const count = (this.db.prepare('SELECT COUNT(*) as n FROM timeline').get() as { n: number }).n;
    if (count > this.timelineCap) {
      const excess = count - this.timelineCap;
      this.db
        .prepare('DELETE FROM timeline WHERE seq IN (SELECT seq FROM timeline ORDER BY seq ASC LIMIT ?)')
        .run(excess);
    }
  }

  queue(seq: number, frame: Buffer): number {
    const now = Date.now();
    const result = this.db
      .prepare('INSERT INTO outbox (seq, frame, createdAt, attempts) VALUES (?, ?, ?, 0)')
      .run(seq, frame, now);
    this.enforceOutboxCap();
    return Number(result.lastInsertRowid);
  }

  drain(limit = 500): OutboxEntry[] {
    return this.db
      .prepare('SELECT id, seq, frame, createdAt, attempts FROM outbox ORDER BY id ASC LIMIT ?')
      .all(limit) as OutboxEntry[];
  }

  ack(outboxId: number): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(outboxId);
  }

  bumpAttempts(outboxId: number): { attempts: number; deadLettered: boolean } {
    const row = this.db
      .prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ? RETURNING attempts')
      .get(outboxId) as { attempts: number } | undefined;
    if (!row) return { attempts: 0, deadLettered: false };
    if (row.attempts >= this.maxAttempts) {
      this.moveToDeadLetter(outboxId);
      return { attempts: row.attempts, deadLettered: true };
    }
    return { attempts: row.attempts, deadLettered: false };
  }

  private moveToDeadLetter(outboxId: number): void {
    const now = Date.now();
    const move = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, seq, frame, createdAt, attempts FROM outbox WHERE id = ?')
        .get(outboxId) as OutboxEntry | undefined;
      if (!row) return;
      this.db
        .prepare(
          'INSERT INTO outbox_dead_letter (originalId, seq, frame, createdAt, failedAt, attempts) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(row.id, row.seq, row.frame, row.createdAt, now, row.attempts);
      this.db.prepare('DELETE FROM outbox WHERE id = ?').run(outboxId);
    });
    move();
  }

  getDeadLetterCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM outbox_dead_letter').get() as { n: number }).n;
  }

  getDeadLetterEntries(limit = 100, includeFrame = false): (DeadLetterEntry & { frame?: Buffer })[] {
    const cols = includeFrame
      ? 'id, originalId, seq, frame, createdAt, failedAt, attempts'
      : 'id, originalId, seq, createdAt, failedAt, attempts';
    return this.db
      .prepare(`SELECT ${cols} FROM outbox_dead_letter ORDER BY id ASC LIMIT ?`)
      .all(limit) as (DeadLetterEntry & { frame?: Buffer })[];
  }

  pendingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM outbox').get() as { n: number }).n;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  private enforceOutboxCap(): void {
    const count = this.pendingCount();
    if (count > this.outboxCap) {
      const excess = count - this.outboxCap;
      const toDelete = this.db
        .prepare('SELECT id, seq, attempts FROM outbox ORDER BY id ASC LIMIT ?')
        .all(excess) as DroppedFrame[];
      this.db
        .prepare('DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY id ASC LIMIT ?)')
        .run(excess);
      this.droppedCount += toDelete.length;
      if (this.onDrop && toDelete.length > 0) {
        this.onDrop(toDelete);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

/** 2-byte header + payload per §5.6.4 */
export function frameFromParts(opcode: number, slot: number, payload: Buffer): Buffer {
  const buf = Buffer.alloc(2 + payload.length);
  buf[0] = opcode;
  buf[1] = slot;
  payload.copy(buf, 2);
  return buf;
}
