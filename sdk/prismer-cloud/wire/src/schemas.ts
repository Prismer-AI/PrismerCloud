/**
 * @prismer/wire — PARA Event Zod Schemas
 *
 * Single source of truth for the PARA (Prismer Agent Runtime ABI) wire protocol.
 * All 47 events across 10 families as defined in docs/version190/03-para-spec.md §4.3.
 *
 * Count note: the §4.3.1 matrix shows "42" in the total row, but the per-family
 * row sums add up to 46. The TypeScript type block in §4.3 contains 47 distinct
 * event types (Environment family has 6 events: fs.op/file.watched/cwd.changed/
 * config.changed/worktree.created/worktree.removed; matrix says 5). This file
 * implements ALL events visible in the spec's authoritative TypeScript block.
 */

import { z } from 'zod';
import type { PermissionMode, PermissionRule, PermissionRuleSource } from '@prismer/sandbox-runtime';

// ─── Shared primitives ─────────────────────────────────────────────────────
// These Zod schemas must stay structurally aligned with the D12 canonical types
// in @prismer/sandbox-runtime/src/types.ts.  The `satisfies` constraint below
// makes tsc fail at compile-time if the schema drifts from the canonical type.

export const PermissionModeSchema = z.enum([
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'auto',
] as const) satisfies z.ZodType<PermissionMode>;

export const PermissionRuleSourceSchema = z.enum([
  'policySettings',
  'userSettings',
  'projectSettings',
  'localSettings',
  'skill',
  'session',
  'cliArg',
  'command',
] as const) satisfies z.ZodType<PermissionRuleSource>;

export const PermissionBehaviorSchema = z.enum(['allow', 'deny', 'ask'] as const);

export const PermissionRuleSchema: z.ZodType<PermissionRule> = z.object({
  source: PermissionRuleSourceSchema,
  behavior: PermissionBehaviorSchema,
  value: z.object({
    tool: z.string(),
    pattern: z.string().optional(),
  }),
});

// ─── SkillSource — 6 variants per §4.3 ───────────────────────────────────

export const SkillSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('project'), workspace: z.string() }),
  z.object({ kind: z.literal('workspace'), workspace: z.string() }),
  z.object({ kind: z.literal('plugin'), pluginName: z.string() }),
  z.object({ kind: z.literal('bundled'), adapter: z.string() }),
  z.object({
    kind: z.literal('registry'),
    registry: z.enum(['prismer', 'clawhub', 'hermes-official', 'skills-sh', 'github', 'well-known']),
    ref: z.string(),
  }),
]);

// ─── AgentDescriptor ──────────────────────────────────────────────────────

export const AgentDescriptorSchema = z.object({
  id: z.string(),
  adapter: z.string(),
  version: z.string(),
  tiersSupported: z.array(z.number().int().min(1).max(10)),
  capabilityTags: z.array(z.string()),
  workspace: z.string(),
  workspaceGroup: z.string().optional(),
});

// ─── Lifecycle family (8 events) ──────────────────────────────────────────

const AgentRegisterEventSchema = z.object({
  type: z.literal('agent.register'),
  agent: AgentDescriptorSchema,
});

const AgentSessionStartedEventSchema = z.object({
  type: z.literal('agent.session.started'),
  sessionId: z.string(),
  scope: z.string(),
  parentSessionId: z.string().optional(),
});

const AgentSessionResetEventSchema = z.object({
  type: z.literal('agent.session.reset'),
  sessionId: z.string(),
  reason: z.enum(['new', 'reset', 'clear', 'compact']),
});

const AgentSessionEndedEventSchema = z.object({
  type: z.literal('agent.session.ended'),
  sessionId: z.string(),
  reason: z.enum(['stop', 'crash', 'quota', 'logout', 'other']),
});

const AgentSubagentStartedEventSchema = z.object({
  type: z.literal('agent.subagent.started'),
  agentId: z.string(),
  parentAgentId: z.string(),
  subagentType: z.string(),
});

const AgentSubagentEndedEventSchema = z.object({
  type: z.literal('agent.subagent.ended'),
  agentId: z.string(),
  reason: z.string(),
  transcriptPath: z.string().optional(),
});

const AgentStateEventSchema = z.object({
  type: z.literal('agent.state'),
  status: z.enum(['idle', 'thinking', 'tool', 'awaiting_approval', 'error']),
});

const AgentTiersUpdateEventSchema = z.object({
  type: z.literal('agent.tiers.update'),
  agentId: z.string(),
  tiersAdded: z.array(z.number().int()),
  tiersRemoved: z.array(z.number().int()),
  reason: z.string().optional(),
});

