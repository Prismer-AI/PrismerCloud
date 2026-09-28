// WS-B2.5 (PP-1) — Prismer cloud-gateway proxy injection for code-agent providers (ported from Paseo).
//
// 🔴 鉴权铁律 (doc 08 §7.7 WS-B): code-agents do NOT use official claude/codex
// login. In prod (agent-rt pods) there is no interactive login — providers MUST
// authenticate through OUR cloud LLM gateway, exactly like the EXISTING
// claude-code / codex adapters already do. This helper produces the per-provider
// injection that the CodeAgentDriver passes into `createSession`/`resumeSession`
// via `launchContext.env` (the seam every Paseo provider already overlays onto
// its spawned subprocess env: claude.buildSdkEnv ← launchEnv, codex.spawnAppServer
// ← launchContext.env, opencode server-manager ← launchEnv).
//
// We SHARE — not fork — the existing adapters' resolver logic:
//   - claude → resolveClaudeCodePrismerProvider (claude-code/index.ts)
//   - codex  → resolveCodexPrismerProvider + writeCodexPrismerHome (codex/index.ts)
// so the provider-chain base_url resolution can't drift between the two paths
// (project memory: project_provider_chain — config-driven chain → base_url).
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-B / B2.5.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveClaudeCodePrismerProvider,
  type ClaudeCodeConfig,
} from "../claude-code/index.js";
import {
  resolveCodexPrismerProvider,
  writeCodexPrismerHome,
  buildCodexNoProxy,
  type CodexConfig,
} from "../codex/index.js";
import { applyPrismerScopeEnv } from "../../prismer-env.js";
import {
  piCoreApiForType,
  piCoreSupportsLocalType,
  piCoreWireBaseUrl,
  resolveLocalProvider,
} from "../../shared/local-provider.js";
import { installCodingSkills } from "./coding-skill-set.js";
import {
  PARENT_SESSION_ENV_VARS,
} from "./shims/paseo-env.js";

const MODULE = "[CodeAgentProxyEnv]";

/**
 * desktop202/20 — header the agent's LLM calls carry so the cloud llm-proxy can
 * record this run's routing outcome (fallback / vision-filter) keyed by it, and
 * the cloud reply handler can look it back up. Value = the dispatch `taskId`
 * (carried in metadata as `prismerDispatchId`, always == the reply's `taskId`).
 * Literal kept in sync with `ROUTING_RUN_ID_HEADER` in cloud
 * `src/lib/llm-routing-store.ts` (separate package — can't import across).
 */
const RUN_ID_HEADER = "x-prismer-task-run-id";

