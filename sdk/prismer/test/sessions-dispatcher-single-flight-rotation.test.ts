// release203/27 S10 — hermes sessions single-flight guard + pollution rotation.
//
// Two contracts under test:
//   1. Single-flight: while a turn is in-flight on a (conversation, agent)
//      session, a concurrent second dispatch is rejected as a TRANSIENT
//      precondition (`dispatch_precondition_unavailable` + hermes.status
//      'session_busy') — never a second interleaved turn on the same stateful
//      transcript. isSessionBusyTransient() recognises it so the daemon retry
//      loop surfaces it to the cloud's requeueTransientRun channel.
//   2. Rotation: after N consecutive empty_reply, OR after an interrupt/abort,
//      the NEXT turn mints a FRESH hermes session (createForConversation)
//      instead of reusing the polluted one (get). Negative control: healthy
//      turns never rotate.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/adapters/persistence/hermes/sessions-mapper.js', () => ({
  HermesSessionMapper: class {},
}));

type TestSseState = {
  runId: string | null;
  onRunStarted?: (runId: string) => void;
};

const registerSpy = vi.hoisted(() => vi.fn());
const recordTerminalRoutingSpy = vi.hoisted(() => vi.fn());

let sseBehavior: (state?: TestSseState) => Promise<Record<string, unknown>>;
vi.mock('../src/adapters/persistence/hermes/sessions-sse.js', () => ({
  consumeSessionsSse: vi.fn(async (_body: unknown, _task: unknown, state?: TestSseState) =>
    sseBehavior(state),
  ),
}));

vi.mock('../src/daemon/memory/run-session-map.js', () => ({
  getRunSessionRegistry: () => ({
    register: registerSpy,
    recordTerminalRouting: recordTerminalRoutingSpy,
  }),
}));

import { dispatchViaSessions } from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import { isSessionBusyTransient } from '../src/daemon/dispatch.js';
import { __resetSessionHealth } from '../src/adapters/persistence/hermes/session-health.js';
import type { TaskInput } from '../src/adapters/contract.js';
import type { ResolvedAssetRef } from '../src/types/im-events.js';

function makeTask(): TaskInput {
  return {
    taskId: 'run_s10',
    prompt: 'ignored',
    currentPrompt: 'hello',
    conversationType: 'direct',
    conversationId: 'cv_1',
    profileAgentUsername: 'engineer',
    profileAgentImUserId: 'u_engineer',
    metadata: { conversationId: 'cv_1', agentImUserId: 'u_engineer', workspaceId: 'ws_1' },
  } as unknown as TaskInput;
}

const EXISTING = {
  conversationId: 'cv_1',
  agentImUserId: 'u_engineer',
  hermesSessionId: 'hs_existing',
  hermesSessionKey: null,
};
const FRESH = {
  conversationId: 'cv_1',
  agentImUserId: 'u_engineer',
  hermesSessionId: 'hs_fresh',
  hermesSessionKey: null,
};

let getSpy: ReturnType<typeof vi.fn>;
let createSpy: ReturnType<typeof vi.fn>;
let invalidateSpy: ReturnType<typeof vi.fn>;
let chatBodies: Array<Record<string, unknown>>;

function makeDeps() {
  getSpy = vi.fn(() => EXISTING);
  createSpy = vi.fn(async () => FRESH);
  invalidateSpy = vi.fn();
  return {
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: 'test-key',
    profileName: 'engineer',
    serviceId: 'svc_test',
    model: 'hermes-test',
    providerName: 'prismer',
    capabilities: {},
    instructions: 'You are a test agent.',
    idempotencyKey: 'idem-1',
    sessionMapper: { get: getSpy, createForConversation: createSpy, invalidate: invalidateSpy },
  } as unknown as Parameters<typeof dispatchViaSessions>[1];
}

beforeEach(() => {
  __resetSessionHealth();
  registerSpy.mockClear();
  recordTerminalRoutingSpy.mockClear();
  chatBodies = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/chat/stream')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (url.includes('/messages'))
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSessionHealth();
});

