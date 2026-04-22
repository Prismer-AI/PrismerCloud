import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================
// Public types
// ============================================================

export interface AuditEntry {
  ts: string;
  agentId: string;
  operation: 'read' | 'write' | 'delete' | 'edit' | 'list' | 'search' | 'permission';
  path?: string;
  toolName?: string;
  decision: 'allow' | 'deny' | 'ask' | 'executed' | 'failed';
  reason?: string;
  bytes?: number;
  durationMs?: number;
  callPath: 'native' | 'http' | 'relay';
  requestId?: string;
  error?: string;
  truncated?: true;
}

export interface AuditWriter {
  append(entry: AuditEntry): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly failedWriteCount: number;
  readonly lastFailureAt: string | undefined;
}

// ============================================================
// Truncation guard — keeps any single line under 64KB
// Fields `error` and `reason` are the likely large fields.
// ============================================================

const MAX_FIELD_BYTES = 8 * 1024; // 8KB

function truncateEntry(entry: AuditEntry): AuditEntry {
  let needsTruncation = false;
  const out: AuditEntry = { ...entry };

  if (out.error !== undefined && Buffer.byteLength(out.error, 'utf8') > MAX_FIELD_BYTES) {
    out.error = Buffer.from(out.error, 'utf8').slice(0, MAX_FIELD_BYTES).toString('utf8');
    needsTruncation = true;
  }
  if (out.reason !== undefined && Buffer.byteLength(out.reason, 'utf8') > MAX_FIELD_BYTES) {
    out.reason = Buffer.from(out.reason, 'utf8').slice(0, MAX_FIELD_BYTES).toString('utf8');
    needsTruncation = true;
  }
  if (needsTruncation) {
    out.truncated = true;
  }
  return out;
}

// ============================================================
// Default writer (appendFileSync-based JSONL)
// ============================================================

function makeDefaultWriter(
  filePath: string,
  onWriteFailure?: (err: unknown, entry: AuditEntry) => void,
): AuditWriter {
  let dirEnsured = false;
  let _failedWriteCount = 0;
  let _lastFailureAt: string | undefined;

  return {
    get failedWriteCount(): number { return _failedWriteCount; },
    get lastFailureAt(): string | undefined { return _lastFailureAt; },

    append(entry: AuditEntry): void {
      try {
        if (!dirEnsured) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          dirEnsured = true;
        }
        const safe = truncateEntry(entry);
        fs.appendFileSync(filePath, JSON.stringify(safe) + '\n', 'utf8');
      } catch (err) {
        // Audit is best-effort — never crash the caller on I/O failures.
        _failedWriteCount++;
        _lastFailureAt = new Date().toISOString();
        if (onWriteFailure !== undefined) {
          onWriteFailure(err, entry);
        } else {
          process.stderr.write(`[audit] failed to write audit log: ${String(err)}\n`);
        }
      }
    },

    // appendFileSync relies on kernel buffering; no extra flush needed.
    async flush(): Promise<void> {
      // no-op — kernel buffers the appends synchronously
    },

    async close(): Promise<void> {
      // no-op — no persistent fd to close with appendFileSync approach
    },
  };
}

// ============================================================
// Singleton management
// ============================================================

let _instance: AuditWriter | undefined;

function defaultPath(): string {
  return path.join(os.homedir(), '.prismer', 'audit.jsonl');
}

/**
 * Lazy singleton used by the fs adapter.
 * The first call initialises the default writer writing to ~/.prismer/audit.jsonl.
 */
export function getAuditWriter(): AuditWriter {
  if (_instance === undefined) {
    _instance = makeDefaultWriter(defaultPath());
  }
  return _instance;
}

/**
 * Replace the singleton. Used by tests to inject an in-memory writer.
 */
export function setAuditWriter(writer: AuditWriter): void {
  _instance = writer;
}

/**
 * Reset the singleton back to undefined so the next getAuditWriter() call
 * creates a fresh default instance.  Used exclusively in test teardown.
 */
export function __resetAuditWriterForTests(): void {
  _instance = undefined;
}

export interface CreateAuditWriterOptions {
  path?: string;
  onWriteFailure?: (err: unknown, entry: AuditEntry) => void;
}

/**
 * Create a standalone AuditWriter that writes JSONL to the given path.
 * Each call returns a new independent writer — not the singleton.
 */
export function createAuditWriter(options?: CreateAuditWriterOptions): AuditWriter {
  return makeDefaultWriter(options?.path ?? defaultPath(), options?.onWriteFailure);
}
