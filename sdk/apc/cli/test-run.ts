/**
 * test-run.ts — `apc test`（apc/02 §2 R1 · 05 A1 S7 的唯一调用面）。
 *
 * ## 这是**包装层**，不是第二个编排器
 *
 * 02 §2 R1 的落点写死了：编排器是既有资产 `scripts/test203/run.ts` 的**原位扩展**，
 * `apc test` 只负责把 skill / 自动循环的调用翻译成对它的一次子进程调用。所以这里
 * **没有任何 tier 知识**——tier 表、doctor 前置段、baseline diff、env_blocked 都在
 * run.ts 里，本文件多知道一点都是漂移源（14 B6 就是"第二份 ground truth"的病）。
 *
 * ## 三条硬约束
 *
 * 1. **退出码原样透传**，含 `78`（env_blocked，环境故障域 ≠ SUT 红）与 `2`（用法错）。
 *    S7 skill 靠它区分"代码红"与"环境红"；把 78 折成 1 会让 H2 去 redispatch 一个
 *    根本没跑的圈次（06 §3 纪律 2）。
 * 2. **stdout 原样透传**：`--json` 下 run.ts 的 `test203.run/v1` 结构化产物（含每层
 *    `TierResult`）必须逐字节到达调用方，本层不重排、不包一层信封。人读报告在 stderr。
 * 3. **参数原样透传**：`--tier/--diff/--json/--baseline/--list/--help` 等全部交给 run.ts
 *    校验（未知 tier → run.ts exit 2）。本层不复制一份 flag 白名单。
 *
 * 用法：
 *   apc test --tier=T0,T1 --diff --json
 *   apc test --tier=T4 --list
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** repo 根（sdk/apc/cli/ → ../../..；形状照 `env/probes.ts:26`）。run.ts 的相对路径以它为基准。 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const RUNNER = 'scripts/test203/run.ts';

/** 被信号杀死时没有退出码可透传；用一个**独立**的非零码，绝不折成 0。 */
export const SIGNAL_EXIT = 1;

export function main(argv: string[]): number {
  const r = spawnSync('npx', ['tsx', RUNNER, ...argv], {
    cwd: REPO_ROOT,
    stdio: 'inherit', // stdout/stderr 逐字节透传（约束 2）
  });
  if (r.error) {
    process.stderr.write(`apc test: 无法启动 ${RUNNER} —— ${r.error.message}\n`);
    return SIGNAL_EXIT;
  }
  if (r.status === null) {
    process.stderr.write(`apc test: ${RUNNER} 被信号终止（${r.signal ?? 'unknown'}）—— 无退出码可透传\n`);
    return SIGNAL_EXIT;
  }
  return r.status;
}
