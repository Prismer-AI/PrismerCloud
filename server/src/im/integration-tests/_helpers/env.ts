/**
 * Integration-test environment configuration.
 *
 * Everything resolves at module load — keep this small so suites don't pay a
 * dynamic-env cost per call. Override via env vars when running against a
 * non-default target (e.g. `TEST_TARGET=https://cloud.prismer.dev npm run test:integration`).
 */

export const TEST_TARGET = (process.env.TEST_TARGET ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');

/**
 * Direct DB URL used only by helpers that need to verify state out-of-band
 * (e.g. assert a row was actually written). Most suites should go through
 * the HTTP API instead.
 */
export const TEST_DB_URL = process.env.DATABASE_URL ?? null;

export const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 30_000);

/**
 * Default API prefix appended when a caller passes a bare path (e.g. `/users/me`).
 * Paths starting with `/api/` bypass the prefix — see http.ts.
 */
export const TEST_API_PREFIX = '/api/im';
