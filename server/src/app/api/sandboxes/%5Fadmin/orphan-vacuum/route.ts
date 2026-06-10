/**
 * GET  /api/sandboxes/_admin/orphan-vacuum — preview (per-table counts).
 * POST /api/sandboxes/_admin/orphan-vacuum — execute the vacuum.
 *
 * Cleans up rows whose `workspaceId` (or chain FK) points to a parent
 * row that no longer exists. Pre-existing residue from e2e harnesses
 * that called `DELETE FROM im_workspaces` without cascading. New
 * workspace deletions go through `workspace-clear.service.ts` which
 * already cascades correctly; this is a one-shot history cleanup.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other _admin routes.
 *
 * POST body (optional):
 *   { "onlyTables": ["im_memory_files", "im_genes"] }
 *
 * Without `onlyTables` the full target list runs.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { logger } from '@/lib/logger';
import {
  previewOrphanVacuum,
  executeOrphanVacuum,
} from '@/lib/orphan-vacuum';

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!isSandboxAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const data = await previewOrphanVacuum();
    return NextResponse.json(data);
  } catch (err) {
    logger.error({ err }, '[admin/orphan-vacuum] preview failed');
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth();
  if (!isSandboxAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  let onlyTables: string[] | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { onlyTables?: unknown };
    if (Array.isArray(body.onlyTables)) {
      const filtered = body.onlyTables.filter((t): t is string => typeof t === 'string' && t.length > 0);
      if (filtered.length > 0) onlyTables = filtered;
    }
  } catch {
    // Empty / non-JSON body — treat as "vacuum all tables".
  }
  try {
    const result = await executeOrphanVacuum({ onlyTables });
    logger.info(
      { admin: session?.user?.email, totalDeleted: result.totalDeleted, durationMs: result.durationMs, onlyTables },
      '[admin/orphan-vacuum] completed',
    );
    return NextResponse.json(result);
  } catch (err) {
    logger.error({ err }, '[admin/orphan-vacuum] execute failed');
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
