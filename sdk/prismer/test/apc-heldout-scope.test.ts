// desktop205 W5 (setter half) — WHO decides that a run is "APC coding-scope".
//
// W4/W5 landed the CHANNEL (per-run `Options.settings`, decided from the composed
// spawn env) but stopped at the setter: `APC_HELDOUT_DENY` had a definition and a
// consumer and zero writers, because the reconnaissance looked for a "held-out /
// self-dev repo" concept and found none on either side.
//
// It was looking for the wrong word. The SAME commit shipped an authoritative
// verdict for the sibling half: cloud's `GET /api/im/workspaces/:id →
// platformScoped` (W1/D2-b), which is exactly what decides whether this agent
// gets the APC coding SKILL set (skill-sync.ts::reconcileApcCodingSkills).
// "Which agents get the APC skills" and "which runs get the held-out deny hint"
// are one question, so W5 reuses that one verdict instead of inventing a second
// definition (e.g. sniffing `cwd` for a repo — that turns a hint into an
// implicit rule).
//
// The chain under test, end to end:
//
//   cloud platformScoped   (authorization — the ONLY authority)
//     → resolveApcCodingScope       (daemon, per dispatch, cached verdict)
//     → task.metadata.apcHeldOutDeny (dispatch.ts stamps a boolean it computed)
//     → extra.claude.env             (CodeAgentDriver, first writer of the seam)
//     → buildClaudeSpawnEnv taskEnv  (claude-code/agent.ts)
//     → Options.settings.permissions.deny  ← the oracle
//
// ORACLE. Same discipline as apc-heldout-per-task.test.ts: the real
// `ClaudeAgentSession` runs its real `buildOptions()` and the assertion reads the
// captured SDK `Options`. Nothing here re-derives the merge, the overlay order,
// or the rule text.
//
// ⚠️ SCOPE: the deny list is a HINT, not a security boundary (00-INDEX §2.4;
// `Bash` is structurally outside CC's file-permission check). These tests pin
// who turns it on, not containment.

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDispatch } from '../src/daemon/dispatch.js';
import { __resetPlatformWorkspaceCache } from '../src/daemon/skill-sync.js';
import { CodeAgentDriver } from '../src/adapters/coding/shared/code-agent-driver.js';
import { ClaudeAgentClient } from '../src/adapters/coding/claude-code/agent.js';
import { APC_HELD_OUT_PATHS } from '../src/adapters/coding/claude-code/config-isolation.js';
import type { ClaudeQueryInput } from '../src/adapters/coding/claude-code/query.js';
import type { AdapterDef, AgentProfile, TaskInput } from '../src/adapters/contract.js';
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from '../src/adapters/coding/shared/agent-sdk-types.js';

// ───────────────────────────── link 1: cloud verdict → dispatch metadata ────

/**
 * Drive the REAL `handleDispatch` and return the `metadata` the adapter was
 * actually handed. `platformScoped` is what cloud answers for `ws-1`;
 * `undefined` means the field is absent (old cloud ⇒ verdict `unknown`).
 */
async function dispatchAndReadMetadata(opts: {
  platformScoped?: boolean;
  adapterName?: string;
  cwd?: string | null;
  payloadMetadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const adapterName = opts.adapterName ?? 'claude-code';
  const cwd = opts.cwd === null ? undefined : (opts.cwd ?? mkdtempSync(path.join(os.tmpdir(), 'apc-scope-cwd-')));
  const profile: AgentProfile = {
    id: 'profile-1',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-1',
    adapterName,
    name: 'Ada',
    config: { systemPrompt: '', ...(cwd ? { cwd } : {}) },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const adapter: AdapterDef = {
    name: adapterName,
    kind: 'long-running',
    capabilities: [],
    workspaceSchema: {} as never,
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
  };
  const cloud = {
    get: vi.fn(async (p: string) => {
      if (p === '/api/im/agent_profiles/profile-1') return profile;
      if (p.startsWith('/api/im/tasks?')) return [];
      if (p.startsWith('/api/im/memory/digest?')) {
        return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
      }
      if (p === '/api/im/tasks/task-1') return { task: { id: 'task-1', metadata: {} } };
      if (p === '/api/im/workspaces/ws-1') {
        return opts.platformScoped === undefined ? {} : { platformScoped: opts.platformScoped };
      }
      // Everything else (notably /api/im/skills/installed) is out of scope for
      // this test; handleDispatch already tolerates a failing skill sync.
      throw new Error(`unexpected GET ${p}`);
    }),
    request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
  };
  const dispatch = vi.fn(async () => ({ ok: true, output: 'ok' }));

  const reply = await handleDispatch(
    {
      taskId: 'task-1',
      agentImUserId: 'agent-1',
      profileId: 'profile-1',
      capability: 'code',
      prompt: 'hi',
      ...(opts.payloadMetadata ? { metadata: opts.payloadMetadata } : {}),
    } as never,
    'req-1',
    {
      registry: { get: () => adapter } as never,
      cloud: cloud as never,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      } as never,
      assetCache: { unpin: vi.fn() } as never,
      ws: { send: () => undefined } as never,
      ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch }),
    } as never,
  );
  expect(reply.ok, 'dispatch itself must succeed for the metadata to mean anything').toBe(true);
  return dispatch.mock.calls[0]![0].metadata as Record<string, unknown>;
}

