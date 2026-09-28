/**
 * release-tag.ts — `apc release tag`（apc/01 §2 release-tag，收口步 6）。
 *
 * ## 焊点：tier 门是硬前置（01 §2「测试→上线的焊点」）
 * **没有 tier 全绿 / baseline 无新红的结构化证据，审批请求根本不创建、tag 绝不 push。**
 * tier 门跑真 `apc test --diff --json`（= run.ts），读真退出码——tier 红 / env_blocked ⇒ blocked。
 *
 * ## prod 人闸（不变量 2 · 01 §3 · 评审 P0-3）
 * git 协议按 tag 名限权靠 GitLab protected tags（P-1，blocked on 人工）。在那之前
 * **本 verb 对全部 prod 触发前缀硬拒**（`k8s-prod-*`/`desktop-prod-*`/`prod-*`/`ali-k8s-prod-*`），
 * 不做任何 git 动作。prod 真路径 = M5 + P-1。
 *
 * ## 本机替身边界（04 §4.5）
 * tier 门 / 算 tag / 审批链**全真**；push **到本地 bare repo 替身**（`.dev-stack/apc-bare-origin.git`）
 * 验证「create tag + push」动作本身，**不推 GitLab**。真 push + pipeline 轮询 = M5。
 * 审批：`--approved <approvalId>` 必须从本地 cloud 读回，并与 `--task` 绑定；CLI 自己造不出批件。
 */
import {
  Decision,
  decisionExit,
  emit,
  EXIT_BLOCKED,
  parseTierCaseCounts,
  REPO_ROOT,
  runCaptured,
  runTierGate,
  TierCaseCounts,
  TierGateResult,
  unknownTierCaseCounts,
} from './release-common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const DEFAULT_MIRROR = join(REPO_ROOT, '.dev-stack', 'apc-bare-origin.git');

export type Channel = 'k8s' | 'desktop';
export type Target = 'test' | 'prod';

/** 全部映射 APP_ENV=prod 的触发前缀（01 §3 · .gitlab-ci.yml:953-955）。命中即人闸拒。 */
export const PROD_PREFIXES = ['k8s-prod-', 'desktop-prod-', 'prod-', 'ali-k8s-prod-'];

export function isProdTag(tag: string): boolean {
  return PROD_PREFIXES.some((p) => tag.startsWith(p));
}

export function todayStamp(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 算 tag：`<channel>-<target>-YYYYMMDD-vX.Y.Z`（01 §0 表 #6）。 */
export function computeTag(
  channel: Channel,
  target: Target,
  version: string,
  date: string = todayStamp(),
): string {
  return `${channel}-${target}-${date}-v${version}`;
}

export function readRootVersion(root: string = REPO_ROOT): string {
  return readFileSync(join(root, 'VERSION'), 'utf8').trim();
}

export interface TagPushResult {
  pushed: boolean;
  error?: string;
}

interface ReleaseApprovalRecord {
  id: string;
  taskId: string | null;
  category: string;
  status: string;
  requestedById: string;
  decidedById: string | null;
  metadata?: Record<string, unknown>;
}

interface ReleaseApprovalLookup {
  ok: boolean;
  approval?: ReleaseApprovalRecord;
  commitSha?: string;
  error?: string;
}

function commitShaFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const nestedGit = record.git && typeof record.git === 'object' && !Array.isArray(record.git)
    ? (record.git as Record<string, unknown>).sha
    : undefined;
  const candidate = [nestedGit, record.commitSha, record.gitSha].find(
    (value): value is string => typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value),
  );
  return candidate ?? null;
}

/**
 * 他证 seam：只通过 cloud 的鉴权 approvals interface 读取批件，不接受调用方注入的批件 JSON。
 * `taskId` 同时收窄服务端查询面；返回后仍按 approvalId 精确匹配，随机字符串 fail-closed。
 */
