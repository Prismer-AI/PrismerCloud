// doc 18 §C4 — outbox event envelope (discriminated union on `eventType`).
//
// FROZEN per doc 18 §C4: any change requires a schemaVersion bump + per-device
// migration plan. The local daemon's memory_outbox rows are durable on disk;
// changing the shape after rows exist either needs migration or loses data.
//
// Three event families share this outbox channel + cursor + dead-letter sink:
//
//   1. memory.*           — locked here (phase-0 of Line C)
//   2. recall_* / access_denied — Line C observability (locked here)
//   3. asset.* / ingest.* / knowledge-link.* — doc 19 owner extends; cloud
//      routes on eventType prefix and doc 19 owns the per-eventType bodies.
//      Daemon SHOULD NOT add ingest-family schemas here — that creates
//      ownership drift. doc 19 owner adds them in a sibling envelope file
//      and merges into the outbox via a runtime registry.
//
// Validation runs on BOTH ends:
//   - daemon write side (this module): zod.parse before insert; failures land
//     in memory_outbox_dead_letter, never silently dropped.
//   - cloud receive side (Line A A3): same envelope re-validated on inbox.
//
// Per-eventType idempotency-key conventions are documented inline below; the
// daemon outbox writer (outbox.ts) computes the key and uses it as a UNIQUE
// constraint to make retries safe.

import { z } from 'zod';

const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}T/, 'must be ISO 8601');

export const MemoryEventCommon = z.object({
  eventId: z.string().min(1),
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  actorImUserId: z.string().min(1),
  actorKind: z.enum(['human', 'agent']),
  deviceId: z.string().min(1),
  createdAt: isoDateString,
  idempotencyKey: z.string().min(1),
});

// ---- memory.page.* ---------------------------------------------------------
// idempotencyKey:
//   upsert: `upsert:<workspaceId>:<pageId>:<parentVersion>:<contentHash>`
//   delete: `delete:<workspaceId>:<pageId>:<parentVersion>`

export const PagePayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), content: z.string() }),
  z.object({ kind: z.literal('blobRef'), uri: z.string().min(1) }),
]);

export const MemoryPageUpsertEvent = MemoryEventCommon.extend({
  eventType: z.literal('memory.page.upsert'),
  pageId: z.string().min(1),
  path: z.string().min(1),
  parentVersion: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  payload: PagePayload,
  aclJson: z.string().optional(),
  visibility: z.string().optional(),
  memoryType: z.string().optional(),
  description: z.string().optional(),
  sourceRefs: z.array(z.string()).optional(),
});

