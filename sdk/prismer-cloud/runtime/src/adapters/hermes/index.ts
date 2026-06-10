// Hermes adapter — HTTP-only client of the user's `hermes gateway`.
//
// runtime/ stays TS-only: no spawn('python', ...), no PyPI package, no stdio
// JSON-RPC. Hermes runs in the user's own Python venv; we just speak its
// OpenAI-compatible HTTP API on http://127.0.0.1:8642 (default port).
//
// Endpoint surface this adapter actually calls (release201/25 §16.4 A3, 2026-05-29):
//   POST /api/sessions/{id}/chat/stream — primary dispatch (text + multimodal),
//                                         single SSE stream, server-side history.
//                                         Implemented in sessions-dispatcher.ts.
//   POST /api/sessions                  — session creation (sessions-mapper.ts).
//   POST /v1/runs/{id}/stop             — best-effort cancellation (no sessions
//                                         API equivalent yet).
//   POST /v1/runs/{id}/approval         — §16.4 A6 native HITL approval forward.
//   GET  /v1/capabilities               — §16.4 A4 startup capability gate.
//   GET  /health                        — bearer-auth probe.
//
// The legacy `POST /v1/runs` + `POST /v1/chat/completions` dispatch paths
// were removed once A1 sessions-API (commit 5769d04b) stabilised in
// dev:local. Multimodal travels through the same sessions endpoint as text
// (image_url blocks in the `message` array).
//
// Hermes Kanban/Goals are native local state surfaces (CLI/SQLite/tool gated),
// not HTTP REST bridge URLs. Prismer keeps /api/im/tasks canonical and mirrors
// native state explicitly in later bridge work.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as YAML from 'yaml';
import { z } from 'zod';
import type {
  AdapterDef,
  AdapterService,
  AgentProfile,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from '../contract.js';
import { categorizeDispatchError } from '../contract.js';
import { getCapabilitySnapshot } from '../../daemon/capabilities.js';
import { HermesSkillLoader } from './skill-loader.js';
import { getRunSessionRegistry } from '../../daemon/memory/run-session-map.js';
import { getHermesSessionMapper } from './sessions-mapper.js';
import { deriveExecutionContext, dispatchViaSessions } from './sessions-dispatcher.js';
import { dispatchViaRuns } from './runs-dispatcher.js';
import { deriveDispatchKind } from './flag.js';
import { CONVERSATION_CONTEXT_SCHEMA_DOC } from '../../daemon/conversation-context-schema-doc.js';
import { isVersionInRange, parseVersionFromStdout } from '../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../known-versions.js';

/**
 * Tested-good hermes binary version range (Release 201 v2.0.7 P1).
 *
 * `health()` probes `hermes --version`, parses the result, and warns when
 * the detected version drifts below MIN_VERSION or away from KNOWN_GOOD.
 * Update both pins (and `known-versions.ts`) when a new upstream rev is
 * exercised by the cookbook + CI smoke pass.
 */
const HERMES_MIN_VERSION = ADAPTER_KNOWN_VERSIONS.hermes!.minVersion;
const HERMES_KNOWN_GOOD = ADAPTER_KNOWN_VERSIONS.hermes!.knownGood;

/**
 * release201/26 §13.4a — per-model vision allowlist (evidence-based default).
 *
 * Empirically verified 2026-05-30 against the LIVE cloud proxy
 * (`/api/v1/proxy/{newapi,deepseek}/chat/completions`). Two rounds:
 *
 *   ROUND 1 (sanity): solid-green 64x64 PNG → name the color. Probe:
 *     `scripts/spike/model-vision-probe.ts`. All 3 returned "Green" — but a
 *     green guess proves little (1 obvious color, leading prompt).
 *   ROUND 2 (STRONG, authoritative): a real content-rich screenshot
 *     (`public/截屏 2026-05-02 23.39.31.png`, an Apple Music home screen) with an
 *     OPEN-ENDED non-leading prompt ("描述你看到的内容" — no "music" hint). A model
 *     can only pass by naming concrete on-screen content impossible to guess
 *     blind. Probe: `scripts/spike/model-vision-probe-screenshot.ts`, 2
 *     runs/model. All 3 named Apple Music + 健身嘻哈 + 跑步者 + artists
 *     (Kacey Musgraves / Conan Gray / Niklas Paschburg) + now-playing
 *     (Glass Harbor / Acoustic Labs), zero hallucinations:
 *
 *   gemini-3.1-pro-preview         PASS  (newapi)  HTTP 200, named Apple Music
 *   gemini-3.1-flash-lite-preview  PASS  (newapi)  HTTP 200, named Apple Music
 *   us-kimi-k2.6                   PASS  (newapi)  HTTP 200, named Apple Music
 *                                  (reasoning model — needs max_tokens>=2000 so
 *                                   reasoning_content doesn't starve content)
 *
 * Explicitly NOT vision-capable (kept OFF the allowlist → default false):
 *   deepseek-v4-flash  FAIL  (deepseek)  HTTP 400 "unknown variant `image_url`,
 *                                        expected `text`" — DeepSeek's API
 *                                        rejects image parts at the wire level.
 *                                        Text-only requests succeed, so this is
 *                                        a definitive no-vision verdict, not a
 *                                        transient/funnel-down inconclusive.
 *   deepseek-v4-pro    FAIL  (deepseek)  same HTTP 400 image_url rejection.
 *
 * This REPLACES the prior `proxyProvider === 'deepseek' ? false : true`
 * heuristic: the default is now per-model exact, not a coarse provider guess.
 * An operator-supplied `config.supportsVision` still wins for any model not yet
 * measured (or to override). INCONCLUSIVE models (none in this round) are kept
 * OFF the allowlist (conservative default false; operator can opt in).
 *
 * LAYER RULE: runtime/ cannot import src/, so this is an independent copy of the
 * vision flags in `src/app/api/models/curated-models.ts`. KEEP IN SYNC — when a
 * model's `vision` flag changes there, update this set too.
 */
const VISION_CAPABLE_MODELS = new Set<string>([
  'gemini-3.1-pro-preview', // 2026-05-30 strong test — named Apple Music screenshot
  'gemini-3.1-flash-lite-preview', // 2026-05-30 strong test — named Apple Music screenshot
  'us-kimi-k2.6', // 2026-05-30 strong test — named Apple Music screenshot (reasoning model)
]);

/**
 * release202/04 §3.3 P3 — effective vision capability for a model id. Same
 * resolution as the config builder (`config.supportsVision ?? allowlist`),
 * extracted so the sessions dispatch path can surface it in
 * `<execution_context><model supports_vision=…>` without re-deriving the rule.
 */
function resolveSupportsVision(model: string, explicit: boolean | undefined): boolean {
  return explicit ?? VISION_CAPABLE_MODELS.has(model);
}

/**
 * Hermes-native platform skill. Installed under
 * `<profileDir>/skills/prismer-im-collab/SKILL.md` on every dispatch so
 * Hermes' skill system loads it without colluding the identity slot (SOUL.md)
 * with how-to guidance. SOUL.md remains per-agent persona only.
 *
 * Idempotent: every dispatch rewrites the file so the runtime version stays
 * authoritative even if a user deleted it.
 *
 * Source of truth: `sdk/prismer-cloud/built-in-skills/prismer-im-collab/SKILL.md`.
 * Build pipeline mirrors that directory into `runtime/built-in-skills/` so the
 * npm tarball ships the same file the cloud-side `upsertBuiltInSkills` scanner
 * reads (see `runtime/scripts/prebuild-copy-built-in-skills.cjs`). At runtime
 * we read the on-disk copy via `readFileSync` instead of inlining the markdown
 * into a TS template literal — keeping the single source of truth honest.
 */
const PRISMER_IM_SKILL_NAME = 'prismer-im-collab';
const PRISMER_ROLE_SKILL_PREFIX = 'prismer-role';

/**
 * Resolve the on-disk path to the canonical `SKILL.md` for a built-in skill.
 *
 * Search order — first hit wins:
 *   1. `<package>/built-in-skills/<slug>/SKILL.md`  — npm tarball layout
 *      (prebuild script populates this; `__dirname` resolves to either
 *      `dist/` for the built bundle or `src/adapters/hermes/` for ts-node
 *      / vitest).
 *   2. Repo-canonical `sdk/prismer-cloud/built-in-skills/<slug>/SKILL.md`
 *      walked from this source file — used by vitest + dev runs where the
 *      mirror under `runtime/built-in-skills/` has not been populated.
 *
 * Returns `null` if no candidate exists. Callers must handle null —
 * `installPrismerImSkill` logs to stderr and falls through (best-effort).
 */
function resolveBuiltInSkillPath(slug: string): string | null {
  // Anchor: this file's directory, ESM-safe.
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS fallback (tsup emits dist/index.cjs alongside dist/index.js); the
    // bundled file gets a synthetic `import.meta.url`, but if that ever fails
    // we fall back to `__dirname` which CJS guarantees.
    here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  }

  // Candidate 1: npm tarball / dist layout — runtime/built-in-skills/ sits
  // next to dist/ in the installed package, or next to src/ during build.
  //   tarball:  /node_modules/@prismer/runtime/dist/index.js
  //             -> ../built-in-skills/<slug>/SKILL.md
  //   src dev:  /sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts
  //             -> ../../../built-in-skills/<slug>/SKILL.md (if prebuild ran)
  const tarballCandidates = [
    join(here, '..', 'built-in-skills', slug, 'SKILL.md'),               // dist/index.js anchor
    join(here, '..', '..', '..', 'built-in-skills', slug, 'SKILL.md'),   // src/adapters/hermes anchor → runtime/built-in-skills
  ];

  // Candidate 2: repo-canonical source — vitest / dev runs without prebuild.
  //   /sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts
  //   -> ../../../../built-in-skills/<slug>/SKILL.md
  const canonicalCandidate = join(here, '..', '..', '..', '..', 'built-in-skills', slug, 'SKILL.md');

  for (const candidate of [...tarballCandidates, canonicalCandidate]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cachedPrismerImSkillContent: string | null = null;
function getPrismerImSkillContent(): string | null {
  if (cachedPrismerImSkillContent !== null) return cachedPrismerImSkillContent;
  const skillPath = resolveBuiltInSkillPath(PRISMER_IM_SKILL_NAME);
  if (!skillPath) return null;
  try {
    cachedPrismerImSkillContent = readFileSync(skillPath, 'utf8');
    return cachedPrismerImSkillContent;
  } catch {
    return null;
  }
}

const HermesProfileConfigSchema = z.object({
  /** Hermes profile name (default: AgentProfile.id slice). */
  hermesProfileName: z.string().optional(),
  /** Hermes API server port. Distinct profiles use distinct ports to avoid clashes. */
  port: z.number().int().min(1).max(65_535).default(8642),
  /** Bearer token from `~/.hermes/.env API_SERVER_KEY`. */
  apiKey: z.string().min(1),
  /** Auto-spawn `hermes -p <name> gateway run` if not reachable. Default false. */
  autoStart: z.boolean().default(false),
  /** Wait timeout when autoStart=true. */
  startupTimeoutMs: z.number().int().positive().default(30_000),
  /**
   * Configure Hermes' inference provider to use Prismer Cloud's existing
   * OpenAI-compatible provider endpoint before starting the gateway.
   */
  configurePrismerProvider: z.boolean().default(true),
  /**
   * Auto-install the @prismer/mcp-server stdio MCP server into the Hermes
   * profile so the long-running role agent can drive Workspace tasks
   * (create / update / approve / move) through tool calls. Default true.
   */
  installPrismerMcpServer: z.boolean().default(true),
  /**
   * Override the absolute path to @prismer/mcp-server's `dist/index.js`.
   * If unset the adapter resolves it via Node's module resolver from the
   * runtime install location, then falls back to PRISMER_MCP_SERVER env.
   */
  prismerMcpServerPath: z.string().optional(),
  /** Model sent to Prismer's /api/v1/chat/completions endpoint. */
  model: z.string().min(1).default('us-kimi-k2.6'),
  /** Named custom provider written into Hermes config.yaml. */
  prismerProviderName: z.string().min(1).default('prismer'),
  /**
   * 2026-05-30 — per-agent LLM proxy selector.
   *
   * Picks which Prismer Cloud upstream pool this hermes profile points its
   * `chat/completions` calls at. Default `newapi` is the platform aggregator
   * (gemini / kimi / etc.). `deepseek` swaps the cloud-side `base_url` to the
   * `/api/v1/proxy/deepseek/chat/completions` alias so the cloud forwards the
   * request directly to DeepSeek regardless of the global
   * `DEEPSEEK_BYPASS_ENABLED` env. Lets two agents share a workspace + daemon
   * but route to different LLM backends for an apples-to-apples comparison.
   *
   * Resolution priority for `custom_providers[0].base_url`:
   *   1. `prismerProviderBaseUrl` (explicit operator override) — wins always.
   *   2. `proxyProvider === 'deepseek'` → PRISMER_BASE_URL + `/api/v1/proxy/deepseek`
   *   3. `proxyProvider === 'newapi'` (default) → PRISMER_BASE_URL + `/api/v1`
   */
  proxyProvider: z.string().min(1).optional().default('newapi'),
  /**
   * Override cloud provider base. Defaults to PRISMER_BASE_URL + /api/v1
   * (or `/api/v1/proxy/<proxyProvider>` when `proxyProvider !== 'newapi'`).
   * An explicit value here WINS over `proxyProvider` — operators who pin
   * the base_url get exactly what they pinned.
   */
  prismerProviderBaseUrl: z.string().url().optional(),
  /** Env key Hermes reads from profile .env for the Prismer API key. */
  prismerApiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('PRISMER_API_KEY'),
  /**
   * Mirror Prismer work_item projections into Hermes native Kanban as triage
   * cards. Triage avoids duplicate execution; Prismer's agent_run remains the
   * executable source of truth.
   */
  mirrorNativeKanban: z.boolean().default(true),
  /**
   * Mirror Prismer standing-objective IMTask projections into Hermes' native
   * per-session GoalManager state (`state.db.state_meta["goal:<session_id>"]`).
   * Hermes has no public goals REST/CLI surface; this writes the documented
   * native state key directly and records the exact bridge result on the task.
   */
  mirrorNativeGoals: z.boolean().default(true),
  nativeMirrorTimeoutMs: z.number().int().positive().default(2_000),
  /** Task authority level: executor (default) or orchestrator. */
  taskAuthority: z.enum(['executor', 'orchestrator']).optional().default('executor'),
  /** Human approval escalation policy. Enforcement is currently prompt/cloud-side. */
  approvalPolicy: z.enum(['strict', 'auto-low-risk', 'autonomous']).optional().default('auto-low-risk'),
  /** Agent-level MCP tool allowlist. Empty/null means all tools. Supports exact names and trailing * wildcards. */
  mcpAllowlist: z.array(z.string()).nullable().optional(),
  /** Agent-level operating principles injected through /v1/runs instructions. */
  operatingPrinciples: z
    .union([
      z.string(),
      z.record(z.string()),
      z.array(z.object({ source: z.string(), text: z.string() }).passthrough()),
    ])
    .optional(),
  /** Override the skills root read for dispatch-time SKILL.md injection. */
  skillsDir: z.string().optional(),
  /**
   * release201/24 §Phase2 — extra skill dirs registered into the gateway's
   * config.yaml `skills.external_dirs` so the skill-under-test enters Hermes'
   * NATIVE skill discovery (skills_list / skill tools). The daemon's
   * system-prompt injection alone is not seen by the agent's skill tools, and
   * HERMES_HOME does NOT scope skill loading (the ~90 bundled skills ship with
   * the hermes package). The eval session spawner sets this to its isolated
   * temp-home skills dir.
   */
  skillsExternalDirs: z.array(z.string()).optional(),
  /**
   * release201/24 §Phase2 — install the prismer daemon memory hooks
   * (pre_llm_call recall / post_llm_call extract / on_session_end). Default
   * true. The eval session spawner sets this FALSE so a throwaway eval run
   * neither READS contaminated workspace memory (a prior failed run's
   * "skill X is stale" note biases the agent) nor WRITES memories that poison
   * later runs — the eval judges the skill on its own merits.
   */
  installMemoryHooks: z.boolean().optional().default(true),
  /**
   * release201/26 §14 Phase A (#A1) — enable hermes' BUILTIN knowledge memory
   * (`MEMORY.md` / `USER.md` injected into the system prompt). Default false.
   *
   * release201/09 §9.4b (2026-05-30 hotfix, Option B2) — important correction
   * to the previous comment claim "hermes' code default = False, we don't
   * write a memory: block so it stays off". That was WRONG: hermes
   * deep-merges user config OVER `DEFAULT_CONFIG` (hermes_cli/config.py:4701
   * `_deep_merge`), and `DEFAULT_CONFIG.memory.memory_enabled = True`
   * (config.py:1373). `agent_init.py:1076` reads from the MERGED config, so
   * not writing a `memory:` block leaves hermes builtin memory ON. Real
   * contamination symptom (2026-05-30 user report): after workspace clear +
   * new workspace spawn, CEO recited 5 prior-workspace agent IDs + 7 named
   * humans verbatim from `~/.hermes/profiles/ceo/memories/MEMORY.md`. Fix
   * here = ALWAYS write the `memory:` block with explicit values; default
   * (false) writes `memory_enabled: false` + `user_profile_enabled: false`
   * so hermes' builtin MEMORY.md/USER.md injection is genuinely off. When
   * true (release201/26 §14 Phase A cutover), writes `memory_enabled: true`
   * + `user_profile_enabled: true`. Operator-set sibling keys in an existing
   * memory: block (e.g. `memory_char_limit`, `provider`) are preserved.
   */
  enableBuiltinMemory: z.boolean().optional().default(false),
  /**
   * release201/26 §13.4a (P2 spike, 2026-05-30) — pin hermes vision config so
   * an agent on a `custom:` provider can actually RECEIVE images.
   *
   * Production坑: hermes v0.15.0 does NOT route images through the main chat's
   * inline image part; it spins up a separate `vision_analyze_tool` aux LLM.
   * That aux path's provider auto-detect does NOT recognize `custom:` providers
   * → 502. Every daemon agent runs a custom provider (`custom:prismer` →
   * Prismer Cloud `/api/v1`), so DEFAULT behaviour is: agent receives an image
   * → guaranteed 502. The spike-verified fix is pure config (no hermes patch):
   *   model.supports_vision: true  +  agent.image_input_mode: native
   * which takes the native fast-path and feeds the image straight to the main
   * model. The default model `us-kimi-k2.6` is vision-capable and correctly
   * described images under this config in the spike.
   *
   * Default取舍 (2026-05-30, evidence-based): when the caller does NOT set this
   * explicitly, the effective value is `VISION_CAPABLE_MODELS.has(config.model)`
   * — a per-model allowlist measured by real cloud-proxy vision probes (see the
   * `VISION_CAPABLE_MODELS` docblock). This REPLACES the prior
   * `proxyProvider === 'deepseek' ? false : true` heuristic. Verified vision
   * models (gemini-3.1-pro-preview, gemini-3.1-flash-lite-preview, us-kimi-k2.6
   * — the daemon default) default ON; verified text-only models
   * (deepseek-v4-flash / deepseek-v4-pro, which 400 on image parts) default OFF.
   * An explicit value here always wins; set `true` to force vision on an
   * unmeasured model, `false` for any text-only / reasoning model.
   */
  supportsVision: z.boolean().optional(),
  /**
   * Role-template snapshot carried in AgentProfile.config by cloud ACP.
   * Expected fields used here:
   *   - roleTemplate.mcpServers[].toolsAllowlist
   *   - roleTemplate.operatingPrinciples
   */
  roleTemplate: z
    .object({
      mcpServers: z.array(z.object({ toolsAllowlist: z.array(z.string()).optional() }).passthrough()).optional(),
      operatingPrinciples: z
        .union([
          z.string(),
          z.record(z.string()),
          z.array(z.object({ source: z.string(), text: z.string() }).passthrough()),
        ])
        .optional(),
    })
    .passthrough()
    .optional(),
});

export type HermesProfileConfig = z.infer<typeof HermesProfileConfigSchema>;

export const hermesAdapter: AdapterDef = {
  name: 'hermes',
  kind: 'long-running',
  capabilities: ['shell', 'code', 'mcp', 'long-context'],
  workspaceSchema: HermesProfileConfigSchema,

  validate(config: unknown): ValidationResult {
    const r = HermesProfileConfigSchema.safeParse(config);
    if (r.success) return { ok: true };
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  },

  async prepareProfile(profile): Promise<void> {
    const config = HermesProfileConfigSchema.parse(profile.config);
    if (config.configurePrismerProvider) {
      const profileName = getHermesProfileName(profile);
      const agentUsername = profile.agentUsername || profileName;
      configurePrismerProvider(profileName, config, agentUsername, profile.workspaceId);
    }
  },

  async ensureService(profile): Promise<AdapterService> {
    const config = HermesProfileConfigSchema.parse(profile.config);
    // Why: each cloud agent needs its own Hermes profile so SOUL.md /
    // config.yaml / MCP env are isolated. Prefer agent.username (stable,
    // human-readable) but fall back to a slice of profile.id for safety.
    // Explicit hermesProfileName in config still wins as an operator
    // override, unless it's the legacy "default" sentinel.
    const profileName = getHermesProfileName(profile);
    // Why: prevent port collisions when multiple agents auto-spawn their own
    // Hermes gateway in the same daemon. Each profileName hashes to a stable
    // offset from the default base port, so the same agent always uses the
    // same port across restarts. An explicit non-default config.port wins.
    const portOverride = config.port !== 8642 ? config.port : portForProfile(`${profileName}:${config.apiKey}`, 8642);
    const baseUrl = `http://127.0.0.1:${portOverride}`;
    // Why this fallback chain: cloud may not yet populate `profile.agentUsername`
    // in the DTO (older deploys, or pre-restart). After the per-agent-profile
    // migration, `hermesProfileName` in config is guaranteed to be the agent's
    // username, so it's the most reliable identity source for the X-IM-Agent
    // header we inject into the MCP env.
    const agentUsername = profile.agentUsername || profileName;
    if (config.configurePrismerProvider) {
      configurePrismerProvider(profileName, config, agentUsername, profile.workspaceId);
    }

    // release202/07 robustness — decide reuse-vs-respawn with an AUTHENTICATED
    // identity probe, not just /health. An old-version or wrong-key hermes
    // squatting on this port answers /health 200 (health isn't key-gated) yet
    // fails the authenticated /v1/capabilities probe (404 on a pre-sessions
    // build, or 401 on a wrong API_SERVER_KEY — e.g. an orphan gateway we
    // spawned in a PRIOR daemon session). Reusing such a squatter is exactly
    // what later makes the capability gate trip with the misleading "Hermes
    // does not advertise session_chat_streaming". So only a hermes that answers
    // /v1/capabilities as OURS counts as reusable; anything else → free the
    // port (stopStaleHermesGateways) + spawn ours.
    let capabilities: Record<string, boolean> | undefined;
    const somethingListening = await checkHealth(baseUrl, config.apiKey);
    if (somethingListening) {
      capabilities = await probeHermesCapabilities(baseUrl, config.apiKey);
      if (capabilities === undefined) {
        process.stderr.write(
          `[hermes-adapter] a hermes on ${baseUrl} answered /health but FAILED the authenticated capability probe — treating it as a stale/foreign gateway squatting on the port (wrong API_SERVER_KEY or pre-sessions build); freeing the port and spawning ours\n`,
        );
      }
    }
    if (capabilities === undefined) {
      if (!config.autoStart) {
        throw new Error(
          somethingListening
            ? `Hermes at ${baseUrl} is reachable but not ours — authenticated /v1/capabilities failed (wrong API_SERVER_KEY or a pre-sessions build). Stop that gateway and start ours:\n  API_SERVER_ENABLED=true API_SERVER_KEY=<key> API_SERVER_PORT=${portOverride} hermes -p ${profileName} gateway run`
            : `Hermes API server not reachable at ${baseUrl}. Start it with:\n  API_SERVER_ENABLED=true API_SERVER_KEY=<key> API_SERVER_PORT=${portOverride} hermes -p ${profileName} gateway run\n(set autoStart: true on the AgentProfile to spawn it automatically)`,
        );
      }
      await stopStaleHermesGateways(profileName, portOverride, config.startupTimeoutMs);
      // F18 (2026-05-20) — sandbox the hermes child's cwd to the profile's
      // own directory. Previously `spawn` inherited the daemon process's
      // cwd; when the daemon was launched from a user project dir (e.g.
      // `~/workspace/myrepo`), LLM tool calls like
      // `write_file_tool({path: 'draw_chart.py'})` resolved against that
      // cwd and dumped agent-produced files into the user's source tree.
      // Real incident: 5 .py files appeared in `prismercloud/` after one
      // chart task. Confining cwd to `~/.hermes/profiles/<name>/` keeps
      // accidental relative-path writes inside the agent's own sandbox.
      //
      // release202/04 §3.2 — DELIBERATELY NOT per-task scratch dir. Unlike the
      // spawn-style adapters (claude-code, codex), the hermes gateway is a
      // LONG-RUNNING, per-profile SHARED process: ServicePool (service-pool.ts)
      // caches one HermesService per profile.id, and ONE gateway process then
      // serves MANY dispatches across MANY conversations. cwd is fixed once,
      // here, at spawn — so binding it to a single dispatch's task scratch dir
      // would (a) be stale the instant the next turn/conversation arrives and
      // (b) cross-conversation contaminate (turn B writing into turn A's task
      // dir). Hermes therefore stays pinned to the per-profile sandbox and
      // relies on the absolute-path instruction from appendArtifactsInstruction
      // (dispatch.ts) to steer writes into the per-task artifacts/scratch dirs.
      const hermesProfileDir = getHermesProfileDir(profileName);
      try {
        mkdirSync(hermesProfileDir, { recursive: true });
      } catch (err) {
        process.stderr.write(
          `[hermes-adapter] failed to ensure hermes profile dir ${hermesProfileDir}: ${(err as Error).message}\n`,
        );
      }
      // autoStart: spawn Hermes' gateway with the API server platform enabled.
      // Hermes 0.10 exposes /v1/runs from gateway/platforms/api_server.py; a
      // plain `hermes gateway` without these env vars starts only configured
      // messaging platforms and will never bind the HTTP API.
      // 2026-05-29 — agent identity injection. Hermes is per-profile (one
      // process per agent), so env we set here is per-agent for the rest
      // of this service's lifetime. Any child the hermes server spawns —
      // tool subprocesses, the `cloud file send` CLI inside a sandbox,
      // MCP-launched bridges — inherits these vars. The SDK CLI reads
      // PRISMER_AGENT_USERNAME and forwards it as X-IM-Agent, which the
      // cloud auth middleware (src/im/auth/middleware.ts:131-160) resolves
      // to the agent IM User row so POST /api/im/messages stamps
      // senderId=<agent> instead of the human owner of PRISMER_API_KEY.
      const agentEnv: Record<string, string> = {};
      if (profile.agentUsername) agentEnv.PRISMER_AGENT_USERNAME = profile.agentUsername;
      if (profile.agentImUserId) agentEnv.PRISMER_AGENT_IM_USER_ID = profile.agentImUserId;

      spawn('hermes', ['-p', profileName, 'gateway', 'run'], {
        detached: false,
        stdio: 'ignore',
        cwd: hermesProfileDir,
        env: {
          ...process.env,
          API_SERVER_ENABLED: 'true',
          API_SERVER_KEY: config.apiKey,
          API_SERVER_PORT: String(portOverride),
          API_SERVER_HOST: '127.0.0.1',
          // TERMINAL_CWD is the env that hermes file_tools._resolve_path
          // honors over `os.getcwd()` for relative paths. Pin it to the
          // profile dir so even non-LLM-initiated writes (e.g. hermes
          // internal book-keeping) land in the sandbox.
          TERMINAL_CWD: hermesProfileDir,
          [config.prismerApiKeyEnv]: resolvePrismerApiKey(config),
          ...agentEnv,
        },
      });
      await waitForHealthy(baseUrl, config.apiKey, config.startupTimeoutMs);
      // Re-probe after the fresh spawn so `capabilities` is pinned for dispatch.
      capabilities = await probeHermesCapabilities(baseUrl, config.apiKey);
    }

    // §16.4 A4 — capability gate. `capabilities` is now pinned ABOVE: either
    // from the authenticated reuse-probe (an existing gateway that proved it's
    // ours) or from the post-spawn probe (a freshly spawned gateway). Hermes
    // v0.15+ self-advertises feature bits via GET /v1/capabilities
    // (api_server.py _handle_capabilities). dispatch() reads
    // session_chat_streaming off the pinned HermesService.capabilities without
    // re-fetching every turn.
    //
    // Best-effort: if every probe failed (404 on pre-0.15, network error, bad
    // JSON), capabilities stays undefined and dispatch() fails with a typed
    // adapter error rather than silently degrading (§16.4 A3 removed the legacy
    // /v1/runs + /v1/chat/completions fallbacks).

    // release201/26 §13.3 #3 — write the collab SKILL.md into the profile
    // now (dispatch() rewrites it idempotently per-turn) and immediately
    // verify hermes actually LOADED it via the read-only GET /v1/skills
    // probe. "Written ≠ loaded" is the §16 spike trap; the probe turns it
    // into a loud warn + metric (non-blocking — see verifyHermesSkillLoaded).
    installPrismerImSkill(profileName);
    await verifyHermesSkillLoaded(baseUrl, config.apiKey, PRISMER_IM_SKILL_NAME, capabilities);

    return new HermesService(
      profile.id,
      baseUrl,
      config,
      profileName,
      new HermesSkillLoader(resolveHermesSkillsRoot(profile, profileName)),
      capabilities,
    );
  },

  async health(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      const p = spawn('hermes', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      p.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      p.on('exit', (code) => {
        if (code !== 0) {
          resolve({
            available: false,
            reason: 'hermes CLI not in PATH',
            hint: 'See https://hermes-agent.nousresearch.com/docs/installation',
          });
          return;
        }
        const detected = parseVersionFromStdout(stdout);
        if (!isVersionInRange(detected, HERMES_MIN_VERSION)) {
          process.stderr.write(
            `[hermes-adapter] detected hermes ${detected} below MIN ${HERMES_MIN_VERSION}; behavior is unverified\n`,
          );
        } else if (detected !== HERMES_KNOWN_GOOD && HERMES_KNOWN_GOOD !== 'unknown') {
          process.stderr.write(
            `[hermes-adapter] detected hermes ${detected}, known-good ${HERMES_KNOWN_GOOD}; minor drift OK if smoke passes\n`,
          );
        }
        resolve({ available: true });
      });
      p.on('error', () =>
        resolve({
          available: false,
          reason: 'hermes CLI not found',
          hint: 'See https://hermes-agent.nousresearch.com/docs/installation',
        }),
      );
    });
  },
};

export class HermesService implements AdapterService {
  private currentRunId?: string;

  constructor(
    public readonly id: string,
    public readonly baseUrl: string,
    public readonly config: HermesProfileConfig,
    public readonly profileName: string,
    private readonly skillLoader: HermesSkillLoader,
    /**
     * §16.4 A4 capability gate — set at ensureService time by probing
     * GET /v1/capabilities. `undefined` means probe failed (pre-0.15
     * hermes or network error). After §16.4 A3 removed the legacy
     * /v1/runs + /v1/chat/completions fallbacks, an undefined or
     * sessions-feature-missing capability map causes dispatch() to
     * fail with an explicit adapter error rather than silently
     * degrade.
     *
     * dispatch() reads `session_chat_streaming` to verify the sessions
     * API is available; resolveApproval() reads `run_approval_response`
     * to gate native HITL forwarding (independent of dispatch path).
     */
    // NOT readonly: dispatch() may replace `undefined` with a fresh probe
    // result if the startup probe lost the race vs hermes api_server
    // `connecting` → `connected`. See the lazy re-probe in dispatch().
    public capabilities?: Record<string, boolean>,
  ) {}

  /**
   * §16.4 A6 — native HITL approval forwarding. After the cloud-side
   * approval-card persists the user's decision, daemon also forwards
   * the choice here so hermes-internal approval state stays in sync
   * (avoids data races on hermes' own session-level "always" cache and
   * unlocks the native `choice: session/always` semantics that our
   * pre-A6 redispatch path couldn't express).
   *
   * Source contract: hermes-agent gateway/platforms/api_server.py:3875
   * `_handle_run_approval` expects POST /v1/runs/{runId}/approval with
   * body `{ choice: 'once'|'session'|'always'|'deny', all?: boolean }`.
   */
  async resolveApproval(
    runId: string,
    choice: 'once' | 'session' | 'always' | 'deny',
    resolveAll = false,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.capabilities?.run_approval_response) {
      return { ok: false, error: 'hermes does not advertise run_approval_response' };
    }
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ choice, all: resolveAll }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `${res.status} ${text}`.trim() };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * release202 — clarify forwarding. Mirrors resolveApproval but carries the
   * user's *answer* (free-form text or a chosen option) back into the blocked
   * agent run, which the approval channel (enum-only) cannot. Called by the
   * daemon's inbound-reply path when a user answers a pending clarify question
   * surfaced from a `clarify.request` SSE event.
   *
   * Source contract: hermes-agent gateway/platforms/api_server.py
   * `_handle_run_clarify` — POST /v1/runs/{runId}/clarify with body
   * `{ response: string, clarify_id?: string }`. When clarify_id is supplied
   * the resolve is session-global (works for the sessions chat-stream path
   * whose run_id is not tracked in _run_statuses). Verified end-to-end
   * 2026-06-01 on both /v1/runs and /api/sessions/{id}/chat/stream.
   */
  async resolveClarify(
    runId: string,
    response: string,
    clarifyId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.capabilities?.run_clarify_response) {
      return { ok: false, error: 'hermes does not advertise run_clarify_response' };
    }
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/clarify`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(clarifyId ? { response, clarify_id: clarifyId } : { response }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `${res.status} ${text}`.trim() };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async healthy(): Promise<boolean> {
    return checkHealth(this.baseUrl, this.config.apiKey);
  }

  async dispatch(task: TaskInput): Promise<TaskResult> {
    const startedAt = Date.now();
    let runId: string | undefined;
    // v2.0 (A3) — dispatch.ts now composes `profileSystemPrompt + "\n\n" +
    // operatingPrinciples` into a single `metadata.systemPrompt`. We no
    // longer read `metadata.operatingPrinciples` separately — the dispatch
    // path stopped emitting it. SOUL.md still gets only the per-agent
    // persona portion (sysPrompt) so identity slot #1 doesn't drift; the
    // operating-principles tail rides along as ephemeral `instructions`.
    const sysPrompt = typeof task.metadata?.systemPrompt === 'string' ? task.metadata.systemPrompt : undefined;
    this.installRoleTemplateSkill();
    const skillPrompt = await this.skillLoader.loadSystemPromptFragment().catch((err) => {
      process.stderr.write(
        `[hermes-adapter] failed to read skills for ${this.profileName}: ${(err as Error).message}\n`,
      );
      return undefined;
    });
    // 2026-05-22 / release202/04 — Artifacts path is per-dispatch (daemon
    // allocates `~/.prismer/.../tasks/<taskId>/artifacts/`). Hermes is
    // long-running and its SOUL.md / skills are session-cached, so the agent
    // will happily reuse a previous turn's artifacts path if we don't shout
    // the new one at it every turn. dispatch.ts already prepended an
    // instruction to the user prompt, but Hermes session memory + cached
    // system prompt can let the agent ignore that and reach for a stale path.
    // Re-assert the authoritative path on `instructions` (ephemeral per-run)
    // so it appears AFTER SOUL.md, where Hermes places it as the freshest
    // directive of the turn.
    //
    // Backward-compat: prefer the new `prismerArtifactsDir` metadata key, fall
    // back to the legacy INBOUND `prismerOutboxDir` key for stale dispatch
    // payloads (cloud→daemon plumbing, not agent-visible).
    const artifactsDir =
      (typeof task.metadata?.prismerArtifactsDir === 'string'
        ? task.metadata.prismerArtifactsDir
        : undefined) ??
      (typeof task.metadata?.prismerOutboxDir === 'string' ? task.metadata.prismerOutboxDir : undefined);
    const artifactsDirective = artifactsDir
      ? [
          '[Artifacts directive — MANDATORY, overrides any prior artifacts path]',
          '',
          'For THIS turn ONLY, your active artifacts dir is:',
          `  ${artifactsDir}`,
          '',
          'Any user-deliverable file (PDF, image, CSV, archive, doc) MUST be',
          'written to that EXACT absolute path. Do NOT reuse the artifacts path',
          'from any previous turn — those directories no longer accept new',
          'uploads. Do NOT copy files into the previous artifacts dir; copy them',
          'into the path above. Files outside this directory will not become',
          'chat attachments and the user will see "no files were attached".',
        ].join('\n')
      : '';
    // P1-1 (dispatch reliability) — give the agent a structured view of
    // what is actually installed in THIS daemon container, so it stops
    // calling non-existent tools or writing text into `.pdf` extensions
    // to satisfy a deliverable. Snapshot is cached for the process
    // lifetime (one probe per daemon boot), so this is cheap per turn.
    const caps = getCapabilitySnapshot();
    const capsSection = caps.summary.length
      ? [
          '## Daemon capabilities (this container, probed at boot)',
          ...caps.summary.map((s) => `- ${s}`),
          '',
          'When you need to produce a binary deliverable (PDF / PPTX / XLSX /',
          'image / video), USE one of the libraries listed above. Do NOT write',
          'plain text into a `.pdf` extension — artifacts-watcher will reject it',
          'and the user sees nothing. If the format you need is not listed,',
          'ask the user or fall back to a supported format with a brief',
          'explanation of the substitution you made.',
        ].join('\n')
      : '';
    const instructions = [capsSection, artifactsDirective, sysPrompt, skillPrompt]
      .filter(Boolean)
      .join('\n\n');
    // Why: Hermes 0.13 treats `instructions` as *ephemeral* — it gets
    // appended to the cached system prompt AFTER SOUL.md (run_agent.py
    // `_build_system_prompt`), so the LLM still leads with "I am Hermes
    // Agent". To make the per-profile persona the actual identity (slot
    // #1), pin it as SOUL.md in the profile dir before the session
    // starts. Sessions are keyed by conversationId; SOUL.md is read at
    // session creation and cached for the session — different
    // conversations get their own snapshot, so concurrent agents in
    // different chats don't race after the first dispatch.
    if (sysPrompt) {
      try {
        const profileDir = getHermesProfileDir(this.profileName);
        mkdirSync(profileDir, { recursive: true });
        // SOUL.md is per-agent persona only — Hermes identity slot #1.
        // Platform-level "how to collaborate" guidance lives in the
        // prismer-im-collab skill (installed below), so it loads via
        // Hermes' skill system without polluting identity.
        writeFileSync(join(profileDir, 'SOUL.md'), sysPrompt, 'utf8');
      } catch (err) {
        process.stderr.write(
          `[hermes-adapter] failed to write SOUL.md for ${this.profileName}: ${(err as Error).message}\n`,
        );
      }
    }
    // Install the prismer-im-collab Hermes skill on every dispatch. Runs
    // regardless of whether a per-agent persona was provided — platform
    // collaboration rules apply to all profiles. Idempotent rewrite keeps
    // the runtime version authoritative even if the file was deleted.
    installPrismerImSkill(this.profileName);
    // release201/25 §16.4 A3 — single dispatch path via sessions API.
    //
    // Legacy `POST /v1/runs` + `POST /v1/chat/completions` (dispatchMultimodalChat)
    // fallback branches were removed 2026-05-29 once A1 (commit 5769d04b) had
    // baked in dev:local for several days. The sessions API covers text-only
    // AND multimodal in one stateful SSE stream (sessions-dispatcher.ts
    // buildMessage handles image_url parts), so there is nothing left to fall
    // back to.
    //
    // Pre-conditions (capability + conversationId + agentImUserId +
    // sessionMapper singleton) are now hard requirements — when any of them
    // is missing dispatch fails explicitly with a typed adapter error rather
    // than silently degrading. This is the intended A3 behaviour: hermes
    // v0.15+ is pinned as known-good in adapters/known-versions.ts, and
    // synthetic / external-channel tasks must plumb conversationId +
    // agentImUserId rather than reach for a fallback that quietly drops
    // multi-turn history.
    //
    // SSE-layer state (approvalRequested, runId) lives inside
    // dispatchViaSessions; the outer catch only handles failures
    // surrounding that call (kanban/goals patch fetch, fatal session
    // resolution).
    try {
      const nativeBridgePatch = await this.prepareNativeBridgePatch(task);

      // Defense-in-depth: if the startup probe set capabilities to undefined
      // (e.g. race vs hermes api_server `connecting` → `connected` even with
      // the fixed waitForHealthy, or a transient network hiccup during
      // ensureService), re-probe once before failing. A single successful
      // re-probe replaces the cached undefined for the lifetime of this
      // HermesService instance, so the next dispatch returns fast. If the
      // re-probe also fails we fall through to the typed error below — the
      // operator gets the same upgrade hint, just one dispatch later.
      if (this.capabilities === undefined) {
        const reprobed = await probeHermesCapabilities(this.baseUrl, this.config.apiKey);
        if (reprobed) {
          this.capabilities = reprobed;
        }
      }

      // release202/08 Phase 1 — route one-shot task-runs to /v1/runs
      // (flag-gated, default OFF). deriveDispatchKind returns 'turn'
      // unconditionally when HERMES_TASK_RUNS_DISPATCH is off, so this branch is
      // inert and ALL traffic falls through to the unchanged sessions path
      // below. When ON, a `task-run` execution context with no triggering chat
      // sender dispatches statelessly via /v1/runs — no session, no
      // local_run_sessions mapping, no session_chat_streaming capability gate
      // (that gate is sessions-specific). conversationId/agentImUserId are NOT
      // required for a run (a pure kanban / scheduled fire has neither).
      const executionContextForKind = deriveExecutionContext(task, {
        model: this.config.model,
        supportsVision: resolveSupportsVision(this.config.model, this.config.supportsVision),
        profileName: this.profileName,
      });
      const dispatchKind = deriveDispatchKind(task, executionContextForKind.type);
      if (dispatchKind === 'run') {
        const runIdempotencyKey = llmIdempotencyKey({
          taskRunId: task.taskId,
          attemptNo: readAttemptNo(task),
          stepSeq: 0,
          prompt: `${instructions || ''}\n${task.currentPrompt ?? task.prompt}`,
          model: this.config.model,
        });
        const runOutcome = await dispatchViaRuns(task, {
          baseUrl: this.baseUrl,
          apiKey: this.config.apiKey,
          model: this.config.model,
          supportsVision: resolveSupportsVision(this.config.model, this.config.supportsVision),
          profileName: this.profileName,
          instructions,
          idempotencyKey: runIdempotencyKey,
        });
        if (runOutcome.runId) {
          this.currentRunId = runOutcome.runId;
          runId = runOutcome.runId;
          // Register runId → context for shell-hook reverse lookup. This is
          // the in-memory shell-hook map (file-path resolution), NOT a hermes
          // session / local_run_sessions mapping — the run stays stateless.
          try {
            const registry = getRunSessionRegistry();
            if (registry) {
              const meta = (task.metadata ?? {}) as Record<string, unknown>;
              const convId = typeof meta.conversationId === 'string' ? meta.conversationId : null;
              const agentImUserId =
                typeof meta.agentImUserId === 'string' ? meta.agentImUserId : '';
              const workspaceIdMeta =
                typeof meta.workspaceId === 'string'
                  ? meta.workspaceId
                  : typeof meta.prismerWorkspaceId === 'string'
                    ? meta.prismerWorkspaceId
                    : '';
              const roleSlug =
                typeof meta.roleTemplateSlug === 'string' ? meta.roleTemplateSlug : null;
              if (workspaceIdMeta && (agentImUserId || task.taskId)) {
                registry.register({
                  runId: runOutcome.runId,
                  conversationId: convId,
                  taskId: task.taskId ?? null,
                  agentImUserId: agentImUserId || 'unknown',
                  workspaceId: workspaceIdMeta,
                  profileName: this.profileName,
                  roleTemplateSlug: roleSlug,
                  adapterName: 'hermes',
                });
              }
            }
          } catch (err) {
            process.stderr.write(
              `[hermes-adapter] runs run-session register failed run=${runOutcome.runId}: ${(err as Error).message}\n`,
            );
          }
        }
        const runOut = runOutcome.result;
        if (runOut.ok && runOut.metadata && Object.keys(nativeBridgePatch).length > 0) {
          const hermesMeta = (runOut.metadata.hermes ?? {}) as Record<string, unknown>;
          runOut.metadata = {
            ...runOut.metadata,
            hermes: { ...hermesMeta, ...nativeBridgePatch },
          };
        }
        return runOut;
      }

      if (this.capabilities?.session_chat_streaming !== true) {
        return {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message:
              'Hermes does not advertise session_chat_streaming (capability gate). Upgrade hermes to a release whose /v1/capabilities ships this feature (NousResearch/hermes-agent uses calver vYYYY.M.D); legacy /v1/runs path was removed in release201/25 §16.4 A3.',
          },
          metadata: {
            hermes: this.bridgeSnapshot('failed', {
              baseUrl: this.baseUrl,
              model: this.config.model,
              error: 'capability_session_chat_streaming_missing',
            }),
          },
        };
      }
      const sessionMapper = getHermesSessionMapper();
      if (sessionMapper === null) {
        return {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message:
              'Hermes session mapper not initialised — daemon Runner must wire setHermesSessionMapper before dispatch.',
          },
          metadata: {
            hermes: this.bridgeSnapshot('failed', {
              baseUrl: this.baseUrl,
              model: this.config.model,
              error: 'session_mapper_not_initialised',
            }),
          },
        };
      }
      const conversationId =
        typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : null;
      const agentImUserId =
        typeof task.metadata?.agentImUserId === 'string' ? task.metadata.agentImUserId : null;
      if (!conversationId || !agentImUserId) {
        return {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message:
              'Hermes sessions path requires conversationId + agentImUserId in task.metadata (release201/25 §16.4 A3 removed the /v1/runs fallback that quietly accepted synthetic tasks).',
          },
          metadata: {
            hermes: this.bridgeSnapshot('failed', {
              baseUrl: this.baseUrl,
              model: this.config.model,
              error: 'missing_conversation_or_agent_im_user_id',
            }),
          },
        };
      }

      // Same idempotency key seed the prior /v1/runs path used so any
      // cloud llm-proxy cache entries remain stable across this rollout.
      const idempotencyKey = llmIdempotencyKey({
        taskRunId: task.taskId,
        attemptNo: readAttemptNo(task),
        stepSeq: 0,
        prompt: `${instructions || ''}\n${task.currentPrompt ?? task.prompt}`,
        model: this.config.model,
      });
      const outcome = await dispatchViaSessions(task, {
        baseUrl: this.baseUrl,
        apiKey: this.config.apiKey,
        profileName: this.profileName,
        serviceId: this.id,
        model: this.config.model,
        // release202/04 §3.3 P3 — surface effective vision capability so
        // sessions-dispatcher can stamp <execution_context><model
        // supports_vision=…>; same rule as the config builder.
        supportsVision: resolveSupportsVision(this.config.model, this.config.supportsVision),
        capabilities: this.capabilities,
        instructions,
        // release201/30 — schema explainer prepended to system_message so
        // the model knows how to read the <conversation_context> XML
        // wrapper sessions-dispatcher now sends as the user message.
        contextSchemaDoc: CONVERSATION_CONTEXT_SCHEMA_DOC,
        idempotencyKey,
        sessionMapper,
      });
      if (outcome.runId) {
        this.currentRunId = outcome.runId;
        runId = outcome.runId;
      }
      // Stitch in native bridge metadata (kanban / goals mirror) so
      // cloud-side correlation parity with the prior /v1/runs path is
      // preserved.
      const out = outcome.result;
      if (out.ok && out.metadata && Object.keys(nativeBridgePatch).length > 0) {
        const hermesMeta = (out.metadata.hermes ?? {}) as Record<string, unknown>;
        out.metadata = {
          ...out.metadata,
          hermes: { ...hermesMeta, ...nativeBridgePatch },
        };
      }
      return out;
    } catch (err) {
      process.stderr.write(
        `[hermes-adapter] task=${task.taskId ?? '?'} dispatch caught name=${(err as Error)?.name} msg=${(err as Error)?.message} signal.aborted=${task.signal?.aborted}\n`,
      );
      // categorizeDispatchError gives us the standard {code, message}
      // shape; hermes layers on its own bridge metadata so the cloud can
      // correlate the run with the upstream hermes run_id.
      const categorized = categorizeDispatchError(err, task.signal);
      const bridgeKind = categorized.error?.code === 'task_cancelled' ? 'cancelled' : 'failed';
      return {
        ...categorized,
        metadata: {
          hermes: this.bridgeSnapshot(bridgeKind, {
            runId,
            baseUrl: this.baseUrl,
            model: this.config.model,
            ...(bridgeKind === 'failed' ? { error: (err as Error).message } : {}),
          }),
        },
      };
    } finally {
      if (runId && this.currentRunId === runId) this.currentRunId = undefined;
      // startedAt was captured for parity with the prior failure-shape
      // metric path; sessions dispatch reports its own durationMs.
      void startedAt;
    }
  }

  async shutdown(): Promise<void> {
    if (this.currentRunId) await this.stopRun(this.currentRunId);
  }

  private async stopRun(runId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (res && !res.ok && res.status !== 404 && res.status !== 405) {
      const body = await res.text().catch(() => '');
      throw new Error(`Hermes stop returned ${res.status}: ${body || '<no body>'}`);
    }
  }

  private async prepareNativeBridgePatch(task: TaskInput): Promise<Record<string, unknown>> {
    const [kanbanPatch, goalsPatch] = await Promise.all([
      this.prepareNativeKanbanPatch(task),
      this.prepareNativeGoalsPatch(task),
    ]);
    return { ...kanbanPatch, ...goalsPatch };
  }

  private installRoleTemplateSkill(): void {
    const roleTemplate = readPlainRecord(this.config.roleTemplate);
    const hermesConfig = readPlainRecord(roleTemplate?.hermesConfig);
    const agents = readNonEmptyString(hermesConfig?.agents);
    if (!agents) return;

    const slug = sanitizeRoleSkillSlug(readNonEmptyString(roleTemplate?.slug) ?? 'template');
    const skillName = `${PRISMER_ROLE_SKILL_PREFIX}-${slug}`;
    const content = renderRoleTemplateSkill(skillName, agents, roleTemplate);
    try {
      const skillDir = join(this.skillLoader.getSkillsRoot(), skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
    } catch (err) {
      process.stderr.write(
        `[hermes-adapter] failed to install role-template skill ${skillName} for ${this.profileName}: ${(err as Error).message}\n`,
      );
    }
  }

  private async prepareNativeKanbanPatch(task: TaskInput): Promise<Record<string, unknown>> {
    const sourceKind = typeof task.metadata?.sourceKind === 'string' ? task.metadata.sourceKind : null;
    const parentTaskId = typeof task.metadata?.parentTaskId === 'string' ? task.metadata.parentTaskId : null;
    if (!this.config.mirrorNativeKanban || sourceKind !== 'work_item' || !parentTaskId) {
      return {};
    }

    const title =
      typeof task.metadata?.parentTitle === 'string' && task.metadata.parentTitle.trim()
        ? task.metadata.parentTitle.trim()
        : `Prismer task ${parentTaskId}`;
    const description =
      typeof task.metadata?.parentDescription === 'string' && task.metadata.parentDescription.trim()
        ? task.metadata.parentDescription.trim()
        : task.prompt.slice(0, 1000);

    try {
      const body = [
        description,
        '',
        `Prismer parentTaskId: ${parentTaskId}`,
        `Prismer runTaskId: ${task.taskId}`,
      ].join('\n');
      const mirrored = await createHermesKanbanTask(
        {
          profileName: this.profileName,
        },
        {
          title,
          body,
          triage: true,
          idempotencyKey: `prismer:${parentTaskId}`,
          createdBy: 'prismer',
        },
        this.config.nativeMirrorTimeoutMs,
      );
      const externalTaskId =
        mirrored && typeof mirrored === 'object' && !Array.isArray(mirrored)
          ? (mirrored as { id?: unknown }).id
          : undefined;
      return {
        kanban: {
          status: 'native_local_state',
          mode: 'cli_sqlite_tooling',
          mirrored: true,
          externalTaskId: typeof externalTaskId === 'string' ? externalTaskId : null,
          idempotencyKey: `prismer:${parentTaskId}`,
          mirroredAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        kanban: {
          status: 'mirror_failed',
          mode: 'cli_sqlite_tooling',
          mirrored: false,
          idempotencyKey: `prismer:${parentTaskId}`,
          error: (err as Error).message,
          mirroredAt: new Date().toISOString(),
        },
      };
    }
  }

  private async prepareNativeGoalsPatch(task: TaskInput): Promise<Record<string, unknown>> {
    const conversationId = typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : null;
    const goals = parsePrismerGoals(task.metadata?.prismerGoals);
    if (!this.config.mirrorNativeGoals || !conversationId || goals.length === 0) {
      return {};
    }

    try {
      const mirror = writeHermesGoalState(this.profileName, conversationId, goals);
      return {
        goals: {
          status: 'native_local_state',
          mode: 'session_goal_state',
          mirrored: true,
          externalGoalId: `goal:${conversationId}`,
          sessionId: conversationId,
          goalTaskIds: goals.map((goal) => goal.id),
          state: mirror.status,
          mirroredAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        goals: {
          status: 'mirror_failed',
          mode: 'session_goal_state',
          mirrored: false,
          externalGoalId: `goal:${conversationId}`,
          sessionId: conversationId,
          goalTaskIds: goals.map((goal) => goal.id),
          error: (err as Error).message,
          mirroredAt: new Date().toISOString(),
        },
      };
    }
  }

  private bridgeSnapshot(
    status: 'dispatched' | 'cancelled' | 'failed',
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      status,
      lastSyncedAt: new Date().toISOString(),
      kanban: {
        status: 'native_local_state',
        mode: 'cli_sqlite_tooling',
        mirrored: false,
        reason: 'Hermes Kanban is not a REST bridge URL; Prismer mirror is pending explicit CLI/SQLite/tool integration',
      },
      goals: {
        status: 'native_local_state',
        mode: 'session_goal_state',
        mirrored: false,
        reason: 'No Prismer standing-objective goal context was mirrored for this dispatch',
      },
      ...patch,
    };
  }
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeRoleSkillSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'template'
  );
}

