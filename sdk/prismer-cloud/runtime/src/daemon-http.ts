import * as http from 'node:http';
import type { EventBus } from './event-bus.js';
import type { AgentSupervisor } from './agent-supervisor.js';
import type { FsContext } from '@prismer/sandbox-runtime';
import { sendJson, readBody, extractBearer } from './http/helpers.js';
import { handleSse } from './http/sse.js';
import type { SseDeps } from './http/sse.js';
import {
  handleFsRead,
  handleFsWrite,
  handleFsDelete,
  handleFsEdit,
  handleFsList,
  handleFsSearch,
} from './http/fs-routes.js';
import type { FsRoutesDeps } from './http/fs-routes.js';
import {
  handleAgentList,
  handleAgentGet,
  handleAgentRegister,
  handleAgentMessage,
  handleAgentStop,
  handleAgentApprove,
} from './http/agent-routes.js';
import type { AgentRoutesDeps } from './http/agent-routes.js';
import { PairingManager } from './pairing-manager.js';
import { EventHandler } from './event-handler.js';

// ============================================================
// Public types
// ============================================================

/** Authenticated identity returned by the authenticate callback. */
export interface AuthenticatedIdentity {
  agentId: string;
  bearerSub?: string;
}

export interface DaemonHttpOptions {
  host?: string;
  port?: number;
  eventBus: EventBus;
  supervisor: AgentSupervisor;
  fsContextProvider?: (req: { agentId: string; workspace?: string }) => FsContext | undefined;
  pairingManager?: PairingManager;
  eventHandler?: EventHandler; // Optional event handler for PARA events
  /** When provided, every non-health request must carry a valid Bearer token (null = 401).
   *  When absent, localhost trust mode: body agentId is used as-is. */
  authenticate?: (bearerToken: string | undefined) => AuthenticatedIdentity | null;
}

/** Generic extension-point route handler registered via registerRoute() (Q3). */
export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
) => Promise<void> | void;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

// ============================================================
// DaemonHttpServer — thin dispatcher
// ============================================================

export class DaemonHttpServer {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _bus: EventBus;
  private readonly _supervisor: AgentSupervisor;
  private readonly _fsCtxProvider?: DaemonHttpOptions['fsContextProvider'];
  private readonly _authenticate?: DaemonHttpOptions['authenticate'];
  private readonly _pairingManager: PairingManager;
  private readonly _eventHandler?: EventHandler;

  private _server: http.Server | undefined;
  private _url: string | undefined;
  private _running = false;

  private readonly _sseClients = new Set<http.ServerResponse>();
  private readonly _inFlight = new Set<http.ServerResponse>();
  private readonly _startedAt = Date.now();

  // Extension-point route registry (Q3)
  private readonly _customRoutes = new Map<string, RouteHandler>();

  constructor(opts: DaemonHttpOptions) {
    this._host = opts.host ?? DEFAULT_HOST;
    this._port = opts.port ?? DEFAULT_PORT;
    this._bus = opts.eventBus;
    this._supervisor = opts.supervisor;
    this._fsCtxProvider = opts.fsContextProvider;
    this._authenticate = opts.authenticate;
    this._pairingManager = opts.pairingManager ?? new PairingManager();
    this._eventHandler = opts.eventHandler;
  }

  get url(): string | undefined { return this._url; }
  get isRunning(): boolean { return this._running; }

  // Extension-point route registration (Q3)
  // ============================================================

  /** Register a custom route handler. Built-in routes take precedence. */
  registerRoute(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    handler: RouteHandler,
  ): void {
    this._customRoutes.set(`${method}:${path}`, handler);
  }

  /** Remove a previously registered custom route. */
  unregisterRoute(method: string, path: string): void {
    this._customRoutes.delete(`${method}:${path}`);
  }

  private _findCustomRoute(method: string, pathname: string): RouteHandler | undefined {
    const exact = this._customRoutes.get(`${method}:${pathname}`);
    if (exact !== undefined) return exact;

    const withoutPrefix = pathname.startsWith('/api/v1/')
      ? pathname.slice('/api/v1'.length)
      : pathname;
    if (withoutPrefix !== pathname) {
      const prefixedExact = this._customRoutes.get(`${method}:${withoutPrefix}`);
      if (prefixedExact !== undefined) return prefixedExact;
    }

    for (const [key, handler] of this._customRoutes) {
      const sep = key.indexOf(':');
      if (sep < 0 || key.slice(0, sep) !== method) continue;
      const routePath = key.slice(sep + 1);
      if (routePath.indexOf(':') < 0) continue;
      if (routeMatches(routePath, pathname) || routeMatches(routePath, withoutPrefix)) {
        return handler;
      }
    }

    return undefined;
  }

