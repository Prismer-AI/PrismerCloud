// Desktop-202 Phase 7 (docs/desktop202/12-llm-provider-direct.md) — local
// provider direct-connect layer (BYOK + Ollama).
//
// This is the ONE place the daemon's local provider profiles are modeled and
// resolved. The hermes/codex adapters' existing base_url resolvers
// (`resolvePrismerProviderBaseUrl`, `resolveCodexPrismerProvider`) consult
// `resolveLocalProvider()` as the MIDDLE layer of doc §2's priority:
//
//   1. agent-level explicit pin            (existing — operator base_url override)
//   2. ★ daemon local provider profile     (THIS module — BYOK / Ollama)
//   3. cloud proxy chain default           (existing — /api/v1/proxy/<chain>)
//
// 铁律 (backward compat): this layer exists ONLY when a matching local profile
// is configured in ~/.prismer/config.toml `[[providers]]`. With no profiles
// (CLI / K8s daemon / web), `resolveLocalProvider()` returns null and the
// adapter resolvers fall through to the EXISTING cloud-chain path byte-for-byte.
//
// Keys are NEVER stored in config.toml — only a `key_ref` (keychain reference).
// The renderer/electron-main keychain (safeStorage) read/write lands in the
// SECOND wave (doc §2a, §7). This module only defines the `resolveKeyRef`
// injection point so the runtime can turn a `key_ref` into an actual key.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Profile model (config.toml `[[providers]]` — doc §2a)
// ---------------------------------------------------------------------------

/** Direct-connect provider families the daemon can route to (doc §2a). */
export const PROVIDER_PROFILE_TYPES = [
  'anthropic',
  'openai',
  'deepseek',
  'ollama',
  'openai-compatible',
] as const;

export type ProviderProfileType = (typeof PROVIDER_PROFILE_TYPES)[number];

/** Default public base_url per provider type. Empty = caller must supply. */
const DEFAULT_BASE_URL: Record<ProviderProfileType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  ollama: 'http://127.0.0.1:11434',
  // openai-compatible has no canonical default — base_url is required (refined below).
  'openai-compatible': '',
};

/** Ollama does not use an API key. */
export function providerTypeRequiresKey(type: ProviderProfileType): boolean {
  return type !== 'ollama';
}

export const ProviderProfileSchema = z
  .object({
    /** Stable profile id. Also the value selected via `proxyProvider` (doc §3 union). */
    id: z.string().min(1),
    type: z.enum(PROVIDER_PROFILE_TYPES),
    /**
     * Provider endpoint base. Empty/omitted falls back to the official default
     * for the type (see DEFAULT_BASE_URL). REQUIRED for `openai-compatible`
     * (no canonical endpoint — doc §2a "兜底型").
     */
    base_url: z.string().url().optional(),
    /**
     * Keychain reference (e.g. `keychain:<id>`). Config NEVER stores the plain
     * key (doc §2a). Resolved to an actual key via `resolveKeyRef` (electron
     * keychain wired in the second wave). Omitted for Ollama (no key).
     */
    key_ref: z.string().min(1).optional(),
    /** Model allowlist — UI dropdown source. First entry is the default model. */
    models: z.array(z.string().min(1)).optional(),
    /** Capability metadata: vision-capable (feeds vision-gated image input). */
    vision: z.boolean().optional(),
    /** Capability metadata: max context window (tokens). */
    max_context: z.number().int().positive().optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.type === 'openai-compatible' && !profile.base_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base_url'],
        message: "base_url is required for type 'openai-compatible'",
      });
    }
  });