function renderRoleTemplateSkill(
  skillName: string,
  agents: string,
  roleTemplate: Record<string, unknown> | null,
): string {
  const mcpServers = Array.isArray(roleTemplate?.mcpServers) ? roleTemplate.mcpServers : [];
  const tools = new Set<string>();
  for (const server of mcpServers) {
    const rec = readPlainRecord(server);
    const allowlist = Array.isArray(rec?.toolsAllowlist) ? rec.toolsAllowlist : [];
    for (const tool of allowlist) {
      if (typeof tool === 'string' && tool.trim()) tools.add(tool.trim());
    }
  }
  const allowedTools = [...tools].join(' ');
  const roleTemplateSlug = JSON.stringify(readNonEmptyString(roleTemplate?.slug) ?? null);
  return `---
name: ${skillName}
description: Role-template operating playbook projected from Prismer RoleTemplate.
${allowedTools ? `allowed-tools: ${allowedTools}\n` : ''}metadata:
  prismer:
    source: role-template
    roleTemplateSlug: ${roleTemplateSlug}
---

# Role Template Playbook

${agents.trim()}
`;
}

interface PrismerGoalMirror {
  id: string;
  title: string;
  description?: string | null;
  status: 'active' | 'paused' | 'completed' | 'done' | 'cleared' | string;
  priority?: string;
}

