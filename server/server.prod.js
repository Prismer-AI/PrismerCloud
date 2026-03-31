/**
 * Prismer Cloud — Production Custom Server (plain JS, no compilation needed)
 *
 * Strategy: Intercept http.createServer before loading Next.js standalone
 * server, so we can attach WebSocket (/ws) and SSE (/sse) to the same
 * HTTP server that Next.js creates internally via startServer().
 *
 * The original Next.js standalone server.js is renamed to _next_server.js
 * during Docker build, and this file takes its place as the entry point.
 *
 * IM services + handlers are stored in globalThis by instrumentation.ts →
 * bootstrap.ts. No imports from src/im/* needed.
 */

const http = require('http');
const { parse } = require('url');

// ── Intercept http.createServer to add WS + SSE ──────────────────────

const _originalCreateServer = http.createServer;

http.createServer = function (requestListener) {
  // Wrap the request listener to intercept SSE endpoint
  const wrappedListener = (req, res) => {
    const { pathname } = parse(req.url || '/', true);

    if (pathname === '/sse') {
      handleSSE(req, res);
      return;
    }

    // Everything else → Next.js
    requestListener(req, res);
  };

  // Create the actual HTTP server with our wrapped listener
  const server = _originalCreateServer.call(http, wrappedListener);

  // Attach WebSocket upgrade handler
  let wsModule;
  try {
    wsModule = require('ws');
  } catch {
    console.warn('[Server] ws module not found — WebSocket disabled');
    http.createServer = _originalCreateServer; // restore
    return server;
  }

  const wss = new wsModule.WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url || '/', true);

    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // Other upgrade requests (e.g. Next.js HMR in dev) pass through
  });

  // Wire up IM WebSocket handler once services are ready
  setupWSHandler(wss);

  console.log('[Server] HTTP intercepted — WS /ws + SSE /sse enabled');

  // Restore original createServer (only intercept once)
  http.createServer = _originalCreateServer;

  return server;
};

// ── Load the original Next.js standalone server ───────────────────────
// (It calls startServer() which calls http.createServer() — our patch above)
require('./_next_server.js');

// ── globalThis accessors ──────────────────────────────────────────────

function getIMServices() {
  return globalThis.__imServices;
}

function getIMHandlers() {
  return globalThis.__imHandlers;
}

// ── SSE handler ───────────────────────────────────────────────────────

function handleSSE(req, res) {
  const services = getIMServices();
  const handlers = getIMHandlers();

  if (!services || !handlers || !handlers.handleSSEConnection) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'IM Server not ready' }));
    return;
  }

  handlers.handleSSEConnection(req, res, {
    rooms: services.rooms,
    conversationService: services.conversationService,
    presenceService: services.presenceService,
  });
}

// ── WebSocket handler setup (polls for IM services) ───────────────────

async function setupWSHandler(wss) {
  // Poll until bootstrap completes (max 30s)
  for (let i = 0; i < 300; i++) {
    const services = getIMServices();
    const handlers = getIMHandlers();

    if (services && handlers && handlers.setupWebSocket) {
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

  console.warn('[Server] IM services not available after 30s — WebSocket disabled');
}
