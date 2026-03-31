/**
 * Resolve Prismer config with priority chain:
 *   1. Environment variables (PRISMER_API_KEY, PRISMER_BASE_URL)
 *   2. Claude Code userConfig (CLAUDE_PLUGIN_OPTION_API_KEY, CLAUDE_PLUGIN_OPTION_BASE_URL)
 *   3. ~/.prismer/config.toml (shared with `prismer` CLI)
 *   4. Defaults
 *
 * Usage:
 *   import { resolveConfig } from './lib/resolve-config.mjs';
 *   const { apiKey, baseUrl } = resolveConfig();
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let _cached = null;

export function resolveConfig() {
  if (_cached) return _cached;

  let apiKey = process.env.PRISMER_API_KEY || process.env.CLAUDE_PLUGIN_OPTION_API_KEY || '';
  let baseUrl = process.env.PRISMER_BASE_URL || process.env.CLAUDE_PLUGIN_OPTION_BASE_URL || '';

  // Fallback: read ~/.prismer/config.toml
  if (!apiKey || !baseUrl) {
    try {
      const raw = readFileSync(join(homedir(), '.prismer', 'config.toml'), 'utf-8');
      if (!apiKey) {
        const m = raw.match(/^api_key\s*=\s*['"]([^'"]+)['"]/m);
        if (m?.[1]) apiKey = m[1];
      }
      if (!baseUrl) {
        const m = raw.match(/^base_url\s*=\s*['"]([^'"]+)['"]/m);
        if (m?.[1]) baseUrl = m[1];
      }
    } catch {
      // No config file
    }
  }

  // Validate: API key must be sk-prismer-* format, not a JWT token
  if (apiKey && !apiKey.startsWith('sk-prismer-')) {
    apiKey = ''; // Invalid format — treat as not configured
  }

  _cached = {
    apiKey,
    baseUrl: (baseUrl || 'https://prismer.cloud').replace(/\/$/, ''),
  };

  return _cached;
}
