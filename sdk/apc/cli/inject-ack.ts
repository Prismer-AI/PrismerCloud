/**
 * inject-ack.ts — **层 1 调用回执**的统一注入器（apc/04 §2 裁决一）。
 *
 * doc 04 §2 层 1 原文：
 *   「专项 skill 的 SKILL.md 尾部由打包器统一注入一行纪律：执行本 skill 时先
 *     `cloud skill ack <slug> --task <taskId>` … oracle 读 DB 回执行——这是**副作用
 *     不是文本**，且对 17 个 APC skill 零定制。**注入范围只限 APC 17 个**。」
 *
 * （注：apc/04 原文写「17 个」；2026-08-03 裁决 ui-align + ui-canvas 并存后
 *   `sdk/apc/skills/` 为 18 目录——注入范围跟随目录全集、计数不焊死，见
 *   docs/apc/22 与 spec15 PKF-G2 inventory 冻结测试。）
 *
 * ── 三条承重设计（每条都对码，不是转述）─────────────────────────────────
 *
 * 1. **exit 3 必须分流，`|| true` 是错的**（apc/11 §0.7 "遗留的设计裁决"）。
 *    `cloud skill ack` 的真实退出码语义在
 *    `sdk/cloud/src/commands/skill.ts:535-536`：
 *      0 = 回执落库 · 1 = 请求失败 · 3 = 无 task 上下文 · 4 = 调用者不是 assignee。
 *    exit 3 **不是失败**（skill 该继续跑），但**更不是"已回执"**——注入
 *    `|| true` 会把这两种状态压成同一个 0，于是"没有回执"冒充"有回执"，
 *    层 1 的整个 oracle 作废。所以：
 *      · 生成的纪律块把 4 个退出码逐条写死；
 *      · `renderAckBlock()` 自带 fail-closed 扫描（`assertNoExitCodeSwallow`），
 *        任何吞退出码的写法混进命令行就抛，**注入器本身不许产出错误纪律**。
 *
 * 2. **幂等**：块由 `APC-ACK:v1` 起止标记界定。已存在 → 用 canonical 文本原地替换；
 *    若替换后字节与原文件完全一致，**不写盘**（`changed:false`）。于是"重复跑"
 *    既不重复注入、也不产生任何 diff，同时保留将来 bump 块版本的能力。
 *
 * 3. **built-in 守卫**（apc/00 §2.4）：见 `bundle-guard.ts`。守卫在任何 fs 读写
 *    **之前**跑 —— 负控要断言的是"零文件改动"，不是"改了又回滚"。
 *
 * 用法：
 *   apc skills inject-ack <bundleDir...> [--json]
 *   exit 0 全部处理成功 · 1 有 bundle 失败（含守卫拒绝）· 2 用法错
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readBundle } from '../../prismer/src/bundle/index';
import { assertNotBuiltInSkills, BundleGuardError, REPO_ROOT } from './bundle-guard';

export const ACK_BLOCK_BEGIN = '<!-- APC-ACK:v1 -->';
export const ACK_BLOCK_END = '<!-- /APC-ACK:v1 -->';

/**
 * 吞退出码的写法黑名单。命中任意一条 = 生成器抛错。
 * （`|| :` 与 `|| true` 等价；`; true` / `set +e` 同样把非零码抹掉；
 *  `2>/dev/null` 不吞退出码但会吞掉 exit 4 的 escalate 线索，一并禁。）
 */
const EXIT_CODE_SWALLOWERS = ['|| true', '||true', '|| :', '||:', '; true', 'set +e', '2>/dev/null'];

/** 注入块里那条唯一的可执行命令（`<slug>` 由调用方替换成真 slug）。 */
export function ackCommandFor(slug: string): string {
  return `cloud skill ack ${slug} --task "$PRISMER_TASK_ID"`;
}

/**
 * fail-closed 自检：扫描块内 ``` 围栏中的命令行，命中黑名单即抛。
 *
 * 只扫围栏内（散文里可以正常讨论这些写法而不触发误报），且这正是 agent 会照抄的
 * 那部分文本。
 */
export function assertNoExitCodeSwallow(block: string): void {
  let inFence = false;
  for (const line of block.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    for (const bad of EXIT_CODE_SWALLOWERS) {
      if (line.includes(bad)) {
        throw new Error(
          `ack block would swallow the exit code (${JSON.stringify(bad)} in ${JSON.stringify(line.trim())}). ` +
            'apc/11 §0.7: exit 3 (no task context) must stay distinguishable from exit 0 (receipt landed).',
        );
      }
    }
  }
}

