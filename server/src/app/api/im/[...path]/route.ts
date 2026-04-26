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

  // SSE: pass through the streaming response directly
  if (contentType.includes('text/event-stream')) {
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // Collect Hono response headers to forward (rate limit, cache, custom)
  const forwardHeaders = new Headers();
  response.headers.forEach((value, key) => {
    // Forward rate limit, cache, and custom headers
    if (
      key.startsWith('x-') ||
      key === 'cache-control' ||
      key === 'retry-after' ||
      key === 'deprecation' ||
      key === 'sunset'
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
    // SSE sync/stream uses ?token= query param (EventSource can't set headers)
    const isSyncStream = path === 'sync/stream' && method === 'GET';

    let authHeader = request.headers.get('authorization');
    const originalAuthHeader = authHeader;
    let auth: AuthInfo | null = null;

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

    // Health, register, SSE sync/stream, and public read endpoints bypass apiGuard
    if (!isHealthCheck && !isRegister && !isSyncStream && !isPublicEvolution && !isPublicSkills && !isPublicCommunity) {
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;
      auth = guard.auth;

      // Replace auth header with IM JWT (both API Key and platform JWT users)
      if (guard.auth.authType === 'api_key' && guard.auth.imToken) {
        authHeader = `Bearer ${guard.auth.imToken}`;
      } else if (guard.auth.authType === 'jwt') {
        // Platform JWT is signed by backend — IM server uses a different secret.
        // Generate an IM-compatible JWT so Hono authMiddleware can verify it.
        const { generateIMTokenForUser } = await import('@/lib/api-guard');
        authHeader = `Bearer ${generateIMTokenForUser(guard.auth.userId, guard.auth.email)}`;
      }
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
      startTime,
    };

    const response = await callIMApp(ctx);

    // Post-processing in background (usage recording + agent registration bonus)
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
