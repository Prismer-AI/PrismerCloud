/**
 * release-common.ts — `apc release *` 五 verb 的共享地基（apc/01 §2 收口 · M3-a）。
 *
 * 只放**真副作用工具 + 纯判定函数**，不放任何 tier 知识、不 mock。所有 verb 通过它
 * 调真外部脚本（`scripts/test203/run.ts` / `scripts/ops/sync-test-migrations.ts` /
 * `scripts/ops/runtime-ota.ts`），退出码/输出形状由被调脚本决定，本层只透传 + 判定。
 *
 * ## 退出码语义（五 verb 统一，S9 skill 靠它分流）
 *   0  绿 / 放行 / 无差异（releasable）
 *   1  硬 blocker（tier 红、env_blocked、真脚本失败、prod 人闸、用法错）—— **不许骗绿**
 *   3  staged（有可修前置 / 有待同步差异 / 待审批）—— 非绿但非硬失败
 *
 * ## 本机替身边界（apc/04 §4.5）
 * 远端写入（test RDS / 真 Nacos / GitLab push / 真 fleet rollout）一律止于 dry-run 边界；
 * 真远端路径 = M5。本文件的每个"远端"动作都替换为本地替身（本地 bare mirror / 本地 kind /
 * 本地 ledger），或在替身缺位时**诚实标 blocked 并说明缺什么**，绝不假装验过。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** repo 根（sdk/apc/cli/ → ../../..；形状照 `cli/test-run.ts:29`）。 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export const EXIT_OK = 0;
export const EXIT_BLOCKED = 1;
export const EXIT_STAGED = 3;

export type Decision = 'green' | 'staged' | 'blocked';

/** decision → 退出码。green→0 · staged→3 · blocked→1。 */
export function decisionExit(d: Decision): number {
  return d === 'green' ? EXIT_OK : d === 'staged' ? EXIT_STAGED : EXIT_BLOCKED;
}

export interface SubprocessResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * 跑一个真子进程并**捕获**（非 inherit——verb 要解析被调脚本的输出做判定）。
 * 被信号杀死时 status=null / signal 非空——调用方据此判 blocked（绝不当成 0）。
 */
