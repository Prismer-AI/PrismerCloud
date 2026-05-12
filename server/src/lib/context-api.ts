/**
 * Context API 适配层 (v1.6.0)
 *
 * Feature-flag controlled:
 *   FF_CONTEXT_CACHE_LOCAL=true  → Prisma local cache (primary) + backend fallback (warm migration)
 *   FF_CONTEXT_CACHE_LOCAL=false → Backend API only (legacy)
 *
 * 后端实际行为（经测试验证）：
 *   - withdraw: { raw_link, format } — format 必须小写 "hqcc"
 *   - withdraw/batch: 后端有 bug，改用并发单条 withdraw
 *   - deposit: { raw_link, hqcc_content, intr_content, visibility, meta } — visibility 必填
 */

import { getBackendApiBase } from './backend-api';
import { FEATURE_FLAGS } from './feature-flags';
import { contextCacheService } from './context-cache.service';

// ============================================================================
// Types (unchanged — callers don't need modification)
// ============================================================================

export interface WithdrawRequest {
  url: string;
  format?: 'hqcc' | 'intr' | 'both';
}

export interface WithdrawResponse {
  found: boolean;
  raw_link?: string;
  content_uri?: string;
  hqcc_content?: string;
  intr_content?: string;
  meta?: Record<string, unknown>;
  visibility?: string;
}

export interface WithdrawBatchRequest {
  urls: string[];
  format?: 'hqcc' | 'intr' | 'both';
  embed?: boolean;
}

export interface WithdrawBatchResponse {
  results: Array<{
    raw_link: string;
    found: boolean;
    hqcc_content?: string;
    intr_content?: string;
    meta?: Record<string, unknown>;
  }>;
  summary?: {
    total: number;
    found: number;
    not_found: number;
  };
}

export interface DepositRequest {
  url?: string | null;
  hqcc: string;
  raw?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  meta?: Record<string, unknown>;
  tags?: string[];
}

export interface DepositResponse {
  status: string;
  content_uri?: string;
  raw_link?: string;
  visibility?: string;
  meta?: Record<string, unknown>;
}

// ============================================================================
// Withdraw API
// ============================================================================

/**
 * Withdraw from context cache.
 * When FF_CONTEXT_CACHE_LOCAL=true: local Prisma → backend fallback (warm migration)
 */
export async function withdraw(
  request: WithdrawRequest,
  authHeader?: string | null,
  userId?: string,
): Promise<{ ok: boolean; data: WithdrawResponse | null; error?: string }> {
  if (FEATURE_FLAGS.CONTEXT_CACHE_LOCAL && userId) {
    return withdrawLocal(request, userId, authHeader);
  }
  return withdrawBackend(request, authHeader);
}

