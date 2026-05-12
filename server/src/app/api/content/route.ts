import { NextRequest, NextResponse } from 'next/server';
import Exa from 'exa-js';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { metrics } from '@/lib/metrics';
import { apiGuard } from '@/lib/api-guard';
import { exaBreaker } from '@/lib/circuit-breaker';
import { checkRateLimit, rateLimitResponse, rateLimitHeaders } from '@/lib/rate-limit';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Content');

// Initialize Nacos config on module load (singleton pattern)
let nacosInitialized = false;
const initNacos = async () => {
  if (!nacosInitialized) {
    await ensureNacosConfig();
    nacosInitialized = true;
  }
};

// Get API key with Nacos support
function getContentApiKey(): string | undefined {
  return process.env.EXASEARCH_API_KEY;
}

/**
 * POST /api/content
 *
 * Fetch content from specified URLs using internal content fetching service.
 * 认证: 必需 (API Key 或 JWT) — billable
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 0.5 });
  if (!guard.ok) return guard.response;
  const rl = checkRateLimit(guard.auth.userId, 'content');
  if (!rl.allowed) return rateLimitResponse(rl);
  try {
    // Ensure Nacos config is loaded before accessing env vars
    await initNacos();

    const CONTENT_API_KEY = getContentApiKey();

    if (!CONTENT_API_KEY) {
      return NextResponse.json({ error: 'Content API key not configured' }, { status: 500 });
    }

    const body = await request.json();
    const { urls } = body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({ error: 'URLs array is required' }, { status: 400 });
    }

    // Validate all URLs
    for (const url of urls) {
      try {
        new URL(url);
      } catch {
        return NextResponse.json({ error: `Invalid URL: ${url}` }, { status: 400 });
      }
    }

    const contentClient = new Exa(CONTENT_API_KEY);

    log.debug({ urlCount: urls.length, urls }, 'Fetching content');

    // Use getContents API
    // livecrawl: "fallback" - fallback to live crawl if cache miss
    const exaStart = Date.now();
    const result = await exaBreaker.execute(() =>
      contentClient.getContents(urls, {
        text: true,
        extras: { links: 1, imageLinks: 5 },
        livecrawl: 'fallback',
      }),
    );

    // Transform results to a cleaner format
    const transformedResults = result.results.map((item) => ({
      id: item.id,
      title: item.title || item.url || 'Untitled',
      url: item.url,
      text: item.text || '',
      publishedDate: item.publishedDate || undefined,
      author: item.author || undefined,
      links: item.extras?.links || [],
      imageLinks: item.extras?.imageLinks || [],
    }));

    metrics.recordExternalApi('exa', Date.now() - exaStart, true);
    metrics.recordRequest('/api/content', Date.now() - reqStart, 200);
    log.info(`Successfully fetched ${transformedResults.length} result(s)`);

    return NextResponse.json(
      {
        results: transformedResults,
        totalResults: transformedResults.length,
      },
      { headers: rateLimitHeaders(rl) },
    );
  } catch (error) {
    metrics.recordExternalApi('exa', 0, false);
    metrics.recordRequest('/api/content', Date.now() - reqStart, 500);
    log.error({ err: error }, 'Content fetch error');
    return NextResponse.json(
      { error: 'Failed to fetch URL content', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
