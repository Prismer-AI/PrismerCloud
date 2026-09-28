// v2.1 §9.5 — daemon-as-hook-intake unit tests.
//
// Validates the 3 hook routes wire into LocalServer correctly + the
// heuristic filter blocks tiny / greeting turns from the extractor.
// Cloud is stubbed via CloudClient.fetchImpl so the test never reaches
// the network.

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
import {
  attachHookServer,
  recallShadowEnabled,
  resolvePostTurnModel,
} from '../src/daemon/memory/hook-server.js';
import { getRecallStats } from '../src/daemon/memory/recall-stats.js';
import { PostTurnStore } from '../src/adapters/coding/shared/lifecycle/post-turn-store.js';
import {
  TerminalFinalizer,
  setTerminalFinalizer,
} from '../src/adapters/coding/shared/lifecycle/terminal-finalizer.js';

let server: LocalServer | undefined;
let baseUrl = '';
let scratchDir = '';

function buildState(): LocalServerState {
  return {
    daemonId: 'dev_test',
    daemonVersion: '2.1.0-test',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: 'ws_hookserver',
    pid: 99998,
    startedAt: Date.now() - 1_000,
    wsConnected: true,
    hostedAgents: [],
    runningTaskIds: [],
    adapters: [],
    resources: { cpu: { usagePct: 0 }, mem: { usedBytes: 0, limitBytes: 0 } },
    readyForDispatch: true,
  };
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'prismer-hookserver-'));
});