async function withdrawLocal(
  request: WithdrawRequest,
  userId: string,
  authHeader?: string | null,
): Promise<{ ok: boolean; data: WithdrawResponse | null; error?: string }> {
  try {
    // 1. Try local Prisma cache
    const localResult = await contextCacheService.withdraw({ rawLink: request.url, format: request.format }, userId);

    if (localResult.found) {
      console.log(`[ContextAPI] Local cache HIT: ${request.url.substring(0, 60)}`);
      return { ok: true, data: localResult };
    }

    // 2. Fallback to backend (warm migration) — skip in self-host mode
    const backendBase = await getBackendApiBase();
    if (backendBase && authHeader) {
      const backendResult = await withdrawBackend(request, authHeader);
      if (backendResult.ok && backendResult.data?.found && backendResult.data?.hqcc_content) {
        console.log(`[ContextAPI] Backend HIT, writing back to local: ${request.url.substring(0, 60)}`);

        contextCacheService
          .deposit({
            userId,
            rawLink: request.url,
            hqccContent: backendResult.data.hqcc_content,
            intrContent: backendResult.data.intr_content,
            visibility: (backendResult.data.visibility as 'public' | 'private' | 'unlisted') || 'public',
            meta: backendResult.data.meta as Record<string, unknown>,
          })
          .catch((err) => console.error('[ContextAPI] Warm migration write-back failed:', err));

        return backendResult;
      }
    }

    console.log(`[ContextAPI] MISS: ${request.url.substring(0, 60)}`);
    return { ok: true, data: { found: false } };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ContextAPI] Local withdraw error:`, errorMsg);
    // Fallback to backend on local error
    if (authHeader) {
      return withdrawBackend(request, authHeader);
    }
    return { ok: false, data: null, error: errorMsg };
  }
}

async function withdrawBackend(
  request: WithdrawRequest,
  authHeader?: string | null,
): Promise<{ ok: boolean; data: WithdrawResponse | null; error?: string }> {
  const backendBase = await getBackendApiBase();
  const format = request.format || 'hqcc';

  try {
    const res = await fetch(`${backendBase}/cloud/context/withdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({ raw_link: request.url, format }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorMsg = errorData.error?.msg || `HTTP ${res.status}`;
      console.error(`[ContextAPI] Backend withdraw failed:`, errorMsg);
      return { ok: false, data: null, error: errorMsg };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ContextAPI] Backend withdraw error:`, errorMsg);
    return { ok: false, data: null, error: errorMsg };
  }
}

// ============================================================================
// Withdraw Batch API
// ============================================================================

/**
 * Batch withdraw.
 * When FF_CONTEXT_CACHE_LOCAL=true: single Prisma findMany (~10ms for any batch size)
 * When false: parallel single backend withdraws (N HTTP requests)
 */
export async function withdrawBatch(
  request: WithdrawBatchRequest,
  authHeader?: string | null,
  userId?: string,
): Promise<{ ok: boolean; data: WithdrawBatchResponse | null; error?: string }> {
  if (FEATURE_FLAGS.CONTEXT_CACHE_LOCAL && userId) {
    return withdrawBatchLocal(request, userId, authHeader);
  }
  return withdrawBatchBackend(request, authHeader);
}

async function withdrawBatchLocal(
  request: WithdrawBatchRequest,
  userId: string,
  authHeader?: string | null,
): Promise<{ ok: boolean; data: WithdrawBatchResponse | null; error?: string }> {
  try {
    // 1. Batch query local Prisma (single SQL WHERE IN)
    const localResult = await contextCacheService.withdrawBatch(request.urls, userId, request.format);

    // 2. Find URLs that missed locally
    const missedUrls = localResult.results.filter((r) => !r.found).map((r) => r.raw_link);

    // 3. Warm migration: fetch missed from backend
    if (missedUrls.length > 0 && authHeader) {
      console.log(`[ContextAPI] Batch: ${localResult.summary.found} local hits, ${missedUrls.length} backend fallback`);

      const backendResult = await withdrawBatchBackend({ urls: missedUrls, format: request.format }, authHeader);

      if (backendResult.ok && backendResult.data) {
        // Merge backend hits into results + write-back
        const backendMap = new Map(
          backendResult.data.results.filter((r) => r.found && r.hqcc_content).map((r) => [r.raw_link, r]),
        );

        for (const result of localResult.results) {
          if (!result.found && backendMap.has(result.raw_link)) {
            const backendEntry = backendMap.get(result.raw_link)!;
            Object.assign(result, backendEntry);

            // Background write-back
            contextCacheService
              .deposit({
                userId,
                rawLink: result.raw_link,
                hqccContent: backendEntry.hqcc_content!,
                intrContent: backendEntry.intr_content,
                visibility: 'public',
                meta: backendEntry.meta as Record<string, unknown>,
              })
              .catch((err) => console.error('[ContextAPI] Batch write-back failed:', err));
          }
        }

        // Recalculate summary
        const found = localResult.results.filter((r) => r.found).length;
        localResult.summary = {
          total: request.urls.length,
          found,
          not_found: request.urls.length - found,
        };
      }
    }

    return { ok: true, data: localResult };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ContextAPI] Local batch withdraw error:`, errorMsg);
    if (authHeader) {
      return withdrawBatchBackend(request, authHeader);
    }
    return { ok: false, data: null, error: errorMsg };
  }
}

