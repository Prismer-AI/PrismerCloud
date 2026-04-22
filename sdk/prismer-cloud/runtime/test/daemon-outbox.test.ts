/**
 * DaemonOutbox tests (v1.9.0 §5.6.5 — disconnect compensation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonOutbox, frameFromParts } from '../src/daemon-outbox.js';

describe('DaemonOutbox', () => {
  let tmpDir: string;
  let outbox: DaemonOutbox;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-outbox-'));
    outbox = new DaemonOutbox({ bindingId: 'binding-test', dataDir: tmpDir });
  });

  afterEach(() => {
    outbox.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('assigns monotonic seq on appendSent', () => {
    const s1 = outbox.appendSent(0x01, 0, Buffer.from('hello'));
    const s2 = outbox.appendSent(0x01, 0, Buffer.from('world'));
    expect(s2).toBe(s1 + 1);
    expect(outbox.getCurrentSeq()).toBe(s2);
  });

  it('getTimelineSince returns only rows above lastSeq', () => {
    outbox.appendSent(0x01, 0, Buffer.from('a'));
    outbox.appendSent(0x01, 0, Buffer.from('b'));
    outbox.appendSent(0x02, 1, Buffer.from('c'));

    const since1 = outbox.getTimelineSince(1);
    expect(since1.length).toBe(2);
    expect(since1[0].payload.toString()).toBe('b');
    expect(since1[1].payload.toString()).toBe('c');
    expect(since1[1].opcode).toBe(0x02);
    expect(since1[1].slot).toBe(1);
  });

  it('queue + drain + ack round-trip', () => {
    const seq = outbox.appendSent(0x01, 0, Buffer.from('x'));
    const frame = frameFromParts(0x01, 0, Buffer.from('x'));
    outbox.queue(seq, frame);
    expect(outbox.pendingCount()).toBe(1);

    const pending = outbox.drain();
    expect(pending.length).toBe(1);
    expect(pending[0].seq).toBe(seq);
    expect(pending[0].frame.equals(frame)).toBe(true);

    outbox.ack(pending[0].id);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('enforces timelineCap by trimming oldest', () => {
    const small = new DaemonOutbox({ bindingId: 'b2', dataDir: tmpDir, timelineCap: 3 });
    small.appendSent(0x01, 0, Buffer.from('1'));
    small.appendSent(0x01, 0, Buffer.from('2'));
    small.appendSent(0x01, 0, Buffer.from('3'));
    small.appendSent(0x01, 0, Buffer.from('4'));
    small.appendSent(0x01, 0, Buffer.from('5'));

    const all = small.getTimelineSince(0);
    expect(all.length).toBeLessThanOrEqual(3);
    // Newest 3 should survive — payloads are '3','4','5'
    const payloads = all.map((r) => r.payload.toString());
    expect(payloads).toEqual(['3', '4', '5']);
    small.close();
  });

  it('bumpAttempts increments retry counter', () => {
    const seq = outbox.appendSent(0x01, 0, Buffer.from('x'));
    const frame = frameFromParts(0x01, 0, Buffer.from('x'));
    outbox.queue(seq, frame);

    const [entry] = outbox.drain();
    outbox.bumpAttempts(entry.id);
    outbox.bumpAttempts(entry.id);

    const [after] = outbox.drain();
    expect(after.attempts).toBe(2);
  });

  it('reopening DB restores currentSeq', () => {
    outbox.appendSent(0x01, 0, Buffer.from('a'));
    outbox.appendSent(0x01, 0, Buffer.from('b'));
    const seqBefore = outbox.getCurrentSeq();
    outbox.close();

    const reopened = new DaemonOutbox({ bindingId: 'binding-test', dataDir: tmpDir });
    expect(reopened.getCurrentSeq()).toBe(seqBefore);
    reopened.close();
  });

  // --- cap-drop visibility ---

  it('drop-on-cap emits onDrop with correct ids/seqs/attempts and increments getDroppedCount', () => {
    const dropped: { id: number; seq: number; attempts: number }[] = [];
    const capBox = new DaemonOutbox({
      bindingId: 'cap-drop',
      dataDir: tmpDir,
      outboxCap: 3,
      onDrop: (entries) => dropped.push(...entries),
    });

    // Queue 5 frames — cap is 3, so 2 oldest should be dropped
    const frame = frameFromParts(0x01, 0, Buffer.from('f'));
    for (let i = 0; i < 5; i++) {
      const seq = capBox.appendSent(0x01, 0, Buffer.from(`f${i}`));
      capBox.queue(seq, frame);
    }

    expect(dropped.length).toBe(2);
    expect(dropped[0].seq).toBeLessThan(dropped[1].seq);
    expect(capBox.getDroppedCount()).toBe(2);
    expect(capBox.pendingCount()).toBe(3);
    capBox.close();
  });

  // --- bumpAttempts return value ---

  it('bumpAttempts returns attempts and deadLettered:false below threshold', () => {
    const seq = outbox.appendSent(0x01, 0, Buffer.from('y'));
    const frame = frameFromParts(0x01, 0, Buffer.from('y'));
    outbox.queue(seq, frame);
    const [entry] = outbox.drain();

    const result = outbox.bumpAttempts(entry.id);
    expect(result.attempts).toBe(1);
    expect(result.deadLettered).toBe(false);
  });

  // --- dead-letter at max attempts ---

  it('bumpAttempts returns deadLettered:true at threshold; entry moved to dead-letter table', () => {
    const dlBox = new DaemonOutbox({
      bindingId: 'dl-test',
      dataDir: tmpDir,
      maxAttempts: 3,
    });

    const seq = dlBox.appendSent(0x01, 0, Buffer.from('dl'));
    const frame = frameFromParts(0x01, 0, Buffer.from('dl'));
    dlBox.queue(seq, frame);
    const [entry] = dlBox.drain();

    dlBox.bumpAttempts(entry.id); // attempts=1
    dlBox.bumpAttempts(entry.id); // attempts=2
    const result = dlBox.bumpAttempts(entry.id); // attempts=3 >= maxAttempts=3 → dead-letter

    expect(result.attempts).toBe(3);
    expect(result.deadLettered).toBe(true);

    // Row must be gone from outbox
    expect(dlBox.pendingCount()).toBe(0);

    // Row must appear in dead-letter
    expect(dlBox.getDeadLetterCount()).toBe(1);

    const dlEntries = dlBox.getDeadLetterEntries();
    expect(dlEntries.length).toBe(1);
    expect(dlEntries[0].originalId).toBe(entry.id);
    expect(dlEntries[0].seq).toBe(seq);
    expect(dlEntries[0].attempts).toBe(3);
    expect(dlEntries[0].failedAt).toBeGreaterThan(0);
    // frame omitted by default
    expect((dlEntries[0] as { frame?: Buffer }).frame).toBeUndefined();

    dlBox.close();
  });

  it('drain skips dead-lettered entries after threshold', () => {
    const dlBox = new DaemonOutbox({
      bindingId: 'dl-drain',
      dataDir: tmpDir,
      maxAttempts: 3,
    });

    // Queue two frames
    const seq1 = dlBox.appendSent(0x01, 0, Buffer.from('a'));
    const seq2 = dlBox.appendSent(0x01, 0, Buffer.from('b'));
    const frame = frameFromParts(0x01, 0, Buffer.from('x'));
    dlBox.queue(seq1, frame);
    dlBox.queue(seq2, frame);

    const [e1] = dlBox.drain();
    // Dead-letter the first entry
    dlBox.bumpAttempts(e1.id);
    dlBox.bumpAttempts(e1.id);
    dlBox.bumpAttempts(e1.id); // → dead-letter

    // drain should only return the second entry
    const remaining = dlBox.drain();
    expect(remaining.length).toBe(1);
    expect(remaining[0].seq).toBe(seq2);

    dlBox.close();
  });
});
