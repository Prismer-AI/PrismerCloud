import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { detectInputType, validateInput } from '@/lib/input-detector';
import { createRanker, RankableItem, RankingConfig } from '@/lib/ranking';
import { generateTaskId, createLoadUsageRecord, recordUsageBackground, UsageSource } from '@/lib/usage-recorder';
import { withdraw, withdrawBatch, deposit } from '@/lib/context-api';
import { extractMeta } from '@/lib/context-meta';
import { apiGuard } from '@/lib/api-guard';
import { metrics } from '@/lib/metrics';

/** Internal base URL for service-to-service calls. Never derived from request headers. */
function getInternalBaseUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
}

/**
 * POST /api/context/load
 * POST /api/context/load?stream=true
 *
 * 统一加载 API - 智能处理 URL 或 Query
 *
 * 三种模式:
 * 1. 单 URL: { input: "https://..." }
 * 2. 批量 URL: { input: ["url1", "url2", ...] }
 * 3. Query 搜索: { input: "search query text" }
 *
 * 自动检测输入类型，或通过 inputType 强制指定
 *
 * 认证: 必需 (API Key 或 JWT) — billable
 */

export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  // Auth + balance pre-check
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;
  const isStream = request.nextUrl.searchParams.get('stream') === 'true';

  try {
    const body = await request.json();
    const {
      input,
      inputType: forceType,
      processUncached = false,
      search,
      processing,
      return: returnConfig,
      ranking,
    } = body;

    console.log('[Load API] POST received:', {
      input: typeof input === 'string' ? input.substring(0, 100) : input,
      inputType: forceType,
      isStream,
    });

    // 1. 验证输入
    const validation = validateInput(input);
    if (!validation.valid) {
      console.log('[Load API] Validation failed:', validation.error);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_INPUT', message: validation.error },
        },
        { status: 400 },
      );
    }

    // 2. 检测输入类型
    const detection = detectInputType(input, forceType);
    console.log('[Load API] Input detected as:', detection.type);

    // 3. 根据类型分流处理
    const userId = guard.auth.userId;
    let result: NextResponse | Response;
    switch (detection.type) {
      case 'single_url':
        result = await handleSingleUrl(request, detection.urls![0], processing, returnConfig, userId);
        break;

      case 'batch_urls':
        result = await handleBatchUrls(request, detection.urls!, processUncached, processing, returnConfig, userId);
        break;

      case 'prismer_uri':
        result = await handlePrismerUri(request, detection.urls![0], returnConfig, userId);
        break;

      case 'query':
        if (isStream) {
          result = await handleQueryStream(
            request,
            detection.query!,
            search,
            processing,
            returnConfig,
            ranking,
            userId,
          );
        } else {
          result = await handleQuery(request, detection.query!, search, processing, returnConfig, ranking, userId);
        }
        break;

      default:
        result = NextResponse.json(
          {
            success: false,
            error: { code: 'UNKNOWN_INPUT_TYPE', message: 'Could not determine input type' },
          },
          { status: 400 },
        );
    }
    metrics.recordRequest('/api/context/load', Date.now() - reqStart, result.status);
    return result;
  } catch (error) {
    metrics.recordRequest('/api/context/load', Date.now() - reqStart, 500);
    console.error('[Load API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to process request' },
      },
      { status: 500 },
    );
  }
}

/**
 * 处理单个 URL
 */
