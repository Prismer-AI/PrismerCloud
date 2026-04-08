import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Resolve API key with priority chain:
 *   1. PRISMER_API_KEY env var (explicit override)
 *   2. ~/.prismer/config.toml [default] api_key (SDK CLI `prismer auth` sets this)
 *   3. '' (empty — tool calls will fail with clear error)
 */
function resolveApiKey(): string {
  let key = process.env.PRISMER_API_KEY || '';

  if (!key) {
    try {
      const configPath = join(homedir(), '.prismer', 'config.toml');
      const raw = readFileSync(configPath, 'utf-8');
      const match = raw.match(/^api_key\s*=\s*'([^']+)'/m) || raw.match(/^api_key\s*=\s*"([^"]+)"/m);
      if (match?.[1]) key = match[1];
    } catch {
      // No config file — that's OK
    }
  }

  // Validate: must be sk-prismer-* format, not a JWT or other token
  if (key && !key.startsWith('sk-prismer-')) {
    console.error(`[Prismer] Invalid API key format (expected sk-prismer-*, got ${key.substring(0, 10)}...).`);
    console.error('  Run: npx prismer setup');
    console.error('  Get key at: https://prismer.cloud/setup\n');
    return '';
  }

  return key;
}

function resolveBaseUrl(): string {
  if (process.env.PRISMER_BASE_URL) return process.env.PRISMER_BASE_URL;

  try {
    const configPath = join(homedir(), '.prismer', 'config.toml');
    const raw = readFileSync(configPath, 'utf-8');
    const match = raw.match(/^base_url\s*=\s*'([^']+)'/m) || raw.match(/^base_url\s*=\s*"([^"]+)"/m);
    if (match?.[1]) return match[1];
  } catch {
    // No config file
  }

  return 'https://prismer.cloud';
}

const API_KEY = resolveApiKey();
const BASE_URL = resolveBaseUrl();
const IM_AGENT = process.env.PRISMER_IM_AGENT || '';

export function getApiKey(): string {
  return API_KEY;
}

/**
 * Resolve project scope automatically.
 * Priority: PRISMER_SCOPE env > package.json name > cwd basename > 'global'
 */
export function getScope(): string {
  if (process.env.PRISMER_SCOPE) return process.env.PRISMER_SCOPE;

  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    if (pkg.name) return pkg.name;
  } catch {}

  // Use cwd basename as fallback
  const cwd = process.cwd();
  const base = cwd.split('/').pop() || cwd.split('\\').pop();
  if (base && base !== '/' && base !== '.') return base;

  return 'global';
}

export function getBaseUrl(): string {
  return BASE_URL;
}

export async function prismerFetch(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string> } = {}
): Promise<unknown> {
  if (!API_KEY) {
    throw new Error('API key not configured. Run `npx prismer setup` (get key at https://prismer.cloud/setup)');
  }

  const url = new URL(path, BASE_URL);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
  if (IM_AGENT) headers['X-IM-Agent'] = IM_AGENT;

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    let message: string;
    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || text;
    } catch {
      message = text;
    }
    throw new Error(`Prismer API ${response.status}: ${message}`);
  }

  return response.json();
}
