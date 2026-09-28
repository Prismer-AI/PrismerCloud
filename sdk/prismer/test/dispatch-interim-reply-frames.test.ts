// S6/M1 Task 2 — daemon wire: `task.dispatch.reply` multi-frame semantics.
//
// Oracle: a mock WsClient captures every envelope `sendReply` emits — the ONLY
// ws exit the dispatch path has. No real socket, no real gateway (双门制).
//
// Wire invariants under test (§2.2 I1-I6):
//   I1  interim frame shape  { taskId, ok:true, output:<segment>, seq, final:false }
//   I2  terminal frame of a multi-frame turn carries { seq: N+1, final: true }
//   I3  capability bit absent / env kill-switch off / zero-commentary turn ⇒
//       exactly ONE frame, byte-compat with the legacy single-frame shape
//       (no seq / final keys on the wire at all)
//   I4  seq strictly increases 1..N+1 across the turn's frames
//   I5  every frame of the turn echoes the dispatch requestId
//   I6  a failed terminal frame AFTER interim frames were already relayed is
//       still marked { seq: N+1, final: true } (I6 constrains interim frames
//       never to fail; the terminal frame stays the single completion marker)
//
// Four-pairing compat matrix (spec 06 Task 6 Step 1) — daemon half lives here:
//   pairing 1 (new daemon × legacy cloud) = "interimReply bit is ABSENT" case
//   pairing 3 (new daemon × new cloud, flag off) = RELAY-env-off case
//   pairing 4 (upstream gate off) = "zero-commentary turn" case
//   pairing 2 (legacy daemon × new cloud) has no daemon-side test by
//   construction — an old daemon never emits seq/final at all.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleDispatch, buildInterimFrame, markTerminalFrame } from '../src/daemon/dispatch.js';
import type { TaskInput } from '../src/adapters/contract.js';
import type { AdapterDef, AgentProfile } from '../src/adapters/contract.js';
import type { TaskDispatchReplyPayload } from '../src/types/im-events.js';

const RELAY_ENV = 'HERMES_COMMENTARY_RELAY';

interface CapturedEnvelope {
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
}