export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/** The effective base_url for a profile — explicit value or the type default. */
export function effectiveBaseUrl(profile: ProviderProfile): string {
  const explicit = profile.base_url?.replace(/\/$/, '');
  if (explicit) return explicit;
  return DEFAULT_BASE_URL[profile.type].replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Wire-format adaptation (Phase 7 second wave — doc §2 "adapter 仍然吃 base_url
// + api_key + model")
// ---------------------------------------------------------------------------
//
// The resolver hands an adapter base_url + key + model, but the WIRE PROTOCOL
// differs per provider family and is NOT the same as the cloud-chain default
// (hermes → chat_completions, codex → responses). A BYOK direct-connect only
// actually works if the adapter speaks the protocol the provider's endpoint
// serves. This module maps `profile.type` → the concrete wire mode each adapter
// must select, and records the cases an adapter CANNOT serve natively (caller
// falls back to the cloud chain instead of crashing at runtime).

/**
 * Hermes `custom_providers[].api_mode` (hermes_cli/config.py: "chat_completions"
 * | "codex_responses" | "anthropic_messages"). Hermes natively speaks the
 * Anthropic Messages wire protocol, so a BYOK Anthropic key direct-connects.
 */
export type HermesApiMode = 'chat_completions' | 'anthropic_messages';

/**
 * The hermes `api_mode` for a local provider type:
 *   - anthropic           → `anthropic_messages` (Anthropic Messages API, native)
 *   - openai / deepseek /
 *     ollama / openai-     → `chat_completions` (OpenAI-compatible; Ollama via its
 *     compatible             `/v1/chat/completions` shim — see hermesWireBaseUrl)
 *
 * Hermes serves ALL five types — the Anthropic case is the one the cloud chain
 * never needed. No hermes limitation for the supported set.
 */
export function hermesApiModeForType(type: ProviderProfileType): HermesApiMode {
  return type === 'anthropic' ? 'anthropic_messages' : 'chat_completions';
}

/**
 * The base_url hermes should write for a resolved local provider. Ollama's chat
 * endpoint lives under the OpenAI-compatible `/v1` prefix (`/v1/chat/completions`),
 * NOT the native `/api/chat` — using `/v1` is the most direct path that fits
 * hermes' `chat_completions` mode without a custom transport. All other types
 * already expose their wire surface at the resolved base_url verbatim.
 */
export function hermesWireBaseUrl(resolved: ResolvedLocalProvider): string {
  if (resolved.type === 'ollama') {
    const base = resolved.baseUrl.replace(/\/$/, '');
    return base.endsWith('/v1') ? base : `${base}/v1`;
  }
  return resolved.baseUrl;
}

/**
 * Codex CLI is RESPONSES-ONLY (`wire_api = "responses"`, codex-cli ≥ v0.133).
 * It can only direct-connect to a provider whose endpoint serves the OpenAI
 * Responses API. Among the local types only the official OpenAI endpoint does;
 * Ollama / DeepSeek / generic openai-compatible expose chat_completions (not
 * responses) and Anthropic speaks a different protocol entirely.
 *
 * Returns true ONLY for types codex can natively reach. For everything else the
 * codex adapter must NOT write the BYOK provider (it would 404/400 at runtime) —
 * caller falls back to the cloud chain. This is the documented Phase-7 codex
 * limitation; BYOK on codex is OpenAI-only until a chat_completions↔responses
 * bridge exists (today that bridge IS the cloud gateway we'd be bypassing).
 */
export function codexSupportsLocalType(type: ProviderProfileType): boolean {
  return type === 'openai';
}

/**
 * Claude Code speaks the ANTHROPIC MESSAGES wire and nothing else: its client
 * appends `/v1/messages` to `ANTHROPIC_BASE_URL` and sends Anthropic-shaped
 * request/response bodies. A local profile can therefore only be direct-connected
 * when its endpoint serves that wire — among the local types that is ONLY
 * `anthropic` (api.anthropic.com, or a BYOK-pinned Anthropic-compatible base_url
 * declared as `type='anthropic'`).
 *
 * `openai` / `deepseek` / `ollama` / `openai-compatible` all serve
 * `chat_completions` (OpenAI wire). Pointing CC at them would POST an Anthropic
 * body to `/v1/messages` and 404/400 at runtime — the failure would surface as a
 * broken agent, not as a config error, so we DECLINE the direct-connect (stderr
 * warning + cloud-chain fallback) rather than silently mis-wiring. The cloud
 * gateway IS the Anthropic↔chat bridge those types need; bypassing it is exactly
 * what removes the translation. Same shape as `codexSupportsLocalType`.
 */
export function claudeCodeSupportsLocalType(type: ProviderProfileType): boolean {
  return type === 'anthropic';
}

/**
 * pi-core speaks two wires through its embedded pi-ai provider surface:
 * Anthropic Messages (`anthropic`/`deepseek` types) and OpenAI Responses
 * (`openai` / `openai-compatible`). chat-completions-only `ollama` is not
 * directly supported by the embedded engine.
 */
export function piCoreSupportsLocalType(type: ProviderProfileType): boolean {
  return type === 'anthropic' || type === 'deepseek' || type === 'openai' || type === 'openai-compatible';
}

/**
 * The pi-ai wire kind pi-core should speak for a resolved local provider.
 * Mirrors `hermesApiModeForType` but for the engine's native api modules.
 */
export function piCoreApiForType(type: ProviderProfileType): 'anthropic-messages' | 'openai-responses' {
  return type === 'anthropic' || type === 'deepseek' ? 'anthropic-messages' : 'openai-responses';
}

/**
 * The base_url pi-core should write for a resolved local provider. deepseek's
 * Anthropic-compatible wire lives under the `/anthropic` suffix of the
 * configured base (default `https://api.deepseek.com`); every other type
 * exposes its wire at the resolved base_url verbatim.
 */
export function piCoreWireBaseUrl(resolved: ResolvedLocalProvider): string {
  if (resolved.type === 'deepseek' && !/\/anthropic$/.test(resolved.baseUrl)) {
    const base = resolved.baseUrl.replace(/\/$/, '');
    return `${base}/anthropic`;
  }
  return resolved.baseUrl;
}

// ---------------------------------------------------------------------------
// Key resolution injection point (doc §2a — electron keychain second wave)
// ---------------------------------------------------------------------------

/**
 * Turn a `key_ref` into an actual secret. The runtime never reads the macOS
 * keychain directly — that's the electron main process's job (safeStorage),
 * landing in the SECOND wave (doc §2a / §7). Until then the runtime resolves a
 * `key_ref` via either:
 *   1. an injected resolver (`setKeyRefResolver`, e.g. electron IPC bridge), or
 *   2. an env fallback: `key_ref = "keychain:my-anthropic"` → env
 *      `PRISMER_PROVIDER_KEY_my_anthropic` (non-`[A-Za-z0-9_]` → `_`).
 *
 * Returns null when the ref can't be resolved (key not yet set / Ollama).
 */
export type KeyRefResolver = (keyRef: string) => string | null;

let injectedKeyRefResolver: KeyRefResolver | null = null;

/**
 * Inject the keychain-backed resolver. The electron main process calls this at
 * daemon boot (second wave) so `resolveKeyRef` reaches safeStorage. Passing
 * null restores the env-only fallback (tests / headless daemon).
 */
export function setKeyRefResolver(resolver: KeyRefResolver | null): void {
  injectedKeyRefResolver = resolver;
}

/** Env var name a `keychain:<id>` ref maps to in the fallback path. */
export function keyRefEnvVar(keyRef: string): string {
  const id = keyRef.startsWith('keychain:') ? keyRef.slice('keychain:'.length) : keyRef;
  return `PRISMER_PROVIDER_KEY_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/**
 * Resolve a `key_ref` to a secret. Injected resolver wins; otherwise env
 * fallback (`PRISMER_PROVIDER_KEY_<id>`). Returns null when unresolved.
 */
export function resolveKeyRef(keyRef: string | undefined | null): string | null {
  if (!keyRef) return null;
  if (injectedKeyRefResolver) {
    const fromInjected = injectedKeyRefResolver(keyRef);
    if (fromInjected) return fromInjected;
  }
  const envVal = process.env[keyRefEnvVar(keyRef)];
  return envVal && envVal.length > 0 ? envVal : null;
}

// ---------------------------------------------------------------------------
// Resolution layer (doc §2 — middle priority)
// ---------------------------------------------------------------------------

/** A resolved local provider: everything an adapter needs to connect directly. */
export interface ResolvedLocalProvider {
  profileId: string;
  type: ProviderProfileType;
  /** Connect base_url (explicit or type default), no trailing slash. */
  baseUrl: string;
  /** Resolved secret, or null for keyless (Ollama) / unresolved. */
  apiKey: string | null;
  /** Capability metadata (undefined = unknown → trust upstream). */
  vision: boolean | undefined;
  maxContext: number | undefined;
  /** Model allowlist (first = default), or undefined. */
  models: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Daemon-config profile source (injected — keeps adapters out of daemon wiring)
// ---------------------------------------------------------------------------

let injectedLocalProviders: ProviderProfile[] | null = null;

/**
 * Register the daemon's configured `[[providers]]` (from ~/.prismer/config.toml)
 * so the adapter resolvers can consult them WITHOUT importing the daemon
 * Config. The daemon (DaemonRunner boot) calls this once after `loadConfig()`;
 * desktop-only — CLI / K8s daemon never set it, so resolution is unchanged.
 *
 * Passing null/[] clears the source (tests / non-desktop daemons).
 */
export function setLocalProviders(profiles: ProviderProfile[] | null | undefined): void {
  injectedLocalProviders = profiles && profiles.length > 0 ? profiles : null;
}

/** Current injected profiles (or null). Mainly for the adapter resolvers. */
export function getLocalProviders(): ProviderProfile[] | null {
  return injectedLocalProviders;
}

/**
 * The `proxyProvider` namespace marker for a desktop-LOCAL provider profile.
 *
 * The cloud validator (`validateProxyProvider`, `src/im/api/agent-profiles.ts`)
 * rejects any `proxyProvider` it doesn't recognise, and it structurally CANNOT
 * recognise a local profile id — those exist only in this machine's
 * `config.toml`. Before the prefix, writing a local profile id to an agent
 * profile 400'd (`invalid_proxy_provider`), so the desktop pickers offered
 * selections that could never be persisted. `local:` makes the value
 * self-describing: the cloud accepts it on shape alone (zero knowledge of which
 * profiles exist) while still rejecting bare typo'd chain ids.
 *
 * LAYER RULE: runtime/ cannot import src/, so `src/lib/llm/local-provider-ref.ts`
 * holds the cloud-side copy of this constant. KEEP THE STRING IN SYNC.
 */
export const LOCAL_PROVIDER_PREFIX = 'local:';

/** True when a selector explicitly declares a desktop-local provider profile. */
export function isLocalProviderSelector(selector: string | undefined | null): boolean {
  return typeof selector === 'string' && selector.startsWith(LOCAL_PROVIDER_PREFIX);
}

/**
 * The local profile id a selector names: `local:<id>` → `<id>`; anything else
 * verbatim (bare profile ids resolved before the prefix existed and still do).
 */
export function localProviderProfileId(selector: string): string {
  return isLocalProviderSelector(selector) ? selector.slice(LOCAL_PROVIDER_PREFIX.length) : selector;
}

/**
 * The MIDDLE layer of doc §2's resolution priority.
 *
 * Given the agent's `proxyProvider` selector (the existing release202/07 seam
 * that also names cloud chains) and the daemon's configured `[[providers]]`,
 * return the matching LOCAL profile — or null to fall through to the existing
 * cloud-chain path.
 *
 * Matching rule: the selector's profile id (`local:<id>` → `<id>`, else the
 * selector verbatim) equals `profile.id`. Local profile ids and cloud chain ids
 * share the `proxyProvider` namespace (doc §3: "下拉选项 = cloud chain ∪ 本地
 * profiles"); the `local:` prefix disambiguates them for the CLOUD's benefit
 * (see LOCAL_PROVIDER_PREFIX). Both forms resolve here so a profile written
 * before the prefix existed keeps working. A selector that matches no local
 * profile (the default `newapi` / any cloud chain id) → null → existing
 * behaviour, byte for byte.
 *
 * Returns null (never throws) when:
 *   - selector is empty / a reserved cloud-chain alias (`newapi` / `default`)
 *   - no profile id matches the selector
 *   - a non-Ollama profile's key can't be resolved (we must NOT silently
 *     direct-connect without a key; caller falls back to the cloud chain)
 */
export function resolveLocalProvider(
  selector: string | undefined | null,
  profiles?: ProviderProfile[] | null,
): ResolvedLocalProvider | null {
  if (!selector) return null;
  const explicitlyLocal = isLocalProviderSelector(selector);
  const profileId = localProviderProfileId(selector);
  if (!profileId) return null;
  // The reserved-alias short-circuit applies to BARE selectors only: `newapi` /
  // `default` are cloud chains. An explicit `local:newapi` is a local profile a
  // user happened to name that way, and the prefix says so unambiguously.
  if (!explicitlyLocal && (profileId === 'newapi' || profileId === 'default')) return null;
  // Default to the daemon-injected profiles when the caller omits an explicit
  // list (the adapter-resolver path). Explicit [] / list still wins (tests).
  const source = profiles === undefined ? injectedLocalProviders : profiles;
  if (!source || source.length === 0) return null;

  const profile = source.find((p) => p.id === profileId);
  if (!profile) return null;

  let apiKey: string | null = null;
  if (providerTypeRequiresKey(profile.type)) {
    apiKey = resolveKeyRef(profile.key_ref);
    if (!apiKey) {
      // Key not yet provisioned (keychain second wave / env unset). Refuse to
      // direct-connect keyless — fall back to the cloud chain instead.
      return null;
    }
  }

  return {
    profileId: profile.id,
    type: profile.type,
    baseUrl: effectiveBaseUrl(profile),
    apiKey,
    vision: profile.vision,
    maxContext: profile.max_context,
    models: profile.models,
  };
}

// ---------------------------------------------------------------------------
// Ollama probe (doc §2a — Preferences auto-detect)
// ---------------------------------------------------------------------------

export interface OllamaProbeResult {
  available: boolean;
  models: string[];
  /** Populated when the probe failed (network / non-200). */
  error?: string;
}

/**
 * Probe a local Ollama daemon for its installed models via `GET /api/tags`
 * (doc §2a). A runtime util; the Preferences UI (second wave) calls it through
 * the daemon. Never throws — failures surface as `{ available: false, error }`.
 */
export async function probeOllama(
  baseUrl = 'http://127.0.0.1:11434',
  timeoutMs = 2_000,
): Promise<OllamaProbeResult> {
  const base = baseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { available: false, models: [], error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(body.models)
      ? body.models
          .map((m) => (typeof m?.name === 'string' ? m.name : null))
          .filter((n): n is string => !!n)
      : [];
    return { available: true, models };
  } catch (err) {
    return {
      available: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
