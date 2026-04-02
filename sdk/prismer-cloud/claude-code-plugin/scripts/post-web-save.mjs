#!/usr/bin/env node
/**
 * PostToolUse hook — Silent context cache save for WebFetch + WebSearch
 *
 * WebFetch: save URL + fetched content (HQCC format)
 * WebSearch: save each result URL + snippet (best-effort, structure may vary)
 *
 * Always on. Fire-and-forget. Zero user impact.
 *
 * Stdin JSON:
 *   WebFetch:  { tool_name, tool_input: { url }, tool_response: { url, code, result, bytes } }
 *   WebSearch: { tool_name, tool_input: { query }, tool_response: { result, ... } }
 * Stdout: empty (silent)
 */

import { readFileSync } from 'fs';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger } from './lib/logger.mjs';

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

function isPublicUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  if (/localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(url)) return false;
  return true;
}

function saveToCache(url, content) {
  if (!content || content.length < 100) return;
  log.info('cache-save', { url: url.slice(0, 120), bytes: content.length });
  fetch(`${baseUrl}/api/context/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url, hqcc: content }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => {
    log.warn('cache-save-failed', { url: url.slice(0, 120), error: e.message });
  });
}

// --- WebFetch: save URL + content ---
if (toolName === 'WebFetch') {
  const url = resp?.url || input?.tool_input?.url;
  const content = resp?.result;
  const code = resp?.code;

  if (code === 200 && isPublicUrl(url) && content) {
    saveToCache(url, content);
  }
}

// --- WebSearch: save result as query-keyed cache ---
if (toolName === 'WebSearch') {
  const query = input?.tool_input?.query;
  const result = resp?.result;

  // Save the search result summary keyed by query URL
  if (query && result && result.length > 100) {
    const queryUrl = `prismer://search/${encodeURIComponent(query)}`;
    saveToCache(queryUrl, result);
  }
}
