// G-10 — Remote command dispatch (agent_restart) test
//
// Verifies that when the TransportManager emits a 'command' event with
// type='agent_restart', the daemon runner routes to the appropriate
// adapter's reset() method (NOT supervisor.restart — that was G-10
// legacy, v1.9.27+ uses adapter.reset). Acks go back via
// transportManager.sendControl({type:'command.result', ...}).
//
// This is a unit test that stubs TransportManager (emits events only) and
// spies on adapterRegistry (exposed on globalThis.__prismerAdapterRegistry).
// It avoids spinning up the full HTTP / probe stack — we only care about
// the dispatch contract established in runner.ts line ~200.
//
// Run:  cd sdk/prismer-cloud/runtime && npm test -- --run remote-command-dispatch

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Stubs ────────────────────────────────────────────────────────────────────

class StubTransportManager extends EventEmitter {
  sentControl: unknown[] = [];
  async start(): Promise<void> {
    // no-op — no real probes, no real WS
  }
  async stop(): Promise<void> {
    // no-op
  }
  async forceReprobe(): Promise<void> {
    // no-op
  }
  registerRpcHandler(_method: string, _handler: (params: unknown) => Promise<unknown>): void {
    // no-op
  }
  sendControl(message: unknown): boolean {
    this.sentControl.push(message);
    return true;
  }
}

const stubTransport = new StubTransportManager();

const supervisorMock = {
  restart: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  register: vi.fn(),
  spawn: vi.fn(),
  stop: vi.fn(),
  get: vi.fn(),
  list: vi.fn().mockReturnValue([]),
  attach: vi.fn(),
};

// ─── vi.mock: replace TransportManager + AgentSupervisor before runner imports ─

vi.mock('../../src/multi-path-transport.js', () => ({
  TransportManager: vi.fn().mockImplementation(() => stubTransport),
}));

vi.mock('../../src/agent-supervisor.js', () => ({
  AgentSupervisor: vi.fn().mockImplementation(() => supervisorMock),
}));

// Avoid adapter auto-register scanning the real filesystem.
vi.mock('../../src/adapters/auto-register.js', () => ({
  autoRegisterAdapters: vi.fn().mockResolvedValue({ registered: [], skipped: [] }),
}));

// Skip registering FS RPC handlers (pulls in sandbox-runtime).
vi.mock('../../src/fs-rpc.js', () => ({
  registerFsRpcHandlers: vi.fn(),
}));

// Skip dispatch RPC handler registration (pulls in adapter-registry).
vi.mock('../../src/dispatch-rpc.js', () => ({
  registerDispatchRpcHandlers: vi.fn(),
}));

// Skip artifact uploader (needs cloud).
vi.mock('../../src/artifacts-uploader.js', () => ({
  ArtifactUploader: vi.fn().mockImplementation(() => ({})),
}));

// Skip heartbeat loop.
vi.mock('../../src/agents/heartbeat-loop.js', () => ({
  startHeartbeatLoop: vi.fn().mockReturnValue({ stop: vi.fn() }),
}));

// Mock evolution gateway (has its own HTTP concerns).
vi.mock('../../src/evolution-gateway.js', () => ({
  EvolutionGatewayHttpHandler: vi.fn().mockImplementation(() => ({
    getRoutes: () => new Map<string, any>(),
  })),
}));

// G-22: stub the published-agents registry so we control the cloudAgentId → localAgentId mapping.
const publishedRegistryMock = vi.fn<[], Array<{
  name: string;
  cloudAgentId: string;
  localAgentId?: string;
  adapter?: string;
  publishedAt: string;
}>>(() => []);

vi.mock('../../src/agents/published-registry.js', () => ({
  loadPublishedRegistry: (...args: unknown[]) => publishedRegistryMock(...(args as [])),
}));

// ─── Import under test (AFTER vi.mock) ────────────────────────────────────────

import { startDaemonRunner } from '../../src/daemon/runner.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'g10-dispatch-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Minimal AdapterImpl helper for tests — returns whatever reset is injected.
function makeFakeAdapter(name: string, resetImpl?: (agentName?: string) => Promise<any>) {
  return {
    name,
    tiersSupported: [1, 2, 3],
    capabilityTags: ['code'],
    dispatch: vi.fn().mockResolvedValue({ ok: true, output: 'stub' }),
    ...(resetImpl ? { reset: vi.fn().mockImplementation(resetImpl) } : {}),
  };
}

