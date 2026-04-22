import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditWriter,
  getAuditWriter,
  setAuditWriter,
  __resetAuditWriterForTests,
} from '../src/audit.js';
import type { AuditEntry, AuditWriter, CreateAuditWriterOptions } from '../src/audit.js';

function tmpFile(): string {
  return path.join(os.tmpdir(), `prismer-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function baseEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    ts: new Date().toISOString(),
    agentId: 'test-agent',
    operation: 'read',
    decision: 'executed',
    callPath: 'native',
    ...overrides,
  };
}

describe('audit writer', () => {
  afterEach(() => {
    __resetAuditWriterForTests();
  });

  it('appends a single JSONL line parseable as JSON with expected fields', () => {
    const file = tmpFile();
    const writer = createAuditWriter({ path: file });
    const entry = baseEntry({ path: '/workspace/file.ts', bytes: 42 });

    writer.append(entry);

    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.agentId).toBe('test-agent');
    expect(parsed.operation).toBe('read');
    expect(parsed.decision).toBe('executed');
    expect(parsed.bytes).toBe(42);
    expect(parsed.path).toBe('/workspace/file.ts');
  });

  it('multiple appends produce N lines in order', () => {
    const file = tmpFile();
    const writer = createAuditWriter({ path: file });

    for (let i = 0; i < 5; i++) {
      writer.append(baseEntry({ bytes: i }));
    }

    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    lines.forEach((line, idx) => {
      const parsed = JSON.parse(line) as AuditEntry;
      expect(parsed.bytes).toBe(idx);
    });
  });

  it('truncates reason field > 8KB and sets truncated: true', () => {
    const file = tmpFile();
    const writer = createAuditWriter({ path: file });
    const longReason = 'x'.repeat(10 * 1024); // 10KB

    writer.append(baseEntry({ reason: longReason }));

    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw.trim()) as AuditEntry & { truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(parsed.reason ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('truncates error field > 8KB and sets truncated: true', () => {
    const file = tmpFile();
    const writer = createAuditWriter({ path: file });
    const longError = 'e'.repeat(10 * 1024);

    writer.append(baseEntry({ error: longError }));

    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw.trim()) as AuditEntry & { truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(parsed.error ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('append does not throw when target directory is not writable', () => {
    // Point to a path that definitely cannot be written (root-owned, no permissions)
    const badPath = '/dev/null/this-is-a-file-under-a-non-directory/audit.jsonl';
    const writer = createAuditWriter({ path: badPath });

    // Must not throw — audit is best-effort
    expect(() => writer.append(baseEntry())).not.toThrow();
  });

  it('getAuditWriter / setAuditWriter singleton swap works', () => {
    const received: AuditEntry[] = [];
    const mockWriter: AuditWriter = {
      append: (e) => { received.push(e); },
      flush: async () => {},
      close: async () => {},
      failedWriteCount: 0,
      lastFailureAt: undefined,
    };

    setAuditWriter(mockWriter);
    const got = getAuditWriter();
    expect(got).toBe(mockWriter);

    got.append(baseEntry({ bytes: 99 }));
    expect(received).toHaveLength(1);
    expect(received[0].bytes).toBe(99);
  });

  it('flush and close resolve without error', async () => {
    const file = tmpFile();
    const writer = createAuditWriter({ path: file });
    await expect(writer.flush()).resolves.toBeUndefined();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});

// ============================================================
// I4 — AuditWriter observability: failedWriteCount, lastFailureAt, onWriteFailure
// ============================================================

describe('I4: AuditWriter failure observability', () => {
  afterEach(() => {
    __resetAuditWriterForTests();
  });

  it('I4-a: onWriteFailure callback fires on write failure; failedWriteCount = 1; lastFailureAt set', () => {
    const badPath = '/nonexistent/dir/that/cannot/exist/audit.jsonl';
    const failures: Array<{ err: unknown; entry: AuditEntry }> = [];

    const opts: CreateAuditWriterOptions = {
      path: badPath,
      onWriteFailure: (err, entry) => { failures.push({ err, entry }); },
    };
    const writer = createAuditWriter(opts);
    const entry = baseEntry({ bytes: 7 });

    // Must not throw
    expect(() => writer.append(entry)).not.toThrow();

    expect(failures).toHaveLength(1);
    expect(failures[0].entry.bytes).toBe(7);
    expect(writer.failedWriteCount).toBe(1);
    expect(writer.lastFailureAt).toBeDefined();
    // lastFailureAt is ISO timestamp
    expect(() => new Date(writer.lastFailureAt!)).not.toThrow();
    expect(new Date(writer.lastFailureAt!).toISOString()).toBe(writer.lastFailureAt);
  });

  it('I4-b: without callback, append does not throw; failedWriteCount increments; stderr gets message', () => {
    const badPath = '/nonexistent/dir/that/cannot/exist/audit.jsonl';
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    const writer = createAuditWriter({ path: badPath });

    expect(() => writer.append(baseEntry())).not.toThrow();

    expect(writer.failedWriteCount).toBe(1);
    expect(writer.lastFailureAt).toBeDefined();
    expect(stderrChunks.join('')).toContain('[audit]');

    stderrSpy.mockRestore();
  });

  it('I4-c: failedWriteCount accumulates across multiple failures', () => {
    const badPath = '/nonexistent/dir/that/cannot/exist/audit.jsonl';
    const writer = createAuditWriter({ path: badPath, onWriteFailure: () => {} });

    writer.append(baseEntry());
    writer.append(baseEntry());
    writer.append(baseEntry());

    expect(writer.failedWriteCount).toBe(3);
  });

  it('I4-d: getAuditWriter() exposes failedWriteCount on the singleton', () => {
    // The singleton with a bad path
    const badPath = '/nonexistent/dir/that/cannot/exist/audit.jsonl';
    const writer = createAuditWriter({ path: badPath, onWriteFailure: () => {} });
    setAuditWriter(writer);

    const singleton = getAuditWriter();
    singleton.append(baseEntry());

    expect(singleton.failedWriteCount).toBe(1);
  });
});
