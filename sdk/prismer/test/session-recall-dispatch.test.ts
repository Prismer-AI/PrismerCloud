// spec 11 T5-1 — dispatch must drive the daemon's session recall lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDispatch } from '../src/daemon/dispatch.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { MemoryRecallHooks } from '../src/daemon/memory/hooks.js';
import {
  SessionRecallCoordinator,
  setSessionRecallCoordinator,
} from '../src/daemon/memory/session-recall.js';
import {
  createCloudRecallPolicyProvider,
  setCloudRecallPolicyProvider,
} from '../src/daemon/memory/recall-policy-provider.js';
import type { AdapterDef, AgentProfile, TaskInput } from '../src/adapters/contract.js';

let dir = '';
let runtime: MemoryRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-session-recall-dispatch-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_t5' });
  setSessionRecallCoordinator(new SessionRecallCoordinator(new MemoryRecallHooks(runtime, 'dev_t5')));
});

afterEach(() => {
  setSessionRecallCoordinator(null);
  setCloudRecallPolicyProvider(null);
  runtime.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeProfile(): AgentProfile {
  return {
    id: 'profile_t5',
    workspaceId: 'ws_t5',
    agentImUserId: 'agent_t5',
    adapterName: 'pi-core',
    name: 'T5 test agent',
    config: {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function seedIndex(): void {
  runtime.resolve('ws_t5').store.write({
    workspaceId: 'ws_t5',
    path: 'INDEX.pkf',
    content: '# Workspace index\n\n- Important project context\n',
    pageType: 'index' as unknown as 'hub',
    actorImUserId: 'seed_t5',
    actorKind: 'human',
  });
}

async function dispatch(conversationId?: string): Promise<ReturnType<typeof vi.fn>> {
  const profile = makeProfile();
  const adapter: AdapterDef = {
    name: 'pi-core',
    kind: 'long-running',
    capabilities: [],
    workspaceSchema: {} as unknown,
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
  };
  const cloud = {
    get: vi.fn(async (path: string) => {
      if (path === `/api/im/agent_profiles/${profile.id}`) return profile;
      if (path.startsWith('/api/im/skills/installed?')) return [];
      if (path.startsWith('/api/im/memory/digest?')) return { digest: '', filesTotal: 0 };
      if (path.startsWith('/api/im/tasks?')) return [];
      throw new Error(`unexpected GET ${path}`);
    }),
    request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
  };
  const adapterDispatch = vi.fn(async (_task: TaskInput) => ({ ok: true, output: 'done' }));

  const reply = await handleDispatch(
    {
      taskId: `task_${conversationId ?? 'none'}`,
      agentImUserId: profile.agentImUserId,
      profileId: profile.id,
      capability: 'chat',
      prompt: 'Continue the workspace task.',
      ...(conversationId ? { conversationId } : {}),
    },
    'request_t5',
    {
      registry: { get: () => adapter } as never,
      cloud: cloud as never,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      } as never,
      assetCache: { unpin: vi.fn(), pin: vi.fn() } as never,
      ws: { send: vi.fn() } as never,
      ensureService: async () => ({ id: 'svc_t5', healthy: async () => true, dispatch: adapterDispatch }),
    },
  );

  expect(reply.ok).toBe(true);
  return adapterDispatch;
}

describe('spec 11 T5-1 — dispatch/session recall lifecycle', () => {
  it('starts recall for a conversation-backed dispatch and records the preload observation', async () => {
    seedIndex();
    const slot = runtime.resolve('ws_t5');
    const before = slot.outbox.pendingCount();

    await dispatch('conversation_t5');

    expect(slot.outbox.pendingCount()).toBe(before + 1);
  });

  it('injects session-start recall content into the dispatched prompt', async () => {
    seedIndex();

    const adapterDispatch = await dispatch('conversation_prompt_t5');

    const task = adapterDispatch.mock.calls[0]?.[0] as TaskInput | undefined;
    expect(task?.prompt).toContain('[Memory Context]');
    expect(task?.prompt).toContain('[Session Recall]');
    expect(task?.prompt).toContain('Important project context');
  });

  it('keeps the previous negative behavior when dispatch has no session', async () => {
    seedIndex();
    const slot = runtime.resolve('ws_t5');
    const before = slot.outbox.pendingCount();

    await dispatch();

    expect(slot.outbox.pendingCount()).toBe(before);
  });

  it('refreshes the registered workspace policy only for a session-backed dispatch', async () => {
    const policyCloud = {
      get: vi.fn(async () => ({ metadata: {} })),
    };
    setCloudRecallPolicyProvider(createCloudRecallPolicyProvider(policyCloud as never));

    await dispatch('conversation_policy_t5');
    expect(policyCloud.get).toHaveBeenCalledWith('/api/im/workspaces/ws_t5');

    policyCloud.get.mockClear();
    await dispatch();
    expect(policyCloud.get).not.toHaveBeenCalled();
  });
});
