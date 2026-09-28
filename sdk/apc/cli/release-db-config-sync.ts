/**
 * release-db-config-sync.ts — `apc release db-config-sync`（apc/01 §2 db-config-sync，收口步 3/4）。
 *
 * ## 治 R3（apc/11 §0 病灶表）
 * 旧实现调 30 行硬编码 stub（恒 exit 0，`writes:0` 换马甲）。本实现**调真**
 * `scripts/ops/sync-test-migrations.ts --dry-run`——真解析凭证、真连库、真算迁移计划，
 * 退出码/计划由真脚本决定。绝不注入桩。
 *
 * ## 两个子能力
 * 1. **迁移 dry-run**：spawn 真 `sync-test-migrations.ts --dry-run`。本机替身口径下把
 *    `REMOTE_MYSQL_*` 指向**本地 replica**（127.0.0.1:3307，站位远端 test RDS）+ `APP_ENV=local`
 *    跳过真 Nacos（`nacos-config.ts:506` C-6 短路）。真脚本枚举 `src/im/sql/*.sql` ⇄ 目标库
 *    `_migrations` 账本，产出**真实迁移计划**。dry-run 永不写库（04 §4.5 dry-run 边界）。
 *    - 缺 `REMOTE_MYSQL_*` → 真脚本 `throw` → exit 1 → 本 verb blocked（这是负控注入点）。
 * 2. **Nacos key-diff**：纯函数 `diffKeys` 对两份 key dump 算差集（真算法）。本机替身下比对
 *    `dump-nacos-namespace.ts` 产出的本地 dump 文件（`--ref`/`--cur`）；**不写真 Nacos**。
 *    未给文件 → key-diff 诚实标 skipped（⬜，真 Nacos fetch = M5），不冒充已验。
 *
 * decision：真脚本失败 → blocked(1)；有 pending 迁移 / key 差集 → staged(3，待审批+M5 apply)；
 * 零差异 → green(0)。**退出码反映真实差异**（04 §4.5）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { Decision, decisionExit, emit, EXIT_BLOCKED, REPO_ROOT, runTsx } from './release-common';

export const SYNC_SCRIPT = 'scripts/ops/sync-test-migrations.ts';

// ── 迁移 dry-run ────────────────────────────────────────────────────────────

export interface MigrationPlan {
  /** 真脚本退出码。 */
  exitCode: number;
  /** dry-run 列出的 pending 迁移文件名（真脚本从 fs 枚举 ⇄ 账本比对得出）。 */
  pending: string[];
  /** 真脚本 stderr（连库失败等），供诊断。 */
  stderr: string;
}

/** 从真脚本 stdout 解析 dry-run 的 `Would apply (N):` 块 / `No pending migrations.`。 */
export function parseMigrationPlan(stdout: string): string[] {
  if (/No pending migrations\./.test(stdout)) return [];
  const pending: string[] = [];
  let inBlock = false;
  for (const line of stdout.split('\n')) {
    if (/^(?:Would apply|Pending) \(\d+\):/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const m = line.match(/^\s+-\s+(.+\.sql)\s*$/);
      if (m) pending.push(m[1].trim());
      else if (line.trim().length > 0 && !/^\s+-/.test(line)) break;
    }
  }
  return pending;
}

/**
 * 本机替身的 replica 连接参数（站位远端 test RDS）。从 env 读，host/port 兜底本地 docker MySQL。
 * `APP_ENV=local` 保证真脚本跳过 Nacos（不打远端），凭证仍由这里注入。
 */
export function replicaEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    APP_ENV: 'local',
    REMOTE_MYSQL_HOST: base.REMOTE_MYSQL_HOST ?? '127.0.0.1',
    REMOTE_MYSQL_PORT: base.REMOTE_MYSQL_PORT ?? '3307',
    REMOTE_MYSQL_USER: base.REMOTE_MYSQL_USER ?? '',
    REMOTE_MYSQL_PASSWORD: base.REMOTE_MYSQL_PASSWORD ?? '',
    REMOTE_MYSQL_DATABASE: base.REMOTE_MYSQL_DATABASE ?? '',
  };
}

export function runMigrationDryRun(env: NodeJS.ProcessEnv = process.env): MigrationPlan {
  const r = runTsx(SYNC_SCRIPT, ['--dry-run'], { env: replicaEnv(env), timeout: 120_000 });
  const exitCode = r.status ?? EXIT_BLOCKED;
  return {
    exitCode,
    pending: exitCode === 0 ? parseMigrationPlan(r.stdout) : [],
    stderr: r.stderr,
  };
}

// ── Nacos key-diff ──────────────────────────────────────────────────────────

