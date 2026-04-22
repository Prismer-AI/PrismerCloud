/**
 * mode-b-bridge.ts — OpenClaw → Prismer daemon Mode B handshake (v1.9.x Task 3)
 *
 * Per docs/version190/22-adapter-integration-contract.md §3.2 (HTTP loopback
 * pattern): OpenClaw runs as a separate process from the Prismer daemon, so
 * the elegant `globalThis.__prismerAdapterRegistry?.register(...)` Mode B
 * pattern doesn't work cross-process. Instead:
 *
 *   1. The OpenClaw plug-in (this file) starts a tiny HTTP listener on a
 *      randomly-chosen 127.0.0.1:<port> with POST /dispatch.
 *   2. It POSTs to the daemon's /api/v1/adapters/register-mode-b
 *      announcing { name: 'openclaw', loopbackUrl }.
 *   3. The daemon builds a Mode B AdapterImpl pointing at that loopback
 *      and replaces the auto-register CLI shim.
 *
 * For v1.9.x scope this ships the FRAMEWORK — the local /dispatch handler
 * returns a stub response. The OpenClaw team will fill in the actual
 * command dispatch in their next sprint.
 *
 * All operations are best-effort. Failures (daemon down, port in use,
 * etc.) log and continue — the OpenClaw plug-in must never abort just
 * because PARA Mode B couldn't connect.
 */

import * as http from 'node:http';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

// ---------------------------------------------------------------------------
// notifyDaemonOfPresence
// ---------------------------------------------------------------------------

export interface NotifyOptions {
  daemonHttpBase: string; // e.g. 'http://127.0.0.1:3210'
  name: string; // e.g. 'openclaw'
  loopbackUrl: string; // e.g. 'http://127.0.0.1:54321'
  timeoutMs?: number;
}

export interface NotifyResult {
  ok: boolean;
  error?: string;
  /** When daemon returned 200, whether it replaced an existing shim. */
  replaced?: boolean;
}

/**
 * Best-effort POST to the daemon's register-mode-b endpoint. Never throws —
 * failures are returned as { ok: false }.
 */
