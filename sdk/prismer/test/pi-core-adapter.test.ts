import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, StepRecorderHandle } from "../src/adapters/contract.js";
import { createPiCoreAdapter, piCoreServiceOptions } from "../src/adapters/runtime-engine/pi-core/index.js";
import { buildProviderRegistry } from "../src/adapters/coding/shared/provider-registry.js";

function makeProfile(cwd: string): AgentProfile {
  return {
    id: "profile-pi",
    workspaceId: "ws-pi",
    agentImUserId: "agent-pi",
    adapterName: "pi-core",
    name: "Pi Core",
    config: {
      cwd,
      model: "faux/faux-1",
      systemPrompt: "You are a focused test agent.",
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeRecorder(): StepRecorderHandle & {
  recordToolCall: ReturnType<typeof vi.fn>;
  recordToolResult: ReturnType<typeof vi.fn>;
} {
  return {
    recordPhaseChange: vi.fn(),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordReasoningChunk: vi.fn(),
    recordError: vi.fn(),
  };
}

describe("pi-core runtime engine adapter boundary", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHarness() {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-core-"));
    tempDirs.push(cwd);

    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core Model" }],
      tokensPerSecond: 0,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = createPiCoreAdapter({
      models,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
    });
    return { adapter, faux, cwd };
  }

  it("accepts a minimal profile config without cwd", async () => {
    const { adapter } = makeHarness();
    expect(adapter.validate({}).ok).toBe(true);
  });

  it("exposes RuntimeAgentEngine capabilities without coding harness tags", async () => {
    const { adapter } = makeHarness();
    expect(adapter.name).toBe("pi-core");
    expect(adapter.capabilities).toEqual(
      expect.arrayContaining(["runtime-engine", "pi-core", "tools", "streaming", "mcp"]),
    );
    expect(adapter.capabilities).not.toContain("code");
    expect(adapter.capabilities).not.toContain("shell");
  });

  it("uses pi-core as the only Pi Core registry identity", () => {
    const logger = pino({ enabled: false });
    const registry = buildProviderRegistry(logger);
    expect(registry["pi-core"]).toBeDefined();
    expect(registry.pi).toBeUndefined();
    expect(registry.omp).toBeUndefined();
    expect(registry["pi-core"]!.createClient(logger).provider).toBe("pi-core");
  });

  it("runtime210/09 §3.1b — service options opt pi-core into the steps channel + progress heartbeat", () => {
    // The production Path B ruling lives here: pi-core EXPLICITLY opts in, so
    // every other engine keeps the driver defaults ('off' / no heartbeat).
    const opts = piCoreServiceOptions(makeProfile("/tmp/pi"));
    expect(opts.textDeltaChannel).toBe("steps");
    expect(opts.progressHeartbeat).toBe(true);
    expect(opts.cwd).toBe("/tmp/pi");
  });

  it("loads pi-agent-core and completes a text turn through the RuntimeAgentEngine facade", async () => {
    const { adapter, faux, cwd } = makeHarness();
    faux.setResponses([fauxAssistantMessage("PI_TEXT_OK")]);

    const health = await adapter.health();
    expect(health.available).toBe(true);

    const service = await adapter.ensureService!(makeProfile(cwd));
    expect(service.id).toBe("runtime-engine:pi-core");
    const result = await service.dispatch({
      taskId: "run_pi_text",
      kind: "run",
      prompt: "Say PI_TEXT_OK.",
      metadata: { conversationId: "conv-pi", agentImUserId: "agent-pi" },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("PI_TEXT_OK");
    expect(result.metadata?.modelUsed).toBe("faux-1");
    expect(result.metadata?.providerUsed).toBe("faux");
    await service.shutdown?.();
  });

  it("writes and reads back files through Pi Core tools in the runtime cwd", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const target = join(cwd, "nested", "pi-output.txt");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "nested/pi-output.txt", content: "PI_TOOL_OK" }, { id: "write-1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("read", { path: "nested/pi-output.txt" }, { id: "read-1" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const toolResult = context.messages.findLast(
          (message): message is Extract<(typeof context.messages)[number], { role: "toolResult" }> =>
            message.role === "toolResult",
        );
        const text = toolResult?.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return fauxAssistantMessage(`PI_TOOL_DONE ${text ?? "missing-tool-result"}`);
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await service.dispatch({
      taskId: "run_pi_tool",
      kind: "run",
      prompt: "Write PI_TOOL_OK to nested/pi-output.txt, read it back, then report the read result.",
      metadata: { conversationId: "conv-pi-tool", agentImUserId: "agent-pi" },
      recorder,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("PI_TOOL_DONE");
    expect(result.output).toContain("PI_TOOL_OK");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("PI_TOOL_OK");
    expect(recorder.recordToolCall).toHaveBeenCalledWith(
      "write",
      { type: "write", filePath: "nested/pi-output.txt", content: "PI_TOOL_OK" },
      "write-1",
      {
        detail: { type: "write", filePath: "nested/pi-output.txt", content: "PI_TOOL_OK" },
        status: "running",
      },
    );
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "write-1",
      { type: "write", filePath: "nested/pi-output.txt", content: "PI_TOOL_OK" },
      {
        detail: { type: "write", filePath: "nested/pi-output.txt", content: "PI_TOOL_OK" },
        status: "completed",
      },
    );
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "read-1",
      { type: "read", filePath: "nested/pi-output.txt", content: "PI_TOOL_OK" },
      {
        detail: { type: "read", filePath: "nested/pi-output.txt", content: "PI_TOOL_OK" },
        status: "completed",
      },
    );
    await service.shutdown?.();
  });

  it("runtime210/09 §2.3 — the materialized task workdir is the session jail cwd, not the profile cwd", async () => {
    const { adapter, faux, cwd: profileCwd } = makeHarness();
    // The "materialized workdir" dispatch.ts stamps onto
    // task.metadata.prismerScratchDir after ensureWorkdir — a DIFFERENT dir
    // from the profile cwd. The pi-core session jail must bind IT (the repo
    // the user is working), not the profile default — otherwise FS tools
    // operate on the wrong tree while the dispatch claims the workdir.
    const workdir = mkdtempSync(join(tmpdir(), "prismer-pi-workdir-"));
    tempDirs.push(workdir);
    const target = join(workdir, "nested", "jail-output.txt");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "nested/jail-output.txt", content: "PI_WORKDIR_OK" }, { id: "wd-1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("PI_WORKDIR_DONE"),
    ]);

    const service = await adapter.ensureService!(makeProfile(profileCwd));
    const result = await service.dispatch({
      taskId: "run_pi_workdir",
      kind: "run",
      prompt: "Write PI_WORKDIR_OK to nested/jail-output.txt.",
      metadata: {
        conversationId: "conv-pi-workdir",
        agentImUserId: "agent-pi",
        // dispatch.ts stamps prismerWorkdirOverride ONLY when a workdir spec
        // was materialized (09 §2.3); prismerScratchDir doubles as the legacy
        // per-task scratch and must NOT hijack the pi-core jail (probe PARTIAL
        // root cause, now closed — scratch-only falls back to the profile cwd).
        prismerWorkdirOverride: workdir,
        prismerScratchDir: join(profileCwd, "per-task-scratch"),
      },
    });

    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("PI_WORKDIR_OK");
    // Negative control: the write must NOT have landed in the profile cwd —
    // the jail is bound to the materialized workdir.
    expect(existsSync(join(profileCwd, "nested", "jail-output.txt"))).toBe(false);
    await service.shutdown?.();
  });

  it("runtime210 review P3 — gateway build log fires once per (provider × model × wire), not per createSession", async () => {
    // No injected models: the client must build the gateway models itself
    // (createDefaultModels), which is where the per-session log used to fire.
    const adapter = createPiCoreAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-gwlog-"));
    tempDirs.push(cwd);
    process.env.PRISMER_PI_BASE_URL = "https://test.docbrew.cn/api/v1";
    process.env.PRISMER_PI_API_KEY = "sk-prismer-test-abc123";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Two services → two sessions (listCommands warms one each) → the
      // gateway build log must appear ONCE, not per createSession.
      const service1 = await adapter.ensureService!(makeProfile(cwd));
      await service1.listCommands();
      const service2 = await adapter.ensureService!(makeProfile(cwd));
      await service2.listCommands();

      const gatewayLines = logSpy.mock.calls.filter((call) =>
        String(call[0]).startsWith("[pi-core] gateway provider="),
      );
      expect(gatewayLines).toHaveLength(1);
      await service1.shutdown?.();
      await service2.shutdown?.();
    } finally {
      logSpy.mockRestore();
      delete process.env.PRISMER_PI_BASE_URL;
      delete process.env.PRISMER_PI_API_KEY;
    }
  });

  it("keeps Pi Core filesystem tools jailed to the runtime cwd", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const outside = join(cwd, "..", `${basename(cwd)}-outside.txt`);
    tempDirs.push(outside);
    const escapePath = `../${basename(outside)}`;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: escapePath, content: "PI_ESCAPE_SHOULD_NOT_EXIST" }, { id: "escape-1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("PI_ESCAPE_ATTEMPT_DONE"),
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await service.dispatch({
      taskId: "run_pi_escape",
      kind: "run",
      prompt: `Attempt to write outside cwd at ${escapePath}.`,
      metadata: { conversationId: "conv-pi-escape", agentImUserId: "agent-pi" },
      recorder,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("PI_ESCAPE_ATTEMPT_DONE");
    expect(existsSync(outside)).toBe(false);
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "escape-1",
      { type: "write", filePath: escapePath, content: "PI_ESCAPE_SHOULD_NOT_EXIST" },
      {
        detail: { type: "write", filePath: escapePath, content: "PI_ESCAPE_SHOULD_NOT_EXIST" },
        status: "failed",
      },
    );
    await service.shutdown?.();
  });
});
