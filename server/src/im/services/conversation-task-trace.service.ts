/**
 * Prismer IM — Conversation Task-Trace Service (release201/26 Phase 3)
 *
 * Writes an L2 `segmentKind='task_trace'` segment when a task reaches a terminal
 * (completed) state. The segment compresses that task's `IMTaskRunStep` sequence
 * into a durable `{ taskId, toolsUsed[], outputs[], decisions[] }` salientFacts
 * payload so `buildEnvelope.recentTaskTrace` can surface "what the last task did"
 * without re-reading the (high-volume, per-run) step ledger.
 *
 * Ground truth: docs/release201/26-conversational-memory-plan.md
 *   - §5     envelope `recentTaskTrace` field (Phase 3)
 *   - §5.4 (RFC 25) task trace design
 *   - §8 Phase 3 — TaskTrace segment写 L2 + envelope.recentTaskTrace
 *   - §10    "TaskTrace segment 污染 ledger" → trace 写 L2 不写 IMMessage,
 *            签名链不受影响
 *
 * Design invariants (do not regress):
 *   - Writes ONLY to L2 tables (IMConversationCompressedSegment); NEVER an
 *     IMMessage — the message signing chain must not be touched (§10).
 *   - Invoked fire-and-forget at the task terminal transition; NEVER throws,
 *     NEVER blocks the completion path.
 *   - segmentSeq allocation rides the schema unique key
 *     `(conversationId, segmentKind, segmentSeq)`; a racing duplicate is a P2002
 *     no-op (mirrors conversation-compaction.service).
 *   - coveredRawMessageIds = [triggerMessageId] (the message that spawned the
 *     run), per task spec — a task_trace does not "cover" a contiguous raw range
 *     the way a range segment does.
 */

import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
import { estimateCl100kTokens } from './conversation-memory.service';

const log = createModuleLogger('ConversationTaskTrace');

const SEGMENT_KIND = 'task_trace';
const PRODUCER_MODEL = 'task-trace-extractive';
const PRODUCER_VERSION = 'v1';
// Cap list sizes so a pathological 10k-step run can't bloat the segment.
const MAX_TOOLS = 40;
const MAX_OUTPUTS = 40;
const MAX_DECISIONS = 20;

// ─── Observability (docs/release201/26 §9 — mirror compaction metric style) ───
function emitProducedMetric(): void {
  // compressed_segment_produced_total{kind,producer_version}
  log.info(
    {
      metric: 'compressed_segment_produced_total',
      kind: SEGMENT_KIND,
      producer_version: PRODUCER_VERSION,
    },
    `[ConversationTaskTrace] compressed_segment_produced_total kind=${SEGMENT_KIND} producer_version=${PRODUCER_VERSION}`,
  );
}
function emitFailedMetric(reason: string): void {
  // compressed_segment_producer_failed_total{kind,reason}
  log.info(
    { metric: 'compressed_segment_producer_failed_total', kind: SEGMENT_KIND, reason },
    `[ConversationTaskTrace] compressed_segment_producer_failed_total kind=${SEGMENT_KIND} reason=${reason}`,
  );
}

