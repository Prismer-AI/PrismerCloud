/**
 * IM Server Bootstrap — Node.js only
 *
 * Called from instrumentation.ts via dynamic import.
 * Creates the Hono app (no port binding) and stores it globally.
 * Next.js proxy route calls getIMApp().fetch() directly — in-process, single port.
 *
 * This file is NEVER evaluated in Edge Runtime.
 */

import path from 'path';
import type { Hono } from 'hono';
import type { IMAppResult } from './server';

// Force Next.js standalone trace to include IM server dependencies.
import 'hono';
import '@hono/node-server';
import 'ws';
import 'ioredis';

// Global storage — survives Turbopack HMR reloads
const globalForIM = globalThis as unknown as {
  __imApp?: Hono;
  __imServices?: IMAppResult;
  __imHandlers?: {
    setupWebSocket: typeof import('./ws/handler').setupWebSocket;
    handleSSEConnection: typeof import('./sse/handler').handleSSEConnection;
  };
  __imStarted?: boolean;
};

/**
 * Get the initialized Hono IM app.
 * Returns undefined if not yet initialized.
 */
export function getIMApp(): Hono | undefined {
  return globalForIM.__imApp;
}

/**
 * Get the full IM service bag (rooms, services, redis).
 * Used by the custom server to wire up WebSocket and SSE handlers.
 */
export function getIMServices(): IMAppResult | undefined {
  return globalForIM.__imServices;
}

/**
 * Get WS/SSE handler functions.
 * Stored in globalThis so the custom server (compiled by tsup) doesn't
 * need to import src/im/* files directly — avoids path resolution issues
 * in Next.js standalone builds.
 */
export function getIMHandlers() {
  return globalForIM.__imHandlers;
}

/**
 * Ensure DATABASE_URL is set before IM server imports Prisma.
 */
function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return;

  if (process.env.NODE_ENV !== 'production') {
    const dbPath = path.resolve(process.cwd(), 'prisma/data/dev.db');
    process.env.DATABASE_URL = `file:${dbPath}`;
  } else {
    const host = process.env.REMOTE_MYSQL_HOST || process.env.MYSQL_HOST || 'localhost';
    const port = process.env.REMOTE_MYSQL_PORT || process.env.MYSQL_PORT || '3306';
    const user = process.env.REMOTE_MYSQL_USER || process.env.MYSQL_USER || 'root';
    const password = process.env.REMOTE_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '';
    const database = process.env.REMOTE_MYSQL_DATABASE || process.env.MYSQL_DATABASE || 'prismer_cloud';
    process.env.DATABASE_URL = `mysql://${user}:${password}@${host}:${port}/${database}`;
  }
}

export async function bootstrapIMServer() {
  // Singleton guard
  if (globalForIM.__imStarted) return;
  globalForIM.__imStarted = true;

  try {
    // In production, load Nacos config first so REMOTE_MYSQL_* env vars are available.
    if (process.env.NODE_ENV === 'production') {
      const { ensureNacosConfig } = await import('@/lib/nacos-config');
      await ensureNacosConfig();
      console.log('[IM Server] Nacos config loaded');
    }

    ensureDatabaseUrl();

    const { createApp } = await import('./server');
    const result = await createApp();

    // Store Hono app and services globally for Next.js proxy + custom server
    globalForIM.__imApp = result.app;
    globalForIM.__imServices = result;

    // Store handler functions so custom server can use them via globalThis
    // (avoids tsup needing to resolve src/im/* paths in standalone builds)
    const { setupWebSocket } = await import('./ws/handler');
    const { handleSSEConnection } = await import('./sse/handler');
    globalForIM.__imHandlers = { setupWebSocket, handleSSEConnection };

    console.log('[IM Server] Ready (in-process, no separate port)');
  } catch (err) {
    console.error('[IM Server] Failed to start:', err);
    globalForIM.__imStarted = false;
  }
}
