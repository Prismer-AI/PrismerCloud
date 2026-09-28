import { afterEach, describe, expect, it } from 'vitest';
import type { HookEvent, HookInput, Options as ClaudeOptions } from '@anthropic-ai/claude-agent-sdk';
import { openLocalDb } from '../src/sync/store.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import { TerminalFinalizer, setTerminalFinalizer } from '../src/adapters/coding/shared/lifecycle/terminal-finalizer.js';
import { runProviderTurn } from '../src/adapters/coding/shared/providers/provider-runner.js';
import { buildClaudeRuntimeHooks } from '../src/adapters/coding/claude-code/runtime-hooks.js';
import type { AgentStreamEvent } from '../src/adapters/coding/shared/agent-sdk-types.js';

afterEach(() => setTerminalFinalizer(null));

describe('provider terminal reliability is independent of Claude hooks', () => {
  it('persists the terminal job even when every hook-side handler throws', async () => {
    const hooks = buildClaudeRuntimeHooks({
      observe: () => {
        throw new Error('observation sink failed');
      },
      decidePreToolUse: () => {
        throw new Error('policy sink failed');
      },
      onError: () => {
        throw new Error('error reporter failed');
      },
    });

    for (const [event, extra] of hookFixtures()) {
      await expect(invoke(hooks, event, extra)).resolves.toMatchObject({ continue: true });
    }

    const db = openLocalDb(':memory:');
    const store = new PostTurnStore(db);
    setTerminalFinalizer(new TerminalFinalizer(store));
    let listener: (event: AgentStreamEvent) => void = () => undefined;
    const turn = runProviderTurn({
      prompt: 'implement the control plane',
      runOptions: {
        postTurn: {
          workspaceId: 'ws_test',
          agentImUserId: 'agent_1',
          conversationId: 'conv_1',
          turnId: 'turn_hook_failure',
          userMessage: 'implement the control plane',
        },
      },
      subscribe: (callback) => {
        listener = callback;
        return () => undefined;
      },
      startTurn: async () => {
        queueMicrotask(() => listener({ type: 'turn_completed', provider: 'claude', turnId: 'provider_turn' }));
        return { turnId: 'provider_turn' };
      },
      getSessionId: () => 'session_1',
    });

    await expect(turn).resolves.toMatchObject({ sessionId: 'session_1' });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      turnId: 'turn_hook_failure',
      terminalState: 'completed',
      status: 'pending',
    });
    db.close();
  });
});

type Hooks = NonNullable<ClaudeOptions['hooks']>;

async function invoke(hooks: Hooks, event: HookEvent, extra: Record<string, unknown>) {
  const callback = hooks[event]?.[0]?.hooks[0];
  expect(callback, `${event} callback missing`).toBeTypeOf('function');
  return callback!(hookInput(event, extra), undefined, {
    signal: new AbortController().signal,
  });
}

function hookInput(event: HookEvent, extra: Record<string, unknown>): HookInput {
  return {
    hook_event_name: event,
    session_id: 'session_1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/workspace',
    ...extra,
  } as HookInput;
}

function hookFixtures(): Array<[HookEvent, Record<string, unknown>]> {
  return [
    ['PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'tool_pre' }],
    [
      'PostToolUse',
      {
        tool_name: 'Read',
        tool_input: {},
        tool_response: 'ok',
        tool_use_id: 'tool_post',
      },
    ],
    [
      'PostToolUseFailure',
      {
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 'tool_fail',
        error: 'failed',
      },
    ],
    ['SubagentStart', { agent_id: 'child', agent_type: 'reviewer' }],
    [
      'SubagentStop',
      {
        agent_id: 'child',
        agent_type: 'reviewer',
        agent_transcript_path: '/tmp/child.jsonl',
        stop_hook_active: false,
      },
    ],
    ['Stop', { stop_hook_active: false }],
  ];
}
