// spec 11 T5-2 — Cloud policy delivery must reach the daemon's live hooks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { MemoryRecallHooks, setRecallPolicyProvider } from '../src/daemon/memory/hooks.js';
import {
  createCloudRecallPolicyProvider,
  refreshRecallPolicyForWorkspace,
  setCloudRecallPolicyProvider,
} from '../src/daemon/memory/recall-policy-provider.js';

let dir = '';
let runtime: MemoryRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-recall-policy-provider-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_t5' });
});

afterEach(() => {
  setCloudRecallPolicyProvider(null);
  setRecallPolicyProvider(null);
  runtime.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seedRecallPages(): void {
  const slot = runtime.resolve('ws_t5');
  for (let i = 0; i < 4; i += 1) {
    slot.store.write({
      workspaceId: 'ws_t5',
      path: `decision-${i}.md`,
      content: `OAuth migration decision ${i}`,
      pageType: 'leaf',
      actorImUserId: 'seed_t5',
      actorKind: 'human',
    });
  }
}

describe('spec 11 T5-2 — Cloud recall policy provider', () => {
  it('refreshes workspace metadata before the next recall and applies a changed topK', async () => {
    let topK = 1;
    const cloud = {
      get: vi.fn(async (path: string) => {
        expect(path).toBe('/api/im/workspaces/ws_t5');
        return {
          metadata: {
            memoryRecallPolicy: {
              digestIndexInject: false,
              recallInject: { enabled: true, topK, minScore: 0, maxBytes: 4096 },
              firstRoundHybrid: false,
              roleDelivery: { agent: 'auto-inject' },
            },
          },
        };
      }),
    };
    const provider = createCloudRecallPolicyProvider(cloud as never);
    setCloudRecallPolicyProvider(provider);
    seedRecallPages();
    const hooks = new MemoryRecallHooks(runtime, 'dev_t5');

    await refreshRecallPolicyForWorkspace('ws_t5');
    const first = hooks.onIdleRecallHint({
      workspaceId: 'ws_t5',
      agentImUserId: 'agent_t5',
      actorKind: 'agent',
      sessionId: 'session_t5',
      turnIndex: 1,
      query: 'OAuth migration decision',
    });
    expect(first?.results).toHaveLength(1);

    topK = 3;
    await refreshRecallPolicyForWorkspace('ws_t5');
    const changed = hooks.onIdleRecallHint({
      workspaceId: 'ws_t5',
      agentImUserId: 'agent_t5',
      actorKind: 'agent',
      sessionId: 'session_t5b',
      turnIndex: 1,
      query: 'OAuth migration decision',
    });
    expect(changed?.results).toHaveLength(3);
    expect(cloud.get).toHaveBeenCalledTimes(2);
  });

  it('drops invalid or absent cloud policy so the existing hook defaults remain in force', async () => {
    const cloud = {
      get: vi.fn(async () => ({ metadata: { memoryRecallPolicy: { recallInject: { topK: -1 } } } })),
    };
    const provider = createCloudRecallPolicyProvider(cloud as never);
    setCloudRecallPolicyProvider(provider);
    seedRecallPages();
    const hooks = new MemoryRecallHooks(runtime, 'dev_t5');

    await refreshRecallPolicyForWorkspace('ws_t5');
    const recalled = hooks.onIdleRecallHint({
      workspaceId: 'ws_t5',
      agentImUserId: 'agent_t5',
      actorKind: 'agent',
      sessionId: 'session_t5',
      turnIndex: 1,
      query: 'OAuth migration decision',
    });

    expect(recalled?.results.length).toBeGreaterThan(1);
  });
});