async function handleSingleUrl(
  request: NextRequest,
  url: string,
  processing?: any,
  returnConfig?: any,
  userId?: string,
): Promise<NextResponse> {
  const startTime = Date.now();
  const authHeader = request.headers.get('authorization');
  const baseUrl = getInternalBaseUrl();
  const strategy = processing?.strategy || 'auto';
  const taskId = generateTaskId('load_url');

  try {
    // Step 1: 检查缓存
    // 注意：后端 withdraw 不支持 format:'both'，只支持 'hqcc' 或 'intr'
    // 如果用户要 both，我们先拿 hqcc，intr_content 从缓存中获取或返回 raw
    const cacheFormat =
      returnConfig?.format === 'both' || returnConfig?.format === 'raw' ? 'hqcc' : returnConfig?.format || 'hqcc';
    console.log(`[handleSingleUrl] Checking cache for ${url}...`);
    const withdrawResult = await withdraw({ url, format: cacheFormat as 'hqcc' | 'intr' }, authHeader, userId);

    console.log(`[handleSingleUrl] Cache check result:`, {
      ok: withdrawResult.ok,
      found: withdrawResult.data?.found,
      hasHqcc: !!withdrawResult.data?.hqcc_content,
    });

    if (withdrawResult.ok && withdrawResult.data?.found && withdrawResult.data?.hqcc_content) {
      const data = withdrawResult.data;
      // 缓存命中且有有效内容 - 记录使用量 (免费)
      recordUsageBackground(
        createLoadUsageRecord({
          taskId,
          input: url,
          inputType: 'url',
          searchCount: 0,
          urlsProcessed: 1,
          urlsCached: 1,
          urlsCompressed: 0,
          processingTimeMs: Date.now() - startTime,
          sources: [{ url, cached: true, tokens: 0 }],
        }),
        authHeader,
      );

      return NextResponse.json({
        success: true,
        requestId: taskId,
        mode: 'single_url',
        result: {
          url,
          title: data.meta?.title || url,
          hqcc: data.hqcc_content,
          raw: returnConfig?.format === 'both' ? data.intr_content : undefined,
          cached: true,
          cachedAt: data.meta?.cached_at,
          meta: data.meta,
        },
        cost: { credits: 0, cached: true },
        processingTime: Date.now() - startTime,
      });
    }

    // Step 2: 缓存未命中 - 获取 URL 内容
    console.log(`[handleSingleUrl] Cache miss for ${url}, fetching content...`);

    const contentRes = await fetch(`${baseUrl}/api/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    });

    if (!contentRes.ok) {
      const errorData = await contentRes.json().catch(() => ({}));
      console.error('[handleSingleUrl] Content fetch failed:', errorData);
      const reason = contentRes.status === 503
        ? (errorData.error || 'Content fetching service not configured')
        : 'Failed to fetch URL content';
      return NextResponse.json({
        success: false,
        requestId: taskId,
        mode: 'single_url',
        result: {
          url,
          cached: false,
          hqcc: null,
          error: reason,
        },
        cost: { credits: 0, cached: false },
        processingTime: Date.now() - startTime,
      }, { status: contentRes.status === 503 ? 503 : 200 });
    }

    const contentData = await contentRes.json();

    if (!contentData.results || contentData.results.length === 0 || !contentData.results[0].text) {
      console.log('[handleSingleUrl] No content found for URL');
      return NextResponse.json({
        success: true,
        requestId: `load_${Date.now().toString(36)}`,
        mode: 'single_url',
        result: {
          url,
          cached: false,
          hqcc: null,
          error: 'No extractable content found at URL',
        },
        cost: { credits: 0, cached: false },
        processingTime: Date.now() - startTime,
      });
    }

    const content = contentData.results[0];

    // 检查内容质量（太短的内容可能是抓取失败）
    const MIN_URL_CONTENT_LENGTH = 500;
    if (content.text.length < MIN_URL_CONTENT_LENGTH) {
      console.log(`[handleSingleUrl] Content too short: ${content.text.length} chars (< ${MIN_URL_CONTENT_LENGTH})`);
      return NextResponse.json({
        success: true,
        requestId: taskId,
        mode: 'single_url',
        result: {
          url,
          cached: false,
          hqcc: null,
          raw: returnConfig?.format === 'both' ? content.text : undefined,
          error: `Content too short (${content.text.length} characters)`,
        },
        cost: { credits: 0, cached: false },
        processingTime: Date.now() - startTime,
      });
    }

    // Step 3: 压缩内容
    console.log(`[handleSingleUrl] Compressing content (${content.text.length} chars)...`);

    const compressRes = await fetch(`${baseUrl}/api/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: content.text,
        url: content.url || url,
        title: content.title,
        strategy,
        imageLinks: content.imageLinks || [],
      }),
    });

    if (!compressRes.ok) {
      console.error('[handleSingleUrl] Compression failed');
      return NextResponse.json({
        success: true,
        requestId: `load_${Date.now().toString(36)}`,
        mode: 'single_url',
        result: {
          url,
          cached: false,
          hqcc: null,
          raw: returnConfig?.format === 'both' || returnConfig?.format === 'raw' ? content.text : undefined,
          error: 'Content compression failed',
        },
        cost: { credits: 0, cached: false },
        processingTime: Date.now() - startTime,
      });
    }

    const compressData = await compressRes.json();

    // Step 4: 提取元数据 + 后台存储
    const extracted = extractMeta(compressData.hqcc);
    const cleanedHqcc = extracted.hqcc;
    if (authHeader && cleanedHqcc) {
      console.log('[handleSingleUrl] Depositing to Context Server (background)...');
      deposit(
        {
          url,
          hqcc: cleanedHqcc,
          raw: content.text,
          visibility: 'public',
          tags: extracted.keywords,
          meta: {
            strategy,
            model: compressData.model,
            source: 'load_api',
            title: extracted.title || content.title,
            image_links: content.imageLinks || [],
            processed_at: new Date().toISOString(),
          },
        },
        authHeader,
        userId,
      )
        .then((result) => {
          if (result.ok) {
            console.log('[handleSingleUrl] Deposit SUCCESS:', { url, data: result.data });
          } else {
            console.error('[handleSingleUrl] Deposit FAILED:', { url, error: result.error });
          }
        })
        .catch((err) => console.error('[handleSingleUrl] Deposit ERROR:', err));
    }

    // Step 5: 记录使用量
    const processingTime = Date.now() - startTime;
    recordUsageBackground(
      createLoadUsageRecord({
        taskId,
        input: url,
        inputType: 'url',
        searchCount: 0,
        urlsProcessed: 1,
        urlsCached: 0,
        urlsCompressed: 1,
        tokensInput: Math.round(content.text.length / 4), // 估算 tokens (整数)
        tokensOutput: Math.round(compressData.hqcc.length / 4),
        processingTimeMs: processingTime,
        sources: [{ url, cached: false, tokens: Math.round(content.text.length / 4) }],
      }),
      authHeader,
    );

    // Step 6: 返回结果
    return NextResponse.json({
      success: true,
      requestId: taskId,
      mode: 'single_url',
      result: {
        url,
        title: extracted.title || content.title,
        hqcc: cleanedHqcc,
        raw: returnConfig?.format === 'both' ? content.text : undefined,
        cached: false,
        meta: {
          strategy,
          model: compressData.model,
          source: 'load_api',
        },
      },
      cost: { credits: 0.5, cached: false },
      processingTime,
    });
  } catch (error) {
    console.error('[handleSingleUrl] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROCESS_ERROR', message: 'Failed to load URL' },
      },
      { status: 500 },
    );
  }
}

