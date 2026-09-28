/**
 * release-rollback.ts — `apc release rollback`（apc/01 §2 release-rollback，收口步 10）。
 *
 * ## 真回滚，非空壳
 * doc §2：回归红触发 → OTA `action:'rollback'/'pulled'`（K8s）· manifest 指针回退（桌面）·
 * cloud 重推上一好 tag → 审批 → 执行 → 建 bug task 回 bugfix 入口。
 *
 * 本机替身（04 §4.5「本地 kind + 本地 feed 上真回滚」）落成**两个真副作用**：
 *   1. **release 状态账本回退**：本地 ledger（release-status 行的替身）——把当前 `current` 版本翻
 *      `pulled`、上一好版本翻回 `current`。真写 JSON 文件，可核验。
 *   2. **版本指针回退**（可选，给了 `--mirror`）：把 bare mirror 的 `refs/heads/release-current`
 *      重指到上一好 tag 的 commit。真 git 副作用，`git ls-remote` 可核验。
 *
 * 审批门（本机：`--approved <token>`；真 approvalId 校验 = M5）。未审批 → 出回滚计划 dry-run(3)。
 * **无上一好版本可回退 → blocked(1)**（负控注入点：账本只有一条即拒，绝不空转返绿）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decision, decisionExit, emit, EXIT_BLOCKED, REPO_ROOT, runCaptured } from './release-common';

export const DEFAULT_LEDGER = join(REPO_ROOT, '.dev-stack', 'apc-release-ledger.json');

export type ReleaseStatus = 'current' | 'pulled' | 'superseded';

export interface ReleaseEntry {
  version: string;
  tag: string;
  status: ReleaseStatus;
  ts: string;
}

export type RollbackPlan =
  | { ok: true; from: ReleaseEntry; to: ReleaseEntry; next: ReleaseEntry[] }
  | { ok: false; reason: string };

/**
 * 纯函数：算回滚计划。当前 = 唯一 `current` 条目；目标 = 它之前最近的**非 pulled** 好版本。
 * 找不到当前 / 找不到上一好版本 → ok:false（负控在此变红）。
 */
export function planRollback(ledger: ReleaseEntry[]): RollbackPlan {
  const currentIdx = ledger.findIndex((e) => e.status === 'current');
  if (currentIdx < 0) return { ok: false, reason: '账本无 current 版本，无从回滚' };
  // 上一好版本 = current 之前、状态非 pulled 的最近一条
  let toIdx = -1;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (ledger[i].status !== 'pulled') {
      toIdx = i;
      break;
    }
  }
  if (toIdx < 0) return { ok: false, reason: '无上一好版本可回退（账本仅一条 / 更早的都已 pulled）' };

  const next = ledger.map((e, i) => {
    if (i === currentIdx) return { ...e, status: 'pulled' as ReleaseStatus };
    if (i === toIdx) return { ...e, status: 'current' as ReleaseStatus };
    return e;
  });
  return { ok: true, from: ledger[currentIdx], to: ledger[toIdx], next };
}

export function readLedger(path: string): ReleaseEntry[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? (parsed as ReleaseEntry[]) : [];
}