export function parsePrismerGoals(value: unknown): PrismerGoalMirror[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): PrismerGoalMirror | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
      const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id;
      if (!id || !title) return null;
      return {
        id,
        title,
        description: typeof record.description === 'string' ? record.description : null,
        status: typeof record.status === 'string' ? record.status : 'active',
        priority: typeof record.priority === 'string' ? record.priority : undefined,
      };
    })
    .filter((entry): entry is PrismerGoalMirror => Boolean(entry));
}

export function writeHermesGoalState(
  profileName: string,
  sessionId: string,
  goals: PrismerGoalMirror[],
): { status: string } {
  const primary = goals[0]!;
  const nowSeconds = Date.now() / 1000;
  const status = normalizeGoalStatus(primary.status);
  const statePath = join(getHermesProfileDir(profileName), 'state.db');
  mkdirSync(dirname(statePath), { recursive: true });
  const db = new Database(statePath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)');
    const key = `goal:${sessionId}`;
    const previousRaw = db.prepare('SELECT value FROM state_meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    const previous = parseGoalState(previousRaw?.value);
    const goalText = formatHermesGoalText(goals);
    const state = {
      goal: goalText,
      status,
      turns_used: typeof previous.turns_used === 'number' ? previous.turns_used : 0,
      max_turns: typeof previous.max_turns === 'number' ? previous.max_turns : 20,
      created_at: typeof previous.created_at === 'number' ? previous.created_at : nowSeconds,
      last_turn_at: typeof previous.last_turn_at === 'number' ? previous.last_turn_at : 0,
      last_verdict:
        status === 'done'
          ? 'done'
          : typeof previous.last_verdict === 'string'
            ? previous.last_verdict
            : null,
      last_reason:
        status === 'done'
          ? 'Prismer goal projection completed'
          : typeof previous.last_reason === 'string'
            ? previous.last_reason
            : null,
      paused_reason:
        status === 'paused'
          ? 'prismer-goal-paused'
          : typeof previous.paused_reason === 'string' && status === 'paused'
            ? previous.paused_reason
            : null,
    };
    db.prepare(
      'INSERT INTO state_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(state));
    return { status };
  } finally {
    db.close();
  }
}

export function normalizeGoalStatus(status: string): string {
  const value = status.trim().toLowerCase();
  if (value === 'completed' || value === 'done') return 'done';
  if (value === 'paused') return 'paused';
  if (value === 'cleared' || value === 'cancelled' || value === 'failed') return 'cleared';
  return 'active';
}

function parseGoalState(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function formatHermesGoalText(goals: PrismerGoalMirror[]): string {
  if (goals.length === 1) {
    const goal = goals[0]!;
    return [goal.title, goal.description].filter(Boolean).join('\n\n');
  }
  return goals
    .map((goal, index) => {
      const priority = goal.priority ? `[${goal.priority}] ` : '';
      const description = goal.description ? ` — ${goal.description}` : '';
      return `${index + 1}. ${priority}${goal.title}${description}`;
    })
    .join('\n');
}

interface HermesConfigDocument {
  model?: string | Record<string, unknown>;
  custom_providers?: unknown;
  [key: string]: unknown;
}

function configurePrismerProvider(
  profileName: string,
  config: HermesProfileConfig,
  agentUsername?: string,
  workspaceId?: string,
): void {
  const baseUrl = resolvePrismerProviderBaseUrl(config);
  const apiKey = resolvePrismerApiKey(config);
  if (!baseUrl || !apiKey) {
    process.stderr.write(
      `[hermes-adapter] skipping Prismer provider bootstrap for profile ${profileName}: missing PRISMER_BASE_URL or PRISMER_API_KEY\n`,
    );
    return;
  }

  const profileDir = getHermesProfileDir(profileName);
  mkdirSync(profileDir, { recursive: true });
  writeEnvValue(join(profileDir, '.env'), config.prismerApiKeyEnv, apiKey);

  const configPath = join(profileDir, 'config.yaml');
  const doc = readHermesConfig(configPath);
  const customProviders = Array.isArray(doc.custom_providers) ? doc.custom_providers : [];
  const normalizedName = normalizeProviderName(config.prismerProviderName);
  const nextProvider = {
    name: config.prismerProviderName,
    base_url: baseUrl,
    key_env: config.prismerApiKeyEnv,
    api_mode: 'chat_completions',
    model: config.model,
  };
  const withoutOld = customProviders.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
    return normalizeProviderName(String((entry as { name?: unknown }).name ?? '')) !== normalizedName;
  });
  doc.custom_providers = [...withoutOld, nextProvider];

  const modelCfg =
    doc.model && typeof doc.model === 'object' && !Array.isArray(doc.model)
      ? { ...(doc.model as Record<string, unknown>) }
      : {};
  modelCfg.provider = `custom:${config.prismerProviderName}`;
  modelCfg.default = config.model;
  modelCfg.base_url = baseUrl;
  modelCfg.api_mode = 'chat_completions';

  // release201/26 §13.4a — pin vision config so a `custom:` provider agent can
  // RECEIVE images. Without this, hermes strips the image part and routes it to
  // the `vision_analyze_tool` aux LLM, which can't auto-detect a custom provider
  // → 502 on every inbound image.
  //
  // LOAD-BEARING KEY = `model.supports_vision: true` (source-traced 2026-05-30,
  // hermes v0.15.0). On the sessions API path we use (`/api/sessions/{id}/chat/
  // stream` → api_server._run_agent → AIAgent → conversation_loop), image
  // keep-vs-strip is decided SOLELY by `_model_supports_vision()` (run_agent.py
  // :3559/3579), which reads `model.supports_vision` via the override shortcut
  // (image_routing.py:102) and short-circuits models.dev — whose
  // PROVIDER_TO_MODELS_DEV has NO `custom` key, so an un-pinned custom provider
  // defaults to no-vision → strip → aux → 502. Pinning true is necessary AND
  // sufficient for our path.
  //
  // `agent.image_input_mode: native` is INERT on the sessions path (never read
  // there; `decide_image_input_mode` is only used by gateway/run.py's IM-platform
  // attachment path + CLI/TUI). We still pin it (harmless) to keep those other
  // paths correct, but DO NOT remove the supports_vision pin thinking native
  // does the work — it does not on the path we dispatch through.
  //
  // Effective resolution (release201/26 §13.4a, evidence-based 2026-05-30):
  // explicit `config.supportsVision` always wins; otherwise default off the
  // per-model `VISION_CAPABLE_MODELS` allowlist — measured by real cloud-proxy
  // probes (see the allowlist docblock + scripts/spike/model-vision-probe.ts),
  // NOT the old coarse `proxyProvider === 'deepseek' ? false : true` heuristic.
  // A model absent from the allowlist (unmeasured / inconclusive / verified
  // text-only like deepseek-v4-*) defaults to false; an operator can still pin
  // `supportsVision: true` to force it.
  const supportsVision = resolveSupportsVision(config.model, config.supportsVision);
  modelCfg.supports_vision = supportsVision;
  doc.model = modelCfg;

  // Only pin `agent.image_input_mode: native` when vision is on. When off we
  // write supports_vision:false but leave image_input_mode to hermes' default /
  // any operator value. Idempotent-preserve pattern: spread the existing agent
  // block, set only the managed key, keep operator siblings, write back.
  if (supportsVision) {
    const agentCfg =
      doc.agent && typeof doc.agent === 'object' && !Array.isArray(doc.agent)
        ? { ...(doc.agent as Record<string, unknown>) }
        : {};
    agentCfg.image_input_mode = 'native';
    doc.agent = agentCfg;
  }

  // release201/24 §Phase2 — register extra skill dirs so the skill-under-test
  // enters Hermes' native skill discovery (skills_list / skill tools). Without
  // this the agent never sees the eval skill ("doesn't exist on disk"); the
  // daemon's system-prompt injection is a separate channel the skill tools
  // don't read. Merge + de-dupe, preserving operator-set entries.
  if (Array.isArray(config.skillsExternalDirs) && config.skillsExternalDirs.length > 0) {
    const skillsCfg =
      doc.skills && typeof doc.skills === 'object' && !Array.isArray(doc.skills)
        ? { ...(doc.skills as Record<string, unknown>) }
        : {};
    const existing = Array.isArray(skillsCfg.external_dirs)
      ? (skillsCfg.external_dirs as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    skillsCfg.external_dirs = Array.from(new Set([...existing, ...config.skillsExternalDirs]));
    doc.skills = skillsCfg;
  }

  // release201/09 §9.4b (2026-05-30 hotfix, Option B2) — ALWAYS write the
  // memory: block with explicit values. Prior code only wrote it when
  // `enableBuiltinMemory: true`, relying on a now-disproved assumption that
  // hermes' code default was off. In reality hermes deep-merges user config
  // OVER `DEFAULT_CONFIG` (hermes_cli/config.py:4701) which sets
  // `memory.memory_enabled = True` (config.py:1373); `agent_init.py:1076`
  // then reads the merged value. Not writing a `memory:` block leaves builtin
  // MEMORY.md/USER.md injection ON, which caused the 2026-05-30 cross-
  // workspace contamination (CEO recited prior-workspace state from
  // ~/.hermes/profiles/<name>/memories/MEMORY.md after workspace clear).
  //
  // release201/26 §14 Phase A (#A1) — when `enableBuiltinMemory: true`,
  // explicit `true` lets hermes own MEMORY.md/USER.md injection on its path
  // (cloud recall runs shadow). Operator-set sibling keys (memory_char_limit,
  // provider, etc.) are preserved by spreading first.
  const memCfg =
    doc.memory && typeof doc.memory === 'object' && !Array.isArray(doc.memory)
      ? { ...(doc.memory as Record<string, unknown>) }
      : {};
  memCfg.memory_enabled = config.enableBuiltinMemory === true;
  memCfg.user_profile_enabled = config.enableBuiltinMemory === true;
  doc.memory = memCfg;

  // v2.1 §9.5 — daemon-as-hook-intake hook block merge.
  //
  // Idempotent: re-running configurePrismerProvider replaces ONLY the
  // prismer-daemon-managed hook commands (marker comment in the command
  // string) and preserves any operator-added hook entries. The 3 events
  // route Hermes shell-hooks into daemon `/v1/hooks/*` so memory recall
  // (pre_llm_call) and extract (post_llm_call) happen out-of-process.
  //
  // hooks_auto_accept: true bypasses Hermes' first-use consent prompt
  // (agent/shell_hooks.py L5) so the daemon can install hooks without
  // human interaction. We preserve an operator-set `false` so opting out
  // survives subsequent profile syncs.
  // release201/24 §Phase2 — eval sessions opt OUT of memory hooks so a
  // throwaway run neither reads contaminated recall nor writes poisoning
  // memories. Operator-added hook entries are left untouched (we only manage
  // the marked prismer-daemon commands), so skipping is safe.
  if (config.installMemoryHooks !== false) {
  const daemonPort = (process.env.PRISMER_DAEMON_PORT ?? '3210').trim() || '3210';
  const hookCmdFor = (event: string): string =>
    // Marker `# prismer-daemon-hook` lets the idempotent filter identify
    // prismer's own command and replace it on re-sync; operator-added
    // hook entries (without the marker) are preserved.
    `# prismer-daemon-hook\ncurl -sS -X POST http://127.0.0.1:${daemonPort}/v1/hooks/${event}?profile=${encodeURIComponent(profileName)}&adapter=hermes --data-binary @-`;
  const HOOK_EVENTS: Array<[string, number]> = [
    ['pre_llm_call', 30],
    ['post_llm_call', 30],
    ['on_session_end', 10],
  ];
  const existingHooks =
    doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)
      ? { ...(doc.hooks as Record<string, unknown>) }
      : {};
  for (const [event, timeoutSec] of HOOK_EVENTS) {
    const prevList = Array.isArray(existingHooks[event])
      ? (existingHooks[event] as Array<Record<string, unknown>>)
      : [];
    const operatorEntries = prevList.filter((entry) => {
      const cmd = entry && typeof entry === 'object'
        ? (entry as { command?: unknown }).command
        : null;
      return typeof cmd === 'string' && !cmd.includes('# prismer-daemon-hook');
    });
    existingHooks[event] = [
      { command: hookCmdFor(event), timeout: timeoutSec },
      ...operatorEntries,
    ];
  }
  doc.hooks = existingHooks;
  if (doc.hooks_auto_accept !== false) {
    doc.hooks_auto_accept = true;
  }
  }

  if (config.installPrismerMcpServer !== false) {
    const serverPath = resolvePrismerMcpServerPath(config);
    if (serverPath) {
      const mcpServers =
        doc.mcp_servers && typeof doc.mcp_servers === 'object' && !Array.isArray(doc.mcp_servers)
          ? { ...(doc.mcp_servers as Record<string, unknown>) }
          : {};
      // Idempotent: re-running configurePrismerProvider on an existing
      // profile preserves any operator-added MCP servers and only refreshes
      // the prismer-tasks block (path or env may have changed).
      // Why: MCP env is per-profile and inherited at spawn — tools cannot
      // recover per-call agent identity from the chat. We pin the agent's
      // username here so prismer-tasks (prismer.agent.send, etc.) always
      // attributes calls to the right agent instead of treating every call
      // as the API-key owner.
      const mcpEnv: Record<string, string> = {
        PRISMER_API_KEY: apiKey,
        PRISMER_BASE_URL: baseUrl.replace(/\/api\/v1\/?$/, ''),
      };
      if (workspaceId) {
        mcpEnv.PRISMER_WORKSPACE_ID = workspaceId;
      }
      if (agentUsername) {
        mcpEnv.PRISMER_AGENT_USERNAME = agentUsername;
      }
      const allowlist = resolveMcpAllowlist(config);
      if (allowlist) {
        mcpEnv.PRISMER_MCP_ALLOWLIST = allowlist.join(',');
      }
      mcpServers['prismer-tasks'] = {
        command: 'node',
        args: [serverPath],
        env: mcpEnv,
        enabled: true,
      };
      doc.mcp_servers = mcpServers;
    } else {
      process.stderr.write(
        `[hermes-adapter] skipping prismer-tasks MCP install for profile ${profileName}: server path not resolvable (set PRISMER_MCP_SERVER or HermesProfileConfig.prismerMcpServerPath)\n`,
      );
    }
  }

  writeFileSync(configPath, YAML.stringify(doc), 'utf8');
}

