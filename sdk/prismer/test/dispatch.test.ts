import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adapterHasFilesystemTools,
  appendActiveKeyResultContext,
  appendActiveObjectiveContext,
  appendGoalContext,
  appendMemoryContext,
  CODING_SOUL_DEFAULT,
  composeActiveGoalContext,
  composeCoreDirectives,
  composePrompt,
  deriveLlmRoutingMetadata,
  handleDispatch,
  isCodingAdapter,
  isLimiterClassError,
  MEMORY_CORE_DIRECTIVE,
  mergeHermesBridgeMetadata,
  mergeObservabilityMetadata,
  parseOkrObjectiveContext,
  parseRetryAfterMs,
  PKF_REPORT_DIRECTIVE,
  renderIdentityLines,
  resolveOperatingPrinciples,
  resolveRetryBackoffMs,
  retryReasonToken,
} from '../src/daemon/dispatch.js';
import type { TaskDispatchContextEntry } from '../src/types/im-events.js';
import type { AdapterDef, AgentProfile } from '../src/adapters/contract.js';
import { validatePkfRuntimeCapability } from '../src/daemon/pkf-runtime-capability.js';
import { RunSessionRegistry, setRunSessionRegistry } from '../src/daemon/memory/run-session-map.js';
import { openLocalDb } from '../src/sync/store.js';

const ctx = (sender: string, content: string): TaskDispatchContextEntry => ({
  sender,
  senderRole: 'human',
  content,
  createdAt: new Date().toISOString(),
});