/** 从一份 Nacos dump（.env 形态）抽出 key 集合。dump-nacos-namespace.ts 的产物形态。 */
export function extractEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.add(key);
  }
  return keys;
}

export interface KeyDiff {
  /** ref 有、cur 无 —— 目标环境缺的 key（需补齐）。 */
  missing: string[];
  /** cur 有、ref 无 —— 目标环境多的 key。 */
  extra: string[];
  common: number;
}

/** 纯集合差：ref（期望/基准）vs cur（目标现状）。 */
export function diffKeys(ref: Set<string>, cur: Set<string>): KeyDiff {
  const missing = [...ref].filter((k) => !cur.has(k)).sort();
  const extra = [...cur].filter((k) => !ref.has(k)).sort();
  const common = [...ref].filter((k) => cur.has(k)).length;
  return { missing, extra, common };
}

export type KeyDiffResult =
  | { status: 'skipped'; reason: string }
  | ({ status: 'computed' } & KeyDiff);

export function runKeyDiff(refPath?: string, curPath?: string): KeyDiffResult {
  if (!refPath || !curPath) {
    return {
      status: 'skipped',
      reason: '本机替身：未提供 --ref/--cur dump 文件；真 Nacos fetch = M5（04 §4.5）',
    };
  }
  for (const p of [refPath, curPath]) {
    if (!existsSync(p)) return { status: 'skipped', reason: `dump 文件不存在: ${p}` };
  }
  const ref = extractEnvKeys(readFileSync(refPath, 'utf8'));
  const cur = extractEnvKeys(readFileSync(curPath, 'utf8'));
  return { status: 'computed', ...diffKeys(ref, cur) };
}

// ── decision ────────────────────────────────────────────────────────────────

export interface DbConfigSyncReport {
  verb: 'db-config-sync';
  decision: Decision;
  migration: MigrationPlan;
  keyDiff: KeyDiffResult;
  blockers: string[];
  staged: string[];
}

export function decideDbConfigSync(migration: MigrationPlan, keyDiff: KeyDiffResult): {
  decision: Decision;
  blockers: string[];
  staged: string[];
} {
  const blockers: string[] = [];
  const staged: string[] = [];

  if (migration.exitCode !== 0) {
    blockers.push(
      `迁移 dry-run 真脚本 exit ${migration.exitCode}：${migration.stderr.trim().slice(0, 200) || '(见脚本输出)'}`,
    );
  } else if (migration.pending.length > 0) {
    staged.push(`${migration.pending.length} 条 pending 迁移待同步（审批后 M5 apply）：${migration.pending.join(', ')}`);
  }

  if (keyDiff.status === 'computed') {
    if (keyDiff.missing.length > 0) staged.push(`目标环境缺 ${keyDiff.missing.length} 个 Nacos key：${keyDiff.missing.join(', ')}`);
    // extra key 不阻塞发版，仅报告
  }

  const decision: Decision = blockers.length > 0 ? 'blocked' : staged.length > 0 ? 'staged' : 'green';
  return { decision, blockers, staged };
}

const USAGE = `apc release db-config-sync [--ref <nacos-dump>] [--cur <nacos-dump>] [--json]

远端 DB 迁移 + Nacos 配置差异检查（apc/01 §2，治 R3）。
迁移：真跑 ${SYNC_SCRIPT} --dry-run（本机替身指向本地 replica，永不写远端）。
key-diff：对两份 dump-nacos-namespace 产物算差集（真 Nacos = M5）。
  exit 0 green（无差异）· 3 staged（有 pending/缺 key）· 1 blocked（真脚本失败/缺凭证）
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = argv.includes('--json');
  const ref = argFor(argv, '--ref');
  const cur = argFor(argv, '--cur');

  const migration = runMigrationDryRun();
  const keyDiff = runKeyDiff(ref, cur);
  const { decision, blockers, staged } = decideDbConfigSync(migration, keyDiff);

  const report: DbConfigSyncReport = { verb: 'db-config-sync', decision, migration, keyDiff, blockers, staged };

  await emit(
    json,
    [
      `[db-config-sync] decision=${decision}  (repo=${REPO_ROOT.split('/').slice(-1)[0]})`,
      `  migration: exit=${migration.exitCode} pending=${migration.pending.length}`,
      `  key-diff: ${keyDiff.status === 'computed' ? `missing=${keyDiff.missing.length} extra=${keyDiff.extra.length}` : `skipped (${keyDiff.reason})`}`,
      ...blockers.map((b) => `  ✗ blocker: ${b}`),
      ...staged.map((s) => `  · staged: ${s}`),
    ].join('\n'),
    report as unknown as Record<string, unknown>,
  );

  return decisionExit(decision);
}

function argFor(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
