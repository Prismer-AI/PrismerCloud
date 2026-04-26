import { NextRequest, NextResponse } from 'next/server';
import Exa from 'exa-js';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { apiGuard } from '@/lib/api-guard';
import { metrics } from '@/lib/metrics';
import { exaBreaker } from '@/lib/circuit-breaker';
import { checkRateLimit, rateLimitResponse, rateLimitHeaders } from '@/lib/rate-limit';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Search');

// Initialize Nacos config on module load (singleton pattern)
let nacosInitialized = false;
const initNacos = async () => {
  if (!nacosInitialized) {
    await ensureNacosConfig();
    nacosInitialized = true;
  }
};

// Get API key with Nacos support
function getSearchApiKey(): string | undefined {
  return process.env.EXASEARCH_API_KEY;
}

/**
 * POST /api/search
 *
 * Search using internal search engine with strict configuration.
 * 认证: 必需 (API Key 或 JWT) — billable
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;
  const rl = checkRateLimit(guard.auth.userId, 'search');
  if (!rl.allowed) return rateLimitResponse(rl);
  try {
    // Ensure Nacos config is loaded before accessing env vars
    await initNacos();

    const SEARCH_API_KEY = getSearchApiKey();

    if (!SEARCH_API_KEY) {
      return NextResponse.json(
        {
          error:
            'Web search not available. Set EXASEARCH_API_KEY in your .env file. Get one at https://dashboard.exa.ai/api-keys',
        },
        { status: 503 },
      );
    }

    const body = await request.json();
    const { query } = body;

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const searchClient = new Exa(SEARCH_API_KEY);
    (searchClient as any).headers.set('x-exa-integration', 'prismercloud');

    // Strict configuration as specified
    // Request 15 results to have buffer after filtering low-quality ones
    const exaStart = Date.now();
    const result = await exaBreaker.execute(() =>
      searchClient.searchAndContents(query, {
        numResults: 15,
        extras: { links: 1, imageLinks: 10 },
        livecrawl: 'fallback',
        text: true,
        type: 'auto',
        userLocation: 'US',
      }),
    );
    metrics.recordExternalApi('exa', Date.now() - exaStart, true);

    // Transform results to a cleaner format
    // Note: API may return null for title, so we handle it
    const transformedResults = result.results.map((item) => ({
      id: item.id,
      title: item.title || item.url || 'Untitled', // Handle null title
      url: item.url,
      text: item.text || '',
      publishedDate: item.publishedDate || undefined,
      author: item.author || undefined,
      links: item.extras?.links || [],
      imageLinks: item.extras?.imageLinks || [],
    }));

    metrics.recordRequest('/api/search', Date.now() - reqStart, 200);
    return NextResponse.json(
      {
        requestId: result.requestId || '',
        resolvedSearchType: (result as any).resolvedSearchType || 'auto',
        results: transformedResults,
        totalResults: transformedResults.length,
      },
      { headers: rateLimitHeaders(rl) },
    );
  } catch (error) {
    metrics.recordExternalApi('exa', 0, false);
    metrics.recordRequest('/api/search', Date.now() - reqStart, 500);
    log.error({ err: error }, 'Search error');
    return NextResponse.json(
      { error: 'Failed to perform search', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
