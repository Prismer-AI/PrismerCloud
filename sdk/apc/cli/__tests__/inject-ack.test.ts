/**
 * inject-ack.test.ts — 注入器验收（apc/11 §2 code 模块口径）。
 *
 * oracle 全部是**副作用**：写盘后的文件字节 / 字节 diff / 退出码。
 * 没有一条断言「输出里有某句话」——除了对**注入产物本身**的内容断言，
 * 那不是文案断言，那就是这个工具的产物（文件内容 diff 是 apc/11 §2 明列的合法判据）。
 *
 * 每条正控都配一条负控（守卫拒绝 = 零文件改动 / 重复跑 = 零 diff / 篡改后自检必抛）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACK_BLOCK_BEGIN,
  ACK_BLOCK_END,
  ackCommandFor,
  assertNoExitCodeSwallow,
  injectAckIntoBundle,
  injectAckIntoSkillMd,
  renderAckBlock,
} from '../inject-ack';
import { BundleGuardError, BUILT_IN_SKILLS_REL, REPO_ROOT } from '../bundle-guard';

const DESCRIPTION =
  'A fixture skill used by the APC ack-injector acceptance tests; long enough to clear the SS-01 description floor of fifty characters.';

function makeBundle(root: string, slug: string, body = '# Fixture\n\nsome content\n'): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${DESCRIPTION}\n---\n\n${body}`, 'utf8');
  return dir;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'apc-inject-ack-'));
}

describe('renderAckBlock — 纪律块内容不变量', () => {
  it('围栏里只有那一条 ack 命令，逐字等于 ackCommandFor(slug)', () => {
    const block = renderAckBlock('git-ops');
    const fenced = block.split('\n');
    const start = fenced.findIndex((l) => l.startsWith('```'));
    const end = fenced.findIndex((l, i) => i > start && l.startsWith('```'));
    const cmdLines = fenced.slice(start + 1, end).filter((l) => l.trim());
    expect(cmdLines).toEqual([ackCommandFor('git-ops')]);
    expect(cmdLines[0]).toBe('cloud skill ack git-ops --task "$PRISMER_TASK_ID"');
  });

  it('四个退出码逐条在案，且 exit 3 明确写成「没有回执」而非成功', () => {
    const block = renderAckBlock('git-ops');
    for (const code of ['`0`', '`1`', '`3`', '`4`']) {
      expect(block, `退出码 ${code} 必须在纪律块里分流`).toContain(code);
    }
    const row3 = block.split('\n').find((l) => l.startsWith('| `3` |'));
    expect(row3, 'exit 3 必须有独立一行分流').toBeTruthy();
    // apc/11 §0.7 承重裁决：exit 3 不是失败，但更不许被读成"已回执"。
    expect(row3!).toContain('没有回执');
    expect(row3!).toContain('无 task 上下文');
  });

  it('负控：命令行里混进吞退出码的写法 → 自检必抛（`|| true` 是错的）', () => {
    const good = renderAckBlock('git-ops');
    expect(() => assertNoExitCodeSwallow(good)).not.toThrow();
    for (const bad of ['|| true', '|| :', '; true', '2>/dev/null']) {
      const tampered = good.replace(ackCommandFor('git-ops'), `${ackCommandFor('git-ops')} ${bad}`);
      expect(() => assertNoExitCodeSwallow(tampered), `${bad} 必须被拦`).toThrow(/swallow the exit code/);
    }
  });

  it('负控：散文里提到这些写法不误伤（只扫围栏内）', () => {
    const block = renderAckBlock('git-ops');
    // 块里本来就有一句"禁止用 || 兜底、; true、set +e"的散文 —— 它在围栏外。
    expect(block).toContain('set +e');
    expect(() => assertNoExitCodeSwallow(block)).not.toThrow();
  });
});

describe('injectAckIntoSkillMd — 纯文本注入', () => {
  it('尾部追加，正文原样保留', () => {
    const src = '---\nname: x\n---\n\n# X\n\nbody\n';
    const out = injectAckIntoSkillMd(src, 'x');
    expect(out.startsWith('---\nname: x\n---\n\n# X\n\nbody')).toBe(true);
    expect(out).toContain(ACK_BLOCK_BEGIN);
    expect(out.trimEnd().endsWith(ACK_BLOCK_END)).toBe(true);
  });

  it('幂等：对已注入文本再跑 → 字节完全不变，标记仍只有一对', () => {
    const once = injectAckIntoSkillMd('# X\n', 'x');
    const twice = injectAckIntoSkillMd(once, 'x');
    expect(twice).toBe(once);
    expect(once.split(ACK_BLOCK_BEGIN).length - 1).toBe(1);
    expect(once.split(ACK_BLOCK_END).length - 1).toBe(1);
  });

  it('块内容漂移 → 原地替换（不是再追加一份）', () => {
    const once = injectAckIntoSkillMd('# X\n', 'x');
    const drifted = once.replace('## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）', '## 被人手改坏了');
    const fixed = injectAckIntoSkillMd(drifted, 'x');
    expect(fixed).toBe(once);
    expect(fixed.split(ACK_BLOCK_BEGIN).length - 1).toBe(1);
  });

  it('负控：只有起标记没有止标记 → 拒绝猜边界', () => {
    expect(() => injectAckIntoSkillMd(`# X\n${ACK_BLOCK_BEGIN}\nhalf\n`, 'x')).toThrow(/unterminated/);
  });
});

describe('injectAckIntoBundle — 真写盘 + 幂等（副作用 oracle）', () => {
  it('首次注入 changed=true，重复跑 changed=false 且文件字节零 diff', () => {
    const root = tmpRoot();
    const dir = makeBundle(root, 'spec-intake');
    const md = join(dir, 'SKILL.md');
    const before = readFileSync(md);

    const r1 = injectAckIntoBundle(dir, root);
    expect(r1).toMatchObject({ slug: 'spec-intake', changed: true, action: 'injected' });
    const after1 = readFileSync(md);
    expect(after1.equals(before)).toBe(false);
    expect(after1.toString('utf8')).toContain(ackCommandFor('spec-intake'));

    const r2 = injectAckIntoBundle(dir, root);
    expect(r2).toMatchObject({ changed: false, action: 'unchanged' });
    const after2 = readFileSync(md);
    // 幂等的副作用判据 = 字节完全相同（不是"看起来没变"）。
    expect(after2.equals(after1)).toBe(true);
    expect(after2.toString('utf8').split(ACK_BLOCK_BEGIN).length - 1).toBe(1);
  });

  it('负控：frontmatter.name 缺失 → 抛，且 SKILL.md 零改动', () => {
    const root = tmpRoot();
    const dir = join(root, 'nameless');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\ndescription: ${DESCRIPTION}\n---\n\n# no name\n`, 'utf8');
    const before = readFileSync(join(dir, 'SKILL.md'));
    expect(() => injectAckIntoBundle(dir, root)).toThrow(/frontmatter.name missing/);
    expect(readFileSync(join(dir, 'SKILL.md')).equals(before)).toBe(true);
  });
});

describe('built-in 守卫（apc/00 §2.4：ack 不下发 39 个通用 built-in）', () => {
  it('负控：指向假造的 built-in 树 → 抛 BundleGuardError 且文件字节零改动', () => {
    const root = tmpRoot();
    const builtInRoot = join(root, BUILT_IN_SKILLS_REL);
    mkdirSync(builtInRoot, { recursive: true });
    const dir = makeBundle(builtInRoot, 'memory');
    const md = join(dir, 'SKILL.md');
    const before = readFileSync(md);

    let err: unknown;
    try {
      injectAckIntoBundle(dir, root);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BundleGuardError);
    expect((err as BundleGuardError).code).toBe('built_in_forbidden');
    // 守卫的验收判据是**零副作用**，不是"抛了个错"。
    expect(readFileSync(md).equals(before)).toBe(true);
  });

  it('负控：指向真仓库的 built-in-skills/memory → 抛，且真文件字节零改动', () => {
    const dir = join(REPO_ROOT, BUILT_IN_SKILLS_REL, 'memory');
    const md = join(dir, 'SKILL.md');
    const before = readFileSync(md);
    expect(() => injectAckIntoBundle(dir)).toThrow(BundleGuardError);
    expect(readFileSync(md).equals(before)).toBe(true);
  });

  it('正控：built-in 树之外的同名目录不受影响', () => {
    const root = tmpRoot();
    const dir = makeBundle(join(root, 'sdk', 'apc', 'skills'), 'memory');
    expect(injectAckIntoBundle(dir, root).changed).toBe(true);
  });
});

describe('apc skills inject-ack — 真跑 CLI 子进程（退出码 oracle）', () => {
  const bin = join(REPO_ROOT, 'sdk', 'apc', 'bin', 'apc.ts');

  it('正常 bundle → exit 0 + JSON changed:true；再跑 → exit 0 + changed:false', () => {
    const root = tmpRoot();
    const dir = makeBundle(root, 'test-runner');
    const run = () =>
      spawnSync('npx', ['tsx', bin, 'skills', 'inject-ack', dir, '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
    const r1 = run();
    expect(r1.status, r1.stderr).toBe(0);
    expect(JSON.parse(r1.stdout).results[0].changed).toBe(true);
    const r2 = run();
    expect(r2.status, r2.stderr).toBe(0);
    expect(JSON.parse(r2.stdout).results[0].changed).toBe(false);
  }, 240_000);

  it('负控：指向真 built-in-skills → exit 1 + code=built_in_forbidden + 真文件零改动', () => {
    const dir = join(REPO_ROOT, BUILT_IN_SKILLS_REL, 'memory');
    const before = readFileSync(join(dir, 'SKILL.md'));
    const r = spawnSync('npx', ['tsx', bin, 'skills', 'inject-ack', dir, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).results[0].code).toBe('built_in_forbidden');
    expect(readFileSync(join(dir, 'SKILL.md')).equals(before)).toBe(true);
  }, 240_000);

  it('无参数 → exit 2（用法错，与"失败"分开）', () => {
    const r = spawnSync('npx', ['tsx', bin, 'skills', 'inject-ack'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status).toBe(2);
  }, 240_000);
});