describe('served LLM routing evidence', () => {
  it('never labels configured intent as the model/provider that actually served the turn', () => {
    expect(deriveLlmRoutingMetadata({ model: 'configured-model', proxyProvider: 'configured-chain' })).toBeUndefined();
  });

  it('projects terminal adapter evidence verbatim', () => {
    expect(
      deriveLlmRoutingMetadata(
        { model: 'configured-model', proxyProvider: 'configured-chain' },
        { modelUsed: 'served-model', providerUsed: 'served-provider', chainId: 'served-chain' },
      ),
    ).toEqual({ modelUsed: 'served-model', providerUsed: 'served-provider', chainId: 'served-chain' });
  });

  it('does not fill a missing served provider from the configured provider', () => {
    expect(
      deriveLlmRoutingMetadata(
        { model: 'configured-model', proxyProvider: 'configured-provider' },
        { modelUsed: 'served-model' },
      ),
    ).toEqual({ modelUsed: 'served-model' });
  });
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
    const entries = [ctx('a', long), ctx('b', long), ctx('c', long)];
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

describe('appendActiveObjectiveContext', () => {
  it('prepends OKR objective and KR summaries with bounded rows', () => {
    const out = appendActiveObjectiveContext(
      'do the work',
      Array.from({ length: 5 }, (_, index) => ({
        id: `goal-${index + 1}`,
        title: `Goal ${index + 1}`,
        metadata: { kind: 'goal', okr: { objectiveId: `obj-${index + 1}` } },
        okrObjective: {
          id: `obj-${index + 1}`,
          title: `Objective ${index + 1}`,
          cycleLabel: '2026-W35',
          keyResults: [
            {
              id: `kr-${index + 1}-1`,
              title: 'Activation completed',
              status: 'on_track',
              current: 2,
              target: 4,
              unit: 'steps',
            },
            { id: `kr-${index + 1}-2`, title: 'Review gate passed', status: 'pending' },
          ],
        },
      })),
    );
    expect(out).toContain('[Active Objectives]');
    expect(out).toContain('Objective 1 (2026-W35)');
    expect(out).toContain('Activation completed 2/4steps [on_track]');
    expect(out).toContain('Review gate passed [pending]');
    expect(out).not.toContain('Objective 5');
    expect(out).toContain('do the work');
  });

  it('does not inject when no goal projection carries OKR objective data', () => {
    expect(appendActiveObjectiveContext('do the work', [{ id: 'goal-1', title: 'Goal 1' }])).toBe('do the work');
  });
});

describe('appendActiveKeyResultContext', () => {
  const goalWithKrs = (keyResults: unknown[]): Parameters<typeof appendActiveKeyResultContext>[1] => [
    {
      id: 'goal-1',
      title: 'Grow activation',
      metadata: { kind: 'goal', okr: { objectiveId: 'obj-1' } },
      okrObjective: {
        id: 'obj-1',
        title: 'Q3 activation',
        cycleLabel: '2026-W35',
        keyResults: keyResults as any,
      },
    },
  ];

  it('prepends the KR acceptance baseline/target/current the goal rows only summarise', () => {
    const out = appendActiveKeyResultContext(
      'do the work',
      goalWithKrs([
        {
          id: 'kr-1',
          title: 'First-run tasks',
          status: 'on_track',
          baseline: 0,
          current: 2,
          target: 4,
          unit: 'tasks',
        },
      ]),
    );
    expect(out).toContain('[Active Key Results]');
    expect(out).toContain('Q3 activation (2026-W35)');
    expect(out).toContain('First-run tasks');
    expect(out).toContain('baseline 0');
    expect(out).toContain('current 2');
    expect(out).toContain('target 4tasks');
    expect(out).toContain('[on_track]');
    expect(out).toContain('do the work');
  });

  it('omits numbers the KR does not carry instead of fabricating them', () => {
    const out = appendActiveKeyResultContext(
      'do the work',
      goalWithKrs([{ id: 'kr-1', title: 'Review gate passed', status: 'pending', target: 1 }]),
    );
    expect(out).toContain('Review gate passed');
    expect(out).toContain('target 1');
    expect(out).not.toContain('baseline');
    expect(out).not.toContain('current');
  });

  it('三项数字全缺 → 不留裸尾冒号（空壳读起来像「有进度没显示」）', () => {
    const out = appendActiveKeyResultContext(
      'do the work',
      goalWithKrs([{ id: 'kr-1', title: 'Review gate passed', status: 'pending' }]),
    );
    expect(out).toContain('Q3 activation (2026-W35) · Review gate passed [pending]');
    expect(out).not.toMatch(/· Review gate passed:/);
  });

  it('unit 只贴 target（口径同 [Active Objectives]，不是每个数字都带单位）', () => {
    const out = appendActiveKeyResultContext(
      'do the work',
      goalWithKrs([{ id: 'kr-1', title: 'First-run tasks', baseline: 0, current: 2, target: 4, unit: 'tasks' }]),
    );
    expect(out).toContain('baseline 0, current 2, target 4tasks');
    expect(out).not.toContain('0tasks');
    expect(out).not.toContain('2tasks');
  });

  it('bounds the rows per objective at the goal-context cap', () => {
    const out = appendActiveKeyResultContext(
      'do the work',
      goalWithKrs(
        Array.from({ length: 5 }, (_, index) => ({
          id: `kr-${index + 1}`,
          title: `KR ${index + 1}`,
          status: 'pending',
        })),
      ),
    );
    expect(out).toContain('KR 4');
    expect(out).not.toContain('KR 5');
  });

  it('does not inject when no active goal carries OKR key results', () => {
    expect(appendActiveKeyResultContext('do the work', [{ id: 'goal-1', title: 'Goal 1' }])).toBe('do the work');
  });

  it('reads the baseline off the cloud payload field names (Prisma row OR API alias)', () => {
    // 云端 GET /okr/objectives/:id 直接回 Prisma 行 → baselineNumeric/targetNumeric。
    const row = parseOkrObjectiveContext(
      {
        id: 'obj-1',
        title: 'Q3 activation',
        keyResults: [
          { id: 'kr-1', title: 'First-run tasks', status: 'on_track', baselineNumeric: 0, targetNumeric: 4 },
        ],
      },
      'fallback',
    );
    expect(row.keyResults[0].baseline).toBe(0);
    expect(row.keyResults[0].target).toBe(4);

    // API 别名形态（current/target/baseline）同样认。
    const alias = parseOkrObjectiveContext(
      {
        id: 'obj-1',
        title: 'Q3 activation',
        keyResults: [{ id: 'kr-1', title: 'First-run tasks', baseline: 1, current: 2, target: 4 }],
      },
      'fallback',
    );
    expect(alias.keyResults[0].baseline).toBe(1);
    expect(alias.keyResults[0].current).toBe(2);

    // 云端没给 baseline（老数据）→ null，不是 0（不伪造起点）。
    const missing = parseOkrObjectiveContext(
      { id: 'obj-1', title: 'Q3', keyResults: [{ id: 'kr-1', title: 'K', status: 'pending' }] },
      'fallback',
    );
    expect(missing.keyResults[0].baseline).toBeNull();
  });
});

describe('composeActiveGoalContext', () => {
  const goalWithObjective = {
    id: 'goal-1',
    title: 'Grow activation',
    metadata: { kind: 'goal', okr: { objectiveId: 'obj-1' } },
    okrObjective: {
      id: 'obj-1',
      title: 'Q3 activation',
      cycleLabel: '2026-W35',
      keyResults: [{ id: 'kr-1', title: 'First-run tasks', status: 'on_track', baseline: 0, current: 2, target: 4 }],
    },
  };

  it('stacks the three OKR-aware sections above the task body (KR → objective → goal)', () => {
    const out = composeActiveGoalContext('do the work', [goalWithObjective] as any);
    const krIdx = out.indexOf('[Active Key Results]');
    const objectiveIdx = out.indexOf('[Active Objectives]');
    const goalIdx = out.indexOf('[Active Goals]');
    const bodyIdx = out.indexOf('do the work');
    // 三段都靠前置拼接（每段都 prepend），故最近的段在最上：KR 最具体 → 最上。
    expect(krIdx).toBeGreaterThan(-1);
    expect(krIdx).toBeLessThan(objectiveIdx);
    expect(objectiveIdx).toBeLessThan(goalIdx);
    expect(goalIdx).toBeLessThan(bodyIdx);
  });

  it('leaves a task with no OKR-carrying goal byte-identical to the raw prompt', () => {
    expect(composeActiveGoalContext('do the work', [{ id: 'goal-1', title: 'Goal 1' }] as any)).toBe(
      '[Active Goals]\n1. [medium] Goal 1\n\ndo the work',
    );
  });

  it('leaves a task with no active goal at all byte-identical to the raw prompt', () => {
    expect(composeActiveGoalContext('do the work', [])).toBe('do the work');
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

  it('injects session recall content without requiring a stable digest', () => {
    const out = appendMemoryContext(
      'answer',
      {
        status: 'empty',
        digest: '',
        filesSummarized: 0,
        filesTotal: 0,
        totalBytes: 0,
        durationMs: 1,
      },
      { sessionRecallContent: '<memory-context>\n- via: grant:abc sourceWorkspaceId=ws_src\n</memory-context>' },
    );
    expect(out).toContain('[Memory Context]');
    expect(out).toContain('[Session Recall]');
    expect(out).toContain('sourceWorkspaceId=ws_src');
    expect(out).toContain('answer');
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
          uriResolver: {
            rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
            rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
          } as any,
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
        uriResolver: {
          rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
          rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
        } as any,
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
    expect(dispatch.mock.calls[0]![0].metadata.systemPrompt).toContain('Assignable work should become explicit tasks');
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

  /**
   * spec 11 T3-4（D-7 第 3 件）—— 真链路的验收 oracle：`handleDispatch` →
   * `loadGoalContext`（拉 workspace goal 任务）→ `loadOkrObjectiveContext`
   * （`GET /api/im/okr/objectives/:id`，云端回 Prisma 行 = `baselineNumeric`）
   * → prompt 装配。断言取适配器真正收到的那条 prompt（不是拼接函数自己）。
   */
  function buildOkrDeps(goalTasks: unknown[], objective: unknown) {
    const sent: unknown[] = [];
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
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
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
        if (path.startsWith('/api/im/tasks?')) return goalTasks;
        if (path === '/api/im/okr/objectives/obj-1') return objective;
        if (path.startsWith('/api/im/memory/digest?')) {
          return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
        }
        if (path === '/api/im/tasks/task-1') return { task: { id: 'task-1', metadata: {} } };
        throw new Error(`unexpected GET ${path}`);
      }),
      request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
    };
    return {
      dispatch,
      deps: {
        registry: { get: () => adapter } as any,
        cloud: cloud as any,
        uriResolver: {
          rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
          rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
        } as any,
        assetCache: { unpin: vi.fn() } as any,
        ws: { send: (msg: unknown) => sent.push(msg) } as any,
        ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
      },
    };
  }

  const GOAL_WITH_OKR = {
    id: 'goal-1',
    workspaceId: 'ws-1',
    title: 'Keep goals canonical',
    status: 'pending',
    assigneeId: 'agent-1',
    metadata: { kind: 'goal', intent: 'standing_objective', goal: { priority: 'high' }, okr: { objectiveId: 'obj-1' } },
    updatedAt: '2026-05-06T01:00:00.000Z',
  };
  const OBJECTIVE_ROW = {
    id: 'obj-1',
    title: 'Q3 activation',
    narrative: null,
    state: 'committed',
    cycleLabel: '2026-W35',
    // 云端 GET /okr/objectives/:id 直接回 Prisma 行 → baselineNumeric 等列名。
    keyResults: [
      {
        id: 'kr-1',
        title: 'First-run tasks',
        status: 'on_track',
        baselineNumeric: 0,
        currentNumeric: 2,
        targetNumeric: 4,
        unit: 'tasks',
      },
    ],
  };

  it('prompt 含 KR baseline/target/current（云端 Prisma 列名 → 注入段）', async () => {
    const { dispatch, deps } = buildOkrDeps([GOAL_WITH_OKR], OBJECTIVE_ROW);
    const reply = await handleDispatch(
      { taskId: 'task-1', agentImUserId: 'agent-1', profileId: 'profile-1', capability: 'code', prompt: 'ship it' },
      'req-okr-1',
      deps,
    );

    expect(reply.ok).toBe(true);
    const prompt = dispatch.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('[Active Key Results]');
    expect(prompt).toContain('Q3 activation (2026-W35)');
    expect(prompt).toContain('First-run tasks');
    expect(prompt).toContain('baseline 0');
    expect(prompt).toContain('current 2');
    expect(prompt).toContain('target 4tasks');
    expect(prompt).toContain('[on_track]');
    expect(prompt).toContain('ship it');
  });

  it('负控：goal 未挂 OKR → 无 [Active Key Results] 段（[Active Goals] 照旧）', async () => {
    const goalWithoutOkr = {
      ...GOAL_WITH_OKR,
      metadata: { kind: 'goal', intent: 'standing_objective', goal: { priority: 'high' } },
    };
    const { dispatch, deps } = buildOkrDeps([goalWithoutOkr], OBJECTIVE_ROW);
    const reply = await handleDispatch(
      { taskId: 'task-1', agentImUserId: 'agent-1', profileId: 'profile-1', capability: 'code', prompt: 'ship it' },
      'req-okr-2',
      deps,
    );

    expect(reply.ok).toBe(true);
    const prompt = dispatch.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('[Active Goals]');
    expect(prompt).not.toContain('[Active Key Results]');
    expect(prompt).not.toContain('baseline 0');
  });
});

describe('product209/19 WP3 — memory + PKF report directives reach all four adapters', () => {
  const VALID_INLINE_PKF =
    '<script type="application/prismer+json">{"type":"note","title":"Inline","description":"Inline PKF test.","pkfVersion":"1.1"}</script><section><h2 id="summary">Summary</h2><p>Ready.</p></section>';

  function buildDeps(profile: AgentProfile, dispatch: ReturnType<typeof vi.fn>) {
    const sent: unknown[] = [];
    const adapter: AdapterDef = {
      name: profile.adapterName,
      kind: 'long-running',
      capabilities: [],
      workspaceSchema: {} as any,
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    };
    const cloud = {
      get: vi.fn(async (path: string) => {
        if (path === '/api/im/agent_profiles/profile-1') return profile;
        if (path.startsWith('/api/im/tasks?')) return [];
        if (path.startsWith('/api/im/memory/digest?')) {
          return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
        }
        if (path === '/api/im/tasks/task-1') return { task: { id: 'task-1', metadata: {} } };
        throw new Error(`unexpected GET ${path}`);
      }),
      request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
    };
    return {
      sent,
      deps: {
        registry: { get: () => adapter } as any,
        cloud: cloud as any,
        uriResolver: {
          rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
          rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
        } as any,
        assetCache: { unpin: vi.fn() } as any,
        ws: { send: (msg: unknown) => sent.push(msg) } as any,
        ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
      },
    };
  }

  const cases: Array<{ adapterName: string; capability: string; systemPrompt: string }> = [
    { adapterName: 'hermes', capability: 'chat', systemPrompt: 'You are a product manager.' },
    { adapterName: 'claude-code', capability: 'code', systemPrompt: '' },
    { adapterName: 'codex', capability: 'code', systemPrompt: '' },
    { adapterName: 'opencode', capability: 'code', systemPrompt: '' },
  ];
  const identityContext = {
    identity: 'You are Ada (@ada), a coding agent.',
    user: 'You are in a direct conversation with Tom.',
    scope: 'Workspace: Acme · Project: none',
  };

  for (const { adapterName, capability, systemPrompt } of cases) {
    it(`${adapterName}: composed systemPrompt carries MEMORY + PKF directives verbatim`, async () => {
      const profile: AgentProfile = {
        id: 'profile-1',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-1',
        adapterName,
        name: adapterName,
        config: { systemPrompt, cwd: mkdtempSync(join(tmpdir(), `wp3-${adapterName}-`)) },
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
      const { deps } = buildDeps(profile, dispatch);

      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: 'agent-1',
          profileId: 'profile-1',
          capability,
          prompt: 'run it',
          identityContext,
        },
        'req-1',
        deps,
      );

      expect(reply.ok).toBe(true);
      const meta = dispatch.mock.calls[0]![0].metadata;
      expect(meta.systemPrompt).toContain(MEMORY_CORE_DIRECTIVE);
      expect(meta.systemPrompt).toContain(PKF_REPORT_DIRECTIVE);
    });
  }

  it('runtime210/09 §3.2 — pi-core receives the same directives AND the forced-autonomous override', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'pi-core',
      name: 'pi-core',
      config: {
        systemPrompt: 'You are a built-in agent.',
        cwd: mkdtempSync(join(tmpdir(), 'wp3-pi-core-')),
        // An approval-seeking legacy template must NOT leak into the prompt:
        // pi-core joins the forceAutonomous family (runtime210/09 §3.2).
        roleTemplate: { operatingPrinciples: 'Always request approval first.' },
        approvalPolicy: 'strict',
      },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
    const { deps } = buildDeps(profile, dispatch);

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'run it',
        identityContext,
      },
      'req-1',
      deps,
    );

    expect(reply.ok).toBe(true);
    const meta = dispatch.mock.calls[0]![0].metadata;
    expect(meta.systemPrompt).toContain(MEMORY_CORE_DIRECTIVE);
    expect(meta.systemPrompt).toContain(PKF_REPORT_DIRECTIVE);
    expect(meta.systemPrompt).toContain('Approval policy: autonomous (ENFORCED)');
    // The forced override is appended AFTER the legacy approval-seeking prose,
    // superseding it (resolveOperatingPrinciples semantics — the template text
    // stays but the standing order is autonomous).
    const enforcedAt = meta.systemPrompt.indexOf('Approval policy: autonomous (ENFORCED)');
    expect(meta.systemPrompt.indexOf('Always request approval first')).toBeGreaterThanOrEqual(0);
    expect(meta.systemPrompt.indexOf('Always request approval first')).toBeLessThan(enforcedAt);
  });

  it('extracts inline PKF on the ordinary workspace task.dispatch path', async () => {
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
    const output = [
      'Readable markdown projection.',
      '<!-- prismer-pkf:inline:start -->',
      VALID_INLINE_PKF,
      '<!-- prismer-pkf:inline:end -->',
    ].join('\n\n');
    const dispatch = vi.fn(async () => ({ ok: true, output }));
    const { deps, sent } = buildDeps(profile, dispatch);

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'write a structured report',
      },
      'req-inline',
      deps,
    );

    expect(reply.output).toBe('Readable markdown projection.');
    expect(reply.contentBlocks).toEqual([{ kind: 'pkf', source: VALID_INLINE_PKF, title: 'Inline' }]);
    const terminalFrame = sent.find((frame: any) => frame?.type === 'task.dispatch.reply') as any;
    expect(terminalFrame?.payload?.contentBlocks).toEqual(reply.contentBlocks);
  });

  it('injects the host capability receipt into the same production dispatch context and fails closed after TAMPER', async () => {
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
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
    const { deps } = buildDeps(profile, dispatch);
    const skillsRoot = mkdtempSync(join(tmpdir(), 'prismer-pkf-cap-dispatch-'));
    mkdirSync(join(skillsRoot, 'pkf-writing'), { recursive: true });
    writeFileSync(join(skillsRoot, 'pkf-writing', 'SKILL.md'), '---\nname: pkf-writing\n---\n');
    const unavailable = validatePkfRuntimeCapability({
      trigger: 'profile-changed',
      profileId: profile.id,
      availableNativeTools: ['pkf_mint_sids', 'pkf_outline', 'pkf_search', 'pkf_read', 'pkf_bundle_commit'],
      skillsRoot,
      pkfCoreAvailable: true,
      cloudCliAvailable: false,
      catalogSkillSlugs: ['pkf-writing', 'pkf-svg'],
      installedSkillSlugs: ['pkf-writing'],
      hermesNativeSkills: { status: 'listed', slugs: ['pkf-writing'] },
      promptFragment: ['[Installed Skills]', '## pkf-writing'].join('\n\n'),
      now: new Date('2026-08-18T00:00:00.000Z'),
    });
    deps.resolvePkfRuntimeCapability = vi.fn(() => unavailable);

    try {
      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          agentImUserId: 'agent-1',
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'write a PKF report',
        },
        'req-capability-tamper',
        deps,
      );

      expect(reply.ok).toBe(true);
      expect(deps.resolvePkfRuntimeCapability).toHaveBeenCalledWith(profile);
      const systemPrompt = dispatch.mock.calls[0]![0].metadata.systemPrompt as string;
      expect(systemPrompt).toContain('PKF Runtime capability receipt (host verified)');
      expect(systemPrompt).toContain('status: unavailable');
      expect(systemPrompt).toContain('doctor: error');
      expect(systemPrompt).toContain('agentInstalledLedger=error');
      expect(systemPrompt).toContain('promptFragment=error');
      expect(systemPrompt).toContain('tool:pkf_validate');
      expect(systemPrompt).toContain('skill:pkf-svg');
      expect(systemPrompt).toContain('cli:cloud');
      expect(systemPrompt).toMatch(/Never run `command -v`/);
      expect(systemPrompt).toMatch(/do not claim validation, persistence, or attachment success/i);
    } finally {
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('runs durability before task.dispatch.reply and carries canonical identity/model/profile receipt', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'configured-model' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({
      ok: true,
      output: 'Durable architecture decision.',
      metadata: {
        modelUsed: 'deepseek-v4-flash',
        providerUsed: 'prismer-gateway',
        hermes: { runId: 'api_provider_9' },
      },
    }));
    const { deps, sent } = buildDeps(profile, dispatch);
    const order: string[] = [];
    const originalSend = deps.ws.send;
    deps.ws.send = (frame: unknown) => {
      if ((frame as { type?: string }).type === 'task.dispatch.reply') order.push('reply');
      originalSend(frame);
    };
    deps.preReplyDurabilityBarrier = vi.fn(async (input: any) => {
      order.push('barrier');
      expect(input).toMatchObject({
        workspaceId: 'ws-1',
        agentImUserId: 'agent-1',
        conversationId: 'conv-1',
        canonicalTurnId: 'run_cloud_1',
        runId: 'run_cloud_1',
        messageId: 'msg-1',
        turnId: 'api_provider_9',
        profileId: 'profile-1',
        profileName: 'Hermes',
        model: 'deepseek-v4-flash',
        provider: 'prismer-gateway',
        lane: 'pre-reply',
      });
      return {
        commitKey: 'durability:1',
        postTurnKey: 'post-turn:1',
        canonicalTurnId: 'run_cloud_1',
        conversationId: 'conv-1',
        runId: 'run_cloud_1',
        messageId: 'msg-1',
        profileId: 'profile-1',
        profileName: 'Hermes',
        model: 'deepseek-v4-flash',
        provider: 'prismer-gateway',
        state: 'persisted' as const,
        receipts: [{ pageId: 'page-1', path: 'decisions/a.pkf', version: 1, contentHash: 'hash-1' }],
        timeoutMs: 30_000,
        replyCommittedAt: 123,
      };
    });

    const reply = await handleDispatch(
      {
        taskId: 'run_cloud_1',
        kind: 'run',
        runId: 'run_cloud_1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'make a durable decision',
        conversationId: 'conv-1',
        metadata: { triggerMessageId: 'msg-1' },
      },
      'req-durable',
      deps,
    );

    expect(order).toEqual(['barrier', 'reply']);
    expect(reply.durability).toMatchObject({
      state: 'persisted',
      receipts: [{ pageId: 'page-1', version: 1 }],
    });
    const terminal = sent.find((frame: any) => frame?.type === 'task.dispatch.reply') as any;
    expect(terminal.payload.durability).toEqual(reply.durability);
  });

  it('uses exact adapter-observed routing when Hermes SSE omits model/provider', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'configured-model' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = openLocalDb(':memory:');
    const registry = new RunSessionRegistry(db);
    registry.register({
      runId: 'provider-run-1',
      taskId: 'run_cloud_terminal',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      agentImUserId: 'agent-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      profileName: 'Hermes',
      roleTemplateSlug: null,
      adapterName: 'hermes',
      model: 'configured-model',
      proxyProvider: 'configured-provider',
      servedModel: 'deepseek-v4-flash',
      servedProvider: 'custom',
      routingEvidenceSource: 'adapter',
    });
    setRunSessionRegistry(registry);
    try {
      const dispatch = vi.fn(async () => ({
        ok: true,
        output: 'Durable decision.',
        metadata: { hermes: { runId: 'api_provider_10' } },
      }));
      const { deps } = buildDeps(profile, dispatch);
      deps.preReplyDurabilityBarrier = vi.fn(async (input: any) => {
        expect(input).toMatchObject({
          model: 'deepseek-v4-flash',
          provider: 'custom',
          canonicalTurnId: 'run_cloud_terminal',
        });
        return {
          commitKey: 'durability:terminal-routing',
          postTurnKey: 'post-turn:terminal-routing',
          canonicalTurnId: 'run_cloud_terminal',
          runId: 'run_cloud_terminal',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          profileId: 'profile-1',
          model: input.model,
          provider: input.provider,
          state: 'skipped_not_durable' as const,
          receipts: [],
          timeoutMs: 30_000,
          replyCommittedAt: 123,
        };
      });

      await handleDispatch(
        {
          taskId: 'run_cloud_terminal',
          kind: 'run',
          runId: 'run_cloud_terminal',
          agentImUserId: 'agent-1',
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'ephemeral turn',
          conversationId: 'conv-1',
          metadata: { triggerMessageId: 'msg-1' },
        },
        'req-terminal-routing',
        deps,
      );
      expect(deps.preReplyDurabilityBarrier).toHaveBeenCalledOnce();
    } finally {
      setRunSessionRegistry(null);
      db.close();
    }
  });

  it('keeps inline PKF replies visible when best-effort durability is retryable', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'deepseek-v4-flash' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const output = [
      'Readable report projection.',
      '<!-- prismer-pkf:inline:start -->',
      VALID_INLINE_PKF,
      '<!-- prismer-pkf:inline:end -->',
    ].join('\n\n');
    const dispatch = vi.fn(async () => ({ ok: true, output }));
    const { deps, sent } = buildDeps(profile, dispatch);
    deps.preReplyDurabilityBarrier = vi.fn(async (input: any) => {
      // product210/03 W1-2 (C2 断双写 / R10): the post-turn classifier input
      // must NOT carry the inline PKF canonical source anymore — the author
      // agent distills deliverables in-turn (ruling A). The classifier input
      // regresses to reply text only; a red-green pair guards the removal.
      expect(input.assistantResponse).toContain('Readable report projection.');
      expect(input.assistantResponse).not.toContain(VALID_INLINE_PKF);
      expect(input.assistantResponse).not.toContain('Validated inline PKF source');
      return {
        commitKey: 'durability:best-effort-inline',
        postTurnKey: 'post-turn:best-effort-inline',
        canonicalTurnId: 'run_cloud_inline_retryable',
        state: 'retryable_failure' as const,
        receipts: [],
        error: { code: 'memory_write_retryable', message: 'gateway returned no text content' },
        timeoutMs: 10,
        replyCommittedAt: 124,
      };
    });

    const reply = await handleDispatch(
      {
        taskId: 'run_cloud_inline_retryable',
        kind: 'run',
        runId: 'run_cloud_inline_retryable',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'write a structured PKF report',
        conversationId: 'conv-inline',
        metadata: { triggerMessageId: 'msg-inline' },
      },
      'req-inline-retryable',
      deps,
    );

    expect(reply.ok).toBe(true);
    expect(reply.error).toBeUndefined();
    expect(reply.output).toBe('Readable report projection.');
    expect(reply.contentBlocks).toEqual([{ kind: 'pkf', source: VALID_INLINE_PKF, title: 'Inline' }]);
    expect(reply.durability?.state).toBe('retryable_failure');
    const terminalFrame = sent.find((frame: any) => frame?.type === 'task.dispatch.reply') as any;
    expect(terminalFrame?.payload).toMatchObject({ ok: true, contentBlocks: reply.contentBlocks });
  });

  it('falls back to profile model + gateway provider when adapter metadata omits routing evidence', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'deepseek-v4-flash' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // Session-based hermes turns surface NO modelUsed/providerUsed metadata —
    // the durability barrier then dead-letters `memory_identity_invalid`
    // (invalid_context:no_model,no_provider) and the whole post-turn memory
    // lane silently writes nothing. The profile IS the routing authority:
    // dispatch must fall back to it.
    const dispatch = vi.fn(async () => ({ ok: true, output: 'Done.' }));
    const { deps } = buildDeps(profile, dispatch);
    deps.preReplyDurabilityBarrier = vi.fn(async (input: any) => ({
      commitKey: 'durability:fallback',
      postTurnKey: 'post-turn:fallback',
      canonicalTurnId: 'run_meta_fallback',
      state: 'committed' as const,
      receipts: [],
      timeoutMs: 10,
      replyCommittedAt: 124,
    }));

    await handleDispatch(
      {
        taskId: 'run_meta_fallback',
        kind: 'run',
        runId: 'run_meta_fallback',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'hello',
        conversationId: 'conv-fallback',
        metadata: { triggerMessageId: 'msg-fb' },
      },
      'req-meta-fallback',
      deps,
    );

    expect(deps.preReplyDurabilityBarrier).toHaveBeenCalledOnce();
    const input = (deps.preReplyDurabilityBarrier as any).mock.calls[0][0];
    expect(input.model).toBe('deepseek-v4-flash');
    expect(input.provider).toBe('prismer-gateway');
  });

  it('W1-3 (R12) — archives validated inline PKF at terminal: silent ids ride pkfArchiveAssetIds, not assetIds', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'deepseek-v4-flash' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const output = [
      'Readable report projection.',
      '<!-- prismer-pkf:inline:start -->',
      VALID_INLINE_PKF,
      '<!-- prismer-pkf:inline:end -->',
    ].join('\n\n');
    const dispatch = vi.fn(async () => ({ ok: true, output }));
    const { deps, sent } = buildDeps(profile, dispatch);
    const archiveCalls: Array<{ workspaceId: string; taskId: string; blocks: unknown[] }> = [];
    deps.uploadInlinePkfArchive = vi.fn(async (input: any) => {
      archiveCalls.push(input);
      expect(input.blocks[0]).toMatchObject({ title: 'Inline' });
      expect(input.blocks[0].source).toBe(VALID_INLINE_PKF);
      return ['ast_archive_1'];
    });
    deps.preReplyDurabilityBarrier = vi.fn(async () => ({
      commitKey: 'durability:archive-inline',
      postTurnKey: 'post-turn:archive-inline',
      canonicalTurnId: 'run_archive_inline',
      state: 'committed' as const,
      receipts: [],
      timeoutMs: 10,
      replyCommittedAt: 124,
    }));

    const reply = await handleDispatch(
      {
        taskId: 'run_archive_inline',
        kind: 'run',
        runId: 'run_archive_inline',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'write a structured PKF report',
        conversationId: 'conv-archive',
        metadata: { triggerMessageId: 'msg-archive' },
      },
      'req-archive-inline',
      deps,
    );

    expect(archiveCalls).toHaveLength(1);
    // R12: archive ids ride the dedicated wire field — never the attachment list.
    expect(reply.pkfArchiveAssetIds).toEqual(['ast_archive_1']);
    expect(reply.assetIds).toBeUndefined();
    const terminalFrame = sent.find((frame: any) => frame?.type === 'task.dispatch.reply') as any;
    expect(terminalFrame?.payload?.pkfArchiveAssetIds).toEqual(['ast_archive_1']);
  });

  it('uses the cloud task id as durability message identity for pure agent_run dispatches', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'deepseek-v4-flash' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({
      ok: true,
      output: 'Pure task completed.',
      metadata: {
        modelUsed: 'deepseek-v4-flash',
        providerUsed: 'prismer-gateway',
        hermes: { runId: 'api_provider_agent_run' },
      },
    }));
    const { deps } = buildDeps(profile, dispatch);
    deps.preReplyDurabilityBarrier = vi.fn(async (input: any) => {
      expect(input).toMatchObject({
        canonicalTurnId: 'task-agent-run-1',
        messageId: 'task-agent-run-1',
        turnId: 'api_provider_agent_run',
        model: 'deepseek-v4-flash',
        provider: 'prismer-gateway',
      });
      return {
        commitKey: 'durability:agent-run',
        postTurnKey: 'post-turn:agent-run',
        canonicalTurnId: 'task-agent-run-1',
        conversationId: 'conv-agent-run',
        messageId: 'task-agent-run-1',
        profileId: 'profile-1',
        model: 'deepseek-v4-flash',
        provider: 'prismer-gateway',
        state: 'skipped_not_durable' as const,
        receipts: [],
        timeoutMs: 30_000,
        replyCommittedAt: 126,
      };
    });

    const reply = await handleDispatch(
      {
        taskId: 'task-agent-run-1',
        kind: 'task',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'pure task without an IM trigger message',
        conversationId: 'conv-agent-run',
        metadata: { kind: 'agent_run' },
      },
      'req-agent-run-message-fallback',
      deps,
    );

    expect(reply.ok).toBe(true);
    expect(deps.preReplyDurabilityBarrier).toHaveBeenCalledOnce();
  });

  it('changes an otherwise successful reply to traceable failure when durability cannot finish', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are Hermes.', model: 'deepseek-v4-flash' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({ ok: true, output: 'Business work completed.' }));
    const { deps } = buildDeps(profile, dispatch);
    deps.preReplyDurabilityBarrier = vi.fn(async () => ({
      commitKey: 'durability:failed',
      postTurnKey: 'post-turn:failed',
      canonicalTurnId: 'run_cloud_2',
      state: 'retryable_failure' as const,
      receipts: [],
      error: { code: 'memory_barrier_timeout', message: 'bounded timeout' },
      timeoutMs: 10,
      replyCommittedAt: 124,
    }));

    const reply = await handleDispatch(
      {
        taskId: 'run_cloud_2',
        kind: 'run',
        runId: 'run_cloud_2',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'remember this decision across future sessions',
        conversationId: 'conv-2',
        metadata: { triggerMessageId: 'msg-2' },
      },
      'req-durable-fail',
      deps,
    );

    expect(reply.ok).toBe(false);
    expect(reply.output).toBe('Business work completed.');
    expect(reply.error).toEqual({
      code: 'memory_write_failed',
      message: 'Durable Memory was not committed before reply (memory_barrier_timeout): bounded timeout',
    });
    expect(reply.durability?.state).toBe('retryable_failure');
  });

  it.each(['retryable_failure', 'terminal_failure'] as const)(
    'fails closed when a legacy duplicate replay carries an effective %s',
    async (effectiveState) => {
      const profile: AgentProfile = {
        id: 'profile-1',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-1',
        adapterName: 'hermes',
        name: 'Hermes',
        config: { systemPrompt: 'You are Hermes.', model: 'deepseek-v4-flash' },
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const { deps } = buildDeps(
        profile,
        vi.fn(async () => ({ ok: true, output: 'Business work completed.' })),
      );
      deps.preReplyDurabilityBarrier = vi.fn(
        async () =>
          ({
            commitKey: `durability:replay:${effectiveState}`,
            postTurnKey: `post-turn:replay:${effectiveState}`,
            canonicalTurnId: 'run_cloud_replay',
            state: 'skipped_duplicate',
            receipts: [],
            error: { code: `memory_${effectiveState}`, message: 'frozen original failure' },
            timeoutMs: 10,
            replyCommittedAt: 125,
            duplicateOf: { state: effectiveState, receipts: [], replyCommittedAt: 124 },
          }) as any,
      );

      const reply = await handleDispatch(
        {
          taskId: `run_cloud_replay_${effectiveState}`,
          kind: 'run',
          runId: `run_cloud_replay_${effectiveState}`,
          agentImUserId: 'agent-1',
          profileId: 'profile-1',
          capability: 'chat',
          prompt: 'remember this replay result across future sessions',
          conversationId: 'conv-replay',
          metadata: { triggerMessageId: 'msg-replay' },
        },
        `req-replay-${effectiveState}`,
        deps,
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'memory_write_failed', message: expect.stringContaining('frozen original failure') },
      });
    },
  );

  it('emits a structured terminal durability result when the barrier itself throws', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { model: 'deepseek-v4-flash' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { deps } = buildDeps(
      profile,
      vi.fn(async () => ({ ok: true, output: 'Business work completed.' })),
    );
    deps.preReplyDurabilityBarrier = vi.fn(async () => {
      throw new Error('sqlite unavailable');
    });

    const reply = await handleDispatch(
      {
        taskId: 'run_cloud_throw',
        kind: 'run',
        runId: 'run_cloud_throw',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'remember this across future sessions',
        conversationId: 'conv-throw',
        metadata: { triggerMessageId: 'msg-throw' },
      },
      'req-durable-throw',
      deps,
    );

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'memory_write_failed' },
      durability: {
        canonicalTurnId: 'run_cloud_throw',
        state: 'terminal_failure',
        receipts: [],
        error: { code: 'memory_barrier_unavailable', message: 'sqlite unavailable' },
      },
    });
  });

  // memory211 P5 — §6.9 裁决 4 re-thresholded sharding at 64K CHARACTERS
  // (b18dbe34a), but MEMORY_CORE_DIRECTIVE still taught ">1M sharding": every
  // dispatched agent was instructed to shard a source that the gate now admits
  // whole up to 64K chars, and to expect a threshold that never fires. The
  // injected prompt carries the CURRENT口径, and never the retired one.
  it('MEMORY_CORE_DIRECTIVE teaches the 64K-character sharding口径, never the retired >1M one', () => {
    expect(MEMORY_CORE_DIRECTIVE).toMatch(/64K-character sharding/);
    expect(MEMORY_CORE_DIRECTIVE).not.toMatch(/1M/);
    // The gate's own 422 code stays discoverable from the prompt's vocabulary.
    expect(MEMORY_CORE_DIRECTIVE).toContain('sharding');
  });
});

