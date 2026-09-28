/**
 * release-db-config-sync.test.ts — 真验证（铁律 1 明列：**必须真调 sync-test-migrations.ts
 * --dry-run 看真输出**，禁注入返 0 的桩）。
 *
 * 核心 e2e 对 REAL `scripts/ops/sync-test-migrations.ts` 跑：本机替身把 REMOTE_MYSQL_* 指向本地
 * replica（127.0.0.1:3307，站位远端 test RDS）+ APP_ENV=local 跳过真 Nacos。真脚本枚举
 * src/im/sql/*.sql ⇄ 目标库 _migrations 账本，产出真实迁移计划。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideDbConfigSync,
  diffKeys,
  extractEnvKeys,
  parseMigrationPlan,
  runKeyDiff,
} from '../release-db-config-sync';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const APC = 'sdk/apc/bin/apc.ts';
const TIMEOUT = 180_000;

/** 指向本地 replica 的真实凭证；dry-run 必须真连库，但绝不能写库。 */
const REPLICA_CREDS = {
  REMOTE_MYSQL_HOST: '127.0.0.1',
  REMOTE_MYSQL_PORT: '3307',
  REMOTE_MYSQL_USER: 'prismer',
  REMOTE_MYSQL_PASSWORD: 'devpass',
  REMOTE_MYSQL_DATABASE: 'prismer_cloud',
};

function migrationLedgerExists(): boolean {
  const result = spawnSync(
    'mysql',
    [
      '--host=127.0.0.1',
      '--port=3307',
      '--user=prismer',
      '--password=devpass',
      '--protocol=TCP',
      '--batch',
      'prismer_cloud',
      '-e',
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='prismer_cloud' AND table_name='_migrations'",
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: TIMEOUT },
  );
  if (result.status !== 0) throw new Error(`local migration ledger probe failed: ${result.stderr}`);
  return result.stdout.trim().split('\n').at(-1) === '1';
}

function apc(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', APC, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('apc release db-config-sync — 真调 sync-test-migrations.ts --dry-run（铁律 1）', () => {
  it('真脚本连上本地 DB、产出真实计划，并保持 dry-run 零写入', () => {
    const realSql = readdirSync(join(REPO_ROOT, 'src/im/sql')).filter((f) => /^\d+.*\.sql$/.test(f));
    expect(realSql.length).toBeGreaterThan(50); // 真仓库有近 200 个迁移

    const ledgerExistedBefore = migrationLedgerExists();
    const r = apc(['release', 'db-config-sync', '--json'], REPLICA_CREDS);
    const j = JSON.parse(r.stdout);
    expect(r.status).toBeOneOf([0, 3]);
    expect(j.migration.exitCode).toBe(0);
    if (!ledgerExistedBefore) {
      expect(j.migration.pending).toHaveLength(realSql.length);
    }
    for (const f of j.migration.pending) expect(realSql).toContain(f);
    expect(j.migration.stderr).not.toMatch(/access denied|mysql error|could not read/i);
    expect(j.decision).toBe(j.migration.pending.length > 0 ? 'staged' : 'green');
    expect(migrationLedgerExists()).toBe(ledgerExistedBefore);
  }, TIMEOUT);

  it('负控：错误数据库凭证必须 blocked，不能把空 ledger 冒充 zero pending', () => {
    const r = apc(['release', 'db-config-sync', '--json'], {
      ...REPLICA_CREDS,
      REMOTE_MYSQL_PASSWORD: 'definitely-wrong',
    });
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.migration.exitCode).toBe(1);
    expect(j.blockers.join()).toMatch(/迁移 dry-run 真脚本 exit 1/);
  }, TIMEOUT);

  it('负控：抽掉 REMOTE_MYSQL 凭证 → 真脚本 throw exit 1 → verb blocked（不许骗绿）', () => {
    const r = apc(['release', 'db-config-sync', '--json'], {
      REMOTE_MYSQL_HOST: '',
      REMOTE_MYSQL_USER: '',
      REMOTE_MYSQL_PASSWORD: '',
      REMOTE_MYSQL_DATABASE: '',
    });
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.migration.exitCode).toBe(1);
    expect(j.blockers.join()).toMatch(/迁移 dry-run 真脚本 exit 1/);
  }, TIMEOUT);
});

describe('parseMigrationPlan — 真脚本 stdout 形状解析', () => {
  it('解析真脚本当前的 Would apply 块', () => {
    const stdout = [
      'DB: h:3307/db',
      '✓ _migrations table ready',
      'Applied: 0 files',
      'Pending: 2 files',
      '',
      '  100_a.sql ...',
      '    (skipped — dry run)',
      'Would apply (2):',
      '  - 100_a.sql',
      '  - 101_b.sql',
    ].join('\n');
    expect(parseMigrationPlan(stdout)).toEqual(['100_a.sql', '101_b.sql']);
  });

  it('No pending migrations. → 空', () => {
    expect(parseMigrationPlan('...\nNo pending migrations.\n')).toEqual([]);
  });
});

describe('diffKeys / runKeyDiff — 真集合差 + import SUT', () => {
  it('extractEnvKeys 抽 .env 形态 key', () => {
    expect([...extractEnvKeys('A=1\n# c\nB_C=2\nnot a key\n')].sort()).toEqual(['A', 'B_C']);
  });

  it('missing/extra 正确', () => {
    const d = diffKeys(new Set(['A', 'B', 'C']), new Set(['B', 'C', 'D']));
    expect(d.missing).toEqual(['A']); // ref 有 cur 无
    expect(d.extra).toEqual(['D']); // cur 有 ref 无
    expect(d.common).toBe(2);
  });

  it('runKeyDiff 对真 fixture 文件算差', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apc-keys-'));
    try {
      writeFileSync(join(dir, 'ref.env'), 'KEK=x\nDISPATCH_DAEMON_SECRET=y\nJWT_SECRET=z\n');
      writeFileSync(join(dir, 'cur.env'), 'JWT_SECRET=z\n');
      const r = runKeyDiff(join(dir, 'ref.env'), join(dir, 'cur.env'));
      expect(r.status).toBe('computed');
      if (r.status === 'computed') expect(r.missing).toEqual(['DISPATCH_DAEMON_SECRET', 'KEK']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未给文件 → skipped（诚实 ⬜，不冒充已验）', () => {
    const r = runKeyDiff(undefined, undefined);
    expect(r.status).toBe('skipped');
  });
});

describe('decideDbConfigSync — 判定 + 变异靶', () => {
  const noKeyDiff = { status: 'skipped', reason: 'x' } as const;

  it('脚本失败 → blocked', () => {
    expect(decideDbConfigSync({ exitCode: 1, pending: [], stderr: '' }, noKeyDiff).decision).toBe('blocked');
  });
  it('有 pending → staged', () => {
    expect(decideDbConfigSync({ exitCode: 0, pending: ['x.sql'], stderr: '' }, noKeyDiff).decision).toBe('staged');
  });
  it('缺 key → staged', () => {
    const d = decideDbConfigSync({ exitCode: 0, pending: [], stderr: '' }, { status: 'computed', missing: ['KEK'], extra: [], common: 1 });
    expect(d.decision).toBe('staged');
  });
  it('零差异 → green', () => {
    expect(decideDbConfigSync({ exitCode: 0, pending: [], stderr: '' }, { status: 'computed', missing: [], extra: [], common: 3 }).decision).toBe('green');
  });
});
