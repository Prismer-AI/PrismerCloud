// WP-C (product209/08 P3) — coding session lifecycle tests: resume semantics,
// TRAP 1 single-flight, and session identity continuity.
//
// These tests verify the existing code-agent-driver behavior — the daemon-side
// session lifecycle is already mature. The tests serve as regression protection
// and document the expected behavior for UI integration.
//
// Test matrix (08 §5):
//   Case 2 (正控): Same (repo, adapter, agent) second turn → resumeSession
//   Case 5 (负控): TRAP 1 in-flight → reject duplicate run
//   Session identity: Different conversationId → createSession (new session)

import { describe, it, expect, vi } from "vitest";
import { CodeAgentDriver } from "../src/adapters/coding/shared/code-agent-driver.js";
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
} from "../src/adapters/coding/shared/agent-sdk-types.js";
import type { TaskInput } from "../src/adapters/contract.js";

// ── Test fixtures ──────────────────────────────────────────────────────

const FLAGS: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

let nextSessionId = 1;
function nextSid(): string {
  return `sess-${nextSessionId++}`;
}

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = FLAGS;
  id: string;
  lastRunOptions?: AgentRunOptions;
  constructor(id?: string) {
    this.id = id ?? nextSid();
  }
  subscribe(): () => void {
    return () => {};
  }
  async run(_p: AgentPromptInput, _o?: AgentRunOptions): Promise<AgentRunResult> {
    this.lastRunOptions = _o;
    return {
      sessionId: this.id,
      finalText: `output from ${this.id}`,
      timeline: [],
      servedModel: 'served-model-final',
      servedProvider: 'claude',
    } as AgentRunResult;
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: `turn-${this.id}` };
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id };
  }
  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }
  async getCurrentMode(): Promise<string | null> {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission() {}
  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeClient implements AgentClient {
  readonly capabilities = FLAGS;
  createSessionCalls = 0;
  resumeSessionCalls = 0;
  lastCreateConfig?: AgentSessionConfig;
  lastResumeHandle?: AgentPersistenceHandle;
  lastResumeOverrides?: Partial<AgentSessionConfig>;
  private _session?: FakeSession;
  get session(): FakeSession | undefined { return this._session; }

  constructor(readonly provider: string) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createSessionCalls++;
    this.lastCreateConfig = config;
    this._session = new FakeSession();
    return this._session;
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeSessionCalls++;
    this.lastResumeHandle = handle;
    this.lastResumeOverrides = overrides;
    this._session = new FakeSession(handle.sessionId);
    return this._session;
  }
  async listModels() {
    return [];
  }
  async isAvailable() {
    return true;
  }
}

function makeTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    prompt: "hello",
    metadata: { conversationId: "conv-1", agentImUserId: "agent-a" },
    ...overrides,
  };
}

function encodeHandle(handle: AgentPersistenceHandle): string {
  return JSON.stringify(handle);
}

const OPTS = { cwd: "/tmp/repo" };

// ── Test suite ─────────────────────────────────────────────────────────

