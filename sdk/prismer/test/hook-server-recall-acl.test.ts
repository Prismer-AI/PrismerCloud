// product204/34 Track 0.1b — hook-server recall/compaction ACL.
//
// `slot.search.hybrid` returns EVERY matching page in the workspace regardless
// of visibility (search.ts filters only workspaceId/MATCH/stale/archivedAt). The
// daemon pre_llm_call recall + post_llm_call compaction passes read it RAW and
// inject the hits into an agent's prompt / session projection — so without an
// ACL filter every role:/council:/other-agent-private page leaks into any
// agent's context (the primary leak in practice: automatic, no RPC needed).
//
// These tests use side-effect oracles only: the actual injected recall `context`
// string (which lists hit paths) + the shared filterRecallHits/canReader judge.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { openLocalDb } from '../src/sync/store.js';
import { RunSessionRegistry } from '../src/daemon/memory/run-session-map.js';
import { attachHookServer } from '../src/daemon/memory/hook-server.js';
import { canReaderReadVisibility, type MemoryReader } from '../src/daemon/memory/acl-predicate.js';

const WS = 'ws_recall_acl';

let server: LocalServer | undefined;
let baseUrl = '';
let scratchDir = '';
let prevGw: string | undefined;
let prevShadow: string | undefined;

function buildState(): LocalServerState {
  return {
    daemonId: 'dev_test',
    daemonVersion: '2.1.0-test',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: WS,
    pid: 99997,
    startedAt: Date.now() - 1_000,
    wsConnected: true,
    hostedAgents: [],
    runningTaskIds: [],
    adapters: [],
    resources: { cpu: { usagePct: 0 }, mem: { usedBytes: 0, limitBytes: 0 } },
    readyForDispatch: true,
  };
}

function mountServer(): { server: LocalServer; registry: RunSessionRegistry; runtime: MemoryRuntime } {
  const db = openLocalDb(':memory:');
  const registry = new RunSessionRegistry(db);
  const memoryRuntime = new MemoryRuntime({ baseDir: scratchDir, deviceId: 'dev_test' });
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'test_key',
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true, data: { extracted: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const attachHooks = attachHookServer({
    cloud,
    memoryRuntime,
    runSessionRegistry: registry,
    deviceId: 'dev_test',
    profileResolver: { byProfileName: () => null },
  });
  return {
    // ephemeral port — the caller reads the real one back after start (O16-b)
    server: new LocalServer({ port: 0, getState: buildState, attachHooks }),
    registry,
    runtime: memoryRuntime,
  };
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'prismer-recall-acl-'));
  // Force INJECT mode (not shadow) so pre_llm_call returns the recall context.
  prevGw = process.env.PRISMER_LOCAL_GATEWAY;
  prevShadow = process.env.FF_MEMORY_RECALL_SHADOW;
  delete process.env.PRISMER_LOCAL_GATEWAY;
  process.env.FF_MEMORY_RECALL_SHADOW = '0';
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  if (prevGw === undefined) delete process.env.PRISMER_LOCAL_GATEWAY;
  else process.env.PRISMER_LOCAL_GATEWAY = prevGw;
  if (prevShadow === undefined) delete process.env.FF_MEMORY_RECALL_SHADOW;
  else process.env.FF_MEMORY_RECALL_SHADOW = prevShadow;
});

// Distinctive shared token so all three pages match ONE FTS query.
const TOKEN = 'quantumcachexyz';

function seedPages(runtime: MemoryRuntime): void {
  const store = runtime.resolve(WS).store;
  // Identical-length/structure content so all three score EQUALLY on the shared
  // FTS token — the test isolates the ACL filter, not BM25 ranking. (Uneven doc
  // lengths let the longest page fall below the relevance threshold and drop out
  // for reasons unrelated to visibility.)
  store.write({
    workspaceId: WS,
    path: 'shared-note.md',
    content: `${TOKEN} note`,
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'human',
    visibility: { kind: 'workspace' },
  });
  store.write({
    workspaceId: WS,
    path: 'roleB-secret.md',
    content: `${TOKEN} note`,
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'agent',
    visibility: { kind: 'role', slug: 'roleB' },
  });
  store.write({
    workspaceId: WS,
    path: 'convB-decision.md',
    content: `${TOKEN} note`,
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'agent',
    visibility: { kind: 'council', id: 'convB' },
  });
}

async function preLlmRecall(profile: string, session: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/hooks/pre_llm_call?profile=${profile}&adapter=hermes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'pre_llm_call',
      session_id: session,
      extra: { user_message: `${TOKEN} eviction policy` },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { context?: string };
  return body.context ?? '';
}

