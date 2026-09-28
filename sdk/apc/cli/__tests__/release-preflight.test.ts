/**
 * release-preflight.test.ts — 真验证（无 mock）。
 *
 * 三层证据：
 *  A. 纯判定 `decidePreflight`（含变异靶点）；
 *  B. 真文件检查 `checkVersionAlignment` / `checkPrismaRegen`（对真 fixture 文件读，非硬编码）；
 *  C. 真 e2e：`apc release preflight` 经真 run.ts 跑 tier 门，读**真退出码**（铁律 1）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPrismaRegen, checkVersionAlignment, runTierGate, TierGateResult } from '../release-common';
import { decidePreflight, isEmptyTierRun } from '../release-preflight';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const APC = 'sdk/apc/bin/apc.ts';
const TIMEOUT = 300_000;

function apc(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', APC, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('decidePreflight — 纯判定 + 变异靶', () => {
  const green = { exitCode: 0, envBlocked: false, regressions: [] as string[] };
  const alignedVersion = { aligned: true, rootVersion: '1.0.0', mismatches: [] };
  const prismaOk = { ok: true, stale: [] };

  it('三项全绿 → green', () => {
    expect(decidePreflight(green, alignedVersion as any, prismaOk as any).decision).toBe('green');
  });

  it('tier SUT 红 → blocked（不是 staged，不许被降级放行）', () => {
    const d = decidePreflight({ exitCode: 1, envBlocked: false, regressions: ['x.ts'] }, alignedVersion as any, prismaOk as any);
    expect(d.decision).toBe('blocked');
    expect(d.blockers.join()).toContain('x.ts');
  });

  it('env_blocked → blocked（环境故障域也拦，不当绿）', () => {
    expect(decidePreflight({ exitCode: 78, envBlocked: true, regressions: [] }, alignedVersion as any, prismaOk as any).decision).toBe('blocked');
  });

  it('版本失配 → staged（可修前置）', () => {
    const d = decidePreflight(green, { aligned: false, rootVersion: '1.0.0', mismatches: [{ file: 'package.json', found: '0.9.0' }] } as any, prismaOk as any);
    expect(d.decision).toBe('staged');
    expect(d.staged.join()).toContain('package.json=0.9.0');
  });

  it('prisma drift → staged', () => {
    const d = decidePreflight(green, alignedVersion as any, { ok: false, stale: [{ schema: 'prisma/schema.mysql.prisma', reason: 'schema-drift' }] } as any);
    expect(d.decision).toBe('staged');
    expect(d.staged.join()).toContain('schema-drift');
  });

  it('blocker 与 staged 并存 → blocker 优先（tier 红压过 staged）', () => {
    const d = decidePreflight({ exitCode: 1, envBlocked: false, regressions: ['x'] }, { aligned: false, rootVersion: '1', mismatches: [{ file: 'package.json', found: null }] } as any, prismaOk as any);
    expect(d.decision).toBe('blocked');
  });

  // ── apc/12 §0.12 修法 B：tier 空跑（0 用例真实执行）不算绿证据 ──────────
  it('tier emptyRun=true（即便 exitCode=0）→ blocked，不许把「没跑」读成「绿」', () => {
    const d = decidePreflight(
      { exitCode: 0, envBlocked: false, regressions: [], emptyRun: true },
      alignedVersion as any,
      prismaOk as any,
    );
    expect(d.decision).toBe('blocked');
    expect(d.blockers.some((b) => b.includes('空跑'))).toBe(true);
  });

  it('emptyRun 与 envBlocked 不混：envBlocked 优先，走它自己的分支', () => {
    const d = decidePreflight(
      { exitCode: 78, envBlocked: true, regressions: [], emptyRun: true },
      alignedVersion as any,
      prismaOk as any,
    );
    expect(d.decision).toBe('blocked');
    expect(d.blockers.some((b) => b.includes('env_blocked'))).toBe(true);
    expect(d.blockers.some((b) => b.includes('空跑'))).toBe(false);
  });

  it('emptyRun=false + exitCode=0 → 不因空跑判据被误伤（正控）', () => {
    const d = decidePreflight(
      { exitCode: 0, envBlocked: false, regressions: [], emptyRun: false },
      alignedVersion as any,
      prismaOk as any,
    );
    expect(d.decision).toBe('green');
  });
});

describe('isEmptyTierRun — 纯判定（release-preflight 本地副本）', () => {
  const gateWith = (stdout: string): TierGateResult => ({
    exitCode: 0,
    envBlocked: false,
    regressions: [],
    raw: { status: 0, signal: null, stdout, stderr: '' },
  });

  it('所有 tier passed+failed 合计为 0 → true（空跑）', () => {
    const stdout = JSON.stringify({ schema: 'test203.run/v1', tiers: [{ tier: 'TD', passed: 0, failed: 0, skipped: 1 }] });
    expect(isEmptyTierRun(gateWith(stdout))).toBe(true);
  });

  it('有 passed>0 → false（真跑过，即便全过）', () => {
    const stdout = JSON.stringify({ schema: 'test203.run/v1', tiers: [{ tier: 'T0', passed: 5, failed: 0 }] });
    expect(isEmptyTierRun(gateWith(stdout))).toBe(false);
  });

  it('有 failed>0 → false（红也是真跑过，不是空跑）', () => {
    const stdout = JSON.stringify({ schema: 'test203.run/v1', tiers: [{ tier: 'T0', passed: 0, failed: 2 }] });
    expect(isEmptyTierRun(gateWith(stdout))).toBe(false);
  });

  it('多 tier 混合，只要总和 > 0 → false', () => {
    const stdout = JSON.stringify({
      schema: 'test203.run/v1',
      tiers: [
        { tier: 'TD', passed: 0, failed: 0 },
        { tier: 'T0', passed: 3, failed: 0 },
      ],
    });
    expect(isEmptyTierRun(gateWith(stdout))).toBe(false);
  });

  it('stdout 解析不了 / tiers 缺失 → false（不掺和，交给 payload fail-closed 分支兜底）', () => {
    expect(isEmptyTierRun(gateWith('not json'))).toBe(false);
    expect(isEmptyTierRun(gateWith(JSON.stringify({ schema: 'test203.run/v1' })))).toBe(false);
    expect(isEmptyTierRun(gateWith(JSON.stringify({ schema: 'test203.run/v1', tiers: [] })))).toBe(false);
  });
});

describe('checkVersionAlignment — 真文件读', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'apc-ver-'));
    writeFileSync(join(root, 'VERSION'), '3.1.4\n');
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('全对齐 → aligned', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '3.1.4' }));
    writeFileSync(join(root, 'src', 'lib', 'version.ts'), "export const VERSION = '3.1.4';");
    mkdirSync(join(root, 'sdk', 'prismer'), { recursive: true });
    mkdirSync(join(root, 'sdk', 'cloud'), { recursive: true });
    writeFileSync(join(root, 'sdk', 'prismer', 'package.json'), JSON.stringify({ version: '3.1.4' }));
    writeFileSync(join(root, 'sdk', 'cloud', 'package.json'), JSON.stringify({ version: '3.1.4' }));
    const r = checkVersionAlignment(root);
    expect(r.aligned).toBe(true);
    expect(r.rootVersion).toBe('3.1.4');
  });

  it('负控：一个文件版本改掉 → aligned=false 且指名道姓', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    const r = checkVersionAlignment(root);
    expect(r.aligned).toBe(false);
    expect(r.mismatches.some((m) => m.file === 'package.json' && m.found === '0.0.1')).toBe(true);
  });

  it('真仓库当前是对齐的（sanity，非硬编码）', () => {
    expect(checkVersionAlignment(REPO_ROOT).aligned).toBe(true);
  });
});

describe('checkPrismaRegen — 真文件读', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'apc-prisma-'));
    mkdirSync(join(root, 'prisma', 'generated', 'mysql'), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('源 schema 与 generated 拷贝逐字节相等 → ok', () => {
    writeFileSync(join(root, 'prisma', 'schema.mysql.prisma'), 'model A { id Int @id }\n');
    writeFileSync(join(root, 'prisma', 'generated', 'mysql', 'schema.prisma'), 'model A { id Int @id }\n');
    expect(checkPrismaRegen(root).ok).toBe(true);
  });

  it('负控：源 schema 改一个字 → schema-drift', () => {
    writeFileSync(join(root, 'prisma', 'schema.mysql.prisma'), 'model A { id Int @id }\nmodel B { id Int @id }\n');
    const r = checkPrismaRegen(root);
    expect(r.ok).toBe(false);
    expect(r.stale[0]!.reason).toBe('schema-drift');
  });

  it('负控：generated 拷贝缺失 → client-missing', () => {
    rmSync(join(root, 'prisma', 'generated', 'mysql', 'schema.prisma'));
    expect(checkPrismaRegen(root).stale[0]!.reason).toBe('client-missing');
  });
});

describe('apc release preflight — 真 e2e（tier 门经真 run.ts）', () => {
  let root: string;
  let greenDoctor: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'apc-preflight-e2e-'));
    for (const d of ['contract', 'cookbook', 'journeys', 'probes', 'td']) mkdirSync(join(root, d), { recursive: true });
    greenDoctor = join(root, 'doctor-green.ts');
    writeFileSync(greenDoctor, "process.stdout.write(JSON.stringify({ items: [{ item: 'infra.cloud-3000', status: 'pass' }] }));\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('缺少 --tier → usage 错误 exit 2（无默认值，不许悄悄回退 TD——修法 A）', () => {
    const r = apc(['release', 'preflight', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: greenDoctor,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--tier');
  }, TIMEOUT);

  // apc/12 §0.12 修法 B 正证据：TD 层无 spec 时 run.ts 走占位 skip（passed:0/failed:0），
  // 这就是被坐实的空门场景——必须 blocked，不能被读成绿。'td' 目录此刻确实是空的
  // （beforeAll 没写任何 td spec；下面「tier 绿」用例会临时写一个真 spec 再清理）。
  it('空跑：TD 层无 spec（占位 skip，passed:0/failed:0）→ blocked，不构成绿证据（修法 B）', () => {
    const r = apc(['release', 'preflight', '--tier=TD', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: greenDoctor,
    });
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.tier.exitCode).toBe(0); // run.ts 自己觉得"没红" —— 这正是空门的危险之处
    expect(j.tier.emptyRun).toBe(true);
    expect(j.blockers.some((b: string) => b.includes('空跑'))).toBe(true);
  }, TIMEOUT);

  it('tier 绿（真跑过至少一条用例）→ 无 tier blocker，emptyRun=false（真 run.ts exit 0 驱动）', () => {
    writeFileSync(join(root, 'td', 'apc-preflight-green.ts'), 'process.exit(0);\n');
    try {
      const r = apc(['release', 'preflight', '--tier=TD', '--json'], {
        TEST203_SELFTEST_ROOT: root,
        TEST203_DOCTOR_SCRIPT: greenDoctor,
      });
      const j = JSON.parse(r.stdout);
      expect(j.tier.exitCode).toBe(0);
      expect(j.tier.emptyRun).toBe(false);
      // tier 绿 ⇒ blockers 里没有 tier 项（version/prisma 可能因真仓库状态进 staged，但不是 blocker）
      expect(j.blockers.some((b: string) => b.includes('tier'))).toBe(false);
    } finally {
      rmSync(join(root, 'td', 'apc-preflight-green.ts'));
    }
  }, TIMEOUT);

  it('负控：注入一个红 TD 用例 → tier blocker → decision=blocked → exit 1', () => {
    writeFileSync(join(root, 'td', 'apc-preflight-red.ts'), 'process.exit(1);\n');
    const r = apc(['release', 'preflight', '--tier=TD', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: greenDoctor,
    });
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.tier.exitCode).toBe(1);
    expect(j.tier.emptyRun).toBe(false); // 有 1 条真失败 —— 不是空跑，是真红
    expect(j.blockers.join()).toContain('tier gate 红');
    rmSync(join(root, 'td', 'apc-preflight-red.ts'));
  }, TIMEOUT);
});

// ── F-A（apc/12 release-preflight 验收）：tier 门此前 fail-OPEN ────────────
// `runTierGate` 只读退出码，解析失败被空 `catch {}` 吞掉 ⇒「跑器一个字节没吐
// + exit 0」与「全跑完全通过」不可区分，tier 门判绿。而 tier 绿是发版硬前置
// （01 §2：没有 tier 全绿的结构化证据，审批不创建、tag 不 push），一个不要求
// 正证据的前置门就是放行章。
//
// 真触发器：`run.ts:935` 的入口守卫比较 `resolve(argv[1])` 与
// `fileURLToPath(import.meta.url)` —— ESM 侧 realpath、argv 侧不 realpath，
// 路径链上有软链就静默不 main() 并退 0。这里用注入的 runner 直接喂那个形状，
// 因为复现真触发器要造软链仓库，而**守卫本身与触发器常不常见无关**。
describe('runTierGate — 正证据要求（fail-closed）', () => {
  const ok = JSON.stringify({
    schema: 'test203.run/v1',
    envStatus: 'ok',
    regressions: [],
    tiers: [{ tier: 'TD', passed: 1, failed: 0, skipped: 0, total: 1 }],
  });
  const stub = (stdout: string, status: number) => () => ({ status, stdout, stderr: '' }) as never;

  it('exit 0 + 零字节输出 ⇒ blocked（不把沉默读成成功）', () => {
    const r = runTierGate('TD', process.env, stub('', 0));
    expect(r.exitCode).toBe(1);
    expect(r.regressions.join()).toContain('no verifiable `test203.run/v1` payload');
  });

  it('exit 0 + 合法 JSON 但 schema 不对 ⇒ blocked', () => {
    const r = runTierGate('TD', process.env, stub(JSON.stringify({ regressions: [] }), 0));
    expect(r.exitCode).toBe(1);
  });

  it('exit 0 + 正确 schema 但 tiers 为空 ⇒ blocked（声称跑了却一层没跑）', () => {
    const r = runTierGate('TD', process.env, stub(JSON.stringify({ schema: 'test203.run/v1', tiers: [] }), 0));
    expect(r.exitCode).toBe(1);
  });

  it('正控 — exit 0 + 完整载荷 ⇒ 绿（守卫不误伤）', () => {
    const r = runTierGate('TD', process.env, stub(ok, 0));
    expect(r.exitCode).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it('负控不越权 — 非零退出码本就不放行，无须载荷', () => {
    expect(runTierGate('TD', process.env, stub('', 1)).exitCode).toBe(1);
    expect(runTierGate('TD', process.env, stub('', 78)).envBlocked).toBe(true);
  });
});
