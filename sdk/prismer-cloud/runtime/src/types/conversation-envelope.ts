// MIRROR of `src/im/types/conversation-envelope.ts` (cloud-side source of truth).
//
// `@prismer/runtime` is a standalone npm package and is NOT in the main
// tsconfig (CLAUDE.md layer rule: runtime is independent, never imports
// `src/`). The cloud-side `ConversationMemoryService.buildEnvelope` produces
// this structure and the dispatcher threads it through
// `metadata.contextEnvelope`; the daemon reads it here and each adapter's
// `renderContextEnvelope` translates it into its native history shape.
//
// KEEP IN SYNC. When the cloud-side type in src/im/types/conversation-envelope.ts
// changes, this mirror MUST be updated in lockstep (same manual-sync banner
// convention as src/types/im-events.ts).
//
// Source of truth chain:
//   src/im/types/conversation-envelope.ts  ─▶  this file
//
// Design decisions pinned in docs/release201/26 §3 / §5 / §6:
//   - L2 Phase 1 only emits Range segments (no Topic/Decision/Entity kind yet)
//   - Quote refs always point at the raw `messageId` (decision C)
//   - Envelope is built cloud-side (decision E) for central observability / A/B
//   - Token counts / budgets are all in `cl100k` (tiktoken) units (§6)

import type { AssetRef } from './im-events.js';

/**
 * Sender / participant role within a conversation. Mirrors
 * `TaskDispatchContextEntry['senderRole']` on the cloud side.
 */
export type EnvelopeRole = 'human' | 'agent' | 'admin' | 'system';

/** Active participant of the conversation. */
export interface ParticipantRef {
  imUserId: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string | null;
}

/**
 * One raw L1 message in the `recent` tail. Visibility-filtered per
 * docs/release201/26 §5.1 (lifecycle / system events are stripped cloud-side).
 */
export interface EnvelopeRecentEntry {
  messageId: string;
  role: EnvelopeRole;
  sender: string;
  content: string;
  createdAt: string;
  /** Asset IDs attached to this message; bytes are never inlined here. */
  assetRefs?: AssetRef[];
}

/** Structured salient facts extracted by the L2 producer (all optional). */
export interface EnvelopeSalientFacts {
  topicHeadlines?: string[];
  decisions?: string[];
  openQuestions?: string[];
  entitiesMentioned?: string[];
  userPreferences?: string[];
  agentCommitments?: string[];
  discardedDirections?: string[];
  /** metric-only: count of `task.*` lifecycle events covered by this segment. */
  taskEventCount?: number;
  /** metric-only: count of `awaiting_human_approval` events covered. */
  approvalCount?: number;
}

/** A compressed L2 Range segment (Phase 1's only `segmentKind`). */
export interface EnvelopeSegment {
  segmentSeq: number;
  coversFromAt: string;
  coversToAt: string;
  summary: string;
  salientFacts: EnvelopeSalientFacts;
  sourceCount: number;
  tokenCountCl100k: number;
}

/**
 * Quote snapshot. Decision C: the ref always points at the raw `messageId`;
 * the snapshot survives source deletion via `sourceDeletedAt`.
 */
export interface EnvelopeQuote {
  quotedMessageId: string;
  snippet: string;
  quotedSender: string;
  quotedAt: string;
  /** Set when the quoted raw message has since been deleted. */
  sourceDeletedAt?: string;
  /**
   * release201/26 §13.4a P2 — image assets on the quoted (older) message,
   * re-attached by the cloud (with `cdnUrl`) so the adapter can re-inject them
   * as image parts in the current turn. Cross-turn vision is blind on stateful
   * upstreams (Hermes stores prior images as `[screenshot]` placeholders), so
   * a text snippet / url-in-text is not enough — the agent must receive the
   * image input again. Reuses the wire `AssetRef` shape.
   */
  imageAssetRefs?: AssetRef[];
}

/** Resolved identifier (entity name → canonical id). Phase 3 only. */
export interface EnvelopeIdentifier {
  kind: string;
  canonicalId: string;
  displayLabel: string;
  lastSeenAt: string;
}

/** Recent task execution trace. Phase 3 only. */
export interface EnvelopeRecentTaskTrace {
  taskId: string;
  toolsUsed: string[];
  outputs: string[];
  decisions: string[];
}

/** Per-category token floors (cl100k). */
export interface EnvelopeBudgetFloors {
  recent: number;
  compressedSegments: number;
  quotes: number;
  identifierIndex: number;
  recentTaskTrace: number;
}

export interface EnvelopeBudget {
  /** Total budget in cl100k tokens (Phase 1 default 8000, §6). */
  totalTokens: number;
  floors: EnvelopeBudgetFloors;
}

/**
 * Asset partition (decision D). `inputs` participate in the agent's context
 * (image-as-input / file-as-input); `archives` are described only and do not
 * consume vision tokens.
 */
export interface EnvelopeAssets {
  inputs: AssetRef[];
  archives: AssetRef[];
}

/**
 * Conversation context envelope — the L3 input contract (cloud → daemon).
 * See docs/release201/26 §5.
 */
export interface ConversationContextEnvelope {
  envelopeVersion: 1;
  conversationId: string;
  conversationType: 'direct' | 'group';
  participants: ParticipantRef[];

  /** L1 raw tail, oldest first. Visibility-filtered per §5.1. */
  recent: EnvelopeRecentEntry[];

  /** L2 Range segments (Phase 1's only kind). */
  compressedSegments: EnvelopeSegment[];

  /** Quote snapshots; ref always points at the raw messageId (decision C). */
  quotes: EnvelopeQuote[];

  /** Phase 3 only — undefined in Phase 1. */
  identifierIndex?: EnvelopeIdentifier[];

  /** Phase 3 only — undefined in Phase 1. */
  recentTaskTrace?: EnvelopeRecentTaskTrace;

  assets: EnvelopeAssets;

  budget: EnvelopeBudget;
}
