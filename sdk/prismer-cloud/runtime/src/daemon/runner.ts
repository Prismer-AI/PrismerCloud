// T14 — Composed daemon runner: DaemonProcess + EventBus + AgentSupervisor + DaemonHttpServer

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DaemonProcess } from '../daemon-process.js';
import { EventBus } from '../event-bus.js';
import { TraceWriterManager } from '../trace-writer.js';
import { AgentSupervisor } from '../agent-supervisor.js';
import { DaemonHttpServer } from '../daemon-http.js';
import { TransportManager } from '../multi-path-transport.js';
import { MemoryGatewayAPI } from '../memory-gateway.js';
import { EvolutionGatewayHttpHandler } from '../evolution-gateway.js';
import { TaskRouter } from '../task-router.js';
import { generateKeyPair, serializeKeyPair, type KeyPair } from '../e2ee-crypto.js';
import type { AuthenticatedIdentity } from '../daemon-http.js';
import { deriveWsFromHttp } from '../cloud-url.js';
import { EventsTailer } from './events-tailer.js';
import { loadPublishedRegistry } from '../agents/published-registry.js';
import type { FsContext } from '@prismer/sandbox-runtime';

// ============================================================
// Types
// ============================================================

export interface DaemonRunnerOptions {
  host?: string;
  port?: number;               // default 3210
  pidFile?: string;
  dataDir?: string;
  installSignalHandlers?: boolean;
  authBearer?: string;         // optional single-token bearer auth; undefined = localhost trust
  apiKey?: string;             // Prismer API key for relay connection
  daemonId?: string;           // Daemon ID for relay registration
  userId?: string;             // User ID for relay registration
  enableTransport?: boolean;    // enable multi-path transport (default: true)
  forceProbe?: boolean;        // force re-probe on startup
  workspace?: string;          // default FS sandbox workspace
  /**
   * v1.9.0 B.7.a — cloud base URL (https://prismer.cloud for prod,
   * https://cloud.prismer.dev for test). Forwarded to EvolutionGateway so
   * daemon→cloud calls hit the same env the API key was issued against.
   */
  cloudApiBase?: string;
}

export interface DaemonRunnerHandle {
  stop(): Promise<void>;
  readonly url: string;
  readonly pid: number;
  readonly dataDir: string;
}

// ============================================================
// startDaemonRunner
// ============================================================