export async function notifyDaemonOfPresence(opts: NotifyOptions): Promise<NotifyResult> {
  const url = stripTrailingSlash(opts.daemonHttpBase) + '/api/v1/adapters/register-mode-b';
  const timeoutMs = opts.timeoutMs ?? 3000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opts.name,
        loopbackUrl: opts.loopbackUrl,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = await resp.text(); } catch { /* ignore */ }
      return { ok: false, error: `daemon_${resp.status}${detail ? `:${detail.slice(0, 200)}` : ''}` };
    }
    let parsed: any;
    try {
      parsed = await resp.json();
    } catch {
      // Daemon returned 200 but unparseable body — treat as success since the
      // status code is the source of truth.
      return { ok: true };
    }
    return { ok: true, replaced: parsed?.replaced === true };
  } catch (err) {
    return { ok: false, error: `network:${(err as Error).message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// startLocalDispatchListener
// ---------------------------------------------------------------------------

export interface DispatchListenerHandle {
  /** Full base URL e.g. 'http://127.0.0.1:54321'. */
  url: string;
  /** Stop the listener (idempotent). */
  close(): Promise<void>;
}

/**
 * Bind a tiny HTTP server on 127.0.0.1:<random-free-port>. Routes:
 *
 *   POST /dispatch   — body { taskId, capability, prompt, ... }
 *                      Stub response: { ok: true, output: '[openclaw-mode-b stub] ...' }
 *                      OpenClaw team replaces with real dispatch in next sprint.
 *
 * Anything else returns 404. Malformed JSON / missing required fields → 400.
 */
export async function startLocalDispatchListener(): Promise<DispatchListenerHandle> {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/reset') {
      // v1.9.x agent_restart hook (see runtime adapter-registry.ts
      // AdapterImpl.reset contract). The adapter host clears any
      // in-memory per-agent session state (conversation history, cached
      // tool handles, etc.). Body: { agentName?: string }. The v1.9.x
      // OpenClaw bridge is stateless — each /dispatch is independent —
      // so we ack noop. A future stateful host can hook in here to drop
      // its per-agentName caches before responding.
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: any = {};
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.length > 0) body = JSON.parse(raw);
        } catch {
          // Tolerate malformed bodies — reset semantics don't require
          // a parseable body. The adapter host is free to treat an
          // absent agentName as "reset all".
          body = {};
        }
        const agentName = typeof body?.agentName === 'string' ? body.agentName : undefined;
        const payload = JSON.stringify({
          ok: true,
          state: 'openclaw_bridge_noop',
          agentName,
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
      });
      req.on('error', () => {
        try {
          const err = JSON.stringify({ ok: false, error: 'request_error' });
          res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
          res.end(err);
        } catch {
          // socket may already be torn down
        }
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/dispatch') {
      const err = JSON.stringify({ ok: false, error: 'not_found' });
      res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        const err = JSON.stringify({ ok: false, error: 'invalid_json' });
        res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
        res.end(err);
        return;
      }
      if (
        typeof body.taskId !== 'string' ||
        typeof body.capability !== 'string' ||
        typeof body.prompt !== 'string'
      ) {
        const err = JSON.stringify({
          ok: false,
          error: 'taskId, capability, prompt (string) required',
        });
        res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
        res.end(err);
        return;
      }
      // >>> REPLACE-ME-IN-NEXT-SPRINT >>>
      // The stub returns ok:false to surface unimplemented status to cloud TaskRouter.
      // OpenClaw team: replace this whole block with the real dispatch path.
      //
      // Why ok:false (not ok:true with a "stub" marker): the cloud TaskRouter
      // maps `ok:false` → `im_tasks.status = failed`. Returning ok:true with a
      // string-substring marker lets unfinished work pretend to succeed; that
      // is exactly the failure mode the I4 review caught. The HTTP status stays
      // 200 because the request *did* reach the right handler — the failure is
      // at the application layer, not the transport layer.
      const payload = JSON.stringify({
        ok: false,
        error: 'mode_b_stub_not_implemented',
        metadata: {
          mode: 'mode_b_stub',
          adapter: 'openclaw',
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    });
    req.on('error', () => {
      try {
        const err = JSON.stringify({ ok: false, error: 'request_error' });
        res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
        res.end(err);
      } catch {
        // socket may already be torn down
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('mode-b-bridge: listener failed to bind');
  }
  const url = `http://127.0.0.1:${addr.port}`;

  const handle: DispatchListenerHandle = {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  return handle;
}

// ---------------------------------------------------------------------------
// startModeBBridge — convenience wrapper called by index.ts::register
// ---------------------------------------------------------------------------

export interface StartModeBBridgeOptions {
  /** Daemon base URL. Default: http://127.0.0.1:3210 */
  daemonHttpBase?: string;
  /** Adapter name to register under. Default: 'openclaw' */
  name?: string;
  /**
   * Re-registration heartbeat interval. Default 60_000 (60s). Tests may pass a
   * smaller value alongside vi.useFakeTimers() to avoid real-time waits.
   */
  heartbeatMs?: number;
}

export interface StartModeBBridgeResult {
  /** The local dispatch listener handle (call .close() on shutdown). */
  listener?: DispatchListenerHandle;
  /** Whether the daemon registration succeeded. */
  registered: boolean;
  /** Detail of the registration outcome (for logging). */
  notifyResult?: NotifyResult;
  /**
   * Stop the periodic re-registration heartbeat (idempotent). Returns
   * undefined when no heartbeat was started (e.g. listener bind failed).
   * Tests should call this in afterEach to avoid leaking timers.
   */
  stopHeartbeat?: () => void;
}

/**
 * Wire both sides of the Mode B bridge:
 *   1. Start the local /dispatch listener (best-effort, returns undefined on bind failure).
 *   2. Notify the daemon (best-effort, never throws).
 *
 * This is fire-and-forget from the plug-in's perspective; failures only
 * log and never block OpenClaw startup.
 */
export async function startModeBBridge(
  api: OpenClawPluginApi,
  opts?: StartModeBBridgeOptions,
): Promise<StartModeBBridgeResult> {
  const daemonHttpBase = opts?.daemonHttpBase ?? 'http://127.0.0.1:3210';
  const name = opts?.name ?? 'openclaw';
  const heartbeatMs = opts?.heartbeatMs ?? 60_000;

  const log = (msg: string): void => {
    try {
      api.logger?.info?.(msg);
    } catch {
      try { process.stderr.write(msg + '\n'); } catch { /* ignore */ }
    }
  };
  const warn = (msg: string): void => {
    try {
      api.logger?.warn?.(msg);
    } catch {
      try { process.stderr.write(msg + '\n'); } catch { /* ignore */ }
    }
  };

  let listener: DispatchListenerHandle | undefined;
  try {
    listener = await startLocalDispatchListener();
    log(`[openclaw-mode-b] dispatch listener bound at ${listener.url}`);
  } catch (err) {
    warn(`[openclaw-mode-b] failed to bind dispatch listener (skipping): ${(err as Error).message}`);
    return { registered: false };
  }

  const notifyResult = await notifyDaemonOfPresence({
    daemonHttpBase,
    name,
    loopbackUrl: listener.url,
  });
  if (notifyResult.ok) {
    log(
      `[openclaw-mode-b] daemon notified at ${daemonHttpBase}` +
      (notifyResult.replaced ? ' (replaced CLI shim)' : ''),
    );
  } else {
    warn(
      `[openclaw-mode-b] daemon notify failed (non-fatal): ${notifyResult.error ?? 'unknown'}`,
    );
  }

  // I3: Periodic re-registration heartbeat.
  //
  // Recovery pattern: on daemon restart, OpenClaw rebinds within `heartbeatMs`
  // without manual ops intervention. Daemon's register endpoint is idempotent
  // (it overwrites by name) — re-registration is cheap. Without this, a daemon
  // bounce strands the loopback URL and dispatches stay broken until OpenClaw
  // is restarted too.
  //
  // .unref() so the timer never keeps the OpenClaw process alive on shutdown.
  // Errors are swallowed (best-effort, same posture as the initial notify).
  const heartbeat = setInterval(() => {
    void notifyDaemonOfPresence({
      daemonHttpBase,
      name,
      loopbackUrl: listener!.url,
    }).catch(() => {
      // best-effort: swallow
    });
  }, heartbeatMs);
  if (typeof (heartbeat as unknown as { unref?: () => void }).unref === 'function') {
    (heartbeat as unknown as { unref: () => void }).unref();
  }
  const stopHeartbeat = (): void => clearInterval(heartbeat);

  return { listener, registered: notifyResult.ok, notifyResult, stopHeartbeat };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