/** 生成 canonical 纪律块（含起止标记）。 */
export function renderAckBlock(slug: string): string {
  const block = [
    ACK_BLOCK_BEGIN,
    '',
    '## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）',
    '',
    '执行本 skill 的**第一步**，先落一条调用回执：',
    '',
    '```bash',
    ackCommandFor(slug),
    '```',
    '',
    '**按退出码分流**（这条命令的退出码是承重信息，禁止用 `||` 兜底、`; true`、',
    '`set +e` 或重定向把它抹掉）：',
    '',
    '| exit | 含义 | 你要做的 |',
    '| --- | --- | --- |',
    '| `0` | 回执已落库（`im_task_logs.action=\'skill_ack\'`） | 继续执行本 skill |',
    '| `3` | **无 task 上下文**——本次运行没有 task，产不出回执 | 继续执行本 skill；但本次运行**没有回执**，任何报告里都不得声称已 ack |',
    '| `4` | 你不是该 task 的 assignee，服务端拒绝 | 停下并上报：回执只能由执行该 task 的 agent 产生 |',
    '| `1` | 其它失败（网络 / 服务端） | 重试一次；仍失败则继续执行，并在结果里显式标注「回执缺失」 |',
    '',
    '回执只证明本 skill **被调度**，不证明**执行正确**——效果证明由本 skill 自己的',
    'acceptanceCriteria 副作用断言承担（apc/04 §2 层 1 诚实标注）。',
    '',
    ACK_BLOCK_END,
  ].join('\n');
  assertNoExitCodeSwallow(block);
  return block;
}

/**
 * 纯函数：把纪律块注入 SKILL.md 文本。已有块 → 原地替换；没有 → 追加到尾部。
 * 返回新文本（与入参相同即代表无变化）。
 */
export function injectAckIntoSkillMd(text: string, slug: string): string {
  const block = renderAckBlock(slug);
  const begin = text.indexOf(ACK_BLOCK_BEGIN);
  if (begin >= 0) {
    const endIdx = text.indexOf(ACK_BLOCK_END, begin);
    if (endIdx < 0) {
      throw new Error(
        `SKILL.md has an unterminated ack block (${ACK_BLOCK_BEGIN} without ${ACK_BLOCK_END}) — refusing to guess where it ends`,
      );
    }
    return text.slice(0, begin) + block + text.slice(endIdx + ACK_BLOCK_END.length);
  }
  const body = text.replace(/\s*$/, '');
  return `${body}\n\n${block}\n`;
}

export interface InjectResult {
  dir: string;
  slug: string;
  /** true = 真写了盘。重复跑必须是 false。 */
  changed: boolean;
  action: 'injected' | 'updated' | 'unchanged';
}

/**
 * 对一个 bundle 目录执行注入。**守卫先跑，任何 fs 写之前**。
 */
export function injectAckIntoBundle(dir: string, repoRoot: string = REPO_ROOT): InjectResult {
  assertNotBuiltInSkills(dir, repoRoot);

  // slug 取自 SKILL.md frontmatter.name（SS-01 §1：目录名 = frontmatter.name，
  // 且是 catalog 的业务主键来源）。用既有 bundle 库读，不自己再解一遍 YAML。
  const bundle = readBundle(dir);
  const slug = typeof bundle.frontmatter.name === 'string' ? bundle.frontmatter.name : '';
  if (!slug) {
    throw new Error(`${dir}: SKILL.md frontmatter.name missing — cannot render a concrete ack command`);
  }

  const skillMdPath = join(resolve(dir), 'SKILL.md');
  const original = readFileSync(skillMdPath, 'utf8');
  const had = original.includes(ACK_BLOCK_BEGIN);
  const next = injectAckIntoSkillMd(original, slug);
  if (next === original) {
    return { dir, slug, changed: false, action: 'unchanged' };
  }
  writeFileSync(skillMdPath, next, 'utf8');
  return { dir, slug, changed: true, action: had ? 'updated' : 'injected' };
}

const USAGE = `apc skills inject-ack <bundleDir...> [--json]

把 APC 层1 调用回执纪律块注入 SKILL.md 尾部（apc/04 §2）。幂等：重复跑零 diff。
拒绝任何落在 sdk/prismer-cloud/built-in-skills/ 内的目录（apc/00 §2.4）。

exit 0 全部成功 · 1 有失败 · 2 用法错
`;

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (dirs.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }

  const results: Array<InjectResult | { dir: string; error: string; code?: string }> = [];
  let failed = 0;
  for (const dir of dirs) {
    try {
      results.push(injectAckIntoBundle(dir));
    } catch (e) {
      failed++;
      const err = e as Error & { code?: string };
      results.push({
        dir,
        error: err.message,
        ...(e instanceof BundleGuardError ? { code: e.code } : {}),
      });
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed === 0, results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      if ('error' in r) process.stderr.write(`✗ ${r.dir}: ${r.error}\n`);
      else process.stdout.write(`${r.action === 'unchanged' ? '=' : '✓'} ${r.dir} (${r.slug}) ${r.action}\n`);
    }
  }
  return failed === 0 ? 0 : 1;
}
