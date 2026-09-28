// Lightweight module-prefixed structured logger for the daemon runtime.
//
// CLAUDE.md §Conventions calls for `[ModuleName] level: message` log lines.
// This module gives every daemon file a typed `log` instance instead of
// scattering raw `console.*` calls (R7 from the v2.0 joint review).
//
// Design notes:
//   * Intentionally console-backed (no `pino` dependency yet). The wrapper API
//     mirrors the `info/warn/error/debug` slice of pino so a future migration
//     is a drop-in swap.
//   * Each call serialises an optional `meta` object as JSON appended to the
//     human line, so log scrapers can pick up structured fields without
//     forcing every callsite to switch to objects on day one.
//   * `level` is honoured against `PRISMER_LOG_LEVEL` (default `info`). Tests
//     can set the env var to `silent` to suppress output.

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function resolveLevel(): LogLevel {
  const raw = (typeof process !== 'undefined' ? process.env?.PRISMER_LOG_LEVEL : undefined) ?? 'info';
  const norm = raw.toLowerCase() as LogLevel;
  if (norm in LEVEL_ORDER) return norm;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[resolveLevel()];
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    return ` ${meta.message}`;
  }
  if (typeof meta === 'string') {
    return ` ${meta}`;
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  /** Returns a child logger with a sub-tag. */
  child(subTag: string): Logger;
}

/**
 * Create a logger pinned to a module tag.
 *
 *   const log = createLogger('Daemon');
 *   log.info('Started');                  // → "[Daemon] info: Started"
 *   log.error('boom', err);               // → "[Daemon] error: boom <err.message>"
 *   log.warn('write failed', { path });   // → "[Daemon] warn: write failed {"path":"..."}"
 */
export function createLogger(tag: string): Logger {
  const prefix = tag.startsWith('[') ? tag : `[${tag}]`;

  function emit(level: LogLevel, message: string, meta?: unknown): void {
    if (!shouldLog(level)) return;
    const line = `${prefix} ${level}: ${message}${formatMeta(meta)}`;
    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  return {
    debug(message: string, meta?: unknown) { emit('debug', message, meta); },
    info(message: string, meta?: unknown) { emit('info', message, meta); },
    warn(message: string, meta?: unknown) { emit('warn', message, meta); },
    error(message: string, meta?: unknown) { emit('error', message, meta); },
    child(subTag: string) {
      const combined = prefix.replace(/^\[/, '').replace(/\]$/, '') + ':' + subTag;
      return createLogger(combined);
    },
  };
}
