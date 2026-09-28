import { describe, expect, it } from 'vitest';
import type { MemoryRecallHooks } from '../src/daemon/memory/hooks.js';
import {
  SessionRecallCoordinator,
  getSessionRecallCoordinator,
  noteDispatchRecall,
  setSessionRecallCoordinator,
} from '../src/daemon/memory/session-recall.js';

function hooks() {
  const calls: string[] = [];
  const fake = {
    onSessionStart: () => {
      calls.push('start');
      return { content: 'INDEX', truncated: false, pageId: 'index-1' };
    },
    onIdleRecallHint: (ctx: { query: string }) => {
      calls.push(`idle:${ctx.query}`);
      return { fence: '<memory-context>hit</memory-context>', results: [{ pageId: 'p1' }] };
    },
  } as unknown as MemoryRecallHooks;
  return { calls, fake };
}

describe('SessionRecallCoordinator', () => {
  it('fires session_start only for the first dispatch of a session', () => {
    const h = hooks();
    let now = 1_000;
    const coordinator = new SessionRecallCoordinator(h.fake, { idleAfterMs: 30_000, now: () => now });

    expect(
      coordinator.noteDispatch({
        workspaceId: 'ws1',
        agentImUserId: 'agent1',
        actorKind: 'agent',
        sessionId: 'conv1',
        prompt: 'hello',
      }),
    ).toMatchObject({ branch: 'session_start', content: 'INDEX' });

    now += 5_000;
    expect(
      coordinator.noteDispatch({
        workspaceId: 'ws1',
        agentImUserId: 'agent1',
        actorKind: 'agent',
        sessionId: 'conv1',
        prompt: 'still here',
      }),
    ).toMatchObject({ branch: 'active', content: null });
    expect(h.calls).toEqual(['start']);
  });

  it('fires idle_recall_hint after the idle threshold and ignores missing sessions', () => {
    const h = hooks();
    let now = 10_000;
    const coordinator = new SessionRecallCoordinator(h.fake, { idleAfterMs: 30_000, now: () => now });

    expect(
      coordinator.noteDispatch({
        workspaceId: 'ws1',
        agentImUserId: 'agent1',
        actorKind: 'agent',
        sessionId: null,
        prompt: 'kanban',
      }).branch,
    ).toBe('no_session');

    coordinator.noteDispatch({
      workspaceId: 'ws1',
      agentImUserId: 'agent1',
      actorKind: 'agent',
      sessionId: 'conv1',
      prompt: 'start',
    });
    now += 30_000;
    expect(
      coordinator.noteDispatch({
        workspaceId: 'ws1',
        agentImUserId: 'agent1',
        actorKind: 'agent',
        sessionId: 'conv1',
        prompt: 'what did we decide earlier?',
      }),
    ).toMatchObject({ branch: 'idle_recall_hint', hits: 1 });
    expect(h.calls).toEqual(['start', 'idle:what did we decide earlier?']);
  });

  it('exposes the daemon singleton without turning unwired dispatch into an error', () => {
    setSessionRecallCoordinator(null);
    expect(getSessionRecallCoordinator()).toBeNull();
    expect(
      noteDispatchRecall({
        workspaceId: 'ws1',
        agentImUserId: 'agent1',
        actorKind: 'agent',
        sessionId: 'conv1',
        prompt: 'hello',
      }).branch,
    ).toBe('unwired');

    const h = hooks();
    setSessionRecallCoordinator(new SessionRecallCoordinator(h.fake));
    expect(getSessionRecallCoordinator()).not.toBeNull();
    setSessionRecallCoordinator(null);
  });
});
