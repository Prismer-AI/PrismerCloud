/**
 * memory211/10 R5 — 死路径收敛记账（**有意翻红更新** R0 基线锚；07 §2.3 + §7 R5）。
 *
 * R0（2026-09-16）记账的事实是：`recall-injector.ts` 的 `buildRecallInjection`
 * 是零调用点的平行纯函数路径。R5 的裁决是**摘除**该死路径——ρ（MemoryRecallPolicy）
 * 只收敛到 live 路径 `hooks.ts MemoryRecallHooks.onIdleRecallHint`，不再保留第二
 * 条没人走的注入实现（「演化改了个没人调的函数」正是 07 §2.3 点名的失败模式，
 * 也是本波验收负控的靶子：改死函数 → live 行为不变 → 红）。
 *
 * 本文件由「死路径仍死」tripwire 改写为「死路径已摘除」tripwire：
 *   - 断言①：buildRecallInjection 在 sdk/src、sdk/test、主仓 src/ **全树零残留**
 *     （定义、导入、调用一概不许——再出现 = 有人把死路径又种回来了，红）。
 *   - 断言②：recall-injector.ts 死模块本身已删除。
 *   - 断言③：live 的 recall_inject 发射点仍是 hooks.ts 的 outbox.enqueue 形状，
 *     且消费 ρ（policyFor / policy.recallInject.topK）——搬迁则 red 提示更新本记账。
 *
 * 判定纪律不变：这条红 = 行为漂移或记账过期，不是「测试坏了」。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(new URL(import.meta.url).pathname);
const SDK_SRC = resolve(HERE, '../src');
const SDK_TEST = resolve(HERE, '.');
const CLOUD_SRC = resolve(HERE, '../../../src');

function collectFiles(root: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('memory211/10 R5 — buildRecallInjection 死路径已摘除（ρ 收敛 live）', () => {
  it('① buildRecallInjection 全树零残留（定义/导入/调用）', () => {
    const residue: string[] = [];
    for (const root of [SDK_SRC, SDK_TEST, CLOUD_SRC]) {
      for (const file of collectFiles(root, (p) => /\.(ts|tsx)$/.test(p))) {
        if (file === join(SDK_TEST, 'memory-recall-inject-deadpath.test.ts')) continue; // this baseline
        const src = readFileSync(file, 'utf8');
        // Call / definition expressions only — comment MENTIONS of the name
        // (like the R1-era CHANGELOG notes) are history, not a resurrected path.
        if (/\bbuildRecallInjection\s*\(/.test(src)) residue.push(file);
      }
    }
    expect(
      residue,
      'buildRecallInjection residue found — the dead path was removed in R5 on purpose. ' +
        'Do NOT resurrect it: consume MemoryRecallPolicy on the LIVE hook ' +
        '(hooks.ts onIdleRecallHint) instead, and update this baseline if the convergence story changes.',
    ).toEqual([]);
  });

  it('② recall-injector.ts 死模块本身已删除', () => {
    const exists = collectFiles(SDK_SRC, (p) => p.endsWith('recall-injector.ts'));
    expect(exists).toEqual([]);
  });

  it('③ live recall_inject 发射点仍是 hooks.ts（outbox.enqueue 形状），且消费 ρ', () => {
    const hooks = readFileSync(join(SDK_SRC, 'daemon/memory/hooks.ts'), 'utf8');
    expect(hooks).toMatch(/eventType:\s*'recall_inject'/);
    expect(hooks).toMatch(/idempotencyKey:\s*`obs:recall_inject:/);
    // ρ convergence markers: the hook consults the policy before defaults.
    expect(hooks).toMatch(/policyFor\(/);
    expect(hooks).toMatch(/policy\?\.recallInject\.topK/);
  });
});
