/**
 * TraceWriter tests — PARA L8 Session Export (docs/version190/03-para-spec.md §4.2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { TraceWriter, TraceWriterManager, isValidSessionId } from '../src/trace-writer.js';
import type { EventBusEnvelope } from '../src/event-bus.js';

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-writer-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makeEvent<T>(topic: string, payload: T, source?: string): EventBusEnvelope<T> {
  const env: EventBusEnvelope<T> = { topic, ts: Date.now(), payload };
  if (source !== undefined) env.source = source;
  return env;
}

// zstd frame magic number, little-endian on disk: 28 B5 2F FD.
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function splitZstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const next = buf.indexOf(ZSTD_FRAME_MAGIC, i + 1);
    const end = next < 0 ? buf.length : next;
    frames.push(buf.subarray(i, end));
    i = end;
  }
  return frames;
}

function decompressAllFrames(filePath: string): string {
  // The on-disk format is concatenated zstd frames (interoperable with `zstd -d`).
  // Node's zstdDecompressSync only walks the first frame, so we scan for frame
  // boundaries via magic bytes and decompress each separately.
  const anyZlib = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
  if (typeof anyZlib.zstdDecompressSync !== 'function') {
    throw new Error('This test requires Node 22+ (zstdDecompressSync)');
  }
  const buf = fs.readFileSync(filePath);
  const frames = splitZstdFrames(buf);
  const parts = frames.map((f) => anyZlib.zstdDecompressSync!(f).toString('utf8'));
  return parts.join('');
}

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe('TraceWriter', () => {
  it('round-trip: append 3 events, zstd-decompress, recover originals', () => {
    const writer = new TraceWriter({ sessionId: 'sess1', homeDir: tmpRoot });

    const events: EventBusEnvelope[] = [
      makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'sess1' }),
      makeEvent('agent.message', { role: 'user', content: 'hi', ts: 1 }),
      makeEvent('agent.session.ended', { type: 'agent.session.ended', sessionId: 'sess1', reason: 'stop' }),
    ];
    for (const ev of events) writer.append(ev);
    writer.close();

    const decoded = decompressAllFrames(writer.filePath);
    const lines = decoded.trim().split('\n');
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual(events[0]);
    expect(parsed[1]).toEqual(events[1]);
    expect(parsed[2]).toEqual(events[2]);
  });

  it('concatenated frames: each append is independent yet decompresses together', () => {
    const writer = new TraceWriter({ sessionId: 'concat-abc', homeDir: tmpRoot });

    writer.append(makeEvent('t.a', { n: 1 }));
    writer.append(makeEvent('t.b', { n: 2 }));
    writer.append(makeEvent('t.c', { n: 3 }));

    const decoded = decompressAllFrames(writer.filePath);
    const lines = decoded.trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).payload.n)).toEqual([1, 2, 3]);
  });

  it('filePath points at ~/.prismer/trace/<sessionId>.jsonl.zst', () => {
    const writer = new TraceWriter({ sessionId: 'abc-123', homeDir: tmpRoot });
    expect(writer.filePath).toBe(
      path.join(tmpRoot, '.prismer', 'trace', 'abc-123.jsonl.zst'),
    );
  });

  it('creates trace directory when missing', () => {
    const writer = new TraceWriter({ sessionId: 'mkdir-test', homeDir: tmpRoot });
    writer.append(makeEvent('probe', {}));
    expect(fs.existsSync(path.join(tmpRoot, '.prismer', 'trace'))).toBe(true);
    expect(fs.existsSync(writer.filePath)).toBe(true);
  });

  it('traceDir option overrides homeDir', () => {
    const explicit = path.join(tmpRoot, 'custom-traces');
    const writer = new TraceWriter({
      sessionId: 'sX',
      homeDir: '/should/be/ignored',
      traceDir: explicit,
    });
    writer.append(makeEvent('x', {}));
    expect(writer.filePath).toBe(path.join(explicit, 'sX.jsonl.zst'));
    expect(fs.existsSync(writer.filePath)).toBe(true);
  });

  it('rejects sessionId containing path-injection characters', () => {
    const bad = ['../evil', 'a/b', 'a\\b', '..', 'x y', '', 'foo/'];
    for (const id of bad) {
      expect(() => new TraceWriter({ sessionId: id, homeDir: tmpRoot })).toThrow(/Invalid sessionId/);
    }
  });

  it('accepts safe session ids (alnum, dash, underscore, dot)', () => {
    const good = ['abc', 'Abc-123', 'foo_bar', 'v1.2.3-sess', 'S1.A2'];
    for (const id of good) {
      expect(() => new TraceWriter({ sessionId: id, homeDir: tmpRoot })).not.toThrow();
    }
  });

  it('bytesWritten is monotonically increasing', () => {
    const writer = new TraceWriter({ sessionId: 'bytes-1', homeDir: tmpRoot });
    expect(writer.bytesWritten).toBe(0);
    writer.append(makeEvent('a', { payload: 'x' }));
    const a = writer.bytesWritten;
    expect(a).toBeGreaterThan(0);
    writer.append(makeEvent('b', { payload: 'y'.repeat(100) }));
    const b = writer.bytesWritten;
    expect(b).toBeGreaterThan(a);
    writer.append(makeEvent('c', {}));
    expect(writer.bytesWritten).toBeGreaterThan(b);
  });

  it('close() renders subsequent appends into no-ops', () => {
    const writer = new TraceWriter({ sessionId: 'close-test', homeDir: tmpRoot });
    writer.append(makeEvent('a', { n: 1 }));
    const beforeClose = writer.bytesWritten;
    writer.close();
    writer.append(makeEvent('b', { n: 2 }));
    expect(writer.bytesWritten).toBe(beforeClose);
  });

  it('file mode is 0o600', () => {
    const writer = new TraceWriter({ sessionId: 'perm-test', homeDir: tmpRoot });
    writer.append(makeEvent('probe', {}));
    const stat = fs.statSync(writer.filePath);
    // File mode low bits — mask to 9 perm bits.
    // eslint-disable-next-line no-bitwise
    const perm = stat.mode & 0o777;
    expect(perm).toBe(0o600);
  });
});

describe('TraceWriterManager', () => {
  it('opens writer on agent.session.started, routes events, closes on ended', () => {
    const mgr = new TraceWriterManager({ traceDir: path.join(tmpRoot, 'trace') });

    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'S1' }));
    expect(mgr.activeSessions()).toEqual(['S1']);

    mgr.handle(makeEvent('agent.message', { sessionId: 'S1', role: 'user', content: 'hello', ts: 1 }));
    mgr.handle(makeEvent('agent.turn.end', { sessionId: 'S1' }));

    mgr.handle(makeEvent('agent.session.ended', { type: 'agent.session.ended', sessionId: 'S1', reason: 'stop' }));
    expect(mgr.activeSessions()).toEqual([]);

    const filePath = path.join(tmpRoot, 'trace', 'S1.jsonl.zst');
    expect(fs.existsSync(filePath)).toBe(true);

    const decoded = decompressAllFrames(filePath);
    const lines = decoded.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(lines[0].topic).toBe('agent.session.started');
    expect(lines[1].topic).toBe('agent.message');
    expect(lines[2].topic).toBe('agent.turn.end');
    expect(lines[3].topic).toBe('agent.session.ended');
  });

  it('skips events with no sessionId (no guessing)', () => {
    const mgr = new TraceWriterManager({ traceDir: path.join(tmpRoot, 'trace') });

    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'S2' }));
    // This event has no sessionId → must not go to any writer.
    mgr.handle(makeEvent('agent.register', { type: 'agent.register', agent: { id: 'a' } }));
    mgr.handle(makeEvent('agent.session.ended', { type: 'agent.session.ended', sessionId: 'S2', reason: 'stop' }));

    const filePath = path.join(tmpRoot, 'trace', 'S2.jsonl.zst');
    const lines = decompressAllFrames(filePath).trim().split('\n').map((l) => JSON.parse(l));
    // Should be only started + ended. agent.register must be dropped.
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.topic)).toEqual(['agent.session.started', 'agent.session.ended']);
  });

  it('multiplexes concurrent sessions to distinct files', () => {
    const mgr = new TraceWriterManager({ traceDir: path.join(tmpRoot, 'trace') });

    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'A' }));
    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'B' }));

    mgr.handle(makeEvent('agent.message', { sessionId: 'A', role: 'user', content: 'for-A', ts: 1 }));
    mgr.handle(makeEvent('agent.message', { sessionId: 'B', role: 'user', content: 'for-B', ts: 2 }));

    expect(mgr.activeSessions().sort()).toEqual(['A', 'B']);

    mgr.handle(makeEvent('agent.session.ended', { type: 'agent.session.ended', sessionId: 'A', reason: 'stop' }));
    mgr.handle(makeEvent('agent.session.ended', { type: 'agent.session.ended', sessionId: 'B', reason: 'stop' }));

    const aLines = decompressAllFrames(path.join(tmpRoot, 'trace', 'A.jsonl.zst'))
      .trim().split('\n').map((l) => JSON.parse(l));
    const bLines = decompressAllFrames(path.join(tmpRoot, 'trace', 'B.jsonl.zst'))
      .trim().split('\n').map((l) => JSON.parse(l));

    expect(aLines).toHaveLength(3); // started + message + ended
    expect(bLines).toHaveLength(3);
    expect(aLines[1].payload.content).toBe('for-A');
    expect(bLines[1].payload.content).toBe('for-B');
  });

  it('shutdown() closes all active writers', () => {
    const mgr = new TraceWriterManager({ traceDir: path.join(tmpRoot, 'trace') });
    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'X' }));
    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'Y' }));
    expect(mgr.activeSessions().length).toBe(2);
    mgr.shutdown();
    expect(mgr.activeSessions().length).toBe(0);
  });

  it('also accepts legacy payload shape {session: "..."} (backwards compat)', () => {
    const mgr = new TraceWriterManager({ traceDir: path.join(tmpRoot, 'trace') });
    mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', session: 'legacy1' }));
    mgr.handle(makeEvent('agent.state', { session: 'legacy1', status: 'thinking' }));
    mgr.handle(makeEvent('agent.session.ended', { type: 'agent.session.ended', session: 'legacy1' }));

    const filePath = path.join(tmpRoot, 'trace', 'legacy1.jsonl.zst');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = decompressAllFrames(filePath).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
  });
});

describe('isValidSessionId (shared policy for core + CLI)', () => {
  it('accepts safe ids — alnum, underscore, dash, dot, plus version-like strings', () => {
    const good = [
      'abc',
      'Abc-123',
      'foo_bar',
      'v1.2.3-sess',
      'S1.A2',
      '_starts_with_underscore',
      '0',
      'a'.repeat(128), // exact length boundary (1..=128)
    ];
    for (const id of good) {
      expect(isValidSessionId(id), `expected OK: ${JSON.stringify(id)}`).toBe(true);
    }
  });

  it('rejects path-traversal, separators, empty, and leading special chars', () => {
    const bad: unknown[] = [
      '',
      '..',
      '../evil',
      'a/b',
      'a\\b',
      'foo/',
      '/absolute',
      '\\absolute',
      '.hidden',
      '-flag',
      'has space',
      'has\ttab',
      'has\nnewline',
      'a..b', // '..' anywhere
      'a'.repeat(129), // over length bound
      // non-string inputs (defensive — CLI route still hits this)
      null,
      undefined,
      123,
      {},
    ];
    for (const id of bad) {
      expect(isValidSessionId(id as string), `expected REJECT: ${JSON.stringify(id)}`).toBe(false);
    }
  });
});

describe('TraceWriterManager warning dedup', () => {
  it('logs at most once per invalid sessionId even when spammed repeatedly', () => {
    const mgr = new TraceWriterManager({ traceDir: path.join(tmpRoot, 'trace') });
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Same invalid sessionId fired 5 times — manager must warn at most once for it.
    for (let i = 0; i < 5; i++) {
      mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: '../evil' }));
    }

    // A DIFFERENT invalid id should warn once too (dedup is per-id, not global).
    for (let i = 0; i < 3; i++) {
      mgr.handle(makeEvent('agent.session.started', { type: 'agent.session.started', sessionId: 'a/b' }));
    }

    const openFailureWarnings = stderrWrite.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('[TraceWriterManager] Failed to open writer'));

    // Exactly 2 — one per distinct invalid id.
    expect(openFailureWarnings.length).toBe(2);
    expect(openFailureWarnings.some((s) => s.includes('../evil'))).toBe(true);
    expect(openFailureWarnings.some((s) => s.includes('a/b'))).toBe(true);

    stderrWrite.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────
// Node <22 graceful degradation
// ──────────────────────────────────────────────────────────
//
// Per PARA spec §8 point 6 (docs/version190/03-para-spec.md): TraceWriter must
// degrade gracefully when `zlib.zstdCompressSync` is unavailable (Node < 22) —
// daemon must still start, single stderr warning is emitted, and append() is
// a no-op (no file created, no throw).
//
// We simulate the Node 20 environment by re-mocking `node:zlib` to omit
// `zstdCompressSync`. The TraceWriter module's detect helper runs at
// constructor time, so a fresh dynamic import with the mock in place reproduces
// the Node < 22 capability-detection path.

describe('TraceWriter Node <22 graceful degradation', () => {
  afterEach(() => {
    vi.doUnmock('node:zlib');
    vi.resetModules();
  });

  it('disables writer + swallows append when zstdCompressSync unavailable', async () => {
    vi.resetModules();
    vi.doMock('node:zlib', async () => {
      const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
      // Force `zstdCompressSync` to undefined so detectZstdCompressSync() reports
      // it unavailable (simulating Node < 22). Must be an explicit property (not
      // deleted) — vitest's module-mock proxy rejects reads of missing keys.
      return { ...actual, zstdCompressSync: undefined };
    });

    // Dynamic import so the mock takes effect for this module graph only.
    const mod = await import('../src/trace-writer.js');
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const writer = new mod.TraceWriter({ sessionId: 'node20-sess', homeDir: tmpRoot });

    expect(writer.disabled).toBe(true);

    // Single stderr warning at construction time.
    const warningCalls = stderrWrite.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('requires Node 22+'));
    expect(warningCalls.length).toBe(1);

    // append() must not throw, must not create file, must not bump bytesWritten.
    expect(() =>
      writer.append(makeEvent('probe', { x: 1 })),
    ).not.toThrow();
    expect(writer.bytesWritten).toBe(0);
    expect(fs.existsSync(writer.filePath)).toBe(false);

    // Second append still safe.
    expect(() => writer.append(makeEvent('probe2', {}))).not.toThrow();
    expect(writer.bytesWritten).toBe(0);

    // close() must also not throw.
    expect(() => writer.close()).not.toThrow();

    stderrWrite.mockRestore();
  });
});