export function runCaptured(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): SubprocessResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    timeout: opts.timeout ?? 600_000,
  });
  return {
    status: r.status,
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** 跑一个 tsx 脚本（相对 repo 根的路径）。 */
export function runTsx(
  scriptRel: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): SubprocessResult {
  return runCaptured('npx', ['tsx', scriptRel, ...args], opts);
}

// ────────────────────────────────────────────────────────────────────────────
// 版本对齐检查（preflight 步 1）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 需与 `/VERSION` 对齐的版本承载文件（sdk/build/version.sh bump 的子集，取有代表性的几处）。
 * version.sh 是全 16 文件的唯一 bump 器；这里只做**放行前的一致性核对**，不 bump。
 */
export const VERSION_FILES = [
  'package.json',
  'src/lib/version.ts',
  'sdk/prismer/package.json',
  'sdk/cloud/package.json',
] as const;

/** 从一个版本承载文件里抽出版本串（按扩展名/文件名选正则）。抽不到返回 null。 */
export function extractVersion(fileRel: string, content: string): string | null {
  if (fileRel.endsWith('.json')) {
    const m = content.match(/"version"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }
  if (fileRel.endsWith('version.ts')) {
    const m = content.match(/export const VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  }
  return null;
}

export interface VersionAlignment {
  aligned: boolean;
  rootVersion: string;
  mismatches: Array<{ file: string; found: string | null }>;
}

/** 读 `/VERSION` 与各承载文件，比对是否一致。真读真文件。 */
export function checkVersionAlignment(root: string = REPO_ROOT): VersionAlignment {
  const rootVersion = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const mismatches: VersionAlignment['mismatches'] = [];
  for (const file of VERSION_FILES) {
    const p = join(root, file);
    if (!existsSync(p)) {
      mismatches.push({ file, found: null });
      continue;
    }
    const found = extractVersion(file, readFileSync(p, 'utf8'));
    if (found !== rootVersion) mismatches.push({ file, found });
  }
  return { aligned: mismatches.length === 0, rootVersion, mismatches };
}

// ────────────────────────────────────────────────────────────────────────────
// Prisma regen 检查（preflight 步 5）
// ────────────────────────────────────────────────────────────────────────────

/**
 * prisma generate 会把当次生成用的 schema **原样拷进** generated client
 * （`prisma/generated/mysql/schema.prisma`）。⇒ 源 schema 与拷贝逐字节相等 =
 * client 与 schema 同步；不等（或拷贝缺失）= 需要 `npm run prisma:generate:all`。
 * 用**内容对比**而非 mtime（mtime 在 checkout/CI 下不可靠）。
 */
export const PRISMA_PAIRS = [
  { schema: 'prisma/schema.mysql.prisma', client: 'prisma/generated/mysql/schema.prisma' },
] as const;

export interface PrismaRegenCheck {
  ok: boolean;
  stale: Array<{ schema: string; reason: 'client-missing' | 'schema-drift' }>;
}

export function checkPrismaRegen(root: string = REPO_ROOT): PrismaRegenCheck {
  const stale: PrismaRegenCheck['stale'] = [];
  for (const pair of PRISMA_PAIRS) {
    const schemaPath = join(root, pair.schema);
    const clientPath = join(root, pair.client);
    if (!existsSync(schemaPath)) continue; // 无源 schema 无从判断
    if (!existsSync(clientPath)) {
      stale.push({ schema: pair.schema, reason: 'client-missing' });
      continue;
    }
    if (readFileSync(schemaPath, 'utf8') !== readFileSync(clientPath, 'utf8')) {
      stale.push({ schema: pair.schema, reason: 'schema-drift' });
    }
  }
  return { ok: stale.length === 0, stale };
}

// ────────────────────────────────────────────────────────────────────────────
// tier 门（release-tag / release-preflight 共用）—— 真跑 apc test（run.ts）读真退出码
// ────────────────────────────────────────────────────────────────────────────

export interface TierGateResult {
  /** run.ts 的真退出码：0 绿 · 1 SUT红/回归 · 2 用法错 · 78 env_blocked。 */
  exitCode: number;
  envBlocked: boolean;
  regressions: string[];
  raw: SubprocessResult;
}

/**
 * 跑 `apc test --tier=<tier> --diff --json`（= 真 run.ts）并解析 `test203.run/v1`。
 * **不注入任何 stub**：run.ts 是 SUT，退出码/regressions 由它决定。测试可经 run.ts
 * 既有 self-test seam（`TEST203_SELFTEST_ROOT`/`TEST203_DOCTOR_SCRIPT`）确定性造绿/红——
 * 那是 run.ts 自己的合法自测钩子（M1-b 已用），不是本层的开卷桩。
 */
export function runTierGate(
  tier: string,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Subprocess runner. Defaults to the real `runTsx` — production callers pass
   * nothing, so the SUT is unchanged. Injectable ONLY so the fail-closed branch
   * below is testable: its trigger (run.ts exiting 0 without emitting) needs a
   * symlinked repo path to reproduce for real, and a guard nobody can exercise
   * is a guard nobody can prove works. This does NOT stub the tier run itself —
   * every existing test still drives the real run.ts through
   * `TEST203_SELFTEST_ROOT`.
   */
  run: (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => SubprocessResult = runTsx,
): TierGateResult {
  const r = run('sdk/apc/bin/apc.ts', ['test', `--tier=${tier}`, '--diff', '--json'], { env });
  let regressions: string[] = [];
  let envBlocked = false;
  let payloadOk = false;
  try {
    const j = JSON.parse(r.stdout) as {
      schema?: string;
      regressions?: string[];
      envStatus?: string;
      tiers?: unknown[];
    };
    regressions = Array.isArray(j.regressions) ? j.regressions : [];
    envBlocked = j.envStatus === 'env_blocked';
    // 正证据：必须真的拿到 run.ts 的载荷，而不只是"没报错"。
    payloadOk = j.schema === 'test203.run/v1' && Array.isArray(j.tiers) && j.tiers.length > 0;
  } catch {
    // 解析不了：payloadOk 保持 false，走下面的 fail-closed 分支
  }
  // 退出码优先（run.ts 已把 env_blocked 物化为 78）
  const exitCode = r.status ?? EXIT_BLOCKED;
  if (exitCode === 78) envBlocked = true;

  // ⚠️ fail-CLOSED（apc/12 release-preflight 验收 F-A）——此前这里是 fail-OPEN：
  // 解析失败只被空 `catch {}` 吞掉，随后 `exitCode = r.status` 让「跑器一个字节
  // 没吐 + exit 0」与「全跑完全通过」**不可区分**，tier 门直接判绿。而 tier 绿是
  // 发版的硬前置（01 §2：没有 tier 全绿的结构化证据，审批不创建、tag 不 push），
  // 一个不要求正证据的前置门就是放行章。
  //
  // 真触发器（验收实测，不是假想）：`scripts/test203/run.ts:935` 的入口守卫比较
  // `resolve(process.argv[1])` 与 `fileURLToPath(import.meta.url)` —— ESM 侧走
  // realpath、argv 侧不走，所以路径链上只要有一个软链，run.ts 就**静默不 main()
  // 并退 0**，stdout 空。日常形态下 REPO_ROOT 已被 Node realpath 故不易撞上，但
  // 「门不要求正证据」这条缺陷与触发器常不常见无关：任何让 run.ts 退 0 且不产出
  // 的原因（守卫、早退、输出重定向、未来重构）都会把它变成放行。
  //
  // 成功路径必须有载荷；env_blocked(78) 与非零退出码本就不放行，无须载荷。
  if (exitCode === 0 && !payloadOk) {
    return {
      exitCode: EXIT_BLOCKED,
      envBlocked,
      regressions: [
        'tier gate produced no verifiable `test203.run/v1` payload despite exit 0 — ' +
          'refusing to read silence as success (run.ts may have exited without running: ' +
          `stdout ${r.stdout.length} bytes)`,
      ],
      raw: r,
    };
  }
  return { exitCode, envBlocked, regressions, raw: r };
}

// ────────────────────────────────────────────────────────────────────────────
// tier 用例计数（正证据）—— apc/12 §0.9「门只问有没有报错，不问有没有正证据」
// ────────────────────────────────────────────────────────────────────────────

/**
 * 一层的用例计数。`null` = run.ts 载荷里**没有**这个数（unknown），**不是 0**。
 * 「解析不出来」与「真的一条都没跑」在发版证据里是两件完全不同的事，用 0 冒充
 * unknown 正是本次要根治的那类哑弹。
 */
export interface TierCaseCount {
  tier: string | null;
  passed: number | null;
  failed: number | null;
}

export interface TierCaseCounts {
  /** 真从 `raw.stdout` 拿到 `tiers` 数组了吗。false ⇒ 下面全是 unknown（null）。 */
  parsed: boolean;
  perTier: TierCaseCount[];
  /** 合计。null = unknown（没有任何一层报了这个数），别读成 0。 */
  passed: number | null;
  failed: number | null;
  total: number | null;
}

/** unknown 哨兵：没跑 tier 门（如 prod 人闸提前拒）时用它，别用全 0。 */
export function unknownTierCaseCounts(): TierCaseCounts {
  return { parsed: false, perTier: [], passed: null, failed: null, total: null };
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 至少一层报了数才算已知；一层都没报 ⇒ null（unknown），不是 0。 */
function sumOrNull(xs: Array<number | null>): number | null {
  return xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null;
}

/**
 * 从 tier 门的原始 stdout（`test203.run/v1`）解析每层 passed/failed + 合计。
 *
 * 落在 release-common 而不是各 verb 里：`release-tag` / `release-preflight` 之前各自
 * 在 `isEmptyTierRun` 里解析同一份载荷、解析完只留一个布尔就把数字扔了——发版产物
 * 因此查得到「没报错」，查不到「这一跑到底真执行了多少条断言」。
 */
export function parseTierCaseCounts(gate: TierGateResult): TierCaseCounts {
  let tiers: unknown;
  try {
    tiers = (JSON.parse(gate.raw.stdout) as { tiers?: unknown }).tiers;
  } catch {
    return unknownTierCaseCounts();
  }
  if (!Array.isArray(tiers)) return unknownTierCaseCounts();
  const perTier: TierCaseCount[] = tiers.map((t) => {
    const o = (t ?? {}) as { tier?: unknown; passed?: unknown; failed?: unknown };
    return {
      tier: typeof o.tier === 'string' ? o.tier : null,
      passed: finiteOrNull(o.passed),
      failed: finiteOrNull(o.failed),
    };
  });
  const passed = sumOrNull(perTier.map((t) => t.passed));
  const failed = sumOrNull(perTier.map((t) => t.failed));
  const total = passed === null && failed === null ? null : (passed ?? 0) + (failed ?? 0);
  return { parsed: true, perTier, passed, failed, total };
}

// ────────────────────────────────────────────────────────────────────────────
// 通用 JSON 出参
// ────────────────────────────────────────────────────────────────────────────

/**
 * 写 stdout 并**等 write 回调返回**再 resolve —— bin/apc.ts 在 main 后立刻 `process.exit`，
 * 大 JSON（如 db-config-sync 的 ~200 条 pending）在管道下会被 exit 截断（§0.9 bug #1 同形）。
 * 必须 await 回调，否则退出码看着对、stdout 被腰斩成非法 JSON。
 */
export async function emit(json: boolean, human: string, payload: Record<string, unknown>): Promise<void> {
  const text = json ? JSON.stringify(payload, null, 2) + '\n' : human + '\n';
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}
