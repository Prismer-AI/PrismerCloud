/**
 * Structured logger for Prismer Cloud.
 *
 * Production: JSON lines (compatible with K8s log aggregation / ELK / CloudWatch).
 * Development: human-readable output via pino-pretty.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info({ requestId, userId }, 'Context loaded');
 *   logger.error({ err, route: '/api/search' }, 'Search failed');
 *
 * Child loggers for modules:
 *   const log = logger.child({ module: 'EvolutionSelector' });
 *   log.info('Gene selected');
 */
import pino from 'pino';
import { appendLog } from './log-buffer';
import { redactObject } from './log-redaction';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * `hooks.streamWrite` — side-channel that copies every pino record into the
 * process-local ring buffer for `/api/sandboxes/_admin/system-logs` queries.
 *
 * Defense: parse the JSON, deep-redact (secrets never enter the buffer),
 * append. Returns the ORIGINAL serialized string so stdout / pino-pretty /
 * Datadog transports see exactly what they always did. Phase A intentionally
 * does not redact those transports; that's pino's own `redact` config in
 * Phase E (see docs/release201/06-debug-pipeline-design.md §5.2).
 *
 * Failure mode: any parse / append error is swallowed — the logger pipeline
 * must never throw out of `streamWrite`, or every `logger.info(...)` call
 * site becomes a potential crash.
 */
function bufferStreamWriteHook(serialized: string): string {
  try {
    const parsed = JSON.parse(serialized);
    if (parsed && typeof parsed === 'object') {
      const redacted = redactObject(parsed) as Record<string, unknown>;
      appendLog(redacted);
    }
  } catch {
    // Non-JSON line (rare — pino always emits JSON) — skip silently.
  }
  return serialized;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  // Pretty print in development only
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  // Base fields on every log line
  base: {
    service: 'prismer-cloud',
    version: process.env.npm_package_version || 'unknown',
  },
  // Serializers for common fields
  serializers: {
    err: pino.stdSerializers.err,
  },
  // Ring buffer side-channel; see comment on `bufferStreamWriteHook`.
  hooks: {
    streamWrite: bufferStreamWriteHook,
  },
});

/**
 * Create a child logger scoped to a module.
 * Equivalent to the old `console.log('[ModuleName]')` pattern.
 */
export function createModuleLogger(module: string) {
  return logger.child({ module });
}
