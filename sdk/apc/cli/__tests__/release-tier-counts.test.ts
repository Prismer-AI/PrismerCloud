/**
 * release-tier-counts.test.ts — tier 门「正证据」计数（W0.8 · apc/12 §0.9 第 6 个实例）。
 *
 * 病灶：`TagReport.tier` 只留 `{tier, exitCode, envBlocked, regressions, emptyRun}`，
 * 而 `isEmptyTierRun` 明明已经从 `gate.raw.stdout` 解析出了每层 passed/failed，
 * **解析完就丢掉了** ⇒ 发版产物查得到「没报错」，查不到「这一跑到底真执行了多少条断言」。
 *
 * 本文件锁三件事：
 *  1. 计数如实进 `cases`（合计 + 每层），0 就是 0、非 0 就是真数；
 *  2. **unknown ≠ 0** —— 载荷解析不出 / 没有 passed·failed 字段时报 `null`，绝不用 0 冒充；
 *  3. `isEmptyTierRun` 下沉到 `parseTierCaseCounts` 后判定与下沉前**逐例等价**
 *     （含 fail-closed 的退化载荷分支），即计数是**加**出来的证据，不是**改**掉的判定。
 *
 * 无 mock：`parseTierCaseCounts` 是纯函数，喂真形状的 `test203.run/v1` 载荷。
 */
import { describe, expect, it } from 'vitest';
import { parseTierCaseCounts, TierGateResult, unknownTierCaseCounts } from '../release-common';
import { isEmptyTierRun } from '../release-tag';

/** 只造 gate 的 raw.stdout —— 被测函数只读这一处。 */
const gateWith = (stdout: string): TierGateResult => ({
  exitCode: 0,
  envBlocked: false,
  regressions: [],
  raw: { status: 0, signal: null, stdout, stderr: '' },
});

const payload = (tiers: unknown[]) => JSON.stringify({ schema: 'test203.run/v1', tiers });

describe('parseTierCaseCounts — 计数是正证据', () => {
  it('空跑（passed+failed 合计 0）→ 如实报 0（不是 unknown），emptyRun 仍为 true', () => {
    const gate = gateWith(payload([{ tier: 'TD', passed: 0, failed: 0, skipped: 1 }]));
    const c = parseTierCaseCounts(gate);

    expect(c.parsed).toBe(true);
    expect(c.passed).toBe(0);
    expect(c.failed).toBe(0);
    expect(c.total).toBe(0);
    expect(c.perTier).toEqual([{ tier: 'TD', passed: 0, failed: 0 }]);
    // 计数为 0 与 emptyRun 判定必须同时成立 —— 空门仍然被拦。
    expect(isEmptyTierRun(gate)).toBe(true);
  });

  it('非 0（多层混合）→ 如实报每层的数与合计，emptyRun 为 false', () => {
    const gate = gateWith(
      payload([
        { tier: 'T0', passed: 12, failed: 0 },
        { tier: 'T1', passed: 3, failed: 2 },
        { tier: 'TD', passed: 0, failed: 0 },
      ]),
    );
    const c = parseTierCaseCounts(gate);

    expect(c.parsed).toBe(true);
    expect(c.passed).toBe(15);
    expect(c.failed).toBe(2);
    expect(c.total).toBe(17);
    expect(c.perTier).toEqual([
      { tier: 'T0', passed: 12, failed: 0 },
      { tier: 'T1', passed: 3, failed: 2 },
      { tier: 'TD', passed: 0, failed: 0 },
    ]);
    expect(isEmptyTierRun(gate)).toBe(false);
  });

  it('⚠️ unknown ≠ 0：stdout 不是 JSON / 没有 tiers → 全 null，parsed=false', () => {
    for (const stdout of ['', 'not json', JSON.stringify({ schema: 'test203.run/v1' })]) {
      const c = parseTierCaseCounts(gateWith(stdout));
      expect(c).toEqual(unknownTierCaseCounts());
      expect(c.passed).toBeNull(); // 不是 0
      expect(c.failed).toBeNull();
      expect(c.total).toBeNull();
      expect(c.parsed).toBe(false);
    }
  });

  it('⚠️ unknown ≠ 0：tier 条目里没有 passed/failed 字段 → null，但 emptyRun 仍 fail-closed 判 true', () => {
    const gate = gateWith(payload([{ tier: 'TD', skipped: 3 }]));
    const c = parseTierCaseCounts(gate);

    expect(c.parsed).toBe(true); // 载荷是读到了的
    expect(c.perTier).toEqual([{ tier: 'TD', passed: null, failed: null }]);
    expect(c.passed).toBeNull(); // 报 unknown，不冒充 0
    expect(c.total).toBeNull();
    // 但判定不许因此放松：下沉前这条就是 true（`?? 0` 求和），下沉后必须还是 true。
    expect(isEmptyTierRun(gate)).toBe(true);
  });

  it('部分层缺字段：已知的照加，缺的按 0 参与合计（合计不是 unknown，因为至少一层报了数）', () => {
    const c = parseTierCaseCounts(gateWith(payload([{ tier: 'TD' }, { tier: 'T0', passed: 4, failed: 1 }])));
    expect(c.perTier).toEqual([
      { tier: 'TD', passed: null, failed: null },
      { tier: 'T0', passed: 4, failed: 1 },
    ]);
    expect(c.passed).toBe(4);
    expect(c.failed).toBe(1);
    expect(c.total).toBe(5);
  });

  it('非数值 passed/failed（字符串/NaN/null）→ null，不静默转成数', () => {
    const c = parseTierCaseCounts(gateWith(payload([{ tier: 'T0', passed: '7', failed: null }])));
    expect(c.perTier).toEqual([{ tier: 'T0', passed: null, failed: null }]);
    expect(c.total).toBeNull();
  });
});

describe('isEmptyTierRun — 下沉到 parseTierCaseCounts 后逐例等价（回归锁）', () => {
  // 这 6 条与 release-preflight.test.ts 里 isEmptyTierRun 的既有用例同形，
  // 用来证明「加计数」没有顺手改判定。
  const cases: Array<[string, string, boolean]> = [
    ['所有 tier passed+failed 合计 0 → true', payload([{ tier: 'TD', passed: 0, failed: 0, skipped: 1 }]), true],
    ['有 passed>0 → false', payload([{ tier: 'T0', passed: 5, failed: 0 }]), false],
    ['有 failed>0 → false（红也是真跑过）', payload([{ tier: 'T0', passed: 0, failed: 2 }]), false],
    [
      '多 tier 混合，总和 > 0 → false',
      payload([
        { tier: 'TD', passed: 0, failed: 0 },
        { tier: 'T0', passed: 3, failed: 0 },
      ]),
      false,
    ],
    ['stdout 解析不了 → false（交给 payload fail-closed 分支兜底）', 'not json', false],
    ['tiers 缺失 → false', JSON.stringify({ schema: 'test203.run/v1' }), false],
    ['tiers 空数组 → false', payload([]), false],
  ];
  for (const [name, stdout, expected] of cases) {
    it(name, () => expect(isEmptyTierRun(gateWith(stdout))).toBe(expected));
  }
});