afterEach(async () => {
  setTerminalFinalizer(null);
  await server?.stop();
  server = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe('hook-server routes (v2.1 §9.5)', () => {
  it('pre_llm_call returns empty context when no memory exists', async () => {
    const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);

    // Pre-register the run session so resolveContext picks up workspace/agent.
    setup.registry.register({
      runId: 'run_known',
      conversationId: 'conv_a',
      taskId: 'task_a',
      agentImUserId: 'agent_a',
      workspaceId: 'ws_hookserver',
      profileName: 'test-profile',
      roleTemplateSlug: null,
      adapterName: 'hermes',
    });

    const res = await fetch(
      `${baseUrl}/v1/hooks/pre_llm_call?profile=test-profile&adapter=hermes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'pre_llm_call',
          session_id: 'run_known',
          extra: { user_message: 'tell me about caching strategies in distributed systems' },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context?: string };
    expect(body.context).toBe('');
  });

  it('pre_llm_call returns 422 for an unresolved profile + unknown session', async () => {
    const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(
      `${baseUrl}/v1/hooks/pre_llm_call?profile=nonexistent&adapter=hermes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'pre_llm_call',
          session_id: 'run_no_registry_entry',
          extra: { user_message: 'hello' },
        }),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unresolved_profile');
  });

  it('post_llm_call skips heuristically tiny turns without calling cloud', async () => {
    let cloudCalls = 0;
    const setup = mountServer({
      cloudExtractResponse: { extracted: [] },
      onCloudCall: () => {
        cloudCalls += 1;
      },
    });
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);

    // Pre-register a run-session so the profile resolver isn't needed.
    setup.registry.register({
      runId: 'run_tiny',
      conversationId: 'conv_x',
      taskId: 'task_x',
      agentImUserId: 'agent_x',
      workspaceId: 'ws_hookserver',
      profileName: 'whatever',
      roleTemplateSlug: null,
      adapterName: 'hermes',
    });

    const res = await fetch(
      `${baseUrl}/v1/hooks/post_llm_call?profile=whatever&adapter=hermes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'post_llm_call',
          session_id: 'run_tiny',
          extra: {
            user_message: 'hi',
            assistant_response: 'hello',
            conversation_history: [],
          },
        }),
      },
    );
    expect(res.status).toBe(204);
    expect(cloudCalls).toBe(0);
  });

  it('post_llm_call persists a durable job instead of using the in-memory extraction queue', async () => {
    let cloudCalls = 0;
    const setup = mountServer({
      cloudExtractResponse: { extracted: [] },
      profileResolution: {
        agentImUserId: 'agent_durable',
        workspaceId: 'ws_hookserver',
        adapterName: 'hermes',
        roleTemplateSlug: 'team-manager',
        model: 'deepseek-v4-flash',
        proxyProvider: 'default',
      },
      onCloudCall: () => {
        cloudCalls += 1;
      },
    });
    const postTurnDb = openLocalDb(':memory:');
    const postTurnStore = new PostTurnStore(postTurnDb);
    setTerminalFinalizer(new TerminalFinalizer(postTurnStore));
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    setup.registry.register({
      runId: 'run_durable',
      conversationId: 'conv_durable',
      taskId: 'task_durable',
      agentImUserId: 'agent_durable',
      workspaceId: 'ws_hookserver',
      profileName: 'durable-profile',
      roleTemplateSlug: null,
      adapterName: 'hermes',
    });

    const res = await fetch(
      `${baseUrl}/v1/hooks/post_llm_call`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'post_llm_call',
          session_id: 'run_durable',
          extra: {
            agent_im_user_id: 'agent_durable',
            workspace_id: 'ws_hookserver',
            user_message: 'Please preserve this architecture decision and its stable runtime ownership boundary.',
            assistant_response:
              'The runtime now owns terminal lifecycle persistence, retry, extraction, and exactly-once memory apply.',
            attached_asset_ids: ['asset_1'],
          },
        }),
      },
    );

    expect(res.status).toBe(204);
    expect(postTurnStore.list()).toHaveLength(1);
    expect(postTurnStore.list()[0]).toMatchObject({
      turnId: 'run_durable',
      canonicalTurnId: 'task_durable',
      conversationId: 'conv_durable',
      status: 'pending',
      payload: {
        executionContext: {
          adapterName: 'hermes',
          roleSlug: 'team-manager',
          proxyProvider: 'default',
          attachedAssetIds: ['asset_1'],
        },
      },
    });
    expect(cloudCalls).toBe(0);
    postTurnDb.close();
  });

  it('negative control: hook-supplied served routing is rejected and performs zero extraction and writes', async () => {
    let cloudCalls = 0;
    const setup = mountServer({
      cloudExtractResponse: { extracted: [] },
      profileResolution: {
        agentImUserId: 'agent_no_provider',
        workspaceId: 'ws_hookserver',
        adapterName: 'hermes',
        roleTemplateSlug: 'team-manager',
        model: 'configured-model-is-not-evidence',
        proxyProvider: 'configured-chain-is-not-evidence',
      },
      onCloudCall: () => { cloudCalls += 1; },
    });
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(`${baseUrl}/v1/hooks/post_llm_call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'post_llm_call',
        session_id: 'api_missing_provider',
        extra: {
          agent_im_user_id: 'agent_no_provider',
          workspace_id: 'ws_hookserver',
          served_model: 'served-model-without-provider',
          user_message:
            'Please preserve this detailed architecture decision, its ownership boundaries, retry semantics, and exact recovery behavior for all future sessions.',
          assistant_response:
            'The Runtime owns the complete durable lifecycle: terminal evidence capture, provider identity validation, extraction, exactly-once Page application, outbox delivery, authoritative Cloud acknowledgement, restart recovery, and conflict handling. Configured provider chains are diagnostic intent only and can never stand in for the provider that actually served the completed turn.',
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(res.status).toBe(400);
    expect(cloudCalls).toBe(0);
    expect(setup.runtime.resolve('ws_hookserver').store.list({ limit: 20 })).toHaveLength(0);
  });

  it('records bounded post_api_request routing on the exact provider session and rejects identity tamper', async () => {
    const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    setup.registry.register({
      runId: 'run_routing_exact',
      providerSessionId: 'api_routing_exact',
      conversationId: 'conv_routing',
      taskId: 'task_routing',
      agentImUserId: 'agent_routing',
      workspaceId: 'ws_hookserver',
      profileName: 'routing-profile',
      roleTemplateSlug: null,
      adapterName: 'hermes',
    });

    const postEvidence = (workspaceId: string, servedModel: string) =>
      fetch(`${baseUrl}/v1/hooks/post_api_request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'post_api_request',
          session_id: 'api_routing_exact',
          extra: {
            agent_im_user_id: 'agent_routing',
            workspace_id: workspaceId,
            served_model: servedModel,
            served_provider: 'served-provider',
          },
        }),
      });

    const accepted = await postEvidence('ws_hookserver', 'served-model');
    expect(accepted.status).toBe(204);
    expect(setup.registry.lookup('run_routing_exact')).toMatchObject({
      servedModel: 'served-model',
      servedProvider: 'served-provider',
      routingEvidenceSource: 'adapter',
    });

    const tampered = await postEvidence('ws_other', 'tampered-model');
    expect(tampered.status).toBe(403);
    expect(setup.registry.lookup('run_routing_exact')).toMatchObject({
      servedModel: 'served-model',
      servedProvider: 'served-provider',
    });
  });

  it('maps provider api identity and explicit write receipts onto the canonical cloud run job', async () => {
    const setup = mountServer({
      cloudExtractResponse: { extracted: [] },
      profileResolution: {
        agentImUserId: 'agent_explicit',
        workspaceId: 'ws_hookserver',
        adapterName: 'hermes',
        roleTemplateSlug: 'researcher',
        model: 'deepseek-v4-flash',
        proxyProvider: 'default',
      },
    });
    const postTurnDb = openLocalDb(':memory:');
    const postTurnStore = new PostTurnStore(postTurnDb);
    setTerminalFinalizer(new TerminalFinalizer(postTurnStore));
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    setup.registry.register({
      runId: 'api_provider_explicit',
      conversationId: 'conv_explicit',
      taskId: 'run_cloud_explicit',
      messageId: 'msg_explicit',
      agentImUserId: 'agent_explicit',
      workspaceId: 'ws_hookserver',
      profileId: 'profile_explicit',
      profileName: 'explicit-profile',
      roleTemplateSlug: 'researcher',
      adapterName: 'hermes',
      model: 'deepseek-v4-flash',
      proxyProvider: 'default',
    });

    const res = await fetch(`${baseUrl}/v1/hooks/post_llm_call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'post_llm_call',
        session_id: 'api_provider_explicit',
        extra: {
          agent_im_user_id: 'agent_explicit',
          workspace_id: 'ws_hookserver',
          user_message: 'Preserve this explicit durable decision in authoritative Memory.',
          assistant_response: 'The page was written through the native memory_write tool.',
          explicit_memory_receipts: [
            { pageId: 'page_1', path: 'decisions/a.pkf', version: 3, contentHash: 'hash_1' },
          ],
        },
      }),
    });

    expect(res.status).toBe(204);
    expect(postTurnStore.list()).toHaveLength(1);
    expect(postTurnStore.list()[0]).toMatchObject({
      turnId: 'api_provider_explicit',
      canonicalTurnId: 'run_cloud_explicit',
      runId: 'run_cloud_explicit',
      messageId: 'msg_explicit',
      lane: 'explicit',
      payload: {
        explicitMemoryReceipts: [
          { pageId: 'page_1', path: 'decisions/a.pkf', version: 3, contentHash: 'hash_1' },
        ],
        executionContext: {
          profileId: 'profile_explicit',
          profileName: 'explicit-profile',
          providerTurnId: 'api_provider_explicit',
        },
      },
    });
    postTurnDb.close();
  });

  it('prefers an explicit hook model, then the resolved profile model', () => {
    expect(resolvePostTurnModel({ model: ' explicit-model ' }, 'profile-model')).toBe('explicit-model');
    expect(resolvePostTurnModel({}, ' profile-model ')).toBe('profile-model');
    expect(resolvePostTurnModel({}, null)).toBe('');
  });

  it('uses the daemon-staged native write receipt when sync_turn omits its provider buffer', async () => {
    const staged = { pageId: 'page_staged', path: 'decisions/staged.pkf', version: 5, contentHash: 'hash_staged' };
    const setup = mountServer({
      cloudExtractResponse: { extracted: [] },
      stagedExplicitMemoryReceipts: [staged],
      profileResolution: {
        agentImUserId: 'agent_staged',
        workspaceId: 'ws_hookserver',
        adapterName: 'hermes',
        roleTemplateSlug: 'researcher',
        model: 'deepseek-v4-flash',
        proxyProvider: 'default',
      },
    });
    const postTurnDb = openLocalDb(':memory:');
    const postTurnStore = new PostTurnStore(postTurnDb);
    setTerminalFinalizer(new TerminalFinalizer(postTurnStore));
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);
    setup.registry.register({
      runId: 'api_provider_staged',
      conversationId: 'conv_staged',
      taskId: 'run_cloud_staged',
      messageId: 'msg_staged',
      agentImUserId: 'agent_staged',
      workspaceId: 'ws_hookserver',
      profileId: 'profile_staged',
      profileName: 'staged-profile',
      roleTemplateSlug: 'researcher',
      adapterName: 'hermes',
      model: 'deepseek-v4-flash',
      proxyProvider: 'default',
    });

    const res = await fetch(`${baseUrl}/v1/hooks/post_llm_call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'post_llm_call',
        session_id: 'api_provider_staged',
        extra: {
          agent_im_user_id: 'agent_staged',
          workspace_id: 'ws_hookserver',
          user_message: 'Persist one durable decision.',
          assistant_response: 'Done.',
        },
      }),
    });

    expect(res.status).toBe(204);
    expect(postTurnStore.list()[0]).toMatchObject({
      lane: 'explicit',
      payload: { explicitMemoryReceipts: [staged] },
    });
    postTurnDb.close();
  });

  it('desktop daemon (doc 18 §3a): shadow recall computes but does NOT inject; shadowFiredCount bumps', async () => {
    getRecallStats().reset();
    const prevGw = process.env.PRISMER_LOCAL_GATEWAY;
    const prevFf = process.env.FF_MEMORY_RECALL_SHADOW;
    // Desktop capability bit ON, no explicit FF → shadow defaults true.
    process.env.PRISMER_LOCAL_GATEWAY = '1';
    delete process.env.FF_MEMORY_RECALL_SHADOW;
    try {
      const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
      server = setup.server;
      await server.start();
      baseUrl = boundBaseUrl(server);

      // Seed a strongly-matching page so recall WOULD have hits to inject.
      setup.runtime.resolve('ws_hookserver').store.write({
        workspaceId: 'ws_hookserver',
        path: 'caching.md',
        content: 'distributed caching strategies: write-through, write-back, TTL eviction',
        pageType: 'leaf',
        actorImUserId: 'im_seed',
        actorKind: 'human',
      });

      setup.registry.register({
        runId: 'run_shadow',
        conversationId: 'conv_s',
        taskId: null,
        agentImUserId: 'agent_s',
        workspaceId: 'ws_hookserver',
        profileName: 'shadow-profile',
        roleTemplateSlug: null,
        adapterName: 'hermes',
      });

      const res = await fetch(
        `${baseUrl}/v1/hooks/pre_llm_call?profile=shadow-profile&adapter=hermes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hook_event_name: 'pre_llm_call',
            session_id: 'run_shadow',
            extra: { user_message: 'distributed caching strategies' },
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { context?: string };
      // SHADOW: even though recall had hits, NOTHING is injected.
      expect(body.context).toBe('');
      expect(body.context).not.toContain('[Relevant memory');
      // doc 18 §8 — shadow firing is counted.
      expect(getRecallStats().snapshot().shadowFiredCount).toBeGreaterThan(0);
    } finally {
      if (prevGw === undefined) delete process.env.PRISMER_LOCAL_GATEWAY;
      else process.env.PRISMER_LOCAL_GATEWAY = prevGw;
      if (prevFf === undefined) delete process.env.FF_MEMORY_RECALL_SHADOW;
      else process.env.FF_MEMORY_RECALL_SHADOW = prevFf;
      getRecallStats().reset();
    }
  });

  it('on_session_end returns 204 and drops the run mapping', async () => {
    const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
    server = setup.server;
    await server.start();
    baseUrl = boundBaseUrl(server);

    setup.registry.register({
      runId: 'run_endme',
      conversationId: null,
      taskId: null,
      agentImUserId: 'agent_y',
      workspaceId: 'ws_hookserver',
      profileName: 'whatever',
      roleTemplateSlug: null,
      adapterName: 'hermes',
    });
    expect(setup.registry.lookup('run_endme')).not.toBeNull();

    const res = await fetch(
      `${baseUrl}/v1/hooks/on_session_end?profile=whatever&adapter=hermes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'on_session_end',
          session_id: 'run_endme',
          extra: {},
        }),
      },
    );
    expect(res.status).toBe(204);
    expect(setup.registry.lookup('run_endme')).toBeNull();
  });
});

// ---- harness ------------------------------------------------------------

interface MountOpts {
  cloudExtractResponse: { extracted: Array<unknown> };
  onCloudCall?: () => void;
  stagedExplicitMemoryReceipts?: Array<{
    pageId: string;
    path: string;
    version: number;
    contentHash: string;
  }>;
  profileResolution?: {
    agentImUserId: string;
    workspaceId: string;
    adapterName: string;
    roleTemplateSlug: string | null;
    model: string | null;
    proxyProvider: string | null;
  };
}

function mountServer(opts: MountOpts): {
  server: LocalServer;
  registry: RunSessionRegistry;
  runtime: MemoryRuntime;
} {
  const db = openLocalDb(':memory:');
  const registry = new RunSessionRegistry(db);
  const memoryRuntime = new MemoryRuntime({ baseDir: scratchDir, deviceId: 'dev_test' });
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'test_key',
    fetchImpl: async () => {
      opts.onCloudCall?.();
      return new Response(JSON.stringify({ ok: true, data: opts.cloudExtractResponse }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const attachHooks = attachHookServer({
    cloud,
    memoryRuntime,
    runSessionRegistry: registry,
    deviceId: 'dev_test',
    profileResolver: {
      byProfileName: () => opts.profileResolution ?? null,
    },
    resolveExplicitMemoryReceipts: () => opts.stagedExplicitMemoryReceipts ?? [],
  });
  return {
    // ephemeral port — the caller reads the real one back after start (O16-b)
    server: new LocalServer({ port: 0, getState: buildState, attachHooks }),
    registry,
    runtime: memoryRuntime,
  };
}

describe('recallShadowEnabled capability bit (doc 18 §3a/§14)', () => {
  const keys = ['FF_MEMORY_RECALL_SHADOW', 'PRISMER_LOCAL_GATEWAY'] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('explicit FF=true → shadow (wins over capability bit)', () => {
    process.env.FF_MEMORY_RECALL_SHADOW = 'true';
    expect(recallShadowEnabled()).toBe(true);
  });

  it('explicit FF=false → inject even on desktop (operator override wins)', () => {
    process.env.FF_MEMORY_RECALL_SHADOW = 'false';
    process.env.PRISMER_LOCAL_GATEWAY = '1';
    expect(recallShadowEnabled()).toBe(false);
  });

  it('desktop daemon (PRISMER_LOCAL_GATEWAY=1), no explicit FF → shadow ON', () => {
    process.env.PRISMER_LOCAL_GATEWAY = '1';
    expect(recallShadowEnabled()).toBe(true);
  });

  it('CLI/K8s (no capability bit, no FF) → legacy inject (shadow OFF)', () => {
    expect(recallShadowEnabled()).toBe(false);
  });
});
