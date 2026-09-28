/**
 * release-preflight.ts — `apc release preflight`（apc/01 §2 release-preflight，收口步 1/2/5）。
 *
 * 全只读 / 本地。三道硬前置：
 *   1. **tier 门**：跑真 `apc test --tier=<tier> --diff --json`（= run.ts），读**真退出码**。
 *      SUT 红（regressions）或 env_blocked ⇒ blocked（发版根本不该起步）。
 *   2. **版本对齐**：`/VERSION` ⇄ 各承载文件一致（`checkVersionAlignment`）。
 *   3. **prisma regen**：源 schema ⇄ generated client 拷贝逐字节相等（`checkPrismaRegen`）。
 *
 * decision：
 *   - tier 红 / env_blocked → **blocked**（exit 1）——不许骗绿
 *   - 版本失配 / regen 待跑 → **staged**（exit 3）——可修前置，出 fix-hint
 *   - 三项全绿 → **green**（exit 0）——放行
 *
 * 默认 tier=TD（冒烟），`--tier=` 可覆盖。`--json` 出结构化回执工件（审批人证据包）。
 *
 * 本机替身边界（04 §4.5）：release-preflight **真路径全程**（只读检查），无远端替身缺口。
 */
import {
  checkPrismaRegen,
  checkVersionAlignment,
  Decision,
  decisionExit,
  emit,
  runTierGate,
  TierGateResult,
} from './release-common';

export interface PreflightReport {
  verb: 'preflight';
  decision: Decision;
  tier: { tier: string; exitCode: number; envBlocked: boolean; regressions: string[]; emptyRun: boolean };
  version: ReturnType<typeof checkVersionAlignment>;
  prisma: ReturnType<typeof checkPrismaRegen>;
  blockers: string[];
  staged: string[];
}

/**
 * apc/12 §0.12 修法 B：同 release-tag.ts 的 `isEmptyTierRun`——tier 门「payload 合法、真跑
 * 完了，但该轮所有 tier 的 passed+failed 合计为 0」时不算绿证据（典型触发：TD 层无桌面冒烟
 * spec 时的占位 skip）。与 `envBlocked`（独立环境故障域分支）分开判，不混。
 */
export function isEmptyTierRun(gate: TierGateResult): boolean {
  try {
    const parsed = JSON.parse(gate.raw.stdout) as { tiers?: Array<{ passed?: number; failed?: number }> };
    if (!Array.isArray(parsed.tiers) || parsed.tiers.length === 0) return false;
    const total = parsed.tiers.reduce((sum, t) => sum + (t.passed ?? 0) + (t.failed ?? 0), 0);
    return total === 0;
  } catch {
    return false;
  }
}

/** 纯判定：把三项检查结果收敛成一个 decision + 原因清单。 */
export function decidePreflight(
  tier: { exitCode: number; envBlocked: boolean; regressions: string[]; emptyRun?: boolean },
  version: ReturnType<typeof checkVersionAlignment>,
  prisma: ReturnType<typeof checkPrismaRegen>,
): { decision: Decision; blockers: string[]; staged: string[] } {
  const blockers: string[] = [];
  const staged: string[] = [];

  if (tier.envBlocked) blockers.push('tier gate env_blocked（环境故障域，非 SUT 红）');
  else if (tier.emptyRun)
    blockers.push('tier gate 空跑：0 个用例真实执行（passed+failed=0），不构成绿证据（apc/12 §0.12 修法 B）');
  else if (tier.exitCode === 1) blockers.push(`tier gate 红：${tier.regressions.join(', ') || 'run.ts exit 1'}`);
  else if (tier.exitCode !== 0) blockers.push(`tier gate 异常退出码 ${tier.exitCode}`);

  if (!version.aligned) {
    staged.push(
      `版本失配（/VERSION=${version.rootVersion}）：` +
        version.mismatches.map((m) => `${m.file}=${m.found ?? '缺失'}`).join(', ') +
        ' → 跑 sdk/build/version.sh 对齐',
    );
  }
  if (!prisma.ok) {
    staged.push(
      `prisma client 待重生：${prisma.stale.map((s) => `${s.schema}(${s.reason})`).join(', ')} → npm run prisma:generate:all`,
    );
  }

  const decision: Decision = blockers.length > 0 ? 'blocked' : staged.length > 0 ? 'staged' : 'green';
  return { decision, blockers, staged };
}

const USAGE = `apc release preflight --tier=<tiers> [--json]

发版硬前置只读门（apc/01 §2）：tier 全绿 + 版本对齐 + prisma regen。
  --tier 无默认值，必须显式传——TD 层在无桌面冒烟 spec 时会自动 skipped-with-note
  （passed:0/failed:0），拿它当发版硬前置的默认值是一道不可能红的空门。选一个会真执行断言
  的层，例如 --tier=T0,T1。
  exit 0 green（放行）· 3 staged（有可修前置）· 1 blocked（tier 红/env_blocked/空跑）
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = argv.includes('--json');
  const tierArg = argv.find((a) => a.startsWith('--tier='));
  if (!tierArg) {
    process.stderr.write(
      `apc release preflight: 缺少 --tier=<tiers>：无默认值。TD 层在无桌面冒烟 spec 时自动 ` +
        `skipped-with-note（passed:0/failed:0），拿它当发版硬前置是一道不可能红的空门。` +
        `显式选一个会真执行断言的层，例如 --tier=T0,T1。\n\n${USAGE}`,
    );
    return 2;
  }
  const tier = tierArg.slice('--tier='.length);

  const gate = runTierGate(tier);
  const emptyRun = !gate.envBlocked && isEmptyTierRun(gate);
  const version = checkVersionAlignment();
  const prisma = checkPrismaRegen();
  const { decision, blockers, staged } = decidePreflight(
    { exitCode: gate.exitCode, envBlocked: gate.envBlocked, regressions: gate.regressions, emptyRun },
    version,
    prisma,
  );

  const report: PreflightReport = {
    verb: 'preflight',
    decision,
    tier: { tier, exitCode: gate.exitCode, envBlocked: gate.envBlocked, regressions: gate.regressions, emptyRun },
    version,
    prisma,
    blockers,
    staged,
  };

  await emit(
    json,
    [
      `[preflight] decision=${decision}`,
      `  tier(${tier}): exit=${gate.exitCode} envBlocked=${gate.envBlocked} emptyRun=${emptyRun} regressions=${gate.regressions.length}`,
      `  version: ${version.aligned ? 'aligned' : 'MISMATCH'} (/VERSION=${version.rootVersion})`,
      `  prisma: ${prisma.ok ? 'in-sync' : 'STALE'}`,
      ...blockers.map((b) => `  ✗ blocker: ${b}`),
      ...staged.map((s) => `  · staged: ${s}`),
    ].join('\n'),
    report as unknown as Record<string, unknown>,
  );

  return decisionExit(decision);
}
