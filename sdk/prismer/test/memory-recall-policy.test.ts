// memory211/10 R5 — ρ (MemoryRecallPolicy) consumed on the LIVE recall hook.
//
// 07 §2.3 验收负控的靶子：「policy 改 topK → live 注入行为变（负控：改死函数 →
// 行为不变 → 红）」。死函数（buildRecallInjection）已在 R5 摘除（见
// memory-recall-inject-deadpath.test.ts），本文件把正面断言钉死：hook 的注入
// 行为跟随 policy——topK 收紧 ⇒ 注入条数变；recallInject.enabled=false ⇒ 注入
// 关闭；无 policy ⇒ 内建默认（既有语义零漂移）。
//
// Run: npx vitest run test/memory-recall-policy.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRecallHooks, setRecallPolicyProvider, type MemoryRuntime } from '../src/daemon/memory/hooks.js';

function fakeRuntime(resultCount: number): MemoryRuntime {
  const results = Array.from({ length: resultCount }, (_, i) => ({
    pageId: `p${i}`,
    path: `memory/page-${i}.md`,
    title: `Page ${i}`,
    snippet: `snippet ${i}`,
    score: 0.9 - i * 0.05,
    tokenCount: 10,
    offset: 0,
  }));
  const hybrid = vi.fn((_query: string, opts: { topK: number }) => results.slice(0, opts.topK));
  return {
    resolve: () => ({
      search: {
        // The REAL store.search.hybrid honors `topK`/`maxBytes`/threshold (its
        // own contract, tested in the store suite). This fake does the same so
        // the test observes exactly what the hook passes down — the seam where
        // ρ lands.
        hybrid,
      },
      outbox: {
        enqueue: vi.fn(),
      },
    }),
  } as unknown as MemoryRuntime;
}

const CTX = {
  workspaceId: 'ws_policy',
  agentImUserId: 'agent_1',
  actorKind: 'agent' as const,
  query: 'kestrel protocol',
  sessionId: 's1',
  turnIndex: 1,
};

afterEach(() => {
  setRecallPolicyProvider(null);
});

describe('ρ on the live hook — policy 改，注入行为就变', () => {
  it('无 policy → 内建默认 topK=3（既有语义零漂移）', () => {
    const hooks = new MemoryRecallHooks(fakeRuntime(6), 'dev');
    const res = hooks.onIdleRecallHint({ ...CTX });
    expect(res).toBeTruthy();
    expect(res!.results).toHaveLength(3);
  });

  it('policy.recallInject.topK=1 → live 注入收紧到 1 条（验收门正面）', () => {
    setRecallPolicyProvider(() => ({
      digestIndexInject: true,
      recallInject: { enabled: true, topK: 1, minScore: 0.3, maxBytes: 2048 },
      firstRoundHybrid: false,
      roleDelivery: {},
    }));
    const hooks = new MemoryRecallHooks(fakeRuntime(6), 'dev');
    const res = hooks.onIdleRecallHint({ ...CTX });
    expect(res).toBeTruthy();
    expect(res!.results).toHaveLength(1);
  });

  it('policy.recallInject.enabled=false → 注入整体关闭', () => {
    setRecallPolicyProvider(() => ({
      digestIndexInject: true,
      recallInject: { enabled: false, topK: 3, minScore: 0.3, maxBytes: 2048 },
      firstRoundHybrid: false,
      roleDelivery: {},
    }));
    const hooks = new MemoryRecallHooks(fakeRuntime(6), 'dev');
    expect(hooks.onIdleRecallHint({ ...CTX })).toBeNull();
  });

  it('policy provider 抛错 → 按无 policy 处理（advisory，永不阻断 recall）', () => {
    setRecallPolicyProvider(() => {
      throw new Error('policy store down');
    });
    const hooks = new MemoryRecallHooks(fakeRuntime(6), 'dev');
    const res = hooks.onIdleRecallHint({ ...CTX });
    expect(res).toBeTruthy();
    expect(res!.results).toHaveLength(3);
  });

  it('显式 ctx.topK 优先于 policy（调用方逐次覆盖仍在）', () => {
    setRecallPolicyProvider(() => ({
      digestIndexInject: true,
      recallInject: { enabled: true, topK: 1, minScore: 0.3, maxBytes: 2048 },
      firstRoundHybrid: false,
      roleDelivery: {},
    }));
    const hooks = new MemoryRecallHooks(fakeRuntime(6), 'dev');
    const res = hooks.onIdleRecallHint({ ...CTX, topK: 2 });
    expect(res!.results).toHaveLength(2);
  });
});
