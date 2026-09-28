// runtime210 G-A — pi-core built-in skill 解析与注入单测。
//
// 覆盖面:
//   1. resolveSkillsRoot pi-core 三态:显式 config.skillsDir / agent-dir ctx
//      路径 / 无路径 fallback (pi-core → null,hermes → profile dir 负控)
//   2. dispatch system prompt 组合:pi-core 收到渲染后的 SKILL.md 文本
//      (metadata.systemPrompt 可断言),hermes 组合不变 (负控 — hermes 保持
//      MEMORY.md carrier 语义,不把 skill 文本拼进 systemPrompt)

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePaths } from '../src/config.js';
import { resolveSkillsRoot } from '../src/daemon/skill-sync.js';
import { handleDispatch } from '../src/daemon/dispatch.js';
import type { AdapterDef, AgentProfile, TaskInput } from '../src/adapters/contract.js';

const cleanupDirs: string[] = [];
const oldHermesHome = process.env.HERMES_HOME;

afterEach(() => {
  process.env.HERMES_HOME = oldHermesHome;
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `prismer-picore-skill-${label}-`));
  cleanupDirs.push(dir);
  return dir;
}

function makeProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-1',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-1',
    adapterName: 'pi-core',
    name: 'Pi Core',
    config: {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function seedSkill(skillsDir: string, slug: string, body: string): void {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

describe('runtime210 G-A — resolveSkillsRoot pi-core 同权', () => {
  it('显式 config.skillsDir 对 pi-core 生效 (与 hermes 同权)', () => {
    const explicit = join(tempRoot('explicit'), 'my-skills');
    const piCore = resolveSkillsRoot(makeProfile({ config: { skillsDir: explicit } }), 'agent-1');
    const hermes = resolveSkillsRoot(
      makeProfile({ adapterName: 'hermes', config: { skillsDir: explicit } }),
      'agent-1',
    );
    expect(piCore).toBe(explicit);
    expect(hermes).toBe(explicit);
  });

  it('agent-dir ctx 对 pi-core 解析 devices/<did>/agents/<aid>/skills/', () => {
    const home = tempRoot('agentdir');
    const paths = resolvePaths(home);
    const root = resolveSkillsRoot(makeProfile(), 'agent-x', { paths, daemonId: 'daemon-y' });
    expect(root).toBe(join(home, 'devices', 'daemon-y', 'agents', 'agent-x', 'skills'));
  });

  it('无 ctx 无显式目录:pi-core → null (无 legacy 载体),hermes → profile dir (负控)', () => {
    const hermesHome = tempRoot('hermes-home');
    process.env.HERMES_HOME = hermesHome;
    const piCore = resolveSkillsRoot(makeProfile(), undefined, undefined);
    expect(piCore).toBeNull();
    const hermes = resolveSkillsRoot(
      makeProfile({ adapterName: 'hermes', config: { hermesProfileName: 'ceo' } }),
      undefined,
      undefined,
    );
    expect(hermes).toBe(join(hermesHome, 'profiles', 'ceo', 'skills'));
  });

  it('非消费者 adapter 仍返回 null (codex 行为不变)', () => {
    const explicit = join(tempRoot('codex'), 'skills');
    const codex = resolveSkillsRoot(
      makeProfile({ adapterName: 'codex', config: { skillsDir: explicit } }),
      'agent-1',
    );
    expect(codex).toBeNull();
  });
});

describe('runtime210 G-A — dispatch system prompt skill 注入', () => {
  const SKILL_TOKEN = 'PICORE-SKILL-TOKEN-7f3a';

  function makeCloud(profile: AgentProfile) {
    return {
      get: vi.fn(async (path: string) => {
        if (path === `/api/im/agent_profiles/${profile.id}`) return profile;
        if (path.startsWith('/api/im/skills/installed?')) return [];
        if (path.startsWith('/api/im/memory/digest?')) return { digest: '', filesTotal: 0 };
        if (path.startsWith('/api/im/tasks?')) return [];
        throw new Error(`unexpected GET ${path}`);
      }),
      request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: { installed: 0 } } })),
    };
  }

  function runDispatch(
    profile: AgentProfile,
    adapterName: string,
    payloadPatch: Record<string, unknown> = {},
  ) {
    const sent: unknown[] = [];
    const dispatch = vi.fn(async (task: TaskInput) => ({ ok: true, output: task.prompt, task }));
    const adapter: AdapterDef = {
      name: adapterName,
      kind: 'long-running',
      capabilities: [],
      workspaceSchema: {} as unknown,
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    };
    const cloud = makeCloud(profile);
    const invoke = () =>
      handleDispatch(
        {
          taskId: `task-${adapterName}`,
          agentImUserId: 'agent-1',
          profileId: profile.id,
          capability: 'chat',
          prompt: 'read values.txt and write summary.txt',
          ...payloadPatch,
        },
        'req-1',
        {
          registry: { get: () => adapter } as never,
          cloud: cloud as never,
          uriResolver: {
            rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
            rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
          } as never,
          assetCache: { unpin: vi.fn(), pin: vi.fn() } as never,
          ws: { send: (msg: unknown) => sent.push(msg) } as never,
          ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
        },
      );
    return { invoke, dispatch, sent };
  }

  it('pi-core dispatch 把 skillsDir 里的 SKILL.md 文本拼进 system prompt (可断言)', async () => {
    const home = tempRoot('dispatch-pi');
    const skillsDir = join(home, 'skills');
    seedSkill(skillsDir, 'probe-skill', `---\nname: probe-skill\n---\n\n# Probe\n\n${SKILL_TOKEN}\n`);
    const profile = makeProfile({
      config: { cwd: home, systemPrompt: 'You are a pi-core test agent.', skillsDir },
    });
    const { invoke, dispatch } = runDispatch(profile, 'pi-core');

    const reply = await invoke();
    expect(reply.ok).toBe(true);

    const task = dispatch.mock.calls[0]![0] as TaskInput;
    const systemPrompt = String(task.metadata?.systemPrompt ?? '');
    expect(systemPrompt).toContain('[Installed Skills]');
    expect(systemPrompt).toContain('## probe-skill');
    expect(systemPrompt).toContain(SKILL_TOKEN);
    // Persona 仍在组合里 (skill 是追加,不是替换)。
    expect(systemPrompt).toContain('You are a pi-core test agent.');
  });

  it('hermes dispatch 组合不变 — skill 文本不进 systemPrompt (负控, MEMORY.md carrier 语义保留)', async () => {
    const home = tempRoot('dispatch-hermes');
    const skillsDir = join(home, 'skills');
    seedSkill(skillsDir, 'probe-skill', `---\nname: probe-skill\n---\n\n# Probe\n\n${SKILL_TOKEN}\n`);
    const profile = makeProfile({
      id: 'profile-hermes',
      adapterName: 'hermes',
      config: { systemPrompt: 'You are Hermes.', skillsDir },
    });
    const { invoke, dispatch } = runDispatch(profile, 'hermes');

    const reply = await invoke();
    expect(reply.ok).toBe(true);

    const task = dispatch.mock.calls[0]![0] as TaskInput;
    const systemPrompt = String(task.metadata?.systemPrompt ?? '');
    expect(systemPrompt).toContain('You are Hermes.');
    expect(systemPrompt).not.toContain(SKILL_TOKEN);
    expect(systemPrompt).not.toContain('[Installed Skills]');
  });

  it('runtime210/09 §2.3 — pi-core dispatch with a workdir payload stamps the materialized workdir onto the task cwd', async () => {
    // The dispatch-side half of the P1-C chain: shouldOverrideCwdForWorkdir
    // must accept pi-core → ensureWorkdir materializes the picked dir → the
    // materialized cwd rides task.metadata.prismerScratchDir/prismerWorkDir
    // (which the pi-core driver then binds as the session jail — pinned in
    // pi-core-adapter.test.ts).
    const home = tempRoot('dispatch-workdir');
    const workdir = join(home, 'repo');
    mkdirSync(workdir, { recursive: true });
    const profile = makeProfile({ config: { cwd: join(home, 'profile-cwd'), systemPrompt: 'pi.' } });
    mkdirSync(join(home, 'profile-cwd'), { recursive: true });

    const { invoke, dispatch } = runDispatch(profile, 'pi-core', {
      workdir: { id: 'wp-pi', cwd: workdir, source: 'host-pick' },
    });
    const reply = await invoke();
    expect(reply.ok).toBe(true);

    const task = dispatch.mock.calls[0]![0] as TaskInput;
    expect(task.metadata?.prismerScratchDir).toBe(workdir);
    expect(task.metadata?.prismerWorkDir).toBe(workdir);
    // Negative control: the profile cwd must NOT have been substituted.
    expect(task.metadata?.prismerScratchDir).not.toBe(join(home, 'profile-cwd'));
  });
});
