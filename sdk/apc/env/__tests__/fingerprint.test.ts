/**
 * fingerprint.test.ts — 指纹的两条契约：
 *
 *  1. **E4：复用 test204，不重造**。doc 06 §2 明写"形状沿 test204 `lib/manifest.ts`；
 *     machine-gate + env-preflight 复用不重造"，doc 13 E4 记的欠账正是"零 import test204、
 *     firstSemver/toolVersion 全重写"。这里**读本文件源文本**钉住那三条 import——
 *     它是唯一能证明"没有本地同名副本"的机器判据。
 *  2. **密钥只进位图**：指纹里不许出现 `.env.local` 的任何值。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../fingerprint';
import * as t204Manifest from '../../../../scripts/test204/lib/manifest';
import * as t204Gate from '../../../../scripts/test204/lib/machine-gate';

const SRC = readFileSync(path.join(__dirname, '..', 'fingerprint.ts'), 'utf8');

describe('E4：复用 test204 的形状与分域纪律（不重造）', () => {
  it('源文件真的 import 了 test204 的 manifest / machine-gate（不是本地副本）', () => {
    expect(SRC).toMatch(/from '\.\.\/\.\.\/\.\.\/scripts\/test204\/lib\/manifest'/);
    expect(SRC).toMatch(/from '\.\.\/\.\.\/\.\.\/scripts\/test204\/lib\/machine-gate'/);
    for (const sym of ['collectHardware', 'collectGitHead', 'collectKind', 'collectNacosFingerprint'])
      expect(SRC, `应复用 test204 的 ${sym}`).toContain(sym);
    // 本地不许再写一份同名实现
    expect(SRC).not.toMatch(/function\s+(collectHardware|collectGitHead|firstSemver|toolVersion)\s*\(/);
  });

  it('被复用的符号确实来自 test204 模块（import 路径不是摆设）', () => {
    expect(typeof t204Manifest.collectHardware).toBe('function');
    expect(typeof t204Manifest.collectGitHead).toBe('function');
    expect(typeof t204Manifest.collectKind).toBe('function');
    expect(typeof t204Manifest.collectNacosFingerprint).toBe('function');
    expect(typeof t204Gate.isEnvError).toBe('function');
    // EnvError 与 AssertionError 的类型级分域（machine-gate 文件头的中心纪律）
    expect(t204Gate.isEnvError(new t204Gate.EnvError('x'))).toBe(true);
    expect(t204Gate.isEnvError(new t204Gate.AssertionError('x'))).toBe(false);
  });
});

describe('指纹真值', () => {
  it('真跑：sha256 串 + 硬件真值 + git head + 工具链/位图/schema 全在', async () => {
    const fp = await fingerprint();
    expect(fp.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(fp.hardware.arch).toBe(process.arch);
    expect(fp.hardware.cpu).toContain('core');
    expect(fp.toolchain.node!.installed).toBe(process.versions.node);
    expect(Object.keys(fp.keyBitmap).length).toBeGreaterThan(5);
    for (const v of Object.values(fp.keyBitmap)) expect([0, 1]).toContain(v);
    expect(fp.version.version).toMatch(/^\d+\.\d+\.\d+$/);
  }, 180_000);

  it('同一台机连取两次，指纹稳定（时间戳不参与 hash）', async () => {
    const a = await fingerprint();
    const b = await fingerprint();
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.generatedAt).not.toBe(a.generatedAt); // 时间戳确实在变，但没进 hash
  }, 300_000);

  it('负控：material 任一项变 → 指纹必须变（否则它证明不了机器等价）', async () => {
    const fp = await fingerprint();
    const { createHash } = await import('node:crypto');
    const recompute = (m: Record<string, string>) =>
      'sha256:' +
      createHash('sha256')
        .update(
          Object.keys(m)
            .sort()
            .map((k) => `${k}=${m[k]}`)
            .join('\n'),
        )
        .digest('hex');
    expect(recompute(fp.material)).toBe(fp.fingerprint); // 正控：材料可复算
    const mutated = { ...fp.material, 'tool.node': 'MUTATED' };
    expect(recompute(mutated)).not.toBe(fp.fingerprint);
  }, 180_000);

  it('密钥只进位图：指纹里不出现任何**机密**键的值', async () => {
    const secretish = new Map([
      ['JWT_SECRET', 'fixture-jwt-secret-never-serialize'],
      ['IDENTITY_KMS_KEY', 'fixture-identity-key-never-serialize'],
      ['SKILL_CONFIG_ENC_KEY', 'fixture-skill-key-never-serialize'],
      ['PRISMER_API_KEY', 'fixture-api-token-never-serialize'],
    ]);
    const fp = await fingerprint(secretish);
    const blob = JSON.stringify(fp);
    for (const [k, v] of secretish) {
      expect(blob, `${k} 的值不许进指纹`).not.toContain(v);
      expect(fp.keyBitmap[k], `${k} 的在场性必须进入位图`).toBe(1);
    }
  }, 180_000);
});
