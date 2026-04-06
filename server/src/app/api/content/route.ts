import { NextRequest, NextResponse } from 'next/server';
import Exa from 'exa-js';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { apiGuard } from '@/lib/api-guard';
import { metrics } from '@/lib/metrics';

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
 * Implementation details are abstracted away from the client.
 * 
 * Request body:
 * - urls: string[] - Array of URLs to fetch content from
 * 
 * Response:
 * - results: Array of content results with text, links, and imageLinks
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  try {
    const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
    if (!guard.ok) return guard.response;

    // Ensure Nacos config is loaded before accessing env vars
    await initNacos();

    const CONTENT_API_KEY = getContentApiKey();
    
    if (!CONTENT_API_KEY) {
      return NextResponse.json(
        { error: 'Content fetching not available. Set EXASEARCH_API_KEY in your .env file. Get one at https://dashboard.exa.ai/api-keys' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { urls } = body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json(
        { error: 'URLs array is required' },
        { status: 400 }
      );
    }

    // Validate all URLs — block private/internal networks
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return NextResponse.json(
            { error: `Invalid URL scheme: ${parsed.protocol} (only http/https allowed)` },
            { status: 400 }
          );
        }
        const host = parsed.hostname.toLowerCase();
        if (
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host === '::1' ||
          host === '0.0.0.0' ||
          host.startsWith('10.') ||
          host.startsWith('172.') ||
          host.startsWith('192.168.') ||
          host.startsWith('169.254.') ||
          host.endsWith('.internal') ||
          host.endsWith('.local')
        ) {
          return NextResponse.json(
            { error: `Blocked URL: private/internal network addresses are not allowed` },
            { status: 400 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: `Invalid URL: ${url}` },
          { status: 400 }
        );
      }
    }

    const contentClient = new Exa(CONTENT_API_KEY);

    console.log(`[Content API] Fetching content for ${urls.length} URL(s):`, urls);

    // Use getContents API
    // livecrawl: "fallback" - fallback to live crawl if cache miss
    const exaStart = Date.now();
    const result = await contentClient.getContents(urls, {
      text: true,
      extras: {
        links: 1,
        imageLinks: 5
      },
      livecrawl: "fallback"
    });

    // Transform results to a cleaner format
    const transformedResults = result.results.map((item) => ({
      id: item.id,
      title: item.title || item.url || 'Untitled',
      url: item.url,
      text: item.text || '',
      publishedDate: item.publishedDate || undefined,
      author: item.author || undefined,
      links: item.extras?.links || [],
      imageLinks: item.extras?.imageLinks || []
    }));

    metrics.recordExternalApi('exa', Date.now() - exaStart, true);
    metrics.recordRequest('/api/content', Date.now() - reqStart, 200);
    console.log(`[Content API] Successfully fetched ${transformedResults.length} result(s)`);

    return NextResponse.json({
      results: transformedResults,
      totalResults: transformedResults.length
    });

  } catch (error) {
    metrics.recordExternalApi('exa', 0, false);
    metrics.recordRequest('/api/content', Date.now() - reqStart, 500);
    console.error('[Content API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch URL content', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}







