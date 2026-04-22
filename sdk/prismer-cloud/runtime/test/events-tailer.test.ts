/**
 * EventsTailer — Unit Tests (Vitest)
 *
 * Tests:
 *   - flush() uploads 3 events, updates offset
 *   - second flush() uploads only new events
 *   - file rotation: .1 gets drained, offset resets to 0
 *   - 4xx: offset advances (bad data skipped)
 *   - 5xx: offset NOT advanced (retry later)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventsTailer } from '../src/daemon/events-tailer.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-tailer-'));
}

function writeLines(filePath: string, lines: object[], append = false) {
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (append) {
    fs.appendFileSync(filePath, content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function readOffset(offsetFilePath: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(offsetFilePath, 'utf-8'));
    return raw.position ?? 0;
  } catch {
    return 0;
  }
}

function makeFetch(responses: Array<{ status: number; body?: string }>) {
  let callCount = 0;
  const calls: Array<{ url: string; body: unknown }> = [];

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const resp = responses[callCount] ?? { status: 200 };
    callCount++;
    const parsed = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url, body: parsed });
    return new Response(resp.body ?? '{"ok":true}', {
      status: resp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('EventsTailer', () => {
  let tmpDir: string;
  let eventsFile: string;
  let offsetFile: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    eventsFile = path.join(tmpDir, 'events.jsonl');
    offsetFile = path.join(tmpDir, 'tailer-offset.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flush() uploads 3 events and advances offset', async () => {
    const events = [
      { type: 'agent.session.started', sessionId: 's1', _ts: 1000 },
      { type: 'agent.tool.post', sessionId: 's1', _ts: 1001 },
      { type: 'agent.turn.end', sessionId: 's1', _ts: 1002 },
    ];
    writeLines(eventsFile, events);

    const { impl, calls } = makeFetch([{ status: 200 }]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-1',
      fetchImpl: impl,
    });

    await tailer.flush();

    // fetch called once with all 3 events
    expect(calls).toHaveLength(1);
    const uploaded = (calls[0].body as any).events as unknown[];
    expect(uploaded).toHaveLength(3);

    // offset advanced to end of file
    const fileSize = fs.statSync(eventsFile).size;
    expect(readOffset(offsetFile)).toBe(fileSize);
  });

  it('second flush() uploads only new events', async () => {
    const batch1 = [
      { type: 'agent.session.started', sessionId: 's2', _ts: 2000 },
      { type: 'agent.tool.pre', sessionId: 's2', _ts: 2001 },
    ];
    writeLines(eventsFile, batch1);

    const { impl, calls } = makeFetch([{ status: 200 }, { status: 200 }]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-2',
      fetchImpl: impl,
    });

    // First flush — uploads 2
    await tailer.flush();
    expect(calls).toHaveLength(1);
    expect((calls[0].body as any).events).toHaveLength(2);

    // Append 2 more events
    const batch2 = [
      { type: 'agent.turn.step', sessionId: 's2', _ts: 2002 },
      { type: 'agent.turn.end', sessionId: 's2', _ts: 2003 },
    ];
    writeLines(eventsFile, batch2, true /* append */);

    // Second flush — should upload only the 2 new events
    await tailer.flush();
    expect(calls).toHaveLength(2);
    expect((calls[1].body as any).events).toHaveLength(2);

    // Offset at end of file
    const fileSize = fs.statSync(eventsFile).size;
    expect(readOffset(offsetFile)).toBe(fileSize);
  });

  it('handles rotation: reads .1 from old offset, then resets to 0', async () => {
    // Simulate: original file had 2 lines read up to offset N
    // Then rotation: events.jsonl → events.jsonl.1 (new smaller file starts)
    // events.jsonl.1 gets the "old" content past offset N
    // events.jsonl gets new content from 0

    // Step 1: write 2 events to events.jsonl
    const originalEvents = [
      { type: 'agent.session.started', sessionId: 's3', _ts: 3000 },
      { type: 'agent.tool.pre', sessionId: 's3', _ts: 3001 },
    ];
    writeLines(eventsFile, originalEvents);

    const { impl: impl1, calls: calls1 } = makeFetch([{ status: 200 }]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-3',
      fetchImpl: impl1,
    });

    // First flush — read both events, advance offset
    await tailer.flush();
    const offsetAfterRead = readOffset(offsetFile);
    expect(offsetAfterRead).toBeGreaterThan(0);

    // Step 2: simulate rotation
    // Move events.jsonl → events.jsonl.1
    fs.renameSync(eventsFile, eventsFile + '.1');
    // Start a new events.jsonl with 1 new event
    const newEvents = [{ type: 'agent.turn.end', sessionId: 's3', _ts: 3002 }];
    writeLines(eventsFile, newEvents);

    // Step 3: add 1 more line to .1 (simulating lines written after old offset)
    const rotatedExtra = [{ type: 'agent.compact.post', sessionId: 's3', _ts: 3003 }];
    writeLines(eventsFile + '.1', rotatedExtra, true /* append */);

    // Step 4: flush with the new mock
    const { impl: impl2, calls: calls2 } = makeFetch([{ status: 200 }, { status: 200 }]);
    const tailer2 = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-3',
      fetchImpl: impl2,
    });

    await tailer2.flush();

    // Must have called fetch exactly twice:
    //   1) the rotated extra line from .1
    //   2) the new line in events.jsonl
    expect(calls2.length).toBe(2);

    // First call carries the .1 rotated line
    const firstBody = calls2[0].body as { events: any[] };
    expect(firstBody.events).toHaveLength(1);
    expect(firstBody.events[0].type).toBe('agent.compact.post');

    // Second call carries the new line from the current events.jsonl
    const secondBody = calls2[1].body as { events: any[] };
    expect(secondBody.events).toHaveLength(1);
    expect(secondBody.events[0].type).toBe('agent.turn.end');

    // The offset file should be reset (new file is being tracked from start)
    const newFileSize = fs.statSync(eventsFile).size;
    expect(readOffset(offsetFile)).toBe(newFileSize);
  });

  it('5xx on rotated-batch upload: holds offset, does NOT silently drop .1 lines', async () => {
    // Write to events.jsonl, flush to advance offset
    writeLines(eventsFile, [{ type: 'agent.session.started', sessionId: 'sr', _ts: 4000 }]);
    const { impl: impl1 } = makeFetch([{ status: 200 }]);
    const t1 = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-rotfail',
      fetchImpl: impl1,
    });
    await t1.flush();
    const savedOffset = readOffset(offsetFile);
    expect(savedOffset).toBeGreaterThan(0);

    // Rotate
    fs.renameSync(eventsFile, eventsFile + '.1');
    writeLines(eventsFile, [{ type: 'agent.turn.end', sessionId: 'sr', _ts: 4001 }]);
    writeLines(eventsFile + '.1', [{ type: 'agent.compact.post', sessionId: 'sr', _ts: 4002 }], true);

    // Cloud 503 on the rotated-batch POST → must NOT reset offset to 0
    const { impl: impl2, calls: calls2 } = makeFetch([{ status: 503 }]);
    const t2 = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-rotfail',
      fetchImpl: impl2,
    });
    await t2.flush();

    // One fetch attempt (rotated-batch), received 503
    expect(calls2.length).toBe(1);
    // Offset must stay where it was — .1 data retry-able on next tick
    expect(readOffset(offsetFile)).toBe(savedOffset);
  });

  it('4xx response: offset advances (bad data skipped)', async () => {
    const events = [
      { type: 'agent.session.started', sessionId: 's4', _ts: 4000 },
    ];
    writeLines(eventsFile, events);

    const { impl } = makeFetch([{ status: 400, body: '{"ok":false,"error":"bad"}' }]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-4',
      fetchImpl: impl,
    });

    await tailer.flush();

    // Offset MUST advance even on 4xx — we never want to re-upload bad data
    const fileSize = fs.statSync(eventsFile).size;
    expect(readOffset(offsetFile)).toBe(fileSize);
  });

  it('5xx response: offset NOT advanced', async () => {
    const events = [
      { type: 'agent.session.started', sessionId: 's5', _ts: 5000 },
    ];
    writeLines(eventsFile, events);

    const { impl } = makeFetch([{ status: 500, body: '{"ok":false}' }]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-5',
      fetchImpl: impl,
    });

    await tailer.flush();

    // Offset must NOT advance on 5xx
    expect(readOffset(offsetFile)).toBe(0);
  });

  it('start/stop lifecycle does not throw', async () => {
    const { impl } = makeFetch([]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-6',
      pollIntervalMs: 60000, // long interval — won't auto-fire
      fetchImpl: impl,
    });

    tailer.start();
    tailer.stop();
    // No throw
  });

  it('skips malformed JSON lines without losing valid events', async () => {
    // Write a mix of valid JSON and garbage
    const content = [
      JSON.stringify({ type: 'agent.session.started', sessionId: 's7', _ts: 7000 }),
      'not-valid-json!!!',
      JSON.stringify({ type: 'agent.turn.end', sessionId: 's7', _ts: 7001 }),
    ].join('\n') + '\n';
    fs.writeFileSync(eventsFile, content, 'utf-8');

    const { impl, calls } = makeFetch([{ status: 200 }]);
    const tailer = new EventsTailer({
      eventsFilePath: eventsFile,
      offsetFilePath: offsetFile,
      cloudApiBase: 'http://localhost:3000',
      apiKey: 'sk-test-7',
      fetchImpl: impl,
    });

    await tailer.flush();

    // Should upload 2 valid events (malformed line skipped)
    expect(calls).toHaveLength(1);
    const uploaded = (calls[0].body as any).events as unknown[];
    expect(uploaded).toHaveLength(2);
  });
});