describe("Coding session lifecycle (WP-C P3)", () => {
  it("passes canonical cloud identity and immutable model/profile context to the provider finalizer", async () => {
    const client = new FakeClient("claude");
    const driver = new CodeAgentDriver(client, { cwd: "/tmp/repo", model: "fallback-model" });

    const result = await driver.dispatch(makeTask({
      taskId: "run_cloud_code_1",
      metadata: {
        conversationId: "conv-code",
        agentImUserId: "agent-code",
        workspaceId: "ws-code",
        triggerMessageId: "msg-code",
        runtimeCanonicalTurnId: "run_cloud_code_1",
        runtimeRunId: "run_cloud_code_1",
        runtimeProfileId: "profile-code",
        runtimeProfileName: "Code Agent",
        runtimeExecutionModel: "deepseek-v4-flash",
        runtimeProxyProvider: "chain-code",
        roleTemplateSlug: "engineer",
      },
    }));

    expect(client.session?.lastRunOptions?.postTurn).toMatchObject({
      conversationId: "conv-code",
      runId: "run_cloud_code_1",
      messageId: "msg-code",
      canonicalTurnId: "run_cloud_code_1",
      lane: "async-repair",
      executionContext: {
        adapterName: "claude",
        profileId: "profile-code",
        profileName: "Code Agent",
        roleSlug: "engineer",
        model: "deepseek-v4-flash",
        proxyProvider: "chain-code",
      },
    });
    expect(result.metadata).toMatchObject({
      modelUsed: 'served-model-final',
      providerUsed: 'claude',
    });
  });

  // ── Case 2 (正控): resume on second turn ────────────────────────────

  describe("resume semantics", () => {
    it("first turn with no providerSessionId → createSession", async () => {
      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, OPTS);
      await driver.dispatch(makeTask({ taskId: "t1" }));
      expect(client.createSessionCalls).toBe(1);
      expect(client.resumeSessionCalls).toBe(0);
    });

    it("same session key → session reused from in-memory cache (no new create)", async () => {
      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, OPTS);

      // First turn: creates session.
      await driver.dispatch(
        makeTask({
          taskId: "t2a",
          metadata: { conversationId: "conv-2", agentImUserId: "agent-b" },
        }),
      );
      expect(client.createSessionCalls).toBe(1);

      // Second turn: same key → in-memory cache hit, no createSession/resumeSession.
      await driver.dispatch(
        makeTask({
          taskId: "t2b",
          metadata: { conversationId: "conv-2", agentImUserId: "agent-b" },
        }),
      );
      expect(client.createSessionCalls).toBe(1); // unchanged
      expect(client.resumeSessionCalls).toBe(0); // cache hit, no resume needed
    });

    it("providerSessionId + no live session → resumeSession (daemon restart recovery)", async () => {
      const client = new FakeClient("claude");
      const driver1 = new CodeAgentDriver(client, OPTS);

      // First turn on driver1: creates session, returns persistence handle.
      const r1 = await driver1.dispatch(
        makeTask({
          taskId: "t-restart-a",
          metadata: { conversationId: "conv-restart", agentImUserId: "agent-r" },
        }),
      );
      const handleJson =
        r1.metadata && typeof r1.metadata === "object" && "providerSessionId" in r1.metadata
          ? String((r1.metadata as Record<string, unknown>).providerSessionId)
          : null;
      expect(handleJson).toBeTruthy();

      // Simulate daemon restart: fresh driver, same client, no live sessions.
      const driver2 = new CodeAgentDriver(client, OPTS);
      await driver2.dispatch(
        makeTask({
          taskId: "t-restart-b",
          metadata: {
            conversationId: "conv-restart",
            agentImUserId: "agent-r",
            providerSessionId: handleJson!,
          },
        }),
      );
      expect(client.resumeSessionCalls).toBe(1);
      expect(client.lastResumeHandle?.sessionId).toBeTruthy();
    });

    it("different conversation → createSession (new session identity)", async () => {
      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, OPTS);

      await driver.dispatch(
        makeTask({
          taskId: "t3a",
          metadata: { conversationId: "conv-A", agentImUserId: "agent-x" },
        }),
      );
      expect(client.createSessionCalls).toBe(1);

      // Different conversation → new session.
      await driver.dispatch(
        makeTask({
          taskId: "t3b",
          metadata: { conversationId: "conv-B", agentImUserId: "agent-x" },
        }),
      );
      expect(client.createSessionCalls).toBe(2);
      expect(client.resumeSessionCalls).toBe(0);
    });

    it("session ID preserved through persistence handle round-trip", async () => {
      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, OPTS);

      const r1 = await driver.dispatch(
        makeTask({
          taskId: "t4a",
          metadata: { conversationId: "conv-4", agentImUserId: "agent-c" },
        }),
      );
      const sid1 =
        r1.metadata && typeof r1.metadata === "object"
          ? JSON.parse(String((r1.metadata as Record<string, unknown>).providerSessionId ?? "{}"))
              .sessionId
          : null;
      expect(sid1).toBeTruthy();

      // Resume with the same handle → should return the same session ID.
      const r2 = await driver.dispatch(
        makeTask({
          taskId: "t4b",
          metadata: {
            conversationId: "conv-4",
            agentImUserId: "agent-c",
            providerSessionId: r1.metadata
              ? String((r1.metadata as Record<string, unknown>).providerSessionId)
              : undefined,
          },
        }),
      );
      // The output should contain the session ID from the cached (first) session.
      expect(r2.output).toContain(sid1);
    });
  });

  // ── Case 5 (负控): TRAP 1 single-flight ─────────────────────────────

  describe("TRAP 1 single-flight guard", () => {
    it("duplicate taskId returns cached terminal result", async () => {
      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, OPTS);

      const r1 = await driver.dispatch(makeTask({ taskId: "t-dup" }));
      expect(r1.ok).toBe(true);

      // Re-dispatch same taskId → replay cached result.
      const r2 = await driver.dispatch(makeTask({ taskId: "t-dup" }));
      expect(r2.ok).toBe(true);
      expect(r2.output).toBe(r1.output);
      // Should NOT have created a second session.
      expect(client.createSessionCalls).toBe(1);
    });

    it("replayed result has same persistence metadata", async () => {
      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, OPTS);

      const r1 = await driver.dispatch(makeTask({ taskId: "t-replay" }));
      const r2 = await driver.dispatch(makeTask({ taskId: "t-replay" }));

      const md1 =
        r1.metadata && typeof r1.metadata === "object"
          ? (r1.metadata as Record<string, unknown>).providerSessionId
          : undefined;
      const md2 =
        r2.metadata && typeof r2.metadata === "object"
          ? (r2.metadata as Record<string, unknown>).providerSessionId
          : undefined;
      expect(md1).toBe(md2);
    });
  });

  // ── Autonomous launch on resume ─────────────────────────────────────

  describe("autonomous launch on resume", () => {
    it("claude resumeSession after restart also gets forced bypassPermissions", async () => {
      const client = new FakeClient("claude");
      const driver1 = new CodeAgentDriver(client, OPTS);

      const r1 = await driver1.dispatch(
        makeTask({
          taskId: "t-auton-a",
          metadata: { conversationId: "conv-auton", agentImUserId: "agent-d" },
        }),
      );
      const handleJson =
        r1.metadata && typeof r1.metadata === "object"
          ? String((r1.metadata as Record<string, unknown>).providerSessionId)
          : null;
      expect(handleJson).toBeTruthy();

      // Fresh driver (simulated restart) → resumeSession path.
      const driver2 = new CodeAgentDriver(client, OPTS);
      await driver2.dispatch(
        makeTask({
          taskId: "t-auton-b",
          metadata: {
            conversationId: "conv-auton",
            agentImUserId: "agent-d",
            providerSessionId: handleJson!,
          },
        }),
      );
      expect(client.resumeSessionCalls).toBe(1);
      expect(client.lastResumeOverrides?.modeId).toBe("bypassPermissions");
    });
  });
});
