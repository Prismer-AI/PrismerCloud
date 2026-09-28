import { afterEach, describe, expect, it } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { TerminalFinalizer, setTerminalFinalizer } from '../src/adapters/coding/shared/lifecycle/terminal-finalizer.js';
import { runProviderTurn } from '../src/adapters/coding/shared/providers/provider-runner.js';
import type { AgentStreamEvent } from '../src/adapters/coding/shared/agent-sdk-types.js';

describe('durable post-turn lifecycle', () => {
  const db = openLocalDb(':memory:');
  const store = new PostTurnStore(db);
  setTerminalFinalizer(new TerminalFinalizer(store));

  afterEach(() => {
    db.prepare('DELETE FROM post_turn_jobs').run();
  });

  it.each([
    ['completed', { type: 'turn_completed', provider: 'claude', turnId: 'provider-turn' }],
    ['failed', { type: 'turn_failed', provider: 'claude', turnId: 'provider-turn', error: 'boom', code: 'E_PROVIDER' }],
    ['canceled', { type: 'turn_canceled', provider: 'claude', turnId: 'provider-turn', reason: 'user' }],
  ] as const)('persists exactly one %s terminal snapshot', async (expectedState, event) => {
    const promise = drivenTurn(`task-${expectedState}`, event as AgentStreamEvent);
    if (expectedState === 'failed') await expect(promise).rejects.toThrow('boom');
    else await promise;

    const jobs = store.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      turnId: `task-${expectedState}`,
      terminalState: expectedState,
      status: 'pending',
    });
  });

  it('persists provider throws through the same finalizer path', async () => {
    await expect(
      runProviderTurn({
        prompt: 'hello',
        runOptions: { postTurn: context('task-throw') },
        subscribe: () => () => undefined,
        startTurn: async () => {
          throw new Error('provider process vanished');
        },
        getSessionId: () => 'session-1',
      }),
    ).rejects.toThrow('provider process vanished');

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ turnId: 'task-throw', terminalState: 'failed' });
  });

  it('threads terminal served model/provider into the finalizer and run result', async () => {
    let listener: (event: AgentStreamEvent) => void = () => undefined;
    const result = await runProviderTurn({
      prompt: 'hello',
      runOptions: {
        postTurn: {
          ...context('task-terminal-routing'),
          executionContext: {
            model: 'configured-intent-model',
            proxyProvider: 'configured-chain',
          },
        },
      },
      subscribe: (callback) => {
        listener = callback;
        return () => undefined;
      },
      startTurn: async () => {
        queueMicrotask(() => listener({
          type: 'turn_completed',
          provider: 'claude',
          turnId: 'provider-turn',
        }));
        return { turnId: 'provider-turn' };
      },
      getSessionId: () => 'session-1',
      getRuntimeInfo: async () => ({
        provider: 'claude',
        sessionId: 'session-1',
        model: 'served-model-final',
      }),
    });

    expect(result).toMatchObject({
      servedModel: 'served-model-final',
      servedProvider: 'claude',
    });
    expect(store.list()[0].payload.executionContext).toMatchObject({
      model: 'served-model-final',
      provider: 'claude',
      proxyProvider: 'configured-chain',
    });
  });

  it('persists subscribe failures and does not depend on provider session bookkeeping', async () => {
    await expect(
      runProviderTurn({
        prompt: 'hello',
        runOptions: { postTurn: context('task-subscribe-throw') },
        subscribe: () => {
          throw new Error('subscribe unavailable');
        },
        startTurn: async () => ({ turnId: 'never-started' }),
        getSessionId: () => 'session-1',
      }),
    ).rejects.toThrow('subscribe unavailable');
    expect(store.list()[0]).toMatchObject({
      turnId: 'task-subscribe-throw',
      terminalState: 'failed',
    });
  });

  it('keeps the first terminal snapshot and redacts/truncates bodies', () => {
    const finalizer = new TerminalFinalizer(store);
    const input = {
      workspaceId: 'ws_test',
      agentImUserId: 'agent_1',
      turnId: 'task-idempotent',
      terminalState: 'completed' as const,
      userMessage: `Bearer secret-token ${'x'.repeat(40_000)}`,
      assistantResponse: 'password=hunter2 done',
      toolFailures: [],
    };
    expect(finalizer.finalize(input).inserted).toBe(true);
    expect(
      finalizer.finalize({
        ...input,
        conversationId: 'conv_resolved_later',
        terminalState: 'failed',
      }).inserted,
    ).toBe(false);

    const job = store.list()[0];
    expect(job.terminalState).toBe('completed');
    expect(job.payload.userMessage).not.toContain('secret-token');
    expect(job.payload.assistantResponse).not.toContain('hunter2');
    expect(job.payload.contentMeta.userMessage.truncated).toBe(true);
    expect(job.payload.contentMeta.userMessage.originalBytes).toBeGreaterThan(24 * 1024);
  });

  it('persists the immutable execution context used by post-turn workers', () => {
    const finalizer = new TerminalFinalizer(store);
    finalizer.finalize({
      workspaceId: 'ws_test',
      agentImUserId: 'agent_1',
      conversationId: 'conv_1',
      turnId: 'task-routing-context',
      terminalState: 'completed',
      userMessage: 'Preserve the effective model and runtime context for this completed turn.',
      assistantResponse: 'The durable worker must use the same routing snapshot after a restart.',
      toolFailures: [],
      executionContext: {
        adapterName: ' hermes ',
        roleSlug: ' team-manager ',
        model: ' deepseek-v4-flash ',
        routingEvidenceSource: 'adapter',
        proxyProvider: ' default ',
        attachedAssetIds: [' asset_1 ', '', 'asset_1', 'asset_2'],
      },
    });

    expect(store.list()[0].payload.executionContext).toEqual({
      adapterName: 'hermes',
      roleSlug: 'team-manager',
      model: 'deepseek-v4-flash',
      routingEvidenceSource: 'adapter',
      proxyProvider: 'default',
      attachedAssetIds: ['asset_1', 'asset_2'],
    });
  });
});

function context(turnId: string) {
  return {
    workspaceId: 'ws_test',
    agentImUserId: 'agent_1',
    conversationId: 'conv_1',
    turnId,
    userMessage: 'hello',
  };
}

function drivenTurn(turnId: string, terminal: AgentStreamEvent) {
  let listener: (event: AgentStreamEvent) => void = () => undefined;
  return runProviderTurn({
    prompt: 'hello',
    runOptions: { postTurn: context(turnId) },
    subscribe: (callback) => {
      listener = callback;
      return () => undefined;
    },
    startTurn: async () => {
      queueMicrotask(() => listener(terminal));
      return { turnId: 'provider-turn' };
    },
    getSessionId: () => 'session-1',
  });
}
