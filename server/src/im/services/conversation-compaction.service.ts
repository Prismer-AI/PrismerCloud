/**
 * Prismer IM — Conversation Compaction Service (release201/26 Phase 2)
 *
 * L2 Range-segment *producer*. Phase 1 only READ compressed segments (the
 * `ConversationMemoryService.buildEnvelope` path); this service actually
 * PRODUCES them so the envelope's `compressedSegments` stops being empty.
 *
 * Ground truth: docs/release201/26-conversational-memory-plan.md
 *   - §8 Phase 2     — three triggers (hard / char-budget / idle) + initial values
 *   - §5             — IMConversationCompressedSegment field contract
 *   - §5.1           — message type → visibility (only L2-covered types fed to LLM;
 *                      task.* / approval are metric-only → salientFacts counts)
 *   - §9             — observability metric names (exact)
 *   - §10            — failure modes (producer失败 → extractive fallback, NEVER block dispatch)
 *
 * Design invariants (do not regress):
 *   - The trigger check is wired fire-and-forget at the tail of
 *     message.service.ts `send()` (mirrors the webhook dispatch at :507) and the
 *     server.ts sweep — it MUST NOT block dispatch or message send.
 *   - LLM access reuses the OpenAI-compatible `callLLM` pattern from
 *     evolution-distill.ts (env-resolved model, retry/backoff). We import that
 *     `callLLM` directly rather than rolling a second client.
 *   - Concurrency safety rides the schema `@@unique([conversationId,
 *     segmentKind, segmentSeq])`: a racing second worker that picks the same
 *     segmentSeq hits P2002 and no-ops.
 */

import crypto from 'crypto';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
import { estimateCl100kTokens } from './conversation-memory.service';
import { callLLM } from './evolution-distill';
import type { EnvelopeSalientFacts } from '../types/conversation-envelope';

const log = createModuleLogger('ConversationCompaction');

// ─── Trigger thresholds (docs/release201/26 §8 — initial values) ──────────────
//
// "上线后第 2 周按真实 conversation 分布回调" — these are intentionally surfaced
// as top-level constants so the recalibration is a one-line diff.
//
// "uncompacted" = raw messages not yet covered by ANY range segment (derived
// from IMConversationRawToSegmentIndex), restricted to the §5.1 L2-visible
// types (text/agent_reply/file/image). task.*/system rows are metric-only.
export const COMPACTION_TRIGGERS = {
  // hard: raw_count > 60 且 oldest_uncompacted > 12h
  hard: {
    minUncompacted: 60,
    oldestUncompactedAgeMs: 12 * 60 * 60 * 1000, // 12h
  },
  // char-budget: sum(uncompacted chars) > 48KB
  charBudget: {
    maxUncompactedChars: 48 * 1024, // 48KB
  },
  // idle (scheduled sweep): silent ≥ 4h 且 ≥ 30 待压
  idle: {
    silentForMs: 4 * 60 * 60 * 1000, // 4h
    minUncompacted: 30,
  },
} as const;

/**
 * Min raw messages that must be coverable before producing a segment at all.
 * Without a floor, a single straggling message would spawn a degenerate
 * 1-source segment. Keep below the idle threshold so idle can still fire.
 */
const MIN_COVERABLE_FOR_PRODUCE = 8;

// ─── §5.1 visibility — types that enter the L2 summary body ───────────────────
//
// Only these get fed to the LLM. task.* lifecycle / approval / system rows are
// "metric-only": they bump salientFacts.taskEventCount / approvalCount and are
// otherwise excluded from the prompt.
const L2_BODY_TYPES = new Set(['text', 'agent_reply', 'markdown', 'code', 'file', 'image', 'artifact']);

