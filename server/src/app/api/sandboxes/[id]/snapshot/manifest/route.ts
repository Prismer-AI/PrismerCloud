/**
 * POST /api/sandboxes/:id/snapshot/manifest — daemon-first FS manifest snapshot.
 *
 * Replaces docker-commit (`POST /api/sandboxes/:id/snapshot`) for the daemon-first
 * sandbox model. Body: `{ files: [{ path, sha256, sizeBytes, mtime }] }` (the
 * daemon walks `/workspace/` and computes per-file digests). Phase 1 stores the
 * manifest in `IMContainerSnapshot.metadata` with `kind="fs-manifest"`.
 * `imageTag/imageDigest/sizeBytes` stay null until Phase 2 (v5.5) wires real
 * commit + S3 upload of the workspace tree.
 *
 * Auth: same as the docker-commit route — workspace owner via `authorizeContainer`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { authorizeContainer } from '../../../_helpers';

interface ManifestFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  mtime: number;
}

interface ManifestBody {
  files: ManifestFile[];
}

const MAX_FILES = 50_000; // hard cap to keep payload size sensible

function isManifestBody(v: unknown): v is ManifestBody {
  if (typeof v !== 'object' || v === null) return false;
  const files = (v as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  if (files.length > MAX_FILES) return false;
  for (const f of files) {
    if (typeof f !== 'object' || f === null) return false;
    const ff = f as Record<string, unknown>;
    if (typeof ff.path !== 'string' || ff.path.length === 0) return false;
    if (typeof ff.sha256 !== 'string' || ff.sha256.length === 0) return false;
    if (typeof ff.sizeBytes !== 'number' || ff.sizeBytes < 0) return false;
    if (typeof ff.mtime !== 'number') return false;
  }
  return true;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!isManifestBody(body)) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'expected { files: [{ path, sha256, sizeBytes, mtime }] }' },
      { status: 400 },
    );
  }

  const totalBytes = body.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const ts = Date.now();
  const metadataJson = JSON.stringify({
    kind: 'fs-manifest',
    snapshottedAt: ts,
    files: body.files,
  });
  // Pre-check against MEDIUMTEXT cap (16 MiB). Code review caught: column was
  // TEXT (64 KB) in migration 302 — widened to MEDIUMTEXT in 303. Add a 1 KB
  // headroom for the JSON envelope so we never see Data-too-long from MySQL.
  const METADATA_MAX_BYTES = 16 * 1024 * 1024 - 1024;
  const metadataByteLen = Buffer.byteLength(metadataJson, 'utf8');
  if (metadataByteLen > METADATA_MAX_BYTES) {
    return NextResponse.json(
      {
        error: 'manifest_too_large',
        message: `Manifest serializes to ${metadataByteLen} bytes; max ${METADATA_MAX_BYTES}`,
      },
      { status: 413 },
    );
  }
  const row = await prisma.iMContainerSnapshot.create({
    data: {
      containerId: container.id,
      imageTag: `manifest-${ts}`,
      imageDigest: null,
      sizeBytes: BigInt(totalBytes),
      createdBy: auth.user.id,
      metadata: metadataJson,
    },
  });

  logger.info(
    {
      id,
      podName: container.podName,
      snapshotId: row.id,
      fileCount: body.files.length,
      totalBytes,
    },
    'sandbox FS manifest snapshot recorded',
  );

  return NextResponse.json(
    {
      snapshot: {
        id: row.id,
        containerId: row.containerId,
        imageTag: row.imageTag,
        sizeBytes: Number(row.sizeBytes ?? BigInt(0)),
        fileCount: body.files.length,
        createdAt: row.createdAt,
      },
    },
    { status: 201 },
  );
}
