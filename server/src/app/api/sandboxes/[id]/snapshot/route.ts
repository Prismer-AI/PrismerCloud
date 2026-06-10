/**
 * POST /api/sandboxes/:id/snapshot — capture a workspace snapshot.
 *
 * v200 T9: default mode is `fs-manifest` (daemon-first file digest list,
 * captured via the in-pod daemon's `POST /v1/snapshot`). The legacy `image`
 * mode (Kaniko commit) is opt-in via `body.kind === 'image'` and currently
 * surfaces as ProviderError `snapshot_failed` until the Kaniko build context
 * is implemented (08 §9.2 B1).
 *
 * Request body (all fields optional):
 *   { kind?: 'fs-manifest' | 'image', tag?, repo?, comment?,
 *     includeGlobs?, excludeGlobs?, root? }
 *   default kind = 'fs-manifest'
 *
 * Response 201:
 *   { snapshot: {
 *       id, kind, createdAt,
 *       // fs-manifest mode:
 *       manifestFileCount?, manifestTotalBytes?,
 *       // image mode:
 *       imageRef?, digest?,
 *       sizeBytes
 *   } }
 *
 * Persistence:
 *   IMContainerSnapshot row — `metadata` JSON stores `kind` + (for fs-manifest)
 *   the first 100 file entries + aggregate counts + generatedAt. Full manifest
 *   archival to SnapshotJsonStorage is deferred to v210.
 *
 * Notes on BigInt JSON: Prisma stores `sizeBytes` as `BigInt?`; we cast to
 * Number on the wire (safe for sizes < 2^53 bytes ≈ 9 PB).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { resolvePersistent } from '@/lib/sandbox/registry';
import type { SnapshotRequest } from '@/lib/sandbox/types';
import { ProviderError, httpStatusForProviderError } from '@/lib/execution/errors';
import { authorizeContainer } from '../../_helpers';

const MANIFEST_FILE_PREVIEW_CAP = 100;

const snapshotRequestSchema = z
  .object({
    kind: z.enum(['fs-manifest', 'image']).optional(),
    tag: z.string().max(128).optional(),
    repo: z.string().max(255).optional(),
    comment: z.string().max(1024).optional(),
    includeGlobs: z.array(z.string()).max(64).optional(),
    excludeGlobs: z.array(z.string()).max(64).optional(),
    root: z.string().max(255).optional(),
  })
  .strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  // Parse body — default to fs-manifest when absent or unparseable.
  let parsedBody: SnapshotRequest = { kind: 'fs-manifest' };
  try {
    const raw = await req.text();
    if (raw && raw.trim().length > 0) {
      const json = JSON.parse(raw) as unknown;
      const parsed = snapshotRequestSchema.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_body', message: parsed.error.message }, { status: 400 });
      }
      parsedBody = { kind: 'fs-manifest', ...parsed.data };
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        message: `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 400 },
    );
  }

  try {
    const provider = resolvePersistent(container.providerKind ?? 'k8s');
    const result = await provider.snapshot(container.podName, parsedBody);

    // Build metadata payload — full manifest may be MB-scale for large
    // workspaces. v200 stores aggregate stats + first N file entries; full
    // manifest archival is a v210 SnapshotJsonStorage task.
    const metadataObj: Record<string, unknown> = {
      kind: result.kind,
      generatedAt: result.manifest?.generatedAt ?? new Date().toISOString(),
    };
    if (result.kind === 'fs-manifest' && result.manifest) {
      metadataObj.manifestFileCount = result.manifest.count;
      metadataObj.manifestTotalBytes = result.manifest.totalBytes;
      metadataObj.rootPath = result.manifest.rootPath;
      metadataObj.files = result.manifest.files.slice(0, MANIFEST_FILE_PREVIEW_CAP);
      if (result.manifest.files.length > MANIFEST_FILE_PREVIEW_CAP) {
        metadataObj.filesTruncated = true;
        metadataObj.filesTruncatedAfter = MANIFEST_FILE_PREVIEW_CAP;
      }
    }

    const sizeBytesBig =
      result.sizeBytes != null ? BigInt(result.sizeBytes) : result.manifest ? BigInt(result.manifest.totalBytes) : null;

    const row = await prisma.iMContainerSnapshot.create({
      data: {
        containerId: container.id,
        imageTag: result.kind === 'image' ? (result.imageRef ?? null) : null,
        imageDigest: result.kind === 'image' ? (result.digest ?? null) : null,
        sizeBytes: sizeBytesBig,
        createdBy: auth.user.id,
        metadata: JSON.stringify(metadataObj),
      },
    });

    logger.info(
      {
        id,
        podName: container.podName,
        snapshotId: row.id,
        kind: result.kind,
        fileCount: result.manifest?.count,
        imageRef: result.imageRef,
      },
      'sandbox snapshot created',
    );

    const responseBody: Record<string, unknown> = {
      id: row.id,
      kind: result.kind,
      createdAt: row.createdAt.toISOString(),
      sizeBytes: row.sizeBytes !== null ? Number(row.sizeBytes) : null,
    };
    if (result.kind === 'fs-manifest' && result.manifest) {
      responseBody.manifestFileCount = result.manifest.count;
      responseBody.manifestTotalBytes = result.manifest.totalBytes;
      responseBody.rootPath = result.manifest.rootPath;
    } else if (result.kind === 'image') {
      responseBody.imageRef = result.imageRef;
      responseBody.digest = result.digest;
    }

    return NextResponse.json({ snapshot: responseBody }, { status: 201 });
  } catch (err) {
    if (err instanceof ProviderError) {
      return NextResponse.json(
        { error: err.code, message: err.message, retriable: err.retriable, providerRef: err.providerRef },
        { status: httpStatusForProviderError(err) },
      );
    }
    logger.error({ err, id, podName: container.podName }, 'snapshot failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
