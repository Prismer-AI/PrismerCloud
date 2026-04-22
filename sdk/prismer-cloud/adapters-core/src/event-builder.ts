/**
 * event-builder.ts — Pure helper functions that assemble PARA events.
 *
 * Each constructor:
 *   1. Accepts typed params (no `any`)
 *   2. Validates the assembled event via ParaEventSchema.parse() — throws
 *      ZodError on invalid input so adapter bugs surface immediately
 *   3. Returns the validated ParaEvent (discriminated union member)
 *
 * One constructor per event family that adapters commonly emit (~20 events).
 * Rare events (elicitation.result, channel.transcribed, skill.proposed) are
 * intentionally omitted — consumers construct literals and call
 * ParaEventSchema.parse() directly.
 */

import type {
  AgentDescriptor,
  ParaEvent,
  SkillSource,
} from '@prismer/wire';
import { ParaEventSchema } from '@prismer/wire';

// ─── Helper: validate and narrow ──────────────────────────────────────────

function build(raw: unknown): ParaEvent {
  return ParaEventSchema.parse(raw);
}

// ─── Lifecycle family ─────────────────────────────────────────────────────

/** agent.register — emitted once at adapter startup. */
export function makeRegisterEvent(agent: AgentDescriptor): ParaEvent {
  return build({ type: 'agent.register', agent });
}

/** agent.session.started — emitted when a new session begins. */
export function makeSessionStarted(params: {
  sessionId: string;
  scope: string;
  parentSessionId?: string;
}): ParaEvent {
  return build({ type: 'agent.session.started', ...params });
}

/** agent.session.reset — emitted on /clear, /reset, or compact-triggered reset. */
export function makeSessionReset(params: {
  sessionId: string;
  reason: 'new' | 'reset' | 'clear' | 'compact';
}): ParaEvent {
  return build({ type: 'agent.session.reset', ...params });
}

/** agent.session.ended — emitted when the session terminates. */
export function makeSessionEnded(params: {
  sessionId: string;
  reason: 'stop' | 'crash' | 'quota' | 'logout' | 'other';
}): ParaEvent {
  return build({ type: 'agent.session.ended', ...params });
}

/** agent.state — emitted whenever the agent transitions between idle/thinking/tool/etc. */
export function makeAgentState(
  status: 'idle' | 'thinking' | 'tool' | 'awaiting_approval' | 'error',
): ParaEvent {
  return build({ type: 'agent.state', status });
}

// ─── Turn / LLM family ────────────────────────────────────────────────────

/** agent.prompt.submit — emitted when a user/remote/subagent prompt enters the turn. */
export function makePromptSubmit(params: {
  sessionId: string;
  prompt: string;
  source: 'user' | 'remote' | 'subagent';
}): ParaEvent {
  return build({ type: 'agent.prompt.submit', ...params });
}

/** agent.llm.pre — emitted just before sending a request to the LLM. */
export function makeLlmPre(params: {
  sessionId: string;
  model: string;
  conversationLength: number;
  isFirstTurn: boolean;
}): ParaEvent {
  return build({ type: 'agent.llm.pre', ...params });
}

/** agent.llm.post — emitted after the LLM responds. */
export function makeLlmPost(params: {
  sessionId: string;
  tokensUsed: number;
  stopReason: string;
}): ParaEvent {
  return build({ type: 'agent.llm.post', ...params });
}

/** agent.turn.step — emitted after each tool call in a turn. */
export function makeTurnStep(params: {
  sessionId: string;
  iteration: number;
  toolNames: string[];
}): ParaEvent {
  return build({ type: 'agent.turn.step', ...params });
}

/** agent.turn.end — emitted when the agent finishes a full turn. */
export function makeTurnEnd(params: {
  sessionId: string;
  lastAssistantMessage?: string;
}): ParaEvent {
  return build({ type: 'agent.turn.end', ...params });
}