export async function lookupReleaseApproval(approvalId: string, taskId: string): Promise<ReleaseApprovalLookup> {
  const baseUrl = (process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY;
  if (!token) return { ok: false, error: 'approval 他证缺少 APC_API_KEY / PRISMER_API_KEY' };
  try {
    const response = await fetch(
      `${baseUrl}/api/im/approvals?taskId=${encodeURIComponent(taskId)}&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return { ok: false, error: `approval 他证 HTTP ${response.status}` };
    const payload = (await response.json()) as { ok?: boolean; data?: unknown };
    const rows = Array.isArray(payload.data) ? (payload.data as ReleaseApprovalRecord[]) : [];
    const approval = rows.find((row) => row?.id === approvalId);
    if (!payload.ok || !approval) return { ok: false, error: `approval ${approvalId} 未在 cloud 找到` };
    if (approval.taskId !== taskId) {
      return { ok: false, error: `approval ${approvalId} 绑定 task=${approval.taskId ?? '(none)'}，不是 ${taskId}` };
    }
    if (approval.status !== 'approved') {
      return { ok: false, error: `approval ${approvalId} status=${approval.status}，必须为 approved` };
    }
    if (approval.category !== 'release_tag') {
      return { ok: false, error: `approval ${approvalId} category=${approval.category}，必须为 release_tag` };
    }
    if (!approval.decidedById || approval.decidedById === approval.requestedById) {
      return { ok: false, error: `approval ${approvalId} 必须由请求人以外的人决定（禁止自批）` };
    }
    const approvalSha = commitShaFromMetadata(approval.metadata);
    if (!approvalSha) return { ok: false, error: `approval ${approvalId} metadata 缺少 commitSha` };

    const taskResponse = await fetch(`${baseUrl}/api/im/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!taskResponse.ok) return { ok: false, error: `task ${taskId} 他证 HTTP ${taskResponse.status}` };
    const taskPayload = (await taskResponse.json()) as {
      ok?: boolean;
      data?: { task?: { id?: string; metadata?: unknown } };
    };
    const task = taskPayload.data?.task;
    if (!taskPayload.ok || task?.id !== taskId) return { ok: false, error: `task ${taskId} 未在 cloud 找到` };
    const taskSha = commitShaFromMetadata(task.metadata);
    if (!taskSha) return { ok: false, error: `task ${taskId} metadata 缺少 commitSha` };
    if (taskSha.toLowerCase() !== approvalSha.toLowerCase()) {
      return { ok: false, error: `approval commit=${approvalSha} 与 task commit=${taskSha} 不一致` };
    }
    return { ok: true, approval, commitSha: taskSha };
  } catch (err) {
    return { ok: false, error: `approval 他证不可达: ${(err as Error).message}` };
  }
}

/** 真 git：在 repo 建 tag（强制覆盖幂等）→ push 到 bare mirror。真副作用，可 `git ls-remote` 核验。 */
export function pushTagToMirror(tag: string, repo: string, mirror: string, commitSha: string): TagPushResult {
  const commitRes = runCaptured('git', ['-C', repo, 'cat-file', '-e', `${commitSha}^{commit}`], { cwd: repo });
  if (commitRes.status !== 0) return { pushed: false, error: `task commit 不在 repo: ${commitSha}` };
  const tagRes = runCaptured('git', ['-C', repo, 'tag', '-f', tag, commitSha], { cwd: repo });
  if (tagRes.status !== 0) return { pushed: false, error: `git tag 失败: ${tagRes.stderr.trim()}` };
  const pushRes = runCaptured('git', ['-C', repo, 'push', '--force', mirror, `refs/tags/${tag}:refs/tags/${tag}`], {
    cwd: repo,
  });
  if (pushRes.status !== 0) return { pushed: false, error: `git push 失败: ${pushRes.stderr.trim()}` };
  return { pushed: true };
}

export interface TagReport {
  verb: 'tag';
  decision: Decision;
  tag: string;
  target: Target;
  channel: Channel;
  tier: {
    tier: string;
    exitCode: number;
    envBlocked: boolean;
    regressions: string[];
    emptyRun: boolean;
    /**
     * 正证据（W0.8）：这一跑到底真执行了多少条断言。此前只留 `emptyRun` 布尔，
     * 数字在 `isEmptyTierRun` 里解析完就丢了 ⇒ 发版产物查得到「没报错」，查不到
     * 「跑了多少」。`null` = unknown（载荷里没这个数），**不是 0**。
     */
    cases: TierCaseCounts;
  };
  approved: boolean;
  approvalId: string | null;
  taskId: string | null;
  commitSha: string | null;
  pushed: boolean;
  mirror: string;
  blockers: string[];
  notes: string[];
}

const USAGE = `apc release tag [--channel k8s|desktop] [--target test|prod] [--version X.Y.Z]
                --tier=<tiers> [--task <taskId> --approved <approvalId>] [--repo <path>] [--mirror <bare>] [--date YYYYMMDD] [--json]

算 tag + tier 硬前置 + 审批门 + push 到本地 bare mirror（apc/01 §2，本机替身 04 §4.5）。
  --tier 无默认值，必须显式传（prod 触发路径除外，见下）——TD 层在无桌面冒烟 spec 时会自动
  skipped-with-note（passed:0/failed:0），拿它当发版硬前置是一道不可能红的空门。选一个会
  真执行断言的层，例如 --tier=T0,T1。
  tier 红/env_blocked/空跑（0 用例真实执行）→ blocked(1)；tier 绿未审批 → staged(3)；审批后 push → green(0)
  prod 前缀 → 人闸硬拒(1)，先于 tier 门（不变量 2；真 prod = M5 + P-1 protected tags）
`;

/**
 * apc/12 §0.12 修法 B：tier 门读到「一个用例都没真跑」（该轮所有 tier 的 passed+failed 合计
 * 为 0）时不构成绿证据——不管 run.ts 退出码是不是 0。别和 `envBlocked` 混：env_blocked 是独立
 * 的环境故障域分支，这里只处理「payload 合法、真跑完了、但没有一条用例真正执行」的情况
 * （典型触发：TD 层在 `apps/desktop/e2e/smoke/` 无 spec 时的占位 skip）。
 * 载荷解析下沉到 `release-common.parseTierCaseCounts`（W0.8）——那里同时留下每层
 * passed/failed 进 `TagReport.tier.cases`，本函数只做判定，不再自己解析一遍。
 * 解析不出来就不掺和——那种情况已经被 `runTierGate` 自己的 fail-closed 分支
 * （payload 校验）转成 blocked 了。
 *
 * ⚠️ 判定语义与下沉前**逐例等价**（含 tiers 有元素但一个 passed/failed 字段都没有的
 * 退化载荷 → 仍判 true，fail-closed 不放松）：`total` 为 unknown(null) 时按 0 读，
 * 只在这一条判定里；报出去的 `cases.total` 仍诚实是 null。
 */
export function isEmptyTierRun(gate: TierGateResult, counts: TierCaseCounts = parseTierCaseCounts(gate)): boolean {
  if (!counts.parsed || counts.perTier.length === 0) return false;
  return (counts.total ?? 0) === 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = argv.includes('--json');
  const channel = (argVal(argv, '--channel') ?? 'k8s') as Channel;
  const target = (argVal(argv, '--target') ?? 'test') as Target;
  const version = argVal(argv, '--version') ?? readRootVersion();
  const tier = argVal(argv, '--tier');
  const approvedToken = argVal(argv, '--approved');
  const taskId = argVal(argv, '--task');
  const repo = argVal(argv, '--repo') ?? REPO_ROOT;
  const mirror = argVal(argv, '--mirror') ?? DEFAULT_MIRROR;
  const date = argVal(argv, '--date') ?? todayStamp();

  if (channel !== 'k8s' && channel !== 'desktop') return usageErr(`未知 channel: ${channel}`);
  if (target !== 'test' && target !== 'prod') return usageErr(`未知 target: ${target}`);

  const tag = computeTag(channel, target, version, date);
  const blockers: string[] = [];
  const notes: string[] = [];

  // 1. prod 人闸：先于一切 git / tier 动作硬拒（不变量 2）——包括「有没有传 --tier」这个用法
  //    校验：prod 路径压根不跑 tier 门，不该逼人为一条必被拒的命令编个 tier。
  if (target === 'prod' || isProdTag(tag)) {
    const report: TagReport = {
      verb: 'tag',
      decision: 'blocked',
      tag,
      target,
      channel,
      tier: {
        tier: tier ?? '(prod 人闸提前拒绝，未读 --tier)',
        exitCode: -1,
        envBlocked: false,
        regressions: [],
        emptyRun: false,
        // tier 门根本没跑 ⇒ 计数是 unknown，不是 0（0 会被读成「跑了但一条没执行」）。
        cases: unknownTierCaseCounts(),
      },
      approved: false,
      approvalId: null,
      taskId: null,
      commitSha: null,
      pushed: false,
      mirror,
      blockers: [`prod 人闸：${tag} 命中 prod 触发前缀，本机替身拒绝 push（真 prod = M5 + P-1 protected tags）`],
      notes,
    };
    await emit(json, `[tag] BLOCKED prod 人闸：${tag}`, report as unknown as Record<string, unknown>);
    return EXIT_BLOCKED;
  }

  // 1.5 --tier 无默认值：TD 会自动 skip 产不出「真跑过」的证据，拿它当发版硬前置的默认值
  //     就是把空门焊死当焊点。必须显式选一个会真执行用例的层。
  if (!tier) {
    return usageErr(
      '缺少 --tier：无默认值。TD 层在无桌面冒烟 spec 时自动 skipped-with-note（passed:0/failed:0），' +
        '拿它当发版硬前置是一道不可能红的空门。显式选一个会真执行断言的层，例如 --tier=T0,T1。',
    );
  }

  // 2. tier 硬前置（焊点）
  const gate = runTierGate(tier);
  const cases = parseTierCaseCounts(gate); // 解析一次：判定与产物证据共用
  const emptyRun = !gate.envBlocked && isEmptyTierRun(gate, cases);
  if (gate.envBlocked) blockers.push('tier gate env_blocked（环境故障域）');
  else if (emptyRun)
    blockers.push(
      `tier gate 空跑：tier=${tier} 0 个用例真实执行（passed+failed=0），不构成绿证据（apc/12 §0.12 修法 B）`,
    );
  else if (gate.exitCode === 1) blockers.push(`tier gate 红：${gate.regressions.join(', ') || 'run.ts exit 1'}`);
  else if (gate.exitCode !== 0) blockers.push(`tier gate 异常退出码 ${gate.exitCode}`);

  let decision: Decision;
  let pushed = false;
  let approvalVerified = false;
  let verifiedCommitSha: string | null = null;

  if (blockers.length > 0) {
    decision = 'blocked'; // tier 红 → 审批请求不创建、绝不 push
    notes.push('tier 未过：审批请求不创建，tag 不 push');
  } else if (!approvedToken) {
    decision = 'staged'; // tier 绿 + 待审批 → dry-run：出 tag + tier 证据，不 push
    notes.push(`tier 绿；等待 cloud 审批（--task <taskId> --approved <approvalId>）。tag=${tag}`);
  } else if (!taskId) {
    decision = 'blocked';
    blockers.push('approval 必须绑定 --task <taskId>');
  } else {
    const lookup = await lookupReleaseApproval(approvedToken, taskId);
    if (!lookup.ok) {
      decision = 'blocked';
      blockers.push(lookup.error ?? 'approval 他证校验失败');
    } else {
      // 3. 审批后 push 到 bare mirror（真副作用）
      approvalVerified = true;
      verifiedCommitSha = lookup.commitSha ?? null;
      const res = verifiedCommitSha
        ? pushTagToMirror(tag, repo, mirror, verifiedCommitSha)
        : { pushed: false, error: 'approval/task commit 他证缺失' };
      if (res.pushed) {
        decision = 'green';
        pushed = true;
        notes.push(`cloud approval=${approvedToken} 已读回；已 push ${tag} → ${mirror}`);
      } else {
        decision = 'blocked';
        blockers.push(res.error ?? 'push 失败');
      }
    }
  }

  const report: TagReport = {
    verb: 'tag',
    decision,
    tag,
    target,
    channel,
    tier: { tier, exitCode: gate.exitCode, envBlocked: gate.envBlocked, regressions: gate.regressions, emptyRun, cases },
    approved: approvalVerified,
    approvalId: approvedToken ?? null,
    taskId: taskId ?? null,
    commitSha: verifiedCommitSha,
    pushed,
    mirror,
    blockers,
    notes,
  };

  await emit(
    json,
    [
      `[tag] decision=${decision} tag=${tag}`,
      `  tier(${tier}): exit=${gate.exitCode} envBlocked=${gate.envBlocked} emptyRun=${emptyRun} regressions=${gate.regressions.length}`,
      `  cases: passed=${fmtCount(cases.passed)} failed=${fmtCount(cases.failed)} total=${fmtCount(cases.total)}` +
        (cases.perTier.length > 0
          ? ` [${cases.perTier.map((t) => `${t.tier ?? '?'}:${fmtCount(t.passed)}/${fmtCount(t.failed)}`).join(' ')}]`
          : ''),
      `  approved=${Boolean(approvedToken)} pushed=${pushed} mirror=${mirror}`,
      ...blockers.map((b) => `  ✗ ${b}`),
      ...notes.map((n) => `  · ${n}`),
    ].join('\n'),
    report as unknown as Record<string, unknown>,
  );

  return decisionExit(decision);
}

/** 人读行里 unknown 显式写 `unknown`，绝不印成 0。 */
function fmtCount(n: number | null): string {
  return n === null ? 'unknown' : String(n);
}

function argVal(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function usageErr(msg: string): number {
  process.stderr.write(`apc release tag: ${msg}\n\n${USAGE}`);
  return 2;
}
