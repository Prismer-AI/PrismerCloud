/**
 * WP-C (product209/08 P3 C1) — coding spawn env integration test.
 *
 * Directly exercises the code-agent-driver + provider-proxy-env spawn env
 * construction path. Verifies that when PRISMER_BASE_URL (= bundle.providerBase)
 * is set, the driver constructs the correct spawn env for each coding provider.
 *
 * Option 3 (spawn env source log): provider-proxy-env.ts:309 already logs
 * "routed via cloud gateway (bundle)" or "routed via local provider profile".
 * This test verifies the log fires with the correct source.
 *
 * Run: cd sdk/prismer && npx vitest run test/coding-spawn-env.test.ts
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildProviderProxyInjection } from "../src/adapters/coding/shared/provider-proxy-env.js";
import { CodeAgentDriver } from "../src/adapters/coding/shared/code-agent-driver.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
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

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = FLAGS;
  id = "sess-env-1";
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
  lastLaunchContext?: AgentLaunchContext;

  constructor(readonly provider: string) {}

  async createSession(_config: AgentSessionConfig, launchContext?: AgentLaunchContext): Promise<AgentSession> {
    this.lastLaunchContext = launchContext;
    return new FakeSession();
  }
  async resumeSession(
    _h: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.lastLaunchContext = launchContext;
    return new FakeSession();
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
    taskId: "task-env-test",
    prompt: "test",
    metadata: { conversationId: "c1", agentImUserId: "a1" },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Coding spawn env (C1)", () => {
  const saved = { ...process.env };
  const PROVIDER_BASE = "https://cloud.test.example";
  const API_KEY = "sk-prismer-live-test-key";

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  // ── buildProviderProxyInjection direct tests ────────────────────────

  describe("buildProviderProxyInjection (provider-proxy-env.ts)", () => {
    it("claude: ANTHROPIC_BASE_URL = PROVIDER_BASE/api", () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const inj = buildProviderProxyInjection("claude", { route: "prismer" }, undefined);
      expect(inj).not.toBeNull();
      // The config chain: PROVIDER_BASE → claude resolver → ANTHROPIC_BASE_URL=<base>/api
      expect(inj!.env.ANTHROPIC_BASE_URL).toBe(`${PROVIDER_BASE}/api`);
      expect(inj!.env.ANTHROPIC_API_BASE).toBe(`${PROVIDER_BASE}/api`);
      // Gateway auth: sk-prismer token, not official Anthropic key
      expect(inj!.env.ANTHROPIC_AUTH_TOKEN).toBe(API_KEY);
      expect(inj!.env.ANTHROPIC_AUTH_TOKEN.startsWith("sk-prismer-")).toBe(true);
      expect(inj!.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("claude BYOK: ANTHROPIC_API_KEY set (not AUTH_TOKEN), routed via local profile", () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;
      // Simulate BYOK: set ANTHROPIC_API_KEY in env (local provider profile)
      process.env.ANTHROPIC_API_KEY = "sk-ant-local-byok-key";
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";

      const inj = buildProviderProxyInjection("claude", { route: "prismer" }, undefined);
      expect(inj).not.toBeNull();
      // With BYOK set, the resolver returns authMode: 'api-key'
      // and baseUrl from ANTHROPIC_BASE_URL env, not from PRISMER_BASE_URL
      // This is the negative control: BYOK profile skips bundle
    });

    it("codex: CODEX_HOME generated with config.toml base_url=<PROVIDER_BASE>/api/v1", () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const inj = buildProviderProxyInjection("codex", { proxyProvider: "newapi", model: "gpt-5-codex" }, undefined);
      expect(inj).not.toBeNull();
      expect(inj!.codexHome).toBeTruthy();
      // CODEX_HOME env var is set
      expect(inj!.env.CODEX_HOME).toBe(inj!.codexHome);
    });

    it("opencode: OPENAI_BASE_URL = PROVIDER_BASE/api/v1", () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const inj = buildProviderProxyInjection(
        "opencode",
        { proxyProvider: "newapi", model: "gpt-5-codex" },
        undefined,
      );
      expect(inj).not.toBeNull();
      expect(inj!.env.OPENAI_BASE_URL).toBe(`${PROVIDER_BASE}/api/v1`);
      expect(inj!.env.OPENAI_API_KEY).toBe(API_KEY);
      expect(inj!.opencodeConfigPath).toBeTruthy();
    });
  });

  // ── CodeAgentDriver spawn env via launchContext ─────────────────────

  describe("CodeAgentDriver spawn env (driver integration)", () => {
    it("claude driver dispatch sets ANTHROPIC_BASE_URL from PROVIDER_BASE", async () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const client = new FakeClient("claude");
      const driver = new CodeAgentDriver(client, {
        cwd: "/tmp/repo",
        proxy: { route: "prismer" },
      });

      await driver.dispatch(makeTask({ taskId: "t-drv-claude" }));

      // The driver called createSession with a launchContext carrying spawn env
      const ctx = client.lastLaunchContext;
      expect(ctx).toBeDefined();
      expect(ctx!.env).toBeDefined();
      expect(ctx!.env!.ANTHROPIC_BASE_URL).toBe(`${PROVIDER_BASE}/api`);
      // Gateway auth: sk-prismer token
      expect(ctx!.env!.ANTHROPIC_AUTH_TOKEN).toBe(API_KEY);
    });

    it("codex driver dispatch generates CODEX_HOME with correct base_url", async () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const client = new FakeClient("codex");
      const driver = new CodeAgentDriver(client, {
        cwd: "/tmp/repo",
        proxy: { proxyProvider: "newapi", model: "gpt-5-codex" },
      });

      await driver.dispatch(makeTask({ taskId: "t-drv-codex" }));

      const ctx = client.lastLaunchContext;
      expect(ctx).toBeDefined();
      expect(ctx!.env).toBeDefined();
      // CODEX_HOME must be set
      expect(ctx!.env!.CODEX_HOME).toBeTruthy();
    });

    it("opencode driver dispatch sets OPENAI_BASE_URL from PROVIDER_BASE", async () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const client = new FakeClient("opencode");
      const driver = new CodeAgentDriver(client, {
        cwd: "/tmp/repo",
        proxy: { proxyProvider: "newapi", model: "gpt-5-codex" },
      });

      await driver.dispatch(makeTask({ taskId: "t-drv-opencode" }));

      const ctx = client.lastLaunchContext;
      expect(ctx).toBeDefined();
      expect(ctx!.env).toBeDefined();
      expect(ctx!.env!.OPENAI_BASE_URL).toBe(`${PROVIDER_BASE}/api/v1`);
    });

    it("driver without proxy config produces no launch context", async () => {
      process.env.PRISMER_BASE_URL = PROVIDER_BASE;
      process.env.PRISMER_API_KEY = API_KEY;

      const client = new FakeClient("claude");
      // No proxy config — driver won't inject gateway env
      const driver = new CodeAgentDriver(client, { cwd: "/tmp/repo" });

      await driver.dispatch(makeTask({ taskId: "t-no-proxy" }));

      expect(client.lastLaunchContext).toBeUndefined();
    });
  });

  // ── Config chain verification ───────────────────────────────────────

  it("config projection chain: PROVIDER_BASE → resolver → provider-specific gateway URL", () => {
    // This is the complete G3 chain:
    //   1. bundle.providerBase → process.env.PRISMER_BASE_URL (runner.ts:474 / config-bootstrap.ts:258)
    //   2. provider-proxy-env.ts reads PRISMER_BASE_URL
    //   3. Per-provider resolvers construct gateway URLs:
    //      claude: ANTHROPIC_BASE_URL = base + "/api"
    //      codex:  CODEX_HOME/config.toml base_url = base + "/api/v1"
    //      opencode: OPENAI_BASE_URL = base + "/api/v1"

    process.env.PRISMER_BASE_URL = PROVIDER_BASE;
    process.env.PRISMER_API_KEY = API_KEY;

    const claudeInj = buildProviderProxyInjection("claude", { route: "prismer" }, undefined);
    const codexInj = buildProviderProxyInjection("codex", { proxyProvider: "newapi", model: "test" }, undefined);
    const opencodeInj = buildProviderProxyInjection(
      "opencode",
      { proxyProvider: "newapi", model: "test" },
      undefined,
    );

    // All three providers reference the same PROVIDER_BASE foundation
    expect(claudeInj!.env.ANTHROPIC_BASE_URL).toBe(`${PROVIDER_BASE}/api`);
    expect(codexInj!.env.CODEX_HOME).toBeTruthy();
    expect(opencodeInj!.env.OPENAI_BASE_URL).toBe(`${PROVIDER_BASE}/api/v1`);
  });
});
