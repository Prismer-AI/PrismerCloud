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

const isDev = process.env.NODE_ENV !== 'production';

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
});

/**
 * Create a child logger scoped to a module.
 * Equivalent to the old `console.log('[ModuleName]')` pattern.
 */
export function createModuleLogger(module: string) {
  return logger.child({ module });
}