// ─── Producer prompt template (hash → producerVersion, §5) ────────────────────
//
// Bumping this template MUST change producerVersion so drift is traceable
// (§10 "Producer 月度漂移"). The hash is sha256(template) truncated.
const PRODUCER_PROMPT_TEMPLATE = `You compress a slice of an instant-messaging conversation into a durable memory segment.

Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{
  "summary": "<concise markdown summary of what happened in this slice, 1-4 short paragraphs>",
  "salientFacts": {
    "topicHeadlines": ["..."],
    "decisions": ["..."],
    "openQuestions": ["..."],
    "entitiesMentioned": ["..."],
    "userPreferences": ["..."],
    "agentCommitments": ["..."],
    "discardedDirections": ["..."]
  }
}

Rules:
- summary is markdown prose; salientFacts arrays are short bullet strings (may be empty arrays).
- Preserve concrete identifiers (names, ids, file paths, decisions) verbatim where they matter.
- Do NOT invent facts not present in the messages.

Conversation slice (oldest first):
`;

function producerVersionHash(): string {
  return crypto
    .createHash('sha256')
    .update(PRODUCER_PROMPT_TEMPLATE)
    .digest('hex')
    .slice(0, 12);
}

/** Env-resolved producer model (mirrors evolution-distill.callLLM resolution). */
function resolveProducerModel(): string {
  return (
    process.env.COMPACTION_MODEL ||
    process.env.DEFAULT_MODEL ||
    process.env.DISTILL_MODEL ||
    'gpt-4o-mini'
  );
}

const EXTRACTIVE_FALLBACK_MODEL = 'extractive-fallback';

// ─── Observability (docs/release201/26 §9 — names are exact) ──────────────────
//
// Mirror conversation-memory.service.ts metric style: structured log lines a
// log-based metric / Phase 2 exporter scrapes by name.
function emitProducedMetric(kind: string, producerVersion: string): void {
  // compressed_segment_produced_total{kind,producer_version}
  log.info(
    { metric: 'compressed_segment_produced_total', kind, producer_version: producerVersion },
    `[ConversationCompaction] compressed_segment_produced_total kind=${kind} producer_version=${producerVersion}`,
  );
}
function emitProducerFailedMetric(kind: string, reason: string): void {
  // compressed_segment_producer_failed_total{kind,reason}
  log.info(
    { metric: 'compressed_segment_producer_failed_total', kind, reason },
    `[ConversationCompaction] compressed_segment_producer_failed_total kind=${kind} reason=${reason}`,
  );
}
function emitProducerDurationMetric(durationMs: number): void {
  // compressed_segment_producer_duration_ms
  log.info(
    { metric: 'compressed_segment_producer_duration_ms', durationMs },
    `[ConversationCompaction] compressed_segment_producer_duration_ms duration_ms=${durationMs}`,
  );
}

interface RawRow {
  id: string;
  senderId: string;
  type: string;
  content: string | null;
  metadata: string | null;
  createdAt: Date;
}

// Prisma model type alias (the generated client's row shape). Kept loose so the
// service compiles against either the SQLite or MySQL generated client.
export type IMConversationCompressedSegment = {
  id: string;
  conversationId: string;
  segmentKind: string;
  segmentSeq: number;
  coversFromMessageId: string;
  coversToMessageId: string;
  coveredRawMessageIdsJson: string;
  coversFromCreatedAt: Date;
  coversToCreatedAt: Date;
  summary: string;
  salientFactsJson: string;
  tokenCountCl100k: number;
  producerModel: string;
  producerVersion: string;
  supersededBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function parseMetaKind(metadata: string | null): string {
  if (!metadata) return '';
  try {
    const m = JSON.parse(metadata) as { kind?: unknown };
    return typeof m.kind === 'string' ? m.kind : '';
  } catch {
    return '';
  }
}

function isMetricOnly(type: string, kind: string): boolean {
  return (
    kind.startsWith('task.') ||
    kind === 'task_status_event' ||
    kind === 'awaiting_human_approval' ||
    type === 'system' ||
    type === 'system_event'
  );
}

function isApprovalEvent(type: string, kind: string): boolean {
  return kind === 'awaiting_human_approval';
}

function isTaskEvent(type: string, kind: string): boolean {
  return kind.startsWith('task.') || kind === 'task_status_event';
}

function isL2Body(type: string, kind: string): boolean {
  if (kind === 'agent_reply') return true;
  if (isMetricOnly(type, kind)) return false;
  return L2_BODY_TYPES.has(type);
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^.*?[.!?。！？\n]/);
  const head = (m ? m[0] : trimmed).trim();
  return head.length > 240 ? `${head.slice(0, 240)}…` : head;
}

