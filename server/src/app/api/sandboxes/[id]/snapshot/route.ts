/**
 * POST /api/sandboxes/:id/snapshot — trigger Kaniko snapshot of running container.
 *
 * Schedules the Kaniko Job in-process (via `k8sSandbox.snapshot`), then
 * persists an IMContainerSnapshot row with imageTag, imageDigest, sizeBytes,
 * createdBy.
 *
 * Note: sizeBytes is stored as BigInt in Prisma but JSON-serialized as a
 * Number (acceptable for sizes < 2^53 bytes ≈ 9 PB) — vanilla JSON.stringify
 * throws on BigInt, and downstream clients expect a number.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { K8sSandboxError, k8sSandbox } from '@/lib/k8s-sandbox';
import { authorizeContainer } from '../../_helpers';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  try {
    const { snapshot } = await k8sSandbox.snapshot(container.podName);
    const row = await prisma.iMContainerSnapshot.create({
      data: {
        containerId: container.id,
        imageTag: snapshot.imageTag,
        imageDigest: snapshot.imageDigest ?? null,
        sizeBytes: typeof snapshot.sizeBytes === 'number' ? BigInt(snapshot.sizeBytes) : null,
        createdBy: auth.user.id,
      },
    });

    logger.info(
      { id, podName: container.podName, snapshotId: row.id, imageTag: row.imageTag },
      'sandbox snapshot created',
    );

    return NextResponse.json(
      {
        snapshot: {
          ...row,
          sizeBytes: row.sizeBytes !== null ? Number(row.sizeBytes) : null,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      return NextResponse.json({ error: 'controller_error', status: err.status, body: err.body }, { status: 502 });
    }
    logger.error({ err, id, podName: container.podName }, 'snapshot failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
