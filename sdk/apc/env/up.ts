#!/usr/bin/env npx tsx
/**
 * up.ts — `apc env up`（apc/06 §2）。**幂等**修复：只做可自动化的部分。
 *
 * ## 两条设计约束
 *
 * 1. **不重造既有资产**（06 §2 "吸收现有资产"）。每一步都是对仓库里那份 canonical 脚本的
 *    薄包装：
 *      - infra 段  → `scripts/dev-stack.sh up`（**现版已内建 legacy 检测 + auto-baseline +
 *        drift gate**，dev-stack.sh:111-137——"表已存在跳 migration"是旧坑，已在源头治掉，
 *        up 不再自己造 baseline 逻辑）
 *      - kind 段   → `scripts/sandbox/dev-loop.sh up`
 *      - prisma    → `npm run prisma:generate:all`
 *      - 依赖      → `npm ci`
 *      - bare 替身 → `git init --bare`
 *
 * 2. **凭据/签名 key 类不代办**（06 §0 原则 2）。`manualOnly` 的 manifest 项只出 fix-hint，
 *    up 一个字节都不写。KEK / API key / OTA 私钥不是"环境可以替你生成"的东西。
 *
 * ## 幂等怎么保证（可验证，不是宣称）
 *
 * 每步先跑它的 **guard 项**（= manifest 里的真判定，不是另一套判据）。guard 已 pass →
 * `skipped`。所以"连跑两次第二次全 skip"是**结构性**的：第一次跑完 guard 变绿，第二次
 * 必然全 skip。验收用例 `__tests__/up.test.ts` 对真 `up()` 连跑两次断言这一点。
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BARE_MIRROR, ENV_MANIFEST, KIND_CLUSTER, apcToolsPrefix, findItem, readBinaryPins } from './manifest';
import { REPO_ROOT, run, runBash, which, writeStdout } from './probes';
import type { EnvItem, ItemStatus } from './types';

export type StepAction = 'skipped' | 'executed' | 'failed' | 'manual';

export interface StepResult {
  id: string;
  action: StepAction;
  detail: string;
  /** guard 项跑完的状态（skipped 的证据）。 */
  guard?: { id: string; before: ItemStatus; after?: ItemStatus };
  durationMs: number;
}

export interface UpReport {
  ok: boolean;
  exitCode: number;
  generatedAt: string;
  steps: StepResult[];
  /** up 明确不代办、需要人补的项（凭据 / 签名 key）。 */
  manual: Array<{ id: string; label: string; fixHint: string }>;
}

interface StepDef {
  id: string;
  /** 该步负责让哪个 manifest 项变绿（guard 即验收判据，禁止另立一套）。 */
  guardId: string;
  /**
   * heavy = 该步会跑**长时间外部命令**（colima start / dev-stack / kind / npm ci /
   * prisma / migrations / 全局 npm i）。在**非交互安全模式**（`safe`）下，heavy 步的红
   * **不自动跑**——只归到 `manual[]` 出 fix-hint。这样 agent 在一次 dispatch 里跑
   * `apc env up --safe` 永远不会 block 在 `colima start`（apc/11 §0.17 缺口1：up 的
   * docker/colima 分支是人在终端跑的，不是 agent 在 dispatch 里跑的）。
   * 未标 heavy 的步（mkdir 配置目录 / git init --bare）是轻量幂等的，safe 模式照跑。
   */
  heavy?: boolean;
  /** guard 红时执行的修复。返回人可读 detail；抛异常 = 该步 failed。 */
  fix(): Promise<string>;
}

