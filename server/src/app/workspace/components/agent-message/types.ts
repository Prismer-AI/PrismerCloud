/**
 * Unified Agent Message — shared type contract (release201/32 P0).
 *
 * SoT design: docs/release201/32-unified-agent-message-component.md
 * HTML reference: docs/release201/proto/agent-message.html
 *
 * One <AgentMessage> superset renders an agent's full lifecycle (process
 * stream + reply); a human message is the trimmed subset. P0 is presentational
 * + mock-driven (mock-first, like Evolution Studio v2) — NOT yet wired into
 * im-channel.tsx. Field names mirror the real wire shapes so P1 wiring is a
 * straight adapter:
 *   - ActivityStep  ⇐ ActivityTimelineStep.payloadJson  (sync-api.ts:78)
 *   - MessageAsset  ⇐ AssetAttachment                   (im/types/index.ts:88)
 *   - reasoning/body ⇐ ContentBlock[]                   (content-blocks/types.ts)
 *
 * These declarations are the cross-component contract. StatusCard,
 * ActivityDetail and AgentMessage are all built against THIS file — do not
 * diverge field names per-component.
 */

import type { ContentBlock } from '../content-blocks/types';

// ─── Lifecycle state machine ─────────────────────────────────────────
// Drives which slots render + glow color + card variant. See doc 32 §4.
export type AgentMessageState =
  | 'received'      // dispatched, daemon ack'd, nothing produced yet
  | 'running'       // tool/reasoning stream in flight
  | 'needs-action'  // awaiting human approval (sticky, amber)
  | 'failed'        // execution aborted (rose)
  | 'done';         // reply landed (emerald, glow off)

export type AgentRole = string; // 'ENGINEER' | 'MARKETER' | 'OPS' | ...

// ─── Decoded activity step (from ActivityTimelineStep.payloadJson) ────
export type ActivityStepKind = 'tool' | 'reasoning';
export type ToolEvent = 'tool.started' | 'tool.completed';

/**
 * One row in the event timeline. `kind:'tool'` rows pair started→completed
 * and morph in place (the same row settles); `kind:'reasoning'` rows carry
 * thinking text. Fields decoded from the opaque `payloadJson`.
 */
export interface ActivityStep {
  id: string;
  seq: number;            // per-run monotonic (daemon-allocated)
  kind: ActivityStepKind;
  /** tool rows only — drives the started(in-flight) → completed(settle) animation */
  event?: ToolEvent;
  /**
   * Stable pairing key for started↔completed merge. Daemon emits the same
   * toolCallId on both the `tool.started` and `tool.completed` event of one
   * call (payload `toolCallId` / `tool_call_id`). The timeline pairs on THIS,
   * not on `tool` name — completed events frequently arrive with no tool name
   * (generic `tool_result` kind), so name-pairing produced duplicate rows.
   */
  toolCallId?: string;
  /** tool rows — 'terminal' | 'search_files' | 'browser_navigate' | 'write_file' | ... */
  tool?: string;
  /** 0..100, daemon-reported (NOT a step ratio) */
  progress?: number;
  /** responsible daemon id, e.g. 'hrrk36v4v9' */
  actor?: string;
  /** short headline extracted from args/result, e.g. 'README*' / 'https://prismer.cloud' */
  summary?: string;
  /** reasoning rows only */
  reasoningText?: string;
  /**
   * phase_change rows only — localized phase label (思考中 / 调用工具 / 响应中…).
   * Rendered as a muted timeline divider so running messages keep execution
   * visibility without the mislabeled empty "Reasoning" rows. kind stays
   * 'reasoning' (no schema churn); presence of `phase` (and absence of
   * reasoningText) marks it a phase divider.
   */
  phase?: string;
  /** raw payload for the ▶ payload disclosure */
  payloadJson?: unknown;
  occurredAt: string;     // ISO
  durationMs?: number | null;
}

// ─── Attachment (mirror of AssetAttachment / MessageAssetCard's MessageAsset) ──
export interface MessageAsset {
  id: string;
  mime?: string | null;
  sizeBytes?: number | null;
  filename?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
}

// ─── Linked task (kanban) ────────────────────────────────────────────
export type TaskStatusKey =
  | 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'completed' | 'failed' | 'cancelled';

export interface LinkedTask {
  id: string;
  title: string;
  status: TaskStatusKey;
}

