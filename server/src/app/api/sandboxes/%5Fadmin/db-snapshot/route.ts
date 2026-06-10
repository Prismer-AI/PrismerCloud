/**
 * GET /api/sandboxes/_admin/db-snapshot — structured forensic DB snapshot.
 *
 * Phase C of the v2.1 unified debug pipeline (docs/release201/06-debug-pipeline-design.md §3.7).
 * Replaces the ad-hoc `scripts/forensics/*.ts` joins. Phase A shipped
 * `entity=workspace`; Phase C extends with `task` / `conversation` / `container`.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other `_admin` routes.
 *
 * Query params:
 *   - entity=workspace|task|conversation|container (required)
 *   - id=<entityId>                                (required)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { logger } from '@/lib/logger';
import {
  checkRateLimit,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';
import {
  getWorkspaceSnapshot,
  getTaskSnapshot,
  getConversationSnapshot,
  getContainerSnapshot,
  WorkspaceSnapshotNotFoundError,
  TaskSnapshotNotFoundError,
  ConversationSnapshotNotFoundError,
  ContainerSnapshotNotFoundError,
} from '@/lib/admin/db-snapshot';

const SUPPORTED_ENTITIES = new Set(['workspace', 'task', 'conversation', 'container']);

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const entity = url.searchParams.get('entity');
  const id = url.searchParams.get('id');

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'db-snapshot',
      filters: { entity, id },
    },
    '[admin-debug] called',
  );

  if (!entity || !id) {
    return NextResponse.json(
      { error: 'bad_request', message: 'entity and id query params required' },
      { status: 400 },
    );
  }

  if (!SUPPORTED_ENTITIES.has(entity)) {
    return NextResponse.json(
      {
        error: 'bad_request',
        message: `unknown entity '${entity}' — expected one of: workspace, task, conversation, container`,
      },
      { status: 400 },
    );
  }

  try {
    if (entity === 'workspace') {
      const snapshot = await getWorkspaceSnapshot(id);
      return withRateLimitHeaders(NextResponse.json(snapshot), rl);
    }
    if (entity === 'task') {
      const snapshot = await getTaskSnapshot(id);
      return withRateLimitHeaders(NextResponse.json(snapshot), rl);
    }
    if (entity === 'conversation') {
      const snapshot = await getConversationSnapshot(id);
      return withRateLimitHeaders(NextResponse.json(snapshot), rl);
    }
    // container
    const snapshot = await getContainerSnapshot(id);
    return withRateLimitHeaders(NextResponse.json(snapshot), rl);
  } catch (err) {
    if (
      err instanceof WorkspaceSnapshotNotFoundError ||
      err instanceof TaskSnapshotNotFoundError ||
      err instanceof ConversationSnapshotNotFoundError ||
      err instanceof ContainerSnapshotNotFoundError
    ) {
      return NextResponse.json(
        { error: 'not_found', message: err.message },
        { status: 404 },
      );
    }
    logger.error({ err, entity, id }, '[admin/db-snapshot] unexpected error');
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
