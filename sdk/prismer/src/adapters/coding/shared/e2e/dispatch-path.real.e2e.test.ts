// WS-D D-1 — dispatch-PATH real-e2e. Proves the coding driver is routable through
// the REAL daemon dispatch chain, NOT via a direct CodeAgentDriver.dispatch():
//
//   buildCodingDriverAdapters() → AdapterRegistry.register()   (as runner does)
//   → registry.get(profile.adapterName)                        (as dispatch.ts does)
//   → ServicePool.ensureService(profile, adapter)              (as deps.ensureService)
//   → adapter.ensureService(profile) → CodeAgentDriver
//   → service.dispatch(taskInput) → recorder events
//
// Asserts per coding provider: TaskResult.ok, non-empty output, AND the recorder
// captured events (tool_call and/or reasoning). Gated on binary availability.
// Runs live against the LOCAL :3000 gateway (proxy injection from harness env).
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-D.

import { describe, it, expect, beforeAll } from "vitest";

import {
  binaryAvailable,
  compact,
  makeTaskInput,
  tmpCwd,
  rmCwd,
  GATEWAY_MODELS,
  type ProviderName,
} from "./harness.js";
import { AdapterRegistry } from "../../../registry.js";
import { ServicePool } from "../../../../daemon/service-pool.js";
import { buildCodingDriverAdapters } from "../register.js";
import type { AgentProfile } from "../../../contract.js";

// provider id (registry/binary) → canonical coding adapter NAME a profile routes to.
const CASES: Array<{ provider: ProviderName; adapterName: string; binary: string }> = [
  { provider: "claude", adapterName: "claude-code", binary: "claude" },
  { provider: "codex", adapterName: "codex", binary: "codex" },
  { provider: "opencode", adapterName: "opencode", binary: "opencode" },
];

// Build the registry exactly once, the way runner.ts does.
const registry = new AdapterRegistry();
for (const a of buildCodingDriverAdapters()) registry.register(a);
const pool = new ServicePool();

// Per-provider routing proven live in B3 (see codex.real.e2e.test.ts CODEX_ROUTING):
//  - claude:   gateway model us-kimi-k2.6 (Anthropic wire), proxyProvider 'default'.
//  - codex:    DeepSeek chain — proxyProvider 'deepseek', model deepseek-chat,
//              modeId full-access (the gateway-routed config codex actually accepts).
//  - opencode: gemini via the custom 'prismer' provider, proxyProvider 'default'.
const ROUTING: Record<ProviderName, { model: string; proxyProvider: string; modeId?: string }> = {
  claude: { model: GATEWAY_MODELS.claude, proxyProvider: "default", modeId: "bypassPermissions" },
  codex: { model: "deepseek-chat", proxyProvider: "deepseek", modeId: "full-access" },
  opencode: { model: GATEWAY_MODELS.opencode, proxyProvider: "default" },
};

function makeProfile(adapterName: string, provider: ProviderName, cwd: string): AgentProfile {
  const r = ROUTING[provider];
  return {
    id: `d1-${provider}`,
    workspaceId: "d1-ws",
    agentImUserId: "d1-agent",
    adapterName,
    name: `d1-${provider}`,
    config: {
      cwd,
      model: r.model,
      // 🔴 鉴权铁律: route through OUR gateway (proxy injection), never official login.
      route: "prismer",
      proxyProvider: r.proxyProvider,
      ...(r.modeId ? { modeId: r.modeId } : {}),
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe.each(CASES)(
  "WS-D D-1 dispatch-path real-e2e ($adapterName)",
  ({ provider, adapterName, binary }) => {
    let available = false;
    beforeAll(async () => {
      available = await binaryAvailable(binary);
      if (!available) console.log(`[D-1] SKIP ${adapterName} — ${binary} not on PATH`);
    });

    it("driver adapter is registered under its canonical coding name", () => {
      const adapter = registry.get(adapterName);
      expect(adapter).toBeDefined();
      expect(adapter!.kind).toBe("long-running");
      expect(typeof adapter!.ensureService).toBe("function");
    });

    it("dispatch through registry → ServicePool → CodeAgentDriver → recorder", async (ctx) => {
      if (!available) return ctx.skip();
      const cwd = tmpCwd(`d1-${provider}-`);
      const adapter = registry.get(adapterName);
      expect(adapter).toBeDefined();
      try {
        const profile = makeProfile(adapterName, provider, cwd);
        // EXACT dispatch.ts chain: ServicePool.ensureService(profile, adapter).
        const service = await pool.ensureService(profile, adapter!);
        const { task, recorder, heartbeat } = makeTaskInput({
          prompt: "Reply with exactly: PONG",
        });
        const result = await service.dispatch(task);

        console.log(
          `[D-1] ${adapterName}: ok=${result.ok} output=${JSON.stringify(
            (result.output ?? "").slice(0, 40),
          )} toolCalls=${recorder.toolCalls.length} reasoning=${recorder.reasoning.length} phases=${heartbeat.phases.length}`,
        );

        expect(result.ok).toBe(true);
        expect((result.output ?? "").length).toBeGreaterThan(0);
        // Content sniff is best-effort: the gateway-routed model may mangle a
        // tiny literal ("PONG" → "ONG" on DeepSeek). The dispatch-PATH proof is
        // ok + non-empty output + recorder events, not exact echo fidelity.
        if (provider !== "codex") {
          expect(compact(result.output ?? "")).toContain("pong");
        }
        // recorder captured driver events (reasoning and/or tool_call + phase changes).
        const sawEvents =
          recorder.toolCalls.length > 0 ||
          recorder.reasoning.length > 0 ||
          heartbeat.phases.length > 0;
        expect(sawEvents).toBe(true);
      } finally {
        await pool.shutdown();
        rmCwd(cwd);
      }
    }, 120_000);
  },
);