// ─── Live execution metrics (status-card row 1) ──────────────────────
export interface RunMetrics {
  steps: number;
  tokens: number;     // run-level aggregate (P4 backend; P0 mock)
  elapsedMs: number;
  files: number;
}

/** Glow phase → dual-color breathing backlight (doc 32 §3.3). */
export type GlowPhase = 'thinking' | 'action' | 'off';

// ─── Sender identity ─────────────────────────────────────────────────
export interface MessageSender {
  id: string;
  name: string;
  role?: AgentRole;
  isAgent: boolean;
  /** seed for avatarGradient()/avatarInitials() from design.ts */
  avatarSeed: string;
  avatarEmoji?: string;
  /**
   * ASCII username (ceo/engineer/marketer) — the RELIABLE role-icon source for
   * the shared AgentAvatar (agentType is a generic tier; localized names never
   * match). Threaded from page.tsx's usernameByImUserId map.
   */
  username?: string | null;
  /** Uploaded/custom avatar image — rendered over the gradient + role icon. */
  avatarUrl?: string | null;
}

// ─── The full message model ──────────────────────────────────────────
export interface AgentMessageModel {
  id: string;
  sender: MessageSender;
  /** 'human' sender renders the trimmed subset (no status card / activity / metrics) */
  state: AgentMessageState | 'human';
  createdAt: string;

  // body (final reply markdown) — empty/streaming until done
  body: string;
  /**
   * v2.0 §4.6 multimodal payload. When populated, the reply renders via the
   * shared <MessageContentBlocks> (text + image + audio + video + file +
   * tool_use + reasoning) instead of plain markdown — feature parity with
   * im-channel's MessageBubbleBody. Decoded from message.contentBlocks(Json).
   */
  contentBlocks?: ContentBlock[] | null;
  attachments: MessageAsset[];

  // process stream
  reasoning?: string;            // thinking text (streamed; clamp 3 lines when persisted)
  steps: ActivityStep[];         // event timeline
  metrics: RunMetrics;
  task?: LinkedTask;

  // status-card headline (current action) — for running/needs-action/failed
  current?: {
    /** semantic kind drives phase label + glow color (NOT an emoji string). */
    kind: 'reasoning' | 'tool';
    /** tool slug for icon lookup (toolGlyph); reasoning rows leave undefined. */
    tool?: string;
    title: string;
    summary?: string;
  };

  // @mention targets highlighted in body + header chain (group chat)
  mentions?: string[];
  /** sequential @-mention responsibility chain, e.g. ['CEO','engineer'] (hopCount) */
  mentionChain?: string[];
}

// ─── Component prop contracts (the fan-out boundary) ─────────────────

export interface StatusCardProps {
  state: AgentMessageState;
  /** phase label, e.g. '思考中' | '调用工具' | '完成' | '等待确认' | '执行失败' */
  phaseLabel: string;
  /** deterministic dual-color breathing backlight driver (preferred over sniffing phaseLabel) */
  glowPhase?: GlowPhase;
  current?: AgentMessageModel['current'];
  metrics: RunMetrics;
  /** detail panel open? (card is the toggle) */
  expanded: boolean;
  onToggle: () => void;
  /** needs-action handlers */
  onApprove?: () => void;
  onReject?: () => void;
  /** failed handlers */
  onRetry?: () => void;
  onViewLog?: () => void;
  isDark?: boolean;
}

export interface ActivityDetailProps {
  reasoning?: string;
  /** while true, reasoning streams + tool rows show in-flight visuals */
  live: boolean;
  steps: ActivityStep[];
  task?: LinkedTask;
  onOpenTask?: (task: LinkedTask) => void;
  isDark?: boolean;
}

export interface AgentMessageProps {
  model: AgentMessageModel;
  isDark?: boolean;
  onCopy?: () => void;
  onForward?: () => void;
  onSaveToMemory?: () => void;
  onQuote?: () => void;
  onOpenAsset?: (asset: MessageAsset) => void;
  onOpenTask?: (task: LinkedTask) => void;
  onApprove?: () => void;
  onReject?: () => void;
  onRetry?: () => void;
  /** scroll container ref for the floating jump anchor (live message scrolled out of view) */
  scrollContainer?: React.RefObject<HTMLElement | null>;
  /**
   * Slot rendered inside the reply bubble, below the body. im-channel injects
   * <MessagePrismerLinks> here (extractPrismerChatLinks is not exported), so
   * agent replies keep clickable prismer:// resource/task links at parity with
   * the legacy MessageRow path.
   */
  bodyExtras?: React.ReactNode;
}