/** agent.turn.failure — emitted when a turn fails with a typed error. */
export function makeTurnFailure(params: {
  sessionId: string;
  errorType: 'rate_limit' | 'auth' | 'billing' | 'invalid' | 'server' | 'max_tokens' | 'unknown';
  errorMessage: string;
}): ParaEvent {
  return build({ type: 'agent.turn.failure', ...params });
}

// ─── Tool family ──────────────────────────────────────────────────────────

/** agent.tool.pre — emitted before a tool is executed. */
export function makeToolPre(params: {
  callId: string;
  tool: string;
  args: unknown;
  riskTag?: 'low' | 'mid' | 'high';
}): ParaEvent {
  return build({ type: 'agent.tool.pre', ...params });
}

/** agent.tool.post — emitted after a tool completes successfully. */
export function makeToolPost(params: {
  callId: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  updatedMCPToolOutput?: unknown;
}): ParaEvent {
  return build({ type: 'agent.tool.post', ...params });
}

/** agent.tool.failure — emitted when a tool invocation fails or is interrupted. */
export function makeToolFailure(params: {
  callId: string;
  error: string;
  signalPattern?: string;
  isInterrupt?: boolean;
}): ParaEvent {
  return build({ type: 'agent.tool.failure', ...params });
}

// ─── Permission family ────────────────────────────────────────────────────

/** agent.approval.request — emitted when the agent needs user/remote approval. */
export function makeApprovalRequest(params: {
  callId: string;
  prompt: string;
  ttlMs: number;
  permissionSuggestions?: unknown[];
}): ParaEvent {
  return build({ type: 'agent.approval.request', ...params });
}

/** agent.approval.result — emitted after an approval decision is received. */
export function makeApprovalResult(params: {
  callId: string;
  decision: 'allow' | 'deny' | 'ask' | 'defer';
  by: 'local' | 'remote';
  updatedInput?: unknown;
  updatedPermissions?: unknown[];
}): ParaEvent {
  return build({ type: 'agent.approval.result', ...params });
}

// ─── Task family ──────────────────────────────────────────────────────────

/** agent.task.created — emitted when the agent creates a task in the IM system. */
export function makeTaskCreated(params: {
  taskId: string;
  subject: string;
  description?: string;
  teammateName?: string;
  teamName?: string;
}): ParaEvent {
  return build({ type: 'agent.task.created', ...params });
}

/** agent.task.completed — emitted when a task finishes. */
export function makeTaskCompleted(params: {
  taskId: string;
  subject: string;
  status: 'completed' | 'failed' | 'cancelled';
}): ParaEvent {
  return build({ type: 'agent.task.completed', ...params });
}

// ─── Memory / Compact family ──────────────────────────────────────────────

/** agent.compact.pre — emitted before context compaction. */
export function makeCompactPre(params: {
  sessionId: string;
  trigger: 'manual' | 'auto';
  messageCount: number;
  tokenCount: number;
}): ParaEvent {
  return build({ type: 'agent.compact.pre', ...params });
}

/** agent.compact.post — emitted after context compaction completes. */
export function makeCompactPost(params: {
  sessionId: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}): ParaEvent {
  return build({ type: 'agent.compact.post', ...params });
}

/** agent.bootstrap.injected — emitted when bootstrap files are injected into context. */
export function makeBootstrapInjected(params: {
  bootstrapFiles: string[];
  agentId: string;
}): ParaEvent {
  return build({ type: 'agent.bootstrap.injected', ...params });
}

// ─── Skill family ─────────────────────────────────────────────────────────

/** agent.skill.activated — emitted when a skill is invoked/matched. */
export function makeSkillActivated(params: {
  skillName: string;
  source: SkillSource;
  trigger: 'user-invoke' | 'model-invoke' | 'auto-match';
  args?: string;
}): ParaEvent {
  return build({ type: 'agent.skill.activated', ...params });
}

/** agent.skill.deactivated — emitted when a skill is dropped (compaction, session-end, explicit). */
export function makeSkillDeactivated(params: {
  skillName: string;
  reason: 'compaction-drop' | 'session-end' | 'explicit';
}): ParaEvent {
  return build({ type: 'agent.skill.deactivated', ...params });
}