/**
 * 处理批量 URL
 */
async function handleBatchUrls(
  request: NextRequest,
  urls: string[],
  processUncached: boolean,
  processing?: any,
  returnConfig?: any,
  userId?: string,
): Promise<NextResponse> {
  const startTime = Date.now();
  const authHeader = request.headers.get('authorization');
  const baseUrl = getInternalBaseUrl();
  const maxConcurrent = processing?.maxConcurrent || 3;
  const strategy = processing?.strategy || 'auto';
  const taskId = generateTaskId('load_batch');

  try {
    // 批量检查缓存
    // 注意：后端不支持 format:'both'，只支持 'hqcc' 或 'intr'
    const cacheFormat =
      returnConfig?.format === 'both' || returnConfig?.format === 'raw' ? 'hqcc' : returnConfig?.format || 'hqcc';
    const batchResult = await withdrawBatch(
      {
        urls,
        format: cacheFormat as 'hqcc' | 'intr',
        embed: false,
      },
      authHeader,
      userId,
    );

    if (!batchResult.ok || !batchResult.data) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'BACKEND_ERROR', message: batchResult.error || 'Backend error' },
        },
        { status: 500 },
      );
    }

    const batchData = batchResult.data;

    // 构建初始结果
    const results: any[] =
      batchData.results?.map((item: any) => ({
        url: item.raw_link,
        found: item.found,
        cached: item.found,
        hqcc: item.hqcc_content || null,
        raw: returnConfig?.format === 'both' ? item.intr_content : undefined,
        meta: item.meta,
      })) || [];

    // 创建 URL->结果 映射
    const resultMap = new Map<string, any>();
    results.forEach((r) => resultMap.set(r.url, r));

    let compressionCredits = 0;

    // 如果 processUncached=true，处理未命中或内容为空的 URL
    if (processUncached) {
      const uncachedUrls = results.filter((r) => !r.found || !r.hqcc).map((r) => r.url);

      if (uncachedUrls.length > 0) {
        console.log(`[handleBatchUrls] Processing ${uncachedUrls.length} uncached URLs...`);

        // 批量获取内容
        const contentRes = await fetch(`${baseUrl}/api/content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: uncachedUrls }),
        });

        if (contentRes.ok) {
          const contentData = await contentRes.json();
          const contentMap = new Map<string, any>();
          (contentData.results || []).forEach((c: any) => {
            if (c.url && c.text) {
              contentMap.set(c.url, c);
            }
          });

          // 并发压缩
          for (let i = 0; i < uncachedUrls.length; i += maxConcurrent) {
            const batch = uncachedUrls.slice(i, i + maxConcurrent);
            const compressPromises = batch.map(async (url) => {
              const content = contentMap.get(url);
              if (!content) return;

              try {
                const compressRes = await fetch(`${baseUrl}/api/compress`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    content: content.text,
                    url: content.url || url,
                    title: content.title,
                    strategy,
                    imageLinks: content.imageLinks || [],
                  }),
                });

                if (compressRes.ok) {
                  const compressData = await compressRes.json();
                  compressionCredits += 0.5;

                  // 更新结果
                  const existingResult = resultMap.get(url);
                  if (existingResult) {
                    existingResult.hqcc = compressData.hqcc;
                    existingResult.found = true;
                    existingResult.cached = false;
                    existingResult.processed = true;
                    existingResult.meta = { strategy, model: compressData.model, source: 'load_api' };
                    if (returnConfig?.format === 'both') {
                      existingResult.raw = content.text;
                    }
                  }

                  // 后台存储 (使用兼容适配层)
                  if (authHeader && compressData.hqcc) {
                    const bMeta = extractMeta(compressData.hqcc);
                    if (existingResult) existingResult.hqcc = bMeta.hqcc;
                    deposit(
                      {
                        url,
                        hqcc: bMeta.hqcc,
                        raw: content.text,
                        visibility: 'public',
                        tags: bMeta.keywords,
                        meta: { strategy, model: compressData.model, source: 'load_api', title: bMeta.title },
                      },
                      authHeader,
                      userId,
                    ).catch((err) => console.error('[handleBatchUrls] Background deposit failed:', err));
                  }
                }
              } catch (err) {
                console.error(`[handleBatchUrls] Compress failed for ${url}:`, err);
              }
            });

            await Promise.all(compressPromises);
          }
        }
      }
    }

    // 重新统计
    const finalResults = Array.from(resultMap.values());
    const found = finalResults.filter((r: any) => r.found).length;
    const notFound = finalResults.length - found;
    const processed = finalResults.filter((r: any) => r.processed).length;
    const processingTime = Date.now() - startTime;

    // 记录使用量
    const sources: UsageSource[] = finalResults.map((r: any) => ({
      url: r.url,
      cached: r.cached && !r.processed,
      tokens: r.processed ? Math.round((r.hqcc?.length || 0) / 4) : 0,
    }));

    recordUsageBackground(
      createLoadUsageRecord({
        taskId,
        input: urls.join(', ').substring(0, 200),
        inputType: 'urls',
        searchCount: 0,
        urlsProcessed: urls.length,
        urlsCached: found - processed,
        urlsCompressed: processed,
        processingTimeMs: processingTime,
        sources,
      }),
      authHeader,
    );

    return NextResponse.json({
      success: true,
      requestId: taskId,
      mode: 'batch_urls',
      results: finalResults,
      summary: {
        total: urls.length,
        found,
        notFound,
        cached: found - processed,
        processed,
      },
      cost: {
        credits: compressionCredits,
        cached: found - processed,
      },
      processingTime,
    });
  } catch (error) {
    console.error('[handleBatchUrls] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROCESS_ERROR', message: 'Failed to load URLs' },
      },
      { status: 500 },
    );
  }
}

/**
 * 处理 Query 搜索 (非流式)
 */
async function handleQuery(
  request: NextRequest,
  query: string,
  search?: any,
  processing?: any,
  returnConfig?: any,
  ranking?: any,
  userId?: string,
): Promise<NextResponse> {
  const startTime = Date.now();
  const authHeader = request.headers.get('authorization');
  const taskId = generateTaskId('load_query');

  try {
    // Step 0: 本地缓存搜索 (fast, ~10ms)
    const searchTopK = search?.topK || 15;
    const baseUrl = getInternalBaseUrl();

    let localResults: Array<{ url: string; title: string; hqcc: string; cached: true; score: number; meta: any }> = [];
    if (userId) {
      try {
        const { contextCacheService } = await import('@/lib/context-cache.service');
        const localHits = await contextCacheService.search(query, userId, 5);
        localResults = localHits
          .filter((h) => h.score > 0)
          .map((h) => ({
            url: h.rawLink,
            title: h.title,
            hqcc: h.snippet,
            cached: true as const,
            score: h.score,
            meta: { source: 'local_cache' },
          }));
        if (localResults.length > 0) {
          console.log(`[handleQuery] Local cache: ${localResults.length} hits (top score: ${localResults[0].score})`);
        }
      } catch (err) {
        console.error('[handleQuery] Local search failed (non-blocking):', err);
      }
    }

    // Step 1: Exa 外部搜索
    const searchRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!searchRes.ok && localResults.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'SEARCH_ERROR', message: 'Search failed' },
        },
        { status: 500 },
      );
    }

    const searchData = searchRes.ok ? await searchRes.json() : { results: [] };

    // 过滤低质量结果（内容太短的结果可能是抓取失败或无实质内容）
    const MIN_CONTENT_LENGTH = 1000;
    const qualityResults = (searchData.results || []).filter((r: any) => r.text && r.text.length >= MIN_CONTENT_LENGTH);

    console.log(
      `[handleQuery] Search returned ${searchData.results?.length || 0} results, ${qualityResults.length} quality results (>= ${MIN_CONTENT_LENGTH} chars)`,
    );

    const searchResults = qualityResults.slice(0, searchTopK);

    if (searchResults.length === 0 && localResults.length === 0) {
      return NextResponse.json({
        success: true,
        requestId: `load_query_${Date.now().toString(36)}`,
        mode: 'query',
        results: [],
        summary: {
          query,
          searched: 0,
          cacheHits: 0,
          compressed: 0,
          returned: 0,
        },
        cost: { searchCredits: 1, compressionCredits: 0, totalCredits: 1, savedByCache: 0 },
        processingTime: Date.now() - startTime,
      });
    }

    // Step 2: 批量检查缓存 (使用兼容适配层)
    const urls = searchResults.map((r: any) => r.url);

    // 根据 returnConfig.format 决定缓存查询格式
    // 注意：后端不支持 format:'both'，只支持 'hqcc' 或 'intr'
    const cacheFormat =
      returnConfig?.format === 'both' || returnConfig?.format === 'raw' ? 'hqcc' : returnConfig?.format || 'hqcc';

    const cacheResult = await withdrawBatch(
      { urls, format: cacheFormat as 'hqcc' | 'intr', embed: false },
      authHeader,
      userId,
    );

    const cacheData = cacheResult.ok && cacheResult.data ? cacheResult.data : { results: [] };
    const cacheMap = new Map<string, any>();
    (cacheData.results || []).forEach((item: any) => {
      if (item.found && item.hqcc_content) {
        cacheMap.set(item.raw_link, item);
      }
    });

    // Step 3: 处理未命中项 (并发压缩)
    const uncachedResults = searchResults.filter((r: any) => !cacheMap.has(r.url));
    const maxConcurrent = processing?.maxConcurrent || 3;
    const strategy = processing?.strategy || 'auto';

    const compressedMap = new Map<string, any>();
    let compressionCredits = 0;

    // 并发压缩
    for (let i = 0; i < uncachedResults.length; i += maxConcurrent) {
      const batch = uncachedResults.slice(i, i + maxConcurrent);
      const compressPromises = batch.map(async (result: any) => {
        try {
          const compressRes = await fetch(`${baseUrl}/api/compress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: result.text,
              url: result.url,
              title: result.title,
              strategy,
              imageLinks: result.imageLinks || [],
            }),
          });

          if (compressRes.ok) {
            const compressData = await compressRes.json();
            compressedMap.set(result.url, {
              hqcc: compressData.hqcc,
              model: compressData.model,
            });
            compressionCredits += 0.5; // 估算

            // 后台存储 (fire-and-forget, 使用兼容适配层)
            if (authHeader && compressData.hqcc) {
              const qMeta = extractMeta(compressData.hqcc);
              compressedMap.set(result.url, { ...compressedMap.get(result.url), hqcc: qMeta.hqcc });
              deposit(
                {
                  url: result.url,
                  hqcc: qMeta.hqcc,
                  raw: result.text,
                  visibility: 'public',
                  tags: qMeta.keywords,
                  meta: { strategy, model: compressData.model, source: 'load_api', title: qMeta.title },
                },
                authHeader,
                userId,
              ).catch((err) => console.error('[Load API] Background deposit failed:', err));
            }
          }
        } catch (err) {
          console.error(`[Load API] Compress failed for ${result.url}:`, err);
        }
      });

      await Promise.all(compressPromises);
    }

    // Step 4: 使用 Ranking 模块排序
    const returnTopK = returnConfig?.topK || 5;
    const ranker = createRanker();

    // 准备可排序项 — local + Exa 合并去重
    const seenUrls = new Set<string>();
    const rankableItems: RankableItem[] = [];

    for (const local of localResults) {
      if (seenUrls.has(local.url)) continue;
      seenUrls.add(local.url);
      const cached = cacheMap.get(local.url);
      rankableItems.push({
        url: local.url,
        title: local.title,
        cached: true,
        cachedAt: undefined,
        searchRank: 0,
        searchScore: local.score * 10,
        publishedDate: undefined,
        hqcc: cached?.hqcc_content || local.hqcc,
        content: undefined,
        meta: local.meta,
      });
    }

    searchResults.forEach((result: any, index: number) => {
      if (seenUrls.has(result.url)) return;
      seenUrls.add(result.url);
      const cached = cacheMap.get(result.url);
      const compressed = compressedMap.get(result.url);
      const isCached = !!cached;
      const hqcc = cached?.hqcc_content || compressed?.hqcc || null;
      rankableItems.push({
        url: result.url,
        title: result.title,
        cached: isCached,
        cachedAt: cached?.meta?.cached_at,
        searchRank: index + 1,
        searchScore: result.score,
        publishedDate: result.publishedDate,
        hqcc,
        content: result.text,
        meta: cached?.meta || { strategy, source: 'load_api' },
      });
    });

    // 构建排序配置
    const rankingConfig: RankingConfig = {
      preset: ranking?.preset || 'cache_first',
      custom: ranking?.custom,
    };

    // 执行排序
    const rankedResults = ranker.rank(rankableItems, rankingConfig);

    // 取 topK 并格式化
    // 创建 content 映射用于返回 raw
    const contentMap = new Map<string, string>();
    searchResults.forEach((result: any) => {
      if (result.text) {
        contentMap.set(result.url, result.text);
      }
    });
    // 从缓存获取 intr_content (raw)
    (cacheData.results || []).forEach((item: any) => {
      if (item.found && item.intr_content) {
        contentMap.set(item.raw_link, item.intr_content);
      }
    });

    const includeRaw = returnConfig?.format === 'both' || returnConfig?.format === 'raw';

    const finalResults = rankedResults.slice(0, returnTopK).map((item) => ({
      rank: item.rank,
      url: item.url,
      title: item.title,
      hqcc: item.hqcc,
      raw: includeRaw ? contentMap.get(item.url) : undefined,
      cached: item.cached,
      cachedAt: item.cachedAt,
      ranking: {
        score: item.score,
        factors: item.factors,
      },
      meta: item.meta,
    }));

    const cacheHits = rankableItems.filter((r) => r.cached).length;
    const processingTime = Date.now() - startTime;

    // 记录使用量
    const sources: UsageSource[] = rankableItems.slice(0, 10).map((r) => ({
      url: r.url,
      cached: r.cached,
      tokens: r.cached ? 0 : Math.round((r.content?.length || 0) / 4),
    }));

    recordUsageBackground(
      createLoadUsageRecord({
        taskId,
        input: query,
        inputType: 'query',
        searchCount: 1,
        urlsProcessed: searchResults.length,
        urlsCached: cacheHits,
        urlsCompressed: compressedMap.size,
        processingTimeMs: processingTime,
        sources,
      }),
      authHeader,
    );

    return NextResponse.json({
      success: true,
      requestId: taskId,
      mode: 'query',
      results: finalResults,
      summary: {
        query,
        searched: searchResults.length,
        cacheHits,
        compressed: compressedMap.size,
        returned: finalResults.length,
      },
      cost: {
        searchCredits: 1,
        compressionCredits: Math.round(compressionCredits * 100) / 100,
        totalCredits: Math.round((1 + compressionCredits) * 100) / 100,
        savedByCache: Math.round(cacheHits * 0.5 * 100) / 100,
      },
      processingTime,
    });
  } catch (error) {
    console.error('[handleQuery] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROCESS_ERROR', message: 'Failed to process query' },
      },
      { status: 500 },
    );
  }
}