const steps: StepDef[] = [
  {
    id: 'docker',
    guardId: 'infra.docker-daemon',
    heavy: true,
    async fix() {
      // colima 在就 colima start（06 §2 明确点名）；否则不猜用户装的是哪个 runtime。
      const colima = await which('colima');
      if (!colima) throw new Error('docker daemon 不可达，且本机无 colima —— 请手动启动 OrbStack / Docker Desktop');
      const r = await run('colima', ['start'], 300_000);
      if (!r.ok) throw new Error(`colima start 失败：${r.error}`);
      return `colima start：${r.stdout.split('\n').slice(-1)[0] ?? 'ok'}`;
    },
  },
  {
    id: 'dev-stack',
    // dev-stack.sh up 同时负责 mysql + redis + 迁移账本；guard 取 mysql 协议判定，
    // 其余相邻项由同一次执行覆盖（下面 recheck 会把它们一起复测）。
    guardId: 'infra.mysql-3307',
    heavy: true,
    async fix() {
      const r = await runBash('./scripts/dev-stack.sh up', 600_000);
      if (!r.ok) throw new Error(`dev-stack.sh up 失败：${r.error}`);
      return `dev-stack.sh up 完成（mysql:3307 + redis:6380 + migrations + drift gate）`;
    },
  },
  {
    id: 'kind',
    guardId: `infra.kind-${KIND_CLUSTER}`,
    heavy: true,
    async fix() {
      const r = await runBash('bash scripts/sandbox/dev-loop.sh up', 900_000);
      if (!r.ok) throw new Error(`dev-loop.sh up 失败：${r.error}`);
      return `dev-loop.sh up 完成（kind 集群 ${KIND_CLUSTER}）`;
    },
  },
  {
    id: 'npm-ci',
    guardId: 'project.node-modules-lockfile',
    heavy: true,
    async fix() {
      const r = await runBash('npm ci', 900_000);
      if (!r.ok) throw new Error(`npm ci 失败：${r.error}`);
      return 'npm ci 完成';
    },
  },
  {
    id: 'prisma-generate',
    guardId: 'project.prisma-clients',
    heavy: true,
    async fix() {
      const r = await runBash('npm run prisma:generate:all', 600_000);
      if (!r.ok) throw new Error(`prisma:generate:all 失败：${r.error}`);
      return 'prisma:generate:all 完成（SQLite + MySQL 双 client）';
    },
  },
  {
    id: 'migrations',
    guardId: 'project.mysql-migrations-pending',
    heavy: true,
    async fix() {
      const r = await runBash('./scripts/db-migrate.sh up', 600_000);
      if (!r.ok) throw new Error(`db-migrate.sh up 失败：${r.error}`);
      return 'db-migrate.sh up 完成';
    },
  },
  {
    // 装 APC 锁定的 claude-code binary 到专属前缀（用户裁决 2026-07-24）。pin 从
    // image-pin.yaml 读（唯一真相源）。guard = claude 锁定检查项本身 → 装完 exact 转绿即
    // executed；已是 pin 版本就 skip（幂等天然满足，npm i 到同版本不改变 guard 结论）。
    id: 'apc-claude-binary',
    guardId: 'toolchain.claude-code-binary-pin',
    heavy: true,
    async fix() {
      const pin = readBinaryPins()['claude'];
      if (!pin) throw new Error('image-pin.yaml binaries.claude 无 pin，无法装锁定版本');
      const prefix = apcToolsPrefix();
      mkdirSync(prefix, { recursive: true });
      // 用 **`-g` --prefix**：全局装才产出裁决锚定的 `<prefix>/bin/claude`
      // （非 -g 的 `npm i --prefix` 只产出 `<prefix>/node_modules/.bin/claude`，路径对不上
      // `apcPinnedClaudeBinary` → guard 永远转不绿）。全局装进 <prefix>/lib/node_modules +
      // <prefix>/bin 软链，正是 apcPinnedClaudeBinary 指的那个路径。
      const cmd = `npm i -g --prefix ${prefix} @anthropic-ai/claude-code@${pin}`;
      const r = await runBash(cmd, 900_000);
      if (!r.ok) throw new Error(`${cmd} 失败：${r.error}`);
      return cmd;
    },
  },
  {
    id: 'claude-config-dir',
    guardId: 'project.claude-config-dir',
    async fix() {
      const { isolatedClaudeConfigDir } = await import('./manifest');
      const dir = isolatedClaudeConfigDir();
      mkdirSync(dir, { recursive: true });
      return `mkdir -p ${dir}`;
    },
  },
  {
    id: 'bare-mirror',
    guardId: 'project.bare-repo-mirror',
    async fix() {
      const dir = path.join(REPO_ROOT, BARE_MIRROR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const r = await run('git', ['init', '--bare', dir], 60_000);
      if (!r.ok) throw new Error(`git init --bare 失败：${r.error}`);
      return `git init --bare ${BARE_MIRROR}`;
    },
  },
];

async function statusOf(id: string): Promise<ItemStatus> {
  const item = findItem(id);
  if (!item) throw new Error(`[apc env up] 未知 guard 项 ${id}（manifest 里没有）`);
  try {
    return (await item.check()).status;
  } catch {
    return 'fail';
  }
}

export interface UpOptions {
  /** 只跑这些 step id（测试/定向修复用）。 */
  only?: string[];
  /** true = 不真跑 fix，只报告哪些步会执行（dry-run）。 */
  dryRun?: boolean;
  /**
   * 非交互安全模式（apc/11 §0.17 缺口1）。true 时 **heavy 步（长时间外部命令）不自动跑**——
   * 红着的 heavy 步归到 `manual[]` 出 fix-hint，`action='manual'`（不是 failed，不拉垮
   * exitCode）。轻量幂等步（mkdir / git init --bare）照跑。给 agent 在一次 dispatch 里安全
   * 调用：永不 block 在 `colima start` / `dev-stack up` 这类会超过 reaper 窗口的命令。
   * 也可用 env `APC_ENV_UP_SAFE=1` 打开（agent 环境统一注入）。
   */
  safe?: boolean;
}

function safeModeOn(opts: UpOptions): boolean {
  if (opts.safe !== undefined) return opts.safe;
  const raw = process.env.APC_ENV_UP_SAFE;
  return raw === '1' || raw === 'true';
}

export async function up(opts: UpOptions = {}): Promise<UpReport> {
  const selected = opts.only ? steps.filter((s) => opts.only!.includes(s.id)) : steps;
  const safe = safeModeOn(opts);
  const results: StepResult[] = [];
  const deferred: UpReport['manual'] = [];

  for (const step of selected) {
    const t0 = Date.now();
    const before = await statusOf(step.guardId);
    if (before === 'pass') {
      results.push({
        id: step.id,
        action: 'skipped',
        detail: `guard ${step.guardId} 已 pass —— 无需动作（幂等）`,
        guard: { id: step.guardId, before },
        durationMs: Date.now() - t0,
      });
      continue;
    }
    if (safe && step.heavy) {
      // 非交互安全模式：heavy 步红着也不跑（会 block / 超 reaper 窗口）→ 归 manual。
      const item = findItem(step.guardId);
      const fixHint = item?.fixHint ?? `在交互终端跑 apc env up（本步是长时间外部命令，dispatch 语境不自动执行）`;
      results.push({
        id: step.id,
        action: 'manual',
        detail: `safe 模式跳过 heavy 步（guard ${step.guardId}=${before}）—— 需在交互终端手动 up`,
        guard: { id: step.guardId, before },
        durationMs: Date.now() - t0,
      });
      deferred.push({ id: step.guardId, label: item?.label ?? step.id, fixHint });
      continue;
    }
    if (opts.dryRun) {
      results.push({
        id: step.id,
        action: 'skipped',
        detail: `dry-run：guard ${step.guardId}=${before}，本会执行修复`,
        guard: { id: step.guardId, before },
        durationMs: Date.now() - t0,
      });
      continue;
    }
    try {
      const detail = await step.fix();
      const after = await statusOf(step.guardId);
      results.push({
        id: step.id,
        // 修完 guard 还没绿 = 没修好，如实记 failed（不许拿"命令跑完了"当成功）。
        action: after === 'pass' ? 'executed' : 'failed',
        detail: after === 'pass' ? detail : `${detail} —— 但 guard ${step.guardId} 仍是 ${after}`,
        guard: { id: step.guardId, before, after },
        durationMs: Date.now() - t0,
      });
    } catch (e) {
      results.push({
        id: step.id,
        action: 'failed',
        detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
        guard: { id: step.guardId, before },
        durationMs: Date.now() - t0,
      });
    }
  }

  // 凭据 / 签名 key：**不代办**，只把还红着的列出来给人。
  // safe 模式下延迟的 heavy 步也进 manual（人在交互终端补）。
  const manual: UpReport['manual'] = [...deferred];
  for (const item of ENV_MANIFEST.filter((i: EnvItem) => i.manualOnly)) {
    let s: ItemStatus;
    try {
      s = (await item.check()).status;
    } catch {
      s = 'fail';
    }
    if (s !== 'pass') manual.push({ id: item.id, label: item.label, fixHint: item.fixHint });
  }

  const failed = results.filter((r) => r.action === 'failed');
  return {
    ok: failed.length === 0,
    exitCode: failed.length === 0 ? 0 : 1,
    generatedAt: new Date().toISOString(),
    steps: results,
    manual,
  };
}

export function renderHuman(report: UpReport): string {
  const glyph: Record<StepAction, string> = { skipped: '·', executed: '✚', failed: '✘', manual: '✋' };
  const lines = [`[apc env up] ${report.ok ? 'ok' : 'failed'}`];
  for (const s of report.steps) lines.push(`  ${glyph[s.action]} ${s.id.padEnd(20)} ${s.action.padEnd(9)} ${s.detail}`);
  if (report.manual.length) {
    lines.push('  — 需要人补（up 明确不代办：凭据 / 签名 key）—');
    for (const m of report.manual) lines.push(`  ✋ ${m.id}: ${m.fixHint}`);
  }
  return lines.join('\n');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)?.split(',');
  const report = await up({
    only,
    dryRun: argv.includes('--dry-run'),
    ...(argv.includes('--safe') ? { safe: true } : {}),
  });
  await writeStdout(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(renderHuman(report) + '\n');
  return report.exitCode;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`[apc env up] 崩溃：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
}
