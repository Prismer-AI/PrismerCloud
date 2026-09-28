// RuntimeAgentEngine is the provider-agnostic in-runtime agent contract.
//
// It intentionally reuses the existing AgentClient/AgentSession surface while
// moving non-coding engines such as pi-core out of the coding adapter namespace.
// The old source file remains the shared type owner during this migration so
// existing coding providers do not churn.

export type {
  AgentClient as RuntimeAgentEngine,
  AgentCreateSessionOptions as RuntimeAgentEngineCreateSessionOptions,
  AgentLaunchContext as RuntimeAgentEngineLaunchContext,
  AgentMode as RuntimeAgentEngineMode,
  AgentModelDefinition as RuntimeAgentEngineModelDefinition,
  AgentPersistenceHandle as RuntimeAgentEnginePersistenceHandle,
  AgentPermissionRequest as RuntimeAgentEnginePermissionRequest,
  AgentPermissionResponse as RuntimeAgentEnginePermissionResponse,
  AgentPermissionResult as RuntimeAgentEnginePermissionResult,
  AgentPromptContentBlock as RuntimeAgentEnginePromptContentBlock,
  AgentPromptInput as RuntimeAgentEnginePromptInput,
  AgentRunOptions as RuntimeAgentEngineRunOptions,
  AgentRunResult as RuntimeAgentEngineRunResult,
  AgentRuntimeInfo as RuntimeAgentEngineInfo,
  AgentSession as RuntimeAgentEngineSession,
  AgentSessionConfig as RuntimeAgentEngineSessionConfig,
  AgentSlashCommand as RuntimeAgentEngineSlashCommand,
  AgentStreamEvent as RuntimeAgentEngineStreamEvent,
  AgentTimelineItem as RuntimeAgentEngineTimelineItem,
} from "../../coding/shared/agent-sdk-types.js";

export type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../coding/shared/agent-sdk-types.js";
