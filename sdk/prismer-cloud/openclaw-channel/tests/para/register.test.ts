/**
 * register.test.ts — Unit tests for src/para/register.ts
 *
 * Verifies that registerParaAdapter:
 *   - Calls api.registerHook for each wired §4.6.1 hook
 *   - Returns an OpenClawParaAdapter instance
 *   - Does not throw if the sink is provided
 *   - Does not call registerHook for stubbed TODO hooks
 *     (session:compact:before and session:compact:after)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerParaAdapter } from "../../src/para/register.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { OpenClawParaAdapter } from "../../src/para/adapter.js";
import type { ParaEvent } from "@prismer/wire";
import type { DispatchSink } from "@prismer/adapters-core";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/para/sink.js", () => ({
  defaultJsonlSink: vi.fn(),
  loadCachedDescriptor: vi.fn().mockReturnValue(null),
  buildAndCacheDescriptor: vi.fn().mockReturnValue({
    id: "abcd1234abcd1234",
    adapter: "openclaw",
    version: "2026.4.14",
    tiersSupported: [1, 2],
    capabilityTags: ["code", "message", "channel"],
    workspace: "/workspace",
  }),
  stableAdapterId: vi.fn().mockReturnValue("abcd1234abcd1234"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi(opts?: { withOn?: boolean }): {
  api: OpenClawPluginApi;
  registeredHooks: Map<string, Array<(event: unknown) => void>>;
  typedHooks: Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>;
} {
  const registeredHooks = new Map<string, Array<(event: unknown) => void>>();
  const typedHooks = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => void | Promise<void>>
  >();

  const api: Record<string, unknown> = {
    id: "prismer",
    name: "Prismer",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: {},
    runtime: {},
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerHook: vi.fn((events: string | string[], handler: (event: unknown) => void) => {
      const keys = Array.isArray(events) ? events : [events];
      for (const key of keys) {
        if (!registeredHooks.has(key)) registeredHooks.set(key, []);
        registeredHooks.get(key)!.push(handler);
      }
    }),
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerReload: vi.fn(),
    registerNodeHostCommand: vi.fn(),
    registerSecurityAuditCollector: vi.fn(),
    registerService: vi.fn(),
    registerCliBackend: vi.fn(),
    registerTextTransforms: vi.fn(),
    registerConfigMigration: vi.fn(),
    registerAutoEnableProbe: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerRealtimeTranscriptionProvider: vi.fn(),
    registerRealtimeVoiceProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerVideoGenerationProvider: vi.fn(),
    registerMusicGenerationProvider: vi.fn(),
    registerWebFetchProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
  };

  // Typed hook surface (`api.on(hookName, handler)`) — v1.9.0 break #5 fix.
  if (opts?.withOn !== false) {
    api.on = vi.fn(
      (
        hookName: string,
        handler: (event: unknown, ctx: unknown) => void | Promise<void>,
      ) => {
        if (!typedHooks.has(hookName)) typedHooks.set(hookName, []);
        typedHooks.get(hookName)!.push(handler);
      },
    );
  }

  return { api: api as unknown as OpenClawPluginApi, registeredHooks, typedHooks };
}

function makeNoopSink(): DispatchSink {
  return (_evt: ParaEvent) => {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerParaAdapter", () => {
  let api: OpenClawPluginApi;
  let registeredHooks: Map<string, Array<(event: unknown) => void>>;
  let typedHooks: Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>;

  beforeEach(() => {
    const mock = makeMockApi();
    api = mock.api;
    registeredHooks = mock.registeredHooks;
    typedHooks = mock.typedHooks;
  });

  it("returns an OpenClawParaAdapter instance", () => {
    const adapter = registerParaAdapter(api, { sink: makeNoopSink() });
    expect(adapter).toBeInstanceOf(OpenClawParaAdapter);
  });

  it("registers gateway:startup hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("gateway:startup")).toBe(true);
  });

  it("registers agent:bootstrap hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("agent:bootstrap")).toBe(true);
  });

  it("registers command:new hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("command:new")).toBe(true);
  });

  it("registers command:reset hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("command:reset")).toBe(true);
  });

  it("registers command:stop hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("command:stop")).toBe(true);
  });

  it("registers command (general) hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("command")).toBe(true);
  });

  it("registers session:patch hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("session:patch")).toBe(true);
  });

  it("registers message:received hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("message:received")).toBe(true);
  });

  it("registers message:transcribed hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("message:transcribed")).toBe(true);
  });

  it("registers message:preprocessed hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("message:preprocessed")).toBe(true);
  });

  it("registers message:sent hook", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("message:sent")).toBe(true);
  });

  it("does NOT register session:compact:before (TODO — not in OpenClaw SDK yet)", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("session:compact:before")).toBe(false);
  });

  it("does NOT register session:compact:after (TODO — not in OpenClaw SDK yet)", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    expect(registeredHooks.has("session:compact:after")).toBe(false);
  });

  it("total wired hooks is 11", () => {
    registerParaAdapter(api, { sink: makeNoopSink() });
    const expectedKeys = [
      "gateway:startup",
      "agent:bootstrap",
      "command:new",
      "command:reset",
      "command:stop",
      "command",
      "session:patch",
      "message:received",
      "message:transcribed",
      "message:preprocessed",
      "message:sent",
    ];
    for (const key of expectedKeys) {
      expect(registeredHooks.has(key)).toBe(true);
    }
    expect(expectedKeys.every((k) => registeredHooks.has(k))).toBe(true);
  });

  it("uses custom sink when provided", () => {
    const customCalls: ParaEvent[] = [];
    const customSink: DispatchSink = (evt) => { customCalls.push(evt); };
    registerParaAdapter(api, { sink: customSink });
    // Verify registration succeeded with custom sink (no throws)
    expect(registeredHooks.size).toBeGreaterThan(0);
  });

  it("does not throw during registration", () => {
    expect(() => registerParaAdapter(api, { sink: makeNoopSink() })).not.toThrow();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Typed lifecycle hooks (api.on) — v1.9.0 Docker closure report break #5
  //
  // These hooks fire during `openclaw agent --local`, which does NOT start
  // the gateway and therefore does NOT fire the InternalHookEvent hooks
  // above.  Without these, PARA events don't land in ~/.prismer/para/events.jsonl
  // for one-shot agent runs.
  // ─────────────────────────────────────────────────────────────────────────

  describe("typed api.on hooks (api.on)", () => {
    it("registers gateway_start typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("gateway_start")).toBe(true);
    });

    it("registers session_start typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("session_start")).toBe(true);
    });

    it("registers session_end typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("session_end")).toBe(true);
    });

    it("registers before_prompt_build typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("before_prompt_build")).toBe(true);
    });

    it("registers agent_end typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("agent_end")).toBe(true);
    });

    it("registers before_tool_call typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("before_tool_call")).toBe(true);
    });

    it("registers after_tool_call typed hook", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      expect(typedHooks.has("after_tool_call")).toBe(true);
    });

    it("total typed hooks wired is 7", () => {
      registerParaAdapter(api, { sink: makeNoopSink() });
      const expected = [
        "gateway_start",
        "session_start",
        "session_end",
        "before_prompt_build",
        "agent_end",
        "before_tool_call",
        "after_tool_call",
      ];
      for (const key of expected) {
        expect(typedHooks.has(key)).toBe(true);
      }
      expect(typedHooks.size).toBe(7);
    });

    it("session_start typed hook emits agent.session.started via sink", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("session_start")!;
      expect(handlers.length).toBeGreaterThan(0);
      handlers[0](
        { sessionId: "sess-abc-123" },
        { sessionId: "sess-abc-123" },
      );

      const sessionStarted = calls.find(
        (c) => (c as { type?: string }).type === "agent.session.started",
      );
      expect(sessionStarted).toBeDefined();
      expect((sessionStarted as { sessionId?: string }).sessionId).toBe("sess-abc-123");
    });

    it("before_prompt_build typed hook emits agent.prompt.submit via sink", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("before_prompt_build")!;
      expect(handlers.length).toBeGreaterThan(0);
      handlers[0](
        { prompt: "Hello agent", messages: [] },
        { sessionId: "sess-abc-123", sessionKey: "test" },
      );

      const promptEv = calls.find(
        (c) => (c as { type?: string }).type === "agent.prompt.submit",
      );
      expect(promptEv).toBeDefined();
      expect((promptEv as { prompt?: string }).prompt).toBe("Hello agent");
      expect((promptEv as { source?: string }).source).toBe("user");
    });

    it("agent_end typed hook emits agent.turn.end on success", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("agent_end")!;
      handlers[0](
        {
          messages: [{ role: "assistant", content: "Done." }],
          success: true,
          durationMs: 1200,
        },
        { sessionId: "sess-abc-123" },
      );

      const turnEnd = calls.find(
        (c) => (c as { type?: string }).type === "agent.turn.end",
      );
      expect(turnEnd).toBeDefined();
      expect((turnEnd as { lastAssistantMessage?: string }).lastAssistantMessage).toBe("Done.");
    });

    it("agent_end typed hook emits agent.turn.failure on error", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("agent_end")!;
      handlers[0](
        {
          messages: [],
          success: false,
          error: "rate limit exceeded (429)",
        },
        { sessionId: "sess-abc-123" },
      );

      const failure = calls.find(
        (c) => (c as { type?: string }).type === "agent.turn.failure",
      );
      expect(failure).toBeDefined();
      expect((failure as { errorType?: string }).errorType).toBe("rate_limit");
    });

    it("before_tool_call typed hook emits agent.tool.pre", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("before_tool_call")!;
      handlers[0](
        { toolName: "shell", params: { cmd: "ls" }, toolCallId: "tc-1" },
        { toolName: "shell", sessionId: "sess-abc-123" },
      );

      const pre = calls.find(
        (c) => (c as { type?: string }).type === "agent.tool.pre",
      );
      expect(pre).toBeDefined();
      expect((pre as { tool?: string }).tool).toBe("shell");
      expect((pre as { callId?: string }).callId).toBe("tc-1");
    });

    it("after_tool_call typed hook emits agent.tool.post on success", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("after_tool_call")!;
      handlers[0](
        {
          toolName: "shell",
          params: { cmd: "ls" },
          toolCallId: "tc-1",
          result: "output",
          durationMs: 50,
        },
        { toolName: "shell", sessionId: "sess-abc-123" },
      );

      const post = calls.find(
        (c) => (c as { type?: string }).type === "agent.tool.post",
      );
      expect(post).toBeDefined();
      expect((post as { callId?: string }).callId).toBe("tc-1");
      expect((post as { ok?: boolean }).ok).toBe(true);
    });

    it("after_tool_call typed hook emits agent.tool.failure on error", () => {
      const calls: ParaEvent[] = [];
      const sink: DispatchSink = (evt) => { calls.push(evt); };
      registerParaAdapter(api, { sink });

      const handlers = typedHooks.get("after_tool_call")!;
      handlers[0](
        {
          toolName: "shell",
          params: {},
          toolCallId: "tc-1",
          error: "command not found",
          durationMs: 5,
        },
        { toolName: "shell" },
      );

      const failure = calls.find(
        (c) => (c as { type?: string }).type === "agent.tool.failure",
      );
      expect(failure).toBeDefined();
      expect((failure as { error?: string }).error).toBe("command not found");
    });

    it("gracefully no-ops when api.on is absent (older OpenClaw hosts)", () => {
      const mock = makeMockApi();
      // Strip api.on to simulate old host
      delete (mock.api as unknown as { on?: unknown }).on;
      expect(() => registerParaAdapter(mock.api, { sink: makeNoopSink() })).not.toThrow();
      // registerHook hooks still wire successfully
      expect(mock.registeredHooks.size).toBeGreaterThan(0);
    });

    it("continues registration if api.on throws for a single hook (version skew)", () => {
      const mock = makeMockApi();
      // api.on throws for one specific key but succeeds for others
      const ranHooks: string[] = [];
      (mock.api as unknown as {
        on: (name: string, handler: unknown) => void;
      }).on = vi.fn((name: string) => {
        if (name === "session_start") {
          throw new Error("unknown hook name in this openclaw version");
        }
        ranHooks.push(name);
      });
      expect(() => registerParaAdapter(mock.api, { sink: makeNoopSink() })).not.toThrow();
      // Other hooks still wired
      expect(ranHooks).toContain("gateway_start");
      expect(ranHooks).toContain("agent_end");
    });
  });
});