// ─── Turn / LLM family (6 events) ────────────────────────────────────────

const AgentPromptSubmitEventSchema = z.object({
  type: z.literal('agent.prompt.submit'),
  sessionId: z.string(),
  prompt: z.string(),
  source: z.enum(['user', 'remote', 'subagent']),
});

const AgentLlmPreEventSchema = z.object({
  type: z.literal('agent.llm.pre'),
  sessionId: z.string(),
  model: z.string(),
  conversationLength: z.number().int().nonnegative(),
  isFirstTurn: z.boolean(),
});

const AgentLlmPostEventSchema = z.object({
  type: z.literal('agent.llm.post'),
  sessionId: z.string(),
  tokensUsed: z.number().int().nonnegative(),
  stopReason: z.string(),
});

const AgentTurnStepEventSchema = z.object({
  type: z.literal('agent.turn.step'),
  sessionId: z.string(),
  iteration: z.number().int().nonnegative(),
  toolNames: z.array(z.string()),
});

const AgentTurnEndEventSchema = z.object({
  type: z.literal('agent.turn.end'),
  sessionId: z.string(),
  lastAssistantMessage: z.string().optional(),
});

const AgentTurnFailureEventSchema = z.object({
  type: z.literal('agent.turn.failure'),
  sessionId: z.string(),
  errorType: z.enum(['rate_limit', 'auth', 'billing', 'invalid', 'server', 'max_tokens', 'unknown']),
  errorMessage: z.string(),
});

// ─── Message I/O family (5 events) ───────────────────────────────────────

const AgentMessageEventSchema = z.object({
  type: z.literal('agent.message'),
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
  ts: z.number(),
});