function resolvePrismerMcpServerPath(config: HermesProfileConfig): string | null {
  if (config.prismerMcpServerPath) return config.prismerMcpServerPath;
  if (process.env.PRISMER_MCP_SERVER) return process.env.PRISMER_MCP_SERVER;
  // Walk up from this module to find sdk/prismer-cloud/mcp/dist/index.js
  // (works for both `node_modules/@prismer/runtime/...` and in-repo dev).
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('@prismer/mcp-server');
  } catch {
    /* fall through */
  }
  // Last-resort dev heuristic — repo-relative.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // …/runtime/src/adapters/hermes → walk to sdk/prismer-cloud/mcp/dist
    const candidate = join(here, '../../mcp/dist/index.js');
    if (existsSync(candidate)) return candidate;
    const candidate2 = join(here, '../../../mcp/dist/index.js');
    if (existsSync(candidate2)) return candidate2;
    const candidate3 = join(here, '../../../../mcp/dist/index.js');
    if (existsSync(candidate3)) return candidate3;
  } catch {
    /* fall through */
  }
  return null;
}

function runHermesJson(args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`hermes ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`hermes ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim() || '<no output>'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`hermes ${args.join(' ')} returned invalid JSON: ${(err as Error).message}`));
      }
    });
  });
}

async function createHermesKanbanTask(
  hermes: { profileName: string },
  task: {
    title: string;
    body: string;
    triage: boolean;
    idempotencyKey: string;
    createdBy: string;
  },
  timeoutMs: number,
): Promise<unknown> {
  const args = [
    '-p',
    hermes.profileName,
    'kanban',
    'create',
    task.title,
    '--body',
    task.body,
    ...(task.triage ? ['--triage'] : []),
    '--idempotency-key',
    task.idempotencyKey,
    '--created-by',
    task.createdBy,
    '--json',
  ];
  // runtime/ is TS-only: we speak to the user's `hermes` binary over CLI/HTTP.
  // No python subprocess fallback (see docs/refactor/07-kill-list.md §3).
  // If the installed hermes lacks the `kanban` subcommand, the user must
  // upgrade hermes; we surface the original CLI error directly.
  return runHermesJson(args, timeoutMs);
}