describe('renderIdentityLines / isCodingAdapter', () => {
  it('trims + defaults missing fields to empty strings', () => {
    expect(renderIdentityLines(undefined)).toEqual({ identity: '', user: '', scope: '', sections: [] });
    expect(
      renderIdentityLines({ identity: '  You are X.  ', user: '', scope: 'Workspace: W · Project: none' }),
    ).toEqual({ identity: 'You are X.', user: '', scope: 'Workspace: W · Project: none', sections: [] });
  });

  it('validates, sorts, and trims registered sections (M6 分段注册制 envelope)', () => {
    expect(
      renderIdentityLines({
        identity: 'You are X.',
        sections: [
          { order: 30, content: '  config directives  ' },
          { order: 20, content: 'platform directives' },
          { order: 10, content: '' }, // empty after trim → dropped
          { order: Number.NaN, content: 'bad order → dropped' },
          { content: 'no order → dropped' },
        ],
      }),
    ).toEqual({
      identity: 'You are X.',
      user: '',
      scope: '',
      sections: ['platform directives', 'config directives'],
    });
  });

  // organization/04 S4 — 「无 id 白名单」是把新段 id 钉成回归测试：daemon 只做
  // shape-only 校验 + 升序 sort，认不认识的 id 一律照单全收。若未来有人加白名单
  // 丢掉 org-collaboration，这条 toEqual 三元素断言即红。
  it('sorts a shuffled sections array ascending regardless of new section ids (org-collaboration, no whitelist)', () => {
    const out = renderIdentityLines({
      identity: 'You are A.',
      sections: [
        { id: 'deputy-binding', owner: 'bugfix211/B', order: 18, content: '## Deputy binding\nB' },
        { id: 'org-collaboration', owner: 'organization/04', order: 16, content: '## Org collaboration\nO' },
        { id: 'fact-discipline', owner: 'product205/12', order: 15, content: '[Fact discipline] F' },
      ],
    });
    expect(out.sections).toEqual(['[Fact discipline] F', '## Org collaboration\nO', '## Deputy binding\nB']);
  });

  it('classifies the three coding adapters and excludes persistence', () => {
    expect(isCodingAdapter('claude-code')).toBe(true);
    expect(isCodingAdapter('codex')).toBe(true);
    expect(isCodingAdapter('opencode')).toBe(true);
    expect(isCodingAdapter('hermes')).toBe(false);
  });
});

