/**
 * platform-install.ts — 把 APC skill bundle 装到**平台方 workspace**（apc/00 §2.4 + 04 M1）。
 *
 * doc 04 M1「分发口径」原文：
 *   「catalog scoped 导入（`publishScope: private`）+ 只安装到平台方 workspace 的
 *     agent（IMAgentSkill 逐个装，**非** defaultEnabled / reupsert-built-ins 全局面）」
 *
 * ── 治 doc 13 的 C6（两条，都在这里显式回答）─────────────────────────────
 *
 * C6-a「纯库无 runnable 入口、apc 不 wire」→ 本文件有 `main()`，且注册进
 *      `bin/apc.ts` 的 `apc skills platform-install`。
 *
 * C6-b「`PRIVATE_PUBLISH_SCOPES` 多放行 'workspace'」→ **该常量随旧目录一起删了，
 *      全仓 grep 零命中**（复核见交付报告）。更要紧的是：按现在的 schema，
 *      **'workspace' 恰恰就是唯一的私域值，不是"多放行"**——
 *        `prisma/schema.mysql.prisma:2148-2157`
 *          「publishScope: workspace (私域, default) | marketplace (公域, explicit publish)
 *            —— binary semantics per product204/16 §2.2 (migration 500);
 *            legacy values private/org/community are backfilled away」
 *      所以 doc 04 写的 `publishScope: private` 是**过时字面量**，真值域里没有
 *      'private'。本实现按真值域收紧成一条不变量：
 *
 *        **平台方专属 = `publishScope === 'workspace'`（私域）+ 装载面靠
 *          workspaceId 圈定；publishScope 一旦是 'marketplace' 就 fail-closed 中止。**
 *
 *      即：不重新引入任何"允许集"常量（多值集合正是 C6 说的病），只留一个单值。
 *
 * ── 不新建服务端能力（全部对码的既有面）──────────────────────────────
 *   读 bundle      `runtime/src/bundle/index.ts:85 readBundle` / `:126 validateBundle`
 *                  / `:196 buildSkillCreateBody`（`cloud skill validate|package` 同一套）
 *   catalog 导入   `POST /api/im/skills`（`src/im/api/skills.ts:560`；SDK
 *                  `im.evolution.skills.create` = `index.ts:1405`）。服务端建行时
 *                  `publishScope` 走 schema 默认 'workspace'（`skill.service.ts:800-840`
 *                  只有 `draft:true` 才显式写它）⇒ 天然私域。
 *   已存在则更新   `PATCH /api/im/skills/:id`（`src/im/api/skills.ts:660`；SDK `:1410`）
 *   装到 agent     `POST /api/im/agents/:agentId/skills`（`src/im/api/agents.ts:390`，
 *                  body `{skillId|slug, workspaceId}`，门 = `canManageAgentSkills`
 *                  admin/workspace owner/agent token；SDK `im.agents.skills.install`
 *                  = `index.ts:1508`）→ 落 `im_agent_skills` 一行。
 *
 * ⚠️ slug 分叉（对码坐实，不是猜）：`POST /api/im/skills` 的 catalog slug 由
 * `skill.service.ts:1518 toSlug(name, 'community')` 派生 = `community-<frontmatter.name>`，
 * **不等于** bundle 的 SS-01 slug。所以导入后一律以服务端返回的 slug/id 为准去装。
 *
 * 用法：
 *   apc skills platform-install <bundleDir...> --workspace <id> [--agent <imUserId>]… [--json]
 *   exit 0 全绿 · 1 有失败 · 2 用法错
 */
import { readBundle, validateBundle, buildSkillCreateBody } from '../../prismer/src/bundle/index';
import { PrismerClient } from '../../cloud/src/index';
import { apcClient } from './ack-receipts';
import { assertNotBuiltInSkills, BundleGuardError, REPO_ROOT } from './bundle-guard';

/**
 * 平台方专属所要求的域标记。**单值，不是允许集**——见文件头 C6-b。
 * `prisma/schema.mysql.prisma:2157` `publishScope String @default("workspace")`.
 */
export const PLATFORM_PRIVATE_SCOPE = 'workspace';

export interface PlatformInstallOptions {
  workspaceId: string;
  agentIds: string[];
  repoRoot?: string;
  client?: PrismerClient;
}

export interface PlatformInstallResult {
  dir: string;
  /** bundle 的 SS-01 slug（frontmatter.name）。 */
  bundleSlug: string;
  /** catalog 行的真实 slug（`community-<name>`）。 */
  catalogSlug: string;
  catalogSkillId: string;
  publishScope: string;
  catalogAction: 'created' | 'updated';
  /** 真装上的 agent（每个对应 `im_agent_skills` 一行）。 */
  installedAgentIds: string[];
}

type SkillRow = { id?: string; slug?: string; publishScope?: string };

async function getSkill(client: PrismerClient, slugOrId: string): Promise<SkillRow | null> {
  const res = await client.im.request<{ ok?: boolean; data?: SkillRow }>(
    'GET',
    `/api/im/skills/${encodeURIComponent(slugOrId)}`,
  );
  return res?.ok && res.data ? res.data : null;
}

/**
 * 装一个 bundle：validate → catalog 导入/更新 → 私域断言 → 逐 agent 安装。
 * 任一步失败即抛（fail-closed，不做部分成功的静默降级）。
 */
