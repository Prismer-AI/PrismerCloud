/**
 * GET /api/sandboxes/:id/snapshots — list snapshots for a container.
 *
 * Pure DB read; controller is not consulted (snapshots are persistent
 * artifacts in the registry, not pod-scoped state). sizeBytes is returned
 * as Number for JSON-friendliness (BigInt is not JSON-serializable; values
 * < 2^53 bytes ≈ 9 PB fit safely).
 */

import { NextResponse, type NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { authorizeContainer } from '../../_helpers';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  const rows = await prisma.iMContainerSnapshot.findMany({
    where: { containerId: container.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const snapshots = rows.map((r: (typeof rows)[number]) => ({
    ...r,
    sizeBytes: r.sizeBytes !== null ? Number(r.sizeBytes) : null,
  }));

  return NextResponse.json({ snapshots });
}