describe('interim reply frames (S6/M1 Task 2)', () => {
  let savedRelayEnv: string | undefined;

  beforeEach(() => {
    savedRelayEnv = process.env[RELAY_ENV];
    delete process.env[RELAY_ENV];
  });

  afterEach(() => {
    if (savedRelayEnv === undefined) delete process.env[RELAY_ENV];
    else process.env[RELAY_ENV] = savedRelayEnv;
  });

  // Harness mirrors test/dispatch.test.ts "handleDispatch Hermes convergence":
  // mock cloud + registry + ws (frame capture) + long-running adapter whose
  // dispatch() receives the assembled TaskInput.
  function buildHarness(adapterDispatch: (task: TaskInput) => Promise<{ ok: boolean; output?: string; error?: { code: string; message: string } }>) {
    const sent: CapturedEnvelope[] = [];
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
      workspaceSchema: {} as never,
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    };
    const cloud = {
      get: vi.fn(async (path: string) => {
        if (path === '/api/im/agent_profiles/profile-1') return profile;
        if (path.startsWith('/api/im/skills/installed?')) return [];
        if (path.startsWith('/api/im/memory/digest?')) return { digest: '', filesTotal: 0 };
        if (path.startsWith('/api/im/tasks?')) return [];
        throw new Error(`unexpected GET ${path}`);
      }),
      request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, data: {} } })),
    };
    const deps = {
      registry: { get: () => adapter } as never,
      cloud: cloud as never,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      } as never,
      assetCache: { unpin: vi.fn() } as never,
      ws: { send: (msg: unknown) => sent.push(msg as CapturedEnvelope) } as never,
      ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch: adapterDispatch }),
    };
    const replyFrames = (): TaskDispatchReplyPayload[] =>
      sent.filter((m) => m.type === 'task.dispatch.reply').map((m) => m.payload as TaskDispatchReplyPayload);
    return { sent, deps, replyFrames };
  }

  it('emits {seq,final:false} per segment + one terminal {seq:N+1,final:true} when capability bit present', async () => {
    const { sent, deps, replyFrames } = buildHarness(async (task) => {
      task.onInterimReply?.({ text: 'seg-1', seq: 1 });
      task.onInterimReply?.({ text: 'seg-2', seq: 2 });
      return { ok: true, output: 'final answer' };
    });

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'hi',
        interimReply: true,
      },
      'req-1',
      deps,
    );

    const frames = replyFrames();
    // I4: exactly N interim + 1 terminal; I1/I2 shapes.
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ taskId: 'task-1', ok: true, output: 'seg-1', seq: 1, final: false });
    expect(frames[1]).toEqual({ taskId: 'task-1', ok: true, output: 'seg-2', seq: 2, final: false });
    expect(frames[2]).toMatchObject({ taskId: 'task-1', ok: true, output: 'final answer', seq: 3, final: true });
    // I4: seq strictly increasing 1..N+1.
    const seqs = frames.map((f) => f.seq);
    expect(seqs).toEqual([1, 2, 3]);
    // Exactly one final:true frame, and it is the LAST frame.
    expect(frames.filter((f) => f.final === true)).toHaveLength(1);
    expect(frames[frames.length - 1].final).toBe(true);
    // I5: every frame of the turn echoes the dispatch requestId.
    expect(sent.filter((m) => m.type === 'task.dispatch.reply').map((m) => m.requestId)).toEqual(['req-1', 'req-1', 'req-1']);
    // The returned reply carries the terminal marking too (same object sent).
    expect(reply.seq).toBe(3);
    expect(reply.final).toBe(true);
  });

  it('emits exactly ONE legacy-shaped frame when interimReply bit is ABSENT (legacy cloud pairing)', async () => {
    // Negative control ① — the adapter "produces" segments whenever the
    // callback exists; with the bit absent the daemon must never attach it,
    // so a legacy cloud physically cannot receive interim frames.
    const { deps, replyFrames } = buildHarness(async (task) => {
      expect(task.onInterimReply).toBeUndefined();
      task.onInterimReply?.({ text: 'seg-1', seq: 1 });
      task.onInterimReply?.({ text: 'seg-2', seq: 2 });
      return { ok: true, output: 'final answer' };
    });

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'hi',
        // no interimReply bit — legacy cloud
      },
      'req-1',
      deps,
    );

    const frames = replyFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ taskId: 'task-1', ok: true, output: 'final answer' });
    // I3 byte-compat: the keys must be ABSENT, not merely undefined-valued.
    expect('seq' in frames[0]).toBe(false);
    expect('final' in frames[0]).toBe(false);
    expect(reply.ok).toBe(true);
  });

  it('emits exactly ONE legacy-shaped frame when HERMES_COMMENTARY_RELAY explicitly off', async () => {
    // Negative control ② — capability bit present, daemon-side kill-switch
    // closed (second gate of the double-gate). Same single-frame behavior.
    process.env[RELAY_ENV] = 'off';
    const { deps, replyFrames } = buildHarness(async (task) => {
      expect(task.onInterimReply).toBeUndefined();
      task.onInterimReply?.({ text: 'seg-1', seq: 1 });
      return { ok: true, output: 'final answer' };
    });

    await handleDispatch(
      {
        taskId: 'task-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'hi',
        interimReply: true,
      },
      'req-1',
      deps,
    );

    const frames = replyFrames();
    expect(frames).toHaveLength(1);
    expect('seq' in frames[0]).toBe(false);
    expect('final' in frames[0]).toBe(false);
    expect(frames[0].output).toBe('final answer');
  });

  it('emits exactly ONE legacy-shaped frame on a zero-commentary turn even with the bit present', async () => {
    // Negative control ③ — relay armed but the adapter never fires the
    // callback (no commentary upstream): I3 single-frame, byte-identical.
    const { deps, replyFrames } = buildHarness(async () => ({ ok: true, output: 'final answer' }));

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'hi',
        interimReply: true,
      },
      'req-1',
      deps,
    );

    const frames = replyFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ taskId: 'task-1', ok: true, output: 'final answer' });
    expect('seq' in frames[0]).toBe(false);
    expect('final' in frames[0]).toBe(false);
    expect(reply.seq).toBeUndefined();
  });

  it('marks a FAILED terminal frame {seq:N+1,final:true} when interim frames were already relayed', async () => {
    const { deps, replyFrames } = buildHarness(async (task) => {
      task.onInterimReply?.({ text: 'seg-1', seq: 1 });
      task.onInterimReply?.({ text: 'seg-2', seq: 2 });
      // task_cancelled exits the retry loop immediately (no backoff).
      return { ok: false, error: { code: 'task_cancelled', message: 'cancelled mid-turn' } };
    });

    const reply = await handleDispatch(
      {
        taskId: 'task-1',
        profileId: 'profile-1',
        capability: 'code',
        prompt: 'hi',
        interimReply: true,
      },
      'req-1',
      deps,
    );

    const frames = replyFrames();
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ ok: true, output: 'seg-1', seq: 1, final: false });
    expect(frames[1]).toMatchObject({ ok: true, output: 'seg-2', seq: 2, final: false });
    expect(frames[2]).toMatchObject({
      ok: false,
      error: { code: 'task_cancelled' },
      seq: 3,
      final: true,
    });
    expect(reply.ok).toBe(false);
  });

  it('keeps seq strictly increasing across a transient retry (adapter-reported seq is per-stream and resets)', async () => {
    // Negative control ④ — fix round 1. Task 1's commentarySeq is per-SSE-
    // stream local and restarts at 1 on every attempt, while the daemon retry
    // loop reuses the SAME taskInput.onInterimReply closure. Trusting the
    // adapter-reported seq would put [1, …, 1, terminal N] on the wire after
    // a transient retry (I4 violated twice: duplicate seq AND a terminal
    // frame that is not the max). The daemon-side counter is the single
    // source of truth; the adapter-reported value is deliberately ignored.
    const savedBackoff = process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
    process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = '0';
    try {
      let attempt = 0;
      const { deps, replyFrames } = buildHarness(async (task) => {
        attempt += 1;
        if (attempt === 1) {
          task.onInterimReply?.({ text: 'seg-1', seq: 1 });
          // Retryable transient failure (not approval / cancel / permanent /
          // empty_reply / session-busy) — the loop comes back for attempt 2.
          return { ok: false, error: { code: 'gateway_blip', message: 'upstream 500' } };
        }
        // Attempt 2 runs on a NEW SSE stream: upstream commentarySeq restarts
        // at 1 — exactly the wire hazard this test pins.
        task.onInterimReply?.({ text: 'seg-2', seq: 1 });
        return { ok: true, output: 'final answer' };
      });

      const reply = await handleDispatch(
        {
          taskId: 'task-1',
          profileId: 'profile-1',
          capability: 'code',
          prompt: 'hi',
          interimReply: true,
        },
        'req-1',
        deps,
      );

      const frames = replyFrames();
      expect(frames).toHaveLength(3);
      // I4 across attempts: daemon-minted 1..N+1, no duplicate, terminal max.
      expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
      expect(frames[0]).toMatchObject({ ok: true, output: 'seg-1', seq: 1, final: false });
      expect(frames[1]).toMatchObject({ ok: true, output: 'seg-2', seq: 2, final: false });
      expect(frames[2]).toMatchObject({ ok: true, output: 'final answer', seq: 3, final: true });
      expect(frames.filter((f) => f.final === true)).toHaveLength(1);
      expect(reply.seq).toBe(3);
    } finally {
      if (savedBackoff === undefined) delete process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
      else process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS = savedBackoff;
    }
  });

  it('logs the degenerate deltas-fallback signature when terminal output replays relayed segments verbatim', async () => {
    // Adjudicated residual-window disposal (S6/M1 Task 2 report): a turn whose
    // final output EXACTLY equals the already-relayed commentary segments is
    // the "upstream commentary leaked into the output path" signature. Frames
    // already sent cannot be retracted (fire-and-forget mid-stream), so the
    // daemon-side disposal is the grep-able stderr marker + the contract note;
    // the frame plan itself stays on the I1-I6 standard.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const { deps, replyFrames } = buildHarness(async (task) => {
        task.onInterimReply?.({ text: 'a', seq: 1 });
        task.onInterimReply?.({ text: 'b', seq: 2 });
        // Degenerate turn: no valid assistant.completed → output fell back to
        // the delta accumulation, which upstream also fed the narration into.
        return { ok: true, output: 'ab' };
      });

      await handleDispatch(
        {
          taskId: 'task-1',
          profileId: 'profile-1',
          capability: 'code',
          prompt: 'hi',
          interimReply: true,
        },
        'req-1',
        deps,
      );

      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('interim relay degenerate turn');
      expect(logged).toContain('task-1');
      // Frame plan unchanged — Task 3's cloud handler consumes only
      // final===false / seq; no invented semantics.
      const frames = replyFrames();
      expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('pure frame builders: buildInterimFrame is I1-shaped; markTerminalFrame stamps seq=N+1/final:true and preserves the reply', () => {
    expect(buildInterimFrame('task-1', { text: 'seg-1', seq: 1 })).toEqual({
      taskId: 'task-1',
      ok: true,
      output: 'seg-1',
      seq: 1,
      final: false,
    });
    const terminal = markTerminalFrame(
      { taskId: 'task-1', ok: true, output: 'final answer', metrics: { durationMs: 5 } },
      2,
    );
    expect(terminal).toEqual({
      taskId: 'task-1',
      ok: true,
      output: 'final answer',
      metrics: { durationMs: 5 },
      seq: 3,
      final: true,
    });
  });
});
