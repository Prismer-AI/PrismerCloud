/**
 * test-run.test.ts — `apc test` 的真验证（apc/11 §1 铁律 1：**触外部命令的必须对真命令验**）。
 *
 * 这里**没有一处 mock**：每条用例都真起 `npx tsx sdk/apc/bin/apc.ts test …` 子进程，
 * 让它真去跑 `scripts/test203/run.ts`。oracle 只取副作用——**退出码** 与 **stdout 产物**
 * （`--json` 的 `test203.run/v1` 结构 / `--list` 枚举出的真实文件名）。零文案断言。
 *
 * 承重的是"透传"三件事：退出码（含 78 与 2）、stdout 字节、参数。注入一个恒返 0 的
 * spawn 去测这层等于什么都没测（14 D2/D3 的形态），所以一条都不注入。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const APC = 'sdk/apc/bin/apc.ts';
const TIMEOUT = 600_000;

function apc(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', APC, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let root: string;
let greenDoctor: string;
let redDoctor: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'apc-test-cli-'));
  for (const d of ['contract', 'cookbook', 'journeys', 'probes', 'td']) mkdirSync(join(root, d), { recursive: true });
  const doctor = (name: string, cloud: string) => {
    const p = join(root, name);
    writeFileSync(
      p,
      `process.stdout.write(JSON.stringify({ items: [
  { item: 'infra.mysql-3307', status: 'pass' },
  { item: 'infra.redis-6380', status: 'pass' },
  { item: 'infra.cloud-3000', status: '${cloud}' },
] }));\n`,
    );
    return p;
  };
  greenDoctor = doctor('doctor-green.ts', 'pass');
  redDoctor = doctor('doctor-red.ts', 'fail');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('apc test — 对真 run.ts 的包装层', () => {
  it('--list 透传：枚举的是真仓库里的真 journey 文件，exit 0', () => {
    const realJourneys = readdirSync(join(REPO_ROOT, 'scripts/test203/journeys')).filter((f) => f.endsWith('.ts'));
    expect(realJourneys.length).toBeGreaterThan(0);

    const r = apc(['test', '--tier=T4', '--list']);
    expect(r.status).toBe(0);
    for (const f of realJourneys) expect(r.stdout).toContain(`scripts/test203/journeys/${f}`);
  }, TIMEOUT);

  it('用法错退出码透传：未知 tier → exit 2（不是 0、也不是 1）', () => {
    expect(apc(['test', '--tier=NOPE']).status).toBe(2);
  }, TIMEOUT);

  it('真跑最小自测 tier：exit 0 且 stdout 只有 test203.run/v1 JSON', () => {
    const td = join(root, 'td');
    rmSync(td, { recursive: true, force: true });
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, 'apc-cli-green.ts'), 'process.exit(0);\n');

    const r = apc(['test', '--tier=TD', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: greenDoctor,
    });
    const j = JSON.parse(r.stdout) as {
      schema: string;
      envStatus: string;
      exitCode: number;
      doctor: { source: string; checks: unknown[] };
      tiers: { tier: string; passed: number; failed: number; total: number; envStatus: string }[];
    };
    expect(r.stdout.trimStart()).toMatch(/^\{/);
    expect(r.stdout).not.toContain('[Nacos]');
    expect(j.schema).toBe('test203.run/v1');
    expect(j.doctor.source).toBe(greenDoctor);
    expect(j.tiers.map((t) => t.tier)).toEqual(['TD']);
    expect(j.tiers[0]!.failed).toBe(0);
    expect(j.exitCode).toBe(0);
    expect(r.status).toBe(0); // 与 JSON 里的 exitCode 一致 —— 包装层没有二次加工
  }, TIMEOUT);

  it('78 透传：env_blocked 不许被折成 1（S7 靠它区分环境红/代码红）', () => {
    const blocked = apc(['test', '--tier=T4', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: redDoctor,
    });
    expect(blocked.status).toBe(78);
    expect((JSON.parse(blocked.stdout) as { envStatus: string }).envStatus).toBe('env_blocked');

    // 负控：同一条命令、只翻绿 doctor 的 cloud 项 → 必须回 0（证明 78 不是恒定值）
    const ok = apc(['test', '--tier=T4', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: greenDoctor,
    });
    expect(ok.status).toBe(0);
    expect((JSON.parse(ok.stdout) as { envStatus: string }).envStatus).toBe('ok');
  }, TIMEOUT);

  it('SUT 红透传：run.ts 报 1 时包装层也必须是 1', () => {
    const td = join(root, 'td');
    rmSync(td, { recursive: true, force: true });
    mkdirSync(td, { recursive: true });
    writeFileSync(join(td, 'apc-cli-red.ts'), 'process.exit(1);\n');
    const red = apc(['test', '--tier=TD', '--json'], {
      TEST203_SELFTEST_ROOT: root,
      TEST203_DOCTOR_SCRIPT: greenDoctor,
    });
    expect(red.status).toBe(1);
    const j = JSON.parse(red.stdout) as { tiers: { failedNames: string[] }[] };
    expect(j.tiers[0]!.failedNames.map((n) => n.split(' ')[0])).toEqual(['apc-cli-red.ts']);

    // 负控：同一个 tier、把用例换成 exit 0 → 必须回 0
    writeFileSync(join(td, 'apc-cli-red.ts'), 'process.exit(0);\n');
    expect(
      apc(['test', '--tier=TD', '--json'], { TEST203_SELFTEST_ROOT: root, TEST203_DOCTOR_SCRIPT: greenDoctor }).status,
    ).toBe(0);
  }, TIMEOUT);
});
