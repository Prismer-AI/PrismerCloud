import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDb } from '../src/sync/store.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { PostTurnWorker } from '../src/adapters/coding/shared/lifecycle/post-turn-worker.js';
import {
  TerminalFinalizer,
  synthesizeHostCrashedTurns,
} from '../src/adapters/coding/shared/lifecycle/terminal-finalizer.js';

describe('post-turn restart recovery', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('survives close/reopen before worker execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-turn-restart-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'local.db');
    const firstDb = openLocalDb(dbPath);
    new PostTurnStore(firstDb).enqueue(input('restart-before-worker'), 10);
    firstDb.close();

    const extract = vi.fn(async () => ({ pages: [] }));
    const secondDb = openLocalDb(dbPath);
    const secondStore = new PostTurnStore(secondDb);
    expect(secondStore.list()[0].payload.executionContext).toEqual({
      adapterName: 'hermes',
      roleSlug: 'team-manager',
      model: 'deepseek-v4-flash',
      provider: 'prismer-gateway',
      routingEvidenceSource: 'adapter',
      proxyProvider: 'default',
      attachedAssetIds: ['asset_1'],
    });
    const worker = new PostTurnWorker({ store: secondStore, extract, apply: vi.fn() }, { now: () => 10 });
    await worker.drainOnce();

    expect(extract).toHaveBeenCalledOnce();
    expect(secondStore.list()[0].status).toBe('completed');
    secondDb.close();
  });

  it('negative control: a legacy pending row without terminal provider cannot extract, apply, or accept receipts', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const missingProvider = input('missing-terminal-provider');
    missingProvider.executionContext.provider = undefined;
    missingProvider.explicitMemoryReceipts = [
      {
        pageId: 'untrusted-page',
        path: 'memory/untrusted.pkf',
        version: 1,
        contentHash: 'a'.repeat(64),
      },
    ];
    const { key } = store.enqueue(missingProvider, 30);
    const extract = vi.fn(async () => ({ pages: [] }));
    const apply = vi.fn();
    const worker = new PostTurnWorker({ store, extract, apply }, { now: () => 30 });

    await worker.drainOnce();

    expect(extract).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(store.get(key)).toMatchObject({
      status: 'dead_letter',
      applyResult: null,
      lastError: 'non_extractable:no_terminal_provider',
    });
    db.close();
  });

  it('reopens the same canonical repair row only after terminal routing evidence arrives', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const missingProvider = input('routing-enrichment');
    missingProvider.executionContext.provider = undefined;
    const first = store.enqueue(missingProvider, 40);
    const extract = vi.fn(async () => ({ pages: [] }));
    const apply = vi.fn();
    const worker = new PostTurnWorker({ store, extract, apply }, { now: () => 40 });

    await worker.drainOnce();
    expect(store.get(first.key)?.status).toBe('dead_letter');
    expect(extract).not.toHaveBeenCalled();

    const enriched = store.enqueue(input('routing-enrichment'), 40);
    await worker.drainOnce();

    expect(enriched).toEqual({ key: first.key, inserted: false });
    expect(store.list()).toHaveLength(1);
    expect(store.get(first.key)).toMatchObject({
      status: 'completed',
      payload: { executionContext: { model: 'deepseek-v4-flash', provider: 'prismer-gateway' } },
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    db.close();
  });

  it('recovers processing rows left by a crashed runtime', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const { key } = store.enqueue(input('processing-crash'), 20);
    expect(store.claimNext(20)?.status).toBe('processing');

    const extract = vi.fn(async () => ({ pages: [] }));
    const worker = new PostTurnWorker({ store, extract, apply: vi.fn() }, { now: () => 20 });
    worker.start();

    await vi.waitFor(() => expect(store.get(key)?.status).toBe('completed'));
    expect(extract).toHaveBeenCalledOnce();
    worker.stop();
    db.close();
  });

  it('replays the same gateway dead-letter job after a supervised runtime restart without forking a second row', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 1 });
    const { key } = store.enqueue(input('gateway-model-recovery'), 50);
    const unavailable = new PostTurnWorker(
      {
        store,
        extract: vi.fn(async () => {
          throw new Error(
            'gateway /api/v1/messages failed status=503 code=model_unavailable msg=temporarily unavailable',
          );
        }),
        apply: vi.fn(),
      },
      { now: () => 50 },
    );

    await unavailable.drainOnce();
    expect(store.get(key)).toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
      lastError: expect.stringContaining('model_unavailable'),
    });

    const apply = vi.fn(async () => [
      { pageId: 'page_recovered', path: 'decisions/recovered.pkf', version: 1, contentHash: 'hash_recovered' },
    ]);
    const recovered = new PostTurnWorker(
      {
        store,
        extract: vi.fn(async () => ({
          pages: [
            {
              path: 'decisions/recovered.pkf',
              title: 'Recovered decision',
              content: '<section><h2 id="decision">Recovered</h2></section>',
              placement: 'new' as const,
              pageType: 'leaf' as const,
              visibility: 'workspace' as const,
            },
          ],
        })),
        apply,
      },
      { now: () => 60 },
    );
    recovered.start();

    await vi.waitFor(() => expect(store.get(key)?.status).toBe('completed'));
    expect(store.list()).toHaveLength(1);
    expect(store.get(key)).toMatchObject({
      idempotencyKey: key,
      attemptCount: 1,
      applyResult: [
        { pageId: 'page_recovered', path: 'decisions/recovered.pkf', version: 1, contentHash: 'hash_recovered' },
      ],
    });
    expect(apply).toHaveBeenCalledOnce();
    recovered.stop();
    db.close();
  });

  it.each([
    {
      name: 'conversation identity',
      tamper: (db: ReturnType<typeof openLocalDb>, key: string) => {
        db.prepare('UPDATE post_turn_jobs SET conversation_id = NULL WHERE idempotency_key = ?').run(key);
      },
    },
    {
      name: 'canonical identity',
      tamper: (db: ReturnType<typeof openLocalDb>, key: string) => {
        db.prepare('UPDATE post_turn_jobs SET canonical_turn_id = NULL WHERE idempotency_key = ?').run(key);
      },
    },
    {
      name: 'execution model',
      tamper: (db: ReturnType<typeof openLocalDb>, key: string) => {
        db.prepare(
          `UPDATE post_turn_jobs
           SET payload_json = json_remove(payload_json, '$.executionContext.model')
           WHERE idempotency_key = ?`,
        ).run(key);
      },
    },
    {
      name: 'terminal provider',
      tamper: (db: ReturnType<typeof openLocalDb>, key: string) => {
        db.prepare(
          `UPDATE post_turn_jobs
           SET payload_json = json_remove(payload_json, '$.executionContext.provider')
           WHERE idempotency_key = ?`,
        ).run(key);
      },
    },
    {
      name: 'trusted adapter routing evidence',
      tamper: (db: ReturnType<typeof openLocalDb>, key: string) => {
        db.prepare(
          `UPDATE post_turn_jobs
           SET payload_json = json_remove(payload_json, '$.executionContext.routingEvidenceSource')
           WHERE idempotency_key = ?`,
        ).run(key);
      },
    },
  ])('never reopens a legacy gateway dead-letter missing $name', async ({ tamper }) => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 1 });
    const { key } = store.enqueue(input('legacy-gateway-dead-letter'), 65);
    const unavailable = new PostTurnWorker(
      {
        store,
        extract: vi.fn(async () => {
          throw new Error('gateway /api/v1/messages failed status=503 code=model_unavailable msg=offline');
        }),
        apply: vi.fn(),
      },
      { now: () => 65 },
    );
    await unavailable.drainOnce();
    const beforeRestart = store.get(key);
    expect(beforeRestart).toMatchObject({ status: 'dead_letter', attemptCount: 1 });
    expect(beforeRestart?.lastError).toContain('gateway /api/v1/messages failed');

    // Simulate an old persisted row whose original terminal routing snapshot
    // predates one of the now-required extraction identities.
    tamper(db, key);

    expect(store.recoverGatewayDeadLetters(66)).toBe(0);
    expect(store.get(key)).toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
      result: null,
      applyResult: null,
      lastError: expect.stringContaining('gateway /api/v1/messages failed'),
    });
    db.close();
  });

  it('never reopens a gateway dead-letter after its retained turn payload was compacted', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 1 });
    const { key } = store.enqueue(input('compacted-gateway-dead-letter'), 70);
    const unavailable = new PostTurnWorker(
      {
        store,
        extract: vi.fn(async () => {
          throw new Error('gateway /api/v1/messages failed status=503 code=model_unavailable msg=offline');
        }),
        apply: vi.fn(),
      },
      { now: () => 70 },
    );
    await unavailable.drainOnce();
    expect(store.get(key)?.status).toBe('dead_letter');
    expect(store.compactTerminalPayloads(71, 0)).toBe(1);
    expect(store.get(key)?.payloadCompactedAt).toBe(71);

    expect(store.recoverGatewayDeadLetters(72)).toBe(0);
    expect(store.get(key)?.status).toBe('dead_letter');
    db.close();
  });

  it('synthesizes host_crashed jobs from unfinished checkpoint provenance', () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const result = synthesizeHostCrashedTurns(
      [
        {
          runId: 'run_crashed',
          phaseName: 'tool_use',
          payload: {
            workspaceId: 'ws_test',
            agentImUserId: 'agent_1',
            userMessage: 'unfinished request',
            traceId: 'trace_1',
          },
        },
        { runId: 'run_unknown', phaseName: 'thinking', payload: {} },
      ],
      () => null,
      new TerminalFinalizer(store),
    );

    expect(result).toEqual({ inserted: 1, duplicate: 0, skipped: 1 });
    expect(store.list()[0]).toMatchObject({
      turnId: 'run_crashed',
      terminalState: 'host_crashed',
    });
    expect(store.list()[0].conversationId).toBeUndefined();
    db.close();
  });
});

function input(turnId: string) {
  return {
    workspaceId: 'ws_test',
    agentImUserId: 'agent_1',
    conversationId: 'conv_1',
    turnId,
    terminalState: 'completed' as const,
    userMessage: 'remember this durable fact about the project architecture and its ownership boundaries',
    assistantResponse:
      'I recorded a detailed architecture decision that is long enough for extraction to consider durable.',
    toolFailures: [],
    executionContext: {
      adapterName: 'hermes',
      roleSlug: 'team-manager',
      model: 'deepseek-v4-flash',
      provider: 'prismer-gateway',
      routingEvidenceSource: 'adapter' as const,
      proxyProvider: 'default',
      attachedAssetIds: ['asset_1'],
    },
  };
}
