import type {
  HookCallback,
  HookEvent,
  HookInput,
  HookJSONOutput,
  Options as ClaudeOptions,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

interface ClaudeRuntimeHookCommon {
  sessionId: string;
  cwd: string;
  parentTurnId?: string;
  agentId?: string;
  agentType?: string;
}

export type ClaudeRuntimeHookObservation =
  | (ClaudeRuntimeHookCommon & {
      type: 'pre_tool_use';
      toolName: string;
      toolUseId: string;
      toolInput: unknown;
    })
  | (ClaudeRuntimeHookCommon & {
      type: 'post_tool_use';
      toolName: string;
      toolUseId: string;
      toolInput: unknown;
      toolResponse: unknown;
      durationMs?: number;
    })
  | (ClaudeRuntimeHookCommon & {
      type: 'post_tool_use_failure';
      toolName: string;
      toolUseId: string;
      toolInput: unknown;
      error: string;
      interrupted: boolean;
      durationMs?: number;
    })
  | (ClaudeRuntimeHookCommon & {
      type: 'subagent_start';
      agentId: string;
      agentType: string;
    })
  | (ClaudeRuntimeHookCommon & {
      type: 'subagent_stop';
      agentId: string;
      agentType: string;
      lastAssistantMessage?: string;
    })
  | (ClaudeRuntimeHookCommon & {
      type: 'stop';
      stopHookActive: boolean;
      lastAssistantMessage?: string;
    });

export interface ClaudeRuntimePreToolDecision {
  decision: 'allow' | 'deny' | 'defer';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export interface ClaudeRuntimeHooksOptions {
  getParentTurnId?: () => string | undefined;
  observe?: (observation: ClaudeRuntimeHookObservation) => void | Promise<void>;
  decidePreToolUse?: (
    observation: Extract<ClaudeRuntimeHookObservation, { type: 'pre_tool_use' }>,
  ) => ClaudeRuntimePreToolDecision | Promise<ClaudeRuntimePreToolDecision>;
  onError?: (event: HookEvent, error: unknown) => void;
}

type ClaudeHooks = NonNullable<ClaudeOptions['hooks']>;

/**
 * Programmatic hooks owned by the Runtime host. Every callback is fail-open and
 * side-effect narrow: it emits normalized observations or a PreToolUse policy
 * decision, but never posts Cloud data, writes a plugin outbox, or asks Stop to
 * run another model review.
 */
export function buildClaudeRuntimeHooks(options: ClaudeRuntimeHooksOptions = {}): ClaudeHooks {
  const callback = (event: HookEvent, handler: (input: HookInput) => Promise<HookJSONOutput>): HookCallback => {
    return async (input) => {
      try {
        return await handler(input);
      } catch (error) {
        try {
          options.onError?.(event, error);
        } catch {
          // Hook error reporting is observation-only too.
        }
        return { continue: true };
      }
    };
  };

  const observe = async (observation: ClaudeRuntimeHookObservation): Promise<void> => {
    await options.observe?.(observation);
  };

  return {
    PreToolUse: [
      matcher(
        callback('PreToolUse', async (raw) => {
          const input = expectEvent(raw, 'PreToolUse');
          const observation: Extract<ClaudeRuntimeHookObservation, { type: 'pre_tool_use' }> = {
            ...common(input, options),
            type: 'pre_tool_use',
            toolName: input.tool_name,
            toolUseId: input.tool_use_id,
            toolInput: input.tool_input,
          };
          await observe(observation);
          const decision = (await options.decidePreToolUse?.(observation)) ?? {
            decision: 'defer' as const,
          };
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision.decision,
              ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
              ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
            },
          };
        }),
      ),
    ],
    PostToolUse: [
      matcher(
        callback('PostToolUse', async (raw) => {
          const input = expectEvent(raw, 'PostToolUse');
          await observe({
            ...common(input, options),
            type: 'post_tool_use',
            toolName: input.tool_name,
            toolUseId: input.tool_use_id,
            toolInput: input.tool_input,
            toolResponse: input.tool_response,
            ...(typeof input.duration_ms === 'number' ? { durationMs: input.duration_ms } : {}),
          });
          return { continue: true };
        }),
      ),
    ],
    PostToolUseFailure: [
      matcher(
        callback('PostToolUseFailure', async (raw) => {
          const input = expectEvent(raw, 'PostToolUseFailure');
          await observe({
            ...common(input, options),
            type: 'post_tool_use_failure',
            toolName: input.tool_name,
            toolUseId: input.tool_use_id,
            toolInput: input.tool_input,
            error: input.error,
            interrupted: input.is_interrupt === true,
            ...(typeof input.duration_ms === 'number' ? { durationMs: input.duration_ms } : {}),
          });
          return { continue: true };
        }),
      ),
    ],
    SubagentStart: [
      matcher(
        callback('SubagentStart', async (raw) => {
          const input = expectEvent(raw, 'SubagentStart');
          await observe({
            ...common(input, options),
            type: 'subagent_start',
            agentId: input.agent_id,
            agentType: input.agent_type,
          });
          return { continue: true };
        }),
      ),
    ],
    SubagentStop: [
      matcher(
        callback('SubagentStop', async (raw) => {
          const input = expectEvent(raw, 'SubagentStop');
          await observe({
            ...common(input, options),
            type: 'subagent_stop',
            agentId: input.agent_id,
            agentType: input.agent_type,
            ...(input.last_assistant_message ? { lastAssistantMessage: input.last_assistant_message } : {}),
          });
          return { continue: true };
        }),
      ),
    ],
    Stop: [
      matcher(
        callback('Stop', async (raw) => {
          const input = expectEvent(raw, 'Stop');
          await observe({
            ...common(input, options),
            type: 'stop',
            stopHookActive: input.stop_hook_active,
            ...(input.last_assistant_message ? { lastAssistantMessage: input.last_assistant_message } : {}),
          });
          // Observation only. In particular, no decision:block and no prompt
          // asking Claude to review/remember the turn.
          return { continue: true };
        }),
      ),
    ],
  };
}

function matcher(hook: HookCallback) {
  return { hooks: [hook], timeout: 5 };
}

function common(input: HookInput, options: ClaudeRuntimeHooksOptions): ClaudeRuntimeHookCommon {
  const parentTurnId = options.getParentTurnId?.();
  return {
    sessionId: input.session_id,
    cwd: input.cwd,
    ...(parentTurnId ? { parentTurnId } : {}),
    ...(input.agent_id ? { agentId: input.agent_id } : {}),
    ...(input.agent_type ? { agentType: input.agent_type } : {}),
  };
}

function expectEvent<TEvent extends HookInput['hook_event_name']>(
  input: HookInput,
  event: TEvent,
): Extract<HookInput, { hook_event_name: TEvent }> {
  if (input.hook_event_name !== event) {
    throw new Error(`Claude runtime hook expected ${event}, received ${input.hook_event_name}`);
  }
  return input as Extract<HookInput, { hook_event_name: TEvent }>;
}

export function decideClaudeRuntimePreToolUse(
  input: Pick<PreToolUseHookInput, 'tool_name'>,
  disallowedTools: readonly string[] | undefined,
): ClaudeRuntimePreToolDecision {
  const deniedBy = disallowedTools?.find((rule) => toolRuleMatches(rule, input.tool_name));
  return deniedBy ? { decision: 'deny', reason: `blocked by Runtime policy rule ${deniedBy}` } : { decision: 'defer' };
}

function toolRuleMatches(rule: string, toolName: string): boolean {
  const trimmed = rule.trim();
  return trimmed === '*' || trimmed === toolName || trimmed.startsWith(`${toolName}(`);
}
