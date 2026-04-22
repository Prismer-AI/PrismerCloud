/**
 * plugin-hook-types.ts — Local shims for OpenClaw's typed PluginHook surface
 *
 * openclaw@2026.4.14 does NOT re-export its `PluginHook*` types (e.g.
 * PluginHookSessionStartEvent) from the top-level `openclaw/plugin-sdk`
 * entry.  They're defined inside `dist/plugin-sdk/plugins/types.d.ts` but
 * that file is not an addressable subpath via `exports`.  Rather than
 * reach through an unsupported internal path (brittle across minor
 * upgrades), we mirror the structural shapes here.
 *
 * TypeScript uses structural typing: as long as these shapes stay a
 * *subset* of the upstream shape, `api.on('session_start', handler)`
 * still type-checks at registration time — handler callbacks written
 * against these locals will accept the real upstream event objects.
 *
 * If OpenClaw changes event shapes incompatibly, tests fail at the
 * adapter boundary and these shims get updated in lockstep.  That's
 * cheaper than depending on an unsupported import path.
 */

// ─── Shared ───────────────────────────────────────────────────────────────────

export interface PluginHookAgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

export interface PluginHookSessionContext {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
}

export interface PluginHookToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export interface PluginHookGatewayContext {
  [key: string]: unknown;
}

// ─── Event shapes (subset — only fields we actually read) ─────────────────────

export interface PluginHookSessionStartEvent {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
}

export interface PluginHookSessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
}

export interface PluginHookBeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface PluginHookAgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

export interface PluginHookBeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface PluginHookAfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface PluginHookGatewayStartEvent {
  [key: string]: unknown;
}

/**
 * Handler signatures accepted by `api.on(hookName, handler)`.
 * Kept as pure function types so callers can pass either sync or async
 * handlers — matches the upstream `PluginHookHandlerMap` loosely.
 */
export type PluginHookHandler<E, C> = (
  event: E,
  ctx: C,
) => void | Promise<void>;

/**
 * Minimal surface of `OpenClawPluginApi` that this adapter uses.  Mirrors
 * the upstream shape just enough for `api.on(...)` to type-check against
 * real API objects at call sites, without reaching into unexported paths.
 *
 * The upstream signature is:
 *   on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: {priority?: number}) => void
 *
 * Our version loosens the generic constraint to plain string — runtime
 * OpenClaw still validates the hookName against its internal set, so
 * misspellings surface as runtime log warnings, not silent no-ops.
 */
export interface PluginApiWithTypedHooks {
  on?: (
    hookName: string,
    handler: (event: unknown, ctx: unknown) => void | Promise<void>,
    opts?: { priority?: number },
  ) => void;
}
