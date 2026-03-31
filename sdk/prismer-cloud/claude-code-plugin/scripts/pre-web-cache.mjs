#!/usr/bin/env node
/**
 * PreToolUse hook — Fast context cache check before WebFetch
 *
 * Only for WebFetch (not WebSearch — search always fetches fresh).
 * Disabled by default. Enable via PRISMER_WEB_CACHE_LOAD=1 env var.
 *
 * 1s budget. Hit → deny + cached content. Miss/timeout → allow fetch.
 *
 * Stdin JSON: { tool_name, tool_input: { url }, ... }
 * Stdout JSON: deny with cached content, or nothing (allow)
 */

import { readFileSync } from 'fs';
import { resolveConfig } from './lib/resolve-config.mjs';

// Feature gate — disabled by default, enable with PRISMER_WEB_CACHE_LOAD=1
if (process.env.PRISMER_WEB_CACHE_LOAD !== '1') process.exit(0);

const { apiKey, baseUrl } = resolveConfig();
if (!apiKey) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

// Only intercept WebFetch, never WebSearch
if (input?.tool_name !== 'WebFetch') process.exit(0);

const url = input?.tool_input?.url;
if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) process.exit(0);
if (/localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(url)) process.exit(0);

// 1s budget — if cache is slow, just let fetch proceed
try {
  const res = await fetch(`${baseUrl}/api/context/load`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: url }),
    signal: AbortSignal.timeout(1000),
  });

  if (res.ok) {
    const data = await res.json();
    if (data?.success && data?.result?.cached && data?.result?.hqcc) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[Cache hit: ${url}]\n\n${data.result.hqcc}`,
        },
      }));
      process.exit(0);
    }
  }
} catch {
  // Timeout or error → allow fetch, no delay
}
