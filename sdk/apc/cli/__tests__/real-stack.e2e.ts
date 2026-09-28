#!/usr/bin/env npx tsx
/**
 * real-stack.e2e.ts — M1-c + M1-e 的**真栈**端到端（本机 cloud:3000 + MySQL:3307）。
 *
 * 为什么是独立 tsx 脚本而不是 vitest 用例：它要求活的 cloud + 活的 MySQL。
 * 环境不在 = `env_blocked` 故障域（apc/06 §3），**不是 SUT 红**——塞进默认 vitest 门
 * 会让没起 stack 的机器看到假红，那正是本专项要杜绝的判定混域。
 * 跑法：
 *   npx tsx sdk/apc/cli/__tests__/real-stack.e2e.ts
 *   exit 0 全绿 · 1 有断言红 · 78 env_blocked（cloud/MySQL 不可达）
 *
 * oracle **全部取 DB 行**（mysql2 直查），不取 CLI 的自述：
 *   R1  platform-install → `im_skills` 一行，`publish_scope='workspace'`（私域）
 *   R2  platform-install → 每个 agent 一行 `im_agent_skills`
 *   R3  `cloud skill ack` → `im_task_logs` 一行 `action='skill_ack'` + metadata.skillSlug
 *   R4  `apc skills ack-receipts --expect <slug>` 读到 R3 那一行 → exit 0
 *   N1  负控：没 ack 过的 slug → ack-receipts exit 1（回执缺失即判红）
 *   N2  负控：无 task 上下文（不给 --task、清 PRISMER_TASK_ID）→ `cloud skill ack` **exit 3**
 *        且 `im_task_logs` 零新增（承重：exit 3 ≠ 成功，也不许偷偷写行）
 *   N3  负控：platform-install 指向真 built-in-skills → 非零退出 + `im_skills` 零新增
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { REPO_ROOT, BUILT_IN_SKILLS_REL } from '../bundle-guard';

const CLOUD = process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL ?? 'mysql://prismer:devpass@127.0.0.1:3307/prismer_cloud';
const WORKSPACE_ID = process.env.APC_E2E_WORKSPACE_ID ?? 'cmrnx2igf0091xzita9h1ur5f';
/**
 * ⚠️ 这里要的是 agent 的 **IMUser id**（`im_users.id`），不是 `/api/im/agents` 响应里
 * 那个 `agentId` 字段——后者是 IMAgent 行 id。IMUser id 在同一响应的 `userId` 字段。
 * 传错会被 `canManageAgentSkills`（`src/im/api/agents.ts:1146`）判 403
 * "Admin, workspace owner, or agent token required"（本脚本首跑就踩了这条）。
 */
const AGENT_IDS = (process.env.APC_E2E_AGENT_IDS ?? 'wp8tfzma26e,2dviza7p10t').split(',');

const CLOUD_CLI = join(REPO_ROOT, 'sdk', 'prismer-cloud', 'typescript', 'src', 'cli.ts');
const APC_CLI = join(REPO_ROOT, 'sdk', 'apc', 'bin', 'apc.ts');

let failures = 0;
function check(name: string, ok: boolean, evidence: unknown): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${JSON.stringify(evidence)}\n`);
  if (!ok) failures++;
}

interface RunOut {
  status: number | null;
  stdout: string;
  stderr: string;
}
function run(file: string, args: string[], env: Record<string, string | undefined> = {}): RunOut {
  const r = spawnSync('npx', ['tsx', file, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
  // 证据完整保留（memory `test204证据销毁反pattern`：别只留首行）。
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const DESCRIPTION =
  'APC real-stack end-to-end fixture skill; long enough to clear the SS-01 fifty-character description floor for ingest gates.';

function makeFixtureBundle(slug: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'apc-e2e-')), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${DESCRIPTION}\n---\n\n# ${slug}\n\nfixture body\n`,
    'utf8',
  );
  return dir;
}

