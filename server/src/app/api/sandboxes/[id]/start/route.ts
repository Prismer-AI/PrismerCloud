/**
 * POST /api/sandboxes/:id/start — start a stopped container.
 *
 * Schedules the pod in-process via `k8sSandbox.startContainer`; on success
 * syncs Prisma row to status='running' and refreshes startedAt (preserves
 * prior startedAt if already set, so the field reflects "first start" rather
 * than "most recent start").
 */

import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import prisma from '@/lib/prisma';
import { resolvePersistent } from '@/lib/sandbox/registry';
import { ProviderError, httpStatusForProviderError } from '@/lib/execution/errors';
import { authorizeContainer } from '../../_helpers';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container } = auth.data;

  try {
    const provider = resolvePersistent(container.providerKind ?? 'k8s');
    await provider.startEnvironment(container.podName);
    await prisma.iMContainer.update({
      where: { id },
      data: {
        status: 'running',
        startedAt: container.startedAt ?? new Date(),
        // F11 (2026-05-19) — stop endpoint writes stoppedAt; start must clear
        // it. `containerStatusFromRow` short-circuits to 'stopped' whenever
        // stoppedAt is non-null (DB row is the SoT for lifecycle), so without
        // this reset the device list would show "running" raw status but
        // "stopped" derived containerStatus — confusing the UI Start/Stop
        // visibility logic.
        stoppedAt: null,
      },
    });
    logger.info({ id, podName: container.podName }, 'sandbox started');
    return NextResponse.json({ status: 'started' });
  } catch (err) {
    if (err instanceof ProviderError) {
      return NextResponse.json(
        { error: err.code, message: err.message, retriable: err.retriable, providerRef: err.providerRef },
        { status: httpStatusForProviderError(err) },
      );
    }
    logger.error({ err, id, podName: container.podName }, 'sandbox start failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