export class ConversationCompactionService {
  /**
   * Check trigger conditions for a conversation and, if any hard/char-budget
   * threshold is met, produce one range segment. Idle is evaluated by the
   * server.ts sweep (it passes `idle: true` semantics by virtue of calling this
   * after a quiet period — but we re-derive locally so the call site stays
   * dumb).
   *
   * NEVER throws — this is invoked fire-and-forget from the send() hot path and
   * the sweep. All failures are swallowed + logged so dispatch can't be blocked
   * (§10).
   *
   * @returns `{ produced: N }` where N is 0 or 1 (Phase 2 produces at most one
   *          segment per call; the next call handles the next slice).
   */
  async maybeCompact(conversationId: string): Promise<{ produced: number }> {
    try {
      const uncompacted = await this.loadUncompacted(conversationId);
      const decision = this.evaluateTriggers(uncompacted, await this.lastActivityAt(conversationId));
      if (!decision.fire) return { produced: 0 };

      const seg = await this.produceRangeSegment(conversationId);
      return { produced: seg ? 1 : 0 };
    } catch (err) {
      // Defensive: produceRangeSegment already swallows its own errors, but a
      // trigger-eval / DB-read failure must not bubble into send()/sweep.
      log.warn(
        { err, conversationId },
        `[ConversationCompaction] maybeCompact non-fatal error: ${(err as Error).message}`,
      );
      return { produced: 0 };
    }
  }