export async function startDaemonRunner(opts?: DaemonRunnerOptions): Promise<DaemonRunnerHandle> {
  const home = os.homedir();
  const pidFile = opts?.pidFile ?? path.join(home, '.prismer', 'daemon.pid');
  const dataDir = opts?.dataDir ?? path.join(home, '.prismer');
  const port = opts?.port ?? 3210;
  const host = opts?.host ?? '127.0.0.1';
  const lanHost = resolveLanHostForDaemon(host);
  const enableTransport = opts?.enableTransport ?? true;
  const forceProbe = opts?.forceProbe ?? false;

  // 1. Start DaemonProcess (writes PID, installs signal handlers per opt)
  const daemonProcess = new DaemonProcess({
    pidFile,
    dataDir,
    installSignalHandlers: opts?.installSignalHandlers ?? true,
  });
  await daemonProcess.start();

  // 2. EventBus
  const eventBus = new EventBus();

  // 2b. PARA L8 session trace writer — captures pre-compaction event stream
  //     to <dataDir>/trace/<sessionId>.jsonl.zst (append-only + zstd frames).
  //     See docs/version190/03-para-spec.md §4.2 L8.
  const traceManager = new TraceWriterManager({ traceDir: path.join(dataDir, 'trace') });
  eventBus.subscribe('*', traceManager.handle);

  // 3. AgentSupervisor
  const supervisor = new AgentSupervisor({ eventBus });

  // 3b. AdapterRegistry + DispatchMux (Sprint A3, D4 dispatch)
  // The registry is the single source-of-truth for which adapters this
  // daemon can dispatch to. Adapter modules (claude-code-plugin,
  // openclaw-channel, prismer-adapter-hermes) register themselves on
  // load via adapterRegistry.register(). Cloud task → daemon command →
  // dispatchMux.dispatch() → adapter.dispatch() → result back to cloud.
  const { AdapterRegistry } = await import('../adapter-registry.js');
  const { DispatchMux } = await import('../dispatch-mux.js');
  const adapterRegistry = new AdapterRegistry();
  const dispatchMux = new DispatchMux(adapterRegistry);
  // Expose globally so adapter plug-ins loaded out-of-band can register.
  (globalThis as any).__prismerAdapterRegistry = adapterRegistry;
  (globalThis as any).__prismerDispatchMux = dispatchMux;

  // Auto-detect installed agents and register CLI-spawn adapters for
  // each. Adapters that publish their own AdapterImpl module register
  // themselves first and the auto-registrar yields to them.
  try {
    const { autoRegisterAdapters } = await import('../adapters/auto-register.js');
    const auto = await autoRegisterAdapters(adapterRegistry);
    if (auto.registered.length > 0) {
      console.log(
        '[DaemonRunner] Auto-registered adapters:',
        auto.registered.map((r) => `${r.name}(${r.binary})`).join(', '),
      );
    }
    if (auto.skipped.length > 0) {
      const notInstalled = auto.skipped.filter((s) => s.reason === 'not_installed').map((s) => s.name);
      if (notInstalled.length > 0) {
        console.log('[DaemonRunner] Adapters not installed (skipped):', notInstalled.join(', '));
      }
      const errors = auto.skipped.filter((s) => s.reason !== 'not_installed' && s.reason !== 'already_registered');
      for (const e of errors) {
        console.warn(`[DaemonRunner] Adapter skipped (${e.name}): ${e.reason}`);
      }
    }
  } catch (err) {
    console.warn('[DaemonRunner] Adapter auto-register failed:', err);
  }

  // 4. Generate or load the daemon E2EE keypair. Pairing offers need this even
  //    when cloud transport is not configured yet.
  const keypairFile = path.join(dataDir, 'e2ee-keypair.json');
  let localKeyPair: KeyPair | undefined;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(keypairFile)) {
      const keypairData = JSON.parse(fs.readFileSync(keypairFile, 'utf-8'));
      localKeyPair = {
        publicKey: Buffer.from(keypairData.publicKey, 'base64'),
        privateKey: Buffer.from(keypairData.privateKey, 'base64'),
      };
      console.log('[DaemonRunner] Loaded existing E2EE keypair');
    } else {
      localKeyPair = generateKeyPair();
      const serialized = serializeKeyPair(localKeyPair);
      fs.writeFileSync(keypairFile, JSON.stringify(serialized, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      console.log('[DaemonRunner] Generated new E2EE keypair');
    }
  } catch (err) {
    console.warn('[DaemonRunner] Failed to load/generate E2EE keypair:', err);
  }

  // 5. Multi-path Transport Manager (optional)
  let transportManager: TransportManager | undefined;
  if (enableTransport && opts?.apiKey && opts?.daemonId && opts?.userId && opts?.cloudApiBase) {
    console.log('[DaemonRunner] Initializing multi-path transport');

    if (localKeyPair) {
      transportManager = new TransportManager({
        apiKey: opts.apiKey!,
        daemonId: opts.daemonId!,
        userId: opts.userId!,
        cloudApiBase: opts.cloudApiBase!,
        localKeyPair,
        dataDir,
        lanPort: port,
        lanHost,
      });

      // Bug B: publish the manager on globalThis BEFORE start() resolves so the
      // HTTP /transport/status handler can see it during the initial probe pass.
      // Previously this ran after `await transportManager.start()` — which takes
      // 10–30s of WSS handshakes on cold-boot — causing the handler to fall back
      // to the "disabled" canned response while the prober was actively firing.
      (globalThis as any).__transportManager = transportManager;

      // Set up transport event handlers
      transportManager.on('connected', (info) => {
        console.log('[DaemonRunner] Transport connected:', info);
      });

      transportManager.on('disconnected', (info) => {
        console.log('[DaemonRunner] Transport disconnected:', info);
      });

      transportManager.on('switched', (info) => {
        console.log('[DaemonRunner] Transport switched:', info);
      });

      transportManager.on('error', (err) => {
        console.error('[DaemonRunner] Transport error:', err);
      });

      transportManager.on('command', async (command) => {
        console.log('[DaemonRunner] Received remote command:', command);
        eventBus.publish('remote-command', command);

        // v1.9.x remote command dispatch. Currently iOS scope: 'agent_restart' only (Q-005 (C)).
        // Semantic: route to the adapter's reset() (v1.9.27+) — NOT supervisor.restart.
        // PARA adapters are not long-running processes; restart means "adapter clears per-agent state".
        // See docs/mobile190/ARCHITECTURE.md §[AgentSupervisor vs AdapterRegistry].
        let result: { ok: boolean; [key: string]: unknown };
        try {
          const agentId = (command.payload && (command.payload as any).agentId) as string | undefined;
          switch (command.type) {
            case 'agent_restart': {
              if (!agentId) {
                result = { ok: false, error: 'agentId required in envelope for agent_restart' };
                break;
              }
              // G-22: cloud sends cloudAgentId; resolve to the published-agents
              // entry for this daemon so we know which adapter owns it and what
              // short name to pass to reset().
              let entry: { name: string; adapter?: string; localAgentId?: string } | undefined;
              try {
                entry = loadPublishedRegistry().find((a) => a.cloudAgentId === agentId);
              } catch (err) {
                // Registry read failure: log + fall through to the missing-entry branch.
                console.warn('[DaemonRunner] published-agents registry read failed:', (err as Error).message);
              }
              if (!entry) {
                result = {
                  ok: false,
                  error: `unknown agentId for this daemon: ${agentId} (not in published-agents.toml)`,
                };
                break;
              }
              // Adapter name: prefer entry.adapter, fall back to entry.name
              // (older publish writes didn't set adapter explicitly).
              const adapterName = entry.adapter ?? entry.name;
              const adapter = adapterRegistry.get(adapterName);
              if (!adapter) {
                result = {
                  ok: false,
                  error: `adapter not registered: ${adapterName}`,
                  agentId,
                  adapter: adapterName,
                };
                break;
              }
              if (typeof adapter.reset !== 'function') {
                // Adapter predates the reset() contract. Ack cleanly so cloud
                // doesn't treat it as a hard failure — iOS shows "restarted"
                // even though no state actually changed.
                result = {
                  ok: true,
                  state: 'no_reset_support',
                  agentId,
                  adapter: adapterName,
                };
                break;
              }
              const resetResult = await adapter.reset(entry.name);
              result = {
                ...resetResult,
                ok: resetResult.ok,
                agentId,
                adapter: adapterName,
              };
              break;
            }
            // 'agent_start' / 'agent_stop' intentionally unimplemented in v1.9.x (Q-005 (C) @prismer 2026-04-21)
            default:
              console.warn('[DaemonRunner] Unhandled remote command type:', command.type);
              result = { ok: false, error: `unsupported command type: ${command.type}` };
          }
        } catch (err) {
          console.error('[DaemonRunner] Remote command dispatch failed:', err);
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        // Ack back to cloud — best-effort. Failure to send ack should not crash the handler.
        try {
          const tm = transportManager as unknown as {
            sendControl?: (msg: unknown) => boolean;
          };
          tm.sendControl?.({ type: 'command.result', commandId: command.id, result });
        } catch (ackErr) {
          console.warn('[DaemonRunner] Failed to ack remote command:', ackErr);
        }
      });

      // Sprint C0 — bridge cloud rpc.request 'task.dispatch' to DispatchMux
      // so cloud's TaskRouter can run a task step on the local adapter.
      // v1.9.x Task 2 — wire ArtifactUploader so adapter-produced artifacts
      // get uploaded to cloud and stamped with cloudUploadId on the result.
      try {
        const { registerDispatchRpcHandlers } = await import('../dispatch-rpc.js');
        const { ArtifactUploader } = await import('../artifacts-uploader.js');
        const artifactUploader =
          opts?.apiKey && opts?.cloudApiBase
            ? new ArtifactUploader({ apiKey: opts.apiKey, cloudApiBase: opts.cloudApiBase })
            : undefined;
        registerDispatchRpcHandlers(transportManager as any, {
          mux: dispatchMux,
          registry: adapterRegistry,
          ...(artifactUploader ? { artifactUploader } : {}),
        });
        console.log(
          `[DaemonRunner] Dispatch RPC handlers registered (task.dispatch / list / resolve)${
            artifactUploader ? ' + artifact uploader' : ''
          }`,
        );
      } catch (err) {
        console.warn('[DaemonRunner] Failed to register dispatch RPC handlers:', err);
      }

      // Bug A: start the transport manager in the background rather than
      // awaiting it. `start()` synchronously calls `probeAndSelect()`, which
      // runs 5× WSS handshakes against the relay — on a cold Docker container
      // with an unreachable cloud this blocks ~15–30s. Awaiting it delayed
      // `httpServer.start()` + the `daemon.port` sidecar write by the same
      // margin, during which the CLI reported "Daemon started" but no
      // port file existed yet and the HTTP server wasn't accepting requests.
      // Fire-and-forget is safe: TransportManager handles its own errors
      // (logs 'relay: FAILED', schedules retries) and state is published via
      // __transportManager + getStatus() so the HTTP handler can reflect the
      // probing/unreachable state as it evolves.
      void transportManager.start().then(async () => {
        if (forceProbe) {
          console.log('[DaemonRunner] Force re-probing transport paths');
          await transportManager!.forceReprobe();
        }
      }).catch((err) => {
        console.error('[DaemonRunner] Transport manager start failed:', err);
      });

      // Register transport shutdown handler
      daemonProcess.onShutdown({
        name: 'transport-manager',
        handler: async () => {
          if (transportManager) {
            await transportManager.stop();
          }
        },
      });
    }
  } else if (enableTransport) {
    console.log('[DaemonRunner] Multi-path transport disabled (missing apiKey/daemonId/userId/cloudApiBase)');
  }

  // 5b. Heartbeat loop for published agents (Sprint A2.3, D3 liveness).
  // Only runs when this daemon has cloud identity — otherwise there is
  // no cloud to heartbeat to. The loop loads the published-agents
  // registry on every tick so `prismer agent publish/unpublish` reflects
  // immediately without restarting the daemon.
  if (opts?.apiKey && opts?.daemonId && opts?.cloudApiBase) {
    const { startHeartbeatLoop } = await import('../agents/heartbeat-loop.js');
    const heartbeatLoop = startHeartbeatLoop({
      apiKey: opts.apiKey,
      daemonId: opts.daemonId,
      cloudApiBase: opts.cloudApiBase,
    });
    daemonProcess.onShutdown({
      name: 'heartbeat-loop',
      handler: async () => heartbeatLoop.stop(),
    });
    console.log('[DaemonRunner] Heartbeat loop started (30s interval)');
  } else {
    console.log('[DaemonRunner] Heartbeat loop disabled (missing apiKey/daemonId/cloudApiBase)');
  }

  // 4. Authenticate: if authBearer is set, only accept that exact token.
  //    /health is always public (handled inside DaemonHttpServer before auth check).
  //
  // v1.9.0 B.7.b — derive a stable agentId from the user-supplied identity
  // rather than hard-coding `__http_client__`. The cloud evolution service uses
  // this value as the `X-Prismer-AgentId` header, so collapsing every caller
  // into one literal led to unusable rollups. Fingerprint keeps the raw API
  // key off the wire while still being deterministic across daemon restarts.
  const authBearerFingerprint =
    opts?.authBearer !== undefined
      ? crypto.createHash('sha256').update(opts.authBearer).digest('hex').slice(0, 16)
      : undefined;
  const authenticate = opts?.authBearer !== undefined
    ? (token: string | undefined): AuthenticatedIdentity | null => {
        if (token !== opts.authBearer) return null;
        const derivedAgentId = opts.userId ?? `daemon:${authBearerFingerprint ?? 'anon'}`;
        return { agentId: derivedAgentId };
      }
    : undefined;

  // 5. Default FS context. More specific agent/workspace policy registries can
  //    layer on top later; the product path must still expose a working sandbox.
  const defaultWorkspace = path.resolve(opts?.workspace ?? process.cwd());
  const fsContextProvider = (req: { agentId: string; workspace?: string }): FsContext | undefined => {
    const requestedWorkspace = path.resolve(req.workspace ?? defaultWorkspace);
    const workspace = requestedWorkspace === defaultWorkspace || requestedWorkspace.startsWith(defaultWorkspace + path.sep)
      ? requestedWorkspace
      : defaultWorkspace;
    return {
      agentId: req.agentId,
      workspace,
      mode: 'default',
      rules: [],
    };
  };

  // 5b. Register FS RPC handlers on the transport manager so cloud relay
  //     (mobile → cloud → daemon) can reach the sandbox. Same FS primitives as
  //     the local HTTP path, just different transport and audit callPath.
  if (transportManager) {
    const { registerFsRpcHandlers } = await import('../http/fs-rpc.js');
    registerFsRpcHandlers(transportManager, { fsContextProvider });
  }

  // 6. DaemonHttpServer
  const httpServer = new DaemonHttpServer({
    host,
    port,
    eventBus,
    supervisor,
    authenticate,
    fsContextProvider,
  });

  const memoryGateway = new MemoryGatewayAPI({ enabled: false }, {
    filePath: path.join(dataDir, 'memory.json'),
  });
  memoryGateway.registerRoutes(httpServer);

  const taskRouter = new TaskRouter({
    eventBus,
    supervisor,
    apiToken: opts?.apiKey,
  });
  taskRouter.registerRoutes(httpServer);

  const evolutionGateway = new EvolutionGatewayHttpHandler({
    eventBus,
    supervisor,
    authenticate,
    // v1.9.0 B.7.a — forward the daemon's API key as the outbound Bearer so
    // cloud /api/im/evolution/* sees an authenticated caller instead of 401.
    cloudApiKey: opts?.apiKey,
    cloudApiBase: opts?.cloudApiBase,
  });
  for (const [key, handler] of evolutionGateway.getRoutes()) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const method = key.slice(0, sep) as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const routePath = key.slice(sep + 1);
    httpServer.registerRoute(method, routePath, handler);
  }

  // v1.9.0 Track T3: PARA events tailer — polls ~/.prismer/para/events.jsonl
  // and uploads new lines to cloud POST /api/im/para/events. Only starts when
  // we have an apiKey + cloudApiBase (same gate as relay).
  let eventsTailer: EventsTailer | undefined;
  if (opts?.apiKey && opts?.cloudApiBase) {
    eventsTailer = new EventsTailer({
      apiKey: opts.apiKey,
      cloudApiBase: opts.cloudApiBase,
    });
    eventsTailer.start();
    daemonProcess.onShutdown({
      name: 'events-tailer',
      handler: async () => eventsTailer?.stop(),
    });
  } else {
    console.log('[DaemonRunner] PARA events tailer disabled (missing apiKey/cloudApiBase)');
  }

  const pairingOffers = new Map<string, { expiresAt: number; deviceName?: string }>();
  httpServer.registerRoute('POST', '/pair/offer', (_req, res, ctx) => {
    let ttlSec = 300;
    try {
      if (ctx.body.length > 0) {
        const parsed = JSON.parse(ctx.body.toString('utf8')) as { ttlSec?: number; deviceName?: string };
        if (typeof parsed.ttlSec === 'number' && parsed.ttlSec > 0) {
          ttlSec = Math.min(parsed.ttlSec, 15 * 60);
        }
      }
    } catch {
      // Keep the default TTL for malformed optional body fields.
    }
    const offer = cryptoRandomToken();
    const expiresAt = Date.now() + ttlSec * 1000;
    pairingOffers.set(offer, { expiresAt });
    const daemonPubKey = localKeyPair
      ? serializeKeyPair(localKeyPair).publicKey
      : undefined;
    const payload = JSON.stringify({
      offer,
      uri: `prismer://pair?offer=${encodeURIComponent(offer)}`,
      expiresAt,
      daemonId: opts?.daemonId,
      daemonPubKey,
      relayUrl: opts?.apiKey ? deriveWsFromHttp(opts?.cloudApiBase) : undefined,
      lanHost,
      lanPort: boundPortForOffer(httpServer),
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });

  // Sprint A3 — Adapter Registry HTTP surface (path /api/v1/adapters
   // is mounted by daemon-http.ts via the /api/v1 prefix).
  httpServer.registerRoute('GET', '/adapters', (_req, res) => {
    const list = adapterRegistry.list();
    const payload = JSON.stringify({ ok: true, adapters: list });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });

  // v1.9.x Task 3 — Mode B AdapterImpl registration.
  // Plug-ins running in a sibling agent process (e.g. OpenClaw with the
  // @prismer/openclaw-channel plug-in) POST { name, loopbackUrl } here.
  // We validate the loopback URL is 127.0.0.1:<port>, build a Mode B
  // AdapterImpl whose dispatch() bridges to that loopback, and call
  // adapterRegistry.register(...) which REPLACES any existing CLI-shim
  // entry. Localhost-only — no auth (loopback validation is the boundary).
  httpServer.registerRoute('POST', '/adapters/register-mode-b', async (_req, res, ctx) => {
    let body: any;
    try {
      body = ctx.body.length > 0 ? JSON.parse(ctx.body.toString('utf8')) : {};
    } catch {
      const err = JSON.stringify({ ok: false, error: 'invalid_json' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    if (typeof body !== 'object' || body === null) {
      const err = JSON.stringify({ ok: false, error: 'body must be an object' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    if (typeof body.name !== 'string' || body.name.length === 0) {
      const err = JSON.stringify({ ok: false, error: 'name (string) required' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    if (typeof body.loopbackUrl !== 'string' || body.loopbackUrl.length === 0) {
      const err = JSON.stringify({ ok: false, error: 'loopbackUrl (string) required' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    // Adapter must exist in the catalog so iOS / cloud know what it is.
    const { getAgent } = await import('../agents/registry.js');
    const catalogEntry = getAgent(body.name);
    if (!catalogEntry) {
      const err = JSON.stringify({
        ok: false,
        error: `unknown_adapter:${body.name} (not in catalog)`,
      });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    let modeBAdapter;
    try {
      const { buildModeBAdapter } = await import('../adapters/mode-b.js');
      modeBAdapter = buildModeBAdapter({
        name: body.name,
        loopbackUrl: body.loopbackUrl,
        tiersSupported: catalogEntry.tiersSupported,
        capabilityTags: catalogEntry.capabilityTags,
      });
    } catch (err) {
      const payload = JSON.stringify({
        ok: false,
        error: `invalid_loopback:${(err as Error).message}`,
      });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    const replaced = adapterRegistry.has(body.name);
    try {
      adapterRegistry.register(modeBAdapter);
    } catch (err) {
      const payload = JSON.stringify({
        ok: false,
        error: `register_failed:${(err as Error).message}`,
      });
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    console.log(
      `[DaemonRunner] Mode B adapter registered: ${body.name} → ${body.loopbackUrl}` +
      (replaced ? ' (replaced existing CLI shim)' : ''),
    );
    const ok = JSON.stringify({ ok: true, replaced });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ok) });
    res.end(ok);
  });

  httpServer.registerRoute('POST', '/adapters/dispatch', async (_req, res, ctx) => {
    let body: any;
    try {
      body = ctx.body.length > 0 ? JSON.parse(ctx.body.toString('utf8')) : {};
    } catch {
      const err = JSON.stringify({ ok: false, error: 'invalid_json' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    if (typeof body.taskId !== 'string' || typeof body.capability !== 'string' || typeof body.prompt !== 'string') {
      const err = JSON.stringify({ ok: false, error: 'taskId, capability, prompt required' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) });
      res.end(err);
      return;
    }
    const result = await dispatchMux.dispatch({
      taskId: body.taskId,
      stepIdx: typeof body.stepIdx === 'number' ? body.stepIdx : undefined,
      capability: body.capability,
      prompt: body.prompt,
      metadata: body.metadata,
      preferAdapter: typeof body.preferAdapter === 'string' ? body.preferAdapter : undefined,
      deadlineAt: typeof body.deadlineAt === 'number' ? body.deadlineAt : undefined,
    });
    const status = result.ok ? 200 : 400;
    const payload = JSON.stringify({ ok: result.ok, result });
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });

  httpServer.registerRoute('GET', '/pair/status', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const offer = url.searchParams.get('offer') ?? '';
    const record = pairingOffers.get(offer);
    const paired = false;
    if (record && record.expiresAt <= Date.now()) {
      pairingOffers.delete(offer);
    }
    const payload = JSON.stringify({
      paired,
      expiresAt: record?.expiresAt,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });

  const portFile = path.join(dataDir, 'daemon.port');

  let serverUrl: string;
  let boundPort: number;
  try {
    const bound = await httpServer.start();
    serverUrl = `http://${bound.host}:${bound.port}`;
    boundPort = bound.port;
  } catch (err) {
    // If HTTP bind fails, shut down the daemon process cleanly before rethrowing.
    await daemonProcess.shutdown('manual');
    throw err;
  }

  // Write bound port to sidecar file (atomic tmp+rename, mode 0600).
  // Trailing newline matches README promise + is friendlier to `cat`.
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = portFile + '.tmp';
    fs.writeFileSync(tmp, String(boundPort) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, portFile);
  } catch (err) {
    // Best-effort — don't crash the daemon if sidecar write fails. Log so
    // Docker/CI operators can diagnose FS permission issues on the data dir.
    console.warn(`[DaemonRunner] Failed to write ${portFile}:`, err);
  }

  // 7. Register LIFO shutdown handlers on DaemonProcess:
  //    Order matters: supervisor shuts down first, then HTTP server.
  daemonProcess.onShutdown({
    name: 'http-server',
    handler: async () => {
      memoryGateway.shutdown();
      await httpServer.stop(5000);
    },
  });

  daemonProcess.onShutdown({
    name: 'agent-supervisor',
    handler: async () => {
      await supervisor.shutdown();
    },
  });

  daemonProcess.onShutdown({
    name: 'trace-writer-manager',
    handler: async () => {
      traceManager.shutdown();
    },
  });

  // Remove port sidecar on clean shutdown
  daemonProcess.onShutdown({
    name: 'port-sidecar-cleanup',
    handler: async () => {
      try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }
    },
  });

  // 8. Return handle
  const handle: DaemonRunnerHandle = {
    get url() { return serverUrl; },
    get pid() { return process.pid; },
    get dataDir() { return dataDir; },
    async stop() {
      await daemonProcess.shutdown('manual');
    },
  };

  return handle;
}

function cryptoRandomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function boundPortForOffer(httpServer: DaemonHttpServer): number | undefined {
  const url = httpServer.url;
  if (!url) return undefined;
  const port = Number(new URL(url).port);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

function resolveLanHostForDaemon(host: string): string | undefined {
  if (host === '0.0.0.0' || host === '::') {
    return findLanIPv4();
  }
  if (host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('169.254.')) {
    return undefined;
  }
  return host;
}

function findLanIPv4(): string | undefined {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('127.') || entry.address.startsWith('169.254.')) continue;
      return entry.address;
    }
  }
  return undefined;
}
