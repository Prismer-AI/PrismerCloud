/**
 * adapter.test.ts — Unit tests for src/para/adapter.ts
 *
 * For each of the 13 §4.6.1 OpenClaw hook → PARA event mappings (or the 11
 * that are wired), we:
 *   1. Construct a mock OpenClaw hook context
 *   2. Call the corresponding adapter method
 *   3. Assert the emitted PARA event is valid (ParaEventSchema.parse succeeds)
 *   4. Assert the event has the correct `type` and mapped field values
 *
 * The 2 that are stubbed (session:compact:before, session:compact:after) are
 * tested via adapter method calls directly (the methods exist; only the hook
 * registration is stubbed in register.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ParaEventSchema } from "@prismer/wire";
import { EventDispatcher, PermissionLeaseManager } from "@prismer/adapters-core";
import type { DispatchSink } from "@prismer/adapters-core";
import type { ParaEvent } from "@prismer/wire";
import { OpenClawParaAdapter } from "../../src/para/adapter.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/para/sink.js", () => ({
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
  buildAgentDescriptor: vi.fn().mockReturnValue({
    id: "abcd1234abcd1234",
    adapter: "openclaw",
    version: "2026.4.14",
    tiersSupported: [1, 2],
    capabilityTags: ["code", "message", "channel"],
    workspace: "/workspace",
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect emitted events via a capturing sink. */
function makeCapturingSink(): { events: ParaEvent[]; sink: DispatchSink } {
  const events: ParaEvent[] = [];
  const sink: DispatchSink = (evt: ParaEvent) => {
    events.push(evt);
  };
  return { events, sink };
}

function makeAdapter(sink: DispatchSink): OpenClawParaAdapter {
  const dispatcher = new EventDispatcher(sink);
  const lease = new PermissionLeaseManager();
  return new OpenClawParaAdapter(dispatcher, lease);
}

