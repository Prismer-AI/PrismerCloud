/**
 * register.ts — Wire OpenClawParaAdapter into OpenClaw's plugin API (v1.9.0)
 *
 * Reads the OpenClaw plugin SDK hook registration surface and registers one
 * handler per §4.6.1 hook row.  Only hooks that the SDK actually exposes are
 * wired.  Hooks not yet available in the SDK are marked TODO.
 *
 * Hook subscription API:
 *   api.registerHook(events: string | string[], handler: InternalHookHandler)
 *   — events is an OpenClaw hook key, e.g. 'gateway:startup', 'command:new'
 *   — same key format as OpenClawHookMetadata.events[]
 *
 * Error policy: if registerParaAdapter() itself throws, the caller (index.ts)
 * catches and logs — PARA failures must never block channel registration.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { InternalHookEvent } from 'openclaw/plugin-sdk/hook-runtime';
import {
  isAgentBootstrapEvent,
  isGatewayStartupEvent,
  isMessageReceivedEvent,
  isMessageSentEvent,
  isMessageTranscribedEvent,
  isMessagePreprocessedEvent,
  isSessionPatchEvent,
} from 'openclaw/plugin-sdk/hook-runtime';
import { EventDispatcher, PermissionLeaseManager } from '@prismer/adapters-core';
import type { DispatchSink } from '@prismer/adapters-core';
import { OpenClawParaAdapter } from './adapter.js';
import { defaultJsonlSink } from './sink.js';
import type {
  PluginApiWithTypedHooks,
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

export interface RegisterParaAdapterOptions {
  /** Override the default JSONL sink (useful for testing). */
  sink?: DispatchSink;
}

/**
 * registerParaAdapter — wire all available §4.6.1 hooks into the OpenClaw
 * plugin API and return the adapter instance.
 *
 * Hook wiring status (13 §4.6.1 hooks):
 *
 *  WIRED (8/13):
 *    gateway:startup          → onGatewayStartup   (hook key: 'gateway:startup')
 *    agent:bootstrap          → onAgentBootstrap    (hook key: 'agent:bootstrap')
 *    command:new              → onCommandNew        (hook key: 'command:new')
 *    command:reset            → onCommandReset      (hook key: 'command:reset')
 *    command:stop             → onCommandStop       (hook key: 'command:stop')
 *    command (general)        → onCommand           (hook key: 'command')
 *    message:received         → onMessageReceived   (hook key: 'message:received')
 *    message:sent             → onMessageSent       (hook key: 'message:sent')
 *
 *  WIRED (3 more, total 11/13):
 *    message:transcribed      → onMessageTranscribed  (hook key: 'message:transcribed')
 *    message:preprocessed     → onMessagePreprocessed (hook key: 'message:preprocessed')
 *    session:patch            → onSessionPatch        (hook key: 'session:patch')
 *
 *  TODO — NOT YET AVAILABLE in OpenClaw plugin SDK (openclaw@2026.4.14):
 *    session:compact:before — InternalHookEventType does not include
 *      'compact' sub-actions.  The SDK exposes 'session' type with actions
 *      'patch' only (SessionPatchHookEvent).  compact:before/after are
 *      fired internally but not surfaced to plugin hooks yet.
 *      Tracked: waiting for OpenClaw upstream to add
 *      CompactBeforeHookEvent / CompactAfterHookEvent and expose
 *      type='session', action='compact:before'/'compact:after'.
 *
 *    session:compact:after  — same reason as above.
 *
 * Net: 11/13 wired, 2 stubbed with TODO.
 */
