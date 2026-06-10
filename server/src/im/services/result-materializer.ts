/**
 * Prismer IM — Task result materializer (release201/3x)
 *
 * "任务结果 = asset" 无条件成立。Many agent roles (CEO, advisors, planners)
 * answer a task with an inline markdown body and never write a file
 * deliverable. Pre-this-change that left `metadata.outputAssetIds` empty →
 * no task-bound asset → the completion digest's 产物列表 + drawer Artifacts
 * tab were blank, and the result only lived as inline text in
 * `IMTaskRun.output` / the drawer RESULT viewer.
 *
 * On task completion (single funnel point: `TaskService.emitTaskStatusChat`)
 * this module, when the task produced NO file deliverable, materializes the
 * substantive inline output into a **task-bound** `text/markdown` IMAsset so
 * the whole产物 chain (digest list / drawer Artifacts / PlateMarkdownEditor
 * edit) lights up automatically.
 *
 * Wave-9 originally dropped the `IMAsset(kind=task-result)` auto-mirror for
 * two reasons — (a) no reader, (b) it polluted the Library. Both are now
 * void: there ARE readers (产物列表 / drawer / editor), and writing with
 * `boundKind='task-bound'` keeps the asset OUT of the Library Root (it only
 * surfaces inside the task; Promote↑ is required to lift it to the library).
 * So the mirror is reinstated — but strictly task-bound.
 *
 * Gating (ALL must hold; otherwise no-op):
 *   1. status === 'completed'
 *   2. the task has ZERO existing deliverable assets (file产物 empty)
 *   3. the inline output is substantive markdown (trimmed length ≥ threshold)
 *   4. idempotent — the task has not already been materialized from output
 *
 * Layer: this is a service (uses Prisma + asset-blob-store). It must NEVER be
 * imported by `api/*` for the write path; `task.service.ts` (a service) owns
 * the call. Blob bytes go through `asset-blob-store` (shared with the assets
 * API), never a copied storage path.
 */

import prisma from '../db';
import * as crypto from 'crypto';
import { isS3Available } from './s3.client';
import { MAX_ASSET_BYTES, assetCdnUrlForStorageUri, getBackend, writeFilesystem, writeS3 } from './asset-blob-store';

/** Minimum trimmed length for an inline output to be worth materializing. */
export const MATERIALIZE_MIN_OUTPUT_CHARS = 200;

const RESULT_ASSET_KIND = 'agent-output';
const RESULT_ASSET_MIME = 'text/markdown';

export interface MaterializeResultInput {
  taskId: string;
  /** Best-effort inline output text from the completion call. When null the
   *  materializer falls back to the persisted `IMTask.result` so completion
   *  paths that don't thread output (e.g. the state-machine record-completion
   *  approval path) still materialize. */
  output: string | null | undefined;
  /** Deliverable asset IDs already resolved by the caller (result.assetIds ∪
   *  metadata.outputAssetIds). When non-empty we DO NOT materialize — the task
   *  already has file产物. */
  existingResultAssetIds: string[];
}

export interface MaterializeResultOutcome {
  /** The newly created task-bound asset id, or null if nothing materialized. */
  assetId: string | null;
  reason:
    | 'created'
    | 'has-deliverables'
    | 'output-too-short'
    | 'already-materialized'
    | 'task-missing'
    | 'no-workspace'
    | 'error';
}

/**
 * Extract a plain markdown string from whatever shape the completion output /
 * persisted result takes. Object results are NOT materialized as markdown
 * (they carry typed data, not prose) — only string-ish bodies qualify.
 */
function coerceOutputText(output: string | null | undefined, persistedResult: string | null | undefined): string | null {
  if (typeof output === 'string' && output.trim().length > 0) return output;
  // Fall back to the persisted IMTask.result. It may be a raw string, a
  // JSON-encoded string ("..."), or a JSON object. Only string-ish values are
  // treated as materializable prose.
  if (typeof persistedResult === 'string' && persistedResult.trim().length > 0) {
    const raw = persistedResult.trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // `{ output: "...", assetIds: [...] }` shape (mergeResultWithOutputAssetIds).
        const out = (parsed as Record<string, unknown>).output;
        if (typeof out === 'string' && out.trim().length > 0) return out;
        return null; // typed object result, no prose body
      }
      return null;
    } catch {
      // Not JSON → treat as raw markdown text.
      return raw;
    }
  }
  return null;
}

function slugifyTitle(title: string | null | undefined): string {
  const base = (title ?? '').trim();
  if (!base) return 'result';
  const slug = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'result';
}

async function allocateAssetIndexSeq(workspaceId: string): Promise<bigint> {
  const counter = await prisma.iMAssetIndexCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, nextSeq: BigInt(2) },
    update: { nextSeq: { increment: 1 } },
  });
  return counter.nextSeq - BigInt(1);
}

/**
 * Append `assetId` to `IMTask.metadata.outputAssetIds` (service-layer twin of
 * the api-layer `appendOutputAssetIdToTask`). Idempotent. Returns the updated
 * deduped id list so the caller can re-derive resultAssetIds for the digest.
 */
