// WS-B (PP-1) — CodeAgentDriver bridge unit tests.
//
// Uses a hand-rolled fake AgentClient/AgentSession double (lighter than
// lifting Paseo's filesystem-coupled fake-agent-client). Covers:
//   - session reuse (createSession once, reuse on 2nd dispatch)
//   - TRAP 1 (retry × live session): no duplicate run() / non-retryable
//   - TRAP 2 (abort → interrupt, NOT close)
//   - event forwarding (tool_call timeline → recorder.recordToolCall)
//   - AgentRunResult → TaskResult mapping (output / metrics / canceled)
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.6 ①.

import { describe, it, expect, vi } from "vitest";
import { CodeAgentDriver } from "./code-agent-driver.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import type { TaskInput, StepRecorderHandle } from "../../contract.js";

const FLAGS: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

interface FakeSessionOpts {
  runImpl?: (prompt: AgentPromptInput, opts?: AgentRunOptions) => Promise<AgentRunResult>;
  sessionId?: string;
}

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = FLAGS;
  id: string;
  runCalls = 0;
  interruptCalls = 0;
  closeCalls = 0;
  private subscribers: Array<(e: AgentStreamEvent) => void> = [];

  constructor(private readonly opts: FakeSessionOpts = {}) {
    this.id = opts.sessionId ?? "sess-1";
  }

  emit(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) cb(event);
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    this.runCalls++;
    if (this.opts.runImpl) return this.opts.runImpl(prompt, options);
    return { sessionId: this.id, finalText: "done", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "t1" };
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter((c) => c !== callback);
    };
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    /* none */
  }
  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id };
  }
  async getAvailableModes(): Promise<AgentMode[]> {
    return [{ id: "default", label: "Default" }];
  }
  async getCurrentMode(): Promise<string | null> {
    return "default";
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission() {}
  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {
    this.interruptCalls++;
  }
  async close(): Promise<void> {
    this.closeCalls++;
  }
}

class FakeClient implements AgentClient {
  readonly provider: string;
  readonly capabilities = FLAGS;
  createCalls = 0;
  resumeCalls = 0;
  lastSession?: FakeSession;
  /** Captured config/overrides for autonomous-launch force assertions. */
  lastCreateConfig?: AgentSessionConfig;
  lastResumeOverrides?: Partial<AgentSessionConfig>;

  constructor(
    private readonly sessionFactory: () => FakeSession = () => new FakeSession(),
    provider = "claude",
  ) {
    this.provider = provider;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createCalls++;
    this.lastCreateConfig = config;
    this.lastSession = this.sessionFactory();
    return this.lastSession;
  }
  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeCalls++;
    this.lastResumeOverrides = overrides;
    this.lastSession = this.sessionFactory();
    return this.lastSession;
  }
  async listModels() {
    return [];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function makeTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    taskId: "task-1",
    prompt: "hello",
    metadata: { conversationId: "conv-1", agentImUserId: "agent-1" },
    ...over,
  };
}

const OPTS = { cwd: "/tmp/repo" };

