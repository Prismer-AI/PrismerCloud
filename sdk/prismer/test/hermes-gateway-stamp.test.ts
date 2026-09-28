/**
 * hermes gateway spawn-stamp / 漂移检测（2026-07-16）
 *
 * 背景：composer 里换模型/渠道 = 改 profile.config。但 hermes 的 model 与 provider
 * base_url 是 **spawn 时**烤进 gateway 的（config.yaml 进程启动读一次、key 进 spawn
 * env），`ensureService` 的复用探针只确认「端口上那个 gateway 是我们的」就复用 ——
 * 于是新配置写进了磁盘，跑的还是老模型，用户的选择静默无效。
 *
 * 修法：spawn 成功那刻写一份 stamp（当时的 model/provider/base/keyHash），dispatch
 * 前拿 profile 的期望值跟 stamp 比，不一致就杀进程重启。
 *
 * ⚠️ 为什么不能用 config.yaml 自己做见证（这些用例守的就是这个）：`config.yaml` 在
 * dispatch 之前已经被三条路径写成新值了（prepareProfile 在 boot sync 与
 * syncProfileFromCloud、ensureService 每次复用、prewarm），拿它 diff 永远读到相等
 * → 永不触发。stamp 是独立见证，才能反映「跑着的进程当初带的是什么」。
 *
 * 最重要的用例是 (1) 稳态无 churn —— 误报会让每次 dispatch 都重启 gateway、清空该
 * daemon 上所有 hermes 会话的内存上下文（sessions-dispatcher.ts:696-705）。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildHermesApiServerModelNameEnv,
  hermesGatewayConfigDrifted,
  resolveHermesApiServerModelNameOverride,
  writeHermesGatewayStamp,
} from '../src/adapters/persistence/hermes/index.js';

type ProfileLike = Parameters<typeof hermesGatewayConfigDrifted>[0];

function profile(config: Record<string, unknown>): ProfileLike {
  return {
    id: 'profile-stamp-test',
    agentUsername: 'stamp-test',
    config: {
      apiKey: 'hermes-api-key',
      hermesProfileName: 'stamp-test',
      ...config,
    },
  } as ProfileLike;
}

/** 隔离的 HERMES_HOME 里跑一段（stamp 写在 profile dir 下）。 */
async function withHome<T>(fn: (profileDir: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-stamp-'));
  const oldHome = process.env.HERMES_HOME;
  const oldBase = process.env.PRISMER_BASE_URL;
  const oldKey = process.env.PRISMER_API_KEY;
  process.env.HERMES_HOME = join(home, 'hermes');
  process.env.PRISMER_BASE_URL = 'http://127.0.0.1:3000';
  process.env.PRISMER_API_KEY = 'sk-prismer-test';
  try {
    const profileDir = join(process.env.HERMES_HOME, 'profiles', 'stamp-test');
    mkdirSync(profileDir, { recursive: true });
    return await fn(profileDir);
  } finally {
    if (oldHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHome;
    if (oldBase === undefined) delete process.env.PRISMER_BASE_URL;
    else process.env.PRISMER_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.PRISMER_API_KEY;
    else process.env.PRISMER_API_KEY = oldKey;
    rmSync(home, { recursive: true, force: true });
  }
}

async function withRuntimeEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('hermes gateway spawn stamp — 漂移检测', () => {
  describe('API server advertised-model collision', () => {
    it('derives a deterministic virtual model name only when profile name equals the real model id', () => {
      expect(resolveHermesApiServerModelNameOverride('deepseek-v4-flash', 'deepseek-v4-flash')).toBe(
        'prismer-profile:deepseek-v4-flash',
      );
      expect(resolveHermesApiServerModelNameOverride('engineer', 'deepseek-v4-flash')).toBeUndefined();
    });

    it('injects API_SERVER_MODEL_NAME into the spawn env only for a collision', () => {
      expect(buildHermesApiServerModelNameEnv('deepseek-v4-flash', 'deepseek-v4-flash')).toEqual({
        API_SERVER_MODEL_NAME: 'prismer-profile:deepseek-v4-flash',
      });
      expect(buildHermesApiServerModelNameEnv('engineer', 'deepseek-v4-flash')).toStrictEqual({
        API_SERVER_MODEL_NAME: undefined,
      });
    });

    it('treats a legacy collision stamp as drift so the old gateway respawns once', async () => {
      await withHome(async (profileDir) => {
        const cfg = { model: 'stamp-test', proxyProvider: 'newapi' };
        writeHermesGatewayStamp('stamp-test', {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'stamp-test',
          ...cfg,
        } as never);

        const stampPath = join(profileDir, '.prismer-gateway.json');
        const legacyStamp = JSON.parse(readFileSync(stampPath, 'utf8')) as Record<string, unknown>;
        delete legacyStamp.apiServerModelNameOverride;
        writeFileSync(stampPath, JSON.stringify(legacyStamp), 'utf8');

        expect(hermesGatewayConfigDrifted(profile(cfg))).toBe(true);
      });
    });

    it('keeps a collision gateway stable after the replacement stamp is written', async () => {
      await withHome(async () => {
        const cfg = { model: 'stamp-test', proxyProvider: 'newapi' };
        writeHermesGatewayStamp('stamp-test', {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'stamp-test',
          ...cfg,
        } as never);

        expect(hermesGatewayConfigDrifted(profile(cfg))).toBe(false);
      });
    });
  });

  it('稳态：stamp 与 profile 一致 → 不漂移（不制造 respawn churn）', async () => {
    await withHome(async () => {
      const cfg = { model: 'us-kimi-k2.6', proxyProvider: 'newapi' };
      // 模拟 spawn 分支落见证
      writeHermesGatewayStamp('stamp-test', {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'stamp-test',
        ...cfg,
      } as never);
      expect(hermesGatewayConfigDrifted(profile(cfg))).toBe(false);
    });
  });

  it('换模型：stamp=us-kimi-k2.6 vs profile=deepseek-v4-pro → 漂移', async () => {
    await withHome(async () => {
      writeHermesGatewayStamp('stamp-test', {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'stamp-test',
        model: 'us-kimi-k2.6',
        proxyProvider: 'newapi',
      } as never);
      expect(
        hermesGatewayConfigDrifted(profile({ model: 'deepseek-v4-pro', proxyProvider: 'newapi' })),
      ).toBe(true);
    });
  });

  it('只换渠道（模型不变）→ 漂移：比的是解析后的 provider base，不只是字符串', async () => {
    await withHome(async () => {
      writeHermesGatewayStamp('stamp-test', {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'stamp-test',
        model: 'us-kimi-k2.6',
        proxyProvider: 'newapi',
      } as never);
      // 同一个 model，只把渠道从 newapi 换到 deepseek —— base_url 变了，必须重启
      expect(
        hermesGatewayConfigDrifted(profile({ model: 'us-kimi-k2.6', proxyProvider: 'deepseek' })),
      ).toBe(true);
    });
  });

  it('冷启动：无 stamp 且无活着的 gateway → 不漂移（别 kill-storm）', async () => {
    await withHome(async () => {
      // 没写 stamp，端口上也没有 hermes gateway 进程
      expect(hermesGatewayConfigDrifted(profile({ model: 'us-kimi-k2.6' }))).toBe(false);
    });
  });

  it('stamp 损坏（非法 JSON）当作无 stamp，不抛', async () => {
    await withHome(async (profileDir) => {
      writeFileSync(join(profileDir, '.prismer-gateway.json'), '{not json', 'utf8');
      expect(() => hermesGatewayConfigDrifted(profile({ model: 'us-kimi-k2.6' }))).not.toThrow();
      expect(hermesGatewayConfigDrifted(profile({ model: 'us-kimi-k2.6' }))).toBe(false);
    });
  });

  it('写盘失败/文件丢失：进程内见证仍在 → 换配置照样判漂移（不退化成 kill-storm 温床）', async () => {
    // 回归守卫（review CONFIRMED #1）：profile dir 不可写时 stamp 文件落不下，若只靠
    // 文件，dispatch 会把「本进程刚 spawn、只是没记下」当成无见证的孤儿 → 每条消息
    // kill+respawn、清空会话上下文。修法是 spawn 时同时在内存里见证。
    // 这里删掉 stamp 文件模拟写盘失败：
    //   · 换配置 → true（内存见证判出真漂移）；纯文件实现会读不到文件退回冷启动 false。
    //   · 同配置 → false（稳态不 churn）。
    await withHome(async (profileDir) => {
      writeHermesGatewayStamp('stamp-test', {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'stamp-test',
        model: 'us-kimi-k2.6',
        proxyProvider: 'newapi',
      } as never);
      unlinkSync(join(profileDir, '.prismer-gateway.json')); // 文件没了，只剩内存见证
      expect(hermesGatewayConfigDrifted(profile({ model: 'us-kimi-k2.6', proxyProvider: 'newapi' }))).toBe(false);
      expect(hermesGatewayConfigDrifted(profile({ model: 'deepseek-v4-pro', proxyProvider: 'newapi' }))).toBe(true);
    });
  });

  it('stamp round-trip：写进去的 model 就是 profile 的 model', async () => {
    await withHome(async () => {
      writeHermesGatewayStamp('stamp-test', {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'stamp-test',
        model: 'glm-5.2',
        proxyProvider: 'zhipu',
      } as never);
      // 同配置回读 → 不漂移，证明写入的字段与比较的字段是同一套
      expect(hermesGatewayConfigDrifted(profile({ model: 'glm-5.2', proxyProvider: 'zhipu' }))).toBe(false);
    });
  });

  describe('runtime env 漂移检测（MemoryProvider / recall-tools）', () => {
    const runtimeProfile = {
      id: 'profile-stamp-test',
      agentUsername: 'stamp-test',
      workspaceId: 'ws-runtime',
      agentImUserId: 'agent-runtime',
      config: {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'stamp-test',
        model: 'us-kimi-k2.6',
        proxyProvider: 'newapi',
        installRecallToolsPlugin: true,
      },
    } as ProfileLike;

    it('稳态：recall-tools + daemon port + identity 一致 → 不漂移', async () => {
      await withHome(async () => {
        await withRuntimeEnv(
          {
            PRISMER_RECALL_TOOLS_PLUGIN: '1',
            PRISMER_DAEMON_PORT: '3215',
            PRISMER_MEMORY_PROVIDER: undefined,
          },
          async () => {
            writeHermesGatewayStamp('stamp-test', runtimeProfile.config as never, runtimeProfile);
            expect(hermesGatewayConfigDrifted(runtimeProfile)).toBe(false);
          },
        );
      });
    });

    it('旧 stamp 缺 runtimeEnvHash，启用 recall-tools 后必须漂移一次', async () => {
      await withHome(async (profileDir) => {
        await withRuntimeEnv(
          {
            PRISMER_RECALL_TOOLS_PLUGIN: '1',
            PRISMER_DAEMON_PORT: '7878',
            PRISMER_MEMORY_PROVIDER: undefined,
          },
          async () => {
            writeHermesGatewayStamp('stamp-test', runtimeProfile.config as never, runtimeProfile);
            const stampPath = join(profileDir, '.prismer-gateway.json');
            const legacyStamp = JSON.parse(readFileSync(stampPath, 'utf8')) as Record<string, unknown>;
            delete legacyStamp.runtimeEnvHash;
            writeFileSync(stampPath, JSON.stringify(legacyStamp), 'utf8');
          },
        );
        await withRuntimeEnv(
          {
            PRISMER_RECALL_TOOLS_PLUGIN: '1',
            PRISMER_DAEMON_PORT: '3215',
            PRISMER_MEMORY_PROVIDER: undefined,
          },
          async () => {
            expect(hermesGatewayConfigDrifted(runtimeProfile)).toBe(true);
          },
        );
      });
    });

    it('daemon port 从 agent-rt fallback 7878 变成 desktop embedded 3215 → 漂移', async () => {
      await withHome(async () => {
        await withRuntimeEnv(
          {
            PRISMER_RECALL_TOOLS_PLUGIN: '1',
            PRISMER_DAEMON_PORT: '7878',
            PRISMER_MEMORY_PROVIDER: undefined,
          },
          async () => {
            writeHermesGatewayStamp('stamp-test', runtimeProfile.config as never, runtimeProfile);
          },
        );
        await withRuntimeEnv(
          {
            PRISMER_RECALL_TOOLS_PLUGIN: '1',
            PRISMER_DAEMON_PORT: '3215',
            PRISMER_MEMORY_PROVIDER: undefined,
          },
          async () => {
            expect(hermesGatewayConfigDrifted(runtimeProfile)).toBe(true);
          },
        );
      });
    });
  });

  // ── product204/30 Track C1 — scope 轴漂移守护 ────────────────────────────────
  //
  // toolsetScope / nativeSkillScope / mcpAllowlist 也是 spawn 时烤进 config.yaml 的
  // （agent.disabled_toolsets / skills.disabled / MCP allowlist）。改角色能力门后
  // 若 stamp 只比 model/provider，drift 判 false → gateway 被复用 → 新能力门静默无效。
  // 下面这条是负控：model/provider 完全不变，只改 toolsetScope，必须判漂移；只有
  // buildGatewayStamp 带上 scopeHash 才能过（抽掉 scopeHash 字段 → 该用例翻红）。
  describe('scope 轴漂移检测（Track C1）', () => {
    it('负控：model/provider 不变，只换 toolsetScope → 漂移', async () => {
      await withHome(async () => {
        writeHermesGatewayStamp('stamp-test', {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'stamp-test',
          model: 'us-kimi-k2.6',
          proxyProvider: 'newapi',
          toolsetScope: { mode: 'deny', toolsets: ['web'] },
        } as never);
        expect(
          hermesGatewayConfigDrifted(
            profile({
              model: 'us-kimi-k2.6',
              proxyProvider: 'newapi',
              toolsetScope: { mode: 'deny', toolsets: ['web', 'terminal'] },
            }),
          ),
        ).toBe(true);
      });
    });

    it('稳态：toolsetScope 数组只是顺序不同 → 不漂移（归一化排序）', async () => {
      await withHome(async () => {
        writeHermesGatewayStamp('stamp-test', {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'stamp-test',
          model: 'us-kimi-k2.6',
          proxyProvider: 'newapi',
          toolsetScope: { mode: 'deny', toolsets: ['web', 'terminal'] },
        } as never);
        expect(
          hermesGatewayConfigDrifted(
            profile({
              model: 'us-kimi-k2.6',
              proxyProvider: 'newapi',
              toolsetScope: { mode: 'deny', toolsets: ['terminal', 'web'] },
            }),
          ),
        ).toBe(false);
      });
    });

    it('换 nativeSkillScope（skills.disabled 源）→ 漂移', async () => {
      await withHome(async () => {
        writeHermesGatewayStamp('stamp-test', {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'stamp-test',
          model: 'us-kimi-k2.6',
          proxyProvider: 'newapi',
          nativeSkillScope: { mode: 'allow', skills: ['pdf-processing'] },
        } as never);
        expect(
          hermesGatewayConfigDrifted(
            profile({
              model: 'us-kimi-k2.6',
              proxyProvider: 'newapi',
              nativeSkillScope: { mode: 'allow', skills: ['pdf-processing', 'web-scraping'] },
            }),
          ),
        ).toBe(true);
      });
    });

    it('换 mcpAllowlist → 漂移；同集合乱序 → 不漂移', async () => {
      await withHome(async () => {
        writeHermesGatewayStamp('stamp-test', {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'stamp-test',
          model: 'us-kimi-k2.6',
          proxyProvider: 'newapi',
          mcpAllowlist: ['task.create', 'task.list'],
        } as never);
        expect(
          hermesGatewayConfigDrifted(
            profile({ model: 'us-kimi-k2.6', proxyProvider: 'newapi', mcpAllowlist: ['task.create'] }),
          ),
        ).toBe(true);
        // 同一集合、顺序不同 → 归一化后不漂移
        expect(
          hermesGatewayConfigDrifted(
            profile({ model: 'us-kimi-k2.6', proxyProvider: 'newapi', mcpAllowlist: ['task.list', 'task.create'] }),
          ),
        ).toBe(false);
      });
    });
  });
});
