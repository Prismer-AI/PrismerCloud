/**
 * adapter.ts — OpenClaw → PARA event adapter (v1.9.0)
 *
 * Translates the 13 OpenClaw hook events listed in §4.6.1 of
 * docs/version190/03-para-spec.md into PARA events and emits them via
 * an EventDispatcher.
 *
 * This adapter is OBSERVATION-ONLY — it does not block or modify any
 * OpenClaw behaviour.  All hook handlers are fire-and-forget.
 *
 * §4.6.1 Mapping (13 OpenClaw hooks → PARA events):
 *
 *  1. gateway:startup          → agent.register
 *  2. agent:bootstrap          → agent.bootstrap.injected
 *  3. command:new              → agent.command { commandKind: 'new' }
 *  4. command:reset            → agent.command { commandKind: 'reset' }
 *  5. command:stop             → agent.command { commandKind: 'stop' }
 *  6. command (general)        → agent.command { commandKind: 'other' }
 *  7. session:compact:before   → agent.compact.pre
 *  8. session:compact:after    → agent.compact.post
 *  9. session:patch            → agent.config.changed { configSource: 'skills' }
 * 10. message:received         → agent.channel.inbound
 * 11. message:transcribed      → agent.channel.transcribed
 * 12. message:preprocessed     → agent.channel.preprocessed
 * 13. message:sent             → agent.channel.outbound.sent
 *
 * The spec lists "command:new / command:reset / command:stop / command" as
 * four separate rows that all map to agent.command — they count as 4 of
 * the 13 hooks, making the table rows add up to 13.
 *
 * Note on session start / session end: §4.6.1 does NOT list
 * session:start or session:end for OpenClaw (those appear in the Hermes
 * mapping at §4.6.2).  They are NOT added here.
 *
 * Zod version handling:
 *   @prismer/wire bundles zod ^3 as a direct dep (not peer) so wire's own
 *   ParaEventSchema.parse() always runs against v3, regardless of whether
 *   the consumer (openclaw-channel, daemon, etc.) ships a different zod
 *   version at the top level. This lets this adapter import @prismer/wire
 *   types freely and delegate all validation to EventDispatcher, which
 *   holds the correct zod v3 reference internally.
 */

import type {
  AgentBootstrapHookEvent,
  GatewayStartupHookEvent,
  MessageReceivedHookEvent,
  MessageSentHookEvent,
  MessageTranscribedHookEvent,
  MessagePreprocessedHookEvent,
  SessionPatchHookEvent,
} from 'openclaw/plugin-sdk/hook-runtime';
import type { InternalHookEvent } from 'openclaw/plugin-sdk/hook-runtime';
import type {
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
  PluginHookToolContext,
} from './plugin-hook-types.js';
import type { ParaEvent } from '@prismer/wire';
import {
  EventDispatcher,
  PermissionLeaseManager,
  makeRegisterEvent,
  makeBootstrapInjected,
  makeCompactPre,
  makeCompactPost,
  makeSessionStarted,
  makeSessionEnded,
  makePromptSubmit,
  makeToolPre,
  makeToolPost,
  makeToolFailure,
  makeTurnEnd,
  makeTurnFailure,
} from '@prismer/adapters-core';
import {
  buildAndCacheDescriptor,
  loadCachedDescriptor,
  stableAdapterId,
} from './sink.js';

// Build a raw ParaEvent object for events not covered by the adapters-core
// builders. EventDispatcher.emit() validates via wire's bundled zod v3.
function raw(evt: unknown): ParaEvent {
  return evt as ParaEvent;
}

// ─── Helper: generate a random UUID ───────────────────────────────────────────

import { randomUUID } from 'node:crypto';
function generateId(): string {
  return randomUUID();
}

/** Safely extract a string value, returning fallback if not a non-empty string. */
function str(val: unknown, fallback: string): string {
  return typeof val === 'string' && val.length > 0 ? val : fallback;
}

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * OpenClawParaAdapter
 *
 * One public method per §4.6.1 hook row.  Each method is called by the
 * hook registration layer (register.ts) with the raw InternalHookEvent
 * narrowed to the concrete type.
 *
 * All emit() calls are fire-and-forget (void return).  Validation errors
 * are swallowed by EventDispatcher.onError — they are logged to stderr
 * but never propagate back to OpenClaw.
 */