const AgentChannelInboundEventSchema = z.object({
  type: z.literal('agent.channel.inbound'),
  from: z.string(),
  content: z.string(),
  channelId: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

const AgentChannelOutboundSentEventSchema = z.object({
  type: z.literal('agent.channel.outbound.sent'),
  to: z.string(),
  content: z.string(),
  channelId: z.string(),
  success: z.boolean(),
});

const AgentChannelTranscribedEventSchema = z.object({
  type: z.literal('agent.channel.transcribed'),
  transcript: z.string(),
  from: z.string(),
  channelId: z.string(),
  mediaPath: z.string().optional(),
});

const AgentChannelPreprocessedEventSchema = z.object({
  type: z.literal('agent.channel.preprocessed'),
  bodyForAgent: z.string(),
  from: z.string(),
  channelId: z.string(),
});

// ─── Tool family (5 events) ───────────────────────────────────────────────

const AgentToolPreEventSchema = z.object({
  type: z.literal('agent.tool.pre'),
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
  riskTag: z.enum(['low', 'mid', 'high']).optional(),
});

const AgentToolPostEventSchema = z.object({
  type: z.literal('agent.tool.post'),
  callId: z.string(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  summary: z.string(),
  updatedMCPToolOutput: z.unknown().optional(),
});

const AgentToolFailureEventSchema = z.object({
  type: z.literal('agent.tool.failure'),
  callId: z.string(),
  error: z.string(),
  signalPattern: z.string().optional(),
  isInterrupt: z.boolean().optional(),
});

const AgentElicitationRequestEventSchema = z.object({
  type: z.literal('agent.elicitation.request'),
  serverName: z.string(),
  requestId: z.string(),
  formSchema: z.unknown(),
});

const AgentElicitationResultEventSchema = z.object({
  type: z.literal('agent.elicitation.result'),
  serverName: z.string(),
  requestId: z.string(),
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.unknown().optional(),
});

// ─── Permission family (3 events) ─────────────────────────────────────────

const AgentApprovalRequestEventSchema = z.object({
  type: z.literal('agent.approval.request'),
  callId: z.string(),
  prompt: z.string(),
  ttlMs: z.number().int().positive(),
  permissionSuggestions: z.array(z.unknown()).optional(),
});

const AgentApprovalResultEventSchema = z.object({
  type: z.literal('agent.approval.result'),
  callId: z.string(),
  decision: z.enum(['allow', 'deny', 'ask', 'defer']),
  by: z.enum(['local', 'remote']),
  updatedInput: z.unknown().optional(),
  updatedPermissions: z.array(z.unknown()).optional(),
});

const AgentApprovalDeniedEventSchema = z.object({
  type: z.literal('agent.approval.denied'),
  callId: z.string(),
  reason: z.string(),
  retry: z.boolean(),
});

// ─── Task / Teammate / Command family (4 events) ──────────────────────────

const AgentTaskCreatedEventSchema = z.object({
  type: z.literal('agent.task.created'),
  taskId: z.string(),
  subject: z.string(),
  description: z.string().optional(),
  teammateName: z.string().optional(),
  teamName: z.string().optional(),
});

const AgentTaskCompletedEventSchema = z.object({
  type: z.literal('agent.task.completed'),
  taskId: z.string(),
  subject: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
});

const AgentTeammateIdleEventSchema = z.object({
  type: z.literal('agent.teammate.idle'),
  teammateName: z.string(),
  teamName: z.string().optional(),
});

const AgentCommandEventSchema = z.object({
  type: z.literal('agent.command'),
  command: z.string(),
  args: z.unknown().optional(),
  source: z.string().optional(),
  commandKind: z.enum(['new', 'reset', 'stop', 'other']),
});

// ─── Memory / Context family (4 events) ───────────────────────────────────

const AgentCompactPreEventSchema = z.object({
  type: z.literal('agent.compact.pre'),
  sessionId: z.string(),
  trigger: z.enum(['manual', 'auto']),
  messageCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
});

const AgentCompactPostEventSchema = z.object({
  type: z.literal('agent.compact.post'),
  sessionId: z.string(),
  compactedCount: z.number().int().nonnegative(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
});

const AgentInstructionsLoadedEventSchema = z.object({
  type: z.literal('agent.instructions.loaded'),
  filePath: z.string(),
  memoryType: z.string(),
  loadReason: z.enum(['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact']),
});

const AgentBootstrapInjectedEventSchema = z.object({
  type: z.literal('agent.bootstrap.injected'),
  bootstrapFiles: z.array(z.string()),
  agentId: z.string(),
});

// ─── Environment family (6 events in spec code, 5 in matrix table) ────────

const AgentFsOpEventSchema = z.object({
  type: z.literal('agent.fs.op'),
  op: z.enum(['read', 'write', 'delete', 'exec']),
  path: z.string(),
  bytes: z.number().int().nonnegative().optional(),
});

const AgentFileWatchedEventSchema = z.object({
  type: z.literal('agent.file.watched'),
  filePath: z.string(),
  changeType: z.enum(['modify', 'add', 'remove']),
});

const AgentCwdChangedEventSchema = z.object({
  type: z.literal('agent.cwd.changed'),
  oldCwd: z.string(),
  newCwd: z.string(),
});

const AgentConfigChangedEventSchema = z.object({
  type: z.literal('agent.config.changed'),
  configSource: z.enum(['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills']),
  changedValues: z.unknown().optional(),
});

const AgentWorktreeCreatedEventSchema = z.object({
  type: z.literal('agent.worktree.created'),
  worktreePath: z.string(),
  branch: z.string().optional(),
});

const AgentWorktreeRemovedEventSchema = z.object({
  type: z.literal('agent.worktree.removed'),
  worktreePath: z.string(),
});

// ─── Notification family (1 event) ────────────────────────────────────────

const AgentNotificationEventSchema = z.object({
  type: z.literal('agent.notification'),
  notificationType: z.enum(['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'other']),
  message: z.string(),
  title: z.string().optional(),
});

// ─── Skill family (5 events) ──────────────────────────────────────────────

const AgentSkillActivatedEventSchema = z.object({
  type: z.literal('agent.skill.activated'),
  skillName: z.string(),
  source: SkillSourceSchema,
  trigger: z.enum(['user-invoke', 'model-invoke', 'auto-match']),
  args: z.string().optional(),
});

const AgentSkillDeactivatedEventSchema = z.object({
  type: z.literal('agent.skill.deactivated'),
  skillName: z.string(),
  reason: z.enum(['compaction-drop', 'session-end', 'explicit']),
});

const AgentSkillProposedEventSchema = z.object({
  type: z.literal('agent.skill.proposed'),
  draftPath: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.enum(['agent', 'user']),
});

const AgentSkillInstalledEventSchema = z.object({
  type: z.literal('agent.skill.installed'),
  skillName: z.string(),
  source: SkillSourceSchema,
  version: z.string().optional(),
  sha256: z.string(),
});

const AgentSkillUninstalledEventSchema = z.object({
  type: z.literal('agent.skill.uninstalled'),
  skillName: z.string(),
});

// ─── Combined discriminated union ─────────────────────────────────────────

/**
 * All 47 PARA events as a Zod discriminated union.
 *
 * Note: §4.3.1 matrix total shows "42" but per-family row sums = 46, and
 * the spec's authoritative TypeScript block contains 47 events (Environment
 * family has 6 events while the matrix row says 5). This schema implements
 * all events visible in §4.3's TypeScript block.
 */
export const ParaEventSchema = z.discriminatedUnion('type', [
  // Lifecycle (8)
  AgentRegisterEventSchema,
  AgentSessionStartedEventSchema,
  AgentSessionResetEventSchema,
  AgentSessionEndedEventSchema,
  AgentSubagentStartedEventSchema,
  AgentSubagentEndedEventSchema,
  AgentStateEventSchema,
  AgentTiersUpdateEventSchema,
  // Turn / LLM (6)
  AgentPromptSubmitEventSchema,
  AgentLlmPreEventSchema,
  AgentLlmPostEventSchema,
  AgentTurnStepEventSchema,
  AgentTurnEndEventSchema,
  AgentTurnFailureEventSchema,
  // Message I/O (5)
  AgentMessageEventSchema,
  AgentChannelInboundEventSchema,
  AgentChannelOutboundSentEventSchema,
  AgentChannelTranscribedEventSchema,
  AgentChannelPreprocessedEventSchema,
  // Tool (5)
  AgentToolPreEventSchema,
  AgentToolPostEventSchema,
  AgentToolFailureEventSchema,
  AgentElicitationRequestEventSchema,
  AgentElicitationResultEventSchema,
  // Permission (3)
  AgentApprovalRequestEventSchema,
  AgentApprovalResultEventSchema,
  AgentApprovalDeniedEventSchema,
  // Task / Teammate / Command (4)
  AgentTaskCreatedEventSchema,
  AgentTaskCompletedEventSchema,
  AgentTeammateIdleEventSchema,
  AgentCommandEventSchema,
  // Memory / Context (4)
  AgentCompactPreEventSchema,
  AgentCompactPostEventSchema,
  AgentInstructionsLoadedEventSchema,
  AgentBootstrapInjectedEventSchema,
  // Environment (6 — spec code has worktree.removed; matrix table says 5)
  AgentFsOpEventSchema,
  AgentFileWatchedEventSchema,
  AgentCwdChangedEventSchema,
  AgentConfigChangedEventSchema,
  AgentWorktreeCreatedEventSchema,
  AgentWorktreeRemovedEventSchema,
  // Notification (1)
  AgentNotificationEventSchema,
  // Skill (5)
  AgentSkillActivatedEventSchema,
  AgentSkillDeactivatedEventSchema,
  AgentSkillProposedEventSchema,
  AgentSkillInstalledEventSchema,
  AgentSkillUninstalledEventSchema,
]);

// ─── Re-export individual event schemas for consumers ─────────────────────

export {
  AgentRegisterEventSchema,
  AgentSessionStartedEventSchema,
  AgentSessionResetEventSchema,
  AgentSessionEndedEventSchema,
  AgentSubagentStartedEventSchema,
  AgentSubagentEndedEventSchema,
  AgentStateEventSchema,
  AgentTiersUpdateEventSchema,
  AgentPromptSubmitEventSchema,
  AgentLlmPreEventSchema,
  AgentLlmPostEventSchema,
  AgentTurnStepEventSchema,
  AgentTurnEndEventSchema,
  AgentTurnFailureEventSchema,
  AgentMessageEventSchema,
  AgentChannelInboundEventSchema,
  AgentChannelOutboundSentEventSchema,
  AgentChannelTranscribedEventSchema,
  AgentChannelPreprocessedEventSchema,
  AgentToolPreEventSchema,
  AgentToolPostEventSchema,
  AgentToolFailureEventSchema,
  AgentElicitationRequestEventSchema,
  AgentElicitationResultEventSchema,
  AgentApprovalRequestEventSchema,
  AgentApprovalResultEventSchema,
  AgentApprovalDeniedEventSchema,
  AgentTaskCreatedEventSchema,
  AgentTaskCompletedEventSchema,
  AgentTeammateIdleEventSchema,
  AgentCommandEventSchema,
  AgentCompactPreEventSchema,
  AgentCompactPostEventSchema,
  AgentInstructionsLoadedEventSchema,
  AgentBootstrapInjectedEventSchema,
  AgentFsOpEventSchema,
  AgentFileWatchedEventSchema,
  AgentCwdChangedEventSchema,
  AgentConfigChangedEventSchema,
  AgentWorktreeCreatedEventSchema,
  AgentWorktreeRemovedEventSchema,
  AgentNotificationEventSchema,
  AgentSkillActivatedEventSchema,
  AgentSkillDeactivatedEventSchema,
  AgentSkillProposedEventSchema,
  AgentSkillInstalledEventSchema,
  AgentSkillUninstalledEventSchema,
};
