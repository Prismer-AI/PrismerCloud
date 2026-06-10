// Origin Outbox tests — SQLite-backed pending-upload queue.
//
// Mirrors the memory-outbox shape (validation → dead-letter, idempotencyKey
// UNIQUE, separate dead-letter table) but stores file-upload observations
// rather than memory mutation events.
//
// Acceptance: doc 26 §5 L2-T2 — daemon restart resumes pending uploads.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginOutbox } from '../src/daemon/asset/origin/outbox.js';
import type { OriginObservationRecord } from '../src/daemon/asset/origin/outbox.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-origin-outbox-'));
}

function buildOutbox(dir: string): OriginOutbox {
  return new OriginOutbox({ dbPath: join(dir, 'asset-origin.db') });
}

function dropFolderObservation(overrides: Partial<OriginObservationRecord> = {}): OriginObservationRecord {
  return {
    workspaceId: 'ws_test',
    originKind: 'drop-folder',
    sourceRef: 'folder://drop/sample.csv',
    payloadJson: JSON.stringify({ path: '/Users/x/.prismer/workspaces/ws_test/drop/sample.csv', mtime: 100 }),
    hintsJson: JSON.stringify({ filename: 'sample.csv', folderPath: 'drop' }),
    observedAt: 100,
    ...overrides,
  };
}

describe('OriginOutbox', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  it('persists a pending observation and reports queue depth', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    const result = outbox.enqueue(dropFolderObservation());
    expect(result.deadLetter).toBe(false);
    expect(result.id.startsWith('out_')).toBe(true);
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.deadLetterCount()).toBe(0);
  });

  it('is idempotent on re-enqueue with the same source/observedAt', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    const a = outbox.enqueue(dropFolderObservation());
    const b = outbox.enqueue(dropFolderObservation());
    expect(b.id).toBe(a.id);
    expect(outbox.pendingCount()).toBe(1);
  });

  it('treats a different observedAt as a separate row (file modified)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    outbox.enqueue(dropFolderObservation({ observedAt: 100 }));
    outbox.enqueue(dropFolderObservation({ observedAt: 200 }));
    expect(outbox.pendingCount()).toBe(2);
  });

  it('writes invalid input straight to dead-letter (validation failure)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    // Missing workspaceId — mandatory field per the envelope schema.
    const result = outbox.enqueue({
      ...dropFolderObservation(),
      workspaceId: '',
    });
    expect(result.deadLetter).toBe(true);
    expect(result.id.startsWith('dl_')).toBe(true);
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.deadLetterCount()).toBe(1);
  });

  it('dead-letter path tolerates non-string payload/hints fields without throwing', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    // payloadJson + hintsJson passed as raw objects (caller mistake) instead of
    // pre-stringified JSON. The schema rejects this; the dead-letter INSERT
    // must NOT throw a TYPE_MISMATCH — that would defeat its purpose.
    const result = outbox.enqueue({
      workspaceId: 'ws_a',
      originKind: 'drop-folder',
      sourceRef: 'folder://oops',
      payloadJson: { not: 'a string' } as unknown as string,
      hintsJson: { also: 'wrong' } as unknown as string,
      observedAt: 100,
    });
    expect(result.deadLetter).toBe(true);
    expect(outbox.deadLetterCount()).toBe(1);
  });

  it('claimNext returns and locks one pending row at a time', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    outbox.enqueue(dropFolderObservation({ sourceRef: 'folder://a', observedAt: 1 }));
    outbox.enqueue(dropFolderObservation({ sourceRef: 'folder://b', observedAt: 2 }));
    const first = outbox.claimNext();
    const second = outbox.claimNext();
    const third = outbox.claimNext();
    expect(first?.row.sourceRef).toBe('folder://a');
    expect(second?.row.sourceRef).toBe('folder://b');
    expect(third).toBeNull();
  });

  it('markUploaded retires a claimed row with its asset id', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    const enq = outbox.enqueue(dropFolderObservation());
    const claim = outbox.claimNext();
    expect(claim?.row.id).toBe(enq.id);
    outbox.markUploaded(enq.id, { assetId: 'as_123', contentHash: 'sha256-xyz' });
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.uploadedCount()).toBe(1);
  });

  it('moves a row to dead-letter after exceeding maxAttempts', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const outbox = buildOutbox(dir);
    const enq = outbox.enqueue(dropFolderObservation());
    outbox.recordFailure(enq.id, 'ECONNRESET', { maxAttempts: 3 });
    outbox.recordFailure(enq.id, 'ECONNRESET', { maxAttempts: 3 });
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.deadLetterCount()).toBe(0);
    outbox.recordFailure(enq.id, 'ECONNRESET', { maxAttempts: 3 });
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.deadLetterCount()).toBe(1);
  });

  it('resetClaimed re-promotes orphaned claimed rows back to pending (mid-claim crash recovery)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const dbPath = join(dir, 'asset-origin.db');

    // Round 1: enqueue, claim (simulate the moment between claimNext and upload),
    // then drop the outbox without finalizing — same shape as a daemon crash
    // mid-claim.
    {
      const outbox = new OriginOutbox({ dbPath });
      outbox.enqueue(dropFolderObservation({ sourceRef: 'folder://orphan' }));
      const claim = outbox.claimNext();
      expect(claim?.row.sourceRef).toBe('folder://orphan');
      expect(outbox.pendingCount()).toBe(0); // moved to 'claimed'
      outbox.close();
    }

    // Round 2: fresh outbox over the same db — without resetClaimed the
    // orphan is invisible to claimNext. With it, the row is recoverable.
    const reopened = new OriginOutbox({ dbPath });
    expect(reopened.pendingCount()).toBe(0); // still claimed
    const recovered = reopened.resetClaimed();
    expect(recovered).toBe(1);
    expect(reopened.pendingCount()).toBe(1);
    const reclaim = reopened.claimNext();
    expect(reclaim?.row.sourceRef).toBe('folder://orphan');
  });

  it('survives reopen — pending rows still claimable after instance is recreated', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    {
      const outbox = buildOutbox(dir);
      outbox.enqueue(dropFolderObservation({ sourceRef: 'folder://restart-test' }));
      expect(outbox.pendingCount()).toBe(1);
    }
    // Simulate process restart — fresh OriginOutbox over the same db file.
    const reopened = buildOutbox(dir);
    expect(reopened.pendingCount()).toBe(1);
    const claim = reopened.claimNext();
    expect(claim?.row.sourceRef).toBe('folder://restart-test');
  });
});