async function main(): Promise<number> {
  // ── env 可达性（不可达 = env_blocked，不是 SUT 红）────────────────────────
  let db: mysql.Connection;
  try {
    const ping = await fetch(`${CLOUD}/api/health`).catch(() => null);
    if (!ping || !ping.ok) throw new Error(`cloud ${CLOUD} unreachable`);
    db = await mysql.createConnection(DB_URL);
    await db.query('SELECT 1');
  } catch (e) {
    process.stderr.write(`env_blocked: ${(e as Error).message}\n`);
    return 78;
  }

  let cleanupTaskId: string | undefined;
  const stamp = Date.now().toString(36);
  const slug = `apc-e2e-${stamp}`;
  const apiKey = process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY;
  const cloudEnv = { PRISMER_BASE_URL: CLOUD, ...(apiKey ? { PRISMER_API_KEY: apiKey } : {}) };
  const apcEnv = { APC_CLOUD_BASE_URL: CLOUD, ...(apiKey ? { APC_API_KEY: apiKey } : {}) };

  try {
    // ── 注入器先跑（M1-c）：产物进 catalog 的就是带 ack 块的 SKILL.md ────────
    const dir = makeFixtureBundle(slug);
    const inj = run(APC_CLI, ['skills', 'inject-ack', dir, '--json']);
    check('inject-ack exit 0', inj.status === 0, { status: inj.status, stderr: inj.stderr.slice(-400) });

    // ── R1/R2 platform-install（M1-e）─────────────────────────────────────
    const agentArgs = AGENT_IDS.flatMap((a) => ['--agent', a]);
    const inst = run(
      APC_CLI,
      ['skills', 'platform-install', dir, '--workspace', WORKSPACE_ID, ...agentArgs, '--json'],
      apcEnv,
    );
    check('platform-install exit 0', inst.status === 0, {
      status: inst.status,
      stdout: inst.stdout.slice(-600),
      stderr: inst.stderr.slice(-600),
    });

    const [skillRows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT id, slug, publish_scope, lifecycle_stage, fileCount, content FROM im_skills WHERE slug = ?',
      [`community-${slug}`],
    );
    check(
      'R1 im_skills 一行 + publish_scope=workspace（私域）',
      skillRows.length === 1 && skillRows[0]!.publish_scope === 'workspace',
      skillRows[0] ? { ...skillRows[0], content: `<${String(skillRows[0].content).length} chars>` } : null,
    );
    // M1-c × M1-e 的接缝：进 catalog 的 SKILL.md **必须**带着 ack 纪律块，
    // 否则 daemon skill-sync 分发下去的 prompt 里根本没有回执指令，层1 全空。
    const catalogContent = String(skillRows[0]?.content ?? '');
    check(
      'R1b catalog 行的 content 带 ack 命令（注入器产物真的进了 catalog）',
      catalogContent.includes(`cloud skill ack ${slug} --task "$PRISMER_TASK_ID"`) &&
        catalogContent.includes('<!-- APC-ACK:v1 -->'),
      { hasCmd: catalogContent.includes(`cloud skill ack ${slug}`), len: catalogContent.length },
    );

    const skillId = skillRows[0]?.id as string | undefined;
    const [agentSkillRows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT agentId, skillId, status FROM im_agent_skills WHERE skillId = ? ORDER BY agentId',
      [skillId ?? ''],
    );
    check(
      `R2 im_agent_skills ${AGENT_IDS.length} 行（逐 agent 装）`,
      agentSkillRows.length === AGENT_IDS.length &&
        AGENT_IDS.every((a) => agentSkillRows.some((r) => r.agentId === a)),
      agentSkillRows,
    );

    // ── N3 负控：指向真 built-in-skills → 零 catalog 新增 ─────────────────
    const [beforeCount] = await db.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM im_skills');
    const guard = run(
      APC_CLI,
      [
        'skills',
        'platform-install',
        join(REPO_ROOT, BUILT_IN_SKILLS_REL, 'memory'),
        '--workspace',
        WORKSPACE_ID,
        '--agent',
        AGENT_IDS[0]!,
        '--json',
      ],
      apcEnv,
    );
    const [afterCount] = await db.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM im_skills');
    check(
      'N3 built-in 守卫：非零退出 + im_skills 零新增',
      guard.status === 1 && Number(beforeCount[0]!.n) === Number(afterCount[0]!.n),
      { status: guard.status, before: beforeCount[0]!.n, after: afterCount[0]!.n },
    );

    // ── R3/R4 ack 回执（M1-c）─────────────────────────────────────────────
    const meRes = await fetch(`${CLOUD}/api/im/me`, {
      headers: { Authorization: `Bearer ${apiKey ?? ''}` },
    }).then((r) => r.json() as Promise<{ data?: { user?: { id?: string } } }>);
    const meId = meRes.data?.user?.id;
    if (!meId) throw new Error('cannot resolve caller imUserId from /api/im/me');

    const created = run(
      CLOUD_CLI,
      ['task', 'create', '--title', `apc e2e ${stamp}`, '--assignee-id', meId, '--json'],
      cloudEnv,
    );
    const taskId = (JSON.parse(created.stdout.slice(created.stdout.indexOf('{'))) as { data?: { id?: string } }).data?.id;
    if (!taskId) throw new Error(`task create failed: ${created.stdout.slice(-400)}${created.stderr.slice(-400)}`);

    const ack = run(CLOUD_CLI, ['skill', 'ack', slug, '--task', taskId], cloudEnv);
    check('R3a cloud skill ack exit 0', ack.status === 0, { status: ack.status, stderr: ack.stderr.slice(-300) });

    const [logRows] = await db.query<mysql.RowDataPacket[]>(
      "SELECT action, actorId, metadata FROM im_task_logs WHERE taskId = ? AND action = 'skill_ack'",
      [taskId],
    );
    const md = logRows[0] ? (JSON.parse(String(logRows[0].metadata)) as Record<string, unknown>) : {};
    check(
      'R3b im_task_logs 一行 action=skill_ack + metadata.skillSlug 对得上',
      logRows.length === 1 && md.skillSlug === slug && md.code === 'SKILL_ACK' && logRows[0]!.actorId === meId,
      { rows: logRows.length, md, actorId: logRows[0]?.actorId },
    );

    const readBack = run(APC_CLI, ['skills', 'ack-receipts', taskId, '--expect', slug, '--json'], apcEnv);
    check('R4 ack-receipts 读到回执 → exit 0', readBack.status === 0, {
      status: readBack.status,
      stdout: readBack.stdout.slice(-400),
    });

    // ── N1 负控：没 ack 过的 slug → 判红 ──────────────────────────────────
    const missing = run(APC_CLI, ['skills', 'ack-receipts', taskId, '--expect', `${slug}-never`, '--json'], apcEnv);
    const missingJson = JSON.parse(missing.stdout) as { missing?: string[]; ok?: boolean };
    check('N1 回执缺失 → exit 1 且 missing 列出该 slug', missing.status === 1 && missingJson.ok === false && missingJson.missing?.[0] === `${slug}-never`, {
      status: missing.status,
      missing: missingJson.missing,
    });

    // ── N2 负控：无 task 上下文 → exit 3 且零写入 ─────────────────────────
    const [beforeLogs] = await db.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM im_task_logs WHERE taskId = ?',
      [taskId],
    );
    const noCtx = run(CLOUD_CLI, ['skill', 'ack', slug], { ...cloudEnv, PRISMER_TASK_ID: '' });
    const [afterLogs] = await db.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM im_task_logs WHERE taskId = ?',
      [taskId],
    );
    check(
      'N2 无 task 上下文 → exit 3（不是 0，也不是 1）且 im_task_logs 零新增',
      noCtx.status === 3 && Number(beforeLogs[0]!.n) === Number(afterLogs[0]!.n),
      { status: noCtx.status, before: beforeLogs[0]!.n, after: afterLogs[0]!.n },
    );

    process.stdout.write(`\nartifacts: skill=community-${slug} task=${taskId}\n`);
    cleanupTaskId = taskId;
  } finally {
    // 清理 fixture catalog 行（断言已经跑完）——本机 catalog 不留 e2e 垃圾，
    // 沿 memory `marketplace垃圾清理` 的教训。
    await db
      .query('DELETE a FROM im_agent_skills a JOIN im_skills s ON a.skillId = s.id WHERE s.slug = ?', [
        `community-${slug}`,
      ])
      .catch(() => {});
    await db.query('DELETE FROM im_skills WHERE slug = ?', [`community-${slug}`]).catch(() => {});
    // fixture task 也一起收掉，否则每跑一次就在看板上多一条垃圾。
    if (cleanupTaskId) {
      await db.query('DELETE FROM im_task_logs WHERE taskId = ?', [cleanupTaskId]).catch(() => {});
      await db.query('DELETE FROM im_tasks WHERE id = ?', [cleanupTaskId]).catch(() => {});
    }
    await db.end();
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`}\n`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write(`crash: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
