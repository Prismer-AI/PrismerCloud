import { NextRequest, NextResponse } from 'next/server';
import { recordUsageBackground, generateTaskId, PRICING } from '@/lib/usage-recorder';
import { apiGuard } from '@/lib/api-guard';
import type { AuthInfo } from '@/lib/api-guard';
import { logger } from '@/lib/logger';

/**
 * IM API Route — In-process integration
 *
 * Calls the Hono IM app directly via app.fetch() — no HTTP proxy, no separate port.
 * All IM APIs are served on the same port 3000 as Next.js.
 *
 * Auth: Uses unified apiGuard for API Key / JWT validation.
 * API Key users get an IM JWT via guard.auth.imToken.
 */

interface ProxyContext {
  request: NextRequest;
  path: string;
  method: string;
  authHeader: string | null;
  originalAuthHeader: string | null;
  searchParamOverrides?: Record<string, string>;
  startTime: number;
}

/**
 * Call the Hono IM app directly in-process.
 */
async function callIMApp(ctx: ProxyContext): Promise<Response> {
  // Dynamic import to avoid Edge Runtime issues — bootstrap.ts is Node.js only
  const { getIMApp } = await import('@/im/bootstrap');
  const app = getIMApp();

  if (!app) {
    return NextResponse.json({ ok: false, error: 'IM Server not initialized' }, { status: 503 });
  }

  // Build the internal URL for Hono app (hostname doesn't matter, it's in-process)
  const internalUrl = new URL(`http://localhost/api/${ctx.path}`);
  ctx.request.nextUrl.searchParams.forEach((value, key) => {
    internalUrl.searchParams.set(key, value);
  });
  if (ctx.searchParamOverrides) {
    for (const [key, value] of Object.entries(ctx.searchParamOverrides)) {
      internalUrl.searchParams.set(key, value);
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': ctx.request.headers.get('content-type') || 'application/json',
  };
  if (ctx.authHeader) {
    headers['Authorization'] = ctx.authHeader;
  }
  // Forward X-IM-Agent header for multi-agent identity selection
  const imAgent = ctx.request.headers.get('x-im-agent');
  if (imAgent) {
    headers['X-IM-Agent'] = imAgent;
  }
  // Wave-8 W6: forward Range header so /assets/:id can serve partial content
  // for native <video>/<audio> scrubbing.
  const range = ctx.request.headers.get('range');
  if (range) {
    headers['Range'] = range;
  }

  // Build request for Hono
  const init: RequestInit = {
    method: ctx.method,
    headers,
  };

  if (!['GET', 'HEAD'].includes(ctx.method)) {
    try {
      const body = await ctx.request.text();
      if (body) init.body = body;
    } catch {
      // No body
    }
  }

  // Call Hono app directly — in-process, no network
  const honoRequest = new Request(internalUrl.toString(), init);
  const response = await app.fetch(honoRequest);

  // Convert Hono response to NextResponse
  const contentType = response.headers.get('content-type') || '';
  const location = response.headers.get('location');

  // Preserve IM redirects, especially /assets/:id -> S3 presigned URLs.
  // Without forwarding Location, browser preview/download fetches cannot
  // follow object-storage backed assets.
  if (location && response.status >= 300 && response.status < 400) {
    return new NextResponse(null, {
      status: response.status,
      headers: { Location: location },
    });
  }

  // SSE: return the Hono Response directly so the underlying ReadableStream
  // and its initial headers (Content-Type: text/event-stream + Hono's own
  // SSE markers) reach the client without re-buffering. Wrapping in a fresh
  // `new Response(response.body, …)` previously caused header flushing to
  // wait for the first event, which never arrives until a task changes.
  if (contentType.includes('text/event-stream')) {
    return response;
  }

  // Collect Hono response headers to forward (rate limit, cache, custom)
  const forwardHeaders = new Headers();
  response.headers.forEach((value, key) => {
    // Forward rate limit, cache, custom, and Range-related headers (Wave-8 W6).
    if (
      key.startsWith('x-') ||
      key === 'cache-control' ||
      key === 'retry-after' ||
      key === 'deprecation' ||
      key === 'sunset' ||
      key === 'accept-ranges' ||
      key === 'content-range' ||
      key === 'content-length'
    ) {
      forwardHeaders.set(key, value);
    }
  });

  if (contentType.includes('application/json')) {
    const data = await response.json();
    const res = NextResponse.json(data, { status: response.status });
    forwardHeaders.forEach((value, key) => res.headers.set(key, value));
    return res;
  }

  // For binary content (video/audio/pdf/images/etc.) preserve the underlying
  // stream so 206 Partial Content + body bytes pass through unchanged. This is
  // required for native <video>/<audio> seeking against /api/im/assets/:id.
  if (contentType && !contentType.startsWith('text/') && !contentType.includes('xml')) {
    forwardHeaders.set('Content-Type', contentType);
    return new NextResponse(response.body, {
      status: response.status,
      headers: forwardHeaders,
    });
  }

  const text = await response.text();
  forwardHeaders.set('Content-Type', contentType);
  return new NextResponse(text, {
    status: response.status,
    headers: forwardHeaders,
  });
}

/**
 * Handle agent registration bonus credits.
 *
 * When a new agent registers (isNew=true), grant 10000 bonus credits to
 * the owning account. Credits go to the API Key owner's pool (human).
 */
async function handleAgentRegistration(responseData: any, auth: AuthInfo | null): Promise<void> {
  if (!auth) return;
  if (!responseData?.ok || !responseData?.data?.isNew) return;
  if (responseData.data.role !== 'agent') return;

  const userId = parseInt(auth.userId, 10);
  if (isNaN(userId)) return;

  try {
    const { addCredits } = await import('@/lib/db-credits');
    const { FEATURE_FLAGS } = await import('@/lib/feature-flags');

    if (!FEATURE_FLAGS.USER_CREDITS_LOCAL) return;

    await addCredits(
      userId,
      10_000,
      'bonus',
      `Agent registration bonus (${responseData.data.username})`,
      'agent_register',
      responseData.data.imUserId,
    );
    logger.info(
      { module: 'IM Route', userId, agent: responseData.data.username },
      'Granted 10000 credits for new agent registration',
    );
  } catch (err) {
    logger.error({ module: 'IM Route', err }, 'Failed to grant agent registration credits');
  }
}

/**
 * Record usage for IM write operations.
 * Includes agent meta (userId, authType) for dashboard tracking.
 *
 * Only records for cloud-authenticated users (API Key or cloud JWT with numeric userId).
 * IM JWT users (with alphanumeric IM User IDs) are billed at the IM credit level, not cloud.
 */
function recordIMUsage(operation: string, ctx: ProxyContext, responseData: any, auth: AuthInfo | null): void {
  if (!responseData?.ok && !responseData?.success) return;

  // Skip recording for non-cloud users (IM JWT with non-numeric userId)
  if (!auth) return;
  const numericUserId = parseInt(auth.userId, 10);
  if (isNaN(numericUserId)) return;

  const processingTime = Date.now() - ctx.startTime;
  const taskType: string = 'send';
  let totalCredits = 0;

  // Credit cost mapping (mirrors IM-layer credit-billing middleware)
  const costMap: Array<[RegExp, string, number]> = [
    [/messages/, 'POST', 0.001],
    [/direct\/.*\/messages/, 'POST', 0.001],
    [/groups\/.*\/messages/, 'POST', 0.001],
    [/workspace\/init/, 'POST', 0.01],
    [/groups$/, 'POST', 0.01],
    [/evolution\/analyze/, 'POST', 0.001],
    [/evolution\/record/, 'POST', 0.001],
    [/evolution\/report/, 'POST', 0.002],
    [/evolution\/genes$/, 'POST', 0.005],
    [/evolution\/sync/, 'POST', 0.001],
    [/memory\/files/, 'POST', 0.001],
    [/recall/, 'GET', 0.001],
    [/skills\/.*\/install/, 'POST', 0.002],
    [/tasks$/, 'POST', 0.001],
    [/reports$/, 'POST', 0.01],
  ];

  for (const [pattern, method, cost] of costMap) {
    if (pattern.test(operation) && ctx.method === method) {
      totalCredits = cost;
      break;
    }
  }
  if (totalCredits === 0) return; // Free operation

  // Build input value with agent meta
  const inputValue = `${ctx.path} [user:${auth.userId}, auth:${auth.authType}]`;

  recordUsageBackground(
    {
      task_id: generateTaskId('im'),
      task_type: taskType as any,
      input: { type: 'content', value: inputValue },
      metrics: { processing_time_ms: processingTime },
      cost: { total_credits: totalCredits },
    },
    ctx.originalAuthHeader,
  );
}

async function handleRequest(request: NextRequest, params: { path: string[] }): Promise<Response> {
  const startTime = Date.now();

  try {
    const path = params.path.join('/');
    const method = request.method;
    const isHealthCheck = path === 'health';
    const isRegister = path === 'register' && method === 'POST';
    // SSE endpoints: EventSource cannot set Authorization headers, so they
    // pass the bearer in `?token=` and verify it inside the Hono handler
    // (against the same JWT_SECRET — see src/im/api/tasks.ts SSE handler).
    // apiGuard would reject these for missing Authorization header.
    const isSyncStream = path === 'sync/stream' && method === 'GET';
    const isTaskEvents = path === 'tasks/events' && method === 'GET';
    const isSSEStream = isSyncStream || isTaskEvents;

    let authHeader = request.headers.get('authorization');
    const originalAuthHeader = authHeader;
    let auth: AuthInfo | null = null;
    let searchParamOverrides: Record<string, string> | undefined;

    // Public endpoints bypass auth (no login required)
    const isPublicEvolution =
      path.startsWith('evolution/public/') ||
      (path.startsWith('evolution/leaderboard/') && method === 'GET' && path !== 'evolution/leaderboard/agents/me') ||
      (path.startsWith('evolution/profile/') && method === 'GET') ||
      (path === 'evolution/benchmark' && method === 'GET') ||
      path === 'evolution/map' ||
      path === 'evolution/stories' ||
      (path === 'evolution/metrics' && method === 'GET') ||
      (path.startsWith('evolution/highlights/') && method === 'GET') ||
      (path === 'evolution/card/render' && method === 'POST');
    // Public skills routes: search, stats, categories, trending, detail, related
    // Auth-required: installed, created, content, install, uninstall, star, import
    const isPublicSkills =
      path.startsWith('skills/') &&
      method === 'GET' &&
      path !== 'skills/installed' &&
      path !== 'skills/created' &&
      !path.endsWith('/content');
    // Public community routes: posts list, post detail, comments, stats, search, tags, hot, boards, suggest, autocomplete
    // Auth-required: create/update/delete post/comment, vote, bookmark, notifications
    const isPublicCommunity =
      method === 'GET' &&
      (path === 'community/posts' ||
        /^community\/posts\/[^/]+$/.test(path) ||
        /^community\/posts\/[^/]+\/comments$/.test(path) ||
        path === 'community/stats' ||
        path === 'community/search' ||
        path.startsWith('community/tags/') ||
        path === 'community/hot' ||
        path === 'community/search/suggest' ||
        path.startsWith('community/boards') ||
        path.startsWith('community/autocomplete/'));

    // QR-pair bootstrap (v1.9.3 Track C, Cloud 4): the daemon has no API key
    // until pair/poll completes, so /pair/offer and /pair/poll/:nonce must
    // bypass apiGuard. /pair/approve stays auth-required — that's the mobile-
    // user-clicks-Approve step and is enforced inside the Hono router.
    // /pair/local-only-approve (Wave-6 α) replaces /pair/approve in LAN-dev
    // mode and gates itself on `LOCAL_ONLY=1 && NODE_ENV !== 'production'`
    // inside the Hono handler — apiGuard would reject it for missing
    // Authorization, so we bypass apiGuard here and let the route's own
    // gate decide.
    const isPublicPair =
      (path === 'pair/offer' && method === 'POST') ||
      (/^pair\/poll\/[^/]+$/.test(path) && method === 'GET') ||
      (path === 'pair/local-only-approve' && method === 'POST');

    // Health, register, SSE streams, and public read endpoints bypass normal
    // header auth. SSE handlers verify `?token=` themselves; API keys in that
    // query param are translated here because EventSource cannot attach an
    // Authorization header for the usual apiGuard path.
    if (isSSEStream) {
      const queryToken = request.nextUrl.searchParams.get('token');
      if (queryToken?.startsWith('sk-prismer-')) {
        const headers = new Headers(request.headers);
        headers.set('authorization', `Bearer ${queryToken}`);
        const guardRequest = new NextRequest(request.url, { headers, method: request.method });
        const guard = await apiGuard(guardRequest, { tier: 'tracked' });
        if (!guard.ok) return guard.response;
        auth = guard.auth;
        if (guard.auth.imToken) {
          authHeader = `Bearer ${guard.auth.imToken}`;
          searchParamOverrides = { token: guard.auth.imToken };
        }
      }
    } else if (
      !isHealthCheck &&
      !isRegister &&
      !isSSEStream &&
      !isPublicEvolution &&
      !isPublicSkills &&
      !isPublicCommunity &&
      !isPublicPair
    ) {
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;
      auth = guard.auth;

      // Replace auth header with IM JWT for API Key users (translation needed).
      // Platform JWT users keep their original Bearer header — native auth
      // (Cloud 1, 54release) signs platform JWT with the same JWT_SECRET that
      // the IM Hono authMiddleware uses, and `sub` is already the IMUser.id.
      // Regenerating into an api_key_proxy IM token caused authMiddleware to
      // call ensureIMUser(payload.sub) where sub is the IMUser.id, treating
      // it as a cloud-user-id — which silently auto-created a phantom IMUser
      // and made workspace queries return [] for the real owner.
      if (guard.auth.authType === 'api_key' && guard.auth.imToken) {
        authHeader = `Bearer ${guard.auth.imToken}`;
      }
      // jwt: leave authHeader as the original Bearer (forward-as-is)
    } else if (isRegister && authHeader) {
      // Register with API Key: optional auth for binding agent to human
      try {
        const guard = await apiGuard(request, { tier: 'tracked' });
        if (guard.ok) {
          auth = guard.auth;
          if (guard.auth.authType === 'api_key' && guard.auth.imToken) {
            authHeader = `Bearer ${guard.auth.imToken}`;
          }
        }
      } catch {
        // Auth failed — proceed as anonymous registration
      }
    }

    const ctx: ProxyContext = {
      request,
      path,
      method,
      authHeader,
      originalAuthHeader,
      searchParamOverrides,
      startTime,
    };

    const response = await callIMApp(ctx);

    // Post-processing in background (usage recording + agent registration bonus).
    // Skip for SSE streams: `.clone().json()` would hang forever waiting for
    // an end-of-stream that never arrives, and SSE traffic is per-connection
    // (one open stream, not per-message), so usage accounting doesn't apply.
    const responseContentType = response.headers.get('content-type') || '';
    if (!responseContentType.includes('text/event-stream')) {
      try {
        const responseClone = response.clone();
        const data = await responseClone.json();
        recordIMUsage(path, ctx, data, auth);

        // Agent registration → bonus credits
        if (path === 'register' && method === 'POST') {
          handleAgentRegistration(data, auth).catch(() => {});
        }
      } catch {
        // Ignore post-processing errors
      }
    }

    return response;
  } catch (error) {
    logger.error({ module: 'IM Route', err: error }, 'Request handling error');
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'IM_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}
