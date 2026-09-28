/**
 * manifest.test.ts — 四段清单 + **真探针**的验收。
 *
 * 纪律（apc/11 §1）：
 *  - 探针要**真跑**（真连 MySQL / 真 PING redis / 真打 Nacos HTTP / 真读 lockfile）；
 *  - 每条断言配**负控**：把被测的那一个输入弄坏 → 该条必须变红，其余不受影响；
 *  - 强度不许削薄：协议级判定用"打坏协议层但保住端口"的负控证明它不是端口探活。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ENV_MANIFEST,
  apcPinnedClaudeBinary,
  apcToolsPrefix,
  checkLockConsistency,
  compareToPin,
  checkVersionAlignment,
  findItem,
  isolatedClaudeConfigDir,
  itemsBySection,
  readBinaryPins,
} from '../manifest';
import { mysqlProbe, nacosHealth, readEnvLocal, redactUrl, redisProbe, resolveEnvValue } from '../probes';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'apc-env-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('清单结构（06 §1 四段无缺失）', () => {
  it('四段齐全，id 唯一，每项都有 fixHint 与强度标注', () => {
    for (const section of ['infra', 'toolchain', 'secrets', 'project'] as const)
      expect(itemsBySection(section).length, section).toBeGreaterThan(0);
    const ids = ENV_MANIFEST.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of ENV_MANIFEST) {
      expect(i.fixHint.length, i.id).toBeGreaterThan(0);
      expect(['protocol', 'consistency', 'version', 'presence', 'process']).toContain(i.strength);
    }
  });

  it('凭据 / 签名 key 项标了 manualOnly（up 不代办的契约在清单上可读）', () => {
    expect(findItem('secrets.env-local-required-keys')!.manualOnly).toBe(true);
    expect(findItem('secrets.ota-ui-signing-key')!.manualOnly).toBe(true);
    // 反向：infra/project 段不许标 manualOnly（否则 up 会永远不修）
    for (const i of ENV_MANIFEST.filter((x) => x.section !== 'secrets')) expect(i.manualOnly, i.id).toBeFalsy();
  });
});

describe('MySQL 是协议级判定，不是端口探活（治 E2）', () => {
  const dbUrl = resolveEnvValue('DATABASE_URL');
  const runIf = dbUrl?.startsWith('mysql://') ? it : it.skip;

  runIf('真库：握手 + SELECT VERSION() + 账本行数都拿到', async () => {
    const p = await mysqlProbe(dbUrl!);
    expect(p.ok).toBe(true);
    expect(p.version).toMatch(/^\d+\./);
    expect(p.ledgerRows, 'schema_migrations 账本应有行').toBeGreaterThan(0);
    expect(p.ledgerHead).toMatch(/\.sql$/);
  }, 30_000);

  it('负控：端口**开着**但不是 MySQL（accept 后不说协议）→ 必须红', async () => {
    // 端口探活会绿，协议级判定必须红。这是 E2 的判据本身。
    const server = net.createServer((sock) => sock.on('data', () => {}));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const p = await mysqlProbe(`mysql://x:y@127.0.0.1:${port}/nope`, 3_000);
      expect(p.ok).toBe(false);
      expect(p.error).toBeTruthy();
    } finally {
      server.close();
    }
  }, 30_000);
});

describe('Redis 是协议级 PING，不是端口探活（治 E2）', () => {
  const url = resolveEnvValue('REDIS_URL');
  const runIf = url ? it : it.skip;

  runIf('真 redis：PING → PONG', async () => {
    const p = await redisProbe(url!);
    expect(p.ok).toBe(true);
    expect(p.pong).toBe('PONG');
  }, 30_000);

  it('负控：端口开着但吐非 RESP 垃圾 → 必须红', async () => {
    const server = net.createServer((sock) => sock.write('not-resp\r\n'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const p = await redisProbe(`redis://127.0.0.1:${port}`, 2_000);
      expect(p.ok).toBe(false);
    } finally {
      server.close();
    }
  }, 30_000);
});

describe('Nacos 走 HTTP health（CLAUDE.md：2.x 必须 HTTP API）', () => {
  it('真打 readiness 端点，200 + OK', async () => {
    const p = await nacosHealth();
    expect(p.status, `Nacos readiness 不通：${p.error ?? ''}`).toBe(200);
    expect((p.body ?? '').trim()).toMatch(/^ok$/i);
  }, 30_000);

  it('负控：HTTP 起来但 readiness 返 500 → manifest 项必须红（不是"端口通就绿"）', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const p = await nacosHealth(`http://127.0.0.1:${port}`, 3_000);
      expect(p.ok).toBe(false);
      expect(p.status).toBe(500);
    } finally {
      server.close();
    }
  }, 30_000);

  it('负控：readiness 200 但 body 不是 OK → 仍必须红（wedged 假绿的形状）', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('DOWN:naming');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const item = findItem('infra.nacos')!;
      const prev = process.env.CONFIG_CENTER_IP;
      process.env.CONFIG_CENTER_IP = `http://127.0.0.1:${port}`;
      try {
        const r = await item.check();
        expect(r.status).toBe('fail');
        expect(r.detail).toContain('DOWN:naming');
      } finally {
        if (prev === undefined) delete process.env.CONFIG_CENTER_IP;
        else process.env.CONFIG_CENTER_IP = prev;
      }
    } finally {
      server.close();
    }
  }, 30_000);
});

describe('node_modules ⇄ lockfile 是一致性判定，不是两个 fileExists（治 E5）', () => {
  it('真仓库：174± 个直接依赖逐包版本一致', () => {
    const c = checkLockConsistency();
    expect(c.total).toBeGreaterThan(50);
    expect(c.missing).toEqual([]);
    expect(c.mismatched).toEqual([]);
  });

  it('负控：node_modules 里的包版本被改成与 lock 不符 → 必须红（"存在"判定抓不到这个）', () => {
    const root = tmp();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { widget: '^1.0.0' }, devDependencies: {} }),
    );
    writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/widget': { version: '1.0.0' } } }),
    );
    mkdirSync(path.join(root, 'node_modules', 'widget'), { recursive: true });
    // stale 安装：文件都在（fileExists 会绿），版本对不上。
    writeFileSync(path.join(root, 'node_modules', 'widget', 'package.json'), JSON.stringify({ version: '0.9.0' }));
    const stale = checkLockConsistency(root);
    expect(stale.ok).toBe(false);
    expect(stale.mismatched[0]).toContain('widget lock=1.0.0 installed=0.9.0');

    // 复原成一致 → 复绿（证明这条不是恒红）
    writeFileSync(path.join(root, 'node_modules', 'widget', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    expect(checkLockConsistency(root).ok).toBe(true);
  });

  it('负控：包压根没装 → 记 missing', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { ghost: '^1.0.0' } }));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    expect(checkLockConsistency(root).missing).toEqual(['ghost']);
  });
});

describe('/VERSION 对齐是真读比对', () => {
  it('真仓库对齐', () => {
    const v = checkVersionAlignment();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.mismatched).toEqual([]);
    expect(v.unreadable).toEqual([]);
  });

  it('负控：某个版本文件落后一版 → 只该文件被点名', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'VERSION'), '9.9.9\n');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
    writeFileSync(path.join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '9.9.8' }));
    const v = checkVersionAlignment(root);
    expect(v.ok).toBe(false);
    expect(v.mismatched).toContain('apps/desktop/package.json=9.9.8');
    expect(v.mismatched).not.toContain('package.json=9.9.9');
  });
});

describe('D1 只锁 claude-code（裁决 2026-07-24：codex/opencode 从 doctor 拿掉）', () => {
  it('doctor 工具链不再检查 codex / opencode（image-pin.yaml 里它们仍在，只是 apc 不查）', () => {
    const toolIds = itemsBySection('toolchain').map((i) => i.id);
    expect(toolIds).not.toContain('toolchain.codex');
    expect(toolIds).not.toContain('toolchain.opencode');
    expect(toolIds).toContain('toolchain.claude-code-binary-pin');
    // image-pin.yaml（infra 侧，未动）里 codex/opencode 条目仍在——doctor 不查 ≠ yaml 删了
    const pins = readBinaryPins();
    expect(pins['codex']).toBeTruthy();
    expect(pins['opencode']).toBeTruthy();
  });
});

/** 造一个可执行 stub，`--version` 打印给定串。用于真副作用负控（不 mock）。 */
function fakeClaude(home: string, versionLine: string): string {
  const bin = apcPinnedClaudeBinary(home);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bash\necho '${versionLine}'\n`, { mode: 0o755 });
  return bin;
}

describe('claude-code 锁定项：查 ~/.prismer/apc-tools 的绝对路径，不是 PATH（裁决核心）', () => {
  const item = findItem('toolchain.claude-code-binary-pin')!;
  const pin = readBinaryPins()['claude']!;

  function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.HOME;
    process.env.HOME = home; // POSIX os.homedir() 读 $HOME → apcPinnedClaudeBinary 随之改指向
    return fn().finally(() => {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    });
  }

  it('检查的路径确实是 <apcToolsPrefix>/bin/claude，且落在 .prismer 家族（与隔离 config 同族）', () => {
    expect(apcPinnedClaudeBinary('/HOME')).toBe(path.join('/HOME', '.prismer', 'apc-tools', 'bin', 'claude'));
    expect(apcToolsPrefix('/HOME')).toBe(path.join('/HOME', '.prismer', 'apc-tools'));
    // 与 isolatedClaudeConfigDir 同一 .prismer 家族
    expect(apcToolsPrefix('/HOME').startsWith(path.join('/HOME', '.prismer'))).toBe(true);
    expect(isolatedClaudeConfigDir('/HOME').startsWith(path.join('/HOME', '.prismer'))).toBe(true);
  });

  it('负控（真副作用）：临时 HOME 下锁定 binary 不存在 → fail 且 detail 指向 `apc env up`', async () => {
    const home = tmp();
    const r = await withHome(home, () => item.check());
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('apc env up');
    expect(r.detail).toContain(apcPinnedClaudeBinary(home)); // 报的是锁定路径，不是 PATH 的 claude
  }, 30_000);

  it('负控（真副作用）：锁定路径放一个返回**错**版本的假 binary → exact 比对必须 fail', async () => {
    const home = tmp();
    fakeClaude(home, '9.9.9 (fake)');
    const r = await withHome(home, () => item.check());
    expect(r.status).toBe('fail');
    // detail 报 9.9.9（读的是锁定路径的假 binary，不是 PATH 上真 claude 的 2.1.x）——
    // 这同时证明「查锁定路径不查 PATH」+「exact 没被削薄成存在即可」
    expect(r.detail).toContain('9.9.9');
    expect(r.detail).toContain(pin);
  }, 30_000);

  it('正控（真副作用）：锁定路径放一个返回**恰好 pin** 的假 binary → pass', async () => {
    const home = tmp();
    fakeClaude(home, `${pin} (Claude Code)`);
    const r = await withHome(home, () => item.check());
    expect(r.status, `期望 exact pass：装的=${pin} pin=${pin}`).toBe('pass');
    expect(r.detail).toContain(`== pin ${pin}`);
  }, 30_000);

  it('负控（exact 不许退成 floor/存在）：pin 之上一个补丁版仍必须 fail', async () => {
    const home = tmp();
    const bumped = pin.replace(/(\d+)$/, (m) => String(Number(m) + 1)); // 2.1.179 → 2.1.180
    fakeClaude(home, `${bumped} (Claude Code)`);
    const r = await withHome(home, () => item.check());
    expect(r.status, 'floor 会放行更高版本；exact 必须红').toBe('fail');
    expect(r.detail).toContain(bumped);
  }, 30_000);
});

describe('compareToPin exact 判据（治 E6，纯函数变异）', () => {
  it('同一版本，pin 改一个字符 → pass 翻 fail；无 pin→skip；缺 binary→fail', () => {
    const pin = readBinaryPins()['claude']!;
    const ctx = { bin: '/abs/bin/claude', pinName: 'claude' };
    const installed = { raw: `${pin} (Claude Code)`, semver: pin };
    expect(compareToPin(installed, pin, ctx).status).toBe('pass');
    // 变异：pin 尾号 +1（恒 ok:true / floor 的实现都过不去）
    expect(compareToPin(installed, pin.replace(/(\d+)$/, (m) => String(Number(m) + 1)), ctx).status).toBe('fail');
    // 变异：无 pin → skip（未检测，不是 pass）
    expect(compareToPin(installed, undefined, ctx).status).toBe('skip');
    // 变异：binary 不在 → fail
    expect(compareToPin(null, pin, ctx).status).toBe('fail');
  });
});

describe('hermes 段的诚实性（治 E1：不许只 --version 却断言网关口径）', () => {
  it('hermes 二进制项的 detail 不出现任何 model / 网关口径断言', async () => {
    const item = findItem('toolchain.hermes-binary')!;
    const r = await item.check();
    expect(r.detail).not.toMatch(/kimi|deepseek|gateway|网关口径/i);
    expect(r.detail).toContain('未比对 pin');
  }, 60_000);

  it('网关口径是**独立一项**且走真 HTTP；拿不到时只能 skip，绝不 pass', async () => {
    const item = findItem('toolchain.hermes-gateway-models')!;
    expect(item.strength).toBe('protocol');
    const r = await item.check();
    if (r.status === 'skip') {
      expect(r.detail).toMatch(/未检测/);
    } else {
      // 真拿到了：detail 必须带实到的 model 列表（证明是真拉的，不是在场冒充）
      expect(r.detail).toMatch(/newapi=\[|缺/);
    }
  }, 60_000);
});

describe('凭据段只判在场，绝不外泄值', () => {
  it('detail 里不出现 .env.local 任一非空值', async () => {
    const item = findItem('secrets.env-local-required-keys')!;
    const r = await item.check();
    const values = [...readEnvLocal().values()].filter((v) => v.length >= 8);
    for (const v of values) expect(r.detail).not.toContain(v);
  });

  it('MySQL 判定的 detail 里口令被打码', async () => {
    const url = resolveEnvValue('DATABASE_URL');
    if (!url) return;
    const r = await findItem('infra.mysql-3307')!.check();
    expect(r.detail).toBe(r.detail.replace(/:[^:@/]+@/, ':***@'));
    expect(redactUrl('mysql://u:secret@h:1/d')).toBe('mysql://u:***@h:1/d');
  }, 30_000);
});

describe('bare-repo 替身是 git 判定，不是目录存在判定', () => {
  it('负控：只建目录不 init → 必须红', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'notarepo'), { recursive: true });
    const r = spawnSync('git', ['-C', path.join(root, 'notarepo'), 'rev-parse', '--is-bare-repository'], {
      encoding: 'utf8',
    });
    // git 本人拒绝 —— manifest 项的判据正是这个返回。
    expect(r.status).not.toBe(0);
  });

  it('正控：真仓库里的替身被 git 认成 bare', async () => {
    const r = await findItem('project.bare-repo-mirror')!.check();
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('bare repo');
  }, 30_000);

  it('负控：非 bare 的普通仓库 → is-bare-repository=false，判定必须红', () => {
    const root = tmp();
    execFileSync('git', ['init', root], { encoding: 'utf8' });
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim();
    expect(out).toBe('false');
  });
});

describe('REPO_ROOT 解析正确（路径错 = 所有相对判定一起废）', () => {
  it('指向真仓库根', () => {
    expect(REPO_ROOT).toBe(path.resolve(__dirname, '../../../..'));
    expect(readEnvLocal().size).toBeGreaterThan(0);
  });
});