// ───────────────────────────── link 2+3: metadata → real SDK Options ────────

const FLAGS: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

function makeLogger(): never {
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop,
  };
  logger.child = () => logger;
  return logger as never;
}

/**
 * Wraps the REAL `ClaudeAgentClient` so the driver's own `createSession` /
 * `resumeSession` calls build a REAL `ClaudeAgentSession`. `listCommands()` is
 * the cheapest public method that forces `buildOptions()` → `queryFactory`, so
 * the captured object is the genuine SDK `Options`. Only `run()` is replaced —
 * we are pinning launch options, not executing a turn.
 */
class BridgeClient implements AgentClient {
  readonly provider = 'claude';
  readonly capabilities = FLAGS;
  constructor(private readonly real: ClaudeAgentClient) {}
  private async prime(session: AgentSession): Promise<AgentSession> {
    await (session as unknown as { listCommands(): Promise<unknown> }).listCommands();
    (session as unknown as { run: unknown }).run = async () => ({
      sessionId: session.id,
      finalText: 'ok',
      timeline: [],
    });
    return session;
  }
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return await this.prime(await this.real.createSession(config));
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return await this.prime(await this.real.resumeSession(handle, overrides));
  }
  async listModels() {
    return [];
  }
  async isAvailable() {
    return true;
  }
}

function makeTask(metadata: Record<string, unknown>, over: Partial<TaskInput> = {}): TaskInput {
  return {
    taskId: 't1',
    prompt: 'hello',
    metadata: { conversationId: 'c1', agentImUserId: 'a1', ...metadata },
    ...over,
  } as TaskInput;
}

function denyRules(settings: unknown): string[] {
  if (settings === undefined) return [];
  const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
  const deny = (parsed as { permissions?: { deny?: unknown } })?.permissions?.deny;
  return Array.isArray(deny) ? (deny as string[]) : [];
}

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevSwitch: string | undefined;
let captures: Array<{ settings: unknown; env: NodeJS.ProcessEnv }>;
let driver: CodeAgentDriver;

