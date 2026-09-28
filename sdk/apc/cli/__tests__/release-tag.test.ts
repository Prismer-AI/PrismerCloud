/**
 * release-tag.test.ts — 真验证（无 mock）。
 *
 *  A. 纯：computeTag / isProdTag。
 *  B. 真 git 副作用：tag push 到真 bare mirror，`git ls-remote` 核验（+ 负控：未审批/tier 红 不 push）。
 *  C. prod 人闸：--target prod 硬拒、绝不 push。
 *  tier 门经真 run.ts（seam 造绿/红）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeTag, isProdTag, PROD_PREFIXES } from '../release-tag';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const APC = 'sdk/apc/bin/apc.ts';
const TIMEOUT = 300_000;

function apc(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn('npx', ['tsx', APC, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

describe('computeTag / isProdTag — 纯', () => {
  it('算 tag 形状', () => {
    expect(computeTag('k8s', 'test', '2.2.4', '20260724')).toBe('k8s-test-20260724-v2.2.4');
    expect(computeTag('desktop', 'test', '2.2.4', '20260724')).toBe('desktop-test-20260724-v2.2.4');
  });
  it('全部 4 个 prod 前缀识别（不变量 2）', () => {
    for (const p of PROD_PREFIXES) expect(isProdTag(`${p}20260724-v1`)).toBe(true);
    expect(isProdTag('k8s-test-20260724-v1')).toBe(false);
  });
});

describe('apc release tag — 真 git 副作用 + 审批门 + tier 门', () => {
  let repo: string;
  let mirror: string;
  let selftest: string;
  let greenDoctor: string;
  let approvalServer: Server;
  let approvalBaseUrl: string;
  let taskSha: string;

  const TAG = 'k8s-test-20260101-v9.9.9';
  const TASK_ID = 'task-release-1';
  const APPROVAL_ID = 'approval-release-1';
  let approvalRecord: Record<string, unknown>;
  let taskMetadata: Record<string, unknown>;
  const commonEnv = () => ({
    TEST203_SELFTEST_ROOT: selftest,
    TEST203_DOCTOR_SCRIPT: greenDoctor,
    APC_CLOUD_BASE_URL: approvalBaseUrl,
    APC_API_KEY: 'sk-prismer-live-test',
  });
  const baseArgs = () => [
    'release', 'tag',
    '--channel', 'k8s', '--target', 'test', '--version', '9.9.9', '--date', '20260101',
    '--tier=TD', '--repo', repo, '--mirror', mirror, '--json',
  ];

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'apc-tag-repo-'));
    mirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-')) + '.git';
    // 真 working repo（要有一个 commit 才能 tag）
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'f'), 'x');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'init'], repo);
    taskSha = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    // 真 bare mirror
    spawnSync('git', ['init', '--bare', '-q', mirror], { encoding: 'utf8' });
    // seam：run.ts self-test 根
    selftest = mkdtempSync(join(tmpdir(), 'apc-tag-selftest-'));
    for (const d of ['contract', 'cookbook', 'journeys', 'probes', 'td']) mkdirSync(join(selftest, d), { recursive: true });
    greenDoctor = join(selftest, 'doctor-green.ts');
    writeFileSync(greenDoctor, "process.stdout.write(JSON.stringify({ items: [{ item: 'infra.cloud-3000', status: 'pass' }] }));\n");
    // apc/12 §0.12 修法 B：TD 层无 spec 时是「空跑」占位 skip（passed:0/failed:0），不再算
    // 绿证据。下面所有期待「tier 绿」的用例都需要至少一条真跑过的用例，所以在这里常驻放一个
    // 真的绿 TD spec；「负控 2：tier 红」会额外加一个失败 spec（此时 emptyRun 不成立，是真红）。
    writeFileSync(join(selftest, 'td', 'apc-tag-green.ts'), 'process.exit(0);\n');

    approvalServer = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/im/approvals')) {
        res.end(JSON.stringify({
          ok: true,
          data: [approvalRecord],
        }));
        return;
      }
      if (req.url === `/api/im/tasks/${TASK_ID}`) {
        res.end(JSON.stringify({ ok: true, data: { task: { id: TASK_ID, metadata: taskMetadata } } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolveListen) => approvalServer.listen(0, '127.0.0.1', resolveListen));
    const address = approvalServer.address();
    if (!address || typeof address === 'string') throw new Error('approval test server did not bind');
    approvalBaseUrl = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    taskMetadata = { commitSha: taskSha };
    approvalRecord = {
      id: APPROVAL_ID,
      taskId: TASK_ID,
      category: 'release_tag',
      status: 'approved',
      requestedById: 'requester-1',
      decidedById: 'reviewer-1',
      metadata: { commitSha: taskSha },
    };
  });
  afterAll(async () => {
    await new Promise<void>((resolveClose) => approvalServer.close(() => resolveClose()));
    for (const p of [repo, mirror, selftest]) rmSync(p, { recursive: true, force: true });
  });

  function tagInMirror(): boolean {
    const r = git(['ls-remote', '--tags', mirror], repo);
    return (r.stdout ?? '').includes(`refs/tags/${TAG}`);
  }

  it('随机字符串不是 cloud 批件 → blocked，mirror 零 tag', async () => {
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-random-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', TASK_ID, '--approved', 'yes'],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'blocked', pushed: false, approved: false });
      expect(git(['ls-remote', '--tags', freshMirror], repo).stdout.trim()).toBe('');
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('自批批件 requestedById===decidedById → blocked，mirror 零 tag', async () => {
    approvalRecord = { ...approvalRecord, decidedById: 'requester-1' };
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-self-approved-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', TASK_ID, '--approved', APPROVAL_ID],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'blocked', pushed: false, approved: false });
      expect(git(['ls-remote', '--tags', freshMirror], repo).stdout.trim()).toBe('');
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('批件 taskId 与 --task 不同 → blocked，mirror 零 tag', async () => {
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-wrong-task-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', 'task-release-other', '--approved', APPROVAL_ID],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'blocked', pushed: false, approved: false });
      expect(git(['ls-remote', '--tags', freshMirror], repo).stdout.trim()).toBe('');
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('pending 批件不是已批准证据 → blocked，mirror 零 tag', async () => {
    approvalRecord = { ...approvalRecord, status: 'pending' };
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-pending-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', TASK_ID, '--approved', APPROVAL_ID],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'blocked', pushed: false, approved: false });
      expect(git(['ls-remote', '--tags', freshMirror], repo).stdout.trim()).toBe('');
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('非 release_tag 类别不能冒充发版批件 → blocked，mirror 零 tag', async () => {
    approvalRecord = { ...approvalRecord, category: 'dev_entry' };
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-wrong-category-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', TASK_ID, '--approved', APPROVAL_ID],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'blocked', pushed: false, approved: false });
      expect(git(['ls-remote', '--tags', freshMirror], repo).stdout.trim()).toBe('');
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('HEAD 漂到 task commit 之后，tag 仍只指向批件与 task 共同绑定的 commit', async () => {
    writeFileSync(join(repo, 'later'), `parallel-${Date.now()}`);
    git(['add', 'later'], repo);
    git(['commit', '-qm', 'parallel line after approved task'], repo);
    const driftedHead = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    expect(driftedHead).not.toBe(taskSha);

    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-head-drift-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', TASK_ID, '--approved', APPROVAL_ID],
        commonEnv(),
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'green', pushed: true, approved: true });
      const tagged = git(['--git-dir', freshMirror, 'rev-parse', `refs/tags/${TAG}^{commit}`], repo).stdout.trim();
      expect(tagged).toBe(taskSha);
      expect(tagged).not.toBe(driftedHead);
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('批件 commit 与 task metadata commit 不一致 → blocked，mirror 零 tag', async () => {
    approvalRecord = { ...approvalRecord, metadata: { commitSha: 'aaaaaaaa' } };
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-wrong-commit-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        [...baseArgs().slice(0, -3), '--mirror', freshMirror, '--json', '--task', TASK_ID, '--approved', APPROVAL_ID],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report).toMatchObject({ decision: 'blocked', pushed: false, approved: false, commitSha: null });
      expect(report.blockers.join()).toContain('不一致');
      expect(git(['ls-remote', '--tags', freshMirror], repo).stdout.trim()).toBe('');
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('审批 + tier 绿 → 真 push，tag 落 bare mirror（真副作用 oracle）', async () => {
    const r = await apc([...baseArgs(), '--task', TASK_ID, '--approved', APPROVAL_ID], commonEnv());
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('green');
    expect(j.pushed).toBe(true);
    expect(j.tier.emptyRun).toBe(false); // 真跑过至少一条用例，不是空门
    expect(tagInMirror()).toBe(true); // git ls-remote 真核验
  }, TIMEOUT);

  // ── apc/12 §0.12 修法 A：--tier 无默认值 ────────────────────────────
  it('缺少 --tier → usage 错误 exit 2（无默认值，不许悄悄回退 TD）', async () => {
    // 独立 fresh mirror：共享 `mirror` 在前一个用例里已真 push 过同名 TAG，
    // 用它验证「本次没推」会被那笔历史 push 假阳性掩盖。
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-usageerr-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        ['release', 'tag', '--channel', 'k8s', '--target', 'test', '--version', '9.9.9', '--date', '20260101',
          '--repo', repo, '--mirror', freshMirror, '--approved', 'appr-token-123', '--json'],
        commonEnv(),
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--tier');
      const ls = git(['ls-remote', '--tags', freshMirror], repo);
      expect((ls.stdout ?? '').includes('refs/tags/')).toBe(false); // 用法错在任何 git 动作之前拦下
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  // ── apc/12 §0.12 修法 B：tier 空跑（0 用例真实执行）不算绿证据 ──────────
  it('空跑：TD 层无 spec（占位 skip，passed:0/failed:0）→ blocked，即便带 --approved 也绝不 push', async () => {
    const emptySelftest = mkdtempSync(join(tmpdir(), 'apc-tag-selftest-empty-'));
    for (const d of ['contract', 'cookbook', 'journeys', 'probes', 'td']) mkdirSync(join(emptySelftest, d), { recursive: true });
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror-empty-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        ['release', 'tag', '--channel', 'k8s', '--target', 'test', '--version', '9.9.9', '--date', '20260101',
          '--tier=TD', '--repo', repo, '--mirror', freshMirror, '--approved', 'appr-token-123', '--json'],
        { TEST203_SELFTEST_ROOT: emptySelftest, TEST203_DOCTOR_SCRIPT: greenDoctor },
      );
      expect(r.status).toBe(1);
      const j = JSON.parse(r.stdout);
      expect(j.decision).toBe('blocked');
      expect(j.pushed).toBe(false);
      expect(j.tier.exitCode).toBe(0); // run.ts 自己觉得"没红"——这正是空门的危险之处
      expect(j.tier.emptyRun).toBe(true);
      expect(j.blockers.some((b: string) => b.includes('空跑'))).toBe(true);
      const ls = git(['ls-remote', '--tags', freshMirror], repo);
      expect((ls.stdout ?? '').includes('refs/tags/')).toBe(false);
    } finally {
      rmSync(emptySelftest, { recursive: true, force: true });
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('负控 1：未审批 → staged，tag 绝不进 mirror', async () => {
    // 用一个全新 mirror 保证干净
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror2-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    try {
      const r = await apc(
        ['release', 'tag', '--channel', 'k8s', '--target', 'test', '--version', '9.9.9', '--date', '20260101',
          '--tier=TD', '--repo', repo, '--mirror', freshMirror, '--json'],
        commonEnv(),
      );
      expect(r.status).toBe(3);
      const j = JSON.parse(r.stdout);
      expect(j.decision).toBe('staged');
      expect(j.pushed).toBe(false);
      const ls = git(['ls-remote', '--tags', freshMirror], repo);
      expect((ls.stdout ?? '').includes('refs/tags/')).toBe(false);
    } finally {
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('负控 2：tier 红 → blocked，即便带 --approved 也绝不 push（tier 门压过审批）', async () => {
    const freshMirror = mkdtempSync(join(tmpdir(), 'apc-tag-mirror3-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', freshMirror]);
    writeFileSync(join(selftest, 'td', 'apc-tag-red.ts'), 'process.exit(1);\n');
    try {
      const r = await apc(
        ['release', 'tag', '--channel', 'k8s', '--target', 'test', '--version', '9.9.9', '--date', '20260101',
          '--tier=TD', '--repo', repo, '--mirror', freshMirror, '--approved', 'appr-token', '--json'],
        commonEnv(),
      );
      expect(r.status).toBe(1);
      const j = JSON.parse(r.stdout);
      expect(j.decision).toBe('blocked');
      expect(j.pushed).toBe(false);
      expect(j.tier.emptyRun).toBe(false); // 有真失败用例，不是空跑
      const ls = git(['ls-remote', '--tags', freshMirror], repo);
      expect((ls.stdout ?? '').includes('refs/tags/')).toBe(false);
    } finally {
      rmSync(join(selftest, 'td', 'apc-tag-red.ts'), { force: true });
      rmSync(freshMirror, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe('apc release tag — prod 人闸（不变量 2）', () => {
  it('--target prod → blocked，绝不做任何 git 动作（tier 门都不跑）', async () => {
    const mirror = mkdtempSync(join(tmpdir(), 'apc-prod-mirror-')) + '.git';
    spawnSync('git', ['init', '--bare', '-q', mirror]);
    try {
      const r = await apc(['release', 'tag', '--channel', 'k8s', '--target', 'prod', '--version', '9.9.9', '--date', '20260101', '--approved', 'x', '--mirror', mirror, '--json']);
      expect(r.status).toBe(1);
      const j = JSON.parse(r.stdout);
      expect(j.decision).toBe('blocked');
      expect(j.pushed).toBe(false);
      expect(j.blockers.join()).toContain('prod 人闸');
      // tier 门未跑（exitCode 哨兵 -1）；prod 人闸甚至不要求 --tier 就先拒了
      expect(j.tier.exitCode).toBe(-1);
      expect(j.tier.emptyRun).toBe(false);
      const ls = spawnSync('git', ['ls-remote', '--tags', mirror], { encoding: 'utf8' });
      expect((ls.stdout ?? '').includes('refs/tags/')).toBe(false);
    } finally {
      rmSync(mirror, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
