// WS-B2.5 — Prismer cloud-gateway proxy injection unit tests. NO live LLM.
//
// Asserts each ported provider authenticates through OUR gateway (base_url +
// sk-prismer token), NOT official claude/codex login, and that the PRISMER_*
// scope env is applied + the Claude parent-session env scrubbed.
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-B / B2.5.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocalProviders } from "../../shared/local-provider.js";
import { buildProviderProxyInjection } from "./provider-proxy-env.js";

const BASE = "https://test.docbrew.cn";
const TOKEN = "sk-prismer-test-abc123";

const SCOPE_META = {
  prismerWorkspaceId: "ws-1",
  prismerTaskId: "task-1",
  prismerAgentId: "agent-1",
};

describe("buildProviderProxyInjection", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.PRISMER_BASE_URL = BASE;
    process.env.PRISMER_API_KEY = TOKEN;
    // Pollute with Claude parent-session vars to assert the scrub.
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  it("claude → gateway ANTHROPIC_BASE_URL + sk-prismer AUTH_TOKEN (not official key)", () => {
    const inj = buildProviderProxyInjection("claude", { route: "prismer" }, SCOPE_META);
    expect(inj).not.toBeNull();
    // CC client appends /v1/messages → base must end at /api.
    expect(inj!.env.ANTHROPIC_BASE_URL).toBe(`${BASE}/api`);
    expect(inj!.env.ANTHROPIC_API_BASE).toBe(`${BASE}/api`);
    expect(inj!.env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
    expect(inj!.env.ANTHROPIC_AUTH_TOKEN.startsWith("sk-prismer-")).toBe(true);
    // Never an official Anthropic api key.
    expect(inj!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("codex → config.toml [model_providers.prismer] base_url=<base>/api/v1 model_provider=prismer", () => {
    const inj = buildProviderProxyInjection(
      "codex",
      { proxyProvider: "newapi", model: "gpt-5-codex" },
      SCOPE_META,
    );
    expect(inj).not.toBeNull();
    expect(inj!.codexHome).toBeTruthy();
    expect(inj!.env.CODEX_HOME).toBe(inj!.codexHome);
    const toml = readFileSync(join(inj!.codexHome!, "config.toml"), "utf8");
    expect(toml).toContain("[model_providers.prismer]");
    expect(toml).toContain(`base_url = "${BASE}/api/v1"`);
    expect(toml).toContain('model_provider = "prismer"');
    expect(toml).toContain(TOKEN);
  });

  it("codex chain → /api/v1/proxy/<chain>", () => {
    const inj = buildProviderProxyInjection(
      "codex",
      { proxyProvider: "deepseek", model: "gpt-5-codex" },
      SCOPE_META,
    );
    const toml = readFileSync(join(inj!.codexHome!, "config.toml"), "utf8");
    expect(toml).toContain(`base_url = "${BASE}/api/v1/proxy/deepseek"`);
  });

  it("opencode → OPENAI_BASE_URL + OPENAI_API_KEY (our gateway + key)", () => {
    const inj = buildProviderProxyInjection(
      "opencode",
      { proxyProvider: "newapi" },
      SCOPE_META,
    );
    expect(inj).not.toBeNull();
    expect(inj!.env.OPENAI_BASE_URL).toBe(`${BASE}/api/v1`);
    expect(inj!.env.OPENAI_API_KEY).toBe(TOKEN);
  });

  it("opencode → emits opencode.json custom provider (WS-B2.6) with our baseURL + key + model", () => {
    const inj = buildProviderProxyInjection(
      "opencode",
      { proxyProvider: "newapi", model: "prismer/gemini-3.1-flash-lite-preview" },
      SCOPE_META,
    );
    expect(inj).not.toBeNull();
    expect(inj!.opencodeConfigPath).toBeTruthy();
    expect(inj!.env.OPENCODE_CONFIG).toBe(inj!.opencodeConfigPath);
    const cfg = JSON.parse(readFileSync(inj!.opencodeConfigPath!, "utf8")) as {
      provider: Record<
        string,
        { npm: string; options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }
      >;
    };
    const p = cfg.provider.prismer;
    expect(p).toBeDefined();
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.options.baseURL).toBe(`${BASE}/api/v1`);
    expect(p.options.apiKey).toBe(TOKEN);
    // The provider prefix is stripped → bare gateway model id keys the models map.
    expect(p.models["gemini-3.1-flash-lite-preview"]).toBeDefined();
    expect(p.models["prismer/gemini-3.1-flash-lite-preview"]).toBeUndefined();
  });

  it("pi-core → PRISMER_PI_* env for in-process pi-ai gateway provider", () => {
    const inj = buildProviderProxyInjection(
      "pi-core",
      { proxyProvider: "newapi", model: "prismer/gemini-3.1-flash-lite-preview" },
      SCOPE_META,
    );
    expect(inj).not.toBeNull();
    expect(inj!.env.PRISMER_PI_BASE_URL).toBe(`${BASE}/api/v1`);
    expect(inj!.env.PRISMER_PI_API_KEY).toBe(TOKEN);
    expect(inj!.env.PRISMER_PI_PROVIDER).toBe("prismer");
    expect(inj!.env.PRISMER_PI_API).toBe("openai-responses");
    expect(inj!.env.PRISMER_PI_MODEL).toBe("gemini-3.1-flash-lite-preview");
    expect(inj!.env.OPENAI_API_KEY).toBeUndefined();
    expect(inj!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("pi-core → local third-party provider (deepseek) resolves the Anthropic wire + kind", () => {
    process.env.PRISMER_PROVIDER_KEY_ds = "sk-ds-test";
    setLocalProviders([{ id: "ds", type: "deepseek", key_ref: "keychain:ds" }]);
    try {
      const inj = buildProviderProxyInjection(
        "pi-core",
        { proxyProvider: "local:ds", model: "ds/deepseek-v4-flash" },
        SCOPE_META,
      );
      expect(inj).not.toBeNull();
      expect(inj!.env.PRISMER_PI_BASE_URL).toBe("https://api.deepseek.com/anthropic");
      expect(inj!.env.PRISMER_PI_API_KEY).toBe("sk-ds-test");
      expect(inj!.env.PRISMER_PI_PROVIDER).toBe("ds");
      expect(inj!.env.PRISMER_PI_API).toBe("anthropic-messages");
      expect(inj!.env.PRISMER_PI_MODEL).toBe("deepseek-v4-flash");
    } finally {
      delete process.env.PRISMER_PROVIDER_KEY_ds;
      setLocalProviders(null);
    }
  });

  it("pi-core → local ollama profile falls back to the cloud chain (chat-completions-only, pi-core cannot serve it)", () => {
    // Ollama is keyless → resolveLocalProvider resolves it WITHOUT a key, so a
    // naive wiring would point the embedded pi-ai engine (anthropic-messages /
    // openai-responses wire) at 127.0.0.1:11434 → wrong wire, silent break.
    // piCoreSupportsLocalType must decline and land on the gateway instead.
    setLocalProviders([{ id: "ollama-1", type: "ollama" }]);
    try {
      const inj = buildProviderProxyInjection(
        "pi-core",
        { proxyProvider: "local:ollama-1", model: "ollama-1/llama3" },
        SCOPE_META,
      );
      expect(inj).not.toBeNull();
      expect(inj!.env.PRISMER_PI_BASE_URL).not.toBe("http://127.0.0.1:11434");
      expect(inj!.env.PRISMER_PI_BASE_URL).toBe(`${BASE}/api/v1`);
      expect(inj!.env.PRISMER_PI_PROVIDER).toBe("prismer");
      expect(inj!.env.PRISMER_PI_API).toBe("openai-responses");
    } finally {
      setLocalProviders(null);
    }
  });

  it("pi-core → local anthropic-type provider keeps the base_url verbatim", () => {
    process.env.PRISMER_PROVIDER_KEY_byok = "sk-byok-test";
    setLocalProviders([
      { id: "byok", type: "anthropic", base_url: "https://byok.example.com", key_ref: "keychain:byok" },
    ]);
    try {
      const inj = buildProviderProxyInjection(
        "pi-core",
        { proxyProvider: "local:byok", model: "byok/claude-haiku-4-5" },
        SCOPE_META,
      );
      expect(inj).not.toBeNull();
      expect(inj!.env.PRISMER_PI_BASE_URL).toBe("https://byok.example.com");
      expect(inj!.env.PRISMER_PI_PROVIDER).toBe("byok");
      expect(inj!.env.PRISMER_PI_API).toBe("anthropic-messages");
    } finally {
      delete process.env.PRISMER_PROVIDER_KEY_byok;
      setLocalProviders(null);
    }
  });

  it("applies PRISMER_* scope env + scrubs Claude parent-session vars", () => {
    const inj = buildProviderProxyInjection("claude", { route: "prismer" }, SCOPE_META);
    expect(inj!.env.PRISMER_WORKSPACE_ID).toBe("ws-1");
    expect(inj!.env.PRISMER_AGENT_ID).toBe("agent-1");
    // doc 08 §7.6 ② parent-session scrub.
    expect(inj!.env.CLAUDECODE).toBeUndefined();
    expect(inj!.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it("returns null when routing not requested", () => {
    expect(buildProviderProxyInjection("claude", { route: "default" }, undefined)).toBeNull();
    expect(buildProviderProxyInjection("codex", {}, undefined)).toBeNull();
  });

  it("returns null (degrade to official) when gateway env missing", () => {
    delete process.env.PRISMER_BASE_URL;
    delete process.env.PRISMER_API_KEY;
    expect(buildProviderProxyInjection("claude", { route: "prismer" }, undefined)).toBeNull();
  });

  it("unknown provider → null (no injection)", () => {
    expect(buildProviderProxyInjection("cursor", { route: "prismer" }, undefined)).toBeNull();
  });
});