/** Pull the stable dispatch run id the cloud uses to correlate routing outcomes. */
function dispatchRunId(metadata: Record<string, unknown> | undefined): string | undefined {
  const v = metadata?.prismerDispatchId;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** CLAUDE_CODE_* prefix scrub mirror (paseo-env shim does the same for spawns). */
const PARENT_SESSION_ENV_PREFIXES = ["CLAUDE_CODE_"] as const;

/**
 * Provider-chain routing config carried on a code-agent profile. This is the
 * union of the fields the existing claude-code / codex adapters read, so the
 * shared resolvers can be driven directly. All optional → unset = official
 * endpoint (backwards compatible; degrade path identical to the legacy
 * adapters when PRISMER_BASE_URL / key env is missing).
 */
export interface CodeAgentProxyConfig {
  /** 'prismer' routes through our gateway; 'default'/'omniroute' = no routing. */
  route?: "default" | "prismer" | "omniroute";
  /** Provider-chain id (release202/07). Set → route through the chain. */
  proxyProvider?: string;
  /** Env var holding the sk-prismer-* key (default PRISMER_API_KEY). */
  prismerApiKeyEnv?: string;
  /** The curated model id (needed by codex's config.toml writer). */
  model?: string;
}

export interface ProviderProxyInjection {
  /**
   * Env map to forward via `launchContext.env` into the provider session.
   * Carries the gateway base_url + token (per-provider var names) plus the
   * PRISMER_* scope env, and is scrubbed of the Claude parent-session vars.
   */
  env: Record<string, string>;
  /** For codex: the CODEX_HOME dir whose config.toml was written. */
  codexHome?: string;
  /** For opencode: the path to the opencode.json custom-provider config. */
  opencodeConfigPath?: string;
}

/** Custom-provider id declared in the emitted opencode.json (model form `<id>/<model>`). */
const OPENCODE_CUSTOM_PROVIDER_ID = "prismer";

/**
 * WS-B2.6 — emit an opencode custom OpenAI-compatible provider config so opencode
 * routes turns through OUR cloud gateway. opencode's built-in `openai` provider
 * validates model ids against the models.dev catalog and rejects our gateway model
 * names; a custom `@ai-sdk/openai-compatible` provider that lists OUR models bypasses
 * that catalog check. opencode resolves config from the OPENCODE_CONFIG env (verified
 * against opencode 1.14.46: `OPENCODE_CONFIG=<file> opencode models prismer` →
 * `prismer/<model>`). The profile model must be the qualified id
 * `prismer/<gateway-model>` so opencode's parseModel routes to this provider.
 */
function writeOpenCodeProviderConfig(
  baseURL: string,
  apiKey: string,
  model: string | undefined,
  runId: string | undefined,
): string {
  // The profile model arrives qualified (`prismer/<model>`); strip the provider
  // prefix to get the bare gateway model id that keys the `models` map.
  const bareModel = (model && model.includes("/") ? model.split("/").slice(1).join("/") : model) ||
    "gemini-3.1-flash-lite-preview";
  // desktop202/20 — @ai-sdk/openai-compatible passes `options.headers` onto every
  // request, so the gateway receives the run id and records routing outcome.
  const options: { baseURL: string; apiKey: string; headers?: Record<string, string> } = {
    baseURL,
    apiKey,
  };
  if (runId) options.headers = { [RUN_ID_HEADER]: runId };
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPENCODE_CUSTOM_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Prismer Gateway",
        options,
        models: { [bareModel]: {} },
      },
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "paseo-opencode-config-"));
  const path = join(dir, "opencode.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

/**
 * Scrub the Claude parent-session env vars from an injection env map (doc 08
 * §7.6 ②). When the daemon process is itself a Claude Code session the
 * CLAUDECODE / CLAUDE_CODE_* vars would leak into spawned providers and corrupt
 * session resolution. The paseo-env shim does this for the full spawn env; we
 * keep our launchEnv overlay clean too so a parent var never re-enters via the
 * overlay (overlays win over baseEnv in createExternalProcessEnv).
 */
function scrubParentSessionEnv(env: Record<string, string>): void {
  for (const key of PARENT_SESSION_ENV_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (PARENT_SESSION_ENV_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
  }
}

/**
 * Build the per-provider Prismer cloud-gateway injection for a Paseo session.
 *
 * Returns null when routing is NOT requested or the required env is missing
 * (degrade to the official endpoint — same contract as the legacy adapters).
 *
 *   claude   → { ANTHROPIC_BASE_URL, ANTHROPIC_API_BASE, ANTHROPIC_AUTH_TOKEN }
 *              (daemon-local BYOK anthropic profile → ANTHROPIC_API_KEY instead of
 *               AUTH_TOKEN — direct api.anthropic.com takes x-api-key, not Bearer)
 *   codex    → writes CODEX_HOME/config.toml [model_providers.prismer]; env={CODEX_HOME}
 *   opencode → { OPENAI_BASE_URL, OPENAI_API_KEY, OPENCODE_CONFIG }; writes an
 *              opencode.json declaring a custom OpenAI-compatible provider
 *              `prismer` listing OUR gateway model (WS-B2.6) so opencode accepts
 *              the model id and routes through the gateway.
 *   pi-core  → { PRISMER_PI_BASE_URL, PRISMER_PI_API_KEY, PRISMER_PI_MODEL };
 *              the in-process Pi adapter builds a `@earendil-works/pi-ai`
 *              OpenAI Responses provider from these values.
 *
 * `metadata` is the task metadata used to apply the PRISMER_* scope env
 * (workspace / task / agent / scratch ids) onto the injection.
 */
export function buildProviderProxyInjection(
  provider: string,
  config: CodeAgentProxyConfig,
  metadata: Record<string, unknown> | undefined,
): ProviderProxyInjection | null {
  let env: Record<string, string> = {};
  let codexHome: string | undefined;
  let opencodeConfigPath: string | undefined;
  // desktop202/20 — stable dispatch run id stamped onto LLM calls (codex/opencode
  // only — claude routes through the Anthropic proxy which has no chain-fallback
  // / vision-filter concept, so there is nothing for it to record).
  const runId = dispatchRunId(metadata);
  // Resolved gateway base_url for this provider — used to compute NO_PROXY so
  // the agent's HTTP client bypasses any HTTP_PROXY/ALL_PROXY/system proxy for
  // the gateway host (see NO_PROXY block below).
  let resolvedBaseUrl: string | undefined;
  // What the injection actually points at — the gateway, or (claude + a
  // daemon-local BYOK profile) the provider directly. Used only for the log line,
  // which otherwise claims "cloud gateway" for a BYOK direct-connect.
  let routedVia = 'cloud gateway';

  switch (provider) {
    case "claude": {
      // Share the claude-code adapter's resolver verbatim — no fork.
      const ccConfig = {
        route: config.route ?? "default",
        proxyProvider: config.proxyProvider,
        prismerApiKeyEnv: config.prismerApiKeyEnv ?? "PRISMER_API_KEY",
      } as ClaudeCodeConfig;
      const resolved = resolveClaudeCodePrismerProvider(ccConfig);
      if (!resolved) return null;
      // G4 (doc 08 §7.7): claude CLI reads ANTHROPIC_BASE_URL; set ANTHROPIC_API_BASE
      // too for compat with any tooling that still consults the legacy name.
      env.ANTHROPIC_BASE_URL = resolved.baseUrl;
      env.ANTHROPIC_API_BASE = resolved.baseUrl;
      // desktop202/12 §2 — the resolver tells us WHICH auth header this endpoint
      // takes: the cloud gateway validates `Authorization: Bearer sk-prismer-*`
      // (ANTHROPIC_AUTH_TOKEN); a daemon-local BYOK anthropic profile direct-connects
      // to api.anthropic.com, which takes `x-api-key: sk-ant-*` (ANTHROPIC_API_KEY).
      // Injecting the wrong one is a 401, so never guess — honor authMode.
      if (resolved.authMode === 'api-key') {
        env.ANTHROPIC_API_KEY = resolved.apiKey;
      } else {
        env.ANTHROPIC_AUTH_TOKEN = resolved.apiKey;
      }
      if (resolved.local) routedVia = `local provider profile (${resolved.baseUrl})`;
      resolvedBaseUrl = resolved.baseUrl;
      break;
    }
    case "codex": {
      const codexConfig = {
        proxyProvider: config.proxyProvider,
        prismerApiKeyEnv: config.prismerApiKeyEnv ?? "PRISMER_API_KEY",
      } as CodexConfig;
      const resolved = resolveCodexPrismerProvider(codexConfig);
      if (!resolved) return null;
      // Reuse the codex adapter's config.toml writer (model_provider="prismer",
      // base_url=<base>/api/v1). Codex reads CODEX_HOME from its process env.
      codexHome = mkdtempSync(join(tmpdir(), "paseo-codex-home-"));
      writeCodexPrismerHome(
        codexHome,
        config.model ?? "gpt-5-codex",
        resolved,
        runId ? { [RUN_ID_HEADER]: runId } : undefined,
      );
      // release203 — seed the canonical coding skill set into CODEX_HOME/skills
      // so codex's `skills/list` surfaces the SAME skills claude-code gets from
      // `<cwd>/.claude/skills` (probe-verified location). Without this, codex saw
      // only its bundled skills → the codex↔claude-code slash inconsistency.
      try {
        const r = installCodingSkills(join(codexHome, "skills"));
        if (r) {
          process.stderr.write(
            `[provider-proxy-env] codex skills reconciled → ${codexHome}/skills (installed=${r.installed} removed=${r.removed})\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`[provider-proxy-env] codex skill seed failed: ${(err as Error).message}\n`);
      }
      env.CODEX_HOME = codexHome;
      resolvedBaseUrl = resolved.baseUrl;
      break;
    }
    case "opencode": {
      // OpenCode speaks the OpenAI-compatible wire; reuse the codex chain
      // resolver to get the same <base>/api/v1[/proxy/<chain>] + key, then map
      // to the OpenAI env vars the opencode server reads from its environment.
      const codexConfig = {
        proxyProvider: config.proxyProvider,
        prismerApiKeyEnv: config.prismerApiKeyEnv ?? "PRISMER_API_KEY",
      } as CodexConfig;
      const resolved = resolveCodexPrismerProvider(codexConfig);
      if (!resolved) return null;
      // Env injection alone is insufficient: opencode's built-in `openai`
      // provider rejects our gateway model ids (not in the models.dev catalog).
      // We additionally emit an opencode.json declaring a CUSTOM
      // OpenAI-compatible provider (`prismer`) that lists OUR gateway model, and
      // point opencode at it via OPENCODE_CONFIG. The profile model must be the
      // qualified id `prismer/<model>` so opencode routes to this provider.
      env.OPENAI_BASE_URL = resolved.baseUrl;
      env.OPENAI_API_KEY = resolved.apiKey;
      opencodeConfigPath = writeOpenCodeProviderConfig(
        resolved.baseUrl,
        resolved.apiKey,
        config.model,
        runId,
      );
      env.OPENCODE_CONFIG = opencodeConfigPath;
      resolvedBaseUrl = resolved.baseUrl;
      break;
    }
    case "pi-core": {
      const codexConfig = {
        proxyProvider: config.proxyProvider,
        prismerApiKeyEnv: config.prismerApiKeyEnv ?? "PRISMER_API_KEY",
      } as CodexConfig;
      // Local provider profiles (BYOK / third-party direct-connect, "local:<id>")
      // resolve first and carry their own wire kind; the cloud chain keeps the
      // OpenAI Responses wire. pi-core supports both — PRISMER_PI_API tells the
      // adapter which pi-ai api module to build.
      //
      // GATE: pi-core only serves the types its embedded engine speaks
      // (anthropic-messages / openai-responses). chat-completions-only types
      // (ollama) would be wired to a wire the endpoint does not serve → silent
      // runtime break, so we DECLINE the direct-connect and fall through to the
      // cloud chain (the gateway IS the chat_completions bridge), same shape as
      // codexSupportsLocalType in the codex resolver.
      const local = resolveLocalProvider(config.proxyProvider);
      if (local && piCoreSupportsLocalType(local.type)) {
        env.PRISMER_PI_BASE_URL = piCoreWireBaseUrl(local);
        env.PRISMER_PI_API_KEY = local.apiKey ?? "";
        env.PRISMER_PI_PROVIDER = local.profileId;
        env.PRISMER_PI_API = piCoreApiForType(local.type);
        resolvedBaseUrl = env.PRISMER_PI_BASE_URL;
      } else {
        if (local) {
          process.stderr.write(
            `[provider-proxy-env] local provider '${local.profileId}' (type=${local.type}) is not pi-core-compatible ` +
              `(chat-completions-only); falling back to the cloud chain.\n`,
          );
        }
        const resolved = resolveCodexPrismerProvider(codexConfig);
        if (!resolved) return null;
        env.PRISMER_PI_BASE_URL = resolved.baseUrl;
        env.PRISMER_PI_API_KEY = resolved.apiKey;
        env.PRISMER_PI_PROVIDER = "prismer";
        env.PRISMER_PI_API = "openai-responses";
        resolvedBaseUrl = resolved.baseUrl;
      }
      if (config.model) {
        env.PRISMER_PI_MODEL = config.model.includes("/")
          ? config.model.split("/").slice(1).join("/")
          : config.model;
      }
      break;
    }
    default:
      // Unknown provider — no proxy injection (ACP/cursor/copilot handle their
      // own auth; this helper only covers the first-class code agents).
      return null;
  }

  // PROVEN root-cause fix (2026-06-18): the agent's HTTP client (codex/reqwest,
  // and equally any client that honors HTTP_PROXY/ALL_PROXY/system proxy) routes
  // a loopback gateway call through a local HTTP proxy (e.g. Clash 127.0.0.1:7897)
  // which fails to relay → 502 / hang. Setting NO_PROXY (+ lowercase no_proxy)
  // for localhost + the gateway host makes the client connect DIRECTLY. This is
  // robustness for ANY HTTP-proxy egress env, not just local dev, so we apply it
  // to all three routed providers. Mirrors the existing CLI codex adapter
  // (buildCodexNoProxy + NO_PROXY merge in codex/index.ts).
  const noProxy = buildCodexNoProxy(resolvedBaseUrl ?? "http://localhost");
  env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${noProxy}` : noProxy;
  env.no_proxy = env.no_proxy ? `${env.no_proxy},${noProxy}` : noProxy;

  // PRISMER_* scope env (workspace / task / agent / scratch ids), shared helper.
  applyPrismerScopeEnv(env as Record<string, string | undefined>, metadata);
  // Drop any undefined values applyPrismerScopeEnv may have left as holes.
  for (const k of Object.keys(env)) {
    if (env[k] == null) delete env[k];
  }
  // Claude parent-session env scrub (doc 08 §7.6 ②).
  scrubParentSessionEnv(env);

  console.log(
    `${MODULE} provider=${provider} routed via ${routedVia} (keys=${Object.keys(env).join(",")})`,
  );
  return { env, codexHome, opencodeConfigPath };
}
