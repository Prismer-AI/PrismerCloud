import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDb } from '../src/sync/store.js';
import {
  PostTurnRoutingEvidenceConflictError,
  PostTurnStore,
} from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { PostTurnWorker } from '../src/adapters/coding/shared/lifecycle/post-turn-worker.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { SCHEMA_VERSION } from '../src/daemon/memory/store.js';
import { ExtractedPageApplicator } from '../src/daemon/memory/extracted-page-applicator.js';
import type { ExtractedPage } from '../src/daemon/memory/extract.js';
import { canonicalDurabilityCommitKey } from '../src/adapters/coding/shared/lifecycle/canonical-turn-identity.js';

describe('post-turn exactly-once apply', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it.each(['after_page_write', 'after_outbox_enqueue'] as const)(
    'rolls back the whole memory transaction at %s',
    (failureStage) => {
      const rig = memoryRig(cleanup);
      const applicator = new ExtractedPageApplicator(rig.slot, {
        failAt: (stage) => {
          if (stage === failureStage) throw new Error(failureStage);
        },
      });

      expect(() => applicator.apply(PAGE, applyContext())).toThrow(failureStage);
      expect(counts(rig.slot.store.rawDb())).toEqual({ pages: 0, versions: 0, outbox: 0, applies: 0 });
      rig.runtime.closeAll();
    },
  );

  it('returns the apply ledger without increasing page version or outbox rows on replay', () => {
    const rig = memoryRig(cleanup);
    const applicator = new ExtractedPageApplicator(rig.slot);
    const first = applicator.apply(PAGE, applyContext());
    const replay = applicator.apply(PAGE, applyContext());

    expect(replay).toEqual(first);
    expect(counts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    rig.runtime.closeAll();
  });

  it('promotes an extractor standalone `new` page to a top-level hub instead of persisting an unclassified leaf', () => {
    const rig = memoryRig(cleanup);
    const applicator = new ExtractedPageApplicator(rig.slot);

    applicator.apply(PAGE, applyContext());

    expect(rig.slot.store.loadByAnyPath(PAGE.path)?.pageType).toBe('hub');
    rig.runtime.closeAll();
  });

  it('carries the Runtime canonical durability commit key unchanged into the Page outbox envelope', () => {
    const rig = memoryRig(cleanup);
    const applicator = new ExtractedPageApplicator(rig.slot);
    const context = applyContext();

    applicator.apply(PAGE, context);

    const row = rig.slot.store.rawDb().prepare(
      "SELECT idempotencyKey, envelopeJson FROM memory_outbox WHERE eventType = 'memory.page.upsert'",
    ).get() as { idempotencyKey: string; envelopeJson: string };
    const envelope = JSON.parse(row.envelopeJson) as { idempotencyKey: string };
    expect(row.idempotencyKey).toBe(context.commitKey);
    expect(envelope.idempotencyKey).toBe(context.commitKey);
    expect(context.commitKey).toBe(canonicalDurabilityCommitKey({
      workspaceId: context.workspaceId,
      agentImUserId: context.agentImUserId,
      canonicalTurnId: context.turnId,
    }));
    expect(context.commitKey).not.toContain(context.resultHash);
    rig.runtime.closeAll();
  });

  it('does not re-extract or rewrite after apply committed but job completion failed', async () => {
    const rig = memoryRig(cleanup);
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { retryBaseMs: 1 });
    const { key } = store.enqueue(jobInput('commit-before-complete'), 0);
    const extract = vi.fn(async () => ({ pages: [PAGE] }));
    const applicator = new ExtractedPageApplicator(rig.slot);
    let firstApply = true;
    let clock = 0;
    const worker = new PostTurnWorker(
      {
        store,
        extract,
        apply: (job, result, resultHash) => {
          applicator.applyAll(result.pages, {
            postTurnKey: job.idempotencyKey,
            commitKey: canonicalDurabilityCommitKey({
              workspaceId: job.workspaceId,
              agentImUserId: job.agentImUserId,
              canonicalTurnId: job.canonicalTurnId,
            }),
            resultHash,
            workspaceId: job.workspaceId,
            agentImUserId: job.agentImUserId,
            conversationId: job.conversationId,
            turnId: job.turnId,
            deviceId: 'device_1',
          });
          if (firstApply) {
            firstApply = false;
            throw new Error('crash before job complete');
          }
        },
      },
      { now: () => clock },
    );

    await worker.drainOnce();
    expect(store.get(key)?.status).toBe('pending');
    clock = 1;
    await worker.drainOnce();

    expect(store.get(key)?.status).toBe('completed');
    expect(extract).toHaveBeenCalledOnce();
    expect(counts(rig.slot.store.rawDb())).toEqual({ pages: 1, versions: 1, outbox: 1, applies: 1 });
    db.close();
    rig.runtime.closeAll();
  });

  it('uses a persisted result ledger when a crash happens before first apply', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const { key } = store.enqueue(jobInput('result-before-apply'), 0);
    store.saveExtractionResult(key, { pages: [PAGE] }, 0);
    const extract = vi.fn(async () => ({ pages: [] }));
    const apply = vi.fn();
    const worker = new PostTurnWorker({ store, extract, apply }, { now: () => 0 });

    await worker.drainOnce();

    expect(extract).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    expect(store.get(key)?.status).toBe('completed');
    db.close();
  });

  it('performs a real memory schema v1 to v3 migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-schema-v3-'));
    cleanup.push(dir);
    const workspaceDir = join(dir, 'ws_test');
    const dbPath = join(workspaceDir, 'memory.db');
    // MemoryRuntime creates the workspace directory lazily, so create only the
    // parent here while keeping the DB itself in a genuine v1 shape.
    mkdirSync(workspaceDir, { recursive: true });
    const legacy = new Database(dbPath);
    legacy.prepare('CREATE TABLE memory_schema_version (version INTEGER PRIMARY KEY)').run();
    legacy.prepare('INSERT INTO memory_schema_version (version) VALUES (1)').run();
    legacy.close();

    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
    const slot = runtime.resolve('ws_test');
    expect(
      slot.store.rawDb().prepare("SELECT name FROM sqlite_master WHERE name = 'memory_post_turn_applies'").get(),
    ).toBeTruthy();
    // product209/16 §9.4 (memory_replica_state + the two memory_pages columns):
    // a genuine v1 db walks EVERY ratchet on open and lands at the runtime's
    // current schema version (pinned by import, so the V4 FTS rebuild of
    // memory211/01 W2 #7 does not re-edit this test).
    expect(
      (slot.store.rawDb().prepare('SELECT version FROM memory_schema_version').get() as { version: number }).version,
    ).toBe(SCHEMA_VERSION);
    runtime.closeAll();
  });

  it('accepts terminal routing only from the adapter and rejects conflicting replay evidence', () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const base = jobInput('routing-authority');
    store.enqueue({ ...base, executionContext: { adapterName: 'hermes' } }, 0);
    store.enqueue({
      ...base,
      executionContext: {
        adapterName: 'hermes',
        model: 'served-model-a',
        provider: 'served-provider',
        routingEvidenceSource: 'adapter',
      },
    }, 1);
    expect(store.list()[0]?.payload.executionContext).toMatchObject({
      model: 'served-model-a',
      provider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });

    expect(() => store.enqueue({
      ...base,
      executionContext: {
        model: 'forged-model-b',
        provider: 'served-provider',
        routingEvidenceSource: 'adapter',
      },
    }, 2)).toThrow(PostTurnRoutingEvidenceConflictError);
    expect(store.list()[0]?.payload.executionContext?.model).toBe('served-model-a');
    db.close();
  });

  it('redacts JWT, PEM, credential URLs and bounded failure errors at the persistence boundary', () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 1 });
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OSJ9.signature123456789';
    const pem = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
    const connection = 'postgresql://admin:plain-password@db.internal:5432/prod';
    const { key } = store.enqueue({
      ...jobInput('redaction'),
      userMessage: `${jwt} ${pem}`,
      assistantResponse: connection,
      toolFailures: [{ tool: 'terminal', summary: `password=hunter2 ${jwt}` }],
    }, 0);
    store.fail(key, new Error(`${connection} ${'x'.repeat(8_000)}`), 1);
    const persisted = store.get(key)!;
    const serialized = JSON.stringify(persisted.payload);
    expect(serialized).not.toContain('secret-material');
    expect(serialized).not.toContain('signature123456789');
    expect(serialized).not.toContain('plain-password');
    expect(serialized).not.toContain('hunter2');
    expect(persisted.lastError).not.toContain('plain-password');
    expect(Buffer.byteLength(persisted.lastError ?? '', 'utf8')).toBeLessThanOrEqual(4 * 1024);
    db.close();
  });
});