export const MemoryPageDeleteEvent = MemoryEventCommon.extend({
  eventType: z.literal('memory.page.delete'),
  pageId: z.string().min(1),
  parentVersion: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

// ---- memory.link.* ---------------------------------------------------------
// idempotencyKey:
//   upsert: `link-upsert:<workspaceId>:<sha256(sourceUri+targetUri+relation)>`
//   delete: `link-delete:<workspaceId>:<sha256(sourceUri+targetUri+relation)>`

export const MemoryLinkUpsertEvent = MemoryEventCommon.extend({
  eventType: z.literal('memory.link.upsert'),
  sourceUri: z.string().min(1),
  targetUri: z.string().min(1),
  relation: z.string().min(1),
  weight: z.number().optional(),
  extractedFromPageId: z.string().optional(),
});

export const MemoryLinkDeleteEvent = MemoryEventCommon.extend({
  eventType: z.literal('memory.link.delete'),
  sourceUri: z.string().min(1),
  targetUri: z.string().min(1),
  relation: z.string().min(1),
});

// ---- memory.feedback -------------------------------------------------------
// idempotencyKey:
//   `feedback:<workspaceId>:<targetEventId|targetPageId>:<actorImUserId>:<createdAt>`

// memory.feedback: targetEventId XOR targetPageId is required, but the
// constraint is enforced at outbox.enqueue() time (runtime) rather than via
// zod.refine() because refine returns ZodEffects which is not a valid
// member of a discriminatedUnion. Keeping the schema as a plain ZodObject
// preserves the union shape; outbox writer rejects the row to dead-letter
// when both fields are missing.
export const MemoryFeedbackEvent = MemoryEventCommon.extend({
  eventType: z.literal('memory.feedback'),
  targetEventId: z.string().optional(),
  targetPageId: z.string().optional(),
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  reason: z.string().optional(),
  query: z.string().optional(),
});

// ---- memory.proposal — M-C session-end extract (doc 25 §3 支柱 3) ----------
// Fork-LLM-extracted memory proposal from the host's `on_session_end`. The
// daemon outbox carries it to the cloud, where it is routed to
// `im_memory_proposals` for the user to review in the Library Memory view.
// idempotencyKey: `proposal:<sessionId>:<pagePath>:<eventId-prefix>` —
// stable enough that outbox replays dedupe; loose enough that two
// proposals for the same path in different sessions both reach the cloud.
export const MemoryProposalEvent = MemoryEventCommon.extend({
  eventType: z.literal('memory.proposal'),
  sessionId: z.string().min(1),
  pagePath: z.string().min(1),
  baseVersion: z.number().int().nonnegative(),
  operation: z.enum(['create', 'replace', 'delete']),
  contentDiff: z.string(),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(z.string()).optional(),
});

/**
 * Runtime check matching the constraint that cannot be expressed in the
 * discriminated union schema. Outbox writer calls this before persistence;
 * failures route to memory_outbox_dead_letter.
 */
export function validateFeedbackTarget(
  e: { targetEventId?: string; targetPageId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (e.targetEventId || e.targetPageId) return { ok: true };
  return { ok: false, reason: 'memory.feedback requires either targetEventId or targetPageId' };
}

// ---- observability family (Line C plan §C3-C5, doc 23 §9.5 row 9) ----------
// Same outbox channel; cloud routes them to im_memory_observability_events
// rather than the page mirror. idempotencyKey:
//   `obs:<eventType>:<actorImUserId>:<createdAt>:<eventId>` — last segment
//   ensures uniqueness even when actor emits multiple events at the same ms.

const ObservabilityCommon = MemoryEventCommon.extend({
  pageId: z.string().optional(),
  query: z.string().optional(),
  metadataJson: z.record(z.unknown()).optional(),
  metricsJson: z.record(z.unknown()).optional(),
});

export const RecallPreloadEvent = ObservabilityCommon.extend({
  eventType: z.literal('recall_preload'),
});
export const RecallInjectEvent = ObservabilityCommon.extend({
  eventType: z.literal('recall_inject'),
});
export const RecallPullEvent = ObservabilityCommon.extend({
  eventType: z.literal('recall_pull'),
});
export const RecallRejectEvent = ObservabilityCommon.extend({
  eventType: z.literal('recall_reject'),
});
export const AccessDeniedEvent = ObservabilityCommon.extend({
  eventType: z.literal('access_denied'),
});
// M-B (doc 25 §3 支柱 2): one event per fork-driven recall. Joins the
// existing observability stream so the cloud-side dashboard counts
// fork frequency / duration / cache-hit-rate per `metadataJson.forkLabel`.
export const RecallForkEvent = ObservabilityCommon.extend({
  eventType: z.literal('recall_fork'),
});

// Phase-0 supported union. Phase-1 doc 19 owner extends with asset.* /
// ingest.* / knowledge-link.* via a separate registered union; daemon's
// outbox writer composes both unions at runtime.
export const MemoryOutboxEnvelope = z.discriminatedUnion('eventType', [
  MemoryPageUpsertEvent,
  MemoryPageDeleteEvent,
  MemoryLinkUpsertEvent,
  MemoryLinkDeleteEvent,
  MemoryFeedbackEvent,
  RecallPreloadEvent,
  RecallInjectEvent,
  RecallPullEvent,
  RecallRejectEvent,
  AccessDeniedEvent,
  RecallForkEvent,
  MemoryProposalEvent,
]);

export type MemoryOutboxEnvelopeT = z.infer<typeof MemoryOutboxEnvelope>;
export type MemoryOutboxEventType = MemoryOutboxEnvelopeT['eventType'];

// Convenience: classify an eventType into its routing family. Cloud receive
// side switches on this same prefix (single switch on `eventType` per doc 18).
export function eventFamily(eventType: string): 'memory' | 'observability' | 'unknown' {
  // memory.proposal is an outbox event with a 'memory.' prefix but it
  // routes to im_memory_proposals, not the page/link mirror. The
  // daemon family classifier returns 'memory' for it; the cloud-side
  // `eventFamily` (memory-event-family.ts) further splits memory.* into
  // {page, link, proposal} branches.
  if (eventType.startsWith('memory.')) return 'memory';
  if (
    eventType === 'recall_preload' ||
    eventType === 'recall_inject' ||
    eventType === 'recall_pull' ||
    eventType === 'recall_reject' ||
    eventType === 'access_denied' ||
    eventType === 'recall_fork'
  ) {
    return 'observability';
  }
  return 'unknown';
}
