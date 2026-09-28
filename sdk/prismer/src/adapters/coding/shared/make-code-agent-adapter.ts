// WS-B (PP-1) — makeCodeAgentAdapter: wire a code-agent provider client into an
// AdapterDef whose ensureService returns a CodeAgentDriver (ported from Paseo).
//
// This is the long-running AdapterDef factory for code-agent providers
// (claude / codex / opencode) driven via the ported code-agent driver. It is NOT
// registered into the live adapter registry here — that is B3/WS-D. We only
// export the factory so it can be unit-tested + wired later.
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-B step 3.

import { z } from "zod";
import type {
  AdapterDef,
  AdapterService,
  AgentProfile,
  HealthStatus,
  ValidationResult,
} from "../../contract.js";
import type { AgentCapabilityFlags, AgentClient } from "./agent-sdk-types.js";
import { CodeAgentDriver, type CodeAgentDriverOptions } from "./code-agent-driver.js";

const MODULE = "[CodeAgentAdapter]";

/** Profile config schema for a code-agent adapter. */
const CodeAgentProfileSchema = z.object({
  cwd: z.string().min(1),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  // WS-B2.5 — provider-chain routing (mirrors claude-code / codex adapters).
  // When route:'prismer' or proxyProvider is set, the session is launched with
  // OUR cloud-gateway base_url + token injected (NOT official login).
  route: z.enum(["default", "prismer", "omniroute"]).optional(),
  proxyProvider: z.string().min(1).optional(),
  prismerApiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
});

/** Derive coarse capability tags (mobile-facing) from code-agent capability flags. */
function capabilitiesFromFlags(provider: string, flags: AgentCapabilityFlags): string[] {
  const tags = new Set<string>(["code", provider]);
  if (flags.supportsToolInvocations) tags.add("shell");
  if (flags.supportsMcpServers) tags.add("mcp");
  if (flags.supportsStreaming) tags.add("streaming");
  if (flags.supportsRewindConversation || flags.supportsRewindFiles || flags.supportsRewindBoth) {
    tags.add("rewind");
  }
  return [...tags];
}

export interface MakeCodeAgentAdapterOptions {
  /**
   * Optional override for how a profile's config is turned into
   * CodeAgentDriverOptions. Defaults to reading the CodeAgentProfileSchema fields.
   */
  resolveServiceOptions?: (profile: AgentProfile) => CodeAgentDriverOptions;
}

/**
 * Build an AdapterDef for a code-agent provider client.
 *
 * ensureService creates a CodeAgentDriver bound to the resolved cwd. The caller
 * (dispatch.ts via the adapter registry) caches the service per profile — the
 * CodeAgentDriver itself holds the per-conversation session map, so repeat
 * dispatches reuse sessions across turns.
 */
export function makeCodeAgentAdapter(
  client: AgentClient,
  options?: MakeCodeAgentAdapterOptions,
): AdapterDef {
  const provider = client.provider;
  const flags = client.capabilities;

  const resolveServiceOptions =
    options?.resolveServiceOptions ??
    ((profile: AgentProfile): CodeAgentDriverOptions => {
      const parsed = CodeAgentProfileSchema.parse(profile.config);
      const wantsProxy = parsed.route === "prismer" || !!parsed.proxyProvider;
      return {
        cwd: parsed.cwd,
        systemPrompt: parsed.systemPrompt,
        model: parsed.model,
        modeId: parsed.modeId,
        proxy: wantsProxy
          ? {
              route: parsed.route,
              proxyProvider: parsed.proxyProvider,
              prismerApiKeyEnv: parsed.prismerApiKeyEnv,
              model: parsed.model,
            }
          : undefined,
      };
    });

  return {
    name: provider,
    kind: "long-running",
    capabilities: capabilitiesFromFlags(provider, flags),
    capabilityFlags: flags,
    workspaceSchema: CodeAgentProfileSchema,

    async ensureService(profile: AgentProfile): Promise<AdapterService> {
      const opts = resolveServiceOptions(profile);
      console.log(`${MODULE} ensureService provider=${provider} cwd=${opts.cwd}`);
      return new CodeAgentDriver(client, opts);
    },

    validate(config: unknown): ValidationResult {
      const result = CodeAgentProfileSchema.safeParse(config);
      if (result.success) return { ok: true };
      return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    },

    async health(): Promise<HealthStatus> {
      try {
        const available = await client.isAvailable();
        return available
          ? { available: true }
          : { available: false, reason: `${provider} provider unavailable` };
      } catch (err) {
        return {
          available: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
