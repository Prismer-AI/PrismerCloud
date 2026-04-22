/**
 * @prismer/wire — Timeline / seq / epoch data structures
 *
 * Reference: docs/version190/07-remote-control.md §5.6.5 (append-only timeline
 * + seq backfill). The daemon keeps a SQLite-backed append-only log keyed by a
 * monotonic `seq`; clients replay missing entries when reconnecting.
 *
 * Note on seq: the spec uses int64 on the wire, but JSON has no bigint. We use
 * z.number().int() here — callers should treat seq as a 53-bit safe integer
 * (which is fine for ~2^53 events, far beyond any realistic daemon lifetime).
 */

import { z } from 'zod';

// ─── Timeline entry ───────────────────────────────────────────────────────

/** A single entry in the daemon's append-only timeline. */
export const TimelineEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(), // epoch ms
  kind: z.string().min(1), // e.g. 'agent.tool.post', 'approval.request'
  payload: z.unknown(), // opaque — event-kind-specific, validated elsewhere
  epoch: z.number().int().nonnegative().optional(), // bumps on daemon restart
});

export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

// ─── Backfill request / response ──────────────────────────────────────────

/** Client → daemon: "last seen seq=N, send everything after." */
export const BackfillRequestSchema = z.object({
  since: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(10000).optional(),
});

export type BackfillRequest = z.infer<typeof BackfillRequestSchema>;

/** Daemon → client: a window of timeline entries + pagination hint. */
export const BackfillResponseSchema = z.object({
  entries: z.array(TimelineEntrySchema),
  hasMore: z.boolean(),
  nextSeq: z.number().int().nonnegative().optional(),
});

export type BackfillResponse = z.infer<typeof BackfillResponseSchema>;

// ─── Per-message acknowledgement ──────────────────────────────────────────

/** Client → daemon: ack that seq=N has been delivered/rendered. */
export const SeqAckSchema = z.object({
  seq: z.number().int().nonnegative(),
});

export type SeqAck = z.infer<typeof SeqAckSchema>;

// ─── Epoch marker (daemon restart) ────────────────────────────────────────

/**
 * Epoch marker — daemon increments its epoch on every process restart so
 * clients can detect state loss and force a full resync.
 */
export const EpochMarkerSchema = z.object({
  epoch: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(), // epoch ms
  daemonId: z.string().min(1),
});

export type EpochMarker = z.infer<typeof EpochMarkerSchema>;
