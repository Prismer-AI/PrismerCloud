/**
 * Prismer IM Server — Centralized configuration
 *
 * Database is managed by Prisma using the main app's DATABASE_URL.
 */

/**
 * Build Redis URL from env vars.
 * REDIS_URL takes priority; otherwise construct from REDIS_HOST/PORT/PASSWORD/DB.
 */
function buildRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD || '';
  const db = process.env.REDIS_DB || '0';

  const auth = password ? `:${password}@` : '';
  return `redis://localhost:6379/${db}`;
}

export const config = {
  port: parseInt(process.env.IM_PORT || '3200', 10),
  host: process.env.IM_HOST || '0.0.0.0',

  redis: {
    url: buildRedisUrl(),
  },

  jwt: {
    // Use getter: JWT_SECRET may be injected by Nacos AFTER module load.
    // apiGuard (proxy layer) reads env dynamically — IM must match.
    get secret() {
      return process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'dev-secret-change-me';
    },
    get expiresIn() {
      return process.env.JWT_EXPIRES_IN || '7d';
    },
  },

  agent: {
    heartbeatIntervalMs: parseInt(process.env.AGENT_HEARTBEAT_INTERVAL_MS || '30000', 10),
    heartbeatTimeoutMs: parseInt(process.env.AGENT_HEARTBEAT_TIMEOUT_MS || '90000', 10),
  },

  ws: {
    authTimeoutMs: parseInt(process.env.WS_AUTH_TIMEOUT_MS || '10000', 10),
  },

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3100,http://localhost:3200').split(
      ',',
    ),
  },

  webhook: {
    secret: process.env.WEBHOOK_SECRET || 'dev-webhook-secret',
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
  },

  s3: {
    region: process.env.AWS_S3_REGION || process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.AWS_S3_BUCKET || 'pro-prismer-slide',
    accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
  },

  cdn: {
    domain: process.env.CDN_DOMAIN || '',
  },

  files: {
    maxSimpleSize: parseInt(process.env.FILES_MAX_SIMPLE_SIZE || '', 10) || 10 * 1024 * 1024,
    maxMultipartSize: parseInt(process.env.FILES_MAX_MULTIPART_SIZE || '', 10) || 50 * 1024 * 1024,
    partSize: 5 * 1024 * 1024,
    presignExpiry: parseInt(process.env.FILES_PRESIGN_EXPIRY || '', 10) || 600,
    uploadTTL: parseInt(process.env.FILES_UPLOAD_TTL || '', 10) || 3600,
    quotaFree: 1 * 1024 * 1024 * 1024,
    quotaPro: 10 * 1024 * 1024 * 1024,
    costPerMB: parseFloat(process.env.FILES_COST_PER_MB || '') || 0.5,
    s3KeyPrefix: process.env.FILES_S3_KEY_PREFIX || 'im/files',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
} as const;

export type Config = typeof config;