describe('runtime210/09 §3.2 — pi-core behaviour alignment collections', () => {
  it('composeCoreDirectives: pi-core joins the hermes/coding families; others stay empty', () => {
    // Positive: pi-core gets the SAME verbatim directives as the existing
    // four adapter families.
    expect(composeCoreDirectives('pi-core')).toEqual([MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE]);
    // Negative controls: existing behaviour is unchanged.
    expect(composeCoreDirectives('hermes')).toEqual([MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE]);
    expect(composeCoreDirectives('claude-code')).toEqual([MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE]);
    expect(composeCoreDirectives('codex')).toEqual([MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE]);
    expect(composeCoreDirectives('opencode')).toEqual([MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE]);
    expect(composeCoreDirectives('openclaw')).toEqual([]);
    expect(composeCoreDirectives('unknown-adapter')).toEqual([]);
  });

  it('adapterHasFilesystemTools: pi-core is fs-capable; persistence/unknown stay false', () => {
    expect(adapterHasFilesystemTools({ adapterName: 'pi-core', config: {} })).toBe(true);
    // Negative controls — hermes + coding unchanged; tool-less families false.
    expect(adapterHasFilesystemTools({ adapterName: 'openclaw', config: {} })).toBe(false);
    expect(adapterHasFilesystemTools({ adapterName: 'unknown-adapter', config: {} })).toBe(false);
  });

  it('forceAutonomous: pi-core profile overrides approval-seeking templates (via resolveOperatingPrinciples)', () => {
    const composed = resolveOperatingPrinciples(
      {
        roleTemplate: { operatingPrinciples: 'Always request approval first.' },
        approvalPolicy: 'strict',
      },
      true, // what handleDispatch passes for pi-core (runtime210/09 §3.2)
    );
    expect(composed).toContain('Approval policy: autonomous (ENFORCED)');
    // Negative control: a non-forced adapter keeps its stored policy shape.
    const nonForced = resolveOperatingPrinciples({ approvalPolicy: 'strict' }, false);
    expect(nonForced).toContain('Approval policy: strict');
  });
});

