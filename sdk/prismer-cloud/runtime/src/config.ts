// T11 — config.toml loader + $KEYRING resolution

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import TOML from '@iarna/toml';
import type { Keychain } from './keychain.js';

// ============================================================
// Public types
// ============================================================

export interface PrismerConfig {
  apiKey?: string;
  apiBase?: string;
  daemon?: {
    host?: string;
    port?: number;
  };
  agents?: Record<string, {
    enabled?: boolean;
    apiKey?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface LoadConfigOptions {
  path?: string;
  keychain?: Keychain;
  resolvePlaceholders?: boolean;
}

// ============================================================
// Errors
// ============================================================

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ============================================================
// Placeholder parsing
// ============================================================

const KEYRING_PREFIX = '$KEYRING:';

export function parseKeyringPlaceholder(value: string): { service: string; account: string } | null {
  if (!value.startsWith(KEYRING_PREFIX)) return null;
  const rest = value.slice(KEYRING_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx < 1 || slashIdx === rest.length - 1) {
    throw new ConfigError(`malformed $KEYRING placeholder: "${value}" — expected $KEYRING:<service>/<account>`);
  }
  return {
    service: rest.slice(0, slashIdx),
    account: rest.slice(slashIdx + 1),
  };
}

// ============================================================
// Recursive walker — resolves placeholders in-place
// ============================================================

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

async function walkAndResolve(
  value: JsonValue,
  keychain: Keychain,
  resolvePlaceholders: boolean,
): Promise<JsonValue> {
  if (typeof value === 'string') {
    const parsed = parseKeyringPlaceholder(value);
    if (parsed === null) return value;
    if (!resolvePlaceholders) return value;
    const secret = await keychain.get(parsed.service, parsed.account);
    if (secret === null) {
      throw new ConfigError(`missing secret: ${parsed.service}/${parsed.account}`);
    }
    return secret;
  }

  if (Array.isArray(value)) {
    const results: JsonValue[] = [];
    for (const item of value) {
      results.push(await walkAndResolve(item, keychain, resolvePlaceholders));
    }
    return results;
  }

  if (value !== null && typeof value === 'object') {
    const resolved: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = await walkAndResolve(v as JsonValue, keychain, resolvePlaceholders);
    }
    return resolved;
  }

  return value;
}

// ============================================================
// Default config path
// ============================================================

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.prismer', 'config.toml');
}

// ============================================================
// loadConfig
// ============================================================

export async function loadConfig(opts?: LoadConfigOptions): Promise<PrismerConfig> {
  const configPath = opts?.path ?? defaultConfigPath();
  const resolvePlaceholders = opts?.resolvePlaceholders ?? true;

  let raw: string | null = null;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new ConfigError(`Cannot read config at ${configPath}: ${e.message}`);
    }
  }

  let parsed: TOML.JsonMap = {};
  if (raw !== null) {
    try {
      parsed = TOML.parse(raw);
    } catch (err) {
      throw new ConfigError(`failed to parse config TOML: ${String(err)}`);
    }
  }

  // Runtime-only view of the config — the TOML schema nests api_key under
  // [default], so lift it to the top-level `apiKey` field expected by
  // callers like commands/daemon.ts. The keychain placeholder resolver still
  // runs across the full tree below.
  const defaultSection = (parsed as { default?: { api_key?: string; base_url?: string; environment?: string } }).default;
  const flat: PrismerConfig = {
    ...(parsed as unknown as PrismerConfig),
  };
  if (defaultSection?.api_key !== undefined && flat.apiKey === undefined) {
    flat.apiKey = defaultSection.api_key;
  }
  if (defaultSection?.base_url !== undefined && flat.apiBase === undefined) {
    flat.apiBase = defaultSection.base_url;
  }

  // v1.9.0 B.2: PRISMER_API_KEY env is the final fallback for out-of-band
  // injection (Docker -e, CI, non-interactive installs). Env wins over missing
  // config but does NOT override an existing config value, so a deliberately
  //-selected key in config.toml stays authoritative.
  if (flat.apiKey === undefined) {
    const envKey = process.env['PRISMER_API_KEY'];
    if (envKey !== undefined && envKey.length > 0) {
      flat.apiKey = envKey;
    }
  }

  if (!opts?.keychain || !resolvePlaceholders) {
    return flat;
  }

  const resolved = await walkAndResolve(flat as unknown as JsonValue, opts.keychain, resolvePlaceholders);
  return resolved as unknown as PrismerConfig;
}

// ============================================================
// writeConfig
// ============================================================

export async function writeConfig(config: PrismerConfig, opts?: { path?: string }): Promise<void> {
  const configPath = opts?.path ?? defaultConfigPath();
  const parentDir = path.dirname(configPath);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  // Best-effort: clamp existing parent dir to owner-only (mkdirSync won't chmod an existing dir)
  try { fs.chmodSync(parentDir, 0o700); } catch { /* not critical */ }

  const serialized = TOML.stringify(config as TOML.JsonMap);
  const tmp = configPath + '.tmp';
  // Write with owner-only mode so the file is never world-readable, even momentarily
  fs.writeFileSync(tmp, serialized, { encoding: 'utf-8', mode: 0o600 });
  // Defensive chmod in case the file already existed with looser permissions
  try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  fs.renameSync(tmp, configPath);
}