interface StepRow {
  kind: string;
  payloadJson: unknown;
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Distil an IMTaskRunStep sequence into the task_trace salient facts.
 *
 *   - toolsUsed   ← distinct `tool_call` payload `toolName` (insertion order)
 *   - outputs     ← `tool_result` payload `outputSummary` + the run's final
 *                   `output` (passed in by the caller, since steps don't carry it)
 *   - decisions   ← `reasoning_chunk` payload `text` (the agent's stated
 *                   reasoning) — left empty when no reasoning steps were recorded
 */
export function distilTaskTrace(
  steps: StepRow[],
  finalOutput?: string | null,
): { toolsUsed: string[]; outputs: string[]; decisions: string[] } {
  const toolsSeen = new Set<string>();
  const toolsUsed: string[] = [];
  const outputs: string[] = [];
  const decisions: string[] = [];

  for (const s of steps) {
    const p = asObject(s.payloadJson);
    switch (s.kind) {
      case 'tool_call': {
        const name = str(p.toolName) ?? str(p.tool) ?? str(p.name);
        if (name && !toolsSeen.has(name) && toolsUsed.length < MAX_TOOLS) {
          toolsSeen.add(name);
          toolsUsed.push(name);
        }
        break;
      }
      case 'tool_result': {
        const out = str(p.outputSummary) ?? str(p.output);
        if (out && outputs.length < MAX_OUTPUTS) outputs.push(out);
        break;
      }
      case 'reasoning_chunk': {
        const text = str(p.text) ?? str(p.reasoning);
        if (text && decisions.length < MAX_DECISIONS) decisions.push(text);
        break;
      }
      default:
        break;
    }
  }

  const finalStr = str(finalOutput);
  if (finalStr && outputs.length < MAX_OUTPUTS) outputs.push(finalStr);

  return { toolsUsed, outputs, decisions };
}

export class ConversationTaskTraceService {
  /**
   * Write a task_trace L2 segment for a completed run. Fire-and-forget safe:
   * NEVER throws, NEVER writes an IMMessage.
   *
   * @returns the created segment id, or null when skipped (no conversation /
   *          no steps / concurrent duplicate / any swallowed error).
   */
  async writeTaskTrace(input: {
    taskRunId: string;
    taskId: string | null;
    conversationId: string | null;
    triggerMessageId: string | null;
    finalOutput?: string | null;
  }): Promise<string | null> {
    const { taskRunId, taskId, conversationId, triggerMessageId } = input;
    try {
      if (!conversationId) {
        // No conversation to attach the trace to — nothing to do.
        return null;
      }

      // ── load the run's step sequence (oldest first) ──────────────────────
      let steps: StepRow[] = [];
      try {
        steps = (await prisma.$queryRaw`
          SELECT kind, payloadJson
          FROM im_task_run_steps
          WHERE taskRunId = ${taskRunId}
          ORDER BY seq ASC
          LIMIT 2000
        `) as StepRow[];
      } catch (err) {
        // Step ledger read failed — fall through with empty steps so we can
        // still record a (minimal) trace from finalOutput. Never abort.
        log.warn(
          { err, taskRunId },
          `[ConversationTaskTrace] step read failed: ${(err as Error).message}`,
        );
        steps = [];
      }

      const { toolsUsed, outputs, decisions } = distilTaskTrace(steps, input.finalOutput);

      // Nothing meaningful to record (no steps, no output) → skip rather than
      // write an empty segment that just adds noise to the envelope.
      if (toolsUsed.length === 0 && outputs.length === 0 && decisions.length === 0) {
        return null;
      }

      const salientFacts = {
        taskId: taskId ?? taskRunId,
        toolsUsed,
        outputs,
        decisions,
      };
      const summary = `Task ${taskId ?? taskRunId} completed using ${toolsUsed.length} tool(s)${
        outputs.length ? `; produced ${outputs.length} output(s)` : ''
      }.`;
      const coveredRawMessageIds = triggerMessageId ? [triggerMessageId] : [];
      const now = new Date();

      // ── allocate next segmentSeq (max+1 across ALL kinds in this conv) ────
      // segmentSeq is unique per (conversationId, segmentKind); task_trace keeps
      // its own seq series.
      const maxAgg = await prisma.iMConversationCompressedSegment.aggregate({
        where: { conversationId, segmentKind: SEGMENT_KIND },
        _max: { segmentSeq: true },
      });
      const nextSeq =
        ((maxAgg as { _max?: { segmentSeq: number | null } })._max?.segmentSeq ?? 0) + 1;

      try {
        const created = await prisma.iMConversationCompressedSegment.create({
          data: {
            conversationId,
            segmentKind: SEGMENT_KIND,
            segmentSeq: nextSeq,
            // task_trace doesn't span a contiguous raw range; pin both bounds to
            // the trigger message (or empty string when absent).
            coversFromMessageId: triggerMessageId ?? '',
            coversToMessageId: triggerMessageId ?? '',
            coveredRawMessageIdsJson: JSON.stringify(coveredRawMessageIds),
            coversFromCreatedAt: now,
            coversToCreatedAt: now,
            summary,
            salientFactsJson: JSON.stringify(salientFacts),
            tokenCountCl100k: estimateCl100kTokens(JSON.stringify(salientFacts)),
            producerModel: PRODUCER_MODEL,
            producerVersion: PRODUCER_VERSION,
          },
        });
        emitProducedMetric();
        log.info(
          { conversationId, taskRunId, segmentSeq: nextSeq, tools: toolsUsed.length },
          `[ConversationTaskTrace] wrote task_trace seq=${nextSeq} tools=${toolsUsed.length}`,
        );
        return (created as { id: string }).id;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          // Concurrent writer grabbed the same seq — no-op (§10 concurrency).
          log.info(
            { conversationId, segmentSeq: nextSeq },
            `[ConversationTaskTrace] concurrent writer won segmentSeq=${nextSeq}; no-op`,
          );
          return null;
        }
        throw err;
      }
    } catch (err) {
      emitFailedMetric('unexpected');
      log.error(
        { err, taskRunId, conversationId },
        `[ConversationTaskTrace] ❌ writeTaskTrace failed (non-blocking): ${(err as Error).message}`,
      );
      return null;
    }
  }
}

export const conversationTaskTraceService = new ConversationTaskTraceService();
