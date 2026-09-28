import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookEvent, HookInput, Options as ClaudeOptions } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentClient } from '../src/adapters/coding/claude-code/agent.js';
import {
  buildClaudeRuntimeHooks,
  type ClaudeRuntimeHookObservation,
} from '../src/adapters/coding/claude-code/runtime-hooks.js';
import type { ClaudeQueryInput } from '../src/adapters/coding/claude-code/query.js';

function makeLogger(): any {
  const noop = () => undefined;
  const logger: any = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
  };
  logger.child = () => logger;
  return logger;
}

function makeQueryStub(): any {
  return {
    supportedCommands: async () => [],
    applyFlagSettings: async () => undefined,
    close: () => undefined,
    return: async () => undefined,
    async *[Symbol.asyncIterator]() {
      /* no messages */
    },
  };
}

let tempHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-hooks-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('Claude Runtime native hooks', () => {
  it('buildOptions installs Runtime callbacks and ignores ~/.claude/hooks.json', async () => {
    const globalClaudeDir = path.join(tempHome, '.claude');
    const globalHooksPath = path.join(globalClaudeDir, 'hooks.json');
    const globalMarker = JSON.stringify({ Stop: [{ command: 'should-never-run' }] });
    mkdirSync(globalClaudeDir, { recursive: true });
    writeFileSync(globalHooksPath, globalMarker, 'utf8');

    let captured: ClaudeOptions | undefined;
    const client = new ClaudeAgentClient({
      logger: makeLogger(),
      runtimeSettings: { disallowedTools: ['Bash(git push *)'] },
      resolveBinary: async () => '/nonexistent/claude',
      queryFactory: (input: ClaudeQueryInput) => {
        captured = input.options;
        return makeQueryStub();
      },
    } as any);
    const profileHook = async () => {
      throw new Error('profile hook must be replaced');
    };
    const session = await client.createSession({
      provider: 'claude',
      cwd: process.cwd(),
      extra: {
        claude: {
          hooks: { Stop: [{ hooks: [profileHook] }] },
        },
      },
    } as any);

    await session.listCommands();

    expect(captured?.hooks && Object.keys(captured.hooks).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'Stop',
      'SubagentStart',
      'SubagentStop',
    ]);
    expect(captured?.hooks?.Stop?.[0]?.hooks[0]).not.toBe(profileHook);
    expect(readFileSync(globalHooksPath, 'utf8')).toBe(globalMarker);

    const output = await captured!.hooks!.PreToolUse![0]!.hooks[0]!(
      hookInput('PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        tool_use_id: 'tool_1',
      }),
      'tool_1',
      { signal: new AbortController().signal },
    );
    expect(output).toMatchObject({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
  });

  it('normalizes tool, subagent and Stop signals without blocking Stop', async () => {
    const observations: ClaudeRuntimeHookObservation[] = [];
    const hooks = buildClaudeRuntimeHooks({
      getParentTurnId: () => 'turn_parent',
      observe: (observation) => observations.push(observation),
    });

    await invoke(hooks, 'PreToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_use_id: 'tool_read',
    });
    await invoke(hooks, 'PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_response: 'ok',
      tool_use_id: 'tool_read',
      duration_ms: 12,
    });
    await invoke(hooks, 'PostToolUseFailure', {
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_use_id: 'tool_fail',
      error: 'exit 1',
      is_interrupt: false,
    });
    await invoke(hooks, 'SubagentStart', {
      agent_id: 'child_1',
      agent_type: 'code-reviewer',
    });
    await invoke(hooks, 'SubagentStop', {
      agent_id: 'child_1',
      agent_type: 'code-reviewer',
      agent_transcript_path: '/tmp/child.jsonl',
      stop_hook_active: false,
      last_assistant_message: 'review complete',
    });
    const stop = await invoke(hooks, 'Stop', {
      stop_hook_active: false,
      last_assistant_message: 'done',
    });

    expect(observations.map((item) => item.type)).toEqual([
      'pre_tool_use',
      'post_tool_use',
      'post_tool_use_failure',
      'subagent_start',
      'subagent_stop',
      'stop',
    ]);
    expect(observations[3]).toMatchObject({
      type: 'subagent_start',
      agentId: 'child_1',
      parentTurnId: 'turn_parent',
    });
    expect(stop).toEqual({ continue: true });
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
