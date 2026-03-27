/**
 * Prismer Cloud — Custom Server
 *
 * Replaces the default Next.js server to provide:
 *   - HTTP: Next.js pages + API routes (port 3000)
 *   - WebSocket: /ws — real-time IM events
 *   - SSE: /sse — server-push for clients that can't use WebSocket
 *
 * All three share the same port and process.
 *
 * IMPORTANT: This file must NOT import any src/im/* files directly.
 * IM services and handlers are loaded by instrumentation.ts → bootstrap.ts
 * and stored in globalThis. The custom server reads them from there.
 * This avoids tsup needing to resolve src/im/* paths in standalone builds.
 *
 * Dev:  npx tsx --watch server.ts
 * Prod: node server.js (compiled by tsup during Docker build)
 */

import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

// ─── globalThis accessors (populated by bootstrap.ts via instrumentation.ts) ───

function getIMServices(): any {
  return (globalThis as any).__imServices;
}

function getIMHandlers(): { setupWebSocket?: Function; handleSSEConnection?: Function } | undefined {
  return (globalThis as any).__imHandlers;
}

async function main() {
  // ─── 1. Next.js app ────────────────────────────────────────
  const app = next({ dev, hostname, port });
  await app.prepare(); // This triggers instrumentation.ts → bootstrapIMServer()

  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  // ─── 2. HTTP server ────────────────────────────────────────
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);

      // SSE endpoint
      if (parsedUrl.pathname === '/sse') {
        const services = getIMServices();
        const handlers = getIMHandlers();
        if (!services || !handlers?.handleSSEConnection) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'IM Server not ready' }));
          return;
        }
        handlers.handleSSEConnection(req, res, {
          rooms: services.rooms,
          conversationService: services.conversationService,
          presenceService: services.presenceService,
        });
        return;
      }

      // Everything else → Next.js
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('[Server] Error handling request:', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  // ─── 3. WebSocket server ───────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = parse(req.url!, true);

    if (pathname === '/ws') {
      // IM WebSocket
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      // Next.js HMR WebSocket (dev mode) + any other upgrades
      upgrade(req, socket, head);
    }
  });

  // ─── 4. Wire up WS handler once IM services are ready ─────
  setupWSHandler(wss);

  // ─── 5. Start listening ────────────────────────────────────
  server.listen(port, hostname, () => {
    console.log(`> Server ready on http://${hostname}:${port}`);
    console.log(`> WebSocket: ws://${hostname}:${port}/ws`);
    console.log(`> SSE: http://${hostname}:${port}/sse`);
  });

  // ─── 6. Graceful shutdown ──────────────────────────────────
  const shutdown = () => {
    console.log('\nShutting down...');
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Wait for IM services to be available, then wire up WebSocket handler.
 * Services are bootstrapped asynchronously by instrumentation.ts.
 */
async function setupWSHandler(wss: WebSocketServer): Promise<void> {
  // Poll until bootstrap completes (max 30s)
  for (let i = 0; i < 300; i++) {
    const services = getIMServices();
    const handlers = getIMHandlers();
    if (services && handlers?.setupWebSocket) {
      handlers.setupWebSocket(wss, {
        redis: services.redis,
        rooms: services.rooms,
        messageService: services.messageService,
        conversationService: services.conversationService,
        presenceService: services.presenceService,
        agentService: services.agentService,
        streamService: services.streamService,
      });
      console.log('[Server] WebSocket handler ready');
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.warn('[Server] IM services not available — WebSocket disabled');
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
