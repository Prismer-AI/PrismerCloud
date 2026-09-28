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
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as YAML from 'yaml';
import { z } from 'zod';
import type {
  AdapterDef,
  AdapterService,
  AgentProfile,
  DispatchCallOptions,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from '../../contract.js';
import { categorizeDispatchError } from '../../contract.js';
import type { AgentSlashCommand } from '../../coding/shared/index.js';
import { getCapabilitySnapshot } from '../../../daemon/capabilities.js';
import { HermesSkillLoader } from './skill-loader.js';
import { inspectSkillTree, skillAvailabilityContextFromEnvFiles, reconcileSkillDisables, assertUnambiguousSkillImports, explicitGrantNativeDisables } from '../../../daemon/skill-availability.js';
import { installHermesBundledSkill, projectHermesSkillRoot } from './native-skill-projection.js';
import { getRunSessionRegistry } from '../../../daemon/memory/run-session-map.js';
// memory211/01 W3 轴E — stable memory digest, injected at the system-prompt tail.
import { renderMemoryDigestBlock } from '../../../daemon/memory/digest.js';
import { mintCapV2 } from '../../../daemon/memory/cap.js';
import { reportCapabilityIncident } from '../../../daemon/ota/ota-check.js';
import { getHermesSessionMapper } from './sessions-mapper.js';
import { deriveExecutionContext, dispatchViaSessions } from './sessions-dispatcher.js';
import { dispatchViaRuns } from './runs-dispatcher.js';
import { deriveDispatchKind } from './flag.js';
import { CONVERSATION_CONTEXT_SCHEMA_DOC } from '../../../daemon/conversation-context-schema-doc.js';
import { isVersionInRange, parseVersionFromStdout } from '../../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../../known-versions.js';
// product204/09 §2.3 — cloud-resolved skill config env (metadata.skillConfigEnv);
// Hermes writes it into the per-profile .env (seam b), not the spawn env.
// product204/37 WS-3 — role params: secret/user-kind ride roleParamsEnv (→ .env,
// same seam as skillConfigEnv); non-secret behaviour ride roleParams (→ prompt).
import {
  renderRoleParamsBlock,
  roleParamsEnvFromMetadata,
  roleParamsFromMetadata,
  skillConfigEnvFromMetadata,
} from '../../prismer-env.js';
import {
  resolveLocalProvider,
  isLocalProviderSelector,
  hermesApiModeForType,
  hermesWireBaseUrl,
} from '../../shared/local-provider.js';

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
 *   2026-09-10 — deepseek's vision exp model PASSES at the wire: official
 *   vision guide (api-docs.deepseek.com/zh-cn/guides/vision) + live round-trip
 *   (`image_url` data-URL part → HTTP 200, image tokens billed). Images are
 *   accepted ONLY in `user` messages; the two verdicts above still stand for
 *   plain flash/pro.
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
  'deepseek-v4-flash-vision-exp', // 2026-09-10 official vision guide + live image-part round-trip
]);

/**
 * release202/04 §3.3 P3 — effective vision capability for a model id. Same
 * resolution as the config builder (`config.supportsVision ?? allowlist`),
 * extracted so the sessions dispatch path can surface it in
 * `<execution_context><model supports_vision=…>` without re-deriving the rule.
 */