const PAGE: ExtractedPage = {
  path: 'decisions/runtime-control.pkf',
  title: 'Runtime control plane',
  content: '# Runtime control plane\n\nRuntime owns terminal lifecycle reliability.',
  placement: 'new',
  pageType: 'leaf',
  visibility: 'workspace',
};

function memoryRig(cleanup: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'post-turn-memory-'));
  cleanup.push(dir);
  const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device_1' });
  return { runtime, slot: runtime.resolve('ws_test') };
}

function applyContext() {
  return {
    postTurnKey: 'post-turn:ws_test:agent_1:conv_1:turn_1',
    commitKey: canonicalDurabilityCommitKey({
      workspaceId: 'ws_test',
      agentImUserId: 'agent_1',
      canonicalTurnId: 'turn_1',
    }),
    resultHash: 'result-hash-1',
    pageIndex: 0,
    workspaceId: 'ws_test',
    agentImUserId: 'agent_1',
    conversationId: 'conv_1',
    turnId: 'turn_1',
    deviceId: 'device_1',
  };
}

function jobInput(turnId: string) {
  return {
    workspaceId: 'ws_test',
    agentImUserId: 'agent_1',
    conversationId: 'conv_1',
    turnId,
    terminalState: 'completed' as const,
    userMessage: 'remember this architecture decision',
    assistantResponse: 'the runtime owns it',
    toolFailures: [],
    executionContext: {
      model: 'served-model',
      provider: 'served-provider',
      routingEvidenceSource: 'adapter' as const,
    },
  };
}

function counts(db: Database.Database) {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    pages: count('memory_pages'),
    versions: count('memory_page_versions'),
    outbox: count('memory_outbox'),
    applies: count('memory_post_turn_applies'),
  };
}
