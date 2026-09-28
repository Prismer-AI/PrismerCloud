/**
 * release-rollback.test.ts — 真验证（真回滚，非空壳）。
 *
 *  A. 纯 planRollback（含负控：无上一好版本）。
 *  B. 真副作用 e2e：ledger 文件真回退 + bare mirror 的 release-current 指针真重指。
 *  C. 负控：只一条 current 的 ledger → blocked 且 ledger 字节不变（未空转乱改）。
 *  D. 正证据 + 撕裂回滚（apc/17 §8.2 W0.3）：`git` 替身骗不出绿；指针不可动时账本一个字节不写。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRollback, ReleaseEntry } from '../release-rollback';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const APC = 'sdk/apc/bin/apc.ts';
const TIMEOUT = 120_000;

function apc(args: string[], env?: NodeJS.ProcessEnv) {
  const r = spawnSync('npx', ['tsx', APC, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: env ?? process.env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function git(args: string[], cwd?: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

const scratch: string[] = [];
function tmp(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(p);
  return p;
}
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

const led = (entries: Array<[string, string, ReleaseEntry['status']]>): ReleaseEntry[] =>
  entries.map(([version, tag, status]) => ({ version, tag, status, ts: '2026-01-01T00:00:00Z' }));

describe('planRollback — 纯 + 负控', () => {
  it('2 条（v1 superseded, v2 current）→ 回滚 v2→v1', () => {
    const p = planRollback(led([['1.0.0', 't1', 'superseded'], ['2.0.0', 't2', 'current']]));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.from.version).toBe('2.0.0');
      expect(p.to.version).toBe('1.0.0');
      expect(p.next.find((e) => e.version === '2.0.0')!.status).toBe('pulled');
      expect(p.next.find((e) => e.version === '1.0.0')!.status).toBe('current');
    }
  });
  it('负控：只有 current 一条 → ok:false（无上一好版本）', () => {
    const p = planRollback(led([['2.0.0', 't2', 'current']]));
    expect(p.ok).toBe(false);
  });
  it('负控：无 current → ok:false', () => {
    expect(planRollback(led([['1.0.0', 't1', 'superseded']])).ok).toBe(false);
  });
  it('上一条已 pulled → 跳过它找更早的好版本', () => {
    const p = planRollback(led([['1.0.0', 't1', 'superseded'], ['1.5.0', 't15', 'pulled'], ['2.0.0', 't2', 'current']]));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.to.version).toBe('1.0.0');
  });
});

describe('apc release rollback — 真副作用 e2e', () => {
  it('审批 → ledger 真回退 + bare mirror 指针真重指到上一好 tag', () => {
    const dir = tmp('apc-rb-');
    const ledgerPath = join(dir, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify(led([['1.0.0', 'k8s-test-v1', 'superseded'], ['2.0.0', 'k8s-test-v2', 'current']]), null, 2));
    // bare mirror 带两个 tag
    const mirror = join(dir, 'mirror.git');
    git(['init', '--bare', '-q', mirror]);
    const work = join(dir, 'work');
    git(['init', '-q', work]);
    git(['config', 'user.email', 't@t'], work);
    git(['config', 'user.name', 't'], work);
    writeFileSync(join(work, 'f'), 'a');
    git(['add', '.'], work);
    git(['commit', '-qm', 'c1'], work);
    git(['tag', 'k8s-test-v1'], work);
    writeFileSync(join(work, 'f'), 'b');
    git(['commit', '-aqm', 'c2'], work);
    git(['tag', 'k8s-test-v2'], work);
    git(['push', '-q', mirror, '--tags'], work);
    const v1sha = git(['rev-parse', 'k8s-test-v1'], work).stdout.trim();

    const r = apc(['release', 'rollback', '--ledger', ledgerPath, '--mirror', mirror, '--approved', 'appr-tok', '--json']);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('green');
    expect(j.applied).toBe(true);
    expect(j.mirrorRepointed).toBe(true);

    // oracle 1：ledger 文件真变（v2 pulled, v1 current）
    const after = JSON.parse(readFileSync(ledgerPath, 'utf8')) as ReleaseEntry[];
    expect(after.find((e) => e.version === '2.0.0')!.status).toBe('pulled');
    expect(after.find((e) => e.version === '1.0.0')!.status).toBe('current');

    // oracle 2：mirror 的 release-current 指针真指到 v1 的 commit
    const ptr = git(['-C', mirror, 'rev-parse', 'refs/heads/release-current']).stdout.trim();
    expect(ptr).toBe(v1sha);
  }, TIMEOUT);

  it('负控 1：只有一条 current → blocked，ledger 文件字节不变（未空转乱改）', () => {
    const dir = tmp('apc-rb-neg-');
    const ledgerPath = join(dir, 'ledger.json');
    const original = JSON.stringify(led([['2.0.0', 'v2', 'current']]), null, 2);
    writeFileSync(ledgerPath, original);
    const r = apc(['release', 'rollback', '--ledger', ledgerPath, '--approved', 'appr-tok', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).decision).toBe('blocked');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(original); // 字节完全不变
  }, TIMEOUT);

  it('负控 2：未审批 → staged，ledger 不变（dry-run 只出计划）', () => {
    const dir = tmp('apc-rb-dry-');
    const ledgerPath = join(dir, 'ledger.json');
    const original = JSON.stringify(led([['1.0.0', 'v1', 'superseded'], ['2.0.0', 'v2', 'current']]), null, 2);
    writeFileSync(ledgerPath, original);
    const r = apc(['release', 'rollback', '--ledger', ledgerPath, '--json']);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).decision).toBe('staged');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(original);
  }, TIMEOUT);
});

// ────────────────────────────────────────────────────────────────────────────
// D. 正证据 + 撕裂回滚（apc/17 §8.2 W0.3；apc/12 §1 承重发现 A / B）
//    这三条分支此前全仓零覆盖——既有 7 条测试全走 lightweight tag 的 happy path。
// ────────────────────────────────────────────────────────────────────────────

/** 造一个 bare mirror + 两个 tag（`annotated` 决定用 `-a` 还是 lightweight），返回路径与 v1 的 commit。 */
function makeMirror(dir: string, tags: [string, string], annotated: boolean) {
  const mirror = join(dir, 'mirror.git');
  const work = join(dir, 'work');
  git(['init', '--bare', '-q', mirror]);
  git(['init', '-q', work]);
  git(['config', 'user.email', 't@t'], work);
  git(['config', 'user.name', 't'], work);
  const tag = (name: string) => git(annotated ? ['tag', '-a', name, '-m', name] : ['tag', name], work);
  writeFileSync(join(work, 'f'), 'a');
  git(['add', '.'], work);
  git(['commit', '-qm', 'c1'], work);
  tag(tags[0]);
  writeFileSync(join(work, 'f'), 'b');
  git(['commit', '-aqm', 'c2'], work);
  tag(tags[1]);
  git(['push', '-q', mirror, '--tags'], work);
  const v1commit = git(['rev-parse', `${tags[0]}^{commit}`], work).stdout.trim();
  const v2commit = git(['rev-parse', `${tags[1]}^{commit}`], work).stdout.trim();
  git(['-C', mirror, 'update-ref', 'refs/heads/release-current', v2commit]);
  return { mirror, v1commit, v2commit };
}

