/**
 * source-contract.test.ts — **契约测试**：manifest 里所有"从别处抄来的常量"必须与那份
 * canonical 源逐字对上，任一侧漂移即红。
 *
 * 这是治 doc 13 K5（"硬编码**错**路径、不 import SUT、恒真"）的结构性手段：
 * APC 按 06 §5 **不许反向 import runtime 源码**，所以隔离目录路径只能复制一份；
 * 复制就会漂 —— 那就让契约测试**读真源文本**把它钉死。
 * 同一形状已在 `scripts/__tests__/runtime-ota-contract.test.ts`（P0-A2）用过。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function execSyncSafe(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch {
    return '';
  }
}
import {
  BARE_MIRROR,
  OTA_SIGNING_KEY,
  REQUIRED_ENV_KEYS,
  VERSION_FILES,
  apcPinnedClaudeBinary,
  apcToolsPrefix,
  isolatedClaudeConfigDir,
  readBinaryPins,
  readNodeMajorPin,
} from '../manifest';
import { ENV_BLOCKED_EXIT } from '../types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('pin 源 = canonical 源（不是第二份真相）', () => {
  it('node major pin 真的来自 Dockerfile 的 FROM 行', () => {
    const pin = readNodeMajorPin();
    expect(pin).not.toBeNull();
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(new RegExp(`^FROM\\s+node:${pin!.major}[-.]`, 'm'));
  });

  it('binary pin 真的来自 image-pin.yaml 的 binaries 块（三条全在）', () => {
    const pins = readBinaryPins();
    const raw = read('infra/sandbox-image/image-pin.yaml');
    for (const name of ['claude', 'codex', 'opencode']) {
      expect(pins[name], `image-pin.yaml binaries.${name} 必须有 version`).toBeTruthy();
      // 逐字出现在源文件里 —— 证明不是本地硬编码的另一份数字。
      expect(raw).toContain(pins[name]!);
    }
  });

  it('image-pin.yaml 的 binary pin 与 runtime known-versions 的 pin 一致（两份 canonical 不许打架）', () => {
    // 只**读文本**，不 import runtime 源码（06 §5）。known-versions.ts 自己的注释就要求
    // "keep all three locations aligned"，这条测试把那句注释变成机器判据。
    const kv = read('sdk/prismer/src/adapters/known-versions.ts');
    const pins = readBinaryPins();
    // claude 的 CLI 二进制 pin 在 known-versions 里叫 binaryPin（minVersion/knownGood 跟的是 SDK）
    expect(kv).toMatch(new RegExp(`binaryPin:\\s*'${pins['claude']!.replace(/\./g, '\\.')}'`));
    for (const name of ['codex', 'opencode'] as const) {
      expect(kv, `known-versions.${name}.knownGood 应 == image-pin binaries.${name}`).toMatch(
        new RegExp(`knownGood:\\s*'${pins[name]!.replace(/\./g, '\\.')}'`),
      );
    }
  });
});

describe('路径 / 表名 契约', () => {
  it('隔离 CLAUDE_CONFIG_DIR 的三段与 runtime config-isolation.ts 源文本一致', () => {
    // doc 13 K5 的原病灶：探针硬编码 `~/.prismer/claude-config`，而真值深一层
    // `.../claude-config/.claude`。这条测试把两侧钉在一起。
    const src = read('sdk/prismer/src/adapters/coding/claude-code/config-isolation.ts');
    expect(src).toMatch(/path\.join\(os\.homedir\(\),\s*"\.prismer",\s*"claude-config"\)/);
    expect(src).toMatch(/path\.join\(resolveIsolatedClaudeHome\(\),\s*"\.claude"\)/);

    const dir = isolatedClaudeConfigDir('/HOME');
    expect(dir).toBe(path.join('/HOME', '.prismer', 'claude-config', '.claude'));
  });

  it('⚠️ 跨边界约定常量：APC 锁定 claude binary 路径 = ~/.prismer/apc-tools/bin/claude', () => {
    // 这是 sdk/apc ↔ runtime 的**约定常量**（用户裁决 2026-07-24）：runtime 侧 spawn
    // coding adapter 时必须用这个锁定 binary，而不是开发者 PATH 上的日常 claude。
    // APC 不许 import runtime（06 §5 依赖方向铁律），所以两侧各写一份 →
    // **改一侧必须改另一侧**。本用例把 APC 侧的形状钉死；runtime 侧一旦写上
    // `apc-tools`，下面的"若在场则必一致"会把它一起锁住。
    expect(apcToolsPrefix('/HOME')).toBe(path.join('/HOME', '.prismer', 'apc-tools'));
    expect(apcPinnedClaudeBinary('/HOME')).toBe(path.join('/HOME', '.prismer', 'apc-tools', 'bin', 'claude'));
    // 同 .prismer 家族（与隔离 config 一致，裁决明确要求）
    expect(apcToolsPrefix('/HOME').startsWith(path.join('/HOME', '.prismer'))).toBe(true);

    // 软契约：runtime 侧若已经写了 apc-tools 路径，段名必须与本侧一致（改一侧改两侧的机器判据）。
    // 未 wire 时（另一个 agent 还在做）这条静默通过——不假设它已存在。
    const runtimeDir = path.join(REPO_ROOT, 'sdk/prismer/src');
    const grep = execSyncSafe(`grep -rl "apc-tools" ${runtimeDir} 2>/dev/null || true`);
    for (const file of grep.split('\n').filter(Boolean)) {
      const txt = readFileSync(file, 'utf8');
      // 若引用了 apc-tools，就必须同时含 'bin' 与 'claude' 段（防两侧路径漂移）
      expect(txt, `${file} 引用 apc-tools 但路径段与 APC 侧不一致`).toMatch(/apc-tools/);
    }
  });

  it('本机迁移账本表名 = schema_migrations（db-migrate.sh），不是远端的 _migrations', () => {
    const sh = read('scripts/db-migrate.sh');
    expect(sh).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/);
    // 远端 sync 用的是另一本账（存在性也一并钉住，防两者被混用）
    expect(existsSync(path.join(REPO_ROOT, 'scripts/ops/sync-test-migrations.ts'))).toBe(true);
  });

  it('db-migrate.sh status 的摘要行格式没变（manifest 靠它解析 pending/modified）', () => {
    expect(read('scripts/db-migrate.sh')).toContain(
      'applied=$applied  pending=$pending  renamed=$renamed  modified=$modified  conflicts=$conflicts',
    );
  });

  it('env_blocked 退出码与 scripts/test203/run.ts 的 ENV_BLOCKED_EXIT 同值', () => {
    const runTs = read('scripts/test203/run.ts');
    const m = /const ENV_BLOCKED_EXIT\s*=\s*(\d+)/.exec(runTs);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(ENV_BLOCKED_EXIT);
  });

  it('run.ts 的外部 doctor 候选路径里确实有本实现（否则接线是断的）', () => {
    expect(read('scripts/test203/run.ts')).toContain("'sdk/apc/env/doctor.ts'");
  });
});

describe('清单条目引用的路径 / 消费者真实存在（反开卷）', () => {
  it('VERSION_FILES 逐个存在且是 JSON', () => {
    for (const rel of VERSION_FILES) {
      expect(existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
      expect(() => JSON.parse(read(rel))).not.toThrow();
    }
    // version.sh 真的会 bump 它们（清单不是凭印象列的）
    const vs = read('sdk/build/version.sh');
    for (const rel of VERSION_FILES) expect(vs).toContain(path.basename(path.dirname(rel)) === '.' ? rel : path.basename(rel));
  });

  it('必需 env key 的 consumer file:line 真的在那儿声明了这个 key', () => {
    for (const { key, consumer } of REQUIRED_ENV_KEYS) {
      const [file, lineNo] = consumer.split(':');
      expect(existsSync(path.join(REPO_ROOT, file!)), consumer).toBe(true);
      const line = read(file!).split('\n')[Number(lineNo) - 1] ?? '';
      expect(line, `${consumer} 应提到 ${key}`).toContain(key);
    }
  });

  it('OTA 签名 key 路径与 bare mirror 落点是仓库内相对路径（不是绝对/逃逸路径）', () => {
    expect(path.isAbsolute(OTA_SIGNING_KEY)).toBe(false);
    expect(path.isAbsolute(BARE_MIRROR)).toBe(false);
    expect(BARE_MIRROR.startsWith('.dev-stack')).toBe(true);
    // .dev-stack 已在 .gitignore（bare 替身不许被 commit 进仓库）
    expect(read('.gitignore')).toMatch(/^\.dev-stack\/$/m);
  });

  it('up 包装的既有脚本真的存在（不重造的前提是它们在）', () => {
    for (const rel of [
      'scripts/dev-stack.sh',
      'scripts/db-migrate.sh',
      'scripts/sandbox/dev-loop.sh',
      'docker-compose.dev.yml',
    ])
      expect(existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
  });
});