/**
 * 处理 Query 搜索 (流式)
 * TODO: 实现 SSE 流式响应
 */
async function handleQueryStream(
  request: NextRequest,
  query: string,
  search?: any,
  processing?: any,
  returnConfig?: any,
  ranking?: any,
  userId?: string,
): Promise<Response> {
  // 暂时 fallback 到非流式
  console.log('[Load API] Stream mode requested but not yet fully implemented, falling back to non-stream');
  return handleQuery(request, query, search, processing, returnConfig, ranking, userId);
}

/**
 * 处理 prismer:// URI — 内部内容寻址
 */
async function handlePrismerUri(
  request: NextRequest,
  uri: string,
  returnConfig?: any,
  userId?: string,
): Promise<NextResponse> {
  const startTime = Date.now();
  const authHeader = request.headers.get('authorization');
  const taskId = generateTaskId('load_prismer');

  try {
    const withdrawResult = await withdraw({ url: uri, format: returnConfig?.format || 'hqcc' }, authHeader, userId);

    if (withdrawResult.ok && withdrawResult.data?.found && withdrawResult.data?.hqcc_content) {
      const data = withdrawResult.data;
      return NextResponse.json({
        success: true,
        requestId: taskId,
        mode: 'prismer_uri',
        result: {
          uri,
          title: (data.meta as any)?.title || uri,
          hqcc: data.hqcc_content,
          raw: returnConfig?.format === 'both' ? data.intr_content : undefined,
          cached: true,
          meta: data.meta,
        },
        cost: { credits: 0, cached: true },
        processingTime: Date.now() - startTime,
      });
    }

    return NextResponse.json(
      {
        success: false,
        requestId: taskId,
        mode: 'prismer_uri',
        error: { code: 'NOT_FOUND', message: `Content not found: ${uri}` },
      },
      { status: 404 },
    );
  } catch (error) {
    console.error('[handlePrismerUri] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROCESS_ERROR', message: 'Failed to resolve prismer:// URI' },
      },
      { status: 500 },
    );
  }
}
