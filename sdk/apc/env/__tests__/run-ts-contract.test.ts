/**
 * run-ts-contract.test.ts — **真接线验收**：doctor 的输出必须能被既有消费者
 * `scripts/test203/run.ts` 吃下去。
 *
 * 为什么这条是承重的：run.ts:175 已经把 `sdk/apc/env/doctor.ts` 写进
 * `EXTERNAL_DOCTOR_CANDIDATES`，跑法是 `spawnSync('npx',['tsx',path])` → `parseExternalDoctor(stdout)`。
 * **解析不出东西它会静默回退到内置 StageG 4 项检查**，而 doctor 这边看起来"还是绿的"——
 * 那正是本专项要杜绝的假验证形态（apc/11 §1）。
 *
 * 所以本文件**不自己实现一份解析器**，而是 import run.ts 的真 `parseExternalDoctor`
 * （run.ts 末尾有 `import.meta.url` 守卫，import 不会触发 main()），喂**真跑一次 doctor
 * 的真 stdout**。负控在文末：把输出改成不合契约的形状 → 该断言必须变红。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExternalDoctor } from '../../../../scripts/test203/run';
import { doctor } from '../doctor';
import { ENV_MANIFEST } from '../manifest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** run.ts:234 `TIER_ENV_REQUIRES` 里 T3/T4 依赖的关键字（子串匹配）。 */
const TIER_KEYWORDS = ['mysql', 'redis', 'cloud'];

describe('doctor ⇄ scripts/test203/run.ts 解析契约', () => {
  it('真跑 doctor 子进程：stdout 是纯 JSON（无任何日志污染）', () => {
    const r = spawnSync('npx', ['tsx', 'sdk/apc/env/doctor.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(r.error).toBeUndefined();
    // 退出码可能是 78（env_blocked）——那是环境事实，不是契约违规。
    expect([0, 78]).toContain(r.status);
    const parsedJson = JSON.parse(r.stdout!); // 有任何一行非 JSON 输出，这里就抛
    expect(Array.isArray(parsedJson.items)).toBe(true);

    // 真消费者解析：必须解析出非空 checks（解析不出 = run.ts 会静默降级）。
    const checks = parseExternalDoctor(r.stdout!);
    expect(checks).not.toBeNull();
    expect(checks!.length).toBeGreaterThan(0);
  }, 300_000);

  it('item id 覆盖 run.ts 的 tier 关键字（mysql / redis / cloud），否则整层恒 env_blocked', async () => {
    const report = await doctor({ items: ENV_MANIFEST.filter((i) => i.section === 'infra') });
    const checks = parseExternalDoctor(JSON.stringify(report));
    expect(checks).not.toBeNull();
    for (const kw of TIER_KEYWORDS) {
      const hits = checks!.filter((c) => c.name.toLowerCase().includes(kw));
      expect(hits.length, `run.ts 的 T3/T4 按子串 '${kw}' 找检查项，doctor 必须有至少一项命中`).toBeGreaterThan(0);
    }
  }, 300_000);

  it('pass/fail 语义被真解析器还原（不是"能解析"就算数）', () => {
    const shaped = {
      items: [
        { item: 'infra.mysql-3307', label: 'x', status: 'pass' },
        { item: 'infra.redis-6380', label: 'y', status: 'fail' },
      ],
    };
    const checks = parseExternalDoctor(JSON.stringify(shaped))!;
    expect(checks.find((c) => c.name.includes('mysql'))!.ok).toBe(true);
    expect(checks.find((c) => c.name.includes('redis'))!.ok).toBe(false);
  });

  it('负控：不合契约的形状 → 真解析器返回 null（run.ts 会降级，所以这必须是可检出的）', () => {
    // ① 状态字段用了契约外的值
    expect(parseExternalDoctor(JSON.stringify({ items: [{ item: 'a', status: 'green' }] }))).toBeNull();
    // ② 顶层用了 run.ts 不认的容器 key
    expect(parseExternalDoctor(JSON.stringify({ results: [{ item: 'a', status: 'pass' }] }))).toBeNull();
    // ③ stdout 前面混进一行日志 → JSON.parse 直接失败
    expect(parseExternalDoctor('[apc] starting…\n{"items":[{"item":"a","status":"pass"}]}')).toBeNull();
  });

  it('负控：skip 项会被真解析器丢弃 —— 「未检测」不许被读成 pass', () => {
    const checks = parseExternalDoctor(
      JSON.stringify({ items: [{ item: 'infra.mysql-3307', status: 'skip' }, { item: 'infra.redis-6380', status: 'pass' }] }),
    );
    expect(checks!.map((c) => c.name)).toEqual(['infra.redis-6380']);
  });
});
