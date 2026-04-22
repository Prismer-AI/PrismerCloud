// T11 — migrate-secrets command: scan config.toml, move plaintext secrets to keychain

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import TOML from '@iarna/toml';
import { parseKeyringPlaceholder, ConfigError } from '../config.js';
import type { Keychain } from '../keychain.js';

// ============================================================
// Public types
// ============================================================

export interface MigrateStep {
  level: 'info' | 'ok' | 'warn' | 'error';
  message: string;
  detail?: string;
}

export interface MigrateSecretsOptions {
  configPath?: string;
  keychain: Keychain;
  dryRun?: boolean;
  onStep?: (step: MigrateStep) => void;
}

export interface MigrateSecretsResult {
  migrated: Array<{ path: string; service: string; account: string }>;
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; error: string }>;
}

// ============================================================
// Secret detection heuristics
// ============================================================

const SECRET_KEY_NAMES = new Set([
  'apikey', 'api_key', 'token', 'accesstoken', 'secret', 'password',
]);

// I7: expanded to cover common vendor-prefixed token shapes in addition to sk-*
// Patterns: sk-* (OpenAI/Prismer), xox[bpa]-* (Slack), gh[pousr]_* (GitHub),
//           AKIA* (AWS access key), AIza* (Google API key), pk/sk_live/test_* (Stripe)
const SECRET_VALUE_RE = /^(sk-[a-zA-Z0-9_-]{20,}|xox[bpa]-[a-zA-Z0-9-]{20,}|gh[pousr]_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:pk|sk)_(?:live|test)_[a-zA-Z0-9]{20,})$/;

// I7: high-entropy pattern — matches long alphanum strings that did NOT auto-migrate;
//     used to emit a warning only (not auto-migrate)
const HIGH_ENTROPY_RE = /^[A-Za-z0-9_-]{20,}$/;

function isSecretKey(keyName: string): boolean {
  return SECRET_KEY_NAMES.has(keyName.toLowerCase());
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_RE.test(value);
}

function shouldMigrate(keyBasename: string, value: string): boolean {
  if (isSecretKey(keyBasename)) return true;
  if (isSecretValue(value)) return true;
  return false;
}

function looksHighEntropy(value: string): boolean {
  return value.length > 20 && HIGH_ENTROPY_RE.test(value);
}

// ============================================================
// Recursive tree walker
// ============================================================

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

async function walkTree(
  node: JsonValue,
  keyPath: string[],
  keychain: Keychain,
  dryRun: boolean,
  result: MigrateSecretsResult,
  emit: (step: MigrateStep) => void,
): Promise<JsonValue> {
  if (typeof node === 'string') {
    const dotPath = keyPath.join('.');
    const basename = keyPath[keyPath.length - 1] ?? '';

    if (node.startsWith('$KEYRING:')) {
      result.skipped.push({ path: dotPath, reason: 'already a $KEYRING reference' });
      emit({ level: 'info', message: `Skipping ${dotPath} (already a $KEYRING reference)` });
      return node;
    }

    if (!shouldMigrate(basename, node)) {
      // I7: warn on long high-entropy strings that weren't auto-migrated
      if (looksHighEntropy(node)) {
        emit({
          level: 'warn',
          message: `${dotPath} looks secret-like (${node.slice(0, 6)}…); migrate manually if needed`,
        });
      }
      return node;
    }

    const slug = keyPath.join('_');
    const service = 'prismer-config';
    const account = slug;
    const placeholder = `$KEYRING:${service}/${account}`;

    try {
      emit({ level: 'info', message: `Migrating ${dotPath} → keychain (${service}/${account})` });

      if (!dryRun) {
        await keychain.set(service, account, node);
      }

      result.migrated.push({ path: dotPath, service, account });
      emit({ level: 'ok', message: `Migrated ${dotPath} → keychain (${service}/${account})` });
      return placeholder;
    } catch (err) {
      const errMsg = String(err);
      result.errors.push({ path: dotPath, error: errMsg });
      emit({ level: 'error', message: `Failed to migrate ${dotPath}: ${errMsg}` });
      return node;
    }
  }

  if (Array.isArray(node)) {
    const results: JsonValue[] = [];
    for (let i = 0; i < node.length; i++) {
      const item = await walkTree(node[i], [...keyPath, String(i)], keychain, dryRun, result, emit);
      results.push(item);
    }
    return results;
  }

  if (node !== null && typeof node === 'object') {
    const updated: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(node)) {
      updated[k] = await walkTree(v as JsonValue, [...keyPath, k], keychain, dryRun, result, emit);
    }
    return updated;
  }

  return node;
}

// ============================================================
// Backup helper
// ============================================================

function backupConfig(configPath: string): void {
  const bakPath = configPath + '.bak';
  if (fs.existsSync(bakPath)) {
    const ts = Date.now();
    const tsBakPath = `${configPath}.bak.${ts}`;
    fs.copyFileSync(configPath, tsBakPath);
    // I6: backup file must not be world-readable
    fs.chmodSync(tsBakPath, 0o600);
  } else {
    fs.copyFileSync(configPath, bakPath);
    // I6: backup file must not be world-readable
    fs.chmodSync(bakPath, 0o600);
  }
}

// ============================================================
// Default config path
// ============================================================

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.prismer', 'config.toml');
}

// ============================================================
// migrateSecrets
// ============================================================

export async function migrateSecrets(opts: MigrateSecretsOptions): Promise<MigrateSecretsResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  const dryRun = opts.dryRun ?? false;
  const emit = opts.onStep ?? (() => undefined);

  const result: MigrateSecretsResult = { migrated: [], skipped: [], errors: [] };

  emit({ level: 'info', message: `Reading config from ${configPath}` });

  if (!fs.existsSync(configPath)) {
    emit({ level: 'info', message: 'no config to migrate' });
    return result;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    emit({ level: 'error', message: `Failed to read config: ${String(err)}` });
    return result;
  }

  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new ConfigError(`failed to parse config TOML: ${String(err)}`);
  }

  const updated = await walkTree(
    parsed as unknown as JsonValue,
    [],
    opts.keychain,
    dryRun,
    result,
    emit,
  );

  if (!dryRun && result.migrated.length > 0) {
    backupConfig(configPath);
    emit({ level: 'info', message: `Backed up original config to ${configPath}.bak` });

    const serialized = TOML.stringify(updated as unknown as TOML.JsonMap);
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, serialized, 'utf-8');
    // I6: rewritten config must not be world-readable before atomic rename
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
    emit({ level: 'ok', message: `Config rewritten with $KEYRING references` });
  }

  emit({
    level: 'ok',
    message: `Done. ${result.migrated.length} migrated, ${result.skipped.length} skipped, ${result.errors.length} errors.`,
  });

  return result;
}

// Re-export parseKeyringPlaceholder for test convenience
export { parseKeyringPlaceholder, ConfigError };
