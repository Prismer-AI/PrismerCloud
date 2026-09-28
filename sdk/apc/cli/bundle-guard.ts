/**
 * bundle-guard.ts — APC skill bundle 的分发面守卫（apc/00 §2.4 + apc/04 §2 层1）。
 *
 * 一条不变量：**ack 纪律 / platform-install 只作用于 APC 专项的 18 个 skill bundle
 * （2026-08-03 裁决 ui-align + ui-canvas 并存，见 docs/apc/22），绝不下发到
 * `sdk/cloud/catalog/skills/` 的通用内置集。**
 *
 * 为什么要写成守卫而不是靠纪律（apc/04 §2 层1 原文）：
 *   「注入范围只限 APC 17 个（00 §2.4：ack 是平台方工作台的运营纪律，不下发 39 个
 *     通用 built-in——普通用户的 skill 不背平台运营遥测）」
 * built-in 目录是**全体用户的 defaultEnabled 分发面**（`built-in-skill.service.ts`
 * 递归 upsert 整棵树 → im_skills → daemon skill-sync 装到每个 agent）。一次误注入
 * 就把平台方的运营遥测指令下发给了所有租户的 agent，而且会随 merkle 变更静默传播。
 * 所以这里是 **fail-closed 且零副作用**：守卫在任何 fs 写之前抛。
 */
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
// 仓库根**复用** env/probes 的既有常量，不第二次定义（doc 13 E4 记的正是
// "复用不重造" 被违背的那类 drift）。
export { REPO_ROOT } from '../env/probes';

/** 通用内置集根目录（相对 repo 根）。`built-in-skill.service.ts:  resourcePath` 同源。 */
export const BUILT_IN_SKILLS_REL = 'sdk/cloud/catalog/skills';

export class BundleGuardError extends Error {
  constructor(
    message: string,
    readonly code: 'built_in_forbidden',
  ) {
    super(message);
    this.name = 'BundleGuardError';
  }
}

/** 把路径归一到「已解 symlink 的绝对路径 + 末尾分隔符」，便于做前缀包含判断。 */
function normalizeDir(p: string): string {
  const abs = resolve(p);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // 目录不存在 —— 交给调用方的 readBundle 报「bundle dir not found」，
    // 守卫这里仍用词法路径判定（不存在的路径同样可能指向 built-in 树）。
  }
  return real.endsWith(sep) ? real : real + sep;
}

/**
 * 若 `dir` 落在通用内置集内（含任意深度子目录），抛 `BundleGuardError`。
 *
 * `repoRoot` 显式传入而非从 `__dirname` 推——测试要能对**临时目录里造的假
 * built-in 树**验这条守卫，不能只验真仓库那一棵（那样测试会依赖仓库布局，
 * 且无法区分"守卫生效"与"路径恰好不匹配"）。
 */
export function assertNotBuiltInSkills(dir: string, repoRoot: string): void {
  const forbidden = normalizeDir(resolve(repoRoot, BUILT_IN_SKILLS_REL));
  const target = normalizeDir(dir);
  if (target === forbidden || target.startsWith(forbidden)) {
    throw new BundleGuardError(
      `refusing to touch "${dir}": it is inside ${BUILT_IN_SKILLS_REL}. ` +
        'APC ack discipline / platform-install apply ONLY to the APC专项 bundles ' +
        '(apc/00 §2.4) — the general built-in set is every tenant\'s defaultEnabled ' +
        'distribution surface and must not carry platform-operations telemetry.',
      'built_in_forbidden',
    );
  }
}
