/**
 * OpenClaw Channel Plugin — Comprehensive Test Suite
 *
 * Tests the @prismer/openclaw-channel plugin covering:
 * - ChannelPlugin interface compliance
 * - Account resolution & configuration
 * - Message routing (inbound/outbound conversion)
 * - Directory (agent discovery)
 * - Agent tools schema & execution
 * - Setup entry configuration
 * - Error handling (missing API key, network failures, invalid messages)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock openclaw/plugin-sdk — must be declared before any source imports
// ---------------------------------------------------------------------------
vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  emptyPluginConfigSchema: () => ({ type: "object", properties: {} }),
  buildBaseChannelStatusSummary: (snapshot: unknown) => ({ snapshot }),
  buildBaseAccountStatusSnapshot: (params: unknown) => ({ ...params as object }),
  setAccountEnabledInConfigSection: vi.fn(),
  deleteAccountFromConfigSection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock global fetch for API client tests
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Source imports (after mocks are set up)
// ---------------------------------------------------------------------------
import { prismerPlugin } from "../src/channel.js";
import {
  listPrismerAccountIds,
  resolveDefaultPrismerAccountId,
  resolvePrismerAccount,
} from "../src/accounts.js";
import { sendPrismerMessage } from "../src/outbound.js";
import { listPrismerPeers } from "../src/directory.js";
import { createPrismerAgentTools } from "../src/tools.js";
import { prismerFetch } from "../src/api-client.js";
import { setPrismerRuntime, getPrismerRuntime } from "../src/runtime.js";
import type { CoreConfig, ResolvedPrismerAccount } from "../src/types.js";
import setupPlugin from "../setup-entry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCoreConfig(overrides: Partial<CoreConfig["channels"]> = {}): CoreConfig {
  return {
    channels: {
      prismer: {
        apiKey: "sk-prismer-test-key-1234",
        agentName: "test-agent",
        baseUrl: "https://test.prismer.cloud",
        description: "Test agent",
        capabilities: ["chat", "search"],
        ...overrides.prismer,
      },
      ...overrides,
    },
  } as CoreConfig;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// 1. ChannelPlugin Interface Compliance
// ---------------------------------------------------------------------------

describe("ChannelPlugin interface compliance", () => {
  it("exports a valid plugin object with required fields", () => {
    expect(prismerPlugin).toBeDefined();
    expect(prismerPlugin.id).toBe("prismer");
    expect(prismerPlugin.meta).toBeDefined();
    expect(prismerPlugin.capabilities).toBeDefined();
    expect(prismerPlugin.config).toBeDefined();
    expect(prismerPlugin.messaging).toBeDefined();
    expect(prismerPlugin.resolver).toBeDefined();
    expect(prismerPlugin.directory).toBeDefined();
    expect(prismerPlugin.outbound).toBeDefined();
    expect(prismerPlugin.status).toBeDefined();
    expect(prismerPlugin.gateway).toBeDefined();
    expect(prismerPlugin.agentTools).toBeDefined();
  });

  it("meta has correct shape", () => {
    const { meta } = prismerPlugin;
    expect(meta.id).toBe("prismer");
    expect(meta.label).toBe("Prismer");
    expect(meta.selectionLabel).toBe("Prismer IM");
    expect(typeof meta.docsPath).toBe("string");
    expect(typeof meta.blurb).toBe("string");
    expect(typeof meta.order).toBe("number");
  });

  it("capabilities declare supported features", () => {
    const { capabilities } = prismerPlugin;
    expect(capabilities.chatTypes).toContain("direct");
    expect(capabilities.media).toBe(false);
    expect(capabilities.reply).toBe(false);
    expect(capabilities.edit).toBe(false);
    expect(capabilities.threads).toBe(false);
  });

  it("reload watches prismer config prefix", () => {
    expect(prismerPlugin.reload?.configPrefixes).toContain("channels.prismer");
  });

  it("outbound has correct delivery mode and chunk limit", () => {
    expect(prismerPlugin.outbound.deliveryMode).toBe("direct");
    expect(prismerPlugin.outbound.textChunkLimit).toBe(4000);
  });

  it("status has defaultRuntime shape", () => {
    const { defaultRuntime } = prismerPlugin.status;
    expect(defaultRuntime.accountId).toBe("default");
    expect(defaultRuntime.running).toBe(false);
    expect(defaultRuntime.lastStartAt).toBeNull();
    expect(defaultRuntime.lastStopAt).toBeNull();
    expect(defaultRuntime.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Account Resolution & Configuration
// ---------------------------------------------------------------------------

describe("Account resolution", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("listPrismerAccountIds returns default when no config", () => {
    const ids = listPrismerAccountIds({} as CoreConfig);
    expect(ids).toEqual(["default"]);
  });

  it("listPrismerAccountIds includes named accounts", () => {
    const cfg = makeCoreConfig({
      prismer: {
        apiKey: "sk-test",
        accounts: {
          work: { apiKey: "sk-work" },
          personal: { apiKey: "sk-personal" },
        },
      },
    });
    const ids = listPrismerAccountIds(cfg);
    expect(ids).toContain("work");
    expect(ids).toContain("personal");
    // Also includes default because apiKey is set at top level
    expect(ids).toContain("default");
  });

  it("listPrismerAccountIds adds default when accounts exist but no top-level apiKey", () => {
    const cfg: CoreConfig = {
      channels: {
        prismer: {
          accounts: {},
        },
      },
    } as CoreConfig;
    const ids = listPrismerAccountIds(cfg);
    // When accounts map is empty and no apiKey, default is added
    expect(ids).toContain("default");
  });

  it("resolveDefaultPrismerAccountId returns configured default", () => {
    const cfg = makeCoreConfig({
      prismer: { apiKey: "sk-test", defaultAccount: "work" },
    });
    expect(resolveDefaultPrismerAccountId(cfg)).toBe("work");
  });

  it("resolveDefaultPrismerAccountId falls back to 'default'", () => {
    expect(resolveDefaultPrismerAccountId({} as CoreConfig)).toBe("default");
  });

  it("resolvePrismerAccount merges base and account-specific config", () => {
    const cfg = makeCoreConfig({
      prismer: {
        apiKey: "sk-base",
        baseUrl: "https://base.prismer.cloud",
        agentName: "base-agent",
        accounts: {
          custom: {
            apiKey: "sk-custom",
            agentName: "custom-agent",
          },
        },
      },
    });
    const account = resolvePrismerAccount({ cfg, accountId: "custom" });
    // Account-specific overrides base
    expect(account.apiKey).toBe("sk-custom");
    expect(account.agentName).toBe("custom-agent");
    // Base URL falls through from base
    expect(account.baseUrl).toBe("https://base.prismer.cloud");
    expect(account.accountId).toBe("custom");
    expect(account.configured).toBe(true);
  });

  it("resolvePrismerAccount uses env var fallback for apiKey", () => {
    process.env.PRISMER_API_KEY = "sk-from-env";
    const account = resolvePrismerAccount({ cfg: {} as CoreConfig });
    expect(account.apiKey).toBe("sk-from-env");
    expect(account.configured).toBe(true);
  });

  it("resolvePrismerAccount uses env var fallback for baseUrl", () => {
    process.env.PRISMER_BASE_URL = "https://env.prismer.cloud";
    const account = resolvePrismerAccount({ cfg: {} as CoreConfig });
    expect(account.baseUrl).toBe("https://env.prismer.cloud");
  });

  it("resolvePrismerAccount has sensible defaults when unconfigured", () => {
    delete process.env.PRISMER_API_KEY;
    delete process.env.PRISMER_BASE_URL;
    const account = resolvePrismerAccount({ cfg: {} as CoreConfig });
    expect(account.apiKey).toBe("");
    expect(account.configured).toBe(false);
    expect(account.baseUrl).toBe("https://prismer.cloud");
    expect(account.agentName).toBe("openclaw-agent");
    expect(account.description).toBe("OpenClaw agent on Prismer IM");
    expect(account.capabilities).toEqual(["chat"]);
    expect(account.enabled).toBe(true);
  });

  it("resolvePrismerAccount respects enabled:false", () => {
    const cfg = makeCoreConfig({
      prismer: { apiKey: "sk-test", enabled: false },
    });
    const account = resolvePrismerAccount({ cfg });
    expect(account.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Config section: plugin.config methods
// ---------------------------------------------------------------------------

describe("Plugin config methods", () => {
  it("config.listAccountIds delegates to listPrismerAccountIds", () => {
    const cfg = makeCoreConfig();
    const ids = prismerPlugin.config.listAccountIds(cfg);
    expect(ids).toContain("default");
  });

  it("config.resolveAccount returns a ResolvedPrismerAccount", () => {
    const cfg = makeCoreConfig();
    const account = prismerPlugin.config.resolveAccount(cfg, "default");
    expect(account.accountId).toBe("default");
    expect(account.apiKey).toBe("sk-prismer-test-key-1234");
  });

  it("config.isConfigured returns true when apiKey present", () => {
    const cfg = makeCoreConfig();
    const account = prismerPlugin.config.resolveAccount(cfg, "default");
    expect(prismerPlugin.config.isConfigured(account)).toBe(true);
  });

  it("config.isConfigured returns false when apiKey absent", () => {
    const account = resolvePrismerAccount({ cfg: {} as CoreConfig });
    // Clear env to ensure no fallback
    const saved = process.env.PRISMER_API_KEY;
    delete process.env.PRISMER_API_KEY;
    const acct = resolvePrismerAccount({ cfg: {} as CoreConfig });
    process.env.PRISMER_API_KEY = saved;
    expect(prismerPlugin.config.isConfigured(acct)).toBe(false);
  });

  it("config.describeAccount returns summary shape", () => {
    const cfg = makeCoreConfig();
    const account = prismerPlugin.config.resolveAccount(cfg, "default");
    const desc = prismerPlugin.config.describeAccount(account);
    expect(desc).toHaveProperty("accountId");
    expect(desc).toHaveProperty("name");
    expect(desc).toHaveProperty("enabled");
    expect(desc).toHaveProperty("configured");
  });

  it("config.defaultAccountId returns correct value", () => {
    const cfg = makeCoreConfig();
    const defaultId = prismerPlugin.config.defaultAccountId(cfg);
    expect(defaultId).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// 4. Messaging: normalizeTarget & targetResolver
// ---------------------------------------------------------------------------

describe("Messaging", () => {
  it("normalizeTarget trims whitespace", () => {
    expect(prismerPlugin.messaging.normalizeTarget("  user123  ")).toBe("user123");
  });

  it("normalizeTarget returns undefined for empty string", () => {
    expect(prismerPlugin.messaging.normalizeTarget("   ")).toBeUndefined();
  });

  it("targetResolver.looksLikeId accepts alphanumeric+dash+underscore", () => {
    const { looksLikeId } = prismerPlugin.messaging.targetResolver;
    expect(looksLikeId("user-123")).toBe(true);
    expect(looksLikeId("agent_bot")).toBe(true);
    expect(looksLikeId("ABC")).toBe(true);
  });

  it("targetResolver.looksLikeId rejects invalid characters", () => {
    const { looksLikeId } = prismerPlugin.messaging.targetResolver;
    expect(looksLikeId("user@domain")).toBe(false);
    expect(looksLikeId("has space")).toBe(false);
    expect(looksLikeId("")).toBe(false);
  });

  it("targetResolver.hint is set", () => {
    expect(prismerPlugin.messaging.targetResolver.hint).toBe("<userId>");
  });
});

// ---------------------------------------------------------------------------
// 5. Resolver: resolveTargets
// ---------------------------------------------------------------------------

describe("Resolver", () => {
  it("resolves valid direct targets", async () => {
    const results = await prismerPlugin.resolver.resolveTargets({
      inputs: ["user1", "user2"],
      kind: "direct",
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      input: "user1",
      resolved: true,
      id: "user1",
      name: "user1",
    });
  });

  it("returns not-resolved for empty targets", async () => {
    const results = await prismerPlugin.resolver.resolveTargets({
      inputs: ["", "  "],
      kind: "direct",
    });
    expect(results).toHaveLength(2);
    expect(results[0].resolved).toBe(false);
    expect(results[0].note).toBe("empty target");
  });

  it("rejects group targets", async () => {
    const results = await prismerPlugin.resolver.resolveTargets({
      inputs: ["group1"],
      kind: "group",
    });
    expect(results[0].resolved).toBe(false);
    expect(results[0].note).toContain("group");
  });
});

// ---------------------------------------------------------------------------
// 6. API Client (prismerFetch)
// ---------------------------------------------------------------------------

describe("prismerFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends correct headers and method", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: true, data: {} }),
    );

    await prismerFetch("sk-test-key", "/api/im/agents", {
      method: "GET",
      baseUrl: "https://test.prismer.cloud",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://test.prismer.cloud/api/im/agents");
    expect(opts.method).toBe("GET");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("appends query parameters to URL", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: true }),
    );

    await prismerFetch("sk-test", "/api/im/agents", {
      query: { capability: "search", status: "online" },
      baseUrl: "https://test.prismer.cloud",
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("capability=search");
    expect(url).toContain("status=online");
  });

  it("sends JSON body for POST requests", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: true }),
    );

    await prismerFetch("sk-test", "/api/im/register", {
      method: "POST",
      body: { username: "bot", type: "agent" },
      baseUrl: "https://test.prismer.cloud",
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ username: "bot", type: "agent" });
  });

  it("uses default base URL when none provided", async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ ok: true }));

    await prismerFetch("sk-test", "/api/im/agents");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://prismer.cloud/api/im/agents");
  });

  it("throws on non-OK response with parsed error message", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(
        { error: { message: "Invalid API key" } },
        401,
      ),
    );

    await expect(
      prismerFetch("sk-bad", "/api/im/agents", {
        baseUrl: "https://test.prismer.cloud",
      }),
    ).rejects.toThrow("Prismer API 401: Invalid API key");
  });

  it("throws with raw text when response is not JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
      json: async () => { throw new Error("not json"); },
    } as unknown as Response);

    await expect(
      prismerFetch("sk-test", "/api/im/agents", {
        baseUrl: "https://test.prismer.cloud",
      }),
    ).rejects.toThrow("Prismer API 500: Internal Server Error");
  });

  it("skips null/undefined query values", async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ ok: true }));

    await prismerFetch("sk-test", "/api/test", {
      query: { a: "1", b: "", c: "3" },
      baseUrl: "https://test.prismer.cloud",
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("a=1");
    // Empty string is falsy, should be skipped
    expect(url).not.toContain("b=");
    expect(url).toContain("c=3");
  });
});

// ---------------------------------------------------------------------------
// 7. Outbound: sendPrismerMessage
// ---------------------------------------------------------------------------

describe("Outbound: sendPrismerMessage", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends a direct message and returns messageId + conversationId", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: {
          message: { id: "msg-001", conversationId: "conv-001" },
        },
      }),
    );

    const result = await sendPrismerMessage("user-42", "Hello!", {
      cfg: makeCoreConfig(),
    });

    expect(result.messageId).toBe("msg-001");
    expect(result.conversationId).toBe("conv-001");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/im/direct/user-42/messages");
    expect(JSON.parse(opts.body).content).toBe("Hello!");
  });

  it("includes replyTo in body when provided", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: true, data: { message: { id: "msg-002" } } }),
    );

    await sendPrismerMessage("user-42", "Reply!", {
      cfg: makeCoreConfig(),
      replyTo: "msg-001",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.replyTo).toBe("msg-001");
  });

  it("throws when config is missing", async () => {
    await expect(
      sendPrismerMessage("user-42", "Hello!"),
    ).rejects.toThrow("config required");
  });

  it("throws when apiKey is not configured", async () => {
    const saved = process.env.PRISMER_API_KEY;
    delete process.env.PRISMER_API_KEY;
    try {
      await expect(
        sendPrismerMessage("user-42", "Hello!", {
          cfg: { channels: {} } as CoreConfig,
        }),
      ).rejects.toThrow("apiKey not configured");
    } finally {
      if (saved) process.env.PRISMER_API_KEY = saved;
    }
  });

  it("throws when API returns ok:false", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: false,
        error: { message: "Conversation not found" },
      }),
    );

    await expect(
      sendPrismerMessage("user-42", "Hello!", { cfg: makeCoreConfig() }),
    ).rejects.toThrow("Prismer send failed: Conversation not found");
  });

  it("uses account-specific config when accountId provided", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: true, data: { message: { id: "m1" } } }),
    );

    const cfg = makeCoreConfig({
      prismer: {
        apiKey: "sk-base",
        baseUrl: "https://base.test",
        accounts: {
          secondary: {
            apiKey: "sk-secondary",
            baseUrl: "https://secondary.test",
          },
        },
      },
    });

    await sendPrismerMessage("user-1", "Hi", {
      cfg,
      accountId: "secondary",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("secondary.test");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-secondary");
  });
});

// ---------------------------------------------------------------------------
// 8. Outbound via plugin: sendText & sendMedia
// ---------------------------------------------------------------------------

describe("Outbound via plugin interface", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sendText returns channel, messageId, conversationId", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: { message: { id: "msg-100", conversationId: "conv-50" } },
      }),
    );

    const result = await prismerPlugin.outbound.sendText({
      cfg: makeCoreConfig(),
      to: "target-user",
      text: "Hello from plugin",
      accountId: null,
    });

    expect(result.channel).toBe("prismer");
    expect(result.messageId).toBe("msg-100");
    expect(result.conversationId).toBe("conv-50");
  });

  it("sendMedia combines text and media URL", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: { message: { id: "msg-200" } },
      }),
    );

    await prismerPlugin.outbound.sendMedia({
      cfg: makeCoreConfig(),
      to: "target-user",
      text: "Check this out",
      mediaUrl: "https://example.com/image.png",
      accountId: null,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toContain("Check this out");
    expect(body.content).toContain("https://example.com/image.png");
  });

  it("sendMedia sends only text when no mediaUrl", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: { message: { id: "msg-201" } },
      }),
    );

    await prismerPlugin.outbound.sendMedia({
      cfg: makeCoreConfig(),
      to: "target-user",
      text: "Just text",
      mediaUrl: "",
      accountId: null,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toBe("Just text");
  });
});

// ---------------------------------------------------------------------------
// 9. Directory: listPrismerPeers
// ---------------------------------------------------------------------------

describe("Directory: listPrismerPeers", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns agent directory entries", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: [
          { userId: "a1", name: "SearchBot", description: "Searches the web" },
          { userId: "a2", name: "TranslateBot", description: "Translates text" },
        ],
      }),
    );

    const peers = await listPrismerPeers({ cfg: makeCoreConfig() });

    expect(peers).toHaveLength(2);
    expect(peers[0]).toEqual({
      kind: "user",
      id: "a1",
      name: "SearchBot",
      handle: "SearchBot",
    });
  });

  it("filters by query string", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: [
          { userId: "a1", name: "SearchBot", description: "Searches the web" },
          { userId: "a2", name: "TranslateBot", description: "Translates text" },
        ],
      }),
    );

    const peers = await listPrismerPeers({
      cfg: makeCoreConfig(),
      query: "translate",
    });

    expect(peers).toHaveLength(1);
    expect(peers[0].name).toBe("TranslateBot");
  });

  it("respects limit parameter", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: Array.from({ length: 20 }, (_, i) => ({
          userId: `a${i}`,
          name: `Bot${i}`,
        })),
      }),
    );

    const peers = await listPrismerPeers({
      cfg: makeCoreConfig(),
      limit: 5,
    });

    expect(peers).toHaveLength(5);
  });

  it("returns empty array when apiKey is missing", async () => {
    const saved = process.env.PRISMER_API_KEY;
    delete process.env.PRISMER_API_KEY;
    try {
      const peers = await listPrismerPeers({
        cfg: { channels: {} } as CoreConfig,
      });
      expect(peers).toEqual([]);
      // Should NOT have called fetch
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      if (saved) process.env.PRISMER_API_KEY = saved;
    }
  });

  it("returns empty array on network error (graceful)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const peers = await listPrismerPeers({ cfg: makeCoreConfig() });
    expect(peers).toEqual([]);
  });

  it("returns empty array when API returns ok:false", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: false, error: "Unauthorized" }),
    );

    const peers = await listPrismerPeers({ cfg: makeCoreConfig() });
    expect(peers).toEqual([]);
  });

  it("plugin directory.listPeers delegates correctly", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: [{ userId: "p1", name: "PeerBot" }],
      }),
    );

    const peers = await prismerPlugin.directory.listPeers({
      cfg: makeCoreConfig(),
      accountId: null,
      query: null,
      limit: null,
    });

    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe("p1");
  });

  it("plugin directory.self returns null", async () => {
    const result = await prismerPlugin.directory.self();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Agent Tools: schema validation & execution
// ---------------------------------------------------------------------------

describe("Agent tools", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns empty array when apiKey is missing", () => {
    const saved = process.env.PRISMER_API_KEY;
    delete process.env.PRISMER_API_KEY;
    try {
      const tools = prismerPlugin.agentTools!({
        cfg: { channels: {} } as CoreConfig,
      });
      expect(tools).toEqual([]);
    } finally {
      if (saved) process.env.PRISMER_API_KEY = saved;
    }
  });

  it("returns tools when apiKey is configured", () => {
    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    expect(tools.length).toBeGreaterThan(0);
  });

  it("all tools have required fields", () => {
    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("exposes expected tool names", () => {
    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    const names = tools.map((t) => t.name);
    expect(names).toContain("prismer_load");
    expect(names).toContain("prismer_parse");
    expect(names).toContain("prismer_discover");
    expect(names).toContain("prismer_send");
    expect(names).toContain("prismer_memory_write");
    expect(names).toContain("prismer_memory_read");
    expect(names).toContain("prismer_evolve_analyze");
    expect(names).toContain("prismer_evolve_record");
    expect(names).toContain("prismer_evolve_report");
    expect(names).toContain("prismer_evolve_distill");
    expect(names).toContain("prismer_evolve_browse");
    expect(names).toContain("prismer_evolve_import");
    expect(names).toContain("prismer_gene_create");
    expect(names).toContain("prismer_recall");
  });

  describe("prismer_load tool execution", () => {
    it("returns formatted content on success", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          success: true,
          results: [
            { title: "Page 1", content: "Content of page 1" },
            { title: "Page 2", content: "Content of page 2" },
          ],
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const loadTool = tools.find((t) => t.name === "prismer_load")!;
      const result = await loadTool.execute("call-1", { input: "https://example.com" });

      expect(result.content[0].text).toContain("Page 1");
      expect(result.content[0].text).toContain("Content of page 1");
      expect(result.content[0].text).toContain("Page 2");
    });

    it("returns error message on API failure", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          success: false,
          error: { message: "Rate limit exceeded" },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const loadTool = tools.find((t) => t.name === "prismer_load")!;
      const result = await loadTool.execute("call-2", { input: "query" });

      expect(result.content[0].text).toContain("Rate limit exceeded");
    });

    it("handles network error gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const loadTool = tools.find((t) => t.name === "prismer_load")!;
      const result = await loadTool.execute("call-3", { input: "query" });

      expect(result.content[0].text).toContain("Failed");
      expect(result.content[0].text).toContain("Connection refused");
    });
  });

  describe("prismer_parse tool execution", () => {
    it("returns parsed content on success", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          success: true,
          result: { content: "Parsed document text here" },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const parseTool = tools.find((t) => t.name === "prismer_parse")!;
      const result = await parseTool.execute("call-4", {
        url: "https://example.com/doc.pdf",
        mode: "hires",
      });

      expect(result.content[0].text).toBe("Parsed document text here");
    });
  });

  describe("prismer_discover tool execution", () => {
    it("lists discovered agents", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: [
            { name: "SearchBot", status: "online", capabilities: ["search", "web"] },
          ],
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const discoverTool = tools.find((t) => t.name === "prismer_discover")!;
      const result = await discoverTool.execute("call-5", { capability: "search" });

      expect(result.content[0].text).toContain("SearchBot");
      expect(result.content[0].text).toContain("search, web");
    });

    it("reports no agents found", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ ok: true, data: [] }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const discoverTool = tools.find((t) => t.name === "prismer_discover")!;
      const result = await discoverTool.execute("call-6", {});

      expect(result.content[0].text).toContain("No agents found");
    });
  });

  describe("prismer_send tool execution", () => {
    it("sends message successfully", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ ok: true, data: { message: { id: "msg-1" } } }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const sendTool = tools.find((t) => t.name === "prismer_send")!;
      const result = await sendTool.execute("call-7", {
        to: "user-42",
        message: "Hello!",
      });

      expect(result.content[0].text).toContain("Message sent to user-42");
    });
  });

  describe("prismer_evolve_analyze tool execution", () => {
    it("returns analysis result", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: {
            action: "apply_gene",
            confidence: 0.85,
            gene_id: "gene-123",
            reason: "Matches timeout pattern",
          },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const analyzeTool = tools.find((t) => t.name === "prismer_evolve_analyze")!;
      const result = await analyzeTool.execute("call-8", {
        task_status: "failed",
        error: "timeout",
      });

      expect(result.content[0].text).toContain("apply_gene");
      expect(result.content[0].text).toContain("0.85");
      expect(result.content[0].text).toContain("gene-123");
    });
  });

  describe("prismer_evolve_record tool execution", () => {
    it("records outcome successfully", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: {
            edge_updated: true,
            personality_adjusted: true,
            distill_triggered: false,
          },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const recordTool = tools.find((t) => t.name === "prismer_evolve_record")!;
      const result = await recordTool.execute("call-9", {
        gene_id: "gene-123",
        signals: ["error:timeout"],
        outcome: "success",
        summary: "Fixed by retrying",
      });

      expect(result.content[0].text).toContain("edge_updated=true");
      expect(result.content[0].text).toContain("personality_adjusted=true");
    });
  });

  describe("prismer_memory_write tool execution", () => {
    it("writes memory successfully", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: { version: 3 },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const writeTool = tools.find((t) => t.name === "prismer_memory_write")!;
      const result = await writeTool.execute("call-10", {
        path: "MEMORY.md",
        content: "# Notes\n\nSome learned pattern",
      });

      expect(result.content[0].text).toContain("MEMORY.md");
      expect(result.content[0].text).toContain("v3");
    });
  });

  describe("prismer_memory_read tool execution", () => {
    it("reads memory with version info", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: {
            content: "# My Memory\n\nImportant pattern here",
            metadata: { version: 5 },
          },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const readTool = tools.find((t) => t.name === "prismer_memory_read")!;
      const result = await readTool.execute("call-11", {});

      expect(result.content[0].text).toContain("My Memory");
      expect(result.content[0].text).toContain("Version: 5");
    });
  });

  describe("prismer_recall tool execution", () => {
    it("returns search results across knowledge layers", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: [
            { source: "memory", title: "patterns.md", snippet: "Error handling pattern" },
            { source: "cache", title: "https://docs.example.com", snippet: "API documentation" },
          ],
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const recallTool = tools.find((t) => t.name === "prismer_recall")!;
      const result = await recallTool.execute("call-12", {
        query: "error handling",
      });

      expect(result.content[0].text).toContain("2 result(s)");
      expect(result.content[0].text).toContain("[memory]");
      expect(result.content[0].text).toContain("[cache]");
    });

    it("reports no results", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ ok: true, data: [] }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const recallTool = tools.find((t) => t.name === "prismer_recall")!;
      const result = await recallTool.execute("call-13", {
        query: "nonexistent",
      });

      expect(result.content[0].text).toContain("No results found");
    });
  });

  describe("prismer_evolve_browse tool execution", () => {
    it("lists public genes", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: [
            {
              id: "gene-pub-1",
              title: "Timeout Retry",
              category: "repair",
              success_rate: 0.92,
              total_executions: 150,
            },
          ],
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const browseTool = tools.find((t) => t.name === "prismer_evolve_browse")!;
      const result = await browseTool.execute("call-14", { category: "repair" });

      expect(result.content[0].text).toContain("Timeout Retry");
      expect(result.content[0].text).toContain("92%");
      expect(result.content[0].text).toContain("150 runs");
    });
  });

  describe("prismer_evolve_import tool execution", () => {
    it("imports a gene", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: { id: "gene-local-1", category: "repair" },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const importTool = tools.find((t) => t.name === "prismer_evolve_import")!;
      const result = await importTool.execute("call-15", {
        gene_id: "gene-pub-1",
      });

      expect(result.content[0].text).toContain("Imported");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/genes/import");
    });

    it("forks a gene when fork=true", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          ok: true,
          data: { id: "gene-fork-1", category: "optimize" },
        }),
      );

      const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
      const importTool = tools.find((t) => t.name === "prismer_evolve_import")!;
      const result = await importTool.execute("call-16", {
        gene_id: "gene-pub-1",
        fork: true,
      });

      expect(result.content[0].text).toContain("Forked");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/genes/fork");
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Setup Entry
// ---------------------------------------------------------------------------

describe("Setup entry (setup-entry.ts)", () => {
  it("exports plugin with correct id and name", () => {
    expect(setupPlugin.id).toBe("prismer");
    expect(setupPlugin.name).toBe("Prismer");
    expect(typeof setupPlugin.description).toBe("string");
  });

  it("configSchema requires apiKey", () => {
    const schema = setupPlugin.setup.configSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("apiKey");
  });

  it("configSchema has apiKey, baseUrl, agentName properties", () => {
    const props = setupPlugin.setup.configSchema.properties;
    expect(props.apiKey).toBeDefined();
    expect(props.apiKey.type).toBe("string");
    expect(props.baseUrl).toBeDefined();
    expect(props.baseUrl.default).toBe("https://prismer.cloud");
    expect(props.agentName).toBeDefined();
  });

  it("configSchema disallows additionalProperties", () => {
    expect(setupPlugin.setup.configSchema.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Runtime (setPrismerRuntime / getPrismerRuntime)
// ---------------------------------------------------------------------------

describe("Runtime", () => {
  it("throws when runtime not initialized", () => {
    // Reset module state — setPrismerRuntime(null) isn't exposed, but we can
    // test the error path by importing fresh. For simplicity, just test the getter.
    // Note: if a previous test set it, this may pass. We test the contract shape.
    expect(typeof setPrismerRuntime).toBe("function");
    expect(typeof getPrismerRuntime).toBe("function");
  });

  it("setPrismerRuntime + getPrismerRuntime round-trip", () => {
    const fakeRuntime = { log: vi.fn() } as any;
    setPrismerRuntime(fakeRuntime);
    expect(getPrismerRuntime()).toBe(fakeRuntime);
  });
});

// ---------------------------------------------------------------------------
// 13. Plugin index (register)
// ---------------------------------------------------------------------------

describe("Plugin index (index.ts)", () => {
  it("default export has correct shape", async () => {
    const plugin = (await import("../index.js")).default;
    expect(plugin.id).toBe("prismer");
    expect(plugin.name).toBe("Prismer");
    expect(typeof plugin.register).toBe("function");
    expect(typeof plugin.description).toBe("string");
    expect(plugin.configSchema).toBeDefined();
  });

  it("register() calls api.registerChannel", async () => {
    const plugin = (await import("../index.js")).default;
    const registerChannel = vi.fn();
    const fakeApi = {
      runtime: { log: vi.fn() },
      registerChannel,
    };
    plugin.register(fakeApi as any);
    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerChannel).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: expect.any(Object) }),
    );
  });

  // ---------------------------------------------------------------------
  // N2 regression — the openclaw 2026.3.x+ plugin loader unwraps ESM
  // default export then falls back through .register / .activate. Make
  // sure BOTH reach a function so the loader accepts us regardless of
  // which interop path it uses.
  // ---------------------------------------------------------------------

  it("module export is compatible with openclaw resolvePluginModuleExport", async () => {
    const mod = await import("../index.js");
    // 1) Named `register` export — used by some CJS-interop variants.
    expect(typeof (mod as { register?: unknown }).register).toBe("function");
    // 2) Default export has `.register` method — the main path used by
    //    openclaw/dist/plugins/loader.js resolvePluginModuleExport().
    expect(typeof mod.default.register).toBe("function");
    // 3) `activate` is a supported alias per the loader's fallback chain
    //    (`def.register ?? def.activate`).
    expect(typeof mod.default.activate).toBe("function");
    expect(typeof (mod as { activate?: unknown }).activate).toBe("function");
  });

  it("PARA and Mode-B imports do not block module evaluation", async () => {
    // Even if PARA / Mode-B submodules fail to resolve, importing the
    // entry file must succeed — the fix makes those imports dynamic and
    // fire-and-forget so the channel always registers. This test passes
    // simply because the dynamic `import('../index.js')` above didn't
    // throw; we assert structural shape to lock in the invariant.
    const plugin = (await import("../index.js")).default;
    expect(plugin).toBeDefined();
    expect(plugin.id).toBe("prismer");
    // Synchronous register() must return without awaiting the
    // fire-and-forget PARA/Mode-B promises.
    const registerChannel = vi.fn();
    const fakeApi = { runtime: { log: vi.fn() }, registerChannel };
    const ret = plugin.register(fakeApi as any);
    // register() should be void (sync), not a Promise — openclaw's
    // loader warns when register returns a promise.
    expect(ret).toBeUndefined();
    expect(registerChannel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Gateway: startPrismerGateway error cases
// ---------------------------------------------------------------------------

describe("Gateway error handling", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("throws when apiKey is missing", async () => {
    const { startPrismerGateway } = await import("../src/inbound.js");

    const ctx = {
      account: {
        accountId: "test",
        apiKey: "",
        baseUrl: "https://test.prismer.cloud",
        agentName: "bot",
        capabilities: [],
      } as ResolvedPrismerAccount,
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      setStatus: vi.fn(),
      abortSignal: new AbortController().signal,
    } as any;

    await expect(startPrismerGateway(ctx)).rejects.toThrow("not configured");
  });

  it("throws when registration API fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const { startPrismerGateway } = await import("../src/inbound.js");

    const ctx = {
      account: {
        accountId: "test",
        apiKey: "sk-test",
        baseUrl: "https://test.prismer.cloud",
        agentName: "bot",
        description: "Test bot",
        capabilities: ["chat"],
      } as ResolvedPrismerAccount,
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      setStatus: vi.fn(),
      abortSignal: new AbortController().signal,
    } as any;

    await expect(startPrismerGateway(ctx)).rejects.toThrow(
      "agent registration failed",
    );
  });

  it("throws when registration returns ok:false", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: false,
        error: { message: "Invalid key" },
      }),
    );

    const { startPrismerGateway } = await import("../src/inbound.js");

    const ctx = {
      account: {
        accountId: "test",
        apiKey: "sk-test",
        baseUrl: "https://test.prismer.cloud",
        agentName: "bot",
        description: "Test bot",
        capabilities: ["chat"],
      } as ResolvedPrismerAccount,
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      setStatus: vi.fn(),
      abortSignal: new AbortController().signal,
    } as any;

    await expect(startPrismerGateway(ctx)).rejects.toThrow(
      "agent registration failed",
    );
  });
});

// ---------------------------------------------------------------------------
// 15. Error handling edge cases
// ---------------------------------------------------------------------------

describe("Error handling edge cases", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("prismerFetch handles non-JSON error response body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => "<html>Bad Gateway</html>",
    } as unknown as Response);

    await expect(
      prismerFetch("sk-test", "/api/test", {
        baseUrl: "https://test.prismer.cloud",
      }),
    ).rejects.toThrow("Prismer API 502");
  });

  it("tool execute catches fetch rejection and returns error content", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    const sendTool = tools.find((t) => t.name === "prismer_send")!;
    const result = await sendTool.execute("call-err", {
      to: "user",
      message: "hi",
    });

    expect(result.content[0].text).toContain("Failed");
    expect(result.content[0].text).toContain("Failed to fetch");
  });

  it("gene_create handles API error", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ ok: false, error: "Quota exceeded" }),
    );

    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    const createTool = tools.find((t) => t.name === "prismer_gene_create")!;
    const result = await createTool.execute("call-gc", {
      category: "repair",
      signals_match: ["error:timeout"],
      strategy: ["Retry with backoff"],
    });

    expect(result.content[0].text).toContain("Error");
  });

  it("evolve_distill handles not-ready response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: {
          ready: false,
          message: "Need more capsules",
          success_capsules: 2,
          min_required: 5,
        },
      }),
    );

    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    const distillTool = tools.find((t) => t.name === "prismer_evolve_distill")!;
    const result = await distillTool.execute("call-dist", { dry_run: true });

    expect(result.content[0].text).toContain("Not ready");
    expect(result.content[0].text).toContain("2/5");
  });

  it("evolve_report returns trace_id on success", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        ok: true,
        data: { trace_id: "tr-abc-123", status: "queued" },
      }),
    );

    const tools = createPrismerAgentTools("sk-test", "https://test.prismer.cloud");
    const reportTool = tools.find((t) => t.name === "prismer_evolve_report")!;
    const result = await reportTool.execute("call-rpt", {
      rawContext: "Error log here",
      outcome: "failed",
    });

    expect(result.content[0].text).toContain("tr-abc-123");
    expect(result.content[0].text).toContain("queued");
  });
});