function resolveSupportsVision(
  model: string,
  explicit: boolean | undefined,
  proxyProvider?: string,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  // Desktop-202 Phase 7 (docs/desktop202/12 §2b): a matched local provider
  // profile carries its own `vision` capability bit — it governs the
  // vision-gated image input for BYOK / Ollama models (small Ollama models
  // auto-degrade as-file). Falls through to the cloud-model allowlist when no
  // local profile matches or the profile omits the bit.
  const local = resolveLocalProvider(proxyProvider);
  if (local && typeof local.vision === 'boolean') return local.vision;
  return VISION_CAPABLE_MODELS.has(model);
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
 * Source of truth: `sdk/cloud/catalog/skills/prismer-im-collab/SKILL.md`.
 * Build pipeline mirrors that directory into `runtime/built-in-skills/` so the
 * npm tarball ships the same file the cloud-side `upsertBuiltInSkills` scanner
 * reads (see `runtime/scripts/prebuild-copy-built-in-skills.cjs`). At runtime
 * we read the on-disk copy via `readFileSync` instead of inlining the markdown
 * into a TS template literal — keeping the single source of truth honest.
 */
const PRISMER_IM_SKILL_NAME = 'prismer-im-collab';
const PRISMER_ROLE_SKILL_PREFIX = 'prismer-role';
/**
 * memory203/18 R4.2 — the builtin `memory` skill (browse-first write flow +
 * recall discipline) is installed into EVERY hermes profile's skills dir
 * alongside prismer-im-collab. Root cause this closes: the memory/memory-dream
 * SKILL.md never reached the hermes LLM context (only prismer-im-collab + the
 * role skill were installed), so the MEMORY_CORE_DIRECTIVE's "second layer"
 * (the detailed skill) was a dangling reference and agents rationally bypassed
 * memory for raw file reads.
 *
 * `memory-dream` (the convergence loop) stays ORCHESTRATOR-scoped: it is only
 * installed when the profile's `taskAuthority` config bit is 'orchestrator'
 * (its curation write verbs are orchestrator-gated cloud-side anyway; skipping
 * the install keeps executor prompts lean).
 */
const MEMORY_SKILL_NAME = 'memory';
const MEMORY_DREAM_SKILL_NAME = 'memory-dream';
/**
 * product209/20 — PKF authoring is a first-class Hermes-native capability,
 * not only an opaque Runtime prompt fragment. Keeping these in the profile
 * catalog makes `/v1/skills`, slash discovery, and the injected skill context
 * agree on the same source of truth.
 */
const PKF_WRITING_SKILL_NAME = 'pkf-writing';
const PKF_SVG_SKILL_NAME = 'pkf-svg';
const REQUIRED_HERMES_SKILL_NAMES = [
  PRISMER_IM_SKILL_NAME,
  PKF_WRITING_SKILL_NAME,
  PKF_SVG_SKILL_NAME,
] as const;

/**
 * Resolve the on-disk path to the canonical `SKILL.md` for a built-in skill.
 *
 * Search order — first hit wins:
 *   1. `<package>/built-in-skills/<slug>/SKILL.md`  — npm tarball layout
 *      (prebuild script populates this; `__dirname` resolves to either
 *      `dist/` for the built bundle or `src/adapters/hermes/` for ts-node
 *      / vitest).
 *   2. Repo-canonical `sdk/cloud/catalog/skills/<slug>/SKILL.md`
 *      walked from this source file — used by vitest + dev runs where the
 *      mirror under `runtime/built-in-skills/` has not been populated.
 *
 * Returns `null` if no candidate exists. Callers must handle null —
 * `installBuiltInHermesSkill` logs to stderr and falls through (best-effort).
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
  //   src dev:  /sdk/prismer/src/adapters/hermes/index.ts
  //             -> ../../../built-in-skills/<slug>/SKILL.md (if prebuild ran)
  const tarballCandidates = [
    join(here, '..', 'built-in-skills', slug, 'SKILL.md'),                     // dist/index.js anchor
    join(here, '..', '..', '..', '..', 'built-in-skills', slug, 'SKILL.md'),   // src/adapters/persistence/hermes anchor → runtime/built-in-skills
  ];

  // Candidate 2: repo-canonical source — vitest / dev runs without prebuild.
  //   /sdk/prismer/src/adapters/persistence/hermes/index.ts
  //   -> ../../../../../cloud/catalog/skills/<slug>/SKILL.md
  const canonicalCandidate = join(here, '..', '..', '..', '..', '..', 'cloud', 'catalog', 'skills', slug, 'SKILL.md');

  for (const candidate of [...tarballCandidates, canonicalCandidate]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * release203/13 §2.1 — per-role Hermes-native skill scope. Units are Hermes
 * bundled `category` (preferred) or skill `name`. allow ⇒ net-body keep-only;
 * deny ⇒ subtract-more on top of the global floor.
 */
const NativeSkillScopeSchema = z.object({
  mode: z.enum(['allow', 'deny']),
  categories: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
});
type NativeSkillScope = z.infer<typeof NativeSkillScopeSchema>;

/**
 * release203/16 §3 — per-role Hermes toolset scope. Units are Hermes toolset
 * names (flat, no category hierarchy — distinct from nativeSkillScope which is
 * skill-level). allow ⇒ keep ONLY the listed toolsets (net-body); deny ⇒
 * disable the listed toolsets. Projected → config.yaml `agent.disabled_toolsets`
 * (verified against hermes-agent toolsets.py TOOLSETS + agent/agent_init.py
 * disabled_toolsets + hermes_cli/tools_config.py:1353-1360).
 */
const ToolsetScopeSchema = z.object({
  mode: z.enum(['allow', 'deny']),
  toolsets: z.array(z.string()).default([]),
});
type ToolsetScope = z.infer<typeof ToolsetScopeSchema>;

// Exported for unit test (memory203 doc 10 §3) so the config-gen test can parse
// a production-shaped config (with all defaults populated) before driving
// configurePrismerProvider.
export const HermesProfileConfigSchema = z.object({
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
   * profile. RETIRED FOR FIRST-PARTY AGENTS (2026-07-19, per the standing
   * "skill + CLI is primary, MCP is third-party-only" ruling): task / memory /
   * asset operations go through the `cloud` CLI + platform toolsets, not MCP.
   * Default flipped to false — in agent-rt pods the install had been failing
   * silently anyway (server path not resolvable from the OTA bundle), so
   * agents already run without it. The knob stays for explicit third-party
   * opt-in only.
   */
  installPrismerMcpServer: z.boolean().default(false),
  /**
   * Override the absolute path to @prismer/mcp-server's `dist/index.js`.
   * If unset the adapter resolves it via Node's module resolver from the
   * runtime install location, then falls back to PRISMER_MCP_SERVER env.
   */
  prismerMcpServerPath: z.string().optional(),
  /**
   * Desktop-202 doc 18 §4 — install the Prismer MemoryProvider plugin shell
   * (`plugins/memory/prismer/`) into the Hermes profile and pin
   * `memory.provider: prismer` in config.yaml. This is the recall-tools正门 (B
   * path, P0) and **structurally excludes Honcho** (Hermes single external
   * provider). CAPABILITY BIT, default OFF: only the desktop daemon opts in
   * (via profile config or `PRISMER_MEMORY_PROVIDER=1`). CLI / K8s daemons
   * leave it off → config.yaml `memory.provider` untouched → zero behaviour
   * change (铁律回归, doc 18 §14).
   */
  installMemoryProvider: z.boolean().default(false),
  /**
   * Desktop-202 doc 19 §8 — install the **reversible recall-tools plugin
   * lane** (`plugins/tools/prismer-recall/`) into the SHARED Hermes home root
   * (`<HERMES_HOME>/plugins/`, the only dir scanned for standalone plugins) and
   * add it to the per-profile config.yaml `plugins.enabled` allow-list. This registers the
   * agent-driven `memory_search` / `memory_load` tools via Hermes'
   * `register_tool` (NOT a MemoryProvider), so it gives the agent the recall
   * tool FACE without pinning `memory.provider` and without tripping the
   * single-external-provider exclusivity (Honcho stays available). SEPARATE
   * from `installMemoryProvider` (the D5 provider path, doc 18 §4) — these two
   * are mutually independent capability bits; recall-tools is the lighter,
   * fully reversible binding (delete the dir + drop from `plugins.enabled` =
   * gone). CAPABILITY BIT, default OFF → zero behaviour change (no plugin, no
   * `plugins.enabled` entry). Opt in via this flag or `PRISMER_RECALL_TOOLS_PLUGIN=1`.
   */
  installRecallToolsPlugin: z.boolean().default(false),
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
  /**
   * product205/03 §3.4 (M6) — runtime action-governance mode.
   *   - `auto` (default): HERMES_YOLO_MODE on — dangerous-command bridge
   *     disabled, pod-local actions run direct (personal workspace, zero
   *     regression). Ring 0 hard floor still applies (hermes blocklist).
   *   - `gated`: HERMES_YOLO_MODE off — hermes dangerous-command bridge
   *     active, `approval.request` SSE event fires for Ring 1 patterns, the
   *     daemon async-parks (tear-down + awaiting_human_approval + §3.5 bundle)
   *     and cloud materializes a `runtime_action` approval. Team workspace
   *     default. Decoupled from `approvalPolicy`/forceAutonomous (§1.1): the
   *     prompt stays autonomous; only the runtime floor toggles.
   */
  runtimeApprovalMode: z.enum(['auto', 'gated']).optional().default('auto'),
  /** Agent-level MCP tool allowlist. Empty/null means all tools. Supports exact names and trailing * wildcards. */
  mcpAllowlist: z.array(z.string()).nullable().optional(),
  /**
   * release203/13 — per-role Hermes-native skill scope. `deny` subtracts more
   * on top of the global floor; `allow` keeps ONLY the listed categories/skills
   * (net-body). Null/absent = global floor only. Projected from
   * IMRoleTemplate.nativeSkillScope (top-level + roleTemplate snapshot).
   */
  nativeSkillScope: NativeSkillScopeSchema.nullable().optional(),
  /**
   * release203/16 §3 — per-role Hermes toolset scope. `deny` disables the listed
   * toolsets; `allow` keeps ONLY the listed toolsets (every other known toolset
   * disabled). Null/absent = no toolset restriction (Hermes default). Projected
   * from IMRoleTemplate.toolsetScope (top-level + roleTemplate snapshot) →
   * config.yaml `agent.disabled_toolsets`.
   */
  toolsetScope: ToolsetScopeSchema.nullable().optional(),
  /**
   * release203/17 §3.4 — admin-curated GLOBAL capability floor (the deny
   * baseline that no per-role/per-instance scope can hollow out). Projected from
   * cloud's im_capability_registry by applyProfileSnapshot. When present it wins
   * over the adapter-internal static HERMES_NATIVE_SKILL_DENYLIST; when
   * absent/empty (old daemon, cloud unreachable, field unset) the static
   * fallback applies — local-first fail-safe, backward-compatible.
   *
   * Shape `{categories, skills}`: categories are Hermes category dir-names
   * (expanded to skill names against the bundle); skills are explicit SKILL.md
   * names that survive even when no category covers them.
   */
  capabilityFloor: z
    .object({
      categories: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  /** Agent-level operating principles injected through /v1/runs instructions. */
  operatingPrinciples: z
    .union([
      z.string(),
      z.record(z.string(), z.string()),
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
   * new workspace spawn, Team Manager recited 5 prior-workspace agent IDs + 7 named
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
      nativeSkillScope: NativeSkillScopeSchema.nullable().optional(),
      toolsetScope: ToolsetScopeSchema.nullable().optional(),
      operatingPrinciples: z
        .union([
          z.string(),
          z.record(z.string(), z.string()),
          z.array(z.object({ source: z.string(), text: z.string() }).passthrough()),
        ])
        .optional(),
    })
    .passthrough()
    .nullable()
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
      configurePrismerProvider(profileName, config, agentUsername, profile.workspaceId, profile.agentImUserId);
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
    const apiServerModelNameEnv = buildHermesApiServerModelNameEnv(profileName, config.model);
    // Why: prevent port collisions when multiple agents auto-spawn their own
    // Hermes gateway in the same daemon. Each profileName hashes to a stable
    // offset from the default base port, so the same agent always uses the
    // same port across restarts. An explicit non-default config.port wins.
    const portOverride = config.port !== 8642 ? config.port : portForProfile(`${profileName}:${config.apiKey}`, 8642);
    const baseUrl = `http://127.0.0.1:${portOverride}`;
    // The signed bundle stages Cloud SDK as a sibling package. npm's `.bin`
    // symlink is dereferenced by zip on some hosts, yielding a copied CLI that
    // resolves dependencies from the wrong directory. Install a direct link to
    // @prismer/sdk/dist/cli.js before either reusing or spawning Hermes. The
    // ~/.local/bin alias also survives Hermes terminal/login-shell PATH resets.
    let hermesPath = process.env.PATH ?? '';
    try {
      const cloudCli = ensureCloudCliShim();
      hermesPath = `${cloudCli.managedBinDir}${hermesPath ? `:${hermesPath}` : ''}`;
      process.stdout.write(`[hermes-adapter] Cloud CLI ready at ${cloudCli.managedShimPath}\n`);
    } catch (err) {
      // Source-tree Runtime tests do not necessarily install @prismer/sdk.
      // A signed production bundle is gated separately by REQUIRED_ENTRIES;
      // keep non-bundle embedders usable but make capability loss explicit.
      process.stderr.write(`[hermes-adapter] Cloud CLI shim unavailable: ${(err as Error).message}\n`);
    }
    // Why this fallback chain: cloud may not yet populate `profile.agentUsername`
    // in the DTO (older deploys, or pre-restart). After the per-agent-profile
    // migration, `hermesProfileName` in config is guaranteed to be the agent's
    // username, so it's the most reliable identity source for the X-IM-Agent
    // header we inject into the MCP env.
    const agentUsername = profile.agentUsername || profileName;
    if (config.configurePrismerProvider) {
      configurePrismerProvider(profileName, config, agentUsername, profile.workspaceId, profile.agentImUserId);
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
      // product209/16 §8.3 — mint + inject the per-agent memory cap v2 into the
      // hermes gateway env (per-spawn, daemon per-boot key). Minted ONLY from
      // a valid registered Cloud authority snapshot; role/orchestrator/council
      // claims come from the snapshot actor row (server-derived), NOT from the
      // local profile config — a local claim could widen the Cloud snapshot.
      // No valid snapshot → no cap injected → agent Memory RPC fails closed.
      if (profile.agentImUserId && profile.workspaceId) {
        const cap = mintCapV2(profile.agentImUserId, profile.workspaceId);
        if (cap) agentEnv.PRISMER_MEMORY_CAP = cap;
      }

      spawn('hermes', ['-p', profileName, 'gateway', 'run'], {
        detached: false,
        stdio: 'ignore',
        cwd: hermesProfileDir,
        env: {
          ...process.env,
          PATH: hermesPath,
          API_SERVER_ENABLED: 'true',
          API_SERVER_KEY: config.apiKey,
          API_SERVER_PORT: String(portOverride),
          API_SERVER_HOST: '127.0.0.1',
          ...apiServerModelNameEnv,
          // TERMINAL_CWD is the env that hermes file_tools._resolve_path
          // honors over `os.getcwd()` for relative paths. Pin it to the
          // profile dir so even non-LLM-initiated writes (e.g. hermes
          // internal book-keeping) land in the sandbox.
          TERMINAL_CWD: hermesProfileDir,
          // product205/03 §3.4/§1.1 (M6) — runtime action-governance floor.
          // `runtimeApprovalMode` (default 'auto') decouples the spawn-level
          // dangerous-command gate from `forceAutonomous`/`approvalPolicy`
          // (which only rewrite prompt text). 'gated' ⇒ HERMES_YOLO_MODE OFF:
          // hermes' native dangerous-command bridge fires `approval.request`
          // for Ring 1 patterns (rm -r / DROP TABLE / chmod 777), the daemon
          // async-parks the turn (tear-down + awaiting_human_approval + §3.5
          // bundle → cloud `runtime_action` approval) — a real runtime pause,
          // not agent-honor prose. 'auto' ⇒ YOLO on (personal workspace, zero
          // regression; Ring 0 hard floor still applies via hermes blocklist).
          // The non-interactive pod has no human at a prompt; gated mode
          // routes the bridge event to cloud instead of blocking 5min.
          ...(config.runtimeApprovalMode === 'gated' ? {} : { HERMES_YOLO_MODE: 'true' }),
          [config.prismerApiKeyEnv]: resolvePrismerApiKey(config),
          ...agentEnv,
        },
      });
      // 2026-07-16 — 只在 spawn 分支落见证：这个进程带着的就是此刻的 model/provider。
      // 复用分支绝不写（那会把「跑的是旧配置」这个事实抹掉，漂移检测就瞎了）。
      //
      // 2026-08-16 — 见证必须在 waitForHealthy **之前**写：spawn 那一刻进程带什么
      // 配置是既成事实，与它多快变得健康无关。旧位置(健康检查成功后)意味着慢启动或
      // degraded 的网关永远落不下见证 → 下一次 dispatch 把它当「无见证孤儿」判漂移 →
      // 杀掉刚起来的网关重来 → kill-storm + 30s×3 重试耗尽(本地 kind pod 实测:
      // hermes 0.20.0 磁盘压力下报 degraded,旧 checkHealth 判死,4 次 spawn 全被杀)。
      writeHermesGatewayStamp(profileName, config, profile);
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
    // memory203/18 R4.2 — the same install pass now also lands the builtin
    // `memory` skill (+ `memory-dream` for orchestrator profiles).
    installBuiltInHermesSkills(profileName, config.taskAuthority);
    await Promise.all(
      REQUIRED_HERMES_SKILL_NAMES.map((slug) =>
        verifyHermesSkillLoaded(baseUrl, config.apiKey, slug, capabilities),
      ),
    );

    return new HermesService(
      profile.id,
      baseUrl,
      config,
      profileName,
      new HermesSkillLoader(resolveHermesSkillsRoot(profile, profileName), join(getHermesProfileDir(profileName), 'config.yaml'),
        [join(getHermesHomeRoot(), '.env'), join(getHermesProfileDir(profileName), '.env')]),
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

  /**
   * S5 §3.4-4b (specs/05 Task 6) — is a turn in flight on this gateway?
   *
   * The skill-sync path kills the gateway to make freshly-installed skills
   * visible (the catalog is scanned at spawn time and upstream has no reload
   * endpoint). Doing that mid-turn vacates EVERY session on the profile, so the
   * caller checks this first and defers instead.
   */
  get busy(): boolean {
    return this.currentRunId !== undefined;
  }

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

  /**
   * Persistence sessions expose installed skills as real slash commands.
   * The catalog is read from the daemon's per-agent skills directory, so it
   * does not depend on Hermes CLI/TUI command plumbing or a prior chat turn.
   */
  async listCommands(): Promise<AgentSlashCommand[]> {
    return this.skillLoader.listCommands();
  }

  async dispatch(task: TaskInput, opts?: DispatchCallOptions): Promise<TaskResult> {
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
    // Install the built-in Hermes skills before reading the dispatch skill
    // prompt. The per-turn rewrite is deliberately before
    // loadSystemPromptFragment so a deleted/tampered profile skill dir is
    // repaired in the same turn, not one turn later.
    installBuiltInHermesSkills(this.profileName, this.config.taskAuthority);
    // Prismer dispatches through Hermes' sessions HTTP API, which bypasses the
    // CLI/TUI slash dispatcher. Expand an exact installed-skill invocation
    // here so `/skill-name args` has the same deterministic semantics as the
    // native Hermes surfaces instead of reaching the LLM as unexplained text.
    const expandedSkillInvocation = await this.skillLoader
      .expandSlashInvocation(task.currentPrompt ?? task.prompt)
      .catch((err) => {
        process.stderr.write(
          `[hermes-adapter] skill slash expansion failed for ${this.profileName}: ${(err as Error).message}\n`,
        );
        return null;
      });
    if (expandedSkillInvocation) {
      task = { ...task, currentPrompt: expandedSkillInvocation };
    }
    // product204/09 §2.3 (Phase C seam b) — Hermes does NOT go through
    // applyPrismerScopeEnv (the gateway is a long-running per-profile process,
    // not a per-dispatch spawn), so cloud-resolved skill config lands in the
    // per-profile .env instead. python-dotenv loads it at gateway start and
    // tool subprocesses read it from there; a value changed mid-life applies
    // on the next gateway (re)spawn. Per-profile file ⇒ same-daemon multi-
    // agent isolation is structural (验收 C2): agent B's profile dir never
    // sees agent A's keys. Keys are PRISMER_-free by the cloud ingest gate.
    {
      // product204/37 WS-3 — role secret/user-kind params (roleParamsEnv) join the
      // per-profile .env alongside skillConfigEnv, same seam + isolation guarantee.
      const skillEnv = {
        ...skillConfigEnvFromMetadata(task.metadata as Record<string, unknown> | undefined),
        ...roleParamsEnvFromMetadata(task.metadata as Record<string, unknown> | undefined),
      };
      const entries = Object.entries(skillEnv);
      if (entries.length > 0) {
        try {
          const profileDir = getHermesProfileDir(this.profileName);
          for (const [key, value] of entries) {
            writeEnvValue(join(profileDir, '.env'), key, value);
          }
        } catch (err) {
          process.stderr.write(
            `[hermes-adapter] failed to write skill config env for ${this.profileName}: ${(err as Error).message}\n`,
          );
        }
      }
    }
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
    // release203/11 §2.2 (Slice A) — canonical IDENTITY + USER + scope.
    // dispatch.ts ships these as a SEPARATE `metadata.identityContext` (NOT
    // folded into systemPrompt) precisely so SOUL.md below stays persona-only:
    // Hermes docs forbid one-off / per-turn context in SOUL.md. So we place the
    // dynamic identity/user/scope lines here in the per-turn `instructions` slot
    // (slot #2), which Hermes appends AFTER SOUL.md. This gives the agent its
    // name + who it's talking to + where it is, every turn, without polluting
    // the persona slot. When absent (legacy dispatch) the block is empty.
    const idCtx = task.metadata?.identityContext as
      | { identity?: unknown; user?: unknown; scope?: unknown; sections?: unknown }
      | undefined;
    // product204/07 Phase C — named identityContext sections (分段注册制),
    // pre-rendered by dispatch.ts to ordered content strings. They join AFTER
    // the identity triple with '\n\n' in the SAME per-turn instructions slot
    // (never SOUL.md — D6 red line: dynamic per-dispatch context only).
    const identityExtraSections = Array.isArray(idCtx?.sections)
      ? idCtx.sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];
    const identityTriple = idCtx
      ? [idCtx.identity, idCtx.user, idCtx.scope]
          .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
          .join('\n')
      : '';
    const identitySection = [identityTriple, ...identityExtraSections].filter(Boolean).join('\n\n');
    // product204/37 WS-3 — behaviour role params (metadata.roleParams) render as a
    // per-turn instructions block (NEVER SOUL.md — dynamic per-dispatch context,
    // same red line as identity/config sections). Secrets never reach here (they
    // are env-only via roleParamsEnv above).
    const roleParamsBlock = renderRoleParamsBlock(
      roleParamsFromMetadata(task.metadata as Record<string, unknown> | undefined),
    );
    // ── memory211/01 W3 轴E — turn-start memory digest (TAIL slot) ──────────
    //
    // CACHE-INVARIANCE CONTRACT (spec 轴E: 组装与缓存不变性归 Hermes):
    //   • POSITION — the digest is the LAST element of `instructions`, i.e. the
    //     tail of the composed system message (sessions-dispatcher prepends the
    //     schema doc at the HEAD). Everything model-critical that rarely changes
    //     (SOUL.md → identity → caps → persona → skills) stays ABOVE it, so a
    //     digest change never invalidates the prefix cache for those blocks.
    //   • STABILITY — `renderMemoryDigestBlock` emits byte-identical text for a
    //     given digest version (content-hash keyed, path-sorted, no timestamps),
    //     so across turns with an unchanged memory map the tail is byte-equal and
    //     the provider prompt-cache hit rate stays >0. It changes ONLY when the
    //     workspace memory map changes, which is exactly when a re-read is cheap
    //     relative to the value.
    //   • NO-OP PATHS — flag off / no digest provider / empty map ⇒ '' ⇒ the
    //     instructions array is byte-identical to the pre-W3 composition.
    // dispatch.ts stamps the workspace on every dispatch payload's metadata
    // (the same keys the run-session registry reads); there is no TaskInput
    // column for it.
    const workspaceIdForDigest =
      typeof task.metadata?.workspaceId === 'string'
        ? task.metadata.workspaceId
        : typeof task.metadata?.prismerWorkspaceId === 'string'
          ? task.metadata.prismerWorkspaceId
          : '';
    const memoryDigestBlock = workspaceIdForDigest ? renderMemoryDigestBlock(workspaceIdForDigest) : '';
    const instructions = [
      identitySection,
      capsSection,
      artifactsDirective,
      roleParamsBlock,
      sysPrompt,
      skillPrompt,
      memoryDigestBlock,
    ]
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
        supportsVision: resolveSupportsVision(this.config.model, this.config.supportsVision, this.config.proxyProvider),
        profileName: this.profileName,
      });
      const dispatchKind = deriveDispatchKind(task, executionContextForKind.type);
      if (dispatchKind === 'run') {
        // S7 (spec 07 Task 1/裁决 B) — the run idempotency nonce comes from the
        // DAEMON's dispatch call (minted once per call, outside its P2 retry
        // loop, see DispatchCallOptions / daemon/dispatch.ts). It must NOT be
        // re-minted here: `dispatch()` is called once PER ATTEMPT, so a local
        // mint would hand every retry a different `Idempotency-Key` and the
        // upstream would treat the retry as a brand-new run (executed and
        // billed twice). The fallback keeps a direct/one-shot caller working —
        // for a caller with no retry loop above it, "one call = one execution"
        // is the correct semantics anyway.
        const dispatchNonce = opts?.idempotencyNonce ?? randomUUID();
        // NOT the run key: this one is the cloud llm-proxy cache key (see
        // llmIdempotencyKey) and is deliberately per-ATTEMPT (attemptNo is in
        // the hash) — the sessions path still sends it. Named apart so the two
        // idempotency axes can't be confused again.
        const llmProxyIdempotencyKey = llmIdempotencyKey({
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
          supportsVision: resolveSupportsVision(this.config.model, this.config.supportsVision, this.config.proxyProvider),
          profileName: this.profileName,
          instructions,
          idempotencyKey: llmProxyIdempotencyKey,
          idempotencyNonce: dispatchNonce,
          // S7 — freeze <now> to the run row's stamp so a retry seconds later
          // is byte-identical (the upstream fingerprint is over the whole
          // body). Cloud stamps `dispatchedAt` when it creates the run row
          // (kanban + schedule paths); absent ⇒ live clock, unchanged.
          nowIso:
            typeof (task.metadata ?? {}).dispatchedAt === 'string'
              ? (task.metadata as Record<string, unknown>).dispatchedAt as string
              : undefined,
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
              const messageId =
                typeof meta.triggerMessageId === 'string'
                  ? meta.triggerMessageId
                  : typeof meta.messageId === 'string'
                    ? meta.messageId
                    : null;
              const runtimeCanonicalTurnId =
                typeof meta.runtimeCanonicalTurnId === 'string' && meta.runtimeCanonicalTurnId.length > 0
                  ? meta.runtimeCanonicalTurnId
                  : null;
              const canonicalTurnId = runtimeCanonicalTurnId ?? task.taskId ?? null;
              if (workspaceIdMeta && (agentImUserId || canonicalTurnId)) {
                registry.register({
                  runId: runOutcome.runId,
                  conversationId: convId,
                  // Historical column name; value is the Cloud canonical turn
                  // id used by memory durability commit keys.
                  taskId: canonicalTurnId,
                  messageId,
                  agentImUserId: agentImUserId || 'unknown',
                  workspaceId: workspaceIdMeta,
                  profileId: this.id,
                  profileName: this.profileName,
                  roleTemplateSlug: roleSlug,
                  adapterName: 'hermes',
                  model: this.config.model,
                  proxyProvider: this.config.prismerProviderName,
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
        providerName: this.config.prismerProviderName,
        // release202/04 §3.3 P3 — surface effective vision capability so
        // sessions-dispatcher can stamp <execution_context><model
        // supports_vision=…>; same rule as the config builder.
        supportsVision: resolveSupportsVision(this.config.model, this.config.supportsVision, this.config.proxyProvider),
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

  /**
   * S7 (spec 07 Task 1, Step 6) — steer a live run (`POST /v1/runs/{id}/steer`,
   * body `{input|message|text}`; upstream answers 409
   * `run_not_accepting_steer` once the run is no longer running).
   *
   * INTERFACE ONLY in this spec: no UI caller, no dispatch-path caller, no
   * retry. Steering needs the org-paradigm M-wave to define WHO may steer a
   * run and how the input is authorised — shipping the transport early would
   * just be an unauthenticated write channel into a running agent.
   */
  async steerRun(runId: string, text: string): Promise<{ accepted: boolean; status: number }> {
    const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(5_000),
    });
    return { accepted: res.ok, status: res.status };
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

/**
 * release203 — global denylist for Hermes' ~90 bundled native skills.
 *
 * Hermes seeds its bundled `skills/` into `~/.hermes/skills/` on install and
 * surfaces ALL of them via `skills_list` (progressive-disclosure tier-1). Our
 * own built-in skills are scope-filtered (common/persistence/coding, doc 09
 * §7.6) but the Hermes-native bundle was ungoverned — so every agent (incl. a
 * Team Manager orchestrator) advertised Philips-Hue light control, Minecraft servers,
 * jailbreak red-teaming, and local ML serving (vLLM/llama.cpp) as its own
 * capabilities. That is skill-match noise + a misleading self-description.
 *
 * This is the conservative "明显无关" cut (global, all-roles): categories with
 * zero relevance to ANY prismer agent role. Matched against the SKILL.md
 * `name:` field (Hermes' `get_disabled_skill_names` → config.yaml
 * `skills.disabled`, agent/skill_utils.py:432-444). Grey-area categories
 * (research/social-media/media) are deliberately KEPT — trimming those is a
 * per-role allowlist decision, not a global one.
 */
const HERMES_NATIVE_SKILL_DENYLIST: readonly string[] = [
  // smart-home — physical IoT control, irrelevant to software agents
  'openhue',
  // gaming — hobbyist game automation
  'minecraft-modpack-server',
  'pokemon-player',
  // red-teaming — jailbreak tooling; off-policy for our agents
  'godmode',
  // mlops — local model serving/training/eval; executor-infra, not orchestration
  'serving-llms-vllm',
  'llama-cpp',
  'obliteratus',
  'huggingface-hub',
  'evaluating-llms-harness',
  'weights-and-biases',
  'dspy',
  'audiocraft-audio-generation',
  'segment-anything-model',
  // Host-specific maintenance is not a Prismer end-user capability.
  'hermes-agent',
  'hermes-agent-skill-authoring',
  'inspecting-hermes-desktop-dom',
  'sdlc-review',
  'conversation-compaction',
  // prediction-market betting
  'polymarket',
];

// release203/13 — per-role native skill scope resolution + bundled enumeration.

/**
 * Resolve the effective per-role scope: profile top-level wins, else the
 * roleTemplate snapshot (Priority-1/2, identical to resolveMcpAllowlist).
 */
export function resolveNativeSkillScope(
  config: Pick<HermesProfileConfig, 'nativeSkillScope' | 'roleTemplate'>,
): NativeSkillScope | null {
  if (config.nativeSkillScope) return config.nativeSkillScope;
  const fromRole = config.roleTemplate?.nativeSkillScope;
  return fromRole ?? null;
}

interface BundledSkill {
  name: string;
  category: string;
}

// Cache keyed by skillsDir → (dir mtime, scanned skills). Hermes itself caches
// the same way (skill_utils _EXTERNAL_DIRS_CACHE) because re-walking ~90 skills
// per dispatch dominates startup cost.
const bundledSkillsCache = new Map<string, { mtimeMs: number; skills: BundledSkill[] }>();

function readSkillName(skillMdPath: string): string | null {
  try {
    const text = readFileSync(skillMdPath, 'utf8');
    const m = /^name:\s*(.+)$/m.exec(text);
    return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate Hermes' bundled native skills from the home-root `skills/` dir
 * (pure bundle — our injected skills live only under <profileDir>/skills/).
 * `category` = the first-level dir under skills/. Returns [] when the dir is
 * absent/unseeded (fresh boot) → allow-mode fail-safes to the deny floor.
 */
function enumerateBundledSkills(skillsRoot: string): BundledSkill[] {
  let stat;
  try {
    stat = statSync(skillsRoot);
  } catch {
    return [];
  }
  const cached = bundledSkillsCache.get(skillsRoot);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.skills;

  const out: BundledSkill[] = [];
  const walk = (dir: string, category: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, category);
      } else if (entry.name === 'SKILL.md') {
        const name = readSkillName(full);
        if (name) out.push({ name, category });
      }
    }
  };
  let topLevel;
  try {
    topLevel = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of topLevel) {
    if (entry.isDirectory()) walk(join(skillsRoot, entry.name), entry.name);
  }
  bundledSkillsCache.set(skillsRoot, { mtimeMs: stat.mtimeMs, skills: out });
  return out;
}

/**
 * release203/17 §3.4 — the global capability floor (admin-curated, cloud-
 * projected via config.capabilityFloor; static fallback offline). `categories`
 * are Hermes category dir-names (expanded to skill names against the bundle);
 * `skills` are explicit SKILL.md names that survive even when no category
 * covers them (e.g. polymarket / dogfood).
 */
export interface CapabilityFloor {
  categories?: string[];
  skills?: string[];
}

/**
 * Expand a {categories, skills} floor to a concrete set of skill names:
 * every bundled skill whose category is floored ∪ the explicit skill names.
 */
function expandFloor(floor: CapabilityFloor, allBundled: BundledSkill[]): string[] {
  return Array.from(
    new Set<string>([
      ...allBundled.filter((s) => floor.categories?.includes(s.category)).map((s) => s.name),
      ...(floor.skills ?? []),
    ]),
  );
}

/**
 * Compute the final `skills.disabled` list. deny ⇒ floor ∪ in-scope; allow ⇒
 * (every bundled name NOT in scope) ∪ floor — the floor is ALWAYS ∪'d into
 * disabled so a per-instance allow can never hollow it out (doc 17 §3.4 / 18
 * invariant). allow with an unenumerable bundle (empty) fail-safes to the floor.
 */
export function computeDisabledSkills(
  scope: NativeSkillScope | null,
  allBundled: BundledSkill[],
  globalFloor: CapabilityFloor,
): string[] {
  const floorSkills = expandFloor(globalFloor, allBundled);
  if (!scope) return floorSkills;
  const inScope = new Set<string>([
    ...allBundled.filter((s) => scope.categories?.includes(s.category)).map((s) => s.name),
    ...(scope.skills ?? []),
  ]);
  if (scope.mode === 'allow') {
    if (allBundled.length === 0) return floorSkills; // fail-safe
    const kept = allBundled.map((s) => s.name).filter((n) => !inScope.has(n));
    // floor ∪ kept: a role's allow-body cannot un-disable a floored skill.
    return Array.from(new Set<string>([...kept, ...floorSkills]));
  }
  return Array.from(new Set<string>([...floorSkills, ...inScope]));
}

/**
 * release203/16 §3 — known Hermes toolset names, mirrored from hermes-agent
 * toolsets.py `TOOLSETS` keys (v0.15). Used only to compute the `allow`-mode
 * complement (ALL − allowed). deny-mode never needs it. NOTE: this is a static
 * snapshot (toolsets ship in Hermes code, not on disk as SKILL.md — unlike the
 * skill bundle which we scan). If Hermes adds a toolset, allow-mode fail-OPENS
 * for it (won't disable the unknown one) until this list is refreshed; deny-mode
 * stays exact. Prefer deny-mode for governance-critical roles.
 */
const HERMES_ALL_TOOLSETS: readonly string[] = [
  'web', 'search', 'x_search', 'vision', 'video', 'image_gen', 'video_gen',
  'computer_use', 'terminal', 'moa', 'skills', 'browser', 'cronjob', 'messaging',
  'file', 'tts', 'todo', 'memory', 'context_engine', 'session_search', 'clarify',
  'code_execution', 'delegation', 'homeassistant', 'kanban', 'discord',
  'discord_admin', 'yuanbao', 'feishu_doc', 'feishu_drive', 'spotify',
  'debugging', 'safe',
];

/**
 * release203 web-capability fix — the explicit `platform_toolsets.api_server`
 * list configurePrismerProvider pins into every profile config.yaml.
 *
 * This is the `hermes-api-server` composite (hermes-agent toolsets.py)
 * reverse-mapped to CONFIGURABLE_TOOLSETS keys, minus the platform's normal
 * default-off set (`homeassistant` — the only composite member in
 * _DEFAULT_OFF_TOOLSETS): exactly what a CORRECT subset-inference would
 * enable. Writing it explicitly flips hermes to direct-membership resolution
 * (`has_explicit_config`), bypassing the v0.17.0 inference bug that silently
 * dropped `terminal`. `web` stays listed for parity with the composite; its
 * tools remain check_fn-gated (no upstream search backend in pods — our
 * web_search/web_load provider tools are the search surface instead).
 * Exported for unit tests.
 */
export const HERMES_API_SERVER_PLATFORM_TOOLSETS: readonly string[] = [
  'web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'image_gen',
  'skills', 'todo', 'memory', 'session_search', 'delegation', 'cronjob',
];

/**
 * Resolve the effective per-role toolset scope: profile top-level wins, else the
 * roleTemplate snapshot (Priority-1/2, identical to resolveNativeSkillScope).
 */
export function resolveToolsetScope(
  config: Pick<HermesProfileConfig, 'toolsetScope' | 'roleTemplate'>,
): ToolsetScope | null {
  if (config.toolsetScope) return config.toolsetScope;
  const fromRole = config.roleTemplate?.toolsetScope;
  return fromRole ?? null;
}

/**
 * Compute the final `agent.disabled_toolsets` list. deny ⇒ the listed toolsets;
 * allow ⇒ every KNOWN toolset NOT in the allow list. Unknown allow entries are
 * ignored (they're not in HERMES_ALL_TOOLSETS so they can't be subtracted, and
 * an unknown toolset isn't real anyway). Returns [] when scope is null.
 */
export function computeDisabledToolsets(
  scope: ToolsetScope | null,
  allToolsets: readonly string[] = HERMES_ALL_TOOLSETS,
): string[] {
  if (!scope) return [];
  const listed = new Set(scope.toolsets ?? []);
  if (scope.mode === 'allow') {
    return allToolsets.filter((t) => !listed.has(t));
  }
  return [...listed];
}

// Exported for unit test (memory203 doc 10 §3): the config-gen is the single
// place that pins `memory.provider: prismer`, writes PRISMER_DAEMON_PORT, and
// decides whether the fragmented hook + recall-tools paths run.
export function configurePrismerProvider(
  profileName: string,
  config: HermesProfileConfig,
  agentUsername?: string,
  workspaceId?: string,
  agentImUserId?: string,
): void {
  // Desktop-202 Phase 7 (docs/desktop202/12 §2): a matched local provider profile
  // (BYOK / Ollama) governs BOTH the base_url (resolved below) AND the wire
  // protocol (`api_mode`). hermes natively speaks Anthropic Messages, so an
  // anthropic profile direct-connects via `anthropic_messages`; the rest stay
  // `chat_completions` (Ollama via its OpenAI-compatible `/v1` shim). No local
  // profile → null → cloud-chain `chat_completions`, byte-for-byte unchanged.
  const localProvider = resolveLocalProvider(config.proxyProvider);
  const apiMode: 'chat_completions' | 'anthropic_messages' = localProvider
    ? hermesApiModeForType(localProvider.type)
    : 'chat_completions';
  const baseUrl = localProvider
    ? hermesWireBaseUrl(localProvider)
    : resolvePrismerProviderBaseUrl(config);
  const apiKey = resolvePrismerApiKey(config);
  // Ollama is keyless — an empty apiKey is correct there, so don't bail on it.
  const keyOptional = localProvider?.type === 'ollama';
  if (!baseUrl || (!apiKey && !keyOptional)) {
    process.stderr.write(
      `[hermes-adapter] skipping Prismer provider bootstrap for profile ${profileName}: missing PRISMER_BASE_URL or PRISMER_API_KEY\n`,
    );
    return;
  }

  // product207/29 fixup (2.2.8) — write the provider bootstrap to the ROOT
  // ~/.hermes config, not the per-profile dir: Hermes' provider resolution
  // (runtime_provider / AIAgent) loads ~/.hermes/config.yaml + ~/.hermes/.env,
  // and the profile-scoped config.yaml written before this fix was never read
  // by it — every sandbox agent failed with "No LLM provider configured"
  // (2026-08-06). The profile dir is still created for the gateway -p flag.
  const profileDir = getHermesProfileDir(profileName);
  mkdirSync(profileDir, { recursive: true });
  // getHermesHomeRoot() (not homedir()) — 2.2.9: tests and sandbox entrypoints
  // set HERMES_HOME; hardcoding ~/.hermes here made the 2.2.8 root write land
  // in the REAL home during tests and under any non-default HERMES_HOME.
  const hermesRoot = getHermesHomeRoot();
  mkdirSync(hermesRoot, { recursive: true });
  writeEnvValue(join(hermesRoot, '.env'), config.prismerApiKeyEnv, apiKey);
  writeEnvValue(join(profileDir, '.env'), config.prismerApiKeyEnv, apiKey);

  // product207/29 fixup 2.2.9 — the bootstrap is applied to BOTH the per-profile
  // config.yaml and the root ~/.hermes/config.yaml (each doc keeps its own
  // operator-set keys; hermes reads one or the other depending on the
  // HERMES_HOME scope the gateway runs under).
  const applyBootstrap = (doc: HermesConfigDocument, inheritedModels?: unknown): void => {
  const customProviders = Array.isArray(doc.custom_providers) ? doc.custom_providers : [];
  const normalizedName = normalizeProviderName(config.prismerProviderName);
  // 2026-09-07 probe-storm fix — preserve `custom_providers[].models` across
  // this whole-entry replacement. ConfigDelivery (daemon config-bootstrap)
  // writes `models.<id>.context_length` onto the prismer entry in the ROOT
  // config; this function previously replaced the entry with a fresh literal
  // and silently stripped that key (and applyBundle skips rewriting while the
  // configVersion is unchanged, so it never came back — Hermes' step-0
  // context-length override was lost and its per-turn endpoint probing
  // resumed). The profile doc — the one a `hermes -p <name>` gateway actually
  // reads — additionally INHERITS the root entry's models via
  // `inheritedModels` (root is applied first below), because a fresh profile
  // doc has no old entry to preserve from.
  const oldProvider = customProviders.find((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return normalizeProviderName(String((entry as { name?: unknown }).name ?? '')) === normalizedName;
  });
  const preservedModels = oldProvider && 'models' in oldProvider ? oldProvider.models : inheritedModels;
  const nextProvider = {
    name: config.prismerProviderName,
    base_url: baseUrl,
    key_env: config.prismerApiKeyEnv,
    api_mode: apiMode,
    model: config.model,
    ...(preservedModels != null ? { models: preservedModels } : {}),
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
  // 2.2.10 — bare provider name, NOT `custom:${name}`. Hermes' custom-provider
  // resolution (`_get_named_custom_provider`) matches the name against
  // `custom_providers[].name` verbatim — `custom:prismer` never matched the
  // `prismer` entry, so the gateway fell through with provider='custom' and
  // no key → AIAgent raised "No LLM provider configured" (observed live
  // 2026-08-07 on 2.2.9 sandboxes: the dual-write made the gateway read this
  // config for the first time, exposing the format mismatch).
  modelCfg.provider = config.prismerProviderName;
  modelCfg.default = config.model;
  modelCfg.base_url = baseUrl;
  modelCfg.api_mode = apiMode;

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
  const supportsVision = resolveSupportsVision(config.model, config.supportsVision, config.proxyProvider);
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

  // release203/13 — prune Hermes' bundled native skills via config.yaml
  // `skills.disabled`. The global floor (HERMES_NATIVE_SKILL_DENYLIST) is the
  // baseline for every role; per-role `nativeSkillScope` (deny = subtract more,
  // allow = keep-only net-body) refines on top. Bundled set enumerated from the
  // home-root skills/ dir (pure bundle). Merged + de-duped with operator-set
  // `disabled` so manual additions survive. Idempotent-preserve.
  {
    // release203/17 §3.4 — prefer the cloud-projected global floor
    // (config.capabilityFloor, shape {categories, skills}) over the adapter-
    // internal static denylist. Online floor is richer (admin can floor whole
    // categories); offline / old-daemon / unset falls back to the static
    // skill-name cut (HERMES_NATIVE_SKILL_DENYLIST as {skills}) — an acceptable
    // local-first degradation: the offline floor still bars the hand-picked
    // skills, it just can't floor a whole category it never received.
    const cloudFloor = config.capabilityFloor;
    const hasCloudFloor =
      !!cloudFloor && ((cloudFloor.categories?.length ?? 0) > 0 || (cloudFloor.skills?.length ?? 0) > 0);
    const effectiveFloor: CapabilityFloor = hasCloudFloor
      ? cloudFloor!
      : { skills: [...HERMES_NATIVE_SKILL_DENYLIST] };
    // Enumerate the bundle whenever a scope OR a category-floor exists (both
    // allow/deny scope AND floor.categories need it to expand category → skill
    // names). Cached by dir mtime, so the walk is amortized across dispatches.
    const scope = resolveNativeSkillScope(config);
    const needBundle = !!scope || (effectiveFloor.categories?.length ?? 0) > 0;
    const allBundled = needBundle ? enumerateBundledSkills(join(getHermesHomeRoot(), 'skills')) : [];
    // Standalone coding lifecycle guides cannot bypass Runtime-owned hosting.
    const bundleAnchor = resolveBuiltInSkillPath(MEMORY_SKILL_NAME);
    const bundledRoot = process.env.PRISMER_BUILT_IN_SKILLS_ROOT?.trim() || (bundleAnchor ? dirname(dirname(bundleAnchor)) : null);
    const optionalUpstream = bundledRoot ? explicitGrantNativeDisables(bundledRoot) : [];
    const computed = [...new Set([...computeDisabledSkills(scope, allBundled, effectiveFloor), 'claude-code', 'codex', 'opencode', ...optionalUpstream])];
    const skillsCfg =
      doc.skills && typeof doc.skills === 'object' && !Array.isArray(doc.skills)
        ? { ...(doc.skills as Record<string, unknown>) }
        : {};
    const existingDisabled = Array.isArray(skillsCfg.disabled)
      ? (skillsCfg.disabled as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const previous = Array.isArray(skillsCfg.prismer_managed_disabled)
      ? (skillsCfg.prismer_managed_disabled as unknown[]).filter((name): name is string => typeof name === 'string') : [];
    const context = skillAvailabilityContextFromEnvFiles([join(getHermesHomeRoot(), '.env'), join(profileDir, '.env')]);
    context.disabled = reconcileSkillDisables(existingDisabled, previous, computed).disabled;
    // Hermes loads profile .env into its gateway; do not mark an injected
    // credential missing merely because the parent daemon lacks it.
    const externalDirs = Array.isArray(skillsCfg.external_dirs)
      ? skillsCfg.external_dirs.filter((value): value is string => typeof value === 'string') : [];
    const normalizedExternalDirs = externalDirs.map((entry) => {
      const expanded = entry.replace(/\$\{([^}]+)\}|\$(\w+)/g, (match, braced, bare) => context.env[braced ?? bare] ?? match)
        .replace(/^~(?=\/|$)/, context.env.HOME ?? homedir());
      return resolve(profileDir, expanded);
    });
    const pinnedRoot = config.skillsDir?.trim();
    if (pinnedRoot) {
      projectHermesSkillRoot(pinnedRoot, join(profileDir, 'skills'));
      // The projection is the native registration. Registering the same source
      // again as external_dirs would create duplicate upstream candidates.
      skillsCfg.external_dirs = externalDirs.filter((_entry, index) => normalizedExternalDirs[index] !== resolve(pinnedRoot));
    }
    const roots = [...new Set([join(getHermesHomeRoot(), 'skills'), join(profileDir, 'skills'),
      ...(config.skillsDir?.trim() ? [config.skillsDir.trim()] : []), ...normalizedExternalDirs])];
    const inventories = roots.map((root) => inspectSkillTree(root, context));
    assertUnambiguousSkillImports(inventories);
    const inventory = inventories.flat();
    const unavailable = inventory.filter((entry) => entry.status !== 'available').map((entry) => entry.name);
    const replacements = inventory.filter((entry) => entry.status === 'available').flatMap((entry) => entry.nativeReplaces);
    const reconciled = reconcileSkillDisables(existingDisabled, previous, [...computed, ...unavailable, ...replacements]);
    skillsCfg.disabled = reconciled.disabled;
    skillsCfg.prismer_managed_disabled = reconciled.managed;
    doc.skills = skillsCfg;
  }

  // release203/16 §3 — per-role Hermes toolset scope → config.yaml
  // `agent.disabled_toolsets` (hermes-agent agent/agent_init.py:457 +
  // hermes_cli/tools_config.py:1353-1360). deny = disable listed; allow =
  // disable every known toolset NOT allowed. Merged + de-duped with any
  // operator-set list so manual additions survive. No-op when no scope set
  // (backward compatible: old roles / old daemons leave Hermes default).
  {
    const toolsetScope = resolveToolsetScope(config);
    const disabledToolsets = computeDisabledToolsets(toolsetScope);
    if (disabledToolsets.length > 0) {
      const agentCfg =
        doc.agent && typeof doc.agent === 'object' && !Array.isArray(doc.agent)
          ? { ...(doc.agent as Record<string, unknown>) }
          : {};
      const existingTs = Array.isArray(agentCfg.disabled_toolsets)
        ? (agentCfg.disabled_toolsets as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];
      agentCfg.disabled_toolsets = Array.from(new Set([...existingTs, ...disabledToolsets]));
      doc.agent = agentCfg;
    }
  }

  // release203 web-capability fix (upstream-bug bypass) — explicitly pin
  // `platform_toolsets.api_server` so Hermes' subset-inference can never drop
  // a toolset again. Background: with NO explicit list, hermes_cli/
  // tools_config.py `_get_platform_tools()` reverse-maps the `hermes-api-server`
  // composite onto CONFIGURABLE_TOOLSETS via a tools-subset check; a v0.17.0
  // bug in that inference silently dropped `terminal` (agents then fell back
  // to execute_code + python subprocess for every CLI call). When the saved
  // list contains configurable keys, hermes switches to DIRECT membership
  // (`has_explicit_config` branch) — deterministic, bug-proof. Key name
  // verified against the hermes-agent reference clone
  // (hermes_cli/tools_config.py: `config.get("platform_toolsets")`, dict
  // platform → list of toolset keys).
  //
  // The list enumerates the platform's normal default set (the
  // `hermes-api-server` composite reverse-mapped to configurable toolset keys,
  // minus _DEFAULT_OFF_TOOLSETS — i.e. `homeassistant` stays out) so nothing
  // is lost relative to a correct inference. Per-role deny still works:
  // `agent.disabled_toolsets` (written above) is applied LAST by hermes and
  // overrides this list. Union-merged with any operator entries; idempotent.
  {
    const platformToolsets =
      doc.platform_toolsets && typeof doc.platform_toolsets === 'object' && !Array.isArray(doc.platform_toolsets)
        ? { ...(doc.platform_toolsets as Record<string, unknown>) }
        : {};
    const existingApiServer = Array.isArray(platformToolsets.api_server)
      ? (platformToolsets.api_server as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    platformToolsets.api_server = Array.from(
      new Set([...existingApiServer, ...HERMES_API_SERVER_PLATFORM_TOOLSETS]),
    );
    doc.platform_toolsets = platformToolsets;
  }

  // release201/09 §9.4b (2026-05-30 hotfix, Option B2) — ALWAYS write the
  // memory: block with explicit values. Prior code only wrote it when
  // `enableBuiltinMemory: true`, relying on a now-disproved assumption that
  // hermes' code default was off. In reality hermes deep-merges user config
  // OVER `DEFAULT_CONFIG` (hermes_cli/config.py:4701) which sets
  // `memory.memory_enabled = True` (config.py:1373); `agent_init.py:1076`
  // then reads the merged value. Not writing a `memory:` block leaves builtin
  // MEMORY.md/USER.md injection ON, which caused the 2026-05-30 cross-
  // workspace contamination (Team Manager recited prior-workspace state from
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

  // memory203 doc 10 §3 — the native MemoryProvider正门 (路 A, single interface:
  // prefetch + sync_turn + get_tool_schemas + on_memory_write). Computed HERE
  // (hoisted above the hook + recall-tools blocks) because when the provider is
  // active it SUPERSEDES both fragmented paths: the provider's in-process
  // sync_turn/prefetch replace the curl `installMemoryHooks`, and its
  // get_tool_schemas replaces the standalone recall-tools plugin (doc 10 §3;
  // index.ts:2221 — hooks are the provider-UNAVAILABLE fallback). The orchestrator
  // owns the entrypoint flip (export PRISMER_MEMORY_PROVIDER=1 in lieu of
  // PRISMER_RECALL_TOOLS_PLUGIN=1).
  //
  // 2026-07-19 sandbox regression — the fallback lanes below key off the ACTUAL
  // install result, not the intent. When the provider shell is missing (an OTA
  // bundle packed without plugins/), treating intent as "provider active"
  // suppressed the shell hooks AND the recall-tools plugin too — every memory
  // lane went dark instead of degrading. The install is idempotent (cpSync into
  // the profile plugins dir), so attempting it at hoist time is safe.
  const memoryProviderIntent =
    config.installMemoryProvider === true || process.env.PRISMER_MEMORY_PROVIDER === '1';
  const memoryProviderInstalled = memoryProviderIntent && installMemoryProviderShell(profileDir);
  if (memoryProviderIntent && !memoryProviderInstalled) {
    // product204/36 follow-up — a silently-degraded memory layer must be
    // cloud-visible (the 2026-07-19 regression sat unnoticed in stderr).
    // Fire-and-forget; profile prepare continues on the shell-hook fallback.
    reportCapabilityIncident(
      `hermes memory-provider install failed for profile ${profileName} — memory degraded to shell-hook lane`,
    );
  }

  // memory203 doc 10 §3 (port fix) — the daemon publishes its ACTUAL loopback
  // port to PRISMER_DAEMON_PORT at boot (local-server.ts), which in agent-rt
  // pods is 7878. The provider's _http_get + the `prismer memory` CLI both read
  // PRISMER_DAEMON_PORT; the 3210 fallback is the stale dev default that caused
  // every memory RPC to miss. Honour the env first; only fall back to 7878.
  const resolveDaemonPort = (): string =>
    (process.env.PRISMER_DAEMON_PORT ?? '7878').trim() || '7878';
  const writeProfileRuntimeEnv = (): void => {
    const envPath = join(profileDir, '.env');
    if (workspaceId) {
      writeEnvValue(envPath, 'PRISMER_WORKSPACE_ID', workspaceId);
    }
    if (agentUsername) {
      writeEnvValue(envPath, 'PRISMER_AGENT_USERNAME', agentUsername);
    }
    if (agentImUserId) {
      writeEnvValue(envPath, 'PRISMER_AGENT_IM_USER_ID', agentImUserId);
    }
    writeEnvValue(envPath, 'PRISMER_DAEMON_PORT', resolveDaemonPort());
  };

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
  //
  // memory203 doc 10 §3 — when the native MemoryProvider is active these curl
  // hooks are RETIRED. The reason is now CORRECT (memory203/14, 2026-07-01): the
  // provider's IN-PROCESS sync_turn is the automatic-extraction trigger (it POSTs
  // the turn to the daemon's post_llm_call intake, which runs the in-pod
  // background-review). A config.yaml shell hook is the WRONG trigger here anyway —
  // a long-running gateway registers hooks once at startup and never picks up a
  // hook the daemon writes per-dispatch, so it silently never fires. sync_turn
  // (invoked in-process per turn by conversation_loop) does fire reliably. The
  // shell hooks therefore stay ONLY as the no-provider fallback. The eval opt-out
  // (installMemoryHooks === false) is preserved.
  if (config.installMemoryHooks !== false && !memoryProviderInstalled) {
  const daemonPort = resolveDaemonPort();
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

  // Desktop-202 doc 18 §4 — MemoryProvider正门 (B path). CAPABILITY BIT,
  // default OFF. When on (desktop daemon), copy the provider shell into the
  // profile's plugins/ dir and pin `memory.provider: prismer` so Hermes
  // activates it (single external provider → Honcho excluded). When OFF the
  // memory: block written above keeps the legacy shell-hook behaviour and
  // config.yaml never mentions a provider — CLI/K8s unchanged.
  // (memoryProviderInstalled is hoisted above the hook block — the install
  //  already ran there so the hooks + recall-tools paths defer to the provider
  //  only when it ACTUALLY landed on disk, never on intent alone.)
  if (memoryProviderInstalled) {
    const memProviderCfg =
      doc.memory && typeof doc.memory === 'object' && !Array.isArray(doc.memory)
        ? { ...(doc.memory as Record<string, unknown>) }
        : {};
    memProviderCfg.provider = 'prismer';
    doc.memory = memProviderCfg;
    // Pin the bound workspace/agent/daemon identity into the profile .env so
    // Python plugin shells can scope recall and terminal-routing evidence after
    // python-dotenv loads this profile.
    writeProfileRuntimeEnv();
  }

  // Desktop-202 doc 19 §8 — recall-tools + bounded routing-evidence plugin.
  // The explicit tool-only capability remains default OFF. The plugin is also
  // required whenever the native provider is active because Hermes' trusted
  // post_api_request hook is the only source of actual served model/provider.
  // Copy it into the PER-PROFILE `<profileDir>/plugins/` dir
  // into the PER-PROFILE `<profileDir>/plugins/` dir (the dir the daemon-spawned
  // `hermes -p <name> gateway run` gateway actually scans, after its `-p`
  // HERMES_HOME override) and add it to the per-profile config.yaml
  // `plugins.enabled` so Hermes loads it (plugins.py:1169-1187). This is the
  // It never sets `memory.provider`; Hermes dedupes the overlapping recall tool
  // schemas by name when the provider is active.
  const enableRecallToolsPlugin =
    memoryProviderInstalled ||
    config.installRecallToolsPlugin === true ||
    process.env.PRISMER_RECALL_TOOLS_PLUGIN === '1';
  if (enableRecallToolsPlugin) {
    const installed = installRecallToolsPluginShell(profileDir);
    if (installed) {
      const pluginsCfg =
        doc.plugins && typeof doc.plugins === 'object' && !Array.isArray(doc.plugins)
          ? { ...(doc.plugins as Record<string, unknown>) }
          : {};
      const existingEnabled = Array.isArray(pluginsCfg.enabled)
        ? (pluginsCfg.enabled as unknown[]).filter((e): e is string => typeof e === 'string')
        : [];
      pluginsCfg.enabled = Array.from(new Set([...existingEnabled, RECALL_TOOLS_PLUGIN_KEY]));
      doc.plugins = pluginsCfg;
      // The plugin handlers read workspace + agent + daemon port from the
      // profile .env when reporting bounded terminal routing evidence.
      writeProfileRuntimeEnv();
    }
  }

  // release203/15c WS-E3 — let the agent's identity + daemon-port env survive
  // Hermes' `_scrub_child_env` so they reach the `cloud` tool subprocess.
  //
  // Hermes scrubs the execute_code / terminal child env to an ALLOWLIST: only
  // names matching `_SAFE_ENV_PREFIXES` (PATH/HOME/HERMES_/…) or a registered
  // passthrough survive (tools/code_execution_tool.py `_scrub_child_env`,
  // tools/env_passthrough.py). `PRISMER_*` matches no safe prefix, so without
  // this the spawn-env identity vars (PRISMER_AGENT_USERNAME /
  // PRISMER_AGENT_IM_USER_ID / PRISMER_DAEMON_PORT) are silently stripped and
  // `cloud deliver` sees neither a dispatch id NOR an agent identity to
  // auto-resolve from — defeating the whole WS-E3 mechanism. (This corrects the
  // doc's premise that the identity vars are "present in the tool subprocess
  // env": they are present in the GATEWAY env but scrubbed from CHILD env.)
  //
  // These three are agent-IDENTITY / transport vars, NOT per-dispatch and NOT
  // credentials (no KEY/TOKEN/SECRET substring → not blocked by the GHSA
  // provider-credential blocklist). Passing them is exactly the WS-E3 intent.
  {
    const terminalCfg =
      doc.terminal && typeof doc.terminal === 'object' && !Array.isArray(doc.terminal)
        ? { ...(doc.terminal as Record<string, unknown>) }
        : {};
    const existing = Array.isArray(terminalCfg.env_passthrough)
      ? (terminalCfg.env_passthrough as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    terminalCfg.env_passthrough = Array.from(
      new Set([
        ...existing,
        'PRISMER_AGENT_USERNAME',
        'PRISMER_AGENT_IM_USER_ID',
        'PRISMER_DAEMON_PORT',
        'PRISMER_WORKSPACE_ID',
      ]),
    );
    doc.terminal = terminalCfg;
  }

  };

  // Root applied FIRST (2026-09-07): the profile pass below inherits the root
  // entry's `models` (context_length map) — ConfigDelivery writes it to the
  // root file, but the profile-scope gateway only reads the profile config.
  const rootConfigPath = join(hermesRoot, 'config.yaml');
  const rootDoc = readHermesConfig(rootConfigPath);
  applyBootstrap(rootDoc);
  writeFileSync(rootConfigPath, YAML.stringify(rootDoc), 'utf8');
  const rootProviderModels = (() => {
    const customProviders = Array.isArray(rootDoc.custom_providers) ? rootDoc.custom_providers : [];
    const normalizedName = normalizeProviderName(config.prismerProviderName);
    const entry = customProviders.find((e): e is Record<string, unknown> => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
      return normalizeProviderName(String((e as { name?: unknown }).name ?? '')) === normalizedName;
    });
    return entry && 'models' in entry ? entry.models : undefined;
  })();

  const profileConfigPath = join(profileDir, 'config.yaml');
  const profileDoc = readHermesConfig(profileConfigPath);
  applyBootstrap(profileDoc, rootProviderModels);
  writeFileSync(profileConfigPath, YAML.stringify(profileDoc), 'utf8');

  // 2.2.8 wrote the bootstrap to the root only; the daemon-spawned
  // `hermes -p <name> gateway run` overrides HERMES_HOME to the profile dir
  // (hermes main.py `_apply_profile_override`), so the gateway reads
  // `<root>/profiles/<name>/config.yaml` and the root-only write left the
  // profile-level model/agent/platform-toolsets pins absent (2026-08-07, vision
  // / platform-toolsets tests + sandbox agents). Mirror to the root so the
  // bootstrap is correct under BOTH HERMES_HOME scopes. (2026-09-07: write
  // order flipped root-first so the profile doc can inherit the root entry's
  // `models` context-length map — see applyBootstrap comment.)
}

function resolvePrismerMcpServerPath(config: HermesProfileConfig): string | null {
  if (config.prismerMcpServerPath) return config.prismerMcpServerPath;
  if (process.env.PRISMER_MCP_SERVER) return process.env.PRISMER_MCP_SERVER;
  // Resolve the published package first, then use the sibling Cloud product in repo dev.
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('@prismer/mcp-server');
  } catch {
    /* fall through */
  }
  // Last-resort dev heuristic — repo-relative.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // …/prismer/src/adapters/persistence/hermes → walk to sdk/cloud/mcp/dist
    const candidate = join(here, '../../mcp/dist/index.js');
    if (existsSync(candidate)) return candidate;
    const candidate2 = join(here, '../../../mcp/dist/index.js');
    if (existsSync(candidate2)) return candidate2;
    const candidate3 = join(here, '../../../../mcp/dist/index.js');
    if (existsSync(candidate3)) return candidate3;
    const candidate4 = join(here, '../../../../../cloud/mcp/dist/index.js');
    if (existsSync(candidate4)) return candidate4;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Desktop-202 doc 18 §4c — copy the Prismer MemoryProvider shell
 * (`plugins/memory/prismer/`) into the Hermes profile's plugins dir so Hermes
 * discovers it when `memory.provider: prismer` is set. Idempotent (overwrites
 * the prismer subdir only). Best-effort: returns false + stderr-logs on any
 * failure so the caller falls back to the shell-hook path (降级不中断). Does
 * NOT touch operator-installed providers — only the `prismer` subdir.
 */
export function installMemoryProviderShell(profileDir: string): boolean {
  const src = resolveMemoryProviderShellSource();
  if (!src) {
    process.stderr.write(
      '[hermes-adapter] memory provider shell source not resolvable — skipping provider install (falling back to shell-hook memory)\n',
    );
    return false;
  }
  try {
    // Hermes's MEMORY-provider discovery (plugins/memory/__init__.py
    // `_iter_provider_dirs`) scans the user dir `$HERMES_HOME/plugins/` ONE
    // level deep and treats each direct child `<name>/` as a provider
    // (`_is_memory_provider_dir` looks for `<name>/__init__.py`). The extra
    // `memory/` path segment only exists for BUNDLED providers
    // (`<hermes>/plugins/memory/<name>/`). Installing under
    // `<profile>/plugins/memory/prismer/` makes the scan see a `memory/` child
    // with no `__init__.py` and skip it — so the provider is NEVER discovered
    // (verified live: `find_provider_dir("prismer") → None`). Install the shell
    // directly at `<profile>/plugins/prismer/` so it's discovered as a
    // user-installed provider. (Unlike the general plugin scanner used by
    // installRecallToolsPluginShell, which IS category-namespaced.)
    const dest = join(profileDir, 'plugins', 'prismer');
    // A restored checkpoint can contain an already-installed provider owned by
    // the snapshot's bootstrap uid. Re-copying identical immutable shell files
    // is unnecessary and can fail with EACCES after the runtime drops
    // privileges. Treat a byte-identical installed shell as success before any
    // mkdir/copy write. A changed runtime bundle still takes the update path
    // below and reports a real ownership problem instead of silently pinning an
    // old provider.
    const immutableFiles = ['__init__.py', 'plugin.yaml'];
    const alreadyCurrent = immutableFiles.every((name) => {
      const sourceFile = join(src, name);
      const installedFile = join(dest, name);
      return existsSync(installedFile) && readFileSync(sourceFile, 'utf8') === readFileSync(installedFile, 'utf8');
    });
    if (alreadyCurrent) return true;
    replaceManagedPluginTree(src, dest);
    return true;
  } catch (err) {
    process.stderr.write(
      `[hermes-adapter] memory provider shell install failed: ${(err as Error).message}\n`,
    );
    return false;
  }
}

/**
 * Hermes plugin key for the recall-tools plugin. Category-namespaced layout
 * `plugins/tools/prismer-recall/` → key `tools/prismer-recall` (plugins.py
 * `_scan_directory_level`). `plugins.enabled` accepts the path-derived key OR
 * the bare manifest name (plugins.py:1172-1175); we use the path-derived key.
 */
export const RECALL_TOOLS_PLUGIN_KEY = 'tools/prismer-recall';

/**
 * Replace one daemon-owned plugin directory without opening its immutable
 * files for overwrite. Hermes hardens loaded plugin files to 0444; `cpSync`
 * directly onto that tree fails with EACCES even though its parent directory
 * is writable. Stage a complete tree beside it, directory-rename the old tree
 * to a backup, then publish the stage. Any publish failure restores the old
 * directory before returning to the caller.
 */
function replaceManagedPluginTree(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stage = `${dest}.stage-${nonce}`;
  const backup = `${dest}.backup-${nonce}`;
  let movedExisting = false;
  try {
    cpSync(src, stage, { recursive: true });
    if (existsSync(dest)) {
      renameSync(dest, backup);
      movedExisting = true;
    }
    renameSync(stage, dest);
    if (movedExisting) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (movedExisting && !existsSync(dest) && existsSync(backup)) {
      renameSync(backup, dest);
    }
    throw error;
  }
}

/**
 * Desktop-202 doc 19 §8 — copy the thin recall-tools plugin
 * (`plugins/tools/prismer-recall/`) into the PER-PROFILE
 * `<profileDir>/plugins/` dir so the daemon-spawned gateway discovers it
 * (gated per-profile by `plugins.enabled`). Mirrors `installMemoryProviderShell`:
 * idempotent (overwrites the `tools/prismer-recall` subdir only), best-effort
 * (returns false + stderr-logs on failure so the caller degrades to
 * no-recall-tools rather than crashing). Does NOT touch operator-installed
 * plugins — only the prismer-recall subdir.
 *
 * WHY per-profile (empirically verified, M1 validation): the daemon spawns
 * `hermes -p <name> gateway run` WITHOUT pre-setting HERMES_HOME, and Hermes
 * `_apply_profile_override()` (main.py:271-290) runs on EVERY `-p <name>`
 * invocation, repointing `HERMES_HOME=<root>/profiles/<name>`. So the gateway
 * scans `<root>/profiles/<name>/plugins`, NEVER the shared `<root>/plugins`.
 * A plugin in the shared root shows 0 rows in `hermes -p <name> plugins list`;
 * the same plugin under the profile dir shows `enabled`.
 */
export function installRecallToolsPluginShell(profileDir: string): boolean {
  const src = resolveRecallToolsPluginSource();
  if (!src) {
    process.stderr.write(
      '[hermes-adapter] recall-tools plugin source not resolvable — skipping recall-tools install\n',
    );
    return false;
  }
  try {
    // Install into the PER-PROFILE `<profileDir>/plugins/` — the gateway's
    // effective HERMES_HOME after `-p <name>` override is the profile dir, so
    // this is the only dir its plugin scan reaches. ENABLED per-profile via
    // config.yaml `plugins.enabled`; reads PRISMER_WORKSPACE_ID/PRISMER_DAEMON_PORT
    // from the per-profile .env at runtime.
    const dest = join(profileDir, 'plugins', 'tools', 'prismer-recall');
    // Hermes hardens a live profile after gateway start. A later host.acked can
    // replay profile preparation against that read-only tree; recursively
    // copying the same immutable plugin then fails while unlinking files and
    // produces a misleading EACCES warning. Match the MemoryProvider installer:
    // if the two runtime-bearing files are byte-identical, the plugin is already
    // current and no write is required. Changed bundle bytes still take the copy
    // path and surface a real ownership/update failure.
    const immutableFiles = ['__init__.py', 'plugin.yaml'];
    const alreadyCurrent = immutableFiles.every((name) => {
      const sourceFile = join(src, name);
      const installedFile = join(dest, name);
      return existsSync(installedFile) && readFileSync(sourceFile, 'utf8') === readFileSync(installedFile, 'utf8');
    });
    if (alreadyCurrent) return true;
    replaceManagedPluginTree(src, dest);
    return true;
  } catch (err) {
    process.stderr.write(
      `[hermes-adapter] recall-tools plugin install failed: ${(err as Error).message}\n`,
    );
    return false;
  }
}

/** Resolve the on-disk `plugins/tools/prismer-recall/` plugin source dir. */
export function resolveRecallToolsPluginSource(): string | null {
  if (process.env.PRISMER_RECALL_TOOLS_PLUGIN_SHELL) {
    return process.env.PRISMER_RECALL_TOOLS_PLUGIN_SHELL;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // …/runtime/src/adapters/persistence/hermes → …/runtime/plugins/tools/prismer-recall (dev)
    // …/runtime/dist                            → …/runtime/plugins/tools/prismer-recall (packed)
    const candidates = [
      join(here, '../../../../plugins/tools/prismer-recall'),
      join(here, '../../../plugins/tools/prismer-recall'),
      join(here, '../../plugins/tools/prismer-recall'),
      join(here, '../plugins/tools/prismer-recall'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Resolve the on-disk `plugins/memory/prismer/` shell source dir. */
export function resolveMemoryProviderShellSource(): string | null {
  if (process.env.PRISMER_MEMORY_PROVIDER_SHELL) {
    return process.env.PRISMER_MEMORY_PROVIDER_SHELL;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // …/runtime/src/adapters/persistence/hermes → …/runtime/plugins/memory/prismer (dev)
    // …/runtime/dist                            → …/runtime/plugins/memory/prismer (packed)
    const candidates = [
      join(here, '../../../../plugins/memory/prismer'),
      join(here, '../../../plugins/memory/prismer'),
      join(here, '../../plugins/memory/prismer'),
      join(here, '../plugins/memory/prismer'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
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

/** Current value of `key` in `path`'s dotenv file (undefined when absent/unreadable). */
function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith(`${key}=`)) continue;
      const raw = line.slice(key.length + 1);
      // Mirror quoteEnv(): "…" with \\ and \" escapes.
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      return raw;
    }
  } catch {
    /* unreadable → treat as absent (we'll rewrite it) */
  }
  return undefined;
}

/**
 * ★ product204 · SUT-BLOCKER「skill config 对正在运行的 agent 无效」的修复（2026-07-14）。
 *
 * ## 病
 *
 * hermes 的 gateway 是**长驻 per-profile 进程**（不像 claude-code/codex 每次 dispatch
 * 新起子进程 → 它们走 `applyPrismerScopeEnv`，env 在 spawn 那一刻注入，**天然正确**）。
 * gateway 由 **python-dotenv 在启动那一刻**把 `<profileDir>/.env` 载进自己的进程 env，
 * 工具子进程继承它。
 *
 * 而 cloud 解析出来的 skill config 是**搭 dispatch payload** 来的（secret 在装配那一刻才解密，
 * 绝不进 profile GET —— 验收 B2），于是 adapter 只能在 `dispatch()` 里把它写进 `.env`
 * —— **那时 gateway 早就跑起来了**。写进去的值只是躺在盘上，永远进不了那个正在跑的进程。
 *
 * ⇒ **「CEO 给 skill 配了参数」对一个正在运行的 agent 完全无效。**（M6-03/04/05 三条门落空。）
 *
 * ## 药：这个 bug 的**孪生兄弟早就被修过了**
 *
 * `dispatch.ts` 的 skill-sync 段（release203/10 §skill-dispatch-fix）：
 *   *"a running hermes gateway scanned its **skill catalog** at spawn time; a skill synced NOW
 *    is on disk but invisible to the live process. **Drop the cached service so the next
 *    ensureService re-spawns it**"*
 *
 * **一模一样的道理，只是当时只想到了 skill 文件，没想到 skill 的 config。** 所以修法照抄：
 * 在 `ensureService` **之前**把 config 写进 `.env`，**变了就 dropService** → 下一次
 * `ensureService` 重建 gateway → python-dotenv 载入新值 → 工具子进程终于看得见。
 *
 * ## 为什么判据可以是**无状态**的（不需要记住 gateway spawn 时的快照）
 *
 * `.env` 只有 adapter 写。而本函数在 **ensureService 之前**跑，且**一旦发现差异就必然触发 respawn**。
 * 于是不变量成立：**`.env` 里的内容 == 正在跑的那个 gateway 载入的内容**。
 *   · 首次 dispatch：`.env` 无该 key → 写 + respawn ✅
 *   · 稳态：`.env` 已有且相同 → 不写不重启（**无 churn**）✅
 *   · config 变更：`.env` 是旧值 → 写新值 + respawn ✅
 *
 * @returns `.env` 是否发生了改变（true ⇒ 调用方必须 dropService 以重建 gateway）
 */
/**
 * ★ 真正地把这个 profile 的 hermes gateway **杀掉**，好让下一次 `ensureService` 重新 spawn 它。
 *
 * ## 为什么必须有这个（`dropService` 一个人不够）
 *
 * `ServicePool.drop(profileId)` 做的是：从缓存里删掉 + `svc.shutdown?.()`。
 * 而 **`HermesService.shutdown()` 只停当前 run，不碰 gateway 进程**（`:1284-1286`）。
 * 于是 gateway 还活着 → 下一次 `ensureService` 探到端口有人应答、且 `/v1/capabilities`
 * 认证过了（那本来就是我们自己的 gateway）→ **直接复用它** → `.env` 从来没被重读。
 *
 * ⇒ **只 dropService 是重建不了 gateway 的。** 必须先把进程杀掉，`ensureService` 才会
 *   走到 spawn 分支（`:583-599`：只有在"端口没人应答"或"应答的不是我们"时才 spawn）。
 *
 * ✅ **同一个洞原本也存在于 release203/10 的 skill-sync respawn**（`dispatch.ts` 里
 *   `skillSync.synced > 0 → dropService`）—— 它的注释说要"re-spawn with the complete
 *   device skillsDir"，但当初同样只 dropService 而没杀进程。**S-B5（2026-07-14）已一并修复**：
 *   `dispatch.ts` 的 skill-sync 段现在也先 `stopHermesGatewayForProfile(profile)` 再
 *   `dropService`（product204/30 Track C3 复核确认，两条 respawn 路径都真杀进程）。
 */
export async function stopHermesGatewayForProfile(
  profile: Pick<AgentProfile, 'id' | 'agentUsername' | 'config'>,
): Promise<void> {
  const parsed = HermesProfileConfigSchema.safeParse(profile.config);
  if (!parsed.success) {
    // ACS 沙箱等 apiKey-less profile（ConfigDelivery「no env-injected key」路径）从未
    // spawn 过 gateway —— stop 天然 no-op。这里绝不能抛：ZodError 会从
    // ServicePool.invalidate 的 disposer / skill-sync 回调冒泡成 uncaught，直接炸掉
    // daemon（2026-08-30 fxr fixture 复现：rebindHermesMemoryCapabilities → daemon
    // exited(1)，两轮后 bundle 被 bootstrapper blacklist，healthz 长期 503）。
    const issue = parsed.error.issues[0];
    process.stderr.write(
      `[hermes-adapter] stopHermesGatewayForProfile: profile ${profile.id} config invalid (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}) — no gateway to stop\n`,
    );
    return;
  }
  const config = parsed.data;
  const profileName = getHermesProfileName(profile);
  // 与 ensureService 同一套端口推导（`:559`）—— 算错端口就杀不到人，等于没修。
  const port = config.port !== 8642 ? config.port : portForProfile(`${profileName}:${config.apiKey}`, 8642);
  await stopStaleHermesGateways(profileName, port, config.startupTimeoutMs);
}

// ── gateway spawn stamp — 「跑着的 gateway 当初是用什么启动的」 ──────────────
//
// 2026-07-16 — 让 composer 里换模型/渠道真的生效。model 与 provider base_url 都是
// **spawn 时**烤进 gateway 的（`configurePrismerProvider` 写 config.yaml → 进程启动
// 时读一次；`resolvePrismerApiKey` 更是直接进 spawn env）。用户改 profile 后
// `ensureService` 的复用探针（`:582-590`）只问「端口上那个 gateway 是不是我们的」，
// 是就复用 —— 于是新配置写进了磁盘，跑的还是老模型。
//
// ⚠️ 不能照抄 skillConfigEnv 那套「读磁盘当见证」的无状态 diff。`.env` 的把戏成立
// 只因为**只有 dispatch 期的 adapter 写它**；而 `config.yaml` 有三条路径在 dispatch
// 之前就写成新值了（`prepareProfile` 在 boot sync 与 syncProfileFromCloud、
// `ensureService` 每次复用都写、prewarm 也写）。拿它 diff 永远读到相等 → 永不触发。
//
// 所以要一份**独立见证**：spawn 成功那一刻把当时的 model/provider 落到 stamp 文件，
// dispatch 前拿 profile 的期望值跟 stamp 比。stamp 只在 spawn 分支写（复用分支绝不
// 写，否则见证被抹掉）。
const GATEWAY_STAMP_FILE = '.prismer-gateway.json';

interface GatewaySpawnStamp {
  model: string;
  /**
   * Only present when Hermes' advertised profile model would collide with the
   * real LLM model id. Missing on an old collision stamp forces one respawn;
   * non-collision stamps remain compatible and do not churn.
   */
  apiServerModelNameOverride?: string;
  proxyProvider?: string;
  /** 解析后的 provider base（env / 本地 provider 都可能让它跟 proxyProvider 字符串脱钩）。 */
  providerBaseUrl: string;
  /** key 不落盘明文。 */
  apiKeyHash: string;
  /**
   * product204/30 Track C1 — scope 轴也是 **spawn 时**烤进 config.yaml 的：
   * `agent.disabled_toolsets`（toolsetScope）、`skills.disabled`（nativeSkillScope）、
   * MCP 工具 allowlist。改角色的能力门在运行中的 gateway 上原本是静默 no-op（跟
   * model/provider 同一 bug class）。归一化后哈希进 stamp，让 hermesGatewayConfigDrifted
   * 能判出「能力门变了」→ respawn。老 stamp 无此字段（undefined）⇒ 首次 dispatch 保守
   * respawn 一次拿到新 stamp，之后稳态不 churn。
   */
  scopeHash?: string;
  /**
   * Desktop embedded + MemoryProvider/recall-tools runtime env is also loaded
   * only when the Hermes gateway starts. Missing on an old stamp forces one
   * respawn when those lanes are active, so a reused gateway does not keep an
   * old PRISMER_DAEMON_PORT / agent identity.
   */
  runtimeEnvHash?: string;
}

function gatewayStampPath(profileName: string): string {
  return join(getHermesProfileDir(profileName), GATEWAY_STAMP_FILE);
}

/**
 * 归一化 scope 轴（product204/30 Track C1）。数组排序 ⇒ 源顺序 / top-level-vs-roleTemplate
 * 来源都不制造假漂移；真正改了能力门才翻。用 resolved 的 nativeSkillScope（角色声明的
 * 意图）而非完全展开的 `skills.disabled`，以免与磁盘上的 bundled skill 集合耦合（那是
 * skill-sync 的职责，另有 respawn 路径）。
 */
function gatewayScopeHash(config: HermesProfileConfig): string {
  const nativeScope = resolveNativeSkillScope(config);
  const signature = {
    disabledToolsets: computeDisabledToolsets(resolveToolsetScope(config)).slice().sort(),
    nativeSkillScope: nativeScope
      ? {
          mode: nativeScope.mode,
          categories: [...(nativeScope.categories ?? [])].sort(),
          skills: [...(nativeScope.skills ?? [])].sort(),
        }
      : null,
    mcpAllowlist: resolveMcpAllowlist(config)?.slice().sort() ?? null,
  };
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 16);
}

function gatewayRuntimeEnvHash(
  profileName: string,
  config: HermesProfileConfig,
  profile?: Pick<AgentProfile, 'workspaceId' | 'agentUsername' | 'agentImUserId'>,
): string | undefined {
  const memoryProviderIntent =
    config.installMemoryProvider === true || process.env.PRISMER_MEMORY_PROVIDER === '1';
  const recallToolsIntent =
    memoryProviderIntent ||
    config.installRecallToolsPlugin === true ||
    process.env.PRISMER_RECALL_TOOLS_PLUGIN === '1';
  if (!memoryProviderIntent && !recallToolsIntent) return undefined;

  const daemonPort = (process.env.PRISMER_DAEMON_PORT ?? '7878').trim() || '7878';
  const signature = {
    memoryProviderIntent,
    recallToolsIntent,
    daemonPort,
    workspaceId: profile?.workspaceId?.trim() || null,
    agentUsername: profile?.agentUsername?.trim() || profileName,
    agentImUserId: profile?.agentImUserId?.trim() || null,
  };
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 16);
}

function buildGatewayStamp(
  profileName: string,
  config: HermesProfileConfig,
  profile?: Pick<AgentProfile, 'workspaceId' | 'agentUsername' | 'agentImUserId'>,
): GatewaySpawnStamp {
  const apiServerModelNameOverride = resolveHermesApiServerModelNameOverride(profileName, config.model);
  const runtimeEnvHash = gatewayRuntimeEnvHash(profileName, config, profile);
  return {
    model: config.model,
    ...(apiServerModelNameOverride ? { apiServerModelNameOverride } : {}),
    proxyProvider: config.proxyProvider,
    providerBaseUrl: resolvePrismerProviderBaseUrl(config),
    apiKeyHash: createHash('sha256').update(resolvePrismerApiKey(config)).digest('hex').slice(0, 16),
    scopeHash: gatewayScopeHash(config),
    ...(runtimeEnvHash ? { runtimeEnvHash } : {}),
  };
}

/**
 * 进程内见证兜底：profile dir 不可写（磁盘满 / 只读 FS / 权限）时 writeFileSync 会抛，
 * 落不下 stamp 文件。若只靠文件，下次 dispatch 就把「本进程刚 spawn、只是没记下」的
 * gateway 当成无见证的孤儿 → 每条消息 kill+respawn，清空会话上下文（正是注释里说
 * 绝不能发生的 kill-storm）。故本进程 spawn 出来的 gateway 一律记进内存，readGatewayStamp
 * 文件读不到时回退到它。跨 daemon 世代的孤儿不在本 Map 里（也无文件）→ 仍走保守重启一次。
 */
// 键用 stamp 的绝对路径（而非 profileName）：生产里路径随 profile 稳定 = 同一见证跨
// dispatch 复用；不同 HERMES_HOME（含测试隔离）路径不同 = 天然不串。
const inMemoryGatewayStamps = new Map<string, GatewaySpawnStamp>();

/** spawn 成功后调用 —— 记录这个 gateway 进程实际带着什么配置起来的。 */
export function writeHermesGatewayStamp(
  profileName: string,
  config: HermesProfileConfig,
  profile?: Pick<AgentProfile, 'workspaceId' | 'agentUsername' | 'agentImUserId'>,
): void {
  const stamp = buildGatewayStamp(profileName, config, profile);
  const path = gatewayStampPath(profileName);
  inMemoryGatewayStamps.set(path, stamp);
  try {
    writeFileSync(path, JSON.stringify(stamp), 'utf8');
  } catch (err) {
    // 文件记不下：本进程已在内存里见证（上面 set），不会 kill-storm；仅告警。
    process.stderr.write(
      `[hermes-adapter] failed to write gateway stamp for ${profileName} (in-memory witness kept): ${(err as Error).message}\n`,
    );
  }
}

function readGatewayStamp(profileName: string): GatewaySpawnStamp | null {
  const path = gatewayStampPath(profileName);
  try {
    const raw = readFileSync(path, 'utf8');
    const v = JSON.parse(raw) as GatewaySpawnStamp;
    if (v && typeof v.model === 'string') return v;
  } catch {
    // 文件不存在 / 读失败 → 回退进程内见证（本进程 spawn 但写盘失败的场景）。
  }
  return inMemoryGatewayStamps.get(path) ?? null;
}

/**
 * 跑着的 gateway 的配置是否已经跟 profile 期望的不一致（model / 渠道 / 解析后的
 * provider base / key）。true ⇒ 必须杀掉重启，否则用户改的模型不生效。
 *
 * 稳态必须返回 false —— 误报会让每次 dispatch 都重启 gateway、清空所有会话上下文。
 */
export function hermesGatewayConfigDrifted(
  profile: Pick<AgentProfile, 'id' | 'workspaceId' | 'agentUsername' | 'agentImUserId' | 'config'>,
): boolean {
  let config: HermesProfileConfig;
  try {
    config = HermesProfileConfigSchema.parse(profile.config);
  } catch {
    return false; // 配置都解析不了，交给 ensureService 去报错，别在这儿杀进程
  }
  const profileName = getHermesProfileName(profile);
  const stamp = readGatewayStamp(profileName);
  if (!stamp) {
    // 无见证：只有当端口上真有个 gateway 活着时才算漂移（它可能是上个 daemon 世代
    // 留下的孤儿，配置未知 ⇒ 保守重启）。冷启动没进程 ⇒ 不是漂移，别 kill-storm。
    const port = config.port !== 8642 ? config.port : portForProfile(`${profileName}:${config.apiKey}`, 8642);
    return findHermesGatewayPids(profileName, port).length > 0;
  }
  const want = buildGatewayStamp(profileName, config, profile);
  return (
    stamp.model !== want.model ||
    stamp.apiServerModelNameOverride !== want.apiServerModelNameOverride ||
    stamp.proxyProvider !== want.proxyProvider ||
    stamp.providerBaseUrl !== want.providerBaseUrl ||
    stamp.apiKeyHash !== want.apiKeyHash ||
    // product204/30 Track C1 — scope 轴（disabled_toolsets / nativeSkillScope / mcpAllowlist）
    // 变了也必须 respawn，否则改角色能力门对运行中的 gateway 静默无效。
    stamp.scopeHash !== want.scopeHash ||
    // Desktop embedded / MemoryProvider runtime env is also spawn-time state.
    // Keep it in the stamp so env/plugin/identity/port changes do not silently
    // reuse a live gateway that loaded the old .env.
    stamp.runtimeEnvHash !== want.runtimeEnvHash
  );
}

export function syncSkillConfigEnvToProfile(
  profileName: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const skillEnv = skillConfigEnvFromMetadata(metadata);
  const entries = Object.entries(skillEnv);
  if (entries.length === 0) return false;

  const envPath = join(getHermesProfileDir(profileName), '.env');
  let changed = false;
  for (const [key, value] of entries) {
    if (readEnvValue(envPath, key) === value) continue; // 稳态：一致就不动（不制造 respawn churn）
    try {
      writeEnvValue(envPath, key, value);
      changed = true;
    } catch (err) {
      process.stderr.write(
        `[hermes-adapter] failed to write skill config env ${key} for ${profileName}: ${(err as Error).message}\n`,
      );
    }
  }
  return changed;
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

/**
 * Hermes advertises the active profile name as its virtual API model. Its
 * confirmed-lock parser treats that value as the global fallback rather than a
 * routable raw model, so a profile whose name equals the real model id gets a
 * 409 `model_lock_unavailable`. Override only that collision; leaving every
 * other profile undefined preserves Hermes' existing advertised-model behavior.
 */
export function resolveHermesApiServerModelNameOverride(
  profileName: string,
  model: string,
): string | undefined {
  return profileName === model ? `prismer-profile:${profileName}` : undefined;
}

/** Exact environment fragment spread into the daemon-spawned Hermes gateway. */
export function buildHermesApiServerModelNameEnv(
  profileName: string,
  model: string,
): Record<string, string | undefined> {
  const override = resolveHermesApiServerModelNameOverride(profileName, model);
  // The spawn env starts with `...process.env`; assigning undefined is how
  // Node omits an inherited variable from the child environment.
  return { API_SERVER_MODEL_NAME: override };
}

/**
 * The Hermes home ROOT (`$HERMES_HOME` or `~/.hermes`). NOTE (empirically
 * verified, M1 validation): a daemon-spawned gateway does NOT scan this root for
 * plugins. The daemon spawns `hermes -p <name> gateway run` WITHOUT pre-setting
 * HERMES_HOME, and Hermes `_apply_profile_override()` (main.py:271-290) runs on
 * EVERY `-p <name>` invocation, repointing `HERMES_HOME=<root>/profiles/<name>`.
 * So the gateway's plugin scan (`get_hermes_home()/plugins`) resolves to
 * `<root>/profiles/<name>/plugins`. Standalone `plugins.enabled` plugins must
 * therefore be installed under the PER-PROFILE dir (see getHermesProfileDir +
 * installRecallToolsPluginShell), then enabled per-profile via config.yaml.
 * This root helper is retained for getHermesProfileDir composition only.
 */
export function getHermesHomeRoot(): string {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}

export function getHermesProfileDir(profileName: string): string {
  const root = getHermesHomeRoot();
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
  // Priority 2 (desktop-202 Phase 7, docs/desktop202/12 §2): daemon-local
  // provider profile (BYOK / Ollama). When `proxyProvider` names a configured
  // `[[providers]]` id AND its key resolves (Ollama: no key), direct-connect to
  // the profile's base_url. Unset / cloud-chain selector → null → existing path
  // below is byte-for-byte unchanged (CLI / K8s daemon / web).
  const local = resolveLocalProvider(config.proxyProvider);
  if (local) return local.baseUrl;
  const cloudBase = process.env.PRISMER_BASE_URL?.replace(/\/$/, '');
  if (!cloudBase) return '';
  // Priority 3: proxyProvider chain switch (release202/07). Any chain id other
  // than newapi/default rewrites the base to the per-provider alias so the
  // cloud walks that chain (see src/app/api/proxy/[provider]/chat/completions).
  // Default `newapi` keeps the platform aggregator path.
  const provider = config.proxyProvider;
  // A `local:<id>` selector that reached here did NOT resolve (profile absent on
  // this machine / key unprovisioned). It names nothing on the cloud, so walking
  // it as a chain would build `/api/v1/proxy/local%3A<id>` → 404 on every call.
  // Fall back to the platform aggregator, the same landing as no selector.
  if (provider && !isLocalProviderSelector(provider) && provider !== 'newapi' && provider !== 'default') {
    return `${cloudBase}/api/v1/proxy/${encodeURIComponent(provider)}`;
  }
  return `${cloudBase}/api/v1`;
}

function resolvePrismerApiKey(config: HermesProfileConfig): string {
  // Desktop-202 Phase 7: a matched local provider supplies its own key (BYOK).
  // Ollama is keyless → empty string, which is correct (no Authorization).
  const local = resolveLocalProvider(config.proxyProvider);
  if (local) return local.apiKey ?? '';
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
 * Idempotently write a built-in SKILL.md into the profile's skills dir.
 * Called at ensureService-time (so the verify probe below has something to
 * assert against) AND on every dispatch (so the runtime version stays
 * authoritative even if the file was deleted between turns). Best-effort: a
 * failed write logs but never throws — dispatch can still proceed degraded,
 * the verify probe for required native skills will then loud-warn.
 */
function installBuiltInHermesSkill(profileName: string, slug: string): void {
  try {
    const skillPath = resolveBuiltInSkillPath(slug);
    if (skillPath === null) {
      // The canonical SKILL.md is missing — the prebuild mirror failed or the
      // runtime is running from an unsupported layout. Loud-warn and skip
      // (best-effort: dispatch can still proceed; the verify probe will then
      // mark `missing` and metrics will surface the regression).
      process.stderr.write(
        `[hermes-adapter] cannot locate built-in skill ${slug} on disk; skipped install for ${profileName}\n`,
      );
      return;
    }
    const profileDir = getHermesProfileDir(profileName);
    const skillDir = join(profileDir, 'skills', slug);
    installHermesBundledSkill(dirname(skillPath), skillDir);
  } catch (err) {
    process.stderr.write(
      `[hermes-adapter] failed to install ${slug} skill for ${profileName}: ${(err as Error).message}\n`,
    );
  }
}

/**
 * Install the standard built-in skill set for a Hermes profile:
 * collaboration + memory + PKF authoring/visual discipline (always), plus
 * memory-dream for orchestrators (see MEMORY_DREAM_SKILL_NAME note).
 */
export function installBuiltInHermesSkills(profileName: string, taskAuthority: string | undefined): void {
  installBuiltInHermesSkill(profileName, PRISMER_IM_SKILL_NAME);
  installBuiltInHermesSkill(profileName, MEMORY_SKILL_NAME);
  installBuiltInHermesSkill(profileName, PKF_WRITING_SKILL_NAME);
  installBuiltInHermesSkill(profileName, PKF_SVG_SKILL_NAME);
  if (taskAuthority === 'orchestrator') {
    installBuiltInHermesSkill(profileName, MEMORY_DREAM_SKILL_NAME);
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
    return evaluateHermesDetailedHealth(json);
  } catch {
    return false;
  }
}

/**
 * Hermes 0.20.0 起 /health/detailed 的顶层 status 有三态:ok / degraded /
 * (error)。degraded 是 hermes 自报的**运维降级**(如宿主磁盘 >= 90%),此时
 * gateway 与 api_server 仍然工作——把 degraded 判死会让每次 dispatch
 * 30s 超时 + 杀网关重来(2026-08-16 本地 kind pod 实测事故)。可用性的两个
 * 必要条件仍是:gateway 在 running 且 api_server 平台 connected;顶层
 * status 只接受 ok|degraded,其余(含缺失)一律判不健康。
 */
export function evaluateHermesDetailedHealth(json: HermesDetailedHealth): boolean {
  if (json.status !== 'ok' && json.status !== 'degraded') return false;
  // The gateway dispatcher itself is up before per-platform connectors
  // finish handshaking. We need BOTH bits: gateway running AND api_server
  // platform connected (the latter is what serves /v1/capabilities and
  // /api/sessions). gateway_state may be absent on older builds — treat
  // missing as best-effort OK rather than hard-fail.
  if (json.gateway_state && json.gateway_state !== 'running') return false;
  const apiServerState = json.platforms?.api_server?.state;
  return apiServerState === 'connected';
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
  // ★ SIGKILL 是**异步**的 —— 发完就返回等于没杀。
  //
  // 之前这里 SIGKILL 完就 return，于是调用方（skill-config 变更 → 杀 gateway → `ensureService`）
  // 会在旧进程**还占着端口**的窗口里探测：端口有人应答且认证得过 ⇒ `ensureService`
  // **直接复用那个正在死的旧 gateway** —— 而它的 env 是**旧的**（python-dotenv 只在 spawn 时读 .env）。
  // ⇒ 新绑定的 skill-config 静默失效，且**是时序竞争，约 1/5 的概率**。
  // 实测正是 R2-S1「每个 slot 恒 4/5」和 probe 时绿时红的成因：daemon.log 里
  // `killed hermes gateway … re-spawn` **打印了**，产物却仍不含 nonce —— 杀了，但没杀干净。
  const gone = Date.now() + 5_000;
  while (Date.now() < gone) {
    if (!pids.some(pidAlive) && findHermesGatewayPids(profileName, port).length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
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
import { ensureCloudCliShim } from './cloud-cli-shim.js';
