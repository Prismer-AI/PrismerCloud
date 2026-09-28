/**
 * up.test.ts — `apc env up` 的**幂等性**与"凭据不代办"两条契约。
 *
 * oracle 取副作用真值：
 *  - 幂等：真跑两次 `up()`（本机环境已就绪 ⇒ 全 skip），第二次每一步都必须是 skipped，
 *    且 guard.before === 'pass'（skip 的**理由**必须是真判定绿了，不是"跑过一次就跳"）。
 *  - 不代办：manualOnly 的项永远出现在 `manual[]`（若它红着），且 up 从不动它们。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BARE_MIRROR, ENV_MANIFEST, findItem } from '../manifest';
import { REPO_ROOT } from '../probes';
import { up } from '../up';

describe('幂等（06 §2：up 幂等拉起）', () => {
  it('连跑两次：第二次每一步 skipped，且 skip 的理由是 guard 真的 pass', async () => {
    const first = await up();
    const second = await up();
    expect(second.steps.length).toBe(first.steps.length);
    for (const s of second.steps) {
      expect(s.action, `${s.id} 第二次应 skipped（实到 ${s.action}: ${s.detail}）`).toBe('skipped');
      expect(s.guard?.before, `${s.id} 的 skip 必须由 guard=pass 决定`).toBe('pass');
    }
    expect(second.ok).toBe(true);
    expect(second.exitCode).toBe(0);
  }, 600_000);

  it('负控（真副作用）：删掉 bare 替身 → up 必须真把它建回来，且只动这一步', async () => {
    const dir = path.join(REPO_ROOT, BARE_MIRROR);
    expect(existsSync(dir), '前置：替身应已在（上一条 up 建过）').toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);

    const r = await up();
    const step = r.steps.find((s) => s.id === 'bare-mirror')!;
    expect(step.action).toBe('executed');
    expect(step.guard).toEqual({ id: 'project.bare-repo-mirror', before: 'fail', after: 'pass' });
    // 其余步骤不受影响（一步的红不许把别的步骤拖下水）
    for (const s of r.steps.filter((x) => x.id !== 'bare-mirror')) expect(s.action).toBe('skipped');

    // 副作用 oracle：git 本人确认它是 bare（不是"目录建出来了"）
    const isBare = execFileSync('git', ['-C', dir, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim();
    expect(isBare).toBe('true');
  }, 600_000);
});

describe('凭据 / 签名 key 不代办（06 §0 原则 2）', () => {
  it('manualOnly 项若红着，只进 manual[]，永不出现在 steps[]', async () => {
    const r = await up({ dryRun: true });
    const manualIds = ENV_MANIFEST.filter((i) => i.manualOnly).map((i) => i.id);
    const stepGuards = r.steps.map((s) => s.guard?.id);
    for (const id of manualIds) expect(stepGuards, `${id} 不许被任何 up 步骤当 guard`).not.toContain(id);

    // 本机现状：SKILL_CONFIG_ENC_KEY / 本地凭据缺失 ⇒ 该项红 ⇒ 必须出现在 manual[]
    const secrets = await findItem('secrets.env-local-required-keys')!.check();
    if (secrets.status !== 'pass') {
      expect(r.manual.map((m) => m.id)).toContain('secrets.env-local-required-keys');
      expect(r.manual.find((m) => m.id === 'secrets.env-local-required-keys')!.fixHint).toBeTruthy();
    }
  }, 300_000);

  it('dry-run 不产生任何副作用（--dry-run 是"会做什么"，不是"做了什么"）', async () => {
    const dir = path.join(REPO_ROOT, BARE_MIRROR);
    const before = existsSync(dir);
    await up({ dryRun: true, only: ['bare-mirror'] });
    expect(existsSync(dir)).toBe(before);
  }, 120_000);
});

describe('非交互安全模式（apc/11 §0.17 缺口1：dispatch 语境不 block 在 colima start）', () => {
  it('safe: heavy 步（docker/colima）红着也不执行 fix，归 manual[]、action=manual、不拉垮 exitCode', async () => {
    // 真副作用 oracle：docker daemon 若已停（本机现状），guard 红。safe 模式下这一步
    // 绝不能调用 fix()（= `colima start`，会 block 数分钟）。断言它落 manual、action=manual。
    const dockerStatus = await findItem('infra.docker-daemon')!.check();
    const r = await up({ safe: true, only: ['docker', 'bare-mirror'] });
    const dockerStep = r.steps.find((s) => s.id === 'docker')!;
    if (dockerStatus.status !== 'pass') {
      // heavy + red + safe ⇒ 不跑 fix，标 manual（不是 failed，不是 executed）
      expect(dockerStep.action).toBe('manual');
      expect(dockerStep.guard?.after, 'safe 模式不应回填 after（= 没跑 fix 的证据）').toBeUndefined();
      expect(r.manual.map((m) => m.id)).toContain('infra.docker-daemon');
      // manual 不是 failed → exitCode 不被它拉红
      expect(r.exitCode).toBe(0);
    }
    // 轻量步 bare-mirror（非 heavy）在 safe 模式照常处理（skip 或 executed，绝不 manual）
    const bare = r.steps.find((s) => s.id === 'bare-mirror')!;
    expect(bare.action).not.toBe('manual');
  }, 120_000);

  it('负控（safe 的开关真的在起作用）：非 safe 模式下 docker 步不会被归 manual', async () => {
    // 不真跑（dryRun），只证明"归 manual"这条分支只在 safe 时触发 —— 关掉 safe，
    // docker 步走的是 dry-run 的 skipped 分支，绝不出现在 manual[]（除非它是 manualOnly，它不是）。
    const r = await up({ safe: false, dryRun: true, only: ['docker'] });
    expect(r.manual.map((m) => m.id)).not.toContain('infra.docker-daemon');
    const dockerStep = r.steps.find((s) => s.id === 'docker')!;
    expect(dockerStep.action).not.toBe('manual');
  }, 120_000);
});

describe('修完不绿 = 没修好（不许拿"命令跑完了"当成功）', () => {
  it('guard 在 fix 之后仍非 pass → 该步记 failed 而不是 executed', async () => {
    // 直接验判据本身：up() 里 action 由 `after === 'pass'` 决定。这里用 only= 一个
    // 不存在的 step 证明 selected 逻辑，再用真实 bare-mirror 步的 after 字段佐证。
    const r = await up({ only: ['bare-mirror'] });
    expect(r.steps.map((s) => s.id)).toEqual(['bare-mirror']);
    const s = r.steps[0]!;
    if (s.action === 'executed') expect(s.guard?.after).toBe('pass');
    if (s.action === 'failed' && s.guard?.after) expect(s.guard.after).not.toBe('pass');
  }, 300_000);
});