describe('hook-server pre_llm_call recall ACL (product204/34 Track 0.1b)', () => {
  it('a roleA/convA agent does NOT recall roleB or council-B pages (leak closed)', async () => {
    const setup = mountServer();
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    seedPages(setup.runtime);
    setup.registry.register({
      runId: 'run_a',
      conversationId: 'convA',
      taskId: null,
      agentImUserId: 'agent_a',
      workspaceId: WS,
      profileName: 'prof-a',
      roleTemplateSlug: 'roleA',
      adapterName: 'hermes',
    });

    const context = await preLlmRecall('prof-a', 'run_a');
    // workspace-visible page IS recalled (the legit shared path stays open)
    expect(context).toContain('shared-note.md');
    // other role / other council pages are FILTERED OUT
    expect(context).not.toContain('roleB-secret.md');
    expect(context).not.toContain('convB-decision.md');
  });

  it('the roleB agent DOES recall its own role page (positive member recall)', async () => {
    const setup = mountServer();
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    seedPages(setup.runtime);
    setup.registry.register({
      runId: 'run_b',
      conversationId: 'convA', // NOT convB → council-B still filtered
      taskId: null,
      agentImUserId: 'agent_b',
      workspaceId: WS,
      profileName: 'prof-b',
      roleTemplateSlug: 'roleB',
      adapterName: 'hermes',
    });

    const context = await preLlmRecall('prof-b', 'run_b');
    expect(context).toContain('shared-note.md');
    expect(context).toContain('roleB-secret.md'); // own role → recalled
    expect(context).not.toContain('convB-decision.md'); // not a member of convB
  });

  it('an agent dispatched INSIDE council convB recalls the council page (positive member recall — M5 ④)', async () => {
    const setup = mountServer();
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    seedPages(setup.runtime);
    setup.registry.register({
      runId: 'run_c',
      conversationId: 'convB', // member of council B
      taskId: null,
      agentImUserId: 'agent_c',
      workspaceId: WS,
      profileName: 'prof-c',
      roleTemplateSlug: 'roleA', // roleA → roleB still filtered
      adapterName: 'hermes',
    });

    const context = await preLlmRecall('prof-c', 'run_c');
    expect(context).toContain('shared-note.md');
    expect(context).toContain('convB-decision.md'); // same council → recalled
    expect(context).not.toContain('roleB-secret.md'); // not roleB
  });
});

// The compaction recall pass (post_llm_call) filters through the SAME
// filterRecallHits(slot, hybrid(), readerFromCtx(ctx)) helper. This exercises
// the shared judge over the seeded store deterministically (the full
// post_llm_call flow depends on cloud compaction-candidate slicing + fire-and-
// forget timing; the judge is the security-load-bearing part and is shared).
describe('shared recall judge canReaderReadVisibility (product204/34 Track 0.1)', () => {
  const reader = (r: Partial<MemoryReader>): MemoryReader => ({ imUserId: 'agent_x', ...r });

  it('role: own role → readable; other role → denied; orchestrator → all roles', () => {
    expect(canReaderReadVisibility(reader({ roleSlugs: ['roleB'] }), { kind: 'role', slug: 'roleB' })).toBe(true);
    expect(canReaderReadVisibility(reader({ roleSlugs: ['roleA'] }), { kind: 'role', slug: 'roleB' })).toBe(false);
    expect(canReaderReadVisibility(reader({ isOrchestrator: true }), { kind: 'role', slug: 'roleB' })).toBe(true);
    expect(canReaderReadVisibility(reader({}), { kind: 'role', slug: 'roleB' })).toBe(false); // fail-closed
  });

  it('council: member → readable; non-member → denied (fail-closed)', () => {
    expect(canReaderReadVisibility(reader({ councilIds: ['convB'] }), { kind: 'council', id: 'convB' })).toBe(true);
    expect(canReaderReadVisibility(reader({ councilIds: ['convA'] }), { kind: 'council', id: 'convB' })).toBe(false);
    expect(canReaderReadVisibility(reader({}), { kind: 'council', id: 'convB' })).toBe(false);
  });

  it('workspace shared → readable by anyone; other agent private → denied', () => {
    expect(canReaderReadVisibility(reader({}), { kind: 'workspace' })).toBe(true);
    expect(canReaderReadVisibility(reader({ imUserId: 'agent_x' }), { kind: 'private', imUserId: 'agent_x' })).toBe(true);
    expect(canReaderReadVisibility(reader({ imUserId: 'agent_x' }), { kind: 'private', imUserId: 'agent_y' })).toBe(false);
  });

  it('system reader sees everything', () => {
    expect(canReaderReadVisibility(reader({ isSystem: true }), { kind: 'role', slug: 'any' })).toBe(true);
    expect(canReaderReadVisibility(reader({ isSystem: true }), { kind: 'council', id: 'any' })).toBe(true);
  });
});
