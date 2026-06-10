// Shared CLI helpers — JSON / table printing, error exit, PID file.
//
// Output rendering (banners, status lines, tables, spinners, progress, json
// mode) lives in ./ui.ts. The thin wrappers below delegate to that singleton
// so legacy call sites keep working while new code can use `getUI()` directly
// for the full surface (--quiet / --json / table / spinner / progress).

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigPaths } from '../config.js';
import { getUI } from './ui.js';

/** Default cloud base URL when neither --cloud nor PRISMER_BASE_URL is provided. */
export const DEFAULT_CLOUD_BASE_URL = 'https://prismer.cloud';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

export function color(kind: 'bold' | 'dim' | 'cyan' | 'green' | 'yellow' | 'red', text: string): string {
  if (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true') return text;
  return `${ANSI[kind]}${text}${ANSI.reset}`;
}

export function printJson(v: unknown): void {
  // Delegate to UI singleton so --quiet / --json mode + NO_COLOR are honoured.
  getUI().json(v, { pretty: true });
}

export interface ExitErrorOptions {
  /** Stable error code (e.g. `invalid_url`, `cloud_unreachable`). Used by JSON consumers. */
  code?: string;
  /** Process exit code. Defaults to 1. */
  exitCode?: number;
  /** Optional structured details payload merged into the JSON error envelope. */
  details?: Record<string, unknown>;
}

/**
 * Print an error and exit. In JSON UI mode, emits a structured envelope to
 * stdout so machine-readable consumers can `jq` it — otherwise pretty stderr.
 */
export function exitWithError(message: string, opts?: ExitErrorOptions | number): never {
  const o: ExitErrorOptions = typeof opts === 'number' ? { exitCode: opts } : (opts ?? {});
  const exitCode = o.exitCode ?? 1;
  const ui = getUI();
  if (ui.mode === 'json') {
    const payload = {
      ok: false,
      error: { code: o.code ?? 'cli_error', message },
      ...(o.details ? { details: o.details } : {}),
    };
    ui.json(payload, { pretty: true });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(exitCode);
}

/**
 * Normalize a user-supplied cloud base URL. Auto-prepends `http://` for bare
 * `host:port` shapes (so `--cloud 127.0.0.1:3000` works), then validates that
 * the result has a sensible http(s) scheme. Throws with a friendly message on
 * failure so the caller can route it through exitWithError.
 */
export function normalizeCloudUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('Cloud URL is empty.');

  // If it has a scheme already, accept http/https only.
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid --cloud URL: ${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Invalid --cloud URL scheme: ${parsed.protocol} (expected http:// or https://)`);
    }
    // Strip trailing slash for consistency with the rest of the runtime.
    return raw.replace(/\/$/, '');
  }

  // No scheme — only accept bare host[:port][/path] shapes; reject anything weird.
  // Allow IPv4, IPv6 in brackets, hostnames. Default to http:// for local dev.
  if (!/^[A-Za-z0-9.\-_:[\]/]+$/.test(raw)) {
    throw new Error(`Invalid --cloud URL: ${raw} (must be http://… or https://… or host:port)`);
  }
  const candidate = `http://${raw}`;
  try {
    // eslint-disable-next-line no-new
    new URL(candidate);
  } catch {
    throw new Error(`Invalid --cloud URL: ${raw}`);
  }
  return candidate.replace(/\/$/, '');
}

/**
 * Wrap a commander action so any throw becomes a friendly exitWithError —
 * commander's default unhandled-error handler prefixes "prismer:" and the
 * exit code is platform-dependent. This keeps every subcommand consistent.
 */
export function runAction<A extends unknown[]>(
  fn: (...args: A) => Promise<void> | void,
  opts: { code?: string; sanitize?: (msg: string) => string } = {},
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = opts.sanitize ? opts.sanitize(raw) : raw;
      exitWithError(message, { code: opts.code });
    }
  };
}

// Read once at module load — package.json is the single runtime version source,
// avoids hand-edited literals drifting from /VERSION + sdk/build/version.sh.
const PKG_VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const RUNTIME_SUBTITLE = `Runtime CLI v${PKG_VERSION}`;

export function printBanner(opts: { compact?: boolean } = {}): void {
  // Compact mode: terse one-liner used inside command output (e.g. status banner).
  // Full mode: 22-line product icon (sourced from runtime/assets/icon).
  // The UI singleton handles TTY width detection, --quiet / --json suppression,
  // NO_COLOR / 'icon' file-fallback transparently.
  const ui = getUI();
  if (opts.compact) {
    ui.smallHeader(RUNTIME_SUBTITLE);
    return;
  }
  ui.banner(RUNTIME_SUBTITLE, { full: true });
}

export function ok(label: string, detail?: string): void {
  getUI().ok(label, detail);
}

export function warn(label: string, detail?: string): void {
  getUI().warn(label, detail);
}

export function fail(label: string, detail?: string): void {
  getUI().fail(label, detail);
}

export function tip(command: string, detail?: string): void {
  // util's tip() takes (command, detail). UI's tip() prints "Tip: <text>".
  // Keep call-site signatures the same: render the legacy two-arg form.
  const text = detail ? `${command}  ${detail}` : command;
  getUI().tip(text);
}

export function info(message: string): void {
  getUI().info(message);
}

export function header(title: string): void {
  getUI().header(title);
  getUI().blank();
}

export function table(rows: Array<Record<string, string>>, columns: string[]): void {
  getUI().table(rows, { columns });
}

export function pidFilePath(paths: ConfigPaths): string {
  return join(paths.root, 'daemon.pid');
}

export function writePidFile(paths: ConfigPaths, pid: number): void {
  writeFileSync(pidFilePath(paths), `${pid}\n`, 'utf8');
}

export function readPidFile(paths: ConfigPaths): number | undefined {
  const p = pidFilePath(paths);
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : undefined;
}

export function clearPidFile(paths: ConfigPaths): void {
  const p = pidFilePath(paths);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