  /**
   * Produce one range segment covering the (oldest) uncompacted slice.
   *
   * `opts.fromMessageId` / `opts.toMessageId` pin the covered range (used by
   * regenerate); without them the slice is "all currently-uncompacted raw".
   *
   * Returns the created segment, or `null` when there's nothing to cover or a
   * concurrent worker won the unique key (P2002 → no-op).
   */
  async produceRangeSegment(
    conversationId: string,
    opts?: { fromMessageId?: string; toMessageId?: string },
  ): Promise<IMConversationCompressedSegment | null> {
    const startedAt = Date.now();
    const segmentKind = 'range';
    try {
      let rows: RawRow[];
      if (opts?.fromMessageId && opts?.toMessageId) {
        rows = await this.loadRangeByBounds(conversationId, opts.fromMessageId, opts.toMessageId);
      } else {
        rows = await this.loadUncompacted(conversationId);
      }

      if (rows.length === 0) return null;
      // Don't produce a degenerate segment unless we have enough body to cover.
      // (regenerate bypasses this floor — explicit bounds always produce.)
      const bodyRows = rows.filter((r) => isL2Body(r.type, parseMetaKind(r.metadata)));
      if (!opts && bodyRows.length < MIN_COVERABLE_FOR_PRODUCE) return null;

      // ── metric-only accounting (§5.1) ─────────────────────────────────────
      let taskEventCount = 0;
      let approvalCount = 0;
      for (const r of rows) {
        const kind = parseMetaKind(r.metadata);
        if (isTaskEvent(r.type, kind)) taskEventCount += 1;
        if (isApprovalEvent(r.type, kind)) approvalCount += 1;
      }

      // ── produce summary + salientFacts (LLM, fallback extractive) ─────────
      const produced = await this.runProducer(bodyRows);
      const salientFacts: EnvelopeSalientFacts = {
        ...produced.salientFacts,
        ...(taskEventCount > 0 ? { taskEventCount } : {}),
        ...(approvalCount > 0 ? { approvalCount } : {}),
      };

      const coveredIds = rows.map((r) => r.id);
      const from = rows[0];
      const to = rows[rows.length - 1];
      const tokenCountCl100k = estimateCl100kTokens(produced.summary);

      // ── allocate next segmentSeq (max+1) ──────────────────────────────────
      const maxAgg = await prisma.iMConversationCompressedSegment.aggregate({
        where: { conversationId, segmentKind },
        _max: { segmentSeq: true },
      });
      const nextSeq = ((maxAgg as { _max?: { segmentSeq: number | null } })._max?.segmentSeq ?? 0) + 1;

      // ── write segment + reverse index, same tx ────────────────────────────
      let segment: IMConversationCompressedSegment;
      try {
        segment = await prisma.$transaction(async (tx: any) => {
          const created = (await tx.iMConversationCompressedSegment.create({
            data: {
              conversationId,
              segmentKind,
              segmentSeq: nextSeq,
              coversFromMessageId: from.id,
              coversToMessageId: to.id,
              coveredRawMessageIdsJson: JSON.stringify(coveredIds),
              coversFromCreatedAt: from.createdAt,
              coversToCreatedAt: to.createdAt,
              summary: produced.summary,
              salientFactsJson: JSON.stringify(salientFacts),
              tokenCountCl100k,
              producerModel: produced.model,
              producerVersion: produced.version,
            },
          })) as IMConversationCompressedSegment;

          // One reverse-index row per covered raw message.
          await tx.iMConversationRawToSegmentIndex.createMany({
            data: coveredIds.map((rawMessageId) => ({
              rawMessageId,
              segmentId: created.id,
              segmentKind,
            })),
          });
          return created;
        });
      } catch (err) {
        // P2002 on (conversationId, segmentKind, segmentSeq) = a concurrent
        // worker grabbed the same seq. No-op (§3 + §10 "并发压缩同 conv").
        if ((err as { code?: string }).code === 'P2002') {
          log.info(
            { conversationId, segmentSeq: nextSeq },
            `[ConversationCompaction] concurrent producer won segmentSeq=${nextSeq}; no-op`,
          );
          return null;
        }
        throw err;
      }

      emitProducedMetric(segmentKind, produced.version);
      emitProducerDurationMetric(Date.now() - startedAt);
      log.info(
        {
          conversationId,
          segmentSeq: nextSeq,
          sourceCount: coveredIds.length,
          producerModel: produced.model,
        },
        `[ConversationCompaction] produced range segment seq=${nextSeq} sources=${coveredIds.length} model=${produced.model}`,
      );
      return segment;
    } catch (err) {
      // produceRangeSegment must never bubble into the fire-and-forget caller.
      emitProducerFailedMetric(segmentKind, 'unexpected');
      log.error(
        { err, conversationId },
        `[ConversationCompaction] ❌ produceRangeSegment failed (non-blocking): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Regenerate a segment in place: re-run the producer over the OLD segment's
   * covered range, write a NEW segment (next segmentSeq), and mark the old one
   * `supersededBy = <new id>` (so buildEnvelope's `supersededBy: null` filter
   * drops the stale one — §10 "Producer 月度漂移" bulk-regenerate path).
   */
  async regenerateSegment(
    conversationId: string,
    segmentSeq: number,
  ): Promise<IMConversationCompressedSegment | null> {
    const old = (await prisma.iMConversationCompressedSegment.findFirst({
      where: { conversationId, segmentKind: 'range', segmentSeq },
    })) as IMConversationCompressedSegment | null;
    if (!old) {
      log.warn(
        { conversationId, segmentSeq },
        `[ConversationCompaction] regenerate: no segment seq=${segmentSeq}`,
      );
      return null;
    }

    const fresh = await this.produceRangeSegment(conversationId, {
      fromMessageId: old.coversFromMessageId,
      toMessageId: old.coversToMessageId,
    });
    if (!fresh) return null;

    try {
      await prisma.iMConversationCompressedSegment.update({
        where: { id: old.id },
        data: { supersededBy: fresh.id },
      });
    } catch (err) {
      log.warn(
        { err, oldId: old.id, freshId: fresh.id },
        `[ConversationCompaction] regenerate: failed to mark superseded: ${(err as Error).message}`,
      );
    }
    return fresh;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Run the LLM producer. On any LLM failure/timeout/parse-error, fall back to
   * an extractive summary (first sentence per body row + entity vocab) and tag
   * `producerModel='extractive-fallback'`. NEVER throws (§10).
   */
  private async runProducer(
    bodyRows: RawRow[],
  ): Promise<{ summary: string; salientFacts: EnvelopeSalientFacts; model: string; version: string }> {
    const version = producerVersionHash();
    const sliceText = bodyRows
      .map((r) => `[${r.id}] ${r.content ?? ''}`)
      .join('\n');

    let raw: string | null = null;
    try {
      raw = await callLLM(`${PRODUCER_PROMPT_TEMPLATE}${sliceText}`);
    } catch (err) {
      log.warn({ err }, `[ConversationCompaction] callLLM threw: ${(err as Error).message}`);
      raw = null;
    }

    if (raw) {
      const parsed = this.parseProducerJson(raw);
      if (parsed) {
        return { ...parsed, model: resolveProducerModel(), version };
      }
      emitProducerFailedMetric('range', 'parse_error');
    } else {
      emitProducerFailedMetric('range', 'llm_unavailable');
    }

    // ── extractive fallback (§10) ─────────────────────────────────────────
    return { ...this.extractiveFallback(bodyRows), model: EXTRACTIVE_FALLBACK_MODEL, version };
  }

  private parseProducerJson(
    raw: string,
  ): { summary: string; salientFacts: EnvelopeSalientFacts } | null {
    // Tolerate ```json fences the model may add despite instructions.
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    try {
      const obj = JSON.parse(cleaned) as {
        summary?: unknown;
        salientFacts?: Record<string, unknown>;
      };
      if (typeof obj.summary !== 'string') return null;
      const sf = obj.salientFacts ?? {};
      const arr = (k: string): string[] | undefined => {
        const v = (sf as Record<string, unknown>)[k];
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
      };
      const salientFacts: EnvelopeSalientFacts = {};
      for (const k of [
        'topicHeadlines',
        'decisions',
        'openQuestions',
        'entitiesMentioned',
        'userPreferences',
        'agentCommitments',
        'discardedDirections',
      ] as const) {
        const v = arr(k);
        if (v && v.length) salientFacts[k] = v;
      }
      return { summary: obj.summary, salientFacts };
    } catch {
      return null;
    }
  }

  private extractiveFallback(bodyRows: RawRow[]): {
    summary: string;
    salientFacts: EnvelopeSalientFacts;
  } {
    const sentences: string[] = [];
    const entities = new Set<string>();
    for (const r of bodyRows) {
      const s = firstSentence(r.content ?? '');
      if (s) sentences.push(`- ${s}`);
      // crude entity vocab: CamelCase words, paths, @mentions, quoted ids.
      const text = r.content ?? '';
      for (const m of text.matchAll(/@[\w.-]+|[A-Z][a-zA-Z0-9]{2,}|[\w-]+\.[\w./-]+/g)) {
        entities.add(m[0]);
        if (entities.size >= 40) break;
      }
    }
    const summary = sentences.length
      ? `(extractive fallback summary)\n${sentences.join('\n')}`
      : '(extractive fallback: no textual content in slice)';
    const salientFacts: EnvelopeSalientFacts = {};
    if (entities.size) salientFacts.entitiesMentioned = Array.from(entities);
    return { summary, salientFacts };
  }

  /**
   * Load raw messages NOT yet covered by any range segment, oldest first.
   * "Uncompacted" = no row in IMConversationRawToSegmentIndex for that raw id.
   */
  private async loadUncompacted(conversationId: string): Promise<RawRow[]> {
    const rows = (await prisma.iMMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        senderId: true,
        type: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    })) as RawRow[];
    if (rows.length === 0) return [];

    const indexed = (await prisma.iMConversationRawToSegmentIndex.findMany({
      where: { rawMessageId: { in: rows.map((r) => r.id) } },
      select: { rawMessageId: true },
    })) as Array<{ rawMessageId: string }>;
    const covered = new Set(indexed.map((i) => i.rawMessageId));
    return rows.filter((r) => !covered.has(r.id));
  }

