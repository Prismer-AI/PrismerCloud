/**
 * Prismer IM — Conversation Context Envelope (L3 input contract)
 *
 * release201/26 Phase 1. The cloud-side `ConversationMemoryService.buildEnvelope`
 * produces this structure and the dispatcher threads it through
 * `metadata.contextEnvelope`; each adapter implements `renderContextEnvelope`
 * to translate it into its native history shape.
 *
 * Design decisions pinned in docs/release201/26 §3 / §5 / §6:
 *   - L2 Phase 1 only emits Range segments (no Topic/Decision/Entity kind yet)
 *   - Quote refs always point at the raw `messageId` (decision C)
 *   - Envelope is built cloud-side (decision E) for central observability / A/B
 *   - Token counts / budgets are all in `cl100k` (tiktoken) units (§6)
 *
 * Reuses existing wire types from `./im-events`:
 *   - `AssetRef` for input/archive asset descriptors
 *   - `TaskDispatchContextEntry['senderRole']` for the message role union
 */

import type { AssetRef, TaskDispatchContextEntry } from './im-events';

/**
 * Sender / participant role within a conversation. Reuses the same union the
 * dispatch context entry already pins so envelope and `metadata.context` stay
 * in lockstep.
 */
export type EnvelopeRole = TaskDispatchContextEntry['senderRole'];

/**
 * Active participant of the conversation. Mirrors the inline `participants[]`
 * shape on `TaskDispatchRequestPayload` so the daemon can inject the
 * authoritative recipient list without an extra `prismer.conversation.listAgents`
 * round-trip.
 */
export interface ParticipantRef {
  imUserId: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string | null;
}

/**
 * One raw L1 message in the `recent` tail. Visibility-filtered per
 * docs/release201/26 §5.1 (lifecycle / system events are stripped here).
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

/**
 * Structured salient facts extracted by the L2 producer.
 *
 * Shape per docs/release201/25 §5.3 + docs/release201/26 §5.1 ("metric-only"
 * lifecycle accounting). Every field is optional — the producer fills what it
 * can and the dispatcher tolerates absence.
 */
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

/**
 * A compressed L2 Range segment (Phase 1's only `segmentKind`). Covers a
 * contiguous range of older raw messages that no longer fit in `recent`.
 */
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
   * release201/26 §13.4a P2 — image assets attached to the quoted (older)
   * message. Cross-turn vision is BLIND on stateful upstreams: Hermes stores
   * prior images as `[screenshot]` placeholders, so an agent quoting an old
   * image cannot re-perceive it from history. When the quoted message carried
   * image assets, the cloud re-attaches their AssetRefs (with `cdnUrl`) here so
   * `renderContextEnvelope` can re-inject them as image parts in the CURRENT
   * turn — the text snippet alone (or a url in text) is not enough; the agent
   * must receive the bytes/url as a real image input again. Reuses the wire
   * `AssetRef` shape; bytes are never inlined here.
   */
  imageAssetRefs?: AssetRef[];
}

/**
 * Resolved identifier (entity name → canonical id). Phase 3 only — Phase 1
 * leaves `identifierIndex` undefined.
 */
// Phase 3
export interface EnvelopeIdentifier {
  kind: string;
  canonicalId: string;
  displayLabel: string;
  lastSeenAt: string;
}

/**
 * Recent task execution trace. Phase 3 only — Phase 1 leaves
 * `recentTaskTrace` undefined.
 */
// Phase 3
export interface EnvelopeRecentTaskTrace {
  taskId: string;
  toolsUsed: string[];
  outputs: string[];
  decisions: string[];
}

/**
 * Per-category token floors (cl100k). `identifierIndex` / `recentTaskTrace`
 * floors only take effect from Phase 3 (§6).
 */
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
  identifierIndex?: EnvelopeIdentifier[]; // Phase 3

  /** Phase 3 only — undefined in Phase 1. */
  recentTaskTrace?: EnvelopeRecentTaskTrace; // Phase 3

  assets: EnvelopeAssets;

  budget: EnvelopeBudget;
}
