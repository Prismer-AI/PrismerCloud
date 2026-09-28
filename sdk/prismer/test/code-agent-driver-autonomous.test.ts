// release203 — daemon-side FORCE: coding agents launch autonomous (no permission
// confirmation) in agent-rt pods. These assertions live under test/ so they run
// under the configured `npm test` glob (vitest include: test/**). They mirror the
// colocated src/adapters/coding/shared/code-agent-driver.test.ts cases for the
// autonomous-launch force.
//
// Why this matters: agent-rt pods are non-interactive. A tool permission prompt
// can never be answered there, so the provider blocks until the 300s watchdog
// (confirmed live: run f27vyi hung 328s). The pod IS the isolation boundary, so
// coding sessions must launch fully autonomous regardless of the profile modeId.

import { describe, it, expect } from "vitest";
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

const FLAGS: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = FLAGS;
  id = "sess-1";
  subscribe(): () => void {
    return () => {};
  }
  async run(_p: AgentPromptInput, _o?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "ok", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "t1" };
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
  resumeCalls = 0;
  lastCreateConfig?: AgentSessionConfig;
  lastResumeOverrides?: Partial<AgentSessionConfig>;
  constructor(readonly provider: string) {}
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.lastCreateConfig = config;
    return new FakeSession();
  }
  async resumeSession(
    _h: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeCalls++;
    this.lastResumeOverrides = overrides;
    return new FakeSession();
  }
  async listModels() {
    return [];
  }
  async isAvailable() {
    return true;
  }
}

function makeTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    taskId: "t",
    prompt: "hello",
    metadata: { conversationId: "c", agentImUserId: "a" },
    ...over,
  };
}

const OPTS = { cwd: "/tmp/repo" }; // deliberately NO modeId

describe("CodeAgentDriver autonomous launch force", () => {
  it("claude → bypassPermissions when profile modeId absent", async () => {
    const client = new FakeClient("claude");
    await new CodeAgentDriver(client, OPTS).dispatch(makeTask({ taskId: "c1" }));
    expect(client.lastCreateConfig?.modeId).toBe("bypassPermissions");
  });

  it("codex → full-access + danger-full-access + approval never", async () => {
    const client = new FakeClient("codex");
    await new CodeAgentDriver(client, OPTS).dispatch(makeTask({ taskId: "c2" }));
    expect(client.lastCreateConfig?.modeId).toBe("full-access");
    expect(client.lastCreateConfig?.sandboxMode).toBe("danger-full-access");
    expect(client.lastCreateConfig?.approvalPolicy).toBe("never");
  });

  it("opencode → build mode + auto_accept feature true", async () => {
    const client = new FakeClient("opencode");
    await new CodeAgentDriver(client, OPTS).dispatch(makeTask({ taskId: "c3" }));
    expect(client.lastCreateConfig?.modeId).toBe("build");
    expect(client.lastCreateConfig?.featureValues?.auto_accept).toBe(true);
  });

  it("keeps an already-autonomous modeId (no override of explicit choice)", async () => {
    const client = new FakeClient("claude");
    await new CodeAgentDriver(client, { ...OPTS, modeId: "bypassPermissions" }).dispatch(
      makeTask({ taskId: "c4" }),
    );
    expect(client.lastCreateConfig?.modeId).toBe("bypassPermissions");
  });

  it("resumeSession forwards autonomous overrides (covers existing agents)", async () => {
    const client = new FakeClient("codex");
    const handle: AgentPersistenceHandle = { provider: "codex", sessionId: "prior" };
    await new CodeAgentDriver(client, OPTS).dispatch(
      makeTask({
        taskId: "c5",
        metadata: {
          conversationId: "c",
          agentImUserId: "a",
          providerSessionId: JSON.stringify(handle),
        },
      }),
    );
    expect(client.resumeCalls).toBe(1);
    expect(client.lastResumeOverrides?.modeId).toBe("full-access");
    expect(client.lastResumeOverrides?.sandboxMode).toBe("danger-full-access");
  });
});