describe("CodeAgentDriver", () => {
  it("creates a session once and reuses it for the same conversation key", async () => {
    const client = new FakeClient();
    const svc = new CodeAgentDriver(client, OPTS);

    const r1 = await svc.dispatch(makeTask({ taskId: "t-a" }));
    const r2 = await svc.dispatch(makeTask({ taskId: "t-b" })); // same conv key, new task

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(client.createCalls).toBe(1); // created once
    expect(client.resumeCalls).toBe(0);
  });

  // ── daemon-side FORCE: autonomous (no-permission-confirmation) launch ──────
  // agent-rt pods are non-interactive; a tool permission prompt can never be
  // answered there, so coding sessions MUST launch autonomous regardless of the
  // profile's modeId. Covers both createSession and resumeSession.
  describe("forces autonomous launch (no permission confirmation)", () => {
    it("claude: createSession config resolves to bypassPermissions when profile has no modeId", async () => {
      const client = new FakeClient(() => new FakeSession(), "claude");
      const svc = new CodeAgentDriver(client, OPTS); // OPTS has no modeId
      await svc.dispatch(makeTask({ taskId: "t-claude" }));
      expect(client.lastCreateConfig?.modeId).toBe("bypassPermissions");
    });

    it("codex: createSession config resolves to full-access + danger-full-access sandbox", async () => {
      const client = new FakeClient(() => new FakeSession(), "codex");
      const svc = new CodeAgentDriver(client, OPTS);
      await svc.dispatch(makeTask({ taskId: "t-codex" }));
      expect(client.lastCreateConfig?.modeId).toBe("full-access");
      expect(client.lastCreateConfig?.sandboxMode).toBe("danger-full-access");
      expect(client.lastCreateConfig?.approvalPolicy).toBe("never");
    });

    it("opencode: createSession config resolves to build mode + auto_accept feature", async () => {
      const client = new FakeClient(() => new FakeSession(), "opencode");
      const svc = new CodeAgentDriver(client, OPTS);
      await svc.dispatch(makeTask({ taskId: "t-opencode" }));
      expect(client.lastCreateConfig?.modeId).toBe("build");
      expect(client.lastCreateConfig?.featureValues?.auto_accept).toBe(true);
    });

    it("keeps an already-autonomous modeId (does not override an explicit choice)", async () => {
      const client = new FakeClient(() => new FakeSession(), "claude");
      const svc = new CodeAgentDriver(client, { ...OPTS, modeId: "bypassPermissions" });
      await svc.dispatch(makeTask({ taskId: "t-keep" }));
      expect(client.lastCreateConfig?.modeId).toBe("bypassPermissions");
    });

    it("resumeSession forwards the autonomous overrides (covers existing agents with stale modeId)", async () => {
      const client = new FakeClient(() => new FakeSession(), "codex");
      const svc = new CodeAgentDriver(client, OPTS);
      const handle: AgentPersistenceHandle = { provider: "codex", sessionId: "prior" };
      await svc.dispatch(
        makeTask({
          taskId: "t-resume-force",
          metadata: {
            conversationId: "conv-x",
            agentImUserId: "agent-1",
            providerSessionId: JSON.stringify(handle),
          },
        }),
      );
      expect(client.resumeCalls).toBe(1);
      expect(client.lastResumeOverrides?.modeId).toBe("full-access");
      expect(client.lastResumeOverrides?.sandboxMode).toBe("danger-full-access");
    });
  });

  it("resumes via round-tripped handle when no live session and metadata carries providerSessionId", async () => {
    const client = new FakeClient();
    const svc = new CodeAgentDriver(client, OPTS);

    const handle: AgentPersistenceHandle = { provider: "claude", sessionId: "prior" };
    const task = makeTask({
      taskId: "t-resume",
      metadata: {
        conversationId: "conv-resume",
        agentImUserId: "agent-1",
        providerSessionId: JSON.stringify(handle),
      },
    });
    const r = await svc.dispatch(task);
    expect(r.ok).toBe(true);
    expect(client.resumeCalls).toBe(1);
    expect(client.createCalls).toBe(0);
  });

  it("runtime210/09 §3.1b — progressHeartbeat emits the 0..1 monotonic contract (0.05 → +0.05 → cap 0.95)", async () => {
    const session = new FakeSession({
      runImpl: async () => {
        session.emit({ type: "turn_started" });
        session.emit({
          type: "timeline",
          item: {
            type: "tool_call",
            name: "read",
            callId: "c1",
            status: "running",
            detail: { type: "read", filePath: "f.txt" },
          },
        });
        // A long turn — the cap must hold (never the legacy 5..95 scale).
        for (let i = 0; i < 30; i += 1) session.emit({ type: "turn_started" });
        return { sessionId: "sess-1", finalText: "done", timeline: [] };
      },
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, { ...OPTS, progressHeartbeat: true });
    const progress: number[] = [];
    const result = await svc.dispatch(
      makeTask({
        taskId: "t-hb",
        onProgress: (p) => progress.push(p.progress),
      }),
    );
    expect(result.ok).toBe(true);
    expect(progress[0]).toBe(0.05);
    expect(progress[1]).toBe(0.1);
    expect(progress).toHaveLength(32);
    expect(Math.max(...progress)).toBe(0.95); // capped — the dispatcher owns 1.0
  });

  it("runtime210/09 §2.3 — taskCwdPriority binds the session cwd to the materialized workdir (off by default)", async () => {
    // pi-core opts IN: metadata.prismerWorkdirOverride (dispatch.ts's dedicated
    // persistent-workdir marker) must win over the profile cwd.
    const piClient = new FakeClient(() => new FakeSession(), "pi-core");
    const piSvc = new CodeAgentDriver(piClient, { ...OPTS, taskCwdPriority: true });
    await piSvc.dispatch(
      makeTask({
        taskId: "t-cwd-pi",
        metadata: {
          conversationId: "conv-cwd-pi",
          agentImUserId: "agent-1",
          prismerWorkdirOverride: "/tmp/materialized-workdir",
          prismerScratchDir: "/tmp/per-task-scratch",
        },
      }),
    );
    expect(piClient.lastCreateConfig?.cwd).toBe("/tmp/materialized-workdir");

    // pi-core negative: scratch-only metadata (no workdir spec) must NOT hijack
    // the jail — falls back to the profile cwd (probe PARTIAL root cause).
    const piScratchClient = new FakeClient(() => new FakeSession(), "pi-core");
    const piScratchSvc = new CodeAgentDriver(piScratchClient, { ...OPTS, taskCwdPriority: true });
    await piScratchSvc.dispatch(
      makeTask({
        taskId: "t-cwd-pi-scratch",
        metadata: {
          conversationId: "conv-cwd-pi-scratch",
          agentImUserId: "agent-1",
          prismerScratchDir: "/tmp/per-task-scratch",
        },
      }),
    );
    expect(piScratchClient.lastCreateConfig?.cwd).toBe(OPTS.cwd);

    // Coding adapters keep the profile cwd (negative control — no priority).
    const codingClient = new FakeClient(() => new FakeSession(), "claude");
    const codingSvc = new CodeAgentDriver(codingClient, OPTS);
    await codingSvc.dispatch(
      makeTask({
        taskId: "t-cwd-coding",
        metadata: {
          conversationId: "conv-cwd-coding",
          agentImUserId: "agent-1",
          prismerWorkdirOverride: "/tmp/materialized-workdir",
        },
      }),
    );
    expect(codingClient.lastCreateConfig?.cwd).toBe(OPTS.cwd);
  });

  it("TRAP 1: a retried dispatch for the same taskId does NOT re-run the live session", async () => {
    let calls = 0;
    const session = new FakeSession({
      runImpl: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { sessionId: "sess-1", finalText: "second", timeline: [] };
      },
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);

    const r1 = await svc.dispatch(makeTask({ taskId: "same" }));
    expect(r1.ok).toBe(false);
    // non-retryable marker = existing break code 'task_cancelled'
    expect(r1.error?.code).toBe("task_cancelled");

    // dispatch.ts would (defensively) re-invoke with the SAME taskId — guard it.
    const r2 = await svc.dispatch(makeTask({ taskId: "same" }));
    expect(r2.ok).toBe(false);
    expect(session.runCalls).toBe(1); // NOT re-run against the live session
  });

  it("TRAP 2: aborting the task signal calls session.interrupt(), NOT close()", async () => {
    let resolveRun!: (r: AgentRunResult) => void;
    const session = new FakeSession({
      runImpl: () =>
        new Promise<AgentRunResult>((res) => {
          resolveRun = res;
        }),
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);
    const ctrl = new AbortController();

    const p = svc.dispatch(makeTask({ taskId: "t-abort", signal: ctrl.signal }));
    // let the run start + subscribe
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 0));

    expect(session.interruptCalls).toBe(1);
    expect(session.closeCalls).toBe(0);

    // settle the run so the dispatch promise resolves
    resolveRun({ sessionId: "sess-1", finalText: "", timeline: [], canceled: true });
    await p;
    expect(session.closeCalls).toBe(0); // still not closed mid-turn
  });

  it("shutdown() closes sessions (the only place close() is called)", async () => {
    const session = new FakeSession();
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);
    await svc.dispatch(makeTask());
    await svc.shutdown();
    expect(session.closeCalls).toBe(1);
  });

  it("forwards a tool_call timeline event to recorder.recordToolCall with the mapped detail", async () => {
    const session = new FakeSession({
      runImpl: async () => {
        session.emit({
          type: "timeline",
          provider: "claude",
          item: {
            type: "tool_call",
            status: "running",
            error: null,
            callId: "call-9",
            name: "Bash",
            detail: { type: "shell", command: "echo hi" },
          },
        });
        return { sessionId: "sess-1", finalText: "ok", timeline: [] };
      },
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);

    const recordToolCall = vi.fn();
    const recorder: StepRecorderHandle = {
      recordPhaseChange: vi.fn(),
      recordToolCall,
      recordToolResult: vi.fn(),
      recordReasoningChunk: vi.fn(),
      recordError: vi.fn(),
    };
    await svc.dispatch(makeTask({ taskId: "t-fwd", recorder }));

    // WS-C — detail + status now threaded through as the 4th opts arg.
    expect(recordToolCall).toHaveBeenCalledWith(
      "Bash",
      { type: "shell", command: "echo hi" },
      "call-9",
      { detail: { type: "shell", command: "echo hi" }, status: "running" },
    );
  });

  it("WS-C forwards todo timeline → recorder.recordTodo and usage → recordUsage", async () => {
    const session = new FakeSession({
      runImpl: async () => {
        session.emit({
          type: "timeline",
          provider: "claude",
          item: { type: "todo", items: [{ text: "step 1", completed: false }] },
        });
        session.emit({
          type: "turn_completed",
          provider: "claude",
          usage: { inputTokens: 100, outputTokens: 50 },
        });
        return { sessionId: "sess-1", finalText: "ok", timeline: [] };
      },
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);

    const recordTodo = vi.fn();
    const recordUsage = vi.fn();
    const recorder: StepRecorderHandle = {
      recordPhaseChange: vi.fn(),
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
      recordReasoningChunk: vi.fn(),
      recordError: vi.fn(),
      recordTodo,
      recordUsage,
    };
    await svc.dispatch(makeTask({ taskId: "t-todo", recorder }));

    expect(recordTodo).toHaveBeenCalledWith([{ text: "step 1", completed: false }]);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50 });
  });

  it("maps AgentRunResult → TaskResult (output / metrics / providerSessionId)", async () => {
    const session = new FakeSession({
      runImpl: async () => ({
        sessionId: "sess-1",
        finalText: "the answer",
        usage: { inputTokens: 10, outputTokens: 5 },
        timeline: [],
      }),
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);

    const r = await svc.dispatch(makeTask({ taskId: "t-map" }));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("the answer");
    expect(r.metrics?.tokensUsed).toBe(15);
    const handle = JSON.parse(r.metadata?.providerSessionId as string);
    expect(handle.sessionId).toBe("sess-1");
  });

  it("maps a canceled AgentRunResult → task_cancelled error", async () => {
    const session = new FakeSession({
      runImpl: async () => ({ sessionId: "sess-1", finalText: "", timeline: [], canceled: true }),
    });
    const client = new FakeClient(() => session);
    const svc = new CodeAgentDriver(client, OPTS);

    const r = await svc.dispatch(makeTask({ taskId: "t-cancel" }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("task_cancelled");
  });

  // ── input-attachment forwarding (MVP3 regression fix) ──────────────────
  // The OLD driver sent `task.currentPrompt ?? task.prompt` — `currentPrompt`
  // is bare text (no asset blocks) and is ALWAYS set, so file bodies + image
  // attachments were dropped. These pin the corrected forwarding.

  function captureSession(): { session: FakeSession; seen: () => AgentPromptInput | undefined } {
    let captured: AgentPromptInput | undefined;
    const session = new FakeSession({
      runImpl: async (prompt) => {
        captured = prompt;
        return { sessionId: "sess-1", finalText: "ok", timeline: [] };
      },
    });
    return { session, seen: () => captured };
  }

  it("no attachment: sends bare currentPrompt (behavior-preserving)", async () => {
    const { session, seen } = captureSession();
    const svc = new CodeAgentDriver(new FakeClient(() => session), OPTS);
    await svc.dispatch(makeTask({ taskId: "t-bare", prompt: "FULL", currentPrompt: "bare" }));
    expect(seen()).toBe("bare");
  });

  it("text-file attachment: uses task.prompt (asset blocks inlined), NOT bare currentPrompt", async () => {
    const { session, seen } = captureSession();
    const svc = new CodeAgentDriver(new FakeClient(() => session), OPTS);
    await svc.dispatch(
      makeTask({
        taskId: "t-file",
        prompt: "INLINED_FILE_BODY + bare",
        currentPrompt: "bare",
        assetPromptBlocks: ["[Attached file] secret.py\n<body/>"],
      }),
    );
    expect(seen()).toBe("INLINED_FILE_BODY + bare");
  });

  it("image attachment + vision model: emits text + image content blocks (raw base64)", async () => {
    const { session, seen } = captureSession();
    const svc = new CodeAgentDriver(new FakeClient(() => session), {
      cwd: "/tmp/repo",
      model: "us-kimi-k2.6", // vision-capable
    });
    await svc.dispatch(
      makeTask({
        taskId: "t-img",
        prompt: "look at this",
        assetRefs: [
          {
            assetId: "a1",
            contentHash: "h1",
            mime: "image/png",
            sizeBytes: 10,
            kind: "image",
            workspaceId: "w1",
            role: "attachment",
            base64: "AAAA",
            reachable: "base64",
          },
        ],
      }),
    );
    const prompt = seen();
    expect(Array.isArray(prompt)).toBe(true);
    const blocks = prompt as Exclude<AgentPromptInput, string>;
    expect(blocks[0]).toEqual({ type: "text", text: "look at this" });
    expect(blocks).toContainEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("image attachment + NON-vision model: degrades to as-file (no image block, string prompt)", async () => {
    const { session, seen } = captureSession();
    const svc = new CodeAgentDriver(new FakeClient(() => session), {
      cwd: "/tmp/repo",
      model: "deepseek-chat", // NOT vision-capable
    });
    await svc.dispatch(
      makeTask({
        taskId: "t-img-novision",
        prompt: "look at this [Attached image] word.png",
        assetPromptBlocks: ["[Attached image] word.png"],
        assetRefs: [
          {
            assetId: "a2",
            contentHash: "h2",
            mime: "image/png",
            sizeBytes: 10,
            kind: "image",
            workspaceId: "w1",
            role: "attachment",
            base64: "BBBB",
            reachable: "base64",
          },
        ],
      }),
    );
    const prompt = seen();
    // No pixels sent; the as-file reminder text (task.prompt) is forwarded as a string.
    expect(typeof prompt).toBe("string");
    expect(prompt).toBe("look at this [Attached image] word.png");
  });
});