  /** Load a contiguous range [from..to] by createdAt bounds (regenerate path). */
  private async loadRangeByBounds(
    conversationId: string,
    fromMessageId: string,
    toMessageId: string,
  ): Promise<RawRow[]> {
    const bounds = (await prisma.iMMessage.findMany({
      where: { id: { in: [fromMessageId, toMessageId] } },
      select: { id: true, createdAt: true },
    })) as Array<{ id: string; createdAt: Date }>;
    const fromAt = bounds.find((b) => b.id === fromMessageId)?.createdAt;
    const toAt = bounds.find((b) => b.id === toMessageId)?.createdAt;
    if (!fromAt || !toAt) return [];
    return (await prisma.iMMessage.findMany({
      where: { conversationId, createdAt: { gte: fromAt, lte: toAt } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        senderId: true,
        type: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    })) as RawRow[];
  }

  /** Most recent message createdAt (for idle/silent computation). */
  private async lastActivityAt(conversationId: string): Promise<Date | null> {
    const latest = (await prisma.iMMessage.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })) as { createdAt: Date } | null;
    return latest?.createdAt ?? null;
  }

  /**
   * Evaluate the three §8 triggers against the uncompacted slice. Returns which
   * one fired (for logging) and whether to produce.
   */
  private evaluateTriggers(
    uncompacted: RawRow[],
    lastActivityAt: Date | null,
  ): { fire: boolean; reason: 'hard' | 'char_budget' | 'idle' | 'none' } {
    // Only L2-body rows count toward the "待压" thresholds; metric-only rows
    // (task.*/approval/system) are bookkeeping, not compaction pressure.
    const body = uncompacted.filter((r) => isL2Body(r.type, parseMetaKind(r.metadata)));
    if (body.length === 0) return { fire: false, reason: 'none' };

    const now = Date.now();
    const oldest = body[0];
    const oldestAgeMs = now - new Date(oldest.createdAt).getTime();
    const totalChars = body.reduce((sum, r) => sum + (r.content?.length ?? 0), 0);
    const silentMs = lastActivityAt ? now - new Date(lastActivityAt).getTime() : 0;

    // hard: raw_count > 60 且 oldest_uncompacted > 12h
    if (
      body.length > COMPACTION_TRIGGERS.hard.minUncompacted &&
      oldestAgeMs > COMPACTION_TRIGGERS.hard.oldestUncompactedAgeMs
    ) {
      return { fire: true, reason: 'hard' };
    }
    // char-budget: sum(uncompacted chars) > 48KB
    if (totalChars > COMPACTION_TRIGGERS.charBudget.maxUncompactedChars) {
      return { fire: true, reason: 'char_budget' };
    }
    // idle: silent ≥ 4h 且 ≥ 30 待压
    if (
      silentMs >= COMPACTION_TRIGGERS.idle.silentForMs &&
      body.length >= COMPACTION_TRIGGERS.idle.minUncompacted
    ) {
      return { fire: true, reason: 'idle' };
    }
    return { fire: false, reason: 'none' };
  }
}

