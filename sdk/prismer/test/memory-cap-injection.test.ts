import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import {
  verifyCap,
  registerMemoryAuthoritySnapshot,
  computeMemoryAuthoritySnapshotHash,
  __resetCapKeyForTest,
  type MemoryAuthoritySnapshotBundleV1,
} from '../src/daemon/memory/cap.js';
import { prismerScopeEnvFromMetadata } from '../src/adapters/prismer-env.js';
import { buildMemoryToolImpls } from '../src/adapters/memory-tools.js';

// doc 08 §5 — P0.4 injection chain: prismer-env mints PRISMER_MEMORY_CAP from
// the dispatch metadata; the memory-tool client forwards it as the cap header;
// the daemon enforces workspace scope end-to-end.

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

/**
 * spec16 §8.3 — prismer-env now mints cap v2 ONLY from a valid registered
 * Cloud authority snapshot. Seed one per workspace with a server-derived
 * actor row so the injection chain assertions keep exercising the real
 * production mint path (not a bypass).
 */
function seedAuthoritySnapshot(workspaceId: string, actorId: string): void {
  const now = Date.now();
  const base: Omit<MemoryAuthoritySnapshotBundleV1, 'snapshotHash'> = {
    schemaVersion: 1,
    workspaceId,
    daemonId: 'dev_x',
    replicaMode: 'legacy',
    minRuntimeVersion: '0.0.0',
    requiredRuntimeCapabilities: [
      'memory-authority-snapshot-v1',
      'memory-replica-manifest-v1',
      'memory-replica-content-v1',
    ],
    accessVersion: 1,
    replicaSubjectHash: `seed-${workspaceId}`,
    issuedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 60 * 60 * 1000).toISOString(),
    actors: [
      {
        actorId,
        actorKind: 'agent',
        principalKind: 'workspace',
        principalId: workspaceId,
        authority: 'specialist',
        roleSlugs: [],
        taskIds: [],
        councilIds: [],
        canCurate: false,
        canReplicate: true,
      },
    ],
  };
  const snapshotHash = computeMemoryAuthoritySnapshotHash(base);
  expect(registerMemoryAuthoritySnapshot({ ...base, snapshotHash }, 'dev_x')).toBe(true);
}

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

beforeEach(async () => {
  // Capability propagation is orthogonal to new-page placement.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_MEMORY_CAP_ENFORCE;
  __resetCapKeyForTest();
  const dir = mkdtempSync(join(tmpdir(), 'prismer-cap-inj-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  await server?.stop();
  runtime?.closeAll();
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_MEMORY_CAP_ENFORCE;
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('memory cap injection chain (doc 08 P0.4)', () => {
  it('prismer-env mints PRISMER_MEMORY_CAP v2 from a valid authority snapshot', () => {
    seedAuthoritySnapshot('ws_w', 'im_agent_x');
    const env = prismerScopeEnvFromMetadata({
      prismerAgentImUserId: 'im_agent_x',
      prismerWorkspaceId: 'ws_w',
    });
    expect(env.PRISMER_MEMORY_CAP).toBeTruthy();
    const cap = verifyCap(env.PRISMER_MEMORY_CAP!);
    // §8.3 — v2 caps carry the snapshot-derived claims; the scope spine is
    // unchanged (the injection chain asserts the same sub/ws/scope).
    expect(cap).toMatchObject({ sub: 'im_agent_x', ws: 'ws_w', scope: ['ws:ws_w'], ver: 2 });
  });

  it('NEGATIVE (spec16 §8.3): no valid snapshot → prismer-env injects NO cap (fail closed)', () => {
    // ws_nosnap has no registered snapshot — the production mint path must
    // omit the cap entirely (agent Memory RPC then 401s).
    const env = prismerScopeEnvFromMetadata({
      prismerAgentImUserId: 'im_agent_x',
      prismerWorkspaceId: 'ws_nosnap',
    });
    expect(env.PRISMER_MEMORY_CAP).toBeUndefined();
  });

  it('omits the cap when agentImUserId or workspaceId is absent', () => {
    expect(prismerScopeEnvFromMetadata({ prismerWorkspaceId: 'ws_w' }).PRISMER_MEMORY_CAP).toBeUndefined();
    expect(prismerScopeEnvFromMetadata({ prismerAgentImUserId: 'im_x' }).PRISMER_MEMORY_CAP).toBeUndefined();
  });

  it('memory-tools client reads cap from process.env and the daemon accepts it (same ws)', async () => {
    seedAuthoritySnapshot('ws_w', 'im_agent_x');
    // Simulate the spawned agent env: daemon-injected cap.
    const env = prismerScopeEnvFromMetadata({
      prismerAgentImUserId: 'im_agent_x',
      prismerWorkspaceId: 'ws_w',
    });
    process.env.PRISMER_MEMORY_CAP = env.PRISMER_MEMORY_CAP;
    // Seed a page in ws_w (spec16 §8.1 — the RPC is fail-closed, the seed
    // carries the same env cap).
    await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': env.PRISMER_MEMORY_CAP! },
      body: JSON.stringify({
        workspaceId: 'ws_w',
        path: 'a.md',
        content: 'hello world',
        pageType: 'leaf',
        actorImUserId: 'im_agent_x',
        actorKind: 'agent',
      }),
    });

    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_w', actorImUserId: 'im_agent_x' });
    const loaded = await tools.load({ workspaceId: 'ws_w', path: 'a.md' });
    expect(loaded.content).toBe('hello world');
    const searched = await tools.search({ query: 'hello' });
    expect(searched.results.length).toBeGreaterThan(0);
  });

  it('cross-ws: an agent scoped to ws_a cannot read ws_b via the tool client', async () => {
    seedAuthoritySnapshot('ws_b', 'im_owner_b');
    seedAuthoritySnapshot('ws_a', 'im_agent_x');
    // ws_b has a page — seeded under a valid ws_b cap (fail-closed RPC; the
    // seed must land so the denial below is provably a scope denial, not a
    // missing page).
    const ownerB = prismerScopeEnvFromMetadata({
      prismerAgentImUserId: 'im_owner_b',
      prismerWorkspaceId: 'ws_b',
    });
    await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': ownerB.PRISMER_MEMORY_CAP! },
      body: JSON.stringify({
        workspaceId: 'ws_b',
        path: 'secret.md',
        content: 'top secret',
        pageType: 'leaf',
        actorImUserId: 'im_owner_b',
        actorKind: 'agent',
      }),
    });
    // Agent X is scoped to ws_a (its injected cap), but tries to load ws_b.
    const env = prismerScopeEnvFromMetadata({
      prismerAgentImUserId: 'im_agent_x',
      prismerWorkspaceId: 'ws_a',
    });
    process.env.PRISMER_MEMORY_CAP = env.PRISMER_MEMORY_CAP;

    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_b', actorImUserId: 'im_agent_x' });
    // 401 daemon-side (cap-layer ws mismatch, spec16 §13.4) → the client
    // throws (does NOT leak ws_b content).
    await expect(tools.load({ workspaceId: 'ws_b', path: 'secret.md' })).rejects.toThrow();
    await expect(tools.search({ query: 'secret' })).rejects.toThrow();
  });

  it('probe/memory separation: /healthz 200 (no cap), memory RPC 401 without cap', async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    const mem = await fetch(`${baseUrl}/local/memory/list?workspaceId=ws_a`);
    expect(mem.status).toBe(401);
  });
});
