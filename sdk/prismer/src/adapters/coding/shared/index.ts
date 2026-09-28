// WS-A (PP-0) — code-agent driver barrel (ported from Paseo).
//
// Re-exports the shared rich-event DATA types (lifted from Paseo's
// agent-sdk-types) plus the provider-facing AgentClient / AgentSession
// interfaces. These are consumed by:
//   - contract.ts (additive optional members + capabilityFlags)
//   - WS-B's CodeAgentDriver bridge (AgentClient / AgentSession driving)
//   - WS-C recorder widening + WS-E UI rich-event rendering (shared DATA types)
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.6 ①/⑤, §7.7 WS-A.

// Shared rich-event DATA types (long-horizon + code agents both render these).
export type {
  ToolCallDetail,
  ToolCallIconName,
  ToolCallTimelineItem,
  CompactionTimelineItem,
  AgentTimelineItem,
  AgentStreamEvent,
  AgentUsage,
  AgentSlashCommand,
  AgentSlashCommandKind,
  AgentCapabilityFlags,
} from './agent-sdk-types.js';

export { TOOL_CALL_ICON_NAMES, getAgentStreamEventTurnId } from './agent-sdk-types.js';

// Provider-facing interfaces (used by WS-B's bridge).
export type {
  AgentClient,
  AgentSession,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentRunResult,
  AgentRunOptions,
  AgentRuntimeInfo,
  AgentSessionConfig,
  AgentLaunchContext,
  AgentCreateSessionOptions,
  AgentProvider,
} from './agent-sdk-types.js';

// Lifted protocol attachment types.
export type { AgentAttachment } from './protocol/agent-attachment.js';
