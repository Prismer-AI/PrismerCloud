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
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { openLocalDb } from '../src/sync/store.js';
import { RunSessionRegistry } from '../src/daemon/memory/run-session-map.js';
import { attachHookServer } from '../src/daemon/memory/hook-server.js';

let server: LocalServer | undefined;
let baseUrl = '';
let port = 0;
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
  port = 41000 + Math.floor(Math.random() * 500);
  baseUrl = `http://127.0.0.1:${port}`;
  scratchDir = mkdtempSync(join(tmpdir(), 'prismer-hookserver-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe('hook-server routes (v2.1 §9.5)', () => {
  it('pre_llm_call returns empty context when no memory exists', async () => {
    const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
    server = setup.server;
    await server.start();

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

  it('on_session_end returns 204 and drops the run mapping', async () => {
    const setup = mountServer({ cloudExtractResponse: { extracted: [] } });
    server = setup.server;
    await server.start();

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
}

function mountServer(opts: MountOpts): {
  server: LocalServer;
  registry: RunSessionRegistry;
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
      byProfileName: () => null,
    },
  });
  return {
    server: new LocalServer({ port, getState: buildState, attachHooks }),
    registry,
  };
}