beforeEach(() => {
  // ensureClaudeConfigIsolation() mkdir's ~/.prismer/claude-config — send it to
  // a throwaway tree so the real user's home is never touched.
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'apc-scope-home-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevSwitch = process.env.APC_HELDOUT_DENY;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // The daemon-global switch is UNSET for every test here: any deny rule seen
  // below can only have come from the per-dispatch verdict.
  delete process.env.APC_HELDOUT_DENY;
  __resetPlatformWorkspaceCache();

  captures = [];
  const real = new ClaudeAgentClient({
    logger: makeLogger(),
    resolveBinary: async () => '/nonexistent/claude',
    queryFactory: (input: ClaudeQueryInput) => {
      captures.push({ settings: input.options.settings, env: input.options.env ?? {} });
      return {
        supportedCommands: async () => [],
        applyFlagSettings: async () => undefined,
        close: () => undefined,
        return: async () => undefined,
        async *[Symbol.asyncIterator]() {
          /* no messages */
        },
      } as never;
    },
  } as never);
  driver = new CodeAgentDriver(new BridgeClient(real), { cwd: tmpHome });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevSwitch === undefined) delete process.env.APC_HELDOUT_DENY;
  else process.env.APC_HELDOUT_DENY = prevSwitch;
  __resetPlatformWorkspaceCache();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────

describe('W5 — cloud platformScoped is the setter (dispatch half)', () => {
  it('正控: platformScoped:true ⇒ dispatch stamps apcHeldOutDeny=true', async () => {
    const meta = await dispatchAndReadMetadata({ platformScoped: true });
    expect(meta.apcHeldOutDeny).toBe(true);
  });

  it('负控: platformScoped:false ⇒ false (a civilian workspace never gets the hint)', async () => {
    const meta = await dispatchAndReadMetadata({ platformScoped: false });
    expect(meta.apcHeldOutDeny).toBe(false);
  });

  it('负控: field absent (old cloud ⇒ unknown) ⇒ false — "cannot tell" must not narrow a stranger', async () => {
    // W2 chose the opposite direction for the SKILL half (unknown ⇒ leave the
    // dir alone). Both mean "take no action"; the damaging move differs. Here
    // adding rules on a blind guess would re-create exactly the cross-agent
    // blast radius W4/W5 removed, and the hint's real backstop (the review-side
    // diff gate) is unaffected by a cloud outage.
    const meta = await dispatchAndReadMetadata({ platformScoped: undefined });
    expect(meta.apcHeldOutDeny).toBe(false);
  });

  it('负控: a hostile/stale payload.metadata cannot switch the boundary on', async () => {
    // `...payload.metadata` is spread FIRST; the daemon's own computed value is
    // written after it. If the order ever flips, this goes red.
    const meta = await dispatchAndReadMetadata({
      platformScoped: false,
      payloadMetadata: { apcHeldOutDeny: true },
    });
    expect(meta.apcHeldOutDeny).toBe(false);
  });

  it('负控: a non-claude-code agent in the SAME platform workspace is out of population', async () => {
    // resolveApcCodingScope short-circuits to 'n/a' via resolveCodingCwdSkillsDir
    // — the same gate that decides who receives the APC skill set at all.
    const meta = await dispatchAndReadMetadata({ platformScoped: true, adapterName: 'hermes' });
    expect(meta.apcHeldOutDeny).toBe(false);
  });
});

describe('W5 — the stamped verdict reaches the real SDK Options', () => {
  it('正控: apcHeldOutDeny=true ⇒ real buildOptions emits the held-out deny rules', async () => {
    await driver.dispatch(makeTask({ apcHeldOutDeny: true }));
    expect(captures.length, 'the query factory was never called').toBe(1);

    const deny = denyRules(captures[0]!.settings);
    for (const p of APC_HELD_OUT_PATHS) {
      expect(deny).toContain(`Edit(${p})`);
      expect(deny).toContain(`Edit(${p}/**)`);
    }
    expect(captures[0]!.env.APC_HELDOUT_DENY).toBe('1');
  });

  it('负控: a concurrent run on the SAME driver without the stamp gets nothing', async () => {
    await driver.dispatch(makeTask({ apcHeldOutDeny: true }, { taskId: 'apc' }));
    await driver.dispatch(
      // different conversationId ⇒ different sessionKey ⇒ a second real session
      makeTask({ apcHeldOutDeny: false, conversationId: 'c2' }, { taskId: 'plain' }),
    );
    expect(captures.length).toBe(2);
    expect(denyRules(captures[0]!.settings)).toContain('Edit(scripts/test203/baseline.json)');
    expect(denyRules(captures[1]!.settings)).toEqual([]);
    expect(captures[1]!.env.APC_HELDOUT_DENY).toBeUndefined();
  });

  it('负控: a truthy-but-not-true metadata value does NOT arm the boundary', async () => {
    await driver.dispatch(makeTask({ apcHeldOutDeny: '1' }));
    expect(denyRules(captures[0]!.settings)).toEqual([]);
  });

  it('the verdict survives the RESUME path (turn 2+ of the same session)', async () => {
    // A stored providerSessionId sends resolveSession down resumeSession, whose
    // overrides are built separately. Dropping `extra` there would silently lose
    // the boundary after the first turn.
    await driver.dispatch(
      makeTask(
        {
          apcHeldOutDeny: true,
          providerSessionId: JSON.stringify({ provider: 'claude', sessionId: 's1', metadata: { cwd: tmpHome } }),
        },
        { taskId: 'resumed' },
      ),
    );
    expect(captures.length).toBe(1);
    expect(denyRules(captures[0]!.settings)).toContain('Edit(scripts/test203/baseline.json)');
  });
});
