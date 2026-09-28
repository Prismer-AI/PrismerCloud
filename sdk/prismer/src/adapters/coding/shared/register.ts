// WS-D step D-1 — register the coding driver into the live adapter registry so a
// normal task dispatch for a coding agent reaches the CodeAgentDriver bridge
// (runner → registry → adapter.ensureService → CodeAgentDriver → recorder).
//
// This is the daemon-side half of the communication layer. The cloud src/im side
// (which decides profile.adapterName) is D-2 and is NOT touched here.
//
// ── Naming ───────────────────────────────────────────────────────────────────
// The driver drives providers whose registry ids are "claude" / "codex" /
// "opencode" (provider-registry.ts). The canonical coding adapter NAMES that
// cloud profiles route to are "claude-code" / "codex" / "opencode". To deliver
// the driver's rich-event features by default, the driver takes those canonical
// names; the legacy one-shot CLI adapters move to fallback names
// ("claude-code-cli" / "codex-cli") and stay importable as the D21 fallback.
//
// hermes / openclaw (persistence channel) routing is UNCHANGED — this module
// only constructs the coding-provider driver adapters.

import pino from "pino";
import type { Logger } from "pino";

import type { AdapterDef } from "../../contract.js";
import type { AgentClient } from "./agent-sdk-types.js";
import { makeCodeAgentAdapter } from "./make-code-agent-adapter.js";
import { ClaudeAgentClient } from "../claude-code/agent.js";
import { CodexAppServerAgentClient } from "../codex/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../opencode/opencode-agent.js";

/**
 * In-scope coding providers, each mapped to the canonical coding adapter NAME a
 * cloud profile routes to. Clients are constructed directly (mirrors the B3
 * harness's makeClient) rather than through buildProviderRegistry — the full
 * registry eagerly resolves a client factory for EVERY manifest provider
 * (incl. future pi-coding-agent/copilot/cursor), which is out of scope here and
 * would throw.
 */
const CODING_PROVIDERS: Array<{
  adapterName: string;
  createClient: (logger: Logger) => AgentClient;
}> = [
  { adapterName: "claude-code", createClient: (logger) => new ClaudeAgentClient({ logger }) },
  { adapterName: "codex", createClient: (logger) => new CodexAppServerAgentClient(logger) },
  { adapterName: "opencode", createClient: (logger) => new OpenCodeAgentClient(logger) },
];

export interface BuildCodingDriverAdaptersOptions {
  logger?: Logger;
}

/**
 * Build the driver AdapterDefs for the in-scope coding providers
 * (claude / codex / opencode), each named with its canonical coding adapter
 * name so `profile.adapterName` routes the dispatch to the driver.
 *
 * Each adapter's ensureService → makeCodeAgentAdapter's resolveServiceOptions
 * reads route / proxyProvider / model off `profile.config` and hands them to
 * CodeAgentDriver as the proxy injection config — the same gateway routing B3
 * proved live. The provider client itself comes from the provider registry.
 */
export function buildCodingDriverAdapters(
  options?: BuildCodingDriverAdaptersOptions,
): AdapterDef[] {
  const logger = options?.logger ?? pino({ level: process.env.PASEO_E2E_LOG ?? "silent" });
  return CODING_PROVIDERS.map(({ adapterName, createClient }) => {
    const driverAdapter = makeCodeAgentAdapter(createClient(logger));
    // The driver takes the canonical coding adapter name.
    // makeCodeAgentAdapter names the def after client.provider; override it so
    // the profile's adapterName ("claude-code" / "codex" / "opencode") routes here.
    return { ...driverAdapter, name: adapterName };
  });
}