function readHermesConfig(path: string): HermesConfigDocument {
  if (!existsSync(path)) return {};
  try {
    return (YAML.parse(readFileSync(path, 'utf8')) ?? {}) as HermesConfigDocument;
  } catch (err) {
    throw new Error(`Failed to parse Hermes config at ${path}: ${(err as Error).message}`);
  }
}

function writeEnvValue(path: string, key: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const next = lines.filter((line) => !line.startsWith(`${key}=`) && line.trim() !== '');
  next.push(`${key}=${quoteEnv(value)}`);
  writeFileSync(path, `${next.join('\n')}\n`, 'utf8');
}

function quoteEnv(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function getHermesProfileName(profile: Pick<AgentProfile, 'id' | 'agentUsername' | 'config'>): string {
  const configured =
    profile.config && typeof profile.config.hermesProfileName === 'string'
      ? profile.config.hermesProfileName
      : undefined;
  return configured && configured !== 'default'
    ? configured
    : profile.agentUsername || profile.id.slice(0, 8);
}

export function getHermesProfileDir(profileName: string): string {
  const root = process.env.HERMES_HOME || join(homedir(), '.hermes');
  if (!profileName || profileName === 'default') return root;
  return join(root, 'profiles', profileName);
}

/**
 * release201/09 §9.4b — best-effort wipe of the hermes-local memory layer
 * for a single profile. Called by the daemon when cloud emits
 * `workspace.clear.daemon-cleanup` for a workspace this daemon hosted agents
 * in. Wipes the 4 paths hermes writes that survive cloud-side cascade:
 *
 *   ~/.hermes/profiles/<n>/memories/MEMORY.md   builtin-memory recall corpus
 *   ~/.hermes/profiles/<n>/memories/USER.md     builtin-memory user profile
 *   ~/.hermes/profiles/<n>/sessions/state.db    per-session goal/turn state
 *   ~/.hermes/profiles/<n>/SOUL.md              regenerated on next spawn
 *
 * Skills/, config.yaml, .env are NOT touched: skills/ has its own sha256-diff
 * sync (§9.3.2); config.yaml carries the prismer-managed memory: + hooks:
 * blocks the next configurePrismerProvider() re-emits anyway; .env holds the
 * API key.
 *
 * Each path is removed independently; failures are stderr-logged but do not
 * throw — the cloud-side rows are already gone, so a partial wipe degrades
 * to "stale orphan files" not "broken state". Returns the per-path result so
 * callers can surface a structured summary.
 */
export function wipeHermesProfileMemory(profileName: string): Array<{
  path: string;
  status: 'removed' | 'absent' | 'failed';
  error?: string;
}> {
  const profileDir = getHermesProfileDir(profileName);
  const targets = [
    join(profileDir, 'memories', 'MEMORY.md'),
    join(profileDir, 'memories', 'USER.md'),
    join(profileDir, 'sessions', 'state.db'),
    join(profileDir, 'SOUL.md'),
  ];
  return targets.map((target) => {
    try {
      if (!existsSync(target)) return { path: target, status: 'absent' as const };
      rmSync(target, { force: true });
      return { path: target, status: 'removed' as const };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[hermes-adapter] wipeHermesProfileMemory failed path=${target}: ${msg}\n`,
      );
      return { path: target, status: 'failed' as const, error: msg };
    }
  });
}

function resolveHermesSkillsRoot(
  profile: Pick<AgentProfile, 'id' | 'agentUsername' | 'config'>,
  profileName = getHermesProfileName(profile),
): string {
  if (typeof profile.config.skillsDir === 'string' && profile.config.skillsDir.trim()) {
    return profile.config.skillsDir.trim();
  }
  return join(getHermesProfileDir(profileName), 'skills');
}

/**
 * Deterministic per-profile port. Same profileName always picks the same port;
 * different profileNames get different ports with high probability for small N.
 * Caller is expected to override with config.port when it's set to a non-default
 * value.
 */
function portForProfile(profileName: string, basePort: number, span = 1000): number {
  let h = 0;
  for (let i = 0; i < profileName.length; i++) h = (h * 31 + profileName.charCodeAt(i)) | 0;
  return basePort + (Math.abs(h) % span);
}

function resolvePrismerProviderBaseUrl(config: HermesProfileConfig): string {
  // Priority 1: operator override always wins — they get exactly what they
  // pinned, regardless of `proxyProvider`. Allows pointing a profile at a
  // staging cloud or a local mock without losing the per-agent selector
  // semantics for the other profiles.
  if (config.prismerProviderBaseUrl) return config.prismerProviderBaseUrl.replace(/\/$/, '');
  const cloudBase = process.env.PRISMER_BASE_URL?.replace(/\/$/, '');
  if (!cloudBase) return '';
  // Priority 2: proxyProvider chain switch (release202/07). Any chain id other
  // than newapi/default rewrites the base to the per-provider alias so the
  // cloud walks that chain (see src/app/api/proxy/[provider]/chat/completions).
  // Default `newapi` keeps the platform aggregator path.
  const provider = config.proxyProvider;
  if (provider && provider !== 'newapi' && provider !== 'default') {
    return `${cloudBase}/api/v1/proxy/${encodeURIComponent(provider)}`;
  }
  return `${cloudBase}/api/v1`;
}

function resolvePrismerApiKey(config: HermesProfileConfig): string {
  return process.env[config.prismerApiKeyEnv] || process.env.PRISMER_API_KEY || '';
}

export function resolveMcpAllowlist(config: Pick<HermesProfileConfig, 'mcpAllowlist' | 'roleTemplate'>): string[] | null {
  if (Array.isArray(config.mcpAllowlist)) return normalizeAllowlist(config.mcpAllowlist);
  const prismerServer = config.roleTemplate?.mcpServers?.find((server) => {
    const record = server as Record<string, unknown>;
    return record.package === '@prismer/mcp-server' || record.name === 'prismer-tasks';
  });
  if (!prismerServer) return null;
  return Array.isArray(prismerServer.toolsAllowlist) ? normalizeAllowlist(prismerServer.toolsAllowlist) : null;
}

function normalizeAllowlist(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Cleanup-2 (2026-05-25) — derive a stable LLM idempotency key per outbound
 * LLM call. Sent as `X-Prismer-Idempotency-Key` on the adapter's fetch so the
 * cloud llm-proxy can return a Redis-cached response when the daemon crashes
 * mid-stream and the same task is re-dispatched. Without this, a crash-resume
 * cycle double-charges the user's OpenAI tokens (see P0-2 caveat).
 *
 * Inputs:
 *   - taskRunId: stable per dispatch (we use task.taskId, which dispatch.ts
 *     today mirrors as the run id — see StepRecorder taskRunId comment).
 *   - attemptNo: dispatch.ts retry counter; surfaced via task.metadata.attemptNo
 *     when present, defaulted to 1 otherwise. Different attempts get distinct
 *     keys so a server-side error on attempt 1 does NOT serve a stale failure
 *     to attempt 2.
 *   - stepSeq: per-adapter monotonic counter for multi-call dispatches.
 *     Hermes today issues exactly one outbound LLM fetch per dispatch (either
 *     /v1/runs or /v1/chat/completions), so we hardcode 0 for the first call
 *     and bump if/when we add a second call site. The cloud-side cache layer
 *     does not require monotonicity — only key stability per (run, attempt,
 *     step) tuple — so a constant-0 stepSeq is correct under today's call
 *     pattern.
 *   - model + prompt: bind the cache entry to the actual payload so accidental
 *     prompt changes (template tweak, recall injection) bust the cache.
 */
function llmIdempotencyKey(input: {
  taskRunId: string;
  attemptNo: number;
  stepSeq: number;
  prompt: string;
  model: string;
}): string {
  const h = createHash('sha256');
  h.update(input.taskRunId);
  h.update('|');
  h.update(String(input.attemptNo));
  h.update('|');
  h.update(String(input.stepSeq));
  h.update('|');
  h.update(input.model);
  h.update('|');
  h.update(input.prompt);
  return `llm:${h.digest('hex').slice(0, 32)}`;
}

/**
 * Pull the dispatch attempt counter from task.metadata. dispatch.ts may or
 * may not surface it (P2 retry loop owns the variable); when absent we
 * default to 1 so the first attempt's key is still stable.
 */
function readAttemptNo(task: TaskInput): number {
  const raw = (task.metadata ?? {}) as Record<string, unknown>;
  const v = raw.attemptNo;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return Math.floor(v);
  return 1;
}

// release201/25 §16.4 A3 — `consumeSse` (legacy /v1/runs SSE parser) and
// `consumeChatCompletionsSse` (legacy /v1/chat/completions SSE parser)
// were removed 2026-05-29. The sessions API parser lives in
// `sessions-sse.ts` (consumeSessionsSse); it carries the most structured
// lifecycle (assistant.delta / tool.started/completed/failed /
// approval.request / run.completed.usage) and is the single source of
// truth for hermes SSE event handling.

/**
 * §16.4 A4 / §16.12 S2 — probe GET /v1/capabilities at service-spawn
 * time so dispatch() can verify the upstream advertises
 * `session_chat_streaming` (the only supported dispatch path after
 * §16.4 A3 removed the legacy /v1/runs + /v1/chat/completions fallbacks).
 *
 * Returns the `features` map (subset hermes advertises) or undefined
 * when the probe fails. Undefined causes dispatch() to fail with an
 * explicit adapter error rather than silently degrade.
 *
 * Failure modes are distinguished:
 *   - 404 (pre-0.15 hermes) → definitive, no retry, returns undefined
 *   - 401/403 (auth)        → definitive, no retry, returns undefined
 *   - timeout / 5xx         → transient, retried up to 3 times with backoff
 *
 * Earlier this had a single 3s timeout, which mis-flagged a slow first
 * /v1/capabilities response as "unsupported" right after waitForHealthy
 * passed — capability gate would then trip even though hermes was
 * perfectly capable. The retry loop survives the cold-call lag without
 * extending the unbounded path for genuinely-missing endpoints.
 */
async function probeHermesCapabilities(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, boolean> | undefined> {
  const RETRY_DELAYS_MS: readonly number[] = [0, 1_500, 3_500]; // total budget ~ 5s + per-call timeout 4s
  let lastErr: string | null = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    const delay = RETRY_DELAYS_MS[i] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(4_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { features?: Record<string, boolean> };
        const features = json?.features ?? {};
        process.stderr.write(
          `[hermes-adapter] capabilities: session_chat_streaming=${features.session_chat_streaming === true} run_approval_response=${features.run_approval_response === true}${i > 0 ? ` (after ${i + 1} attempts)` : ''}\n`,
        );
        return features;
      }
      // Definitive failures — no retry, the endpoint isn't going to materialise.
      if (res.status === 404) {
        process.stderr.write(
          `[hermes-adapter] /v1/capabilities returned 404 — installed hermes pre-dates the sessions API. Upgrade hermes (NousResearch/hermes-agent uses calver vYYYY.M.D — check tags API for latest)\n`,
        );
        return undefined;
      }
      if (res.status === 401 || res.status === 403) {
        process.stderr.write(
          `[hermes-adapter] /v1/capabilities returned ${res.status} — API_SERVER_KEY mismatch between daemon and hermes\n`,
        );
        return undefined;
      }
      lastErr = `${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  process.stderr.write(
    `[hermes-adapter] /v1/capabilities probe failed after ${RETRY_DELAYS_MS.length} attempts (last: ${lastErr ?? 'unknown'}); sessions API will be unavailable\n`,
  );
  return undefined;
}

/**
 * Idempotently write the prismer-im-collab SKILL.md into the profile's
 * skills dir. Called at ensureService-time (so the verify probe below has
 * something to assert against) AND on every dispatch (so the runtime
 * version stays authoritative even if the file was deleted between turns).
 * Best-effort: a failed write logs but never throws — dispatch can still
 * proceed degraded, the verify probe will then loud-warn.
 */
function installPrismerImSkill(profileName: string): void {
  try {
    const content = getPrismerImSkillContent();
    if (content === null) {
      // The canonical SKILL.md is missing — the prebuild mirror failed or the
      // runtime is running from an unsupported layout. Loud-warn and skip
      // (best-effort: dispatch can still proceed; the verify probe will then
      // mark `missing` and metrics will surface the regression).
      process.stderr.write(
        `[hermes-adapter] cannot locate built-in skill ${PRISMER_IM_SKILL_NAME} on disk; skipped install for ${profileName}\n`,
      );
      return;
    }
    const profileDir = getHermesProfileDir(profileName);
    const skillDir = join(profileDir, 'skills', PRISMER_IM_SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[hermes-adapter] failed to install ${PRISMER_IM_SKILL_NAME} skill for ${profileName}: ${(err as Error).message}\n`,
    );
  }
}

/** Outcome of the §13.3 #3 skill-load verify probe (also the metric label). */
export type HermesSkillVerifyResult = 'loaded' | 'missing' | 'skipped' | 'probe_failed';

/**
 * Emit `hermes_skill_verify_total{result=...}` as a structured stderr line.
 *
 * Why stderr and not daemonMetricEmit: this fires at ensureService-time,
 * where the adapter has no CloudClient / workspaceId handle (those live on
 * the dispatch path). The daemon's metric-pump tails adapter stderr for
 * `[metric]`-tagged counter lines, so a one-line counter here is the
 * lowest-friction sink that stays consistent with the daemon_run_resume_total
 * style (run-resume.ts) without threading a metric sink through ServicePool.
 */
function emitHermesSkillVerifyMetric(result: HermesSkillVerifyResult, slug: string): void {
  process.stderr.write(`[metric] hermes_skill_verify_total{result=${result},slug=${slug}} 1\n`);
}

/**
 * release201/26 §13.3 #3 — verify the SKILL.md we wrote into the profile is
 * actually LOADED by hermes, turning "written ≠ loaded" into a fail-fast
 * signal. This is the same trap release201/25 §16 hit three times during the
 * spike (wrote into profile, never verified).
 *
 * Probes the read-only `GET /v1/skills` JSON listing (api_server.py
 * _handle_skills, line 1149-1178 upstream) — no chat message needed — and
 * asserts `slug` appears in `data[].name`. The `name` there comes from the
 * SKILL.md frontmatter `name:` (skills_tool._find_all_skills line 588),
 * which for prismer-im-collab equals both the frontmatter name and the dir
 * name, so the slug constant is a safe assertion target.
 *
 * Outcome contract:
 *   - skills_api capability false/absent (pre-skills-api hermes) → 'skipped',
 *     debug log only, no warn (graceful degrade, not an error).
 *   - slug present in /v1/skills → 'loaded', no warn.
 *   - slug absent → 'missing' + LOUD warn. We deliberately do NOT hard-fail
 *     dispatch: a missing collab skill degrades behaviour (the agent loses
 *     the channel-routing guidance) but is not fatal — the model can still
 *     reply, and a hard block would convert a soft regression into a total
 *     outage. The loud warn + metric make it observable so it can't rot
 *     silently. (Flip to a thrown error here if §13.3 later upgrades the
 *     collab skill to a hard dispatch precondition.)
 *   - network/timeout/bad-JSON → 'probe_failed', warn, never blocks
 *     ensureService (the probe is observability, not a gate).
 */
export async function verifyHermesSkillLoaded(
  baseUrl: string,
  apiKey: string,
  slug: string,
  capabilities: Record<string, boolean> | undefined,
): Promise<HermesSkillVerifyResult> {
  if (capabilities?.skills_api !== true) {
    process.stderr.write(
      `[hermes-adapter] /v1/skills verify skipped: skills_api not advertised (older hermes) — cannot confirm ${slug} loaded\n`,
    );
    emitHermesSkillVerifyMetric('skipped', slug);
    return 'skipped';
  }
  try {
    const res = await fetch(`${baseUrl}/v1/skills`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      process.stderr.write(
        `[hermes-adapter] /v1/skills returned ${res.status}; cannot verify ${slug} loaded (probe non-fatal)\n`,
      );
      emitHermesSkillVerifyMetric('probe_failed', slug);
      return 'probe_failed';
    }
    const json = (await res.json()) as { data?: Array<{ name?: string }> };
    const loaded = Array.isArray(json?.data)
      ? json.data.some((s) => s?.name === slug)
      : false;
    if (loaded) {
      process.stderr.write(`[hermes-adapter] /v1/skills verify: ${slug} loaded ✓\n`);
      emitHermesSkillVerifyMetric('loaded', slug);
      return 'loaded';
    }
    console.error(
      `[hermes-adapter] ❌ skill ${slug} written to profile but NOT loaded by hermes (/v1/skills miss) — check profile home override / skills dir`,
    );
    emitHermesSkillVerifyMetric('missing', slug);
    return 'missing';
  } catch (err) {
    process.stderr.write(
      `[hermes-adapter] /v1/skills probe failed (${(err as Error).message}); cannot verify ${slug} loaded (probe non-fatal)\n`,
    );
    emitHermesSkillVerifyMetric('probe_failed', slug);
    return 'probe_failed';
  }
}

/**
 * Probes Hermes readiness via `/health/detailed`.
 *
 * The basic `/health` endpoint returns 200 as soon as the gateway dispatcher
 * binds its port — but the `api_server` PLATFORM inside the gateway can still
 * be in `connecting` state at that moment, which means `/v1/capabilities`
 * (and `/api/sessions/...`) are not yet servable. Documented states (see
 * hermes-agent gateway/platforms/base.py: `_write_runtime_status_safe`):
 * `connecting` → `connected` → `disconnected`. The `/v1/capabilities` route
 * only responds with the feature map after api_server hits `connected`.
 *
 * In a real Kubernetes pod with full skills + MCP servers + resource limits,
 * the gap between dispatcher-bound and api_server-connected can be 10-15s.
 * The previous `checkHealth` accepted `/health` 200 too eagerly, so the
 * downstream `probeHermesCapabilities` ran while api_server was still
 * connecting → request hung / timed out / 503'd → `capabilities` cached
 * `undefined` for the lifetime of the `HermesService` instance → every
 * subsequent dispatch surfaced `Hermes does not advertise
 * session_chat_streaming` (the A4 capability gate at adapter line ~755).
 * Symptom thread: 2026-05-30 evening — dispatch failed 3× for agent
 * z3blg1oz even though hermes v0.15.1 was correctly installed in the pod
 * image and `/v1/capabilities` returned `session_chat_streaming: true` when
 * probed manually inside the same image post-startup.
 *
 * The detailed endpoint is documented at
 * https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server.
 */
interface HermesDetailedHealth {
  status?: string;
  gateway_state?: string;
  platforms?: Record<string, { state?: string } | undefined>;
}

async function checkHealth(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health/detailed`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as HermesDetailedHealth;
    if (json.status !== 'ok') return false;
    // The gateway dispatcher itself is up before per-platform connectors
    // finish handshaking. We need BOTH bits: gateway running AND api_server
    // platform connected (the latter is what serves /v1/capabilities and
    // /api/sessions). gateway_state may be absent on older builds — treat
    // missing as best-effort OK rather than hard-fail.
    if (json.gateway_state && json.gateway_state !== 'running') return false;
    const apiServerState = json.platforms?.api_server?.state;
    return apiServerState === 'connected';
  } catch {
    return false;
  }
}

async function waitForHealthy(baseUrl: string, apiKey: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(baseUrl, apiKey)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Hermes did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

async function stopStaleHermesGateways(profileName: string, port: number, timeoutMs: number): Promise<void> {
  const pids = findHermesGatewayPids(profileName, port);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue;
    }
  }
  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  while (Date.now() < deadline) {
    const alive = pids.filter(pidAlive);
    if (alive.length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of pids) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function findHermesGatewayPids(profileName: string, port: number): number[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const current = process.pid;
    const escapedProfile = escapeRegExp(profileName);
    const profilePattern = new RegExp(`(?:^|\\s)-p\\s+${escapedProfile}(?:\\s|$)`);
    const portPattern = new RegExp(`(?:^|\\s)API_SERVER_PORT=${port}(?:\\s|$)`);
    return out
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        const match = /^(\d+)\s+(.+)$/.exec(trimmed);
        if (!match) return null;
        const pid = Number.parseInt(match[1]!, 10);
        const command = match[2]!;
        if (!Number.isFinite(pid) || pid === current) return null;
        if (!isHermesGatewayCommand(command)) return null;
        if (!profilePattern.test(command) && !portPattern.test(command)) return null;
        return pid;
      })
      .filter((pid): pid is number => pid !== null);
  } catch {
    return [];
  }
}

function isHermesGatewayCommand(command: string): boolean {
  if (!/\bgateway\b/.test(command) || !/\brun\b/.test(command)) return false;
  return /(^|\s)(?:\S*\/)?hermes(?:\s|$)/.test(command);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