export class OpenClawParaAdapter {
  constructor(
    private readonly dispatcher: EventDispatcher,
    // PermissionLeaseManager is injected for future L5/L10 use (skill rule
    // revocation on compaction, etc.).  Not used in v1.9.0 observation-only
    // mode but present so callers can share the same instance.
    private readonly lease: PermissionLeaseManager,
  ) {}

  /** Exposed for L5/L10 future integration (skill-lifecycle rule teardown). */
  getLease(): PermissionLeaseManager {
    return this.lease;
  }

  // ─── 1. gateway:startup → agent.register ───────────────────────────────

  /**
   * Called once when the OpenClaw gateway starts.
   * Emits agent.register to announce this adapter to the PARA daemon.
   */
  onGatewayStartup(_ctx: GatewayStartupHookEvent): void {
    const cached = loadCachedDescriptor();
    const descriptor = cached ?? buildAndCacheDescriptor();
    void this.dispatcher.emit(makeRegisterEvent(descriptor));
  }

  // ─── 2. agent:bootstrap → agent.bootstrap.injected ─────────────────────

  /**
   * Called when OpenClaw injects bootstrap files into a new agent context.
   * The spec notes this hook is "mutable array" — the PARA consumer may
   * update the list via updatedBootstrapFiles, but as PARA is
   * observation-only in v1.9.0 we only observe.
   */
  onAgentBootstrap(ctx: AgentBootstrapHookEvent): void {
    const workspace = ctx.context.workspaceDir ?? process.cwd();
    const agentId = str(ctx.context.agentId, stableAdapterId(workspace));
    const bootstrapFiles = (ctx.context.bootstrapFiles ?? [])
      .filter((f): f is NonNullable<typeof f> => f != null)
      .map((f) => (typeof f === 'object' && 'path' in f ? String((f as { path: unknown }).path) : String(f)));
    void this.dispatcher.emit(makeBootstrapInjected({ bootstrapFiles, agentId }));
  }

  // ─── 3. command:new → agent.command { commandKind: 'new' } ─────────────