/** Build a minimal InternalHookEvent-shaped object. */
function makeHookEvent(
  type: string,
  action: string,
  context: Record<string, unknown> = {},
  sessionKey = "session-abc",
): {
  type: string;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
} {
  return {
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenClawParaAdapter", () => {
  let events: ParaEvent[];
  let sink: DispatchSink;
  let adapter: OpenClawParaAdapter;

  beforeEach(async () => {
    const cap = makeCapturingSink();
    events = cap.events;
    sink = cap.sink;
    adapter = makeAdapter(sink);
  });

  // ── 1. gateway:startup → agent.register ───────────────────────────────────
  describe("onGatewayStartup (#1 gateway:startup → agent.register)", () => {
    it("emits a valid agent.register event", async () => {
      const event = makeHookEvent("gateway", "startup", {});
      adapter.onGatewayStartup(event as never);
      // dispatcher.emit is async — give it a tick
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0];
      expect(evt.type).toBe("agent.register");
      // Validate against schema
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });

    it("agent.register has adapter='openclaw'", async () => {
      const event = makeHookEvent("gateway", "startup", {});
      adapter.onGatewayStartup(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.register" }>;
      expect(evt.agent.adapter).toBe("openclaw");
    });
  });

  // ── 2. agent:bootstrap → agent.bootstrap.injected ─────────────────────────
  describe("onAgentBootstrap (#2 agent:bootstrap → agent.bootstrap.injected)", () => {
    it("emits a valid agent.bootstrap.injected event", async () => {
      const event = makeHookEvent("agent", "bootstrap", {
        workspaceDir: "/workspace",
        bootstrapFiles: [{ path: "/workspace/CLAUDE.md" }, { path: "/workspace/NOTES.md" }],
        agentId: "agent-xyz",
      });
      adapter.onAgentBootstrap(event as never);
      await Promise.resolve();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("agent.bootstrap.injected");
      expect(() => ParaEventSchema.parse(events[0])).not.toThrow();
    });

    it("maps bootstrapFiles paths correctly", async () => {
      const event = makeHookEvent("agent", "bootstrap", {
        workspaceDir: "/workspace",
        bootstrapFiles: [{ path: "/workspace/CLAUDE.md" }],
        agentId: "agent-xyz",
      });
      adapter.onAgentBootstrap(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.bootstrap.injected" }>;
      expect(evt.bootstrapFiles).toContain("/workspace/CLAUDE.md");
    });
  });

  // ── 3. command:new → agent.command { commandKind: 'new' } ─────────────────
  describe("onCommandNew (#3 command:new → agent.command commandKind=new)", () => {
    it("emits a valid agent.command event with commandKind=new", async () => {
      adapter.onCommandNew(makeHookEvent("command", "new"));
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0] as Extract<ParaEvent, { type: "agent.command" }>;
      expect(evt.type).toBe("agent.command");
      expect(evt.commandKind).toBe("new");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 4. command:reset → agent.command { commandKind: 'reset' } ─────────────
  describe("onCommandReset (#4 command:reset → agent.command commandKind=reset)", () => {
    it("emits agent.command with commandKind=reset", async () => {
      adapter.onCommandReset(makeHookEvent("command", "reset"));
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.command" }>;
      expect(evt.commandKind).toBe("reset");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 5. command:stop → agent.command { commandKind: 'stop' } ───────────────
  describe("onCommandStop (#5 command:stop → agent.command commandKind=stop)", () => {
    it("emits agent.command with commandKind=stop", async () => {
      adapter.onCommandStop(makeHookEvent("command", "stop"));
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.command" }>;
      expect(evt.commandKind).toBe("stop");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 6. command (general) → agent.command { commandKind: 'other' } ─────────
  describe("onCommand (#6 command → agent.command commandKind=other)", () => {
    it("emits agent.command with commandKind=other for unknown actions", async () => {
      adapter.onCommand(makeHookEvent("command", "custom-cmd", { command: "/custom" }));
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.command" }>;
      expect(evt.commandKind).toBe("other");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 7. session:compact:before → agent.compact.pre ─────────────────────────
  // Note: hook registration is TODO (not yet in OpenClaw SDK), but the adapter
  // method itself exists and is correct — tested directly.
  describe("onSessionCompactBefore (#7 session:compact:before → agent.compact.pre)", () => {
    it("emits a valid agent.compact.pre event", async () => {
      const event = makeHookEvent("session", "compact:before", {
        trigger: "auto",
        messageCount: 42,
        tokenCount: 80000,
      });
      adapter.onSessionCompactBefore(event);
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0] as Extract<ParaEvent, { type: "agent.compact.pre" }>;
      expect(evt.type).toBe("agent.compact.pre");
      expect(evt.trigger).toBe("auto");
      expect(evt.messageCount).toBe(42);
      expect(evt.tokenCount).toBe(80000);
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });

    it("defaults to trigger=auto when context.trigger is missing", async () => {
      const event = makeHookEvent("session", "compact:before", {});
      adapter.onSessionCompactBefore(event);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.compact.pre" }>;
      expect(evt.trigger).toBe("auto");
    });
  });

  // ── 8. session:compact:after → agent.compact.post ─────────────────────────
  describe("onSessionCompactAfter (#8 session:compact:after → agent.compact.post)", () => {
    it("emits a valid agent.compact.post event", async () => {
      const event = makeHookEvent("session", "compact:after", {
        compactedCount: 38,
        tokensBefore: 80000,
        tokensAfter: 12000,
      });
      adapter.onSessionCompactAfter(event);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.compact.post" }>;
      expect(evt.type).toBe("agent.compact.post");
      expect(evt.compactedCount).toBe(38);
      expect(evt.tokensBefore).toBe(80000);
      expect(evt.tokensAfter).toBe(12000);
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 9. session:patch → agent.config.changed { configSource: 'skills' } ────
  describe("onSessionPatch (#9 session:patch → agent.config.changed)", () => {
    it("emits a valid agent.config.changed event with configSource=skills", async () => {
      const event = {
        ...makeHookEvent("session", "patch", {}),
        context: {
          sessionEntry: {},
          patch: { skills: ["deploy-prod"] },
          cfg: {},
        },
      };
      adapter.onSessionPatch(event as never);
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0] as Extract<ParaEvent, { type: "agent.config.changed" }>;
      expect(evt.type).toBe("agent.config.changed");
      expect(evt.configSource).toBe("skills");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 10. message:received → agent.channel.inbound ──────────────────────────
  describe("onMessageReceived (#10 message:received → agent.channel.inbound)", () => {
    it("emits a valid agent.channel.inbound event", async () => {
      const event = makeHookEvent("message", "received", {
        from: "user123",
        content: "Hello world",
        channelId: "telegram",
      });
      adapter.onMessageReceived(event as never);
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.inbound" }>;
      expect(evt.type).toBe("agent.channel.inbound");
      expect(evt.from).toBe("user123");
      expect(evt.content).toBe("Hello world");
      expect(evt.channelId).toBe("telegram");
    });

    it("passes metadata through when ctx provides it (wire bundles zod v3 now)", async () => {
      const event = makeHookEvent("message", "received", {
        from: "u",
        content: "hi",
        channelId: "slack",
        metadata: { threadId: "thread-42", mediaType: "image" },
      });
      adapter.onMessageReceived(event as never);
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.inbound" }>;
      expect(evt.metadata).toEqual({ threadId: "thread-42", mediaType: "image" });
    });

    it("omits metadata when ctx.metadata is empty", async () => {
      const event = makeHookEvent("message", "received", {
        from: "u",
        content: "hi",
        channelId: "slack",
        metadata: {},
      });
      adapter.onMessageReceived(event as never);
      await Promise.resolve();
      expect(events.length).toBe(1);
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.inbound" }>;
      expect(evt.metadata).toBeUndefined();
    });
  });

  // ── 11. message:transcribed → agent.channel.transcribed ───────────────────
  describe("onMessageTranscribed (#11 message:transcribed → agent.channel.transcribed)", () => {
    it("emits a valid agent.channel.transcribed event", async () => {
      const event = makeHookEvent("message", "transcribed", {
        transcript: "Please book a table for two",
        from: "user456",
        channelId: "whatsapp",
        mediaPath: "/tmp/audio.ogg",
      });
      adapter.onMessageTranscribed(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.transcribed" }>;
      expect(evt.type).toBe("agent.channel.transcribed");
      expect(evt.transcript).toBe("Please book a table for two");
      expect(evt.from).toBe("user456");
      expect(evt.channelId).toBe("whatsapp");
      expect(evt.mediaPath).toBe("/tmp/audio.ogg");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });
  });

  // ── 12. message:preprocessed → agent.channel.preprocessed ────────────────
  describe("onMessagePreprocessed (#12 message:preprocessed → agent.channel.preprocessed)", () => {
    it("emits a valid agent.channel.preprocessed event", async () => {
      const event = makeHookEvent("message", "preprocessed", {
        bodyForAgent: "Enriched: https://example.com → [Title: Example Domain]",
        from: "u",
        channelId: "discord",
      });
      adapter.onMessagePreprocessed(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.preprocessed" }>;
      expect(evt.type).toBe("agent.channel.preprocessed");
      expect(evt.bodyForAgent).toContain("Enriched");
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });

    it("falls back to body when bodyForAgent is absent", async () => {
      const event = makeHookEvent("message", "preprocessed", {
        body: "raw body",
        from: "u",
        channelId: "slack",
      });
      adapter.onMessagePreprocessed(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.preprocessed" }>;
      expect(evt.bodyForAgent).toBe("raw body");
    });
  });

  // ── 13. message:sent → agent.channel.outbound.sent ────────────────────────
  describe("onMessageSent (#13 message:sent → agent.channel.outbound.sent)", () => {
    it("emits a valid agent.channel.outbound.sent event", async () => {
      const event = makeHookEvent("message", "sent", {
        to: "agent789",
        content: "Task complete!",
        channelId: "prismer",
        success: true,
      });
      adapter.onMessageSent(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.outbound.sent" }>;
      expect(evt.type).toBe("agent.channel.outbound.sent");
      expect(evt.to).toBe("agent789");
      expect(evt.success).toBe(true);
      expect(() => ParaEventSchema.parse(evt)).not.toThrow();
    });

    it("defaults success=true when not provided", async () => {
      const event = makeHookEvent("message", "sent", {
        to: "u",
        content: "hi",
        channelId: "ch",
      });
      adapter.onMessageSent(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.outbound.sent" }>;
      expect(evt.success).toBe(true);
    });

    it("passes through success=false for failed deliveries", async () => {
      const event = makeHookEvent("message", "sent", {
        to: "u",
        content: "hi",
        channelId: "ch",
        success: false,
      });
      adapter.onMessageSent(event as never);
      await Promise.resolve();
      const evt = events[0] as Extract<ParaEvent, { type: "agent.channel.outbound.sent" }>;
      expect(evt.success).toBe(false);
    });
  });

  // ── Error isolation ────────────────────────────────────────────────────────
  describe("error isolation", () => {
    it("a broken sink does not throw from onMessageReceived", async () => {
      const brokenSink: DispatchSink = () => {
        throw new Error("sink broken");
      };
      const d = new EventDispatcher(brokenSink);
      d.onError(() => { /* swallow */ });
      const a = new OpenClawParaAdapter(d, new PermissionLeaseManager());
      const event = makeHookEvent("message", "received", {
        from: "u",
        content: "hi",
        channelId: "ch",
      });
      // Should not throw
      expect(() => a.onMessageReceived(event as never)).not.toThrow();
    });
  });
});