export function registerParaAdapter(
  api: OpenClawPluginApi,
  opts?: RegisterParaAdapterOptions,
): OpenClawParaAdapter {
  const sink = opts?.sink ?? defaultJsonlSink;
  const dispatcher = new EventDispatcher(sink);
  const lease = new PermissionLeaseManager();
  const adapter = new OpenClawParaAdapter(dispatcher, lease);

  // Silence dispatch errors — observation-only; must not surface to OpenClaw.
  dispatcher.onError((err: Error) => {
    process.stderr.write(`[openclaw-para] dispatch error: ${err.message}\n`);
  });

  // ── 1. gateway:startup → agent.register ──────────────────────────────────
  api.registerHook('gateway:startup', (event: InternalHookEvent) => {
    if (isGatewayStartupEvent(event)) {
      adapter.onGatewayStartup(event);
    }
  });

  // ── 2. agent:bootstrap → agent.bootstrap.injected ────────────────────────
  api.registerHook('agent:bootstrap', (event: InternalHookEvent) => {
    if (isAgentBootstrapEvent(event)) {
      adapter.onAgentBootstrap(event);
    }
  });

  // ── 3. command:new → agent.command { commandKind: 'new' } ────────────────
  api.registerHook('command:new', (event: InternalHookEvent) => {
    adapter.onCommandNew(event);
  });

  // ── 4. command:reset → agent.command { commandKind: 'reset' } ────────────
  api.registerHook('command:reset', (event: InternalHookEvent) => {
    adapter.onCommandReset(event);
  });

  // ── 5. command:stop → agent.command { commandKind: 'stop' } ──────────────
  api.registerHook('command:stop', (event: InternalHookEvent) => {
    adapter.onCommandStop(event);
  });

  // ── 6. command (general) → agent.command { commandKind: 'other' } ─────────
  // This handler fires for ALL 'command' events, including command:new/reset/stop.
  // The spec maps this to commandKind: 'other' for any non-specific command event.
  // In practice, OpenClaw fires both the specific 'command:new' and the general
  // 'command' event, so we will emit both the specific and the general PARA events.
  // This is correct per §4.6.1: "general listener 映为 commandKind: 'other'".
  api.registerHook('command', (event: InternalHookEvent) => {
    // Only emit 'other' for actions not already covered by specific handlers.
    const specificActions = ['new', 'reset', 'stop'];
    if (!specificActions.includes(event.action)) {
      adapter.onCommand(event);
    }
  });

  // ── 9. session:patch → agent.config.changed { configSource: 'skills' } ───
  api.registerHook('session:patch', (event: InternalHookEvent) => {
    if (isSessionPatchEvent(event)) {
      adapter.onSessionPatch(event);
    }
  });

  // ── 10. message:received → agent.channel.inbound ──────────────────────────
  api.registerHook('message:received', (event: InternalHookEvent) => {
    if (isMessageReceivedEvent(event)) {
      adapter.onMessageReceived(event);
    }
  });

  // ── 11. message:transcribed → agent.channel.transcribed ───────────────────
  api.registerHook('message:transcribed', (event: InternalHookEvent) => {
    if (isMessageTranscribedEvent(event)) {
      adapter.onMessageTranscribed(event);
    }
  });

  // ── 12. message:preprocessed → agent.channel.preprocessed ────────────────
  api.registerHook('message:preprocessed', (event: InternalHookEvent) => {
    if (isMessagePreprocessedEvent(event)) {
      adapter.onMessagePreprocessed(event);
    }
  });

  // ── 13. message:sent → agent.channel.outbound.sent ────────────────────────
  api.registerHook('message:sent', (event: InternalHookEvent) => {
    if (isMessageSentEvent(event)) {
      adapter.onMessageSent(event);
    }
  });

  // TODO: session:compact:before → agent.compact.pre
  //   Waiting for OpenClaw upstream to expose CompactBeforeHookEvent.
  //   When available, wire: api.registerHook('session:compact:before', ...)
  //   → adapter.onSessionCompactBefore(event)

  // TODO: session:compact:after → agent.compact.post
  //   Same gap — no CompactAfterHookEvent in openclaw@2026.4.14.
  //   When available, wire: api.registerHook('session:compact:after', ...)
  //   → adapter.onSessionCompactAfter(event)

  // ═════════════════════════════════════════════════════════════════════════
  // Typed lifecycle hooks (api.on(...))
  //
  // v1.9.0 Docker closure report, break #5 (see v190-docker-closure-report.md):
  // `openclaw agent --local` does NOT start the gateway, so none of the
  // InternalHookEvent hooks wired above fire.  The typed plugin-hook registry
  // (`api.on(...)`) IS fired in `--local` mode, so we wire the same adapter
  // to both surfaces.
  //
  // Each hook key maps to the corresponding adapter method.  Error handling:
  // individual `api.on` calls are wrapped so a single unsupported hook key
  // doesn't abort the whole registration — forward-compat protection in case
  // OpenClaw renames/removes a hook between minor versions.
  //
  // `api.on` may be absent on older plugin hosts; the optional-chain check
  // below is a graceful no-op in that case (matching the
  // "non-fatal PARA" error policy declared at the top of this file).
  // ═════════════════════════════════════════════════════════════════════════

  const apiWithOn = api as unknown as OpenClawPluginApi & PluginApiWithTypedHooks;
  if (typeof apiWithOn.on === 'function') {
    const on = apiWithOn.on.bind(apiWithOn);

    const safeOn = (
      hookName: string,
      handler: (event: unknown, ctx: unknown) => void | Promise<void>,
    ): void => {
      try {
        on(hookName, handler);
      } catch (err) {
        // Unknown hook name (OpenClaw version skew) — log and continue.
        process.stderr.write(
          `[openclaw-para] api.on('${hookName}') failed (non-fatal): ${(err as Error).message}\n`,
        );
      }
    };

    // gateway_start → agent.register
    safeOn('gateway_start', (event, ctx) => {
      adapter.onGatewayStart(
        event as PluginHookGatewayStartEvent,
        ctx as PluginHookGatewayContext,
      );
    });

    // session_start → agent.register (first only) + agent.session.started
    safeOn('session_start', (event, ctx) => {
      adapter.onSessionStart(
        event as PluginHookSessionStartEvent,
        ctx as PluginHookSessionContext,
      );
    });

    // session_end → agent.session.ended
    safeOn('session_end', (event, ctx) => {
      adapter.onSessionEnd(
        event as PluginHookSessionEndEvent,
        ctx as PluginHookSessionContext,
      );
    });

    // before_prompt_build → agent.prompt.submit
    safeOn('before_prompt_build', (event, ctx) => {
      adapter.onBeforePromptBuild(
        event as PluginHookBeforePromptBuildEvent,
        ctx as PluginHookAgentContext,
      );
    });

    // agent_end → agent.turn.end or agent.turn.failure
    safeOn('agent_end', (event, ctx) => {
      adapter.onAgentEnd(
        event as PluginHookAgentEndEvent,
        ctx as PluginHookAgentContext,
      );
    });

    // before_tool_call → agent.tool.pre
    safeOn('before_tool_call', (event, ctx) => {
      adapter.onBeforeToolCall(
        event as PluginHookBeforeToolCallEvent,
        ctx as PluginHookToolContext,
      );
    });

    // after_tool_call → agent.tool.post or agent.tool.failure
    safeOn('after_tool_call', (event, ctx) => {
      adapter.onAfterToolCall(
        event as PluginHookAfterToolCallEvent,
        ctx as PluginHookToolContext,
      );
    });
  } else {
    process.stderr.write(
      '[openclaw-para] api.on not available on this OpenClaw host; '
      + 'typed PARA hooks will not fire for `openclaw agent --local` runs. '
      + 'Upgrade to openclaw >= 2026.4.14 for full PARA coverage.\n',
    );
  }

  return adapter;
}