  // Lifecycle
  // ============================================================

  start(): Promise<{ host: string; port: number }> {
    return new Promise<{ host: string; port: number }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this._handleRequest(req, res);
      });
      server.on('error', reject);
      // Swallow expected socket errors (ECONNRESET during teardown / client abort)
      server.on('clientError', (_err, socket) => {
        if (!socket.destroyed) socket.destroy();
      });
      server.listen(this._port, this._host, () => {
        const addr = server.address();
        if (!addr || typeof addr !== 'object') {
          reject(new Error('Failed to obtain bound address'));
          return;
        }
        this._server = server;
        this._running = true;
        this._url = `http://${addr.address}:${addr.port}`;

        // Start event handler if provided
        if (this._eventHandler) {
          this._eventHandler.start();
        }

        resolve({ host: addr.address, port: addr.port });
      });
    });
  }

  async stop(timeoutMs: number = STOP_GRACE_MS): Promise<void> {
    if (!this._server || !this._running) return;
    this._running = false;
    const server = this._server;

    // Stop event handler if provided
    if (this._eventHandler) {
      this._eventHandler.stop();
    }

    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        for (const res of this._inFlight) res.destroy();
        for (const res of this._sseClients) res.destroy();
        this._inFlight.clear();
        this._sseClients.clear();
        resolve();
      }, timeoutMs);
      deadline.unref();

      for (const res of this._sseClients) res.end();
      this._sseClients.clear();

      // Force-close all lingering keep-alive / in-flight connections so
      // server.close() resolves immediately instead of waiting for idle
      // timeout — prevents ECONNRESET errors from writes to dying sockets.
      server.closeAllConnections();

      server.close(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }

  // ============================================================
  // Request dispatcher
  // ============================================================

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this._inFlight.add(res);

    // Swallow write errors on the response (e.g. ECONNRESET when the client
    // disconnects or the socket is torn down during server.stop()).  Without
    // this handler the error becomes "unhandled" and poisons the process exit
    // code even though every test passes.
    res.on('error', () => {});

    const timeoutHandle = setTimeout(() => {
      if (!res.headersSent) {
        sendJson(res, 503, { error: 'timeout' });
      } else {
        res.destroy();
      }
    }, REQUEST_TIMEOUT_MS);

    res.on('finish', () => { clearTimeout(timeoutHandle); this._inFlight.delete(res); });
    res.on('close',  () => { clearTimeout(timeoutHandle); this._inFlight.delete(res); });

    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;

    try {
      // Health — always auth-free
      if (method === 'GET' && pathname === '/api/v1/health') {
        return this._handleHealth(res);
      }

      // Auth gate
      let authed: AuthenticatedIdentity | null = null;
      if (this._authenticate !== undefined && !isAuthBypassedPath(method, pathname)) {
        const token = extractBearer(req);
        const identity = this._authenticate(token);
        if (identity === null) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        authed = identity;
      }

      // Shared deps structs
      const agentDeps: AgentRoutesDeps = { supervisor: this._supervisor, bus: this._bus };
      const fsDeps: FsRoutesDeps = { fsContextProvider: this._fsCtxProvider };
      const sseDeps: SseDeps = { bus: this._bus, sseClients: this._sseClients };

      // ---- Agents ----
      if (method === 'GET' && pathname === '/api/v1/agents') {
        return handleAgentList(res, agentDeps);
      }
      if (method === 'POST' && pathname === '/api/v1/agents/register') {
        return await handleAgentRegister(req, res, agentDeps);
      }
      const agentDetailMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
      if (method === 'GET' && agentDetailMatch) {
        return handleAgentGet(res, agentDetailMatch[1], agentDeps);
      }
      const agentActionMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/([^/]+)$/);
      if (agentActionMatch) {
        const agentId = agentActionMatch[1];
        const action = agentActionMatch[2];
        if (method === 'POST' && action === 'message') {
          return await handleAgentMessage(req, res, agentId, agentDeps);
        }
        if (method === 'POST' && action === 'stop') {
          return await handleAgentStop(req, res, agentId, agentDeps);
        }
        if (method === 'POST' && action === 'approve') {
          return await handleAgentApprove(req, res, agentId, agentDeps);
        }
      }

      // ---- SSE ----
      if (method === 'GET' && pathname === '/api/v1/events') {
        return handleSse(req, res, url, sseDeps);
      }

      // ---- Pairing ----
      if (method === 'POST' && pathname === '/api/v1/pair/offer') {
        return await this._handlePairOffer(req, res);
      }
      if (method === 'GET' && pathname === '/api/v1/pair/status') {
        return this._handlePairStatus(res, url);
      }
      if (method === 'POST' && pathname === '/api/v1/pair/confirm') {
        return await this._handlePairConfirm(req, res);
      }

      // ---- Transport routes ----
      if (method === 'GET' && pathname === '/v1/lan-probe') {
        return this._handleLanProbe(req, res);
      }
      if (method === 'GET' && pathname === '/api/v1/transport/status') {
        return this._handleTransportStatus(res);
      }
      if (method === 'POST' && pathname === '/api/v1/transport/reprobe') {
        return this._handleTransportReprobe(res);
      }

      // ---- FS routes ----
      if (method === 'POST' && pathname === '/api/v1/fs/read') {
        return await handleFsRead(req, res, fsDeps, authed);
      }
      if (method === 'POST' && pathname === '/api/v1/fs/write') {
        return await handleFsWrite(req, res, fsDeps, authed);
      }
      if (method === 'POST' && pathname === '/api/v1/fs/delete') {
        return await handleFsDelete(req, res, fsDeps, authed);
      }
      if (method === 'POST' && pathname === '/api/v1/fs/edit') {
        return await handleFsEdit(req, res, fsDeps, authed);
      }
      if (method === 'POST' && pathname === '/api/v1/fs/list') {
        return await handleFsList(req, res, fsDeps, authed);
      }
      if (method === 'POST' && pathname === '/api/v1/fs/search') {
        return await handleFsSearch(req, res, fsDeps, authed);
      }

      // ---- GUI routes (v1.9.0 Pattern P9 — L9 GUI Integration) ----
      // Stable read-only HTTP for GUI consumers (luminpulse, web console).
      // Mirrors /agents but scoped to human presentation and versioned
      // independently so GUI tooling can pin to /gui/v1 without churn.
      if (method === 'GET' && pathname === '/api/v1/gui/agents') {
        return handleAgentList(res, agentDeps);
      }
      if (method === 'GET' && pathname === '/api/v1/gui/status') {
        // Lightweight "everything-in-one" snapshot for dashboard consumers.
        return sendJson(res, 200, {
          daemon: {
            pid: process.pid,
            uptime: process.uptime(),
            version: '1.9.0',
          },
          agents: this._supervisor ? this._supervisor.list() : [],
          transport: await this._snapshotTransportStatus(),
        });
      }

      // ---- Custom extension routes (Q3) ----
      const customHandler = this._findCustomRoute(method, pathname);
      if (customHandler !== undefined) {
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch (err: unknown) {
          if (err instanceof Error && (err as Error & { code?: string }).code === 'E_TOO_LARGE') {
            return sendJson(res, 413, { error: 'body-too-large', max: 10 * 1024 * 1024 });
          }
          return sendJson(res, 400, { error: 'read-error' });
        }
        await customHandler(req, res, { authed, body });
        return;
      }

      sendJson(res, 404, { error: 'not-found' });
    } catch (err: unknown) {
      if (res.headersSent) return;
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  // ============================================================
  // Health handler (inline — too small to extract)
  // ============================================================

  private _handleHealth(res: http.ServerResponse): void {
    const agents = this._supervisor.list();
    const rssBytes = process.memoryUsage().rss;
    const addr = this._server?.address();
    const port = addr !== null && typeof addr === 'object' ? addr.port : this._port;
    sendJson(res, 200, {
      status: 'ok',
      daemon: {
        pid: process.pid,
        uptime: Date.now() - this._startedAt,
        state: 'running',
        rssBytes,
        port,
      },
      counts: {
        agents: agents.length,
        subscriptions: this._bus.subscriberCount,
      },
    });
  }

  private async _handlePairOffer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'E_TOO_LARGE') {
        return sendJson(res, 413, { error: 'body-too-large', max: 10 * 1024 * 1024 });
      }
      return sendJson(res, 400, { error: 'read-error' });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) as Record<string, unknown> : {};
    } catch {
      return sendJson(res, 400, { error: 'bad-json' });
    }
    const ttlSec = typeof parsed['ttlSec'] === 'number' ? parsed['ttlSec'] : undefined;
    const offer = this._pairingManager.createOffer(ttlSec);
    sendJson(res, 201, {
      ok: true,
      data: {
        offer: offer.offer,
        uri: offer.uri,
        expiresAt: offer.expiresAt,
      },
    });
  }

  private _handlePairStatus(res: http.ServerResponse, url: URL): void {
    const offer = url.searchParams.get('offer');
    if (!offer) {
      sendJson(res, 400, { error: 'missing-offer' });
      return;
    }

    const status = this._pairingManager.getStatus(offer);
    if (!status) {
      sendJson(res, 404, { error: 'offer-not-found', paired: false });
      return;
    }
    sendJson(res, 200, status);
  }

  private async _handlePairConfirm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'E_TOO_LARGE') {
        return sendJson(res, 413, { error: 'body-too-large', max: 10 * 1024 * 1024 });
      }
      return sendJson(res, 400, { error: 'read-error' });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) as Record<string, unknown> : {};
    } catch {
      return sendJson(res, 400, { error: 'bad-json' });
    }

    const offer = typeof parsed['offer'] === 'string' ? parsed['offer'] : undefined;
    if (!offer) {
      return sendJson(res, 400, { error: 'missing-offer' });
    }

    try {
      const status = this._pairingManager.confirm(offer, {
        bindingId: typeof parsed['bindingId'] === 'string' ? parsed['bindingId'] : undefined,
        deviceName: typeof parsed['deviceName'] === 'string' ? parsed['deviceName'] : undefined,
        transport: parsed['transport'] === 'relay' ? 'relay' : 'lan',
        clientPubKey: typeof parsed['clientPubKey'] === 'string' ? parsed['clientPubKey'] : undefined,
      });
      sendJson(res, 200, { ok: true, ...status });
    } catch (err) {
      const e = err as Error & { status?: number };
      sendJson(res, e.status ?? 500, { ok: false, error: e.message });
    }
  }

  // ============================================================
  // Transport status handler
  // ============================================================

  private _handleTransportStatus(res: http.ServerResponse): void {
    // Four-state enum. Old schema lied: a fresh daemon with credentials
    // configured but no reachable cloud reported "disabled" even while the
    // relay prober was firing 404s in the background. Now:
    //   disabled     - TransportManager not instantiated (no cloud configured)
    //   probing      - enabled, first probe pass not complete
    //   connected    - a path is selected and health checks are green
    //   unreachable  - probes have run and all paths failed (or no path met the
    //                  latency threshold); `lastError` carries the short diag
    const transportManager = (globalThis as any).__transportManager as {
      getStatus: () => {
        currentPath: string | null;
        currentEndpoint: string | null;
        connected: boolean;
        latencyMs: number;
        lastHealthCheck: number;
        probesCompleted?: boolean;
        lastError?: string | null;
        paths: {
          [key: string]: {
            available: boolean;
            latencyMs: number;
            lastProbed: number;
          };
        };
      };
    } | undefined;

    if (!transportManager) {
      sendJson(res, 200, {
        status: 'disabled',
        message: 'Multi-path transport is not enabled',
      });
      return;
    }

    const status = transportManager.getStatus();

    // Derive the enum. `connected` requires both a currentPath and the
    // connection flag — e.g. relay may be "switched to" momentarily but
    // the WS is still reconnecting.
    let derived: 'probing' | 'connected' | 'unreachable';
    if (status.connected && status.currentPath !== null) {
      derived = 'connected';
    } else if (!status.probesCompleted) {
      derived = 'probing';
    } else {
      derived = 'unreachable';
    }

    const body: {
      status: 'probing' | 'connected' | 'unreachable';
      path?: string | null;
      latencyMs?: number;
      lastError?: string | null;
      transport: {
        currentPath: string | null;
        currentEndpoint: string | null;
        connected: boolean;
        latencyMs: number;
        lastHealthCheck: number;
        paths: unknown;
      };
    } = {
      status: derived,
      transport: {
        currentPath: status.currentPath,
        currentEndpoint: status.currentEndpoint,
        connected: status.connected,
        latencyMs: status.latencyMs,
        lastHealthCheck: status.lastHealthCheck,
        paths: status.paths,
      },
    };
    if (derived === 'connected') {
      body.path = status.currentPath;
      body.latencyMs = status.latencyMs;
    } else if (derived === 'unreachable') {
      body.lastError = status.lastError ?? null;
    }
    sendJson(res, 200, body);
  }

  /** Read-only snapshot of transport state, used by /gui/status. Returns
   *  null when the multi-path transport isn't enabled. */
  private async _snapshotTransportStatus(): Promise<unknown> {
    const transportManager = (globalThis as any).__transportManager as
      | { getStatus: () => unknown }
      | undefined;
    return transportManager ? transportManager.getStatus() : null;
  }

  // ============================================================
  // LAN probe handler (for client connection probing)
  // ============================================================

  private _handleLanProbe(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Verify client is from same subnet for security
    const clientIP = req.socket.remoteAddress;
    if (!clientIP) {
      sendJson(res, 403, { error: 'forbidden', message: 'Could not determine client IP' });
      return;
    }

    // Extract server address
    const addr = this._server?.address();
    if (!addr || typeof addr !== 'object') {
      sendJson(res, 500, { error: 'internal', message: 'Could not get server address' });
      return;
    }

    // Get daemon info from global storage
    const daemonInfo = (globalThis as any).__daemonInfo as {
      daemonId?: string;
      version?: string;
      lanIP?: string;
      port?: number;
    };

    const daemonId = daemonInfo?.daemonId || 'unknown';
    const version = daemonInfo?.version || '1.9.0';
    const lanIP = daemonInfo?.lanIP || addr.address;
    const port = daemonInfo?.port || addr.port;

    // Log probe request for debugging
    console.log(`[Daemon] LAN probe from ${clientIP} -> responding with ${lanIP}:${port}`);

    sendJson(res, 200, {
      daemonId,
      lanIP,
      port,
      version,
      timestamp: Date.now(),
      capabilities: [
        'e2ee',
        'binary-multiplex',
        'connection-probing',
      ],
    });
  }

  // ============================================================
  // Transport reprobe handler
  // ============================================================

  private async _handleTransportReprobe(res: http.ServerResponse): Promise<void> {
    const transportManager = (globalThis as any).__transportManager as {
      forceReprobe: () => Promise<void>;
    };

    if (!transportManager) {
      sendJson(res, 400, {
        error: 'transport_disabled',
        message: 'Multi-path transport is not enabled',
      });
      return;
    }

    try {
      await transportManager.forceReprobe();
      sendJson(res, 200, {
        status: 'ok',
        message: 'Reprobe initiated',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, {
        error: 'reprobe_failed',
        message: msg,
      });
    }
  }
}

/**
 * Routes that bypass the bearer-token auth gate even when `authenticate` is
 * configured. Mirrors the rationale at `runner.ts:415` for register-mode-b:
 * Localhost-only — loopback validation is the boundary. The dispatch endpoint
 * (`/adapters/dispatch`) is intentionally NOT in this list — it can carry
 * remote caller payloads in production and must remain authenticated.
 *
 * Exported for test access — see test/daemon-http-auth-bypass.test.ts.
 */
export const AUTH_BYPASS_PATHS: ReadonlyArray<{ method: string; pathname: string }> = [
  { method: 'POST', pathname: '/api/v1/adapters/register-mode-b' },
];

function isAuthBypassedPath(method: string, pathname: string): boolean {
  for (const entry of AUTH_BYPASS_PATHS) {
    if (entry.method === method && entry.pathname === pathname) return true;
  }
  return false;
}

function routeMatches(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    if (patternPart.startsWith(':')) continue;
    if (patternPart !== pathParts[i]) return false;
  }

  return true;
}
