/**
 * POST /api/admin/client-log
 *
 * release201/30 §7 Phase 3 — frontend critical-error sink.
 *
 * Frontend fires this when it hits user-visible inconsistency that the cloud
 * already has no way to detect:
 *   - AssetCard renders fallback "[文件丢失]" (file deleted between send and
 *     render, or attachments[] hydration race)
 *   - ConsistencyError: type='file' message arriving without both
 *     attachments[] AND legacy metadata.fileUrl
 *   - upload retry exhausted after N attempts
 *
 * The client-side log mirrors into the same cloud pino ring buffer that the
 * debug-pipeline (`/api/sandboxes/_admin/system-logs`) exposes, so a single
 * traceId grep gives the full story (cloud + client-side warn).
 *
 * Auth: tier 'tracked' (every signed-in user) — this is observability, not a
 * privileged action. The payload is bounded + scrubbed before logging.
 *
 * Body: {
 *   level: 'warn' | 'error',
 *   msg: string,                  // ≤1 KB, trimmed
 *   traceId?: string,             // matches X-Prismer-Trace-Id wire shape
 *   meta?: Record<string, unknown>// caller context (≤4 KB total JSON)
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { logger } from '@/lib/logger';
import { isValidTraceId } from '@/lib/trace-id';

const MAX_MSG_LEN = 1000;
const MAX_BODY_BYTES = 4 * 1024;

interface ClientLogBody {
  level?: string;
  msg?: string;
  traceId?: string;
  meta?: Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  const guard = await apiGuard(request, { tier: 'tracked' });
  if (!guard.ok) return guard.response;

  // Bound body size BEFORE JSON.parse — the route accepts only small log
  // payloads. We clone the request to keep the original stream untouched in
  // case a higher-level middleware (none today, but future-proof) reads it.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'BAD_REQUEST', message: 'unreadable body' } },
      { status: 400 },
    );
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: { code: 'BODY_TOO_LARGE', message: `>${MAX_BODY_BYTES} bytes` } },
      { status: 413 },
    );
  }

  let body: ClientLogBody;
  try {
    body = JSON.parse(raw || '{}') as ClientLogBody;
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'BAD_REQUEST', message: 'invalid_json' } },
      { status: 400 },
    );
  }

  const level: 'warn' | 'error' = body.level === 'error' ? 'error' : 'warn';
  const msg = String(body.msg ?? '').slice(0, MAX_MSG_LEN).trim();
  if (!msg) {
    return NextResponse.json(
      { success: false, error: { code: 'BAD_REQUEST', message: 'msg required' } },
      { status: 400 },
    );
  }
  // Defensive: only pass through trace ids matching our wire shape. Anything
  // else gets dropped (cloud has no use for free-form client junk in the
  // structured field) — the msg field still preserves whatever the client
  // wanted to say, just without contaminating the indexable id.
  const traceId =
    body.traceId && typeof body.traceId === 'string' && isValidTraceId(body.traceId)
      ? body.traceId
      : undefined;
  const meta =
    body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
      ? (body.meta as Record<string, unknown>)
      : {};

  // Use the dynamic pino level dispatch. Both 'warn' and 'error' are
  // structured records, so `[client-log]` appears in `component` (queryable
  // via the debug-pipeline system-logs endpoint).
  logger[level](
    {
      component: '[client-log]',
      traceId,
      userId: guard.auth.userId,
      authType: guard.auth.authType,
      meta,
    },
    msg,
  );

  return NextResponse.json({ success: true, traceId });
}
