#!/usr/bin/env node
/**
 * PostToolUse hook — Enhanced context cache save for WebFetch + WebSearch
 *
 * WebFetch:
 *   - hqcc = Claude Haiku summary (from CC tool_response.result)
 *   - raw  = Re-fetched full page content via Turndown
 *   - meta = original bytes, title, domain
 *
 * WebSearch:
 *   - Extracts discovered URLs from search results
 *   - Batch-fetches top URLs → stores each as independent cache entry (raw + hqcc)
 *   - Tags entries with original query terms → enables Load API query search
 *   - Also stores the search summary under prismer://search/{query}
 *
 * Always on. Fire-and-forget. Zero user impact.
 */

import { readFileSync } from 'fs';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger } from './lib/logger.mjs';
import { fetchRawContent } from './lib/html-to-markdown.mjs';

const log = createLogger('post-web-save');

const { apiKey, baseUrl } = resolveConfig();
if (!apiKey) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const toolName = input?.tool_name;
const resp = input?.tool_response || input?.tool_result;

// ── Helpers ────────────────────────────────────────────────────

function isPublicUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  if (/localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(url)) return false;
  return true;
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Extract URLs from WebSearch response (handles both CC output formats)
 *
 * Format A (structured): resp.results = [SearchResult | string]
 *   SearchResult = { tool_use_id, content: [{title, url}] }
 *
 * Format B (serialized text): resp.result = string containing
 *   "Links: [{...}]" blocks and/or markdown [title](url) links
 */