export const conversationCompactionService = new ConversationCompactionService();

// ─── Idle-candidate sweep helper (server.ts integration, §8 idle) ─────────────
//
// The server.ts periodic sweep calls this at a low cadence. It finds
// conversations that have been silent for the idle window and runs maybeCompact
// on each (which re-derives the idle condition locally). Bounded + never
// throws so it can't crash the host interval.
const IDLE_SWEEP_SCAN_LIMIT = 50;

export async function sweepIdleCompactionCandidates(): Promise<{ scanned: number; produced: number }> {
  let produced = 0;
  let scanned = 0;
  try {
    const cutoff = new Date(Date.now() - COMPACTION_TRIGGERS.idle.silentForMs);
    const candidates = (await prisma.iMConversation.findMany({
      where: { status: 'active', lastMessageAt: { lte: cutoff } },
      orderBy: { lastMessageAt: 'asc' },
      take: IDLE_SWEEP_SCAN_LIMIT,
      select: { id: true },
    })) as Array<{ id: string }>;
    scanned = candidates.length;
    for (const c of candidates) {
      const { produced: n } = await conversationCompactionService.maybeCompact(c.id);
      produced += n;
    }
  } catch (err) {
    log.warn(
      { err },
      `[ConversationCompaction] idle sweep non-fatal error: ${(err as Error).message}`,
    );
  }
  return { scanned, produced };
}