async function withdrawBatchBackend(
  request: WithdrawBatchRequest,
  authHeader?: string | null,
): Promise<{ ok: boolean; data: WithdrawBatchResponse | null; error?: string }> {
  console.log(`[ContextAPI] withdrawBatch backend (parallel singles):`, { count: request.urls.length });

  const settled = await Promise.allSettled(
    request.urls.map((url) => withdrawBackend({ url, format: request.format }, authHeader)),
  );

  const results = request.urls.map((url, i) => {
    const result = settled[i];
    if (result.status === 'fulfilled' && result.value.ok && result.value.data) {
      return {
        raw_link: url,
        found: result.value.data.found,
        hqcc_content: result.value.data.hqcc_content,
        intr_content: result.value.data.intr_content,
        meta: result.value.data.meta,
      };
    }
    return { raw_link: url, found: false };
  });

  const foundCount = results.filter((r) => r.found).length;

  return {
    ok: true,
    data: {
      results,
      summary: {
        total: request.urls.length,
        found: foundCount,
        not_found: request.urls.length - foundCount,
      },
    },
  };
}

// ============================================================================
// Deposit API
// ============================================================================

/**
 * Deposit content to cache.
 * When FF_CONTEXT_CACHE_LOCAL=true: local Prisma (primary) + background backend dual-write
 */
export async function deposit(
  request: DepositRequest,
  authHeader?: string | null,
  userId?: string,
): Promise<{ ok: boolean; data: DepositResponse | null; error?: string }> {
  if (FEATURE_FLAGS.CONTEXT_CACHE_LOCAL && userId && request.url) {
    return depositLocal(request, userId, authHeader);
  }
  return depositBackend(request, authHeader);
}

async function depositLocal(
  request: DepositRequest,
  userId: string,
  authHeader?: string | null,
): Promise<{ ok: boolean; data: DepositResponse | null; error?: string }> {
  const backendBase = await getBackendApiBase();
  try {
    // 1. Write to local Prisma (primary, sync)
    const result = await contextCacheService.deposit({
      userId,
      rawLink: request.url!,
      hqccContent: request.hqcc,
      intrContent: request.raw,
      visibility: request.visibility || 'public',
      meta: request.meta,
      tags: request.tags,
    });

    console.log(`[ContextAPI] Local deposit ${result.status}: ${request.url?.substring(0, 60)}`);

    // 2. Background dual-write to backend (skip in self-host mode)
    if (backendBase && authHeader) {
      depositBackend(request, authHeader).catch((err) =>
        console.error('[ContextAPI] Backend dual-write failed (non-blocking):', err),
      );
    }

    return {
      ok: true,
      data: {
        status: result.status,
        content_uri: result.contentUri,
        raw_link: request.url || undefined,
        visibility: request.visibility || 'public',
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ContextAPI] Local deposit error:`, errorMsg);
    // Fallback to backend on local error (skip in self-host mode)
    if (backendBase && authHeader) {
      return depositBackend(request, authHeader);
    }
    return { ok: false, data: null, error: errorMsg };
  }
}

async function depositBackend(
  request: DepositRequest,
  authHeader?: string | null,
): Promise<{ ok: boolean; data: DepositResponse | null; error?: string }> {
  const backendBase = await getBackendApiBase();

  try {
    const res = await fetch(`${backendBase}/cloud/context/deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        raw_link: request.url,
        hqcc_content: request.hqcc,
        intr_content: request.raw,
        visibility: request.visibility || 'public',
        meta: request.meta || {},
      }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorMsg = errorData.error?.msg || `HTTP ${res.status}`;
      console.error(`[ContextAPI] Backend deposit failed:`, errorMsg);
      return { ok: false, data: null, error: errorMsg };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ContextAPI] Backend deposit error:`, errorMsg);
    return { ok: false, data: null, error: errorMsg };
  }
}