function extractUrlsFromSearchResponse(resp) {
  const urls = [];

  // Format A: structured results array
  if (Array.isArray(resp?.results)) {
    for (const item of resp.results) {
      if (typeof item === 'object' && item !== null && Array.isArray(item.content)) {
        for (const hit of item.content) {
          if (hit.url && hit.title) urls.push({ title: hit.title, url: hit.url });
        }
      }
    }
  }

  // Format B: serialized text — extract "Links: [JSON]" and markdown links
  const text = typeof resp?.result === 'string' ? resp.result : '';
  if (text) {
    // "Links: [{...}]" blocks (CC's mapToolResultToToolResultBlockParam format)
    for (const m of text.matchAll(/Links:\s*(\[[\s\S]*?\])(?:\n|$)/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed)) {
          for (const hit of parsed) {
            if (hit.url && hit.title) urls.push({ title: hit.title, url: hit.url });
          }
        }
      } catch { /* malformed JSON, skip */ }
    }
    // Markdown links [title](url)
    for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g)) {
      urls.push({ title: m[1], url: m[2] });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return urls.filter(u => {
    if (!u.url || seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });
}

/**
 * Get the text commentary from search results (for search summary storage)
 */
function getSearchCommentary(resp) {
  if (Array.isArray(resp?.results)) {
    return resp.results.filter(item => typeof item === 'string').join('\n\n').trim();
  }
  if (typeof resp?.result === 'string') return resp.result;
  return '';
}

/**
 * Save single item to cache. Returns the fetch promise for composability.
 */
function saveToCache({ url, hqcc, raw, meta }) {
  if (!hqcc || hqcc.length < 100) return Promise.resolve();

  const payload = { url, hqcc };
  if (raw && raw.length > 100) payload.raw = raw;
  if (meta) payload.meta = meta;

  log.info('cache-save', {
    url: url.slice(0, 120),
    hqccBytes: hqcc.length,
    rawBytes: raw?.length || 0,
  });

  return fetch(`${baseUrl}/api/context/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => {
    log.warn('cache-save-failed', { url: url.slice(0, 120), error: e.message });
  });
}

/**
 * Batch save items to cache (max 50 per call). Returns the fetch promise.
 */
function saveBatchToCache(items) {
  if (!items.length) return Promise.resolve();

  log.info('cache-save-batch', { count: items.length });

  return fetch(`${baseUrl}/api/context/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => {
    log.warn('cache-save-batch-failed', { count: items.length, error: e.message });
  });
}

// ── WebFetch: re-fetch raw content + save both ─────────────────

if (toolName === 'WebFetch') {
  const url = resp?.url || input?.tool_input?.url;
  const hqcc = resp?.result;
  const code = resp?.code;
  const ccBytes = resp?.bytes;

  if (code === 200 && isPublicUrl(url) && hqcc) {
    const rawPromise = fetchRawContent(url, 6000).catch(() => null);

    rawPromise.then((rawResult) => {
      const meta = {
        source: 'claude-code-webfetch',
        hqccType: 'haiku',  // CC Haiku LLM compressed
        domain: domainOf(url),
        ccOriginalBytes: ccBytes,
        hqccBytes: hqcc.length,
        fetchedAt: new Date().toISOString(),
      };

      if (rawResult) {
        meta.rawBytes = rawResult.originalBytes;
        meta.rawMarkdownBytes = rawResult.markdown.length;
        if (rawResult.title) meta.title = rawResult.title;
        meta.hasRaw = true;
        saveToCache({ url, hqcc, raw: rawResult.markdown, meta });
      } else {
        meta.hasRaw = false;
        saveToCache({ url, hqcc, meta });
      }
    });
  }
}

// ── WebSearch: batch-fetch discovered URLs → independent cache entries ──

if (toolName === 'WebSearch') {
  const query = input?.tool_input?.query;
  const discoveredUrls = extractUrlsFromSearchResponse(resp);
  const commentary = getSearchCommentary(resp);

  if (!query || discoveredUrls.length === 0) process.exit(0);

  // Collect all save promises to ensure process stays alive until all complete
  const savePromises = [];

  // 1. Save search summary under prismer://search/{query}
  if (commentary && commentary.length > 100) {
    savePromises.push(
      saveToCache({
        url: `prismer://search/${encodeURIComponent(query)}`,
        hqcc: commentary,
        meta: {
          source: 'claude-code-websearch-summary',
          query,
          urlCount: discoveredUrls.length,
          urls: discoveredUrls.slice(0, 20).map(u => u.url),
          fetchedAt: new Date().toISOString(),
        },
      }),
    );
  }

  // 2. Batch-fetch top URLs and store each as independent cache entry
  const BATCH_SIZE = 5;
  const targets = discoveredUrls.filter(u => isPublicUrl(u.url)).slice(0, BATCH_SIZE);

  if (targets.length > 0) {
    const batchPromise = Promise.allSettled(
      targets.map(({ title, url }) =>
        fetchRawContent(url, 4000)
          .then(raw => ({ title, url, raw }))
          .catch(() => ({ title, url, raw: null })),
      ),
    ).then((settled) => {
      const items = [];

      for (const r of settled) {
        if (r.status !== 'fulfilled' || !r.value.raw) continue;
        const { title, url, raw } = r.value;
        const md = raw.markdown;
        if (!md || md.length < 200) continue;

        // hqcc = preview (no LLM compression yet)
        // Upgraded to Haiku summary when this URL is later WebFetch'd (upsert)
        const preview = md.slice(0, 800).trim();
        const hqcc = `# ${raw.title || title || domainOf(url)}\n\n${preview}`;

        items.push({
          url,
          hqcc,
          raw: md,
          meta: {
            source: 'claude-code-websearch',
            hqccType: 'preview',  // not LLM-compressed; upgradeable via WebFetch
            fromQuery: query,
            queryTerms: query.toLowerCase(),
            title: raw.title || title,
            domain: domainOf(url),
            fetchedAt: new Date().toISOString(),
          },
        });
      }

      if (items.length > 0) {
        log.info('websearch-indexed', {
          query: query.slice(0, 100),
          discovered: discoveredUrls.length,
          fetched: targets.length,
          indexed: items.length,
        });
        return saveBatchToCache(items);
      }
    });

    savePromises.push(batchPromise);
  }

  // Wait for all saves to settle before process exits
  Promise.allSettled(savePromises);
}