/** agent.skill.proposed — emitted when agent creates a skill draft (e.g., via skill_manage tool). */
export function makeSkillProposed(params: {
  draftPath: string;
  name: string;
  description: string;
  author: 'agent' | 'user';
}): ParaEvent {
  return build({ type: 'agent.skill.proposed', ...params });
}

/** agent.skill.installed — emitted when a skill is installed from a registry. */
export function makeSkillInstalled(params: {
  skillName: string;
  source: SkillSource;
  version?: string;
  sha256: string;
}): ParaEvent {
  return build({ type: 'agent.skill.installed', ...params });
}

/** agent.skill.uninstalled — emitted when a skill is removed. */
export function makeSkillUninstalled(params: {
  skillName: string;
}): ParaEvent {
  return build({ type: 'agent.skill.uninstalled', ...params });
}

// ─── Message I/O family ──────────────────────────────────────────

/** agent.message — emitted for every message (user/agent/system) in conversation. */
export function makeAgentMessage(params: {
  role: 'user' | 'agent' | 'system';
  content: string;
  ts: number;
}): ParaEvent {
  return build({ type: 'agent.message', ...params });
}

/** agent.channel.inbound — emitted when a message arrives from external channel (Telegram, Discord, etc.). */
export function makeChannelInbound(params: {
  from: string;
  content: string;
  channelId: string;
  metadata?: Record<string, unknown>;
}): ParaEvent {
  return build({ type: 'agent.channel.inbound', ...params });
}

/** agent.channel.outbound.sent — emitted after sending to external channel. */
export function makeChannelOutboundSent(params: {
  to: string;
  content: string;
  channelId: string;
  success: boolean;
}): ParaEvent {
  return build({ type: 'agent.channel.outbound.sent', ...params });
}

/** agent.channel.transcribed — emitted after audio transcription completes. */
export function makeChannelTranscribed(params: {
  transcript: string;
  from: string;
  channelId: string;
  mediaPath?: string;
}): ParaEvent {
  return build({ type: 'agent.channel.transcribed', ...params });
}

/** agent.channel.preprocessed — emitted after media/enrichment preprocessing. */
export function makeChannelPreprocessed(params: {
  bodyForAgent: string;
  from: string;
  channelId: string;
}): ParaEvent {
  return build({ type: 'agent.channel.preprocessed', ...params });
}

// ─── Environment family ───────────────────────────────────────────────────

/** agent.fs.op — emitted for file system operations (read/write/delete/etc). */
export function makeFsOp(params: {
  sessionId: string;
  operation: 'read' | 'write' | 'delete' | 'create' | 'rename' | 'move';
  path: string;
  success: boolean;
  error?: string;
}): ParaEvent {
  return build({ type: 'agent.fs.op', ...params });
}

/** agent.file.watched — emitted when a watched file is modified. */
export function makeFileWatched(params: {
  sessionId: string;
  path: string;
  event: 'created' | 'modified' | 'deleted';
}): ParaEvent {
  return build({ type: 'agent.file.watched', ...params });
}

/** agent.cwd.changed — emitted when current working directory changes. */
export function makeCwdChanged(params: {
  sessionId: string;
  oldCwd: string;
  newCwd: string;
}): ParaEvent {
  return build({ type: 'agent.cwd.changed', ...params });
}

/** agent.config.changed — emitted when configuration is modified. */
export function makeConfigChanged(params: {
  sessionId: string;
  configPath: string;
  keysChanged: string[];
}): ParaEvent {
  return build({ type: 'agent.config.changed', ...params });
}

/** agent.worktree.created — emitted when a git worktree is created. */
export function makeWorktreeCreated(params: {
  sessionId: string;
  worktreePath: string;
  baseBranch: string;
}): ParaEvent {
  return build({ type: 'agent.worktree.created', ...params });
}

/** agent.worktree.removed — emitted when a git worktree is removed. */
export function makeWorktreeRemoved(params: {
  sessionId: string;
  worktreePath: string;
}): ParaEvent {
  return build({ type: 'agent.worktree.removed', ...params });
}