async function appendOutputAssetId(
  taskId: string,
  metadataRaw: string | null,
  assetId: string,
): Promise<string[]> {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(metadataRaw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch {
    // malformed → start fresh so we don't lose the new id
  }
  const existing = Array.isArray(meta.outputAssetIds)
    ? (meta.outputAssetIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  if (existing.includes(assetId)) return existing;
  const next = [...existing, assetId];
  await prisma.iMTask.update({
    where: { id: taskId },
    data: { metadata: JSON.stringify({ ...meta, outputAssetIds: next }) },
  });
  return next;
}

/**
 * Materialize a task's inline completion output into a task-bound markdown
 * IMAsset when the task has no file deliverable. Returns the new asset id (and
 * the reason) so the caller can fold it into the digest's resultAssetIds.
 *
 * Best-effort: any failure returns `{ assetId: null, reason: 'error' }` and is
 * logged — it must NEVER throw into the completion / digest path.
 */
export async function materializeTaskResultIfNeeded(
  input: MaterializeResultInput,
): Promise<MaterializeResultOutcome> {
  try {
    // Gate 2 (cheap, no DB): existing file deliverables → skip.
    if (input.existingResultAssetIds.length > 0) {
      return { assetId: null, reason: 'has-deliverables' };
    }

    const task = await prisma.iMTask.findUnique({
      where: { id: input.taskId },
      select: { id: true, title: true, workspaceId: true, result: true, metadata: true, creatorId: true },
    });
    if (!task) return { assetId: null, reason: 'task-missing' };
    if (!task.workspaceId) return { assetId: null, reason: 'no-workspace' };

    // Gate 3: substantive markdown output.
    const text = coerceOutputText(input.output, task.result);
    if (!text || text.trim().length < MATERIALIZE_MIN_OUTPUT_CHARS) {
      return { assetId: null, reason: 'output-too-short' };
    }

    // Gate 4 (idempotent): already materialized from output for this task?
    // The metadata marker is the authoritative check; we also rely on the
    // content-addressed unique constraint (ws, hash, sourceRef, deletedAt) as
    // a second line of defence for a re-emit with identical bytes.
    const already = await prisma.iMAsset.findFirst({
      where: {
        workspaceId: task.workspaceId,
        sourceTaskId: task.id,
        deletedAt: null,
        metadata: { contains: '"materializedFromOutput":true' },
      },
      select: { id: true },
    });
    if (already) return { assetId: already.id, reason: 'already-materialized' };

    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_ASSET_BYTES) {
      return { assetId: null, reason: 'error' };
    }
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');

    // Resolve the workspace owner (asset owner). Fall back to the task creator
    // when the workspace lookup is unavailable.
    const ws = await prisma.iMWorkspace.findUnique({
      where: { id: task.workspaceId },
      select: { ownerImUserId: true },
    });
    const ownerImUserId = ws?.ownerImUserId ?? task.creatorId;

    if (getBackend() === 's3' && !isS3Available()) {
      // Can't write to S3 without creds; surface as best-effort no-op.
      return { assetId: null, reason: 'error' };
    }
    const storageUri =
      getBackend() === 's3' ? await writeS3(contentHash, bytes, RESULT_ASSET_MIME) : await writeFilesystem(contentHash, bytes);
    const cdnUrl = assetCdnUrlForStorageUri(storageUri);

    const assetIndexSeq = await allocateAssetIndexSeq(task.workspaceId);
    const filename = `${slugifyTitle(task.title)}.md`;

    let assetId: string;
    try {
      const created = await prisma.iMAsset.create({
        data: {
          workspaceId: task.workspaceId,
          ownerImUserId,
          contentHash,
          storageUri,
          sizeBytes: BigInt(bytes.length),
          mime: RESULT_ASSET_MIME,
          kind: RESULT_ASSET_KIND,
          sourceTaskId: task.id,
          // release201/09 §9.4a.2 — task-bound assets stay OUT of the Library
          // Root; they only surface inside the task (Promote↑ lifts later).
          boundKind: 'task-bound',
          sourceRef: `task-result:${task.id}`,
          sourceKind: 'task-result',
          filename,
          ingestStatus: 'asset-only',
          assetIndexSeq,
          ...(cdnUrl ? { cdnUrl } : {}),
          metadata: JSON.stringify({
            materializedFromOutput: true,
            sourceTaskId: task.id,
            title: task.title,
          }),
        },
        select: { id: true },
      });
      assetId = created.id;
    } catch (err) {
      // Unique-constraint collision (ws, hash, sourceRef, deletedAt) — a
      // concurrent re-emit already created an identical asset. Resolve it and
      // treat as already-materialized (idempotent).
      const existing = await prisma.iMAsset.findFirst({
        where: {
          workspaceId: task.workspaceId,
          sourceTaskId: task.id,
          contentHash,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existing) return { assetId: existing.id, reason: 'already-materialized' };
      console.error('[ResultMaterializer] ❌ asset create failed', {
        taskId: task.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { assetId: null, reason: 'error' };
    }

    await appendOutputAssetId(task.id, task.metadata, assetId);

    console.log(`[ResultMaterializer] materialized task-bound result asset ${assetId} for task ${task.id}`);
    return { assetId, reason: 'created' };
  } catch (err) {
    console.error('[ResultMaterializer] ❌ materialize failed', {
      taskId: input.taskId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { assetId: null, reason: 'error' };
  }
}
