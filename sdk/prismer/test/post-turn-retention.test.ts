import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';

describe('post-turn retention', () => {
  it('compacts old terminal payloads while preserving active jobs and tombstones', () => {
    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db, { maxAttempts: 1 });
    const processing = store.enqueue(input('a-processing'), 1).key;
    store.claimNext(1);
    const pending = store.enqueue(input('z-pending'), 1).key;

    const completed = store.enqueue(input('completed'), 2).key;
    store.complete(completed, 2);
    const dead = store.enqueue(input('dead'), 3).key;
    store.fail(dead, new Error('terminal'), 3);

    const day31 = 31 * 24 * 60 * 60 * 1_000;
    expect(store.compactTerminalPayloads(day31)).toBe(2);

    expect(store.get(pending)?.status).toBe('pending');
    expect(store.get(processing)?.status).toBe('processing');
    expect(store.get(completed)).toMatchObject({ status: 'completed', payloadCompactedAt: day31 });
    expect(store.get(dead)).toMatchObject({ status: 'dead_letter', payloadCompactedAt: day31 });
    expect(store.list()).toHaveLength(4);
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
    userMessage: 'x'.repeat(30_000),
    assistantResponse: 'y'.repeat(30_000),
    toolFailures: [],
  };
}