function getAdapterRegistry(): { register(a: any): void; get(n: string): any; unregister(n: string): boolean } {
  const reg = (globalThis as any).__prismerAdapterRegistry;
  if (!reg) throw new Error('adapter registry not exposed on globalThis — daemon not started?');
  return reg;
}

describe('Remote command dispatch (G-10)', () => {
  const tmpDirs: string[] = [];
  const handles: Array<{ stop(): Promise<void> }> = [];
  const registeredAdapterNames: string[] = [];

  beforeEach(() => {
    supervisorMock.restart.mockClear();
    stubTransport.removeAllListeners();
    stubTransport.sentControl.length = 0;
    publishedRegistryMock.mockReset();
    publishedRegistryMock.mockReturnValue([]);
  });

  afterEach(async () => {
    // Clean up any adapters registered on globalThis so tests don't bleed.
    try {
      const reg = (globalThis as any).__prismerAdapterRegistry;
      if (reg) {
        for (const n of registeredAdapterNames) reg.unregister(n);
      }
    } catch {
      // ignore
    }
    registeredAdapterNames.length = 0;
    await Promise.all(handles.map((h) => h.stop().catch(() => undefined)));
    handles.length = 0;
    while (tmpDirs.length > 0) {
      cleanupDir(tmpDirs.pop()!);
    }
  });

  it("emits type='agent_restart' → resolves cloudAgentId, calls adapter.reset(entry.name), acks ok:true (G-23)", async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);

    // G-22: registry maps cloudAgentId → entry (name + adapter).
    publishedRegistryMock.mockReturnValue([
      {
        name: 'claude-code',
        cloudAgentId: 'cmo8n730u000f1d01xmgfwjax',
        localAgentId: 'claude-code@PrismerdeMac-Studio.local',
        adapter: 'claude-code',
        publishedAt: new Date().toISOString(),
      },
    ]);

    const handle = await startDaemonRunner({
      host: '127.0.0.1',
      port: 0,
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
      apiKey: 'test-api-key',
      daemonId: 'd-test',
      userId: 'u-test',
      cloudApiBase: 'https://cloud.prismer.dev',
    });
    handles.push(handle);

    // Register a fake adapter with a reset() spy.
    const adapter = makeFakeAdapter('claude-code', async (_agentName) => ({
      ok: true,
      state: 'stateless_noop',
    }));
    getAdapterRegistry().register(adapter);
    registeredAdapterNames.push('claude-code');

    stubTransport.emit('command', {
      id: 'cmd-1',
      type: 'agent_restart',
      payload: { agentId: 'cmo8n730u000f1d01xmgfwjax' },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));

    // G-23: adapter.reset must be called with entry.name (not the cloud id).
    expect(adapter.reset).toHaveBeenCalledTimes(1);
    expect(adapter.reset).toHaveBeenCalledWith('claude-code');
    // Legacy supervisor.restart must NOT be called on the PARA path.
    expect(supervisorMock.restart).not.toHaveBeenCalled();

    // Ack should have been pushed back via sendControl.
    expect(stubTransport.sentControl.length).toBe(1);
    const ack = stubTransport.sentControl[0] as { type: string; commandId: string; result: any };
    expect(ack.type).toBe('command.result');
    expect(ack.commandId).toBe('cmd-1');
    expect(ack.result.ok).toBe(true);
    expect(ack.result.state).toBe('stateless_noop');
    // agentId in the ack echoes the cloud id (cloud correlates on it).
    expect(ack.result.agentId).toBe('cmo8n730u000f1d01xmgfwjax');
    expect(ack.result.adapter).toBe('claude-code');
  }, 10_000);

  it("G-23: adapter without reset() → acks ok:true state='no_reset_support'", async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);

    publishedRegistryMock.mockReturnValue([
      {
        name: 'legacy-agent',
        cloudAgentId: 'cmo-legacy',
        localAgentId: 'legacy-agent@host',
        adapter: 'legacy-agent',
        publishedAt: new Date().toISOString(),
      },
    ]);

    const handle = await startDaemonRunner({
      host: '127.0.0.1',
      port: 0,
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
      apiKey: 'test-api-key',
      daemonId: 'd-test',
      userId: 'u-test',
      cloudApiBase: 'https://cloud.prismer.dev',
    });
    handles.push(handle);

    // Adapter has NO reset — simulates a pre-v1.9.27 module.
    const adapter = makeFakeAdapter('legacy-agent'); // no resetImpl → no reset method
    getAdapterRegistry().register(adapter);
    registeredAdapterNames.push('legacy-agent');

    stubTransport.emit('command', {
      id: 'cmd-legacy',
      type: 'agent_restart',
      payload: { agentId: 'cmo-legacy' },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(supervisorMock.restart).not.toHaveBeenCalled();
    expect(stubTransport.sentControl.length).toBe(1);
    const ack = stubTransport.sentControl[0] as { result: any };
    expect(ack.result.ok).toBe(true);
    expect(ack.result.state).toBe('no_reset_support');
    expect(ack.result.agentId).toBe('cmo-legacy');
    expect(ack.result.adapter).toBe('legacy-agent');
  }, 10_000);

  it("G-23: adapter not registered in the registry → acks ok:false with 'adapter not registered'", async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);

    publishedRegistryMock.mockReturnValue([
      {
        name: 'openclaw',
        cloudAgentId: 'cmo-openclaw',
        adapter: 'openclaw',
        publishedAt: new Date().toISOString(),
      },
    ]);

    const handle = await startDaemonRunner({
      host: '127.0.0.1',
      port: 0,
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
      apiKey: 'test-api-key',
      daemonId: 'd-test',
      userId: 'u-test',
      cloudApiBase: 'https://cloud.prismer.dev',
    });
    handles.push(handle);

    // Deliberately DO NOT register an adapter named 'openclaw' —
    // simulates a binding that refers to an adapter that hasn't come online yet.

    stubTransport.emit('command', {
      id: 'cmd-unreg',
      type: 'agent_restart',
      payload: { agentId: 'cmo-openclaw' },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(stubTransport.sentControl.length).toBe(1);
    const ack = stubTransport.sentControl[0] as { result: any };
    expect(ack.result.ok).toBe(false);
    expect(String(ack.result.error)).toMatch(/adapter not registered/i);
    expect(ack.result.adapter).toBe('openclaw');
  }, 10_000);

  it('G-22: cloudAgentId not in published registry → acks ok:false with unknown-agent error', async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);

    // Empty registry — the incoming agentId is not published on this daemon.
    publishedRegistryMock.mockReturnValue([]);

    const handle = await startDaemonRunner({
      host: '127.0.0.1',
      port: 0,
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
      apiKey: 'test-api-key',
      daemonId: 'd-test',
      userId: 'u-test',
      cloudApiBase: 'https://cloud.prismer.dev',
    });
    handles.push(handle);

    stubTransport.emit('command', {
      id: 'cmd-unknown',
      type: 'agent_restart',
      payload: { agentId: 'cmo-not-on-this-daemon' },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(supervisorMock.restart).not.toHaveBeenCalled();
    expect(stubTransport.sentControl.length).toBe(1);
    const ack = stubTransport.sentControl[0] as { result: any };
    expect(ack.result.ok).toBe(false);
    expect(String(ack.result.error)).toMatch(/unknown agentId/i);
    expect(String(ack.result.error)).toMatch(/published-agents\.toml/);
  }, 10_000);

  it("emits type='agent_restart' without agentId → acks ok:false, does NOT restart", async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);

    const handle = await startDaemonRunner({
      host: '127.0.0.1',
      port: 0,
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
      apiKey: 'test-api-key',
      daemonId: 'd-test',
      userId: 'u-test',
      cloudApiBase: 'https://cloud.prismer.dev',
    });
    handles.push(handle);

    stubTransport.emit('command', {
      id: 'cmd-2',
      type: 'agent_restart',
      payload: {},
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(supervisorMock.restart).not.toHaveBeenCalled();
    expect(stubTransport.sentControl.length).toBe(1);
    const ack = stubTransport.sentControl[0] as { result: any };
    expect(ack.result.ok).toBe(false);
    expect(String(ack.result.error)).toMatch(/agentId required/i);
  }, 10_000);

  it('emits unknown command type → acks ok:false, does NOT restart', async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);

    const handle = await startDaemonRunner({
      host: '127.0.0.1',
      port: 0,
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
      apiKey: 'test-api-key',
      daemonId: 'd-test',
      userId: 'u-test',
      cloudApiBase: 'https://cloud.prismer.dev',
    });
    handles.push(handle);

    stubTransport.emit('command', {
      id: 'cmd-3',
      type: 'agent_start', // v1.9.x iOS scope does NOT include start
      payload: { agentId: 'a-1' },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(supervisorMock.restart).not.toHaveBeenCalled();
    expect(stubTransport.sentControl.length).toBe(1);
    const ack = stubTransport.sentControl[0] as { result: any };
    expect(ack.result.ok).toBe(false);
    expect(String(ack.result.error)).toMatch(/unsupported command type/i);
  }, 10_000);
});
