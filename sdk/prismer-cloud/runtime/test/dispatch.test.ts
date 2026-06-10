import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendGoalContext,
  appendMemoryContext,
  composePrompt,
  handleDispatch,
  mergeHermesBridgeMetadata,
  mergeObservabilityMetadata,
  resolveOperatingPrinciples,
} from '../src/daemon/dispatch.js';
import type { TaskDispatchContextEntry } from '../src/types/im-events.js';
import type { AdapterDef, AgentProfile } from '../src/adapters/contract.js';

const ctx = (sender: string, content: string): TaskDispatchContextEntry => ({
  sender,
  senderRole: 'human',
  content,
  createdAt: new Date().toISOString(),
});

describe('composePrompt', () => {
  it('returns prompt verbatim when no context', () => {
    expect(composePrompt('do X', [], 1000)).toBe('do X');
  });

  it('prepends context history with sender/role tags', () => {
    const out = composePrompt('current msg', [ctx('alice', 'hi'), ctx('bob', 'lo')], 1000);
    expect(out).toContain('[human] @alice: hi');
    expect(out).toContain('[human] @bob: lo');
    expect(out).toContain('[当前消息] current msg');
  });

  it('drops oldest entries when total chars exceed cap', () => {
    const long = 'x'.repeat(500);
    const entries = [
      ctx('a', long),
      ctx('b', long),
      ctx('c', long),
    ];
    const out = composePrompt('now', entries, 800);
    // First entry should have been dropped (3*500 > 800; keep last 1).
    expect(out).not.toContain('@a:');
    expect(out).toContain('@c:');
  });

  it('always keeps at least one context entry even if oversized', () => {
    const big = 'y'.repeat(10_000);
    const out = composePrompt('now', [ctx('only', big)], 100);
    expect(out).toContain('@only:');
    expect(out).toContain('[当前消息] now');
  });

  // ─── Wave-8 W1: asset blocks ───────────────────────────────────────
  it('prepends asset blocks above conversation history', () => {
    const block = '[Attached file] id=ast-1 mime=text/markdown\n---\nMD-FACT-abc\n---';
    const out = composePrompt('echo it', [ctx('alice', 'go')], 1000, [block]);
    const blockIdx = out.indexOf('MD-FACT-abc');
    const histIdx = out.indexOf('@alice:');
    const promptIdx = out.indexOf('[当前消息]');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(histIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(histIdx);
    expect(histIdx).toBeLessThan(promptIdx);
  });

  it('asset blocks survive even when context is empty', () => {
    const block = '[Attached file] id=ast-2 mime=text/plain\n---\nbody\n---';
    const out = composePrompt('do thing', [], 1000, [block]);
    expect(out).toContain('body');
    expect(out).toContain('do thing');
  });

  it('asset blocks are not counted against the context-window cap', () => {
    // Asset block far exceeds the 100-char cap, but conversation entries
    // should still be retained — assets are user-attached and trimming
    // them silently would defeat the attachment.
    const huge = '[Attached file] id=ast-3 mime=text/plain\n---\n' + 'z'.repeat(5000) + '\n---';
    const out = composePrompt('current', [ctx('alice', 'go')], 100, [huge]);
    expect(out).toContain('@alice:');
    expect(out).toContain('[当前消息] current');
    expect(out).toContain('zzz');
  });
});

describe('appendGoalContext', () => {
  it('prepends active goal projections without changing the task contract', () => {
    const out = appendGoalContext('do the work', [
      {
        id: 'goal-1',
        title: 'Keep launch notes current',
        description: 'Update every checkpoint evidence field',
        metadata: { goal: { priority: 'high' } },
      },
    ]);
    expect(out).toContain('[Active Goals]');
    expect(out).toContain('[high] Keep launch notes current');
    expect(out).toContain('do the work');
  });
});

describe('appendMemoryContext', () => {
  it('prepends loaded memory digest without changing the task contract', () => {
    const out = appendMemoryContext('answer the user', {
      status: 'loaded',
      digest: '# Memory Digest\n\n- prefers terse launch checklists',
      filesSummarized: 1,
      filesTotal: 1,
      totalBytes: 42,
      durationMs: 3,
    });
    expect(out).toContain('[Memory Context]');
    expect(out).toContain('prefers terse launch checklists');
    expect(out).toContain('answer the user');
  });

  it('does not inject empty or failed memory', () => {
    const empty = appendMemoryContext('answer', {
      status: 'empty',
      digest: '',
      filesSummarized: 0,
      filesTotal: 0,
      totalBytes: 0,
      durationMs: 1,
    });
    expect(empty).toBe('answer');
  });
});

describe('resolveOperatingPrinciples', () => {
  it('prefers profile operating principles over role-template defaults', () => {
    const out = resolveOperatingPrinciples({
      operatingPrinciples: 'Profile rule: own the current turn.',
      roleTemplate: {
        operatingPrinciples: 'Template rule: should not win.',
      },
      approvalPolicy: 'strict',
    });
    expect(out).toContain('Profile rule: own the current turn.');
    expect(out).not.toContain('Template rule: should not win.');
    expect(out).toContain('Approval policy: strict.');
  });

  it('falls back to role-template operating principles and policy', () => {
    const out = resolveOperatingPrinciples({
      roleTemplate: {
        operatingPrinciples: { zh: '模板规则：优先创建任务。' },
        approvalPolicy: 'autonomous',
      },
    });
    expect(out).toContain('模板规则：优先创建任务。');
    expect(out).toContain('Approval policy: autonomous.');
  });

  it('renders role-template operating principles arrays in agency then 30-acp order', () => {
    const out = resolveOperatingPrinciples({
      roleTemplate: {
        operatingPrinciples: [
          { source: '30-acp', text: 'Global fallback rule.' },
          { source: 'agency', text: 'Agency persona rule.' },
        ],
      },
    });
    expect(out.indexOf('Agency persona rule.')).toBeLessThan(out.indexOf('Global fallback rule.'));
    expect(out).toContain('Approval policy: auto-low-risk.');
  });

  it('prefers profile operating principles arrays over role-template defaults', () => {
    const out = resolveOperatingPrinciples({
      operatingPrinciples: [
        { source: 'agency', text: 'Profile agency rule.' },
        { source: '30-acp', text: 'Profile global rule.' },
      ],
      roleTemplate: {
        operatingPrinciples: 'Template rule: should not win.',
      },
    });
    expect(out).toContain('Profile agency rule.');
    expect(out).toContain('Profile global rule.');
    expect(out).not.toContain('Template rule: should not win.');
  });

  it('uses default operating principles when profile and template omit them', () => {
    const out = resolveOperatingPrinciples({});
    expect(out).toContain('Assignable work should become explicit tasks');
    expect(out).toContain('Approval policy: auto-low-risk.');
  });
});

describe('mergeHermesBridgeMetadata', () => {
  it('preserves existing metadata and bridge siblings while patching Hermes', () => {
    const merged = mergeHermesBridgeMetadata(
      {
        kind: 'goal',
        bridge: {
          other: { ok: true },
          hermes: { previous: 'kept', status: 'old' },
        },
      },
      { status: 'dispatched', runId: 'run-1', lastSyncedAt: '2026-05-06T00:00:00.000Z' },
    );
    expect(merged.kind).toBe('goal');
    expect((merged.bridge as any).other).toEqual({ ok: true });
    expect((merged.bridge as any).hermes).toMatchObject({
      previous: 'kept',
      status: 'dispatched',
      runId: 'run-1',
      lastSyncedAt: '2026-05-06T00:00:00.000Z',
    });
  });
});

describe('mergeObservabilityMetadata', () => {
  it('preserves bridge metadata while patching observability snapshot', () => {
    const merged = mergeObservabilityMetadata(
      {
        bridge: { hermes: { runId: 'run-1' } },
        observability: { auth: { ok: true } },
      },
      { memory: { status: 'loaded', filesTotal: 1 }, goals: { count: 2 } },
    );
    expect((merged.bridge as any).hermes.runId).toBe('run-1');
    expect((merged.observability as any).auth.ok).toBe(true);
    expect((merged.observability as any).memory.filesTotal).toBe(1);
    expect((merged.observability as any).goals.count).toBe(2);
  });
});

describe('handleDispatch Hermes convergence', () => {
  it('injects vision-aux descriptions for image asset refs before adapter dispatch', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'prismer-dispatch-vision-'));
    try {
      const imagePath = join(tempRoot, 'image.png');
      const cacheDir = join(tempRoot, 'cache');
      const contentHash = 'b'.repeat(64);
      writeFileSync(imagePath, Buffer.from('fake image bytes'));

      const sent: unknown[] = [];
      const requests: Array<{ method: string; path: string; body?: unknown }> = [];
      const profile: AgentProfile = {
        id: 'profile-image',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-1',
        adapterName: 'hermes',
        name: 'Hermes',
        config: { systemPrompt: 'You are Hermes.' },
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const dispatch = vi.fn(async (task) => ({ ok: true, output: task.prompt }));
      const adapter: AdapterDef = {
        name: 'hermes',
        kind: 'long-running',
        capabilities: [],
        workspaceSchema: {} as any,
        validate: () => ({ ok: true }),
        health: async () => ({ available: true }),
      };
      const cloud = {
        get: vi.fn(async (path: string) => {
          if (path === '/api/im/agent_profiles/profile-image') return profile;
          if (path.startsWith('/api/im/skills/installed?')) return [];
          if (path.startsWith('/api/im/memory/digest?')) return { digest: '', filesTotal: 0 };
          if (path.startsWith('/api/im/tasks?')) return [];
          if (path === '/api/im/runs/task-image') return { id: 'task-image', metadata: {} };
          throw new Error(`unexpected GET ${path}`);
        }),
        request: vi.fn(async (method: string, path: string, init: { body?: unknown }) => {
          requests.push({ method, path, body: init.body });
          if (path === '/api/internal/vision-aux/describe') {
            return {
              ok: true,
              status: 200,
              data: {
                ok: true,
                data: {
                  description: 'A login form with an email field and submit button.',
                  modelUsed: 'gpt-4o-mini',
                  provider: 'openai-compatible',
                  cacheTtlSec: 300,
                },
              },
            };
          }
          return { ok: true, status: 200, data: { ok: true, data: {} } };
        }),
      };

      const reply = await handleDispatch(
        {
          taskId: 'task-image',
          agentImUserId: 'agent-1',
          profileId: 'profile-image',
          capability: 'code',
          prompt: 'What is in this screenshot?',
          assetRefs: [
            {
              assetId: 'asset-image',
              contentHash,
              mime: 'image/png',
              sizeBytes: 16,
              kind: 'image',
              workspaceId: 'ws-1',
              role: 'attachment',
              filename: 'login.png',
            },
          ],
        },
        'req-image',
        {
          registry: { get: () => adapter } as any,
          cloud: cloud as any,
          uriResolver: { rewrite: async (text: string) => ({ text, resolvedHashes: [] }), rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }) } as any,
          assetCache: {
            getOrFetch: vi.fn(async () => ({ localPath: imagePath, sizeBytes: 16, mime: 'image/png' })),
            pin: vi.fn(),
            unpin: vi.fn(),
          } as any,
          ws: { send: (msg: unknown) => sent.push(msg) } as any,
          ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
          paths: {
            root: tempRoot,
            configFile: join(tempRoot, 'config.toml'),
            localDb: join(tempRoot, 'local.db'),
            cacheDir,
            logsDir: join(tempRoot, 'logs'),
            runsDir: join(tempRoot, 'runs'),
            // release201/09 §9.1 — new layout dirs (Phase 2 dispatch
            // resolves task workdir under these when profile.workspaceId
            // is set).
            workspacesDir: join(tempRoot, 'workspaces'),
            devicesDir: join(tempRoot, 'devices'),
          },
        },
      );

      expect(reply.ok).toBe(true);
      expect(dispatch.mock.calls[0]![0].prompt).toContain('[Image attachment: login.png]');
      expect(dispatch.mock.calls[0]![0].prompt).toContain('A login form with an email field and submit button.');
      const visionCall = requests.find((request) => request.path === '/api/internal/vision-aux/describe');
      expect(visionCall).toMatchObject({ method: 'POST' });
      expect((visionCall!.body as any).source.kind).toBe('data_url');
      const cached = JSON.parse(readFileSync(join(cacheDir, 'vision-cache', `${contentHash}.json`), 'utf8'));
      expect(cached.description).toContain('login form');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('loads active goal tasks and patches Hermes bridge metadata onto the same IM task', async () => {
    const sent: unknown[] = [];
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async (task) => ({
      ok: true,
      output: task.prompt,
      metadata: {
        hermes: {
          status: 'dispatched',
          runId: 'run-1',
          lastSyncedAt: '2026-05-06T00:00:00.000Z',
        },
      },
    }));
    const adapter: AdapterDef = {
      name: 'hermes',
      kind: 'long-running',
      capabilities: [],
      workspaceSchema: {} as any,
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    };
    const cloud = {
      get: vi.fn(async (path: string) => {
        if (path === '/api/im/agent_profiles/profile-1') return profile;
        if (path.startsWith('/api/im/tasks?')) {
          return [
            {
              id: 'goal-1',
              workspaceId: 'ws-1',
              title: 'Keep goals canonical',
              status: 'pending',
              assigneeId: 'agent-1',
              metadata: { kind: 'goal', intent: 'standing_objective', goal: { priority: 'high' } },
              updatedAt: '2026-05-06T01:00:00.000Z',
            },
          ];
        }
        if (path.startsWith('/api/im/memory/digest?')) {
          return {
            digest: '# Memory Digest\n\n## Facts\n- **launch.md** — Keep scope reuse-first',
            filesSummarized: 1,
            filesTotal: 1,
            totalBytes: 72,
          };
        }
        if (path === '/api/im/tasks/task-1') {
          return {
            task: {
              id: 'task-1',
              metadata: { bridge: { other: { status: 'ok' } } },
            },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
      request: vi.fn(async (method: string, path: string, init: { body?: unknown }) => {
        requests.push({ method, path, body: init.body });
        return { ok: true, status: 200, data: { ok: true, data: {} } };
      }),
    };

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'ship it',
      },
      'req-1',
      {
        registry: { get: () => adapter } as any,
        cloud: cloud as any,
        uriResolver: { rewrite: async (text: string) => ({ text, resolvedHashes: [] }), rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }) } as any,
        assetCache: { unpin: vi.fn() } as any,
        ws: { send: (msg: unknown) => sent.push(msg) } as any,
        ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
      },
    );

    expect(reply.ok).toBe(true);
    expect(dispatch.mock.calls[0]![0].prompt).toContain('[Memory Context]');
    expect(dispatch.mock.calls[0]![0].prompt).toContain('Keep scope reuse-first');
    expect(dispatch.mock.calls[0]![0].prompt).toContain('[Active Goals]');
    expect(dispatch.mock.calls[0]![0].prompt).toContain('Keep goals canonical');
    expect(dispatch.mock.calls[0]![0].metadata.prismerObservability.memory).toMatchObject({
      status: 'loaded',
      filesTotal: 1,
    });
    // v2.0 A3: operating principles are now composed into metadata.systemPrompt
    // (persona FIRST + principles SECOND, single composed string), not surfaced
    // via a separate metadata.operatingPrinciples key. Adapters read the
    // composed string from metadata.systemPrompt uniformly.
    expect(dispatch.mock.calls[0]![0].metadata.systemPrompt).toContain(
      'Assignable work should become explicit tasks',
    );
    expect(dispatch.mock.calls[0]![0].prompt).not.toContain('[Operating principles]');
    expect(dispatch.mock.calls[0]![0].metadata.prismerObservability.goals).toMatchObject({
      count: 1,
      mirroredCandidates: 1,
    });
    expect(dispatch.mock.calls[0]![0].metadata.prismerGoals).toEqual([
      expect.objectContaining({
        id: 'goal-1',
        title: 'Keep goals canonical',
        status: 'active',
        priority: 'high',
      }),
    ]);
    // release201/11 S23 — daemon now also fire-and-forget POSTs to
    // /api/im/metrics/batch for agent.dispatch + skill.invoked. Filter
    // those out before asserting on the bridge / observability PATCH
    // count which is what this test cares about.
    const taskPatches = requests.filter((r) => r.path.startsWith('/api/im/tasks/'));
    expect(taskPatches).toHaveLength(2);
    const bridgePatch = taskPatches.find((r) => (r.body as any).metadata.bridge);
    const observabilityPatch = taskPatches.find((r) => (r.body as any).metadata.observability);
    expect(bridgePatch).toMatchObject({ method: 'PATCH', path: '/api/im/tasks/task-1' });
    expect((bridgePatch!.body as any).metadata.bridge.other).toEqual({ status: 'ok' });
    expect((bridgePatch!.body as any).metadata.bridge.hermes).toMatchObject({
      status: 'dispatched',
      runId: 'run-1',
    });
    expect((observabilityPatch!.body as any).metadata.observability.identity).toMatchObject({
      loaded: true,
      profileId: 'profile-1',
    });
    expect(sent.length).toBeGreaterThan(0);
  });
});