export function writeLedger(path: string, ledger: ReleaseEntry[]): void {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

/** commit sha 的唯一合法形态。空串 / 部分输出 / 任何非 40-hex 一律不算解析成功。 */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export type TagResolve = { ok: true; sha: string } | { ok: false; error: string };

/**
 * 解析目标 tag → **commit** sha，**要求正证据**（apc/17 §8.2 W0.3）。
 *
 * 两处与旧实现的差别，各治一条实测缺陷：
 *
 * 1. **`^{commit}` 而非裸 `refs/tags/<tag>`**（apc/12 §1 发现 A 的触发器）：annotated tag
 *    （`git tag -a`，CI/人手常用）的 `refs/tags/X` 是 **tag 对象**，git 正当拒绝把它写进
 *    branch ref ⇒ `update-ref` 失败。`^{commit}` 对 lightweight / annotated 都剥到 commit。
 * 2. **校验 40-hex**（apc/12 §1 发现 B，与 `runTierGate` fail-open 同一句话的同一个漏法）：
 *    旧实现只看 `status !== 0`，**从不要求 sha 非空**。实测注入一个 `exit 0` 且零输出的
 *    `git` 替身 ⇒ `sha=''` ⇒ `update-ref … ''` 也退 0 ⇒ 全流程 `green / mirrorRepointed=true`，
 *    产物白纸黑字写「版本指针回退：… → v1」，而 `release-current` before/after 同一个 sha。
 *    后果比 tier 门更直接：**产物声称 fleet 已回到 known-good，实际还停在坏版本上。**
 */
export function resolveTagCommit(mirror: string, tag: string): TagResolve {
  const rev = runCaptured('git', ['-C', mirror, 'rev-parse', `refs/tags/${tag}^{commit}`], { cwd: mirror });
  if (rev.status !== 0) {
    // status=null = 子进程没跑起来（mirror 目录不存在时 spawn 的 cwd 就不成立），stderr 为空，
    // 必须把 mirror 路径写进 blocker，否则运维只看到一句无信息量的 "exit null"。
    const why = rev.stderr.trim() || (rev.status === null ? `git 未能启动（mirror 路径不可用？）` : '(无 stderr)');
    return { ok: false, error: `mirror ${mirror} 无法把 tag ${tag} 解到 commit（exit ${rev.status}）: ${why}` };
  }
  const sha = rev.stdout.trim();
  if (!COMMIT_SHA.test(sha)) {
    return {
      ok: false,
      error:
        `rev-parse refs/tags/${tag}^{commit} 退 0 但没给出 40-hex commit sha` +
        `（实得 ${JSON.stringify(sha)}，stdout ${rev.stdout.length} 字节）` +
        ` — 拒绝把「没报错」读成「解析成功」`,
    };
  }
  return { ok: true, sha };
}

/**
 * 真 git：把 bare mirror 的 release-current 指针重指到目标 tag 的 commit。
 * 解析侧要求正证据（`resolveTagCommit`），写入侧**回读核对**——`update-ref` 退 0 只说明
 * 「命令没报错」，而产物声称的是「指针现在指着 X」，那就必须去读指针本身。
 */
export function repointMirror(mirror: string, tag: string): { ok: boolean; error?: string; sha?: string } {
  const resolved = resolveTagCommit(mirror, tag);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const sha = resolved.sha;
  const upd = runCaptured('git', ['-C', mirror, 'update-ref', 'refs/heads/release-current', sha], { cwd: mirror });
  if (upd.status !== 0) return { ok: false, error: `update-ref 失败: ${upd.stderr.trim()}` };
  const back = runCaptured('git', ['-C', mirror, 'rev-parse', 'refs/heads/release-current'], { cwd: mirror });
  const now = back.stdout.trim();
  if (back.status !== 0 || now !== sha) {
    return {
      ok: false,
      error:
        `update-ref 后回读不符：期望 ${sha}，实得 ${JSON.stringify(now)}` +
        `（rev-parse exit ${back.status}）— 指针未被证实移动`,
    };
  }
  return { ok: true, sha };
}

export interface RollbackReport {
  verb: 'rollback';
  decision: Decision;
  ledgerPath: string;
  plan: RollbackPlan;
  approved: boolean;
  applied: boolean;
  mirrorRepointed: boolean;
  blockers: string[];
  notes: string[];
}

const USAGE = `apc release rollback [--ledger <path>] [--mirror <bare>] [--approved <token>] [--json]

真回滚（apc/01 §2）：release 状态账本回退 + 版本指针回退（本机替身 04 §4.5）。
  无审批 → dry-run 出回滚计划(3)；审批后执行(0)；无上一好版本 → blocked(1)
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = argv.includes('--json');
  const ledgerPath = argVal(argv, '--ledger') ?? DEFAULT_LEDGER;
  const mirror = argVal(argv, '--mirror');
  const approvedToken = argVal(argv, '--approved');

  const ledger = readLedger(ledgerPath);
  const plan = planRollback(ledger);
  const blockers: string[] = [];
  const notes: string[] = [];
  let applied = false;
  let mirrorRepointed = false;
  let decision: Decision;

  if (!plan.ok) {
    decision = 'blocked';
    blockers.push(plan.reason);
  } else if (!approvedToken) {
    decision = 'staged';
    notes.push(
      `回滚计划：${plan.from.version}(${plan.from.tag}) → ${plan.to.version}(${plan.to.tag})。` +
        `等待审批（本机：--approved <token>；真 approvalId = M5）`,
    );
  } else {
    // 执行。**先探测再写**（apc/12 §1 发现 A：两个副作用不原子，指针失败时不回滚账本 ⇒
    // 「账本已翻、指针没翻」的撕裂态，运维读到 exit 1 判「什么都没发生」而重试 ⇒ 越回退两档）。
    // 探测阶段只读不写：mirror 不可达 / 无该 tag / 解不到 commit，都在**账本一个字节没动**时
    // 判 blocked ⇒ 恢复了「blocked ⇒ 两侧都没动，可安全重试」这条运维靠它做决策的不变量。
    const probe = mirror ? resolveTagCommit(mirror, plan.to.tag) : null;
    if (probe && !probe.ok) {
      blockers.push(`版本指针回退失败（探测阶段，账本未写）: ${probe.error}`);
      notes.push('账本与指针**均未改动** —— 探测先于写入，修好 mirror/tag 后可直接重跑，不会越回退。');
      decision = 'blocked';
    } else {
      writeLedger(ledgerPath, plan.next);
      applied = true;
      notes.push(`账本已回退：${plan.from.version} → pulled，${plan.to.version} → current（${ledgerPath}）`);
      if (mirror) {
        const r = repointMirror(mirror, plan.to.tag);
        if (r.ok) {
          mirrorRepointed = true;
          notes.push(`版本指针回退：refs/heads/release-current → ${plan.to.tag}（${r.sha}，已回读核对）`);
        } else {
          // 探测已过却在此失败 = 探测后被并发改动 / ref lock / 磁盘级故障。窗口很窄但非零，
          // 且此时**确实**是撕裂态 ⇒ blocker 必须明说，绝不能让运维当成「什么都没发生」。
          blockers.push(
            `版本指针回退失败（⚠️ 撕裂态：账本已回退但指针未动，**不要直接重跑**，重跑会再回退一档；` +
              `先人工核对 ${ledgerPath} 与 mirror 的 refs/heads/release-current）: ${r.error}`,
          );
        }
      }
      notes.push('回归红回滚后应建 bug task 回 bugfix 入口（真 task 创建 = M5 / S10 observability）');
      decision = blockers.length > 0 ? 'blocked' : 'green';
    }
  }

  const report: RollbackReport = {
    verb: 'rollback',
    decision,
    ledgerPath,
    plan,
    approved: Boolean(approvedToken),
    applied,
    mirrorRepointed,
    blockers,
    notes,
  };

  await emit(
    json,
    [
      `[rollback] decision=${decision}`,
      plan.ok ? `  plan: ${plan.from.version} → ${plan.to.version}` : `  plan: 无法回滚（${plan.reason}）`,
      `  approved=${Boolean(approvedToken)} applied=${applied} mirrorRepointed=${mirrorRepointed}`,
      ...blockers.map((b) => `  ✗ ${b}`),
      ...notes.map((n) => `  · ${n}`),
    ].join('\n'),
    report as unknown as Record<string, unknown>,
  );

  return decisionExit(decision);
}

function argVal(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