export async function platformInstallBundle(
  dir: string,
  opts: PlatformInstallOptions,
): Promise<PlatformInstallResult> {
  // 守卫先跑：built-in 通用集不走平台方专属装载面（apc/00 §2.4）。
  assertNotBuiltInSkills(dir, opts.repoRoot ?? REPO_ROOT);

  const bundle = readBundle(dir);
  const v = validateBundle(bundle);
  if (!v.ok) {
    throw new Error(`${dir}: SS-01 bundle invalid — ${v.errors.join('; ')}`);
  }
  const { slug: bundleSlug, createBody } = buildSkillCreateBody(bundle);

  const client = opts.client ?? apcClient();

  // catalog slug 由服务端 toSlug(name,'community') 派生；先探这个真名，
  // 再回落探 bundle slug（built-in 风格的行会用后者）。
  const derived = `community-${bundleSlug}`;
  const existing = (await getSkill(client, derived)) ?? (await getSkill(client, bundleSlug));

  let row: SkillRow | null;
  let catalogAction: 'created' | 'updated';
  if (existing?.id) {
    const res = await client.im.request<{ ok?: boolean; data?: SkillRow; error?: { message?: string } }>(
      'PATCH',
      `/api/im/skills/${encodeURIComponent(existing.id)}`,
      {
        description: createBody.description,
        category: createBody.category,
        content: createBody.content,
        ...(createBody.contentManifest ? { contentManifest: createBody.contentManifest } : {}),
        ...(createBody.contentManifestRevision
          ? { contentManifestRevision: createBody.contentManifestRevision }
          : {}),
        // PATCH 对 marketplace 上架行强制要 changelog（`api/skills.ts:660` 注释
        // + product204/21 §2.8）；私域行也带上，无害且留痕。
        changelog: `apc platform-install: ${bundleSlug}`,
      },
    );
    if (!res?.ok) throw new Error(`${dir}: catalog update failed — ${res?.error?.message ?? 'unknown'}`);
    row = (await getSkill(client, existing.id)) ?? { ...existing, ...(res.data ?? {}) };
    catalogAction = 'updated';
  } else {
    const res = await client.im.request<{ ok?: boolean; data?: SkillRow; error?: string | { message?: string } }>(
      'POST',
      '/api/im/skills',
      createBody,
    );
    if (!res?.ok || !res.data?.id) {
      const e = res?.error;
      throw new Error(`${dir}: catalog create failed — ${typeof e === 'string' ? e : (e?.message ?? 'unknown')}`);
    }
    row = (await getSkill(client, res.data.id)) ?? res.data;
    catalogAction = 'created';
  }

  const skillId = row?.id;
  const catalogSlug = row?.slug ?? derived;
  const publishScope = row?.publishScope ?? '';
  if (!skillId) throw new Error(`${dir}: catalog row has no id after ${catalogAction}`);
  // 平台方专属不变量 —— 公域行绝不继续往 agent 上装。
  if (publishScope !== PLATFORM_PRIVATE_SCOPE) {
    throw new Error(
      `${dir}: catalog row ${catalogSlug} has publishScope='${publishScope}', expected '${PLATFORM_PRIVATE_SCOPE}' ` +
        '(apc/00 §2.4 平台方专属 — a marketplace-scoped row is a public shelf, not a platform-only asset)',
    );
  }

  const installedAgentIds: string[] = [];
  for (const agentId of opts.agentIds) {
    const res = await client.im.request<{ ok?: boolean; error?: string | { message?: string } }>(
      'POST',
      `/api/im/agents/${encodeURIComponent(agentId)}/skills`,
      { skillId, workspaceId: opts.workspaceId },
    );
    if (!res?.ok) {
      const e = res?.error;
      throw new Error(
        `${dir}: install to agent ${agentId} failed — ${typeof e === 'string' ? e : (e?.message ?? 'unknown')}`,
      );
    }
    installedAgentIds.push(agentId);
  }

  return {
    dir,
    bundleSlug,
    catalogSlug,
    catalogSkillId: skillId,
    publishScope,
    catalogAction,
    installedAgentIds,
  };
}

const USAGE = `apc skills platform-install <bundleDir...> --workspace <id> [--agent <imUserId>]... [--json]

把 APC skill bundle 导入 catalog（私域 publishScope='workspace'）并逐个装到平台方
workspace 的 agent（im_agent_skills 一行/agent）。apc/00 §2.4 · apc/04 M1。

  --workspace <id>   平台方 workspace id（必填）
  --agent <id>       目标 agent 的 IMUser id，可重复
  --json             结构化输出

拒绝任何落在 sdk/prismer-cloud/built-in-skills/ 内的目录。
exit 0 全绿 · 1 有失败 · 2 用法错
`;

function collectRepeated(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]!);
    else if (argv[i]!.startsWith(`${flag}=`)) out.push(argv[i]!.slice(flag.length + 1));
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const workspaceId = collectRepeated(argv, '--workspace')[0] ?? '';
  const agentIds = collectRepeated(argv, '--agent');

  const consumed = new Set<number>();
  argv.forEach((a, i) => {
    if (a === '--workspace' || a === '--agent') consumed.add(i + 1);
  });
  const dirs = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i));

  if (dirs.length === 0 || !workspaceId) {
    process.stderr.write(USAGE);
    return 2;
  }

  const results: Array<PlatformInstallResult | { dir: string; error: string; code?: string }> = [];
  let failed = 0;
  for (const dir of dirs) {
    try {
      results.push(await platformInstallBundle(dir, { workspaceId, agentIds }));
    } catch (e) {
      failed++;
      results.push({
        dir,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof BundleGuardError ? { code: e.code } : {}),
      });
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed === 0, workspaceId, results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      if ('error' in r) process.stderr.write(`✗ ${r.dir}: ${r.error}\n`);
      else
        process.stdout.write(
          `✓ ${r.dir} → ${r.catalogSlug} (${r.catalogAction}, scope=${r.publishScope}) ` +
            `installed on ${r.installedAgentIds.length} agent(s)\n`,
        );
    }
  }
  return failed === 0 ? 0 : 1;
}
