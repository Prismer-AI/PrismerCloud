/**
 * Resolve Prismer config with priority chain:
 *   1. Environment variables (PRISMER_API_KEY, PRISMER_BASE_URL)
 *   2. ~/.prismer/config.toml (shared with `prismer` CLI)
 *   3. Defaults
 *
 * Ported from claude-code-plugin/scripts/lib/resolve-config.mjs with TypeScript types.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface PrismerConfig {
  apiKey: string;
  baseUrl: string;
}

let _cached: PrismerConfig | null = null;

export function resolveConfig(): PrismerConfig {
  if (_cached) return _cached;

  let apiKey = process.env.PRISMER_API_KEY || '';
  let baseUrl = process.env.PRISMER_BASE_URL || '';

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
      // No config file — proceed with env vars / defaults
    }
  }

  // Validate: API key must be sk-prismer-* format
  if (apiKey && !apiKey.startsWith('sk-prismer-')) {
    apiKey = ''; // Invalid format — treat as not configured
  }

  _cached = {
    apiKey,
    baseUrl: (baseUrl || 'https://prismer.cloud').replace(/\/$/, ''),
  };

  return _cached;
}

/** Clear cached config (useful for testing) */
export function clearConfigCache(): void {
  _cached = null;
}
