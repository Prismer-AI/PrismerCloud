/**
 * GET /api/sandboxes/:id/progress — provisioning progress signal.
 *
 * Lightweight read-only route that returns the current step + history
 * for a container row. Workspace UI and admin/sandbox console both poll
 * this (1s cadence) while a container is mid-provisioning to render the
 * multi-step progress panel without a stream.
 *
 * Returns:
 *   {
 *     id: string,
 *     status: string,        // im_containers.status
 *     step: string | null,   // current in-flight step (NULL = terminal)
 *     history: Array<{       // append-only ordered list
 *       step, status, startedAt, durationMs?, error?
 *     }>,
 *   }
 *
 * Migration 322 added the underlying columns. Polling stops on terminal
 * state (`step === null`) regardless of success/error — the caller infers
 * outcome from `history[history.length-1].status` and `row.status`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { authorizeContainer } from '../../_helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  // authorizeContainer already loaded the row via Prisma but returned a
  // narrow shape. Re-fetch to get the provisioning columns. Cheap — single
  // PK lookup keyed by id we already validated.
  const row = (await prisma.iMContainer.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      provisioningStep: true,
      provisioningHistory: true,
    },
  })) as {
    id: string;
    status: string;
    provisioningStep: string | null;
    provisioningHistory: unknown;
  } | null;

  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({
    id: row.id,
    status: row.status,
    step: row.provisioningStep,
    history: normalizeHistory(row.provisioningHistory),
  });
}

function normalizeHistory(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