function ptr(mirror: string): string {
  return git(['-C', mirror, 'rev-parse', 'refs/heads/release-current']).stdout.trim();
}

describe('W0.3 — repointMirror 正证据 + 不撕裂', () => {
  it('负控 A：PATH 前置 exit-0 零输出的 git 替身 → blocked，账本字节不变、指针不动', () => {
    const dir = tmp('apc-rb-shim-');
    const { mirror, v2commit } = makeMirror(dir, ['k8s-test-v1', 'k8s-test-v2'], false);
    const ledgerPath = join(dir, 'ledger.json');
    const original = JSON.stringify(
      led([['1.0.0', 'k8s-test-v1', 'superseded'], ['2.0.0', 'k8s-test-v2', 'current']]),
      null,
      2,
    );
    writeFileSync(ledgerPath, original);

    // 替身：任何 git 调用都 exit 0 且零输出。旧实现只看 status!==0 ⇒ sha='' ⇒ 全流程判绿
    // 并在 notes 里谎称「版本指针回退：… → k8s-test-v1」，而指针一步没动。
    const shimDir = join(dir, 'shim');
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(shimDir, 'git'), 0o755);

    const r = apc(['release', 'rollback', '--ledger', ledgerPath, '--mirror', mirror, '--approved', 'tok', '--json'], {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    });

    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.mirrorRepointed).toBe(false);
    expect(j.applied).toBe(false); // 探测先于写入 ⇒ 账本根本没写
    expect(j.blockers.join('\n')).toMatch(/40-hex/);
    // oracle：两个副作用都没发生（用真 git 回读，不信替身）
    expect(readFileSync(ledgerPath, 'utf8')).toBe(original);
    expect(ptr(mirror)).toBe(v2commit);
  }, TIMEOUT);

  it('负控 B：annotated tag → 不再撕裂；指针真落到 tag 的 commit（不是 tag 对象）', () => {
    const dir = tmp('apc-rb-ann-');
    const { mirror, v1commit } = makeMirror(dir, ['ann-v1', 'ann-v2'], true);
    // 前提坐实：annotated tag 的 refs/tags/X 是 tag 对象，与 commit 不同 —— 这正是旧实现的触发器
    const tagObj = git(['-C', mirror, 'rev-parse', 'refs/tags/ann-v1']).stdout.trim();
    expect(tagObj).not.toBe(v1commit);

    const ledgerPath = join(dir, 'ledger.json');
    writeFileSync(
      ledgerPath,
      JSON.stringify(led([['1.0.0', 'ann-v1', 'superseded'], ['2.0.0', 'ann-v2', 'current']]), null, 2),
    );
    const r = apc(['release', 'rollback', '--ledger', ledgerPath, '--mirror', mirror, '--approved', 'tok', '--json']);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('green');
    expect(j.mirrorRepointed).toBe(true);
    // 两个副作用一致：账本翻了，指针也真的落到 v1 的 commit
    const after = JSON.parse(readFileSync(ledgerPath, 'utf8')) as ReleaseEntry[];
    expect(after.find((e) => e.version === '2.0.0')!.status).toBe('pulled');
    expect(after.find((e) => e.version === '1.0.0')!.status).toBe('current');
    expect(ptr(mirror)).toBe(v1commit);
  }, TIMEOUT);

  it('负控 B′：mirror 里没有目标 tag → blocked 且账本字节不变（旧实现会账本已翻/指针没翻）', () => {
    const dir = tmp('apc-rb-torn-');
    const emptyMirror = join(dir, 'empty.git');
    git(['init', '--bare', '-q', emptyMirror]);
    const ledgerPath = join(dir, 'ledger.json');
    const original = JSON.stringify(led([['1.0.0', 'nope-v1', 'superseded'], ['2.0.0', 'nope-v2', 'current']]), null, 2);
    writeFileSync(ledgerPath, original);

    const r = apc([
      'release', 'rollback', '--ledger', ledgerPath, '--mirror', emptyMirror, '--approved', 'tok', '--json',
    ]);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe('blocked');
    expect(j.applied).toBe(false);
    // 命根子断言：blocked ⇒ 两侧都没动 ⇒ 运维「重试」是安全的，不会越回退一档
    expect(readFileSync(ledgerPath, 'utf8')).toBe(original);
  }, TIMEOUT);
});
