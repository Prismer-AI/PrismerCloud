import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemoryOutbox } from '../src/daemon/memory/outbox.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-memory-outbox-'));
}

function buildStoreAndOutbox(dir: string): { store: MemoryStore; outbox: MemoryOutbox } {
  const store = new MemoryStore({
    dbPath: join(dir, 'memory.db'),
    workspaceId: 'ws_test',
    deviceId: 'dev_x',
  });
  store.open();
  return { store, outbox: new MemoryOutbox({ store }) };
}

function commonEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    workspaceId: 'ws_test',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    deviceId: 'dev_x',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function pageUpsertEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return commonEvent({
    eventType: 'memory.page.upsert',
    pageId: 'page_xxx',
    path: 'a.md',
    parentVersion: 0,
    contentHash: 'deadbeef',
    payload: { kind: 'inline', content: 'hi' },
    idempotencyKey: 'upsert:ws_test:page_xxx:0:deadbeef',
    ...overrides,
  });
}

function pageDeleteEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return commonEvent({
    eventType: 'memory.page.delete',
    pageId: 'page_delete_xxx',
    parentVersion: 4,
    reason: 'user-request',
    idempotencyKey: 'delete:ws_test:page_delete_xxx:4',
    ...overrides,
  });
}

describe('MemoryOutbox', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('enqueue valid memory.page.upsert lands in pending queue, not dead letter', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const result = outbox.enqueue(pageUpsertEvent());
      expect(result.deadLetter).toBe(false);
      expect(result.id).toMatch(/^out_/);
      expect(outbox.pendingCount()).toBe(1);
      expect(outbox.deadLetterCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('persists canonical memory.page.delete with pageId and no invented path/payload fields', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const result = outbox.enqueue(pageDeleteEvent());
      expect(result.deadLetter).toBe(false);
      const row = store
        .rawDb()
        .prepare('SELECT envelopeJson FROM memory_outbox WHERE id = ?')
        .get(result.id) as { envelopeJson: string };
      const persisted = JSON.parse(row.envelopeJson) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        eventType: 'memory.page.delete',
        pageId: 'page_delete_xxx',
        parentVersion: 4,
      });
      expect(persisted).not.toHaveProperty('path');
      expect(persisted).not.toHaveProperty('payload');
    } finally {
      store.close();
    }
  });

  it('enqueue invalid envelope (missing required field) routes to dead letter', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const bad = pageUpsertEvent();
      delete bad.contentHash;
      const result = outbox.enqueue(bad);
      expect(result.deadLetter).toBe(true);
      expect(result.id).toMatch(/^dl_/);
      expect(outbox.pendingCount()).toBe(0);
      expect(outbox.deadLetterCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('enqueue completely malformed input (non-object) routes to dead letter without crash', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const result = outbox.enqueue('not-an-event' as unknown);
      expect(result.deadLetter).toBe(true);
    } finally {
      store.close();
    }
  });

  it('enqueue duplicate idempotencyKey returns the existing row id, no second insert', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const r1 = outbox.enqueue(pageUpsertEvent());
      const r2 = outbox.enqueue(pageUpsertEvent({ eventId: randomUUID() })); // same idempotencyKey
      expect(r1.id).toBe(r2.id);
      expect(outbox.pendingCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('memory.feedback without targetEventId/targetPageId fails the runtime constraint check → dead letter', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const result = outbox.enqueue(
        commonEvent({
          eventType: 'memory.feedback',
          rating: 1,
          idempotencyKey: 'feedback:ws_test:none:im_alice:abc',
        }),
      );
      expect(result.deadLetter).toBe(true);
      expect(outbox.deadLetterCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('memory.feedback WITH targetPageId enqueues normally', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const result = outbox.enqueue(
        commonEvent({
          eventType: 'memory.feedback',
          targetPageId: 'page_xxx',
          rating: 1,
          idempotencyKey: 'feedback:ws_test:page_xxx:im_alice:abc',
        }),
      );
      expect(result.deadLetter).toBe(false);
    } finally {
      store.close();
    }
  });

  it('observability events (recall_pull) accepted', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const result = outbox.enqueue(
        commonEvent({
          eventType: 'recall_pull',
          pageId: 'page_xxx',
          query: 'auth decision',
          metadataJson: { sessionId: 'sess_1', toolName: 'memory_search' },
          metricsJson: { tokenCount: 120, topK: 1 },
          idempotencyKey: 'obs:recall_pull:im_alice:2026-05-08T00:00:00Z:e1',
        }),
      );
      expect(result.deadLetter).toBe(false);
      expect(outbox.pendingCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('flush() in phase-0 reports pending count + flushed=0 (no worker)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      outbox.enqueue(pageUpsertEvent());
      const summary = outbox.flush();
      expect(summary.pending).toBe(1);
      expect(summary.flushed).toBe(0);
    } finally {
      store.close();
    }
  });

  // spec16 §10.2 (M-OUTBOX-001) — locks the seam the atomic write path relies
  // on: enqueue() participates in an OUTER transaction on the store's DB (the
  // extracted-page-applicator pattern). A throw after a REAL enqueue must roll
  // the outbox row back with the transaction, not leave it committed.
  it('enqueue participates in an outer store transaction (rolls back with it)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const { store, outbox } = buildStoreAndOutbox(dir);
    try {
      const db = store.rawDb();
      expect(() =>
        db.transaction(() => {
          outbox.enqueue(pageUpsertEvent());
          throw new Error('abort after enqueue');
        })(),
      ).toThrow('abort after enqueue');
      expect(outbox.pendingCount()).toBe(0);
    } finally {
      store.close();
    }
  });
});