describe('S10 single-flight guard', () => {
  it('rejects a concurrent turn on the same session as a session_busy transient', async () => {
    const deps = makeDeps();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sseBehavior = async () => {
      await gate; // hold turn 1 in-flight
      return { output: 'the answer', runId: 'run_a', approvalRequested: false };
    };

    const p1 = dispatchViaSessions(makeTask(), deps); // acquires in-flight slot
    await new Promise((r) => setTimeout(r, 10)); // let p1 reach the in-flight state

    const outcome2 = await dispatchViaSessions(makeTask(), deps); // same key → rejected
    expect(outcome2.result.ok).toBe(false);
    expect(outcome2.result.error?.code).toBe('dispatch_precondition_unavailable');
    expect(isSessionBusyTransient(outcome2.result)).toBe(true);
    expect((outcome2.result.metadata as { hermes: { status: string } }).hermes.status).toBe('session_busy');

    release();
    const outcome1 = await p1;
    expect(outcome1.result.ok).toBe(true);

    // After release, a subsequent turn is admitted again (slot freed).
    const outcome3 = await dispatchViaSessions(makeTask(), deps);
    expect(outcome3.result.ok).toBe(true);
  });
});

describe('Hermes native run context', () => {
  it('registers the native run before the SSE stream completes', async () => {
    const deps = makeDeps();
    const task = makeTask();
    task.metadata = {
      ...(task.metadata as Record<string, unknown>),
      runtimeCanonicalTurnId: 'run_cloud_runtime',
    };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const consumerEntered = new Promise<void>((resolve) => (entered = resolve));
    sseBehavior = async (state) => {
      state?.onRunStarted?.('api_native_run');
      entered();
      await gate;
      return {
        output: 'the answer',
        runId: 'api_native_run',
        approvalRequested: false,
        servedModel: 'served-model-final',
        servedProvider: 'served-provider-final',
      };
    };

    const pending = dispatchViaSessions(task, deps);
    await consumerEntered;
    try {
      expect(registerSpy).toHaveBeenCalledWith({
        runId: 'api_native_run',
        providerSessionId: 'hs_existing',
        conversationId: 'cv_1',
        taskId: 'run_cloud_runtime',
        agentImUserId: 'u_engineer',
        workspaceId: 'ws_1',
        messageId: null,
        profileId: 'svc_test',
        profileName: 'engineer',
        roleTemplateSlug: null,
        adapterName: 'hermes',
        model: 'hermes-test',
        proxyProvider: 'prismer',
      });
      const registered = registerSpy.mock.calls[0]?.[0] as { providerSessionId?: string };
      expect(registered.providerSessionId).not.toBe('api_native_run');
      expect(recordTerminalRoutingSpy).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(recordTerminalRoutingSpy).toHaveBeenCalledWith('api_native_run', {
      servedModel: 'served-model-final',
      servedProvider: 'served-provider-final',
      routingEvidenceSource: 'adapter',
    });
  });
});

describe('Hermes session runtime lock', () => {
  it('reconfirms the configured runtime on every multimodal turn for an existing session', async () => {
    const deps = makeDeps();
    deps.supportsVision = true;
    sseBehavior = async () => ({ output: 'the answer', runId: 'run_existing', approvalRequested: false });
    const imageRef: ResolvedAssetRef = {
      assetId: 'ast-existing',
      contentHash: 'sha256-existing',
      mime: 'image/png',
      sizeBytes: 123,
      kind: 'image',
      workspaceId: 'ws_1',
      role: 'attachment',
      cdnUrl: 'https://cdn.example.com/existing.png',
      reachable: 'cdn',
    };

    const outcome = await dispatchViaSessions(
      { ...makeTask(), assetRefs: [imageRef] } as TaskInput,
      deps,
    );

    expect(outcome.result.ok).toBe(true);
    expect(getSpy).toHaveBeenCalledWith('cv_1', 'u_engineer');
    expect(createSpy).not.toHaveBeenCalled();
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      model: 'hermes-test',
      require_model_lock: true,
    });
    expect(chatBodies[0]).not.toHaveProperty('provider');
    expect(chatBodies[0]?.system_message).toContain('You are a test agent.');

    const message = chatBodies[0]?.message as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(message[0]).toMatchObject({ type: 'text' });
    expect(message[0]?.text).toContain('hello');
    expect(message.find((part) => part.type === 'image_url')?.image_url?.url).toBe(
      'https://cdn.example.com/existing.png',
    );
  });

  it.each([
    [401, 'unauthorized'],
    [409, 'session model mismatch'],
  ])('keeps Hermes %s responses as loud dispatch failures', async (status, responseText) => {
    const deps = makeDeps();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(responseText, { status }));

    const outcome = await dispatchViaSessions(makeTask(), deps);

    expect(outcome.result).toMatchObject({
      ok: false,
      error: {
        code: 'adapter_dispatch_failed',
        message: `Hermes sessions ${status}: ${responseText}`,
      },
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('S10 pollution rotation', () => {
  it('locks a fresh session to the configured model without reasserting provider identity', async () => {
    const deps = makeDeps();
    getSpy.mockReturnValue(null);
    sseBehavior = async () => ({ output: 'the answer', runId: 'run_fresh', approvalRequested: false });

    const outcome = await dispatchViaSessions(makeTask(), deps);

    expect(outcome.result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:9000',
      'test-key',
      'cv_1',
      'u_engineer',
      'engineer',
      'ws_1',
      { model: 'hermes-test' },
    );
  });

  it('rotates to a fresh session after 2 consecutive empty_replies (spec 11 T1-3 threshold)', async () => {
    const deps = makeDeps();
    sseBehavior = async () => ({ output: '', runId: 'run_e', approvalRequested: false }); // empty, nothing recoverable

    // Turn 1: empty (streak 1) — below the threshold, the session is reused.
    const t1 = await dispatchViaSessions(makeTask(), deps);
    expect(t1.result.error?.code).toBe('empty_reply');
    expect(createSpy).not.toHaveBeenCalled();

    // Turn 2: still reused (the streak was 1 at turn start), and THIS empty
    // reply reaches the bar.
    const t2 = await dispatchViaSessions(makeTask(), deps);
    expect(t2.result.error?.code).toBe('empty_reply');
    expect(createSpy).not.toHaveBeenCalled();

    // Turn 3: streak reached threshold → mint a FRESH session (negative control:
    // createForConversation is only reached via the rotation branch).
    await dispatchViaSessions(makeTask(), deps);
    expect(createSpy).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('rotates to a fresh session after an interrupt/abort', async () => {
    const deps = makeDeps();
    sseBehavior = async () => {
      throw new Error('upstream stall: no first event for 270s (sessions SSE in-flight watchdog)');
    };
    const t1 = await dispatchViaSessions(makeTask(), deps); // stall → interrupted
    expect(t1.result.ok).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();

    sseBehavior = async () => ({ output: 'recovered answer', runId: 'run_ok', approvalRequested: false });
    await dispatchViaSessions(makeTask(), deps); // next turn rotates
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('rotates to a fresh session after a connection-level break (gateway killed / network drop)', async () => {
    const deps = makeDeps();
    // Not a stall, not a cancel — a connection-level failure. sessions-sse never
    // throws on application-level errors (those return via sseResult), so any
    // thrown error reaching the dispatcher catch that is not the resolveSession
    // fallback is an interrupted turn → the session is presumed polluted.
    sseBehavior = async () => {
      throw new TypeError('fetch failed: network connection lost');
    };
    const t1 = await dispatchViaSessions(makeTask(), deps);
    expect(t1.result.ok).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();

    sseBehavior = async () => ({ output: 'recovered answer', runId: 'run_ok2', approvalRequested: false });
    await dispatchViaSessions(makeTask(), deps); // next turn rotates
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('negative control: healthy turns never rotate (always reuse)', async () => {
    const deps = makeDeps();
    sseBehavior = async () => ({ output: 'a real answer', runId: 'run_h', approvalRequested: false });
    for (let i = 0; i < 4; i++) {
      const o = await dispatchViaSessions(makeTask(), deps);
      expect(o.result.ok).toBe(true);
    }
    expect(createSpy).not.toHaveBeenCalled(); // no pollution → no rotation
    expect(getSpy).toHaveBeenCalled();
  });
});
