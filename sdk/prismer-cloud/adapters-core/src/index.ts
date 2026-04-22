/**
 * @prismer/adapters-core — Public entrypoint
 *
 * Shared utilities consumed by @prismer/claude-code-plugin (CC adapter)
 * and @prismer/openclaw-channel (OpenClaw adapter).
 * NOT published for external use — internal shared code.
 */

export { PermissionLeaseManager } from './permission-lease.js';

export {
  makeRegisterEvent,
  makeSessionStarted,
  makeSessionReset,
  makeSessionEnded,
  makeAgentState,
  makePromptSubmit,
  makeLlmPre,
  makeLlmPost,
  makeTurnStep,
  makeTurnEnd,
  makeTurnFailure,
  makeToolPre,
  makeToolPost,
  makeToolFailure,
  makeApprovalRequest,
  makeApprovalResult,
  makeTaskCreated,
  makeTaskCompleted,
  makeCompactPre,
  makeCompactPost,
  makeBootstrapInjected,
  makeSkillActivated,
  makeSkillDeactivated,
  makeSkillProposed,
  makeSkillInstalled,
  makeSkillUninstalled,
  makeAgentMessage,
  makeChannelInbound,
  makeChannelOutboundSent,
  makeChannelTranscribed,
  makeChannelPreprocessed,
  makeFsOp,
  makeFileWatched,
  makeCwdChanged,
  makeConfigChanged,
  makeWorktreeCreated,
  makeWorktreeRemoved,
} from './event-builder.js';

export {
  normalizeCallId,
  normalizeTimestamp,
  normalizeSessionId,
  normalizeRiskTag,
  isUuidV4,
} from './normalize.js';

export type { DispatchSink } from './dispatcher.js';
export { EventDispatcher } from './dispatcher.js';

// ─── PARA Patterns P4/P5/P8/P11/P12 infrastructure ────────────
export { TraceStore } from './patterns/trace-store.js';
export type { TraceStoreOptions } from './patterns/trace-store.js';
export { ApprovalGateway } from './patterns/approval-gateway.js';
export type {
  ApprovalDecision,
  ApprovalResult,
  ApprovalWaitOptions,
} from './patterns/approval-gateway.js';
export { InjectionRegistry } from './patterns/injection-registry.js';
export type {
  InjectionSource,
  SystemPromptSnippet,
  CacheSafeContext,
} from './patterns/injection-registry.js';

// ─── L10 Skill System (v1.9.0 PARA §4.6.3) ────────────────────
export { parseSkillMarkdown } from './skill-system/frontmatter.js';
export type { ParsedSkill } from './skill-system/frontmatter.js';
export {
  defaultSkillSources,
  discoverSkills,
  findSkill,
  loadSkillBody,
} from './skill-system/loader.js';
export type {
  SkillSource,
  SkillSourceKind,
  SkillDescriptor,
  LoaderOptions,
} from './skill-system/loader.js';
export { ProgressiveSkillLoader } from './skill-system/progressive.js';
export type { ProgressiveLoaderOptions, LoadedSkill } from './skill-system/progressive.js';
export {
  parseSkillRef,
  resolveSkillRef,
} from './skill-system/registry.js';
export type {
  RegistryKind,
  ResolvedSkillRef,
  ResolveOptions,
} from './skill-system/registry.js';