describe('release203/11 Slice A — canonical identity injection', () => {
  function buildDeps(profile: AgentProfile, dispatch: ReturnType<typeof vi.fn>) {
    const sent: unknown[] = [];
    const adapter: AdapterDef = {
      name: profile.adapterName,
      kind: 'long-running',
      capabilities: [],
      workspaceSchema: {} as any,
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    };
    const cloud = {
      get: vi.fn(async (path: string) => {
        if (path === '/api/im/agent_profiles/profile-1') return profile;
        if (path.startsWith('/api/im/tasks?')) return [];
        if (path.startsWith('/api/im/memory/digest?')) {
          return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
        }
        if (path === '/api/im/tasks/task-1') return { task: { id: 'task-1', metadata: {} } };
        throw new Error(`unexpected GET ${path}`);
      }),
      request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
    };
    return {
      sent,
      deps: {
        registry: { get: () => adapter } as any,
        cloud: cloud as any,
        uriResolver: {
          rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
          rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
        } as any,
        assetCache: { unpin: vi.fn() } as any,
        ws: { send: (msg: unknown) => sent.push(msg) } as any,
        ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
      },
    };
  }

  const identityContext = {
    identity: 'You are Ada (@ada), a coding agent.',
    user: 'You are in a direct conversation with Tom.',
    scope: 'Workspace: Acme · Project: none',
  };

  it('净身 coding agent: empty persona → CODING_SOUL_DEFAULT in systemPrompt + identityContext passed through (NOT folded into systemPrompt)', async () => {
    // doc 10 净身 case: config.systemPrompt is '' for a coding agent.
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'claude-code',
      name: 'Ada',
      config: { systemPrompt: '', cwd: mkdtempSync(join(tmpdir(), 'slice-a-coding-cwd-')) },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
    const { deps } = buildDeps(profile, dispatch);

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'who are you?',
        identityContext,
      },
      'req-1',
      deps,
    );

    expect(reply.ok).toBe(true);
    const meta = dispatch.mock.calls[0]![0].metadata;
    // SOUL/persona portion carries the净身 default — not generic Claude.
    expect(meta.systemPrompt).toContain(CODING_SOUL_DEFAULT);
    // identity lines ride on the SEPARATE structured key, NOT in systemPrompt.
    // M6 envelope: renderIdentityLines normalizes the wire shape and always
    // carries a `sections` array (empty when no registered sections rode in).
    expect(meta.identityContext).toEqual({ ...identityContext, sections: [] });
    expect(meta.systemPrompt).not.toContain('You are Ada');
  });

  it('hermes: identityContext forwarded structured; systemPrompt stays persona-only (SOUL.md cleanliness)', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are a product manager.' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
    const { deps } = buildDeps(profile, dispatch);

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'who are you?',
        identityContext,
      },
      'req-1',
      deps,
    );

    expect(reply.ok).toBe(true);
    const meta = dispatch.mock.calls[0]![0].metadata;
    // Persona stays in systemPrompt (→ SOUL.md), identity stays OUT of it.
    expect(meta.systemPrompt).toContain('You are a product manager.');
    expect(meta.systemPrompt).not.toContain('You are Ada');
    // M6 envelope shape: normalized identityContext always carries `sections`.
    expect(meta.identityContext).toEqual({ ...identityContext, sections: [] });
  });

  // organization/04 S4 载体A —— provider 实际输入面：cloud 组好的 sections 数组
  // 原样（升序、trim 后）交到 adapter 的 metadata.identityContext，即 hermes /
  // coding adapter 真正喂给模型的那一份。org-collaboration 段在其中。
  it('hermes: org-collaboration section reaches the adapter input in canonical order', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are a product manager.' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
    const { deps } = buildDeps(profile, dispatch);

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'do the thing',
        identityContext: {
          ...identityContext,
          sections: [
            { id: 'deputy-binding', owner: 'bugfix211/B', order: 18, content: '## Deputy binding\nB' },
            { id: 'org-collaboration', owner: 'organization/04', order: 16, content: '## Org collaboration\nO' },
            { id: 'fact-discipline', owner: 'product205/12', order: 15, content: '[Fact discipline] F' },
          ] as never,
        },
      },
      'req-1',
      deps,
    );

    expect(reply.ok).toBe(true);
    const meta = dispatch.mock.calls[0]![0].metadata;
    expect(meta.identityContext.sections).toEqual([
      '[Fact discipline] F',
      '## Org collaboration\nO',
      '## Deputy binding\nB',
    ]);
  });

  it('legacy dispatch with no identityContext keeps systemPrompt + omits the key (additive)', async () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      adapterName: 'hermes',
      name: 'Hermes',
      config: { systemPrompt: 'You are a product manager.' },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
    const { deps } = buildDeps(profile, dispatch);

    await handleDispatch(
      {
        taskId: 'task-1',
        agentImUserId: 'agent-1',
        profileId: 'profile-1',
        capability: 'chat',
        prompt: 'hi',
      },
      'req-1',
      deps,
    );

    const meta = dispatch.mock.calls[0]![0].metadata;
    expect(meta.systemPrompt).toContain('You are a product manager.');
    expect(meta.identityContext).toBeUndefined();
  });
});