  /**
   * Called when the user sends the /new command.
   */
  onCommandNew(ctx: InternalHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.command',
      command: '/new',
      args: ctx.context ?? {},
      source: 'user',
      commandKind: 'new',
    }));
  }

  // ─── 4. command:reset → agent.command { commandKind: 'reset' } ─────────

  /**
   * Called when the user sends the /reset command.
   */
  onCommandReset(ctx: InternalHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.command',
      command: '/reset',
      args: ctx.context ?? {},
      source: 'user',
      commandKind: 'reset',
    }));
  }

  // ─── 5. command:stop → agent.command { commandKind: 'stop' } ───────────

  /**
   * Called when the user sends the /stop command.
   */
  onCommandStop(ctx: InternalHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.command',
      command: '/stop',
      args: ctx.context ?? {},
      source: 'user',
      commandKind: 'stop',
    }));
  }

  // ─── 6. command (general) → agent.command { commandKind: 'other' } ─────

  /**
   * Called for any other slash command not covered by the specific handlers.
   * Maps to commandKind: 'other' per §4.6.1: "OpenClaw 'general listener'
   * 映为 commandKind: 'other' 以便统一路由".
   */
  onCommand(ctx: InternalHookEvent): void {
    const command = str(ctx.context?.command, `/${ctx.action}`);
    void this.dispatcher.emit(raw({
      type: 'agent.command',
      command,
      args: ctx.context ?? {},
      source: 'user',
      commandKind: 'other',
    }));
  }

  // ─── 7. session:compact:before → agent.compact.pre ──────────────────────

  /**
   * Called before OpenClaw compacts a session's context window.
   *
   * NOTE: OpenClaw's hook system exposes this as event type="session",
   * action="compact:before" (the colon is part of the action string, not
   * an event/action split).  register.ts subscribes to 'session:compact:before'.
   */
  onSessionCompactBefore(ctx: InternalHookEvent): void {
    const sessionId = str(ctx.sessionKey, generateId());
    const trigger =
      ctx.context?.trigger === 'manual' ? ('manual' as const) : ('auto' as const);
    const messageCount =
      typeof ctx.context?.messageCount === 'number' ? ctx.context.messageCount : 0;
    const tokenCount =
      typeof ctx.context?.tokenCount === 'number' ? ctx.context.tokenCount : 0;
    void this.dispatcher.emit(
      makeCompactPre({ sessionId, trigger, messageCount, tokenCount }),
    );
  }

  // ─── 8. session:compact:after → agent.compact.post ──────────────────────

  /**
   * Called after OpenClaw finishes compacting a session.
   * L8 Pattern P12: critical anchor point for session export / Arena Replay.
   */
  onSessionCompactAfter(ctx: InternalHookEvent): void {
    const sessionId = str(ctx.sessionKey, generateId());
    const compactedCount =
      typeof ctx.context?.compactedCount === 'number' ? ctx.context.compactedCount : 0;
    const tokensBefore =
      typeof ctx.context?.tokensBefore === 'number' ? ctx.context.tokensBefore : 0;
    const tokensAfter =
      typeof ctx.context?.tokensAfter === 'number' ? ctx.context.tokensAfter : 0;
    void this.dispatcher.emit(
      makeCompactPost({ sessionId, compactedCount, tokensBefore, tokensAfter }),
    );
  }

  // ─── 9. session:patch → agent.config.changed { configSource: 'skills' } ─

  /**
   * Called when a privileged client patches a session's config.
   * §4.6.1: "OpenClaw 特权 client 才发，PARA 沿用权限语义".
   * Maps to configSource: 'skills' because session patches in OpenClaw
   * are primarily skill-driven workspace updates.
   */
  onSessionPatch(ctx: SessionPatchHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.config.changed',
      configSource: 'skills',
      changedValues: ctx.context.patch ?? undefined,
    }));
  }

  // ─── 10. message:received → agent.channel.inbound ───────────────────────

  /**
   * Called when a message arrives on any channel (Telegram, Discord, Slack, ...).
   * OpenClaw's multi-channel unified entry → PARA agent.channel.inbound.
   */
  onMessageReceived(ctx: MessageReceivedHookEvent): void {
    // metadata passthrough restored — @prismer/wire now bundles zod ^3 as a
    // direct dep (not peer), so wire's internal ParaEventSchema.parse() runs
    // against v3 regardless of openclaw-channel's top-level zod version.
    // See 09-execution-plan §7.3.4 Drift Log entry on zod v3/v4 unification.
    const metadata = ctx.context.metadata;
    const hasMetadata = metadata && typeof metadata === 'object' && Object.keys(metadata as object).length > 0;
    void this.dispatcher.emit(raw({
      type: 'agent.channel.inbound',
      from: str(ctx.context.from, 'unknown'),
      content: str(ctx.context.content, ''),
      channelId: str(ctx.context.channelId, 'unknown'),
      ...(hasMetadata ? { metadata: metadata as Record<string, unknown> } : {}),
    }));
  }

  // ─── 11. message:transcribed → agent.channel.transcribed ─────────────────

  /**
   * Called after audio is transcribed.  Carries the transcript text plus
   * optional mediaPath for traceability.
   */
  onMessageTranscribed(ctx: MessageTranscribedHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.channel.transcribed',
      transcript: str(ctx.context.transcript, ''),
      from: str(ctx.context.from, 'unknown'),
      channelId: str(ctx.context.channelId, 'unknown'),
      mediaPath:
        typeof ctx.context.mediaPath === 'string' ? ctx.context.mediaPath : undefined,
    }));
  }

  // ─── 12. message:preprocessed → agent.channel.preprocessed ───────────────

  /**
   * Called after media enrichment and link expansion are complete.
   * The bodyForAgent field is the enriched body ready for the LLM.
   */
  onMessagePreprocessed(ctx: MessagePreprocessedHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.channel.preprocessed',
      bodyForAgent: str(ctx.context.bodyForAgent, str(ctx.context.body, '')),
      from: str(ctx.context.from, 'unknown'),
      channelId: str(ctx.context.channelId, 'unknown'),
    }));
  }

  // ─── 13. message:sent → agent.channel.outbound.sent ─────────────────────

  /**
   * Called after a message is delivered to the downstream channel.
   * The success flag is passed through so the PARA daemon can observe
   * delivery failures.
   */
  onMessageSent(ctx: MessageSentHookEvent): void {
    void this.dispatcher.emit(raw({
      type: 'agent.channel.outbound.sent',
      to: str(ctx.context.to, 'unknown'),
      content: str(ctx.context.content, ''),
      channelId: str(ctx.context.channelId, 'unknown'),
      success: ctx.context.success !== false,
    }));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Typed lifecycle hooks (`api.on(...)` surface)
  //
  // The `registerHook` InternalHookEvent surface above only fires when the
  // full OpenClaw *gateway* is running (multi-channel long-running server
  // mode).  `openclaw agent --local` uses a slimmer lifecycle — it doesn't
  // start the gateway, so hooks like `gateway:startup` or `message:received`
  // never fire there.
  //
  // The `api.on(hookName, handler)` surface — the typed `PluginHook*`
  // registry — IS fired in `--local` mode.  These handlers translate the
  // OpenClaw lifecycle events into PARA events so `~/.prismer/para/events.jsonl`
  // grows during one-shot agent runs.  This is the v1.9.0 report break #5 fix.
  //
  // Mapping (7 typed hooks → PARA):
  //   gateway_start       → agent.register (cached descriptor reused)
  //   session_start       → agent.register (if first time) + agent.session.started
  //   session_end         → agent.session.ended
  //   before_prompt_build → agent.prompt.submit
  //   agent_end           → agent.turn.end  /  agent.turn.failure
  //   before_tool_call    → agent.tool.pre
  //   after_tool_call     → agent.tool.post / agent.tool.failure
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * gateway_start — ensures `agent.register` is emitted once per OpenClaw
   * process.  The existing `gateway:startup` InternalHookEvent handler above
   * covers gateway mode; this typed handler covers the plugin-hook registry
   * surface, which fires in BOTH gateway and agent modes.  Idempotent by
   * design — if the descriptor was already emitted this process, we still
   * re-emit because `agent.register` is append-only for the daemon.
   */
  onGatewayStart(_event: PluginHookGatewayStartEvent, _ctx: PluginHookGatewayContext): void {
    const cached = loadCachedDescriptor();
    const descriptor = cached ?? buildAndCacheDescriptor();
    void this.dispatcher.emit(makeRegisterEvent(descriptor));
  }

  /**
   * session_start — a fresh OpenClaw agent session begins.
   * Emits agent.register on first call of the process (so `agent --local`
   * announces the adapter even though it never fires gateway_start), then
   * agent.session.started with the OpenClaw-provided sessionId.
   */
  onSessionStart(event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext): void {
    // agent.register — only emit on the first session of this process so
    // the events file doesn't get a `register` event per /new.  We do that
    // by reading the on-disk descriptor cache as a proxy for "first time":
    // `buildAndCacheDescriptor` writes the file, `loadCachedDescriptor`
    // returns the cached record.
    const hadCache = loadCachedDescriptor() !== null;
    if (!hadCache) {
      const descriptor = buildAndCacheDescriptor();
      void this.dispatcher.emit(makeRegisterEvent(descriptor));
    }

    const sessionId = str(event.sessionId, str(ctx.sessionId, generateId()));
    const workspace = process.cwd();
    void this.dispatcher.emit(makeSessionStarted({ sessionId, scope: workspace }));
  }

  /**
   * session_end — OpenClaw agent session terminates (normal exit, error,
   * etc.).  PARA needs a reason enum; we default to `stop` because
   * OpenClaw doesn't currently surface a typed reason field — if it adds
   * one, update here.
   */
  onSessionEnd(event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext): void {
    const sessionId = str(event.sessionId, str(ctx.sessionId, generateId()));
    void this.dispatcher.emit(makeSessionEnded({ sessionId, reason: 'stop' }));
  }

  /**
   * before_prompt_build — fires after OpenClaw loads the session messages
   * and before it builds the final system prompt.  This is the closest
   * analog to Claude Code's `UserPromptSubmit`: the user's prompt text is
   * available and no LLM call has happened yet.
   *
   * Prompt is capped at 3800 chars so the resulting JSONL line stays
   * below POSIX PIPE_BUF (~4096 B) — preserves atomic append when
   * CC/OpenClaw/Hermes adapters share `~/.prismer/para/events.jsonl`.
   */
  onBeforePromptBuild(event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext): void {
    const sessionId = str(ctx.sessionId, str(ctx.sessionKey, generateId()));
    const rawPrompt = str(event.prompt, '');
    const prompt = rawPrompt.length > 3800 ? rawPrompt.slice(0, 3800) + '…[truncated]' : rawPrompt;
    void this.dispatcher.emit(makePromptSubmit({
      sessionId,
      prompt,
      source: 'user',
    }));
  }

  /**
   * agent_end — OpenClaw finishes processing a turn (one `openclaw agent
   * --local` invocation wraps a single turn).  Maps to agent.turn.end on
   * success, agent.turn.failure on error.
   */
  onAgentEnd(event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext): void {
    const sessionId = str(ctx.sessionId, str(ctx.sessionKey, generateId()));
    if (event.success !== false) {
      // Extract the last assistant message from the messages array when
      // possible, capped to 1000 chars for sink-size sanity.
      let lastAssistantMessage: string | undefined;
      const msgs = Array.isArray(event.messages) ? event.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: unknown; content?: unknown } | undefined;
        if (m && typeof m === 'object' && (m as { role?: unknown }).role === 'assistant') {
          const content = (m as { content?: unknown }).content;
          if (typeof content === 'string') {
            lastAssistantMessage = content.length > 1000
              ? content.slice(0, 1000) + '…[truncated]'
              : content;
            break;
          }
        }
      }
      void this.dispatcher.emit(makeTurnEnd({ sessionId, lastAssistantMessage }));
      return;
    }
    // Failure path — normalize error to PARA errorType enum.
    const errRaw = str(event.error, 'unknown').toLowerCase();
    let errorType: 'rate_limit' | 'auth' | 'billing' | 'invalid' | 'server' | 'max_tokens' | 'unknown' = 'unknown';
    if (errRaw.includes('rate') || errRaw.includes('429')) errorType = 'rate_limit';
    else if (errRaw.includes('auth') || errRaw.includes('401') || errRaw.includes('403')) errorType = 'auth';
    else if (errRaw.includes('bill') || errRaw.includes('credit') || errRaw.includes('quota')) errorType = 'billing';
    else if (errRaw.includes('invalid') || errRaw.includes('400')) errorType = 'invalid';
    else if (errRaw.includes('server') || errRaw.includes('500') || errRaw.includes('502') || errRaw.includes('503')) errorType = 'server';
    else if (errRaw.includes('token') || errRaw.includes('length') || errRaw.includes('context')) errorType = 'max_tokens';
    void this.dispatcher.emit(makeTurnFailure({
      sessionId,
      errorType,
      errorMessage: str(event.error, 'unknown'),
    }));
  }

  /**
   * before_tool_call — fires before OpenClaw executes any tool.  Uses the
   * provider-specific toolCallId when available; otherwise generates a
   * stable id so the pre/post pair can be joined downstream.
   */
  onBeforeToolCall(event: PluginHookBeforeToolCallEvent, _ctx: PluginHookToolContext): void {
    const callId = str(event.toolCallId, generateId());
    const tool = str(event.toolName, 'unknown');
    void this.dispatcher.emit(makeToolPre({
      callId,
      tool,
      args: event.params ?? {},
    }));
  }

  /**
   * after_tool_call — fires after OpenClaw executes any tool.  Maps to
   * agent.tool.post on success, agent.tool.failure on error.
   */
  onAfterToolCall(event: PluginHookAfterToolCallEvent, _ctx: PluginHookToolContext): void {
    const callId = str(event.toolCallId, generateId());
    if (typeof event.error === 'string' && event.error.length > 0) {
      void this.dispatcher.emit(makeToolFailure({
        callId,
        error: event.error,
      }));
      return;
    }
    const durationMs = typeof event.durationMs === 'number' ? event.durationMs : 0;
    const summary = typeof event.result === 'string'
      ? (event.result.length > 200 ? event.result.slice(0, 200) + '…' : event.result)
      : (event.result ? 'ok' : 'ok');
    void this.dispatcher.emit(makeToolPost({
      callId,
      ok: true,
      durationMs,
      summary,
    }));
  }
}
