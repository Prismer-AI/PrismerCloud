import { describe, expect, it, vi } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { PostTurnWorker } from '../src/adapters/coding/shared/lifecycle/post-turn-worker.js';

describe('post-turn healthz snapshot', () => {
  it('is all-zero when wired empty and performs no SQLite I/O when read', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    const worker = new PostTurnWorker(
      { store, extract: vi.fn(async () => ({ pages: [] })), apply: vi.fn() },
      { now: () => 123 },
    );
    await worker.drainOnce();
    const healthSpy = vi.spyOn(store, 'health');

    expect(worker.snapshotHealth()).toEqual({
      pending: 0,
      processing: 0,
      deadLetter: 0,
      oldestPendingAgeMs: 0,
      sampledAt: 123,
    });
    expect(healthSpy).not.toHaveBeenCalled();
    db.close();
  });

  it('reports pending, processing and dead-letter from the cached worker sample', async () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 1 });
    store.enqueue(input('pending'), 10);
    store.enqueue(input('processing'), 10);
    store.claimNext(10);
    const deadKey = store.enqueue(input('dead'), 10).key;
    store.claimNext(10);
    store.fail(deadKey, new Error('dead'), 10);

    const worker = new PostTurnWorker(
      { store, extract: vi.fn(async () => ({ pages: [] })), apply: vi.fn() },
      { now: () => 20 },
    );
    // Constructor is deliberately zero-I/O; start recovers processing. For an
    // exact store sample, drain with no eligible work at a time before next-at.
    await worker.drainOnce();
    const snapshot = worker.snapshotHealth();
    expect(snapshot.deadLetter).toBe(1);
    expect(snapshot.sampledAt).toBe(20);
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
    userMessage: 'remember this',
    assistantResponse: 'done',
    toolFailures: [],
    executionContext: {
      model: 'served-model',
      provider: 'served-provider',
      routingEvidenceSource: 'adapter' as const,
    },
  };
}