// ─── memory203/18 R3 — limiter-aware retry + exhaustion mapping ─────────────

describe('memory203/18 R3 — limiter classification helpers', () => {
  it('isLimiterClassError matches the three limiter producers + bare HTTP 429', () => {
    // proxy-concurrency-gate queue-full (429), as hermes summarizes it:
    expect(isLimiterClassError('HTTP 429: Workspace LLM concurrency queue is full (depth 10); retry shortly.')).toBe(
      true,
    );
    // proxy-concurrency-gate slot-deadline (504):
    expect(
      isLimiterClassError('HTTP 504: Workspace LLM concurrency slot not available before deadline; retry shortly.'),
    ).toBe(true);
    // RPM rate limiter:
    expect(isLimiterClassError('HTTP 429: Rate limit exceeded. Limit: 60/min. Retry in 51s.')).toBe(true);
    // substring-only forms (no HTTP prefix survives some adapter paths):
    expect(isLimiterClassError('Rate limit exceeded. Limit: 60/min. Retry in 3s.')).toBe(true);
    expect(isLimiterClassError('upstream: HTTP 429')).toBe(true);
  });

  it('non-limiter failures are NOT limiter-class (negative controls)', () => {
    expect(isLimiterClassError('HTTP 500: internal error')).toBe(false);
    expect(isLimiterClassError('HTTP 504: upstream timeout')).toBe(false); // generic 504 ≠ slot-deadline
    expect(isLimiterClassError('fetch failed')).toBe(false);
    expect(isLimiterClassError('')).toBe(false);
    expect(isLimiterClassError(undefined)).toBe(false);
  });

  it('parseRetryAfterMs reads Retry-After and "Retry in Ns" wording, clamps to 60s', () => {
    expect(parseRetryAfterMs('Rate limit exceeded. Retry in 51s.')).toBe(51_000);
    expect(parseRetryAfterMs('Retry-After: 2')).toBe(2_000);
    expect(parseRetryAfterMs('retry after 5')).toBe(5_000);
    expect(parseRetryAfterMs('Retry in 3600s')).toBe(60_000); // clamp
    expect(parseRetryAfterMs('no hint here')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('resolveRetryBackoffMs: limiter → Retry-After wins, else jittered windows; non-limiter keeps [1s,3s]', () => {
    delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
    // Retry-After honored verbatim:
    expect(resolveRetryBackoffMs(2, 'HTTP 429: Rate limit exceeded. Retry in 51s.')).toBe(51_000);
    // limiter without hint → window [3s,6s] before attempt 2, [8s,15s] before 3:
    const w2 = resolveRetryBackoffMs(2, 'HTTP 429: Workspace LLM concurrency queue is full (depth 10); retry shortly.');
    expect(w2).toBeGreaterThanOrEqual(3_000);
    expect(w2).toBeLessThanOrEqual(6_000);
    const w3 = resolveRetryBackoffMs(3, 'HTTP 429: Workspace LLM concurrency queue is full (depth 10); retry shortly.');
    expect(w3).toBeGreaterThanOrEqual(8_000);
    expect(w3).toBeLessThanOrEqual(15_000);
    // non-limiter keeps the legacy schedule:
    expect(resolveRetryBackoffMs(2, 'HTTP 500: boom')).toBe(1_000);
    expect(resolveRetryBackoffMs(3, 'HTTP 500: boom')).toBe(3_000);
  });

  it('PRISMER_DISPATCH_RETRY_BACKOFF_MS env override wins for all classes', () => {
    process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '10,20';
    try {
      expect(resolveRetryBackoffMs(2, 'HTTP 429: Rate limit exceeded. Retry in 51s.')).toBe(10);
      expect(resolveRetryBackoffMs(3, 'HTTP 500: boom')).toBe(20);
      expect(resolveRetryBackoffMs(4, 'HTTP 500: boom')).toBe(20); // last entry repeats
    } finally {
      delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
    }
  });

  it('retryReasonToken extracts the HTTP status else a class token', () => {
    expect(retryReasonToken('HTTP 429: queue full')).toBe('429');
    expect(retryReasonToken('HTTP 504: slot deadline')).toBe('504');
    expect(retryReasonToken('Rate limit exceeded. Retry in 3s.')).toBe('429');
    expect(retryReasonToken('fetch failed')).toBe('error');
  });
});

describe('memory203/18 R3.1 — retry exhaustion error-code mapping (handleDispatch loop)', () => {
  function buildRetryHarness(dispatch: ReturnType<typeof vi.fn>) {
    const sent: unknown[] = [];
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
        if (path.startsWith('/api/im/tasks?')) return [];
        if (path.startsWith('/api/im/skills/installed?')) return [];
        if (path.startsWith('/api/im/memory/digest?')) {
          return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
        }
        if (path === '/api/im/tasks/task-1') return { task: { id: 'task-1', metadata: {} } };
        if (path === '/api/im/runs/task-1') return { id: 'task-1', metadata: {} };
        return {};
      }),
      request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
    };
    const deps = {
      registry: { get: () => adapter } as any,
      cloud: cloud as any,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      } as any,
      assetCache: { unpin: vi.fn() } as any,
      ws: { send: (msg: unknown) => sent.push(msg) } as any,
      ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
    };
    const run = () =>
      handleDispatch(
        { taskId: 'task-1', agentImUserId: 'agent-1', profileId: 'profile-1', capability: 'chat', prompt: 'hi' },
        'req-1',
        deps,
      );
    return { run, sent, dispatch };
  }

  const LIMITER_MSG = 'HTTP 429: Workspace LLM concurrency queue is full (depth 10); retry shortly.';

  it('limiter-class 429 exhaustion → dispatch_precondition_unavailable, original message preserved, retry progress emitted', async () => {
    process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '0,0';
    try {
      const dispatch = vi.fn(async () => ({
        ok: false,
        output: '',
        error: { code: 'upstream_llm_error', message: LIMITER_MSG },
      }));
      const { run, sent } = buildRetryHarness(dispatch);
      const reply = await run();

      expect(dispatch).toHaveBeenCalledTimes(3); // full local budget burnt
      expect(reply.ok).toBe(false);
      // R3.1 — the EXISTING cloud requeue channel keys on this exact code:
      expect(reply.error?.code).toBe('dispatch_precondition_unavailable');
      expect(reply.error?.message).toBe(LIMITER_MSG);

      // R3.3 — a retry progress frame precedes each backoff (attempts 2 and 3),
      // so the reaper inactivity window resets and the UI can show it.
      const progress = (sent as Array<{ type?: string; payload?: { message?: string } }>).filter(
        (e) => e?.type === 'task.dispatch.progress' && e.payload?.message?.startsWith('retrying('),
      );
      expect(progress).toHaveLength(2);
      expect(progress[0]!.payload!.message).toBe('retrying(attempt=2, reason=429)');
      expect(progress[1]!.payload!.message).toBe('retrying(attempt=3, reason=429)');
    } finally {
      delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
    }
  });

  it('non-limiter HTTP 500 exhaustion stays daemon_local_retry_exhausted (negative control)', async () => {
    process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '0,0';
    try {
      const dispatch = vi.fn(async () => ({
        ok: false,
        output: '',
        error: { code: 'upstream_llm_error', message: 'HTTP 500: internal error' },
      }));
      const { run } = buildRetryHarness(dispatch);
      const reply = await run();

      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(reply.ok).toBe(false);
      expect(reply.error?.code).toBe('daemon_local_retry_exhausted');
      expect(reply.error?.message).toContain('HTTP 500: internal error');
    } finally {
      delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
    }
  });

  it('permanent upstream 4xx still short-circuits (no retry, no remap)', async () => {
    process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '0,0';
    try {
      const dispatch = vi.fn(async () => ({
        ok: false,
        output: '',
        error: { code: 'upstream_llm_error', message: 'HTTP 401: bad api key' },
      }));
      const { run } = buildRetryHarness(dispatch);
      const reply = await run();

      expect(dispatch).toHaveBeenCalledTimes(1); // isPermanentUpstreamError breaks the loop
      expect(reply.ok).toBe(false);
      expect(reply.error?.code).toBe('upstream_llm_error');
    } finally {
      delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
    }
  });

  // ── S7 (spec 07 Task 1 / 裁决 B) — the P2 loop IS one dispatch call ─────
  //
  // The loop retries ONE intent. A replay-aware upstream (Hermes /v1/runs
  // fingerprints `Idempotency-Key` + the whole body) sees a re-minted key as a
  // brand-new run: it executes and bills again while the first acceptance's
  // reply is lost. These two cases are the whole C-1 contract: identical
  // across attempts of one call, different across calls.
  describe('S7 — per-call idempotency nonce survives every P2 attempt', () => {
    it('all attempts of ONE dispatch call receive the SAME idempotencyNonce', async () => {
      process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '0,0';
      try {
        let calls = 0;
        const dispatch = vi.fn(async () => {
          calls += 1;
          if (calls < 3) {
            return { ok: false, output: '', error: { code: 'adapter_dispatch_failed', message: 'HTTP 500: blip' } };
          }
          return { ok: true, output: 'recovered' };
        });
        const { run } = buildRetryHarness(dispatch);
        const reply = await run();

        expect(dispatch).toHaveBeenCalledTimes(3); // two retries, then success
        expect(reply.ok).toBe(true);
        const nonces = dispatch.mock.calls.map(
          (call) => (call[1] as { idempotencyNonce?: string } | undefined)?.idempotencyNonce,
        );
        expect(nonces.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
        // THE oracle: one call ⇒ one key. A per-attempt mint would give 3.
        expect(new Set(nonces).size).toBe(1);
      } finally {
        delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
      }
    });

    it('a SEPARATE dispatch call gets a FRESH nonce (cloud requeue = a real new execution)', async () => {
      process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '0,0';
      try {
        const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));
        const { run } = buildRetryHarness(dispatch);
        await run();
        await run();

        const nonces = dispatch.mock.calls.map(
          (call) => (call[1] as { idempotencyNonce?: string } | undefined)?.idempotencyNonce,
        );
        expect(nonces).toHaveLength(2);
        // Replaying an already-closed run's terminal result would be worse than
        // running it again, so the second call must NOT reuse the first key.
        expect(nonces[0]).not.toBe(nonces[1]);
      } finally {
        delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
      }
    });
  });
});
