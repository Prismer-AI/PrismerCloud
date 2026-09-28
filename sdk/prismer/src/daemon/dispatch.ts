// task.dispatch.request → adapter routing.
//
// Steps:
//   1. Resolve AgentProfile (cloud HTTP — m4 may add a local mirror).
//   2. Look up adapter by profile.adapterName.
//   3. Rewrite prismer:// URIs in prompt + context entries to file://<cache path>.
//      Pin the resolved hashes for the duration of the task.
//   4. Concatenate context history + current message → adapter prompt.
//   5. dispatch (interactive) or ensureService → service.dispatch (long-running).
//   6. Forward progress events as task.dispatch.progress.
//   7. Send task.dispatch.reply (echoes requestId).
//   8. Unpin assets.
//
// See docs/refactor/04-daemon-runtime.md §dispatch and 11-multi-agent §三.

import { readFileSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type {
  AssetDispatchObservation,
  AssetDispatchStrategy,
  AssetRef,
  LlmRoutingMetadata,
  ResolvedAssetRef,
  TaskDispatchContextEntry,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskDispatchRequestPayload,
} from '../types/im-events.js';
import type { TaskDurabilityResult } from '../types/im-events.js';
import type { CloudClient } from '../auth.js';
import { CloudError } from '../auth.js';
import type { UrlResolution } from '../uri-resolver.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type {
  AdapterDef,
  AdapterService,
  AgentProfile,
  DispatchCallOptions,
  TaskInput,
  TaskResult,
} from '../adapters/contract.js';
import type { AssetCache } from '../asset-cache.js';
import type { UriResolver } from '../uri-resolver.js';
import { randomUUID } from 'node:crypto';
import { envelope } from '../envelope.js';
import type { WsClient } from './ws-client.js';
import type { ArtifactsWatcher } from './artifacts-watcher.js';
import { flushRejections as flushArtifactsRejections } from './artifacts-watcher.js';
import type { ConfigPaths } from '../config.js';
import {
  deriveSessionId,
  resolveProjectReposDir,
  resolveSessionDir,
  resolveSessionTaskWorkdir,
  resolveTaskWorkdir,
  UNSCOPED_PROJECT_SENTINEL,
} from '../config.js';
import type { AssetMetadataIndex } from './asset/metadata-index.js';
import { ensureWorkdir, WorkdirMaterializeError } from './workdir-materialize.js';
import { seedDevPreset } from './seed-dev-preset.js';
import { resolveApcCodingScope, resolveSkillsRoot, syncInstalledSkillsForDispatch, SkillSyncSafetyError } from './skill-sync.js';
import { FileSystemSkillLoader, renderSkillsSystemPrompt } from './skill-loader.js';
import { APC_HELDOUT_DENY_METADATA_KEY } from '../adapters/coding/claude-code/config-isolation.js';
import { resolveAgentDirPaths } from './agent-dir.js';
import { TaskHeartbeat } from './task-heartbeat.js';
import { StepRecorder } from './step-recorder.js';
import { getTaskReaperMinInactivityMs } from './reaper-config.js';
import { daemonMetricEmit, type DaemonMetricEmit } from './metric-emit.js';
import { makeTraceStderr, resolveDispatchTraceId } from './trace.js';
import { getRunCheckpointStore } from './memory/run-checkpoint-store.js';
import { getRunSessionRegistry } from './memory/run-session-map.js';
import { refreshRecallPolicyForWorkspace } from './memory/recall-policy-provider.js';
import { noteDispatchRecall } from './memory/session-recall.js';
import { summarizeR5TurnFor, summarizeToolTurnFor } from './memory/tool-sequence.js';
import { extractInlinePkfReply } from './inline-pkf.js';
import {
  bindPkfReplyInlineScope,
  resolvePkfReplyInlineBlocks,
  unbindPkfReplyInlineScope,
} from './pkf/reply-inline.js';
import type { AgentDispatchReplyPkfContentBlock } from '../wire/dispatch-types.js';
import type { PreReplyDurabilityInput } from '../adapters/coding/shared/lifecycle/pre-reply-durability.js';
import { canonicalDurabilityCommitKey } from '../adapters/coding/shared/lifecycle/canonical-turn-identity.js';
import { renderPkfRuntimeCapabilityDirective, type PkfRuntimeCapabilityReport } from './pkf-runtime-capability.js';
// product204 skill-config 注入修复：hermes gateway 是长驻进程，dotenv 只在 spawn 时载入 .env
// ⇒ config 变了必须在 ensureService 之前写盘 + dropService 重建（详见下方调用点的长注释）。
import {
  getHermesProfileDir,
  getHermesProfileName,
  syncSkillConfigEnvToProfile,
  stopHermesGatewayForProfile,
  hermesGatewayConfigDrifted,
  resolveToolsetScope,
  computeDisabledToolsets,
  HermesProfileConfigSchema,
} from '../adapters/persistence/hermes/index.js';
// S6/M1 — daemon-side second gate of the commentary relay double-gate
// (per-request `interimReply` capability bit AND this env kill-switch).
import { isHermesCommentaryRelayEnabled } from '../adapters/persistence/hermes/flag.js';

/**
 * Record of a single #ref resolution during dispatch.
 */
export interface HashRefResolution {
  /** The original #text found in the prompt (without the # prefix). */
  ref: string;
  /** Position of the '#' character in the original prompt. */
  start: number;
  /** Position after the last character of the match. */
  end: number;
  /** Full prismer:// URI if resolved; undefined if unresolved. */
  resolvedUri?: string;
}

/**
 * Result of hash-ref resolution pass.
 */
export interface HashRefResult {
  /** Prompt with #refs replaced by prismer:// URIs. */
  text: string;
  /** All resolutions (resolved + unresolved) for observability. */
  resolutions: HashRefResolution[];
}

export interface DispatchDeps {
  registry: AdapterRegistry;
  cloud: CloudClient;
  uriResolver: UriResolver;
  assetCache: AssetCache;
  ws: WsClient;
  /** Cap on total chars of joined context history. Default 8000. */
  contextMaxChars?: number;
  /** Resolves a long-running adapter's service handle (cached across calls). */
  ensureService: (profile: AgentProfile, adapter: AdapterDef) => Promise<AdapterService>;
  /**
   * release203/10 §skill-dispatch-fix — drop a cached long-running service so
   * the next `ensureService` re-spawns it. Called after skill-sync installs a
   * NEW skill onto a hermes agent whose gateway is already running: the live
   * process scans its skill catalog at spawn time and won't pick up a skill
   * added later, so a re-spawn (with the now-complete device skillsDir) is the
   * only way to make the just-installed skill usable in-session.
   */
  dropService?: (profileId: string) => void | Promise<void>;
  /**
   * Atomically fence one profile, quiesce pending creators, dispose its cached
   * handle, and run `disposer` before allowing a later ensureService call.
   * Runner wires this to ServicePool.invalidate; Hermes gateway restarts must
   * use this seam so prewarm cannot race the first dispatch.
   */
  invalidateService?: (profileId: string, disposer: () => void | Promise<void>) => Promise<void>;
  /**
   * S-B5 — consume (check + clear) a profile's "skill-dirty" flag set by a
   * non-dispatch sync path (profile-changed broadcast / periodic background).
   * Returns true if the profile had a pending skill change the gateway hasn't
   * picked up. The dispatch path (serial, safe) then kills + re-spawns the
   * gateway so the change is visible on THIS dispatch — without murdering an
   * in-flight run (the background path can't kill safely, so it only flags).
   */
  consumeSkillDirty?: (profileId: string) => boolean;
  /**
   * S5 §3.4-4b — re-arm a profile's skill-dirty flag. Counterpart of
   * `consumeSkillDirty`: when the skill-sync respawn is DEFERRED because a turn
   * is in flight, the pending change must survive to the next dispatch.
   */
  markSkillDirty?: (profileId: string) => void;
  /**
   * S5 §3.4-4b — does the profile's cached service have a turn in flight?
   * Wired to `ServicePool.peek(id) instanceof HermesService && svc.busy`.
   */
  peekServiceBusy?: (profileId: string) => boolean;
  /** Aborts the in-flight adapter dispatch when cloud sends task.cancel. */
  signal?: AbortSignal;
  /** Hook for tests / observability. */
  onProgress?: (taskId: string, p: TaskDispatchProgressPayload) => void;
  /**
   * Local agent_profiles mirror (the same rows `loadAllProfiles` reads —
   * host.acked sync / static bindings). resolveProfileResilient serves it only
   * after cloud retries are exhausted, so standalone / disconnected daemons can
   * still dispatch. Optional: absent means cloud-only (unchanged behavior).
   */
  resolveLocalProfile?: (input: { profileId?: string; agentImUserId?: string }) => AgentProfile | null;
  /**
   * Artifacts uploader. When provided, dispatch creates a per-task artifacts
   * directory, points the watcher at it via setActiveTask, and drains its
   * assetIds into reply.assetIds at flush time. Optional so tests can omit it.
   */
  artifactsWatcher?: ArtifactsWatcher;
  /**
   * product210/03 W1-3 (R12) — terminal silent archive of validated inline PKF
   * deliverables as agent-output assets. Uploads from the ALREADY-VALIDATED
   * source bytes (never re-extracts), dedupes by contentHash, and the returned
   * ids must NOT ride reply.assetIds (no chat double-display) — they ride
   * `reply.pkfArchiveAssetIds` for the deliverable ledger + G9 pointer
   * targets. Optional so tests can stub it; production runner wires the
   * DaemonAssetUploadClient.
   */
  uploadInlinePkfArchive?: (input: {
    workspaceId: string;
    taskId: string;
    blocks: Array<{ title?: string | null; source: string }>;
  }) => Promise<string[]>;
  /** Daemon paths — used to derive the per-task artifacts dir. */
  paths?: ConfigPaths;
  /**
   * release201/09 §9.9 — Stable device identifier from `config.toml`. Surfaced
   * to the spawned agent process as `PRISMER_DAEMON_ID` env for metric-outbox
   * emission + transfer manifest authoring. Optional so existing tests can
   * omit it; production runner always provides.
   */
  daemonId?: string;
  /**
   * Multi-workspace asset metadata indexes for #filename resolution.
   * Keyed by workspaceId. If absent, #ref resolution is skipped entirely.
   */
  assetMetadataIndexes?: Map<string, AssetMetadataIndex>;
  /**
   * 14b D34=C — optional override for image vision-fallback. Enabled by
   * default when image assetRefs are present.
   */
  visionAux?: {
    enabled?: boolean;
    cacheDir?: string;
    timeoutMs?: number;
  };
  /**
   * product209 Phase 1 — bounded authoritative Memory barrier. Production
   * runner supplies this; optional keeps older embedders wire-compatible.
   */
  preReplyDurabilityBarrier?: (input: PreReplyDurabilityInput) => Promise<TaskDurabilityResult>;
  /**
   * product209 Phase 6 — host-verified PKF capability receipt. The Runtime
   * computes this from the actual function-tool registry, installed skill
   * files, bundled core and managed Cloud CLI. The model never probes PATH or
   * imports Python to rediscover these capabilities.
   */
  resolvePkfRuntimeCapability?: (profile: AgentProfile) => PkfRuntimeCapabilityReport;
}

type HermesInvalidationDeps = Pick<DispatchDeps, 'invalidateService' | 'dropService'>;

/**
 * S5 §3.4-4b (specs/05 Task 6) — the two extra seams the busy-gated
 * skill-sync respawn needs on top of the plain invalidation deps.
 */
type HermesSkillSyncRespawnDeps = HermesInvalidationDeps & {
  /** True when the profile's live service has a turn in flight. */
  peekServiceBusy?: (profileId: string) => boolean;
  /** Re-arm the profile's skill-dirty flag for a later dispatch to consume. */
  markSkillDirty?: (profileId: string) => void;
};

/**
 * Restart one Hermes profile without leaving a stop/drop race window.
 * Production always supplies the atomic ServicePool invalidator. The legacy
 * fallback remains for older embedders/tests, but drops the cached handle
 * before stopping the exact gateway and therefore never repeats stop→drop.
 */
export async function invalidateHermesService(profile: AgentProfile, deps: HermesInvalidationDeps): Promise<void> {
  if (deps.invalidateService) {
    await deps.invalidateService(profile.id, () => stopHermesGatewayForProfile(profile));
    return;
  }
  if (deps.dropService) await deps.dropService(profile.id);
  await stopHermesGatewayForProfile(profile);
}

/**
 * S5 §3.4-4b (specs/05 Task 6) — restarted-at-spawn gateway vs an in-flight run.
 *
 * A hermes gateway scans its skill catalog at SPAWN time; the pinned upstream
 * route table has no skill reload/rescan endpoint (only a read-only
 * `GET /v1/skills`), so a skill installed while the gateway lives stays
 * invisible until the process is replaced. Killing it mid-turn, however,
 * vacates EVERY session on that profile (hermes holds sessions in memory) —
 * every mapped conversation of that agent starts 404-ing, not just this one.
 *
 * So: idle ⇒ kill now (unchanged behaviour). Busy ⇒ defer, re-arm the dirty
 * flag and let the next dispatch (or idle moment) retry. The just-synced skill
 * is skipped for this turn rather than lost — a strictly better failure than
 * murdering a running turn and bricking the profile's session map.
 */
export async function respawnHermesGatewayAfterSkillSync(
  profile: AgentProfile,
  deps: HermesSkillSyncRespawnDeps,
  detail: string,
): Promise<'killed' | 'deferred'> {
  const busy = deps.peekServiceBusy?.(profile.id) === true;
  if (busy) {
    if (!deps.markSkillDirty) {
      // No way to remember the change ⇒ deferring would silently drop it.
      // Fall through to the kill (the pre-S5 behaviour) and say so loudly.
      process.stderr.write(
        `[daemon] skill sync: ${profile.id} has an in-flight run but no skill-dirty seam is wired — killing the gateway anyway\n`,
      );
    } else {
      deps.markSkillDirty(profile.id);
      process.stderr.write(
        `[daemon] skill sync: deferred gateway respawn profile=${profile.id} (turn in flight) ${detail} — dirty flag re-armed\n`,
      );
      return 'deferred';
    }
  }
  await invalidateHermesService(profile, deps);
  return 'killed';
}

const DEFAULT_CONTEXT_MAX = 8_000;
const GOAL_CONTEXT_MAX = 4;
const MEMORY_DIGEST_MAX_BYTES = 4_000;
// release203 — the approval-seeking line is NOT part of the base defaults
// anymore. It is appended by resolveOperatingPrinciples() ONLY for
// non-autonomous policies, so an autonomous agent's prompt carries zero
// approval-seeking text (see the policy switch below).
const DEFAULT_OPERATING_PRINCIPLES = [
  '- Decide and act.',
  '- Assignable work should become explicit tasks; do not leave concrete work as chat discussion only.',
  '- Use workspace asset tools for uploaded files: search/describe first, then read bounded ranges; do not claim file contents unless a tool call succeeded.',
  '- Keep users informed with concise status and concrete next steps.',
].join('\n');

/**
 * Wave-8 W1: caps for inlining text-like asset bodies into the prompt.
 *
 * The agent's context window is the scarce resource, so we treat assets as
 * just another contributor to it: a text-like asset under 64 KiB is inlined
 * verbatim; anything bigger is truncated to 16 KiB with a clear marker so
 * the agent (and any downstream parser) can see content was clipped.
 *
 * Non-text assets (images, PDFs, archives) are NOT inlined. The daemon
 * surfaces a `file://<localPath>` URI in the prompt so the adapter's own
 * read/parse tool can pick them up — and reports `uri-only` in
 * `assetObservability` so an absent tool isn't masked as "consumed".
 */
const ASSET_INLINE_FULL_MAX_BYTES = 64 * 1024;
const ASSET_INLINE_TRUNCATE_BYTES = 16 * 1024;

/**
 * release203/06 §3.7 (block 1) — adapters that are REPO-scoped: their cwd must
 * be a persistent repo folder reused across turns (codex CODEX_HOME thread
 * resume + claude-code `.claude/projects` session resume + the repo files all
 * live there). Only these adapters honor a dispatch `workdir` spec; for the
 * conversational adapters (hermes / openclaw) the workdir is ignored and the
 * existing per-task scratch behavior is kept.
 */
const REPO_SCOPED_ADAPTERS = new Set(['codex', 'claude-code']);

/**
 * runtime210/09 §2.3 (review P1-C) — adapters whose SESSION must bind a
 * materialized dispatch `workdir`. Superset of `REPO_SCOPED_ADAPTERS`: pi-core
 * is not a repo-resume adapter, but its embedded engine jails read/write/edit
 * to the session cwd, so a dispatch workdir must override the profile cwd
 * exactly like the repo-scoped coding adapters (otherwise the FS tools operate
 * on the wrong tree while the dispatch claims the workdir). Conversational
 * adapters (hermes / openclaw) stay out — their sandbox is the profile dir.
 */
const WORKDIR_OVERRIDE_ADAPTERS = new Set([...REPO_SCOPED_ADAPTERS, 'pi-core']);

/** True when `adapterName` is a repo-scoped code agent (codex / claude-code). */
export function isRepoScopedAdapter(adapterName: string): boolean {
  return REPO_SCOPED_ADAPTERS.has(adapterName);
}

/**
 * release203/11 §2.1/§2.4 (Slice A) — the three CODING adapters. Broader than
 * `REPO_SCOPED_ADAPTERS` (which is opencode-exclusive for the doc-06 workdir
 * override): the canonical identity model treats claude-code / codex / opencode
 * uniformly as "coding" agents for the SOUL default + always-seed cwd behavior.
 */
const CODING_ADAPTERS = new Set(['claude-code', 'codex', 'opencode']);

/** True when `adapterName` is a coding agent (claude-code / codex / opencode). */
export function isCodingAdapter(adapterName: string): boolean {
  return CODING_ADAPTERS.has(adapterName);
}

/**
 * release203/11 §2.1 / §2.5 decision (Slice A) — the净身 coding SOUL default.
 *
 * doc 10 cleared coding agents' `config.systemPrompt` to '' to strip business
 * org-chart personas (Team Manager/PM). But净身 = "no business persona", NOT "no
 * identity": with an empty system prompt the claude/codex/opencode model leads
 * with its own generic persona, so "who are you?" answers as plain Claude.
 *
 * When a coding agent has no persona (profileSystemPrompt empty), the daemon
 * injects this concise engineering persona so the agent has a baseline voice +
 * answer-style rules (reply in the user's language; verify before fabricating)
 * WITHOUT smuggling in a role template. Persona-bearing coding agents keep
 * their own systemPrompt and never see this default.
 */
export const CODING_SOUL_DEFAULT =
  'You are a focused coding agent. Be concise and precise. Prefer reading code over guessing. Always reply in the language the user used in their latest message. Do not fabricate APIs, files, or results — verify first.';

/**
 * memory203/14 (user steer 2026-07-01) — MEMORY IS A FIXED PART OF AGENT
 * OPERATION, not an optional skill that may or may not be loaded/discovered.
 *
 * Root cause this fixes: the memory / memory-dream SKILL.md never reached the
 * long-running agent's LLM context (hermes only loads `prismer-im-collab` into
 * its skill dir; the daemon system prompt injected persona+principles but NO
 * skill content). So an orchestrator dispatched a "converge memory" task had
 * neither the duty nor the procedure in context — it made one generic tool call
 * and wrote a text summary instead of enacting. The user's correction: memory
 * must be DOUBLE-reinforced — (1) this common operating directive injected into
 * every long-running role's system prompt, and (2) the builtin memory /
 * memory-dream skills as the detailed second layer.
 *
 * product209/19 WP3 revision (2026-08): injected into ALL FOUR adapter families
 * — hermes AND claude-code / codex / opencode — via composeCoreDirectives() at
 * the composedSystemPrompt seam (the 2026-07-01 coding净身 ruling originally
 * limited this to hermes; WP3 overturns that boundary: coding agents keep净身
 * for business persona, but memory duty is standing for every adapter).
 * Verbatim-identical text for all four (acceptance asserts it).
 *
 * CRITICAL — points at the NATIVE TOOLS the memory provider exposes
 * (`memory_search` / `memory_load` / `memory_browse` / `memory_write` /
 * `memory_curate`), NOT a `cloud memory …` CLI. The live failure this fixes: the
 * orchestrator read the skill (which spoke of a "memory-dream skill" + `cloud
 * memory curate` CLI), could not map that onto the `memory_curate` TOOL it
 * actually holds, and replied CURATE_UNAVAILABLE. Naming the real tool + its ops
 * makes enactment unambiguous.
 *
 * memory203/18 W2 revision (post W1-gate): teaches the browse-first write flow
 * (`memory_browse` → placement decision → `memory_write` with
 * `parentHubPath`), the hardened RECALL rule (memory before re-reading raw
 * attached files), and the tightened orchestrator convergence loop
 * (`promote_to_hub` WITH `childPaths` — the gate showed hollow promotes +
 * hand-written re-anchor links produced inverted/unresolved edges).
 *
 * memory203/20 W-C revision (four-truths guidance): the old "NEVER write or
 * hand-edit INDEX.pkf" absolutism is REPLACED by the dual-section truth (§1.3
 * W-A landed: `#toc` machine-owned via rewriteTocSection, `#overview` prose
 * agent-owned and rebuild-proof); adds the richness line (REQUIRED frontmatter
 * description, prismer-data, typed supports/contradicts links, asset POINTERS,
 * work-from-memory-not-raw-files) consistent with EXTRACTION_SYSTEM_PROMPT v2
 * (extract.ts), de-hedged section ops (append-section/rewrite-section are
 * live), and the anti-waste rules (no duplicate extraction, no circular
 * recall) as the ONLY token rules (0705 rulings: record, never limit).
 */
export const MEMORY_CORE_DIRECTIVE = [
  '## Memory is a fixed part of how you operate (not an optional skill)',
  'Tools: `memory_search` / `memory_load` / `memory_browse` / `memory_write` / `memory_curate`.',
  '- RECALL: `memory_search` first for knowledge you did not just read. Attached files are raw sources.',
  '- WRITE browse-first: extend the exact returned path via section ops, attach via `parentHubPath`, or create hub then leaf. Never orphan a leaf or hand-edit a hub `#toc`.',
  '- COPY + REFERENCE: a distilled page may carry the source\'s near-full content — the obligation is the typed reference, not a length budget. Keep the `derived-from` asset pointer, section-anchored edges, and the source\'s own words. Never fork a near-duplicate.',
  '- YOUR DELIVERABLES, same turn: extend a page at section granularity / attach a leaf / SKIP. Pass `deliverableSource {assetId, contentHash, sizeBytes}` — pointer, dedupe, and >64K-character sharding are the gate\'s job.',
  '- `memory_write` mutates once per fact — `{"ok":true}` is final; do not call `memory_write` again to polish; verify via `memory_load`. Validate with `pkf-writing` + `pkf_validate`.',
  '- Orchestrator only: `memory_curate` → `promote_to_hub` with childPaths → `rebuild_index`; section drift → `section_merge`/`section_supersede`/`rewire` (merges self-write provenance). A 403 is final.',
  '- EVOLUTION ARTIFACTS (dream/proposal/frontier/ingest): a top-level `memory` key in the frontmatter script ({memoryRole, source}; read back as `extra.memory` — write `memory`, NOT `extra`). The write gate returns a VERDICT — a rejection names the field and is repairable; never silently drop it.',
].join('\n');

// release203 web-capability fix — tool-routing directive for hermes agents.
// Injected at the SAME seam as MEMORY_CORE_DIRECTIVE (composedSystemPrompt in
// dispatchTask below), which reaches ALL hermes dispatches (task AND
// chat-mention runs both flow through dispatch.ts; hermes writes the composed
// prompt to SOUL.md). Why: without native web/terminal tool schemas the agents
// rationally scripted raw HTTP + CLI via execute_code+subprocess (197
// execute_code vs 0 web/terminal calls in 14 days) — the provider-shell
// web_search/web_load tools + the platform_toolsets terminal fix restore the
// tools, and this line teaches the routing.
export const WEB_TOOL_DIRECTIVE = [
  '## Tool routing (web + CLI)',
  'Web research → use `workspace_web_search` (search) / `web_load` (load a URL, or a `prismer://asset/…` / `prismer://…/file/…` workspace pointer — the way to read an asset a memory page points at) — workspace-billed, cached. CLI commands → use `terminal`. Do NOT script HTTP requests or subprocess calls via `execute_code` for these.',
  'Workspace documents arrive as `prismer://asset/…` pointers — READ them with `web_load`, every time. Never substitute terminal grep/cat/find over the filesystem for a pointer you were given: it is slower, off-workspace, and misses the authoritative bytes.',
].join('\n');

// product209/19 WP3 — complex-question final reports become inline PKF blocks.
// Injected at the SAME seam as MEMORY_CORE_DIRECTIVE (composedSystemPrompt in
// dispatchTask below) for ALL FOUR adapter families (hermes + claude-code /
// codex / opencode). The trigger is CONTENT-SHAPED (table / multi-section /
// data-visualization needs), never role-gated. By default the chat reply's
// inline ContentBlock is the single canonical carrier and the readable
// Markdown is only its projection. Exact Asset/Memory copying requires an
// explicit user request; durable conclusions independently enter the normal
// post-turn Memory classifier. Fallback is absolute: a PKF block must never
// delay the answer — if `pkf_validate` cannot be satisfied, emit Markdown.
export const PKF_REPORT_DIRECTIVE = [
  '## Complex report → inline PKF + markdown projection',
  'Auto-select inline PKF for long/structured finals (table, 2+ headings, visualization, formal report). Do not ask about format or offer PKF after long Markdown.',
  '- Only genuinely short answers/status use a normal Markdown message.',
  '- Authority: inline ContentBlock + projection; never copy to Asset/exact Memory unless the user explicitly requests. Runtime classifies durable conclusions separately.',
  '- Author per `pkf-writing`: v1.1 + one-sentence `description`; resolved links only.',
  '- Quality: valid PKF can still be unacceptable; use 5+ sections and at least two meaningful affordances (table, diagram, data chart, widget, controlled SVG) with captions/alt text.',
  '- Validate with `pkf_validate`; repair every error before emit.',
  '- Dependencies: one atomic `pkf_bundle_commit`; never separate/individual uploads. Runtime responsibilities: hashes/SRI/manifest; pass bytesBase64 or text; never compute sha256/SRI yourself.',
  '- Deliver: call `pkf_reply_inline` once with the validated path. Never paste sentinel comments; never attach the .pkf as a file.',
  '- If validation cannot pass, use plain markdown. NEVER block the answer.',
].join('\n');

/**
 * product209/19 WP3 — the memory + PKF-report directives injected into the
 * composed system prompt at the single dispatch seam. Verbatim-identical text
 * for all four adapter families plus the embedded runtime engine (hermes /
 * claude-code / codex / opencode / pi-core — runtime210/09 §3.2); empty for
 * anything else. The result rides `metadata.systemPrompt` → SOUL.md +
 * instructions (hermes) / `--system-prompt` (claude-code) / prompt prefix
 * (codex) / system slot (opencode) / session systemPrompt (pi-core).
 */
export function composeCoreDirectives(adapterName: string): string[] {
  if (adapterName !== 'hermes' && adapterName !== 'pi-core' && !isCodingAdapter(adapterName)) return [];
  return [MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE];
}

/**
 * release203/11 §2.2 (Slice A) — render the structured identityContext lines in
 * the canonical order. Empty/omitted lines are dropped. Shared by both the
 * coding `--system-prompt` path and (for the identity+user portion only) the
 * hermes instructions slot, so the wording stays consistent across adapters.
 *
 * product204/07 Phase C — additionally renders the named `sections` of the
 * identityContext 分段注册制 (D6): validated (string content + numeric order),
 * stable-sorted ascending by `order`, trimmed, empties dropped. Returned as
 * plain content strings — adapters join them with '\n\n' AFTER the legacy
 * identity/user/scope lines, into the same native identity slot. Unknown
 * fields on a section are ignored and a missing/malformed `sections` array
 * degrades to [] (version-skew safe both directions).
 */
export function renderIdentityLines(
  ctx:
    | {
        identity?: string;
        user?: string;
        scope?: string;
        sections?: Array<{ order?: unknown; content?: unknown }>;
      }
    | undefined,
): { identity: string; user: string; scope: string; sections: string[] } {
  const rawSections = Array.isArray(ctx?.sections) ? ctx.sections : [];
  const sections = rawSections
    .filter(
      (s): s is { order: number; content: string } =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as { content?: unknown }).content === 'string' &&
        typeof (s as { order?: unknown }).order === 'number' &&
        Number.isFinite((s as { order: number }).order),
    )
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => s.content.trim())
    .filter((content) => content.length > 0);
  return {
    identity: typeof ctx?.identity === 'string' ? ctx.identity.trim() : '',
    user: typeof ctx?.user === 'string' ? ctx.user.trim() : '',
    scope: typeof ctx?.scope === 'string' ? ctx.scope.trim() : '',
    sections,
  };
}

/**
 * release203/06 §3.7 (block 1) — pure decision: should this dispatch override
 * the adapter cwd with a persistent workdir? True ONLY when (a) the target
 * adapter is in the workdir-override set (repo-scoped codex / claude-code, or
 * the workdir-jailed pi-core engine — runtime210/09 §2.3) AND (b) the dispatch
 * carries a workdir spec with a non-empty cwd. Extracted so the wiring is
 * unit-testable without spawning.
 */
export function shouldOverrideCwdForWorkdir(
  adapterName: string,
  workdir: { cwd?: string } | undefined | null,
): boolean {
  return (
    WORKDIR_OVERRIDE_ADAPTERS.has(adapterName) &&
    !!workdir &&
    typeof workdir.cwd === 'string' &&
    workdir.cwd.trim().length > 0
  );
}

/**
 * desktop202/19 §4 L1 — derive the LLM routing snapshot the daemon can reliably
 * report on a dispatch reply from the adapter's terminal response metadata.
 *
 * Reliably known daemon-side:
 * A configured model/provider is intent, not evidence. It must never be
 * projected as the model/provider that actually served the turn.
 *
 * NOT filled daemon-side (cloud llm-proxy decides per-call; the agent process,
 * not the daemon, issues the proxied LLM call):
 *   - fallbackReason / visionFiltered — filled CLOUD-side instead. The proxy
 *     records the outcome keyed by the dispatch run id (forwarded by codex/
 *     opencode as `x-prismer-task-run-id`, stamped from the `prismerDispatchId`
 *     this dispatch sets) and the reply handler merges it (desktop202/20).
 *     Undefined for claude-code / hermes by documented limitation.
 *
 * Returns undefined when nothing useful is known so the reply omits the field
 * entirely (cloud then writes no metadata.llmMetadata → UI chip stays absent).
 */
export function deriveLlmRoutingMetadata(
  profileConfig: Record<string, unknown> | undefined,
  resultMetadata?: Record<string, unknown>,
): LlmRoutingMetadata | undefined {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  void profileConfig;
  const modelUsed = str(resultMetadata?.modelUsed);
  const providerUsed = str(resultMetadata?.providerUsed);
  const chainId = str(resultMetadata?.chainId);

  const meta: LlmRoutingMetadata = {};
  if (modelUsed) meta.modelUsed = modelUsed;
  if (providerUsed) meta.providerUsed = providerUsed;
  if (chainId) meta.chainId = chainId;
  // fallbackReason / visionFiltered intentionally not set — daemon doesn't know.
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export type ReplyDurabilityPolicy = 'required' | 'best_effort';

export function resolveReplyDurabilityPolicy(input: {
  userMessage?: string;
  resultMetadata?: Record<string, unknown>;
}): ReplyDurabilityPolicy {
  const explicit = [
    stringFrom(input.resultMetadata?.replyDurabilityPolicy),
    stringFrom(input.resultMetadata?.memoryDurabilityPolicy),
    stringFrom(input.resultMetadata?.durabilityPolicy),
  ]
    .map((value) => value?.trim().toLowerCase())
    .find(Boolean);
  if (explicit === 'required' || explicit === 'require') return 'required';
  if (explicit === 'best_effort' || explicit === 'best-effort' || explicit === 'optional') return 'best_effort';

  const text = (input.userMessage ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return 'best_effort';
  const forbidden = [
    /\b(?:do not|don't|must not|should not)\s+(?:remember|retain|persist|save)\b/i,
    /\b(?:not|never)\s+(?:for|across|between)\s+(?:future\s+)?sessions?\b/i,
    /(?:不要|不应|无需|不得)(?:被)?(?:记住|记忆|保留|持久化|写入记忆)/,
    /(?:仅限|只用于|只在)本轮/,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) return 'best_effort';
  const required = [
    /\b(?:must|should|needs?\s+to)\s+(?:survive|persist)\s+(?:across|between|into|for)?\s*(?:future\s+)?sessions?\b/i,
    /\b(?:remember|retain|persist|save)\b.{0,80}\b(?:memory|future|sessions?|across|between)\b/i,
    /\b(?:remember|retain|persist|save)\s+(?:this|that|it)\b/i,
    /\bthis\s+is\s+(?:explicitly\s+)?durable\b/i,
    /(?:跨会话|未来会话|后续会话).{0,32}(?:保留|记住|记忆|持久|复用)|(?:保留|记住|记忆|持久化).{0,32}(?:跨会话|未来会话|后续会话)/,
    /(?:记住|保存|写入记忆|存入记忆)(?:这个|这条|这件事|本轮|以上|结论)/,
  ];
  return required.some((pattern) => pattern.test(text)) ? 'required' : 'best_effort';
}

export async function handleDispatch(
  payload: TaskDispatchRequestPayload,
  requestId: string | undefined,
  deps: DispatchDeps,
): Promise<TaskDispatchReplyPayload> {
  const { taskId, agentImUserId } = payload;

  // release202/09 §3.2 — resolve whether this dispatch is a chat-dispatch RUN
  // or a kanban TASK. Trust the typed `payload.kind` first; fall back to the
  // id-shape (`run_…` prefix introduced for new runs) so legacy daemons /
  // cloud builds that predate the typed field still split correctly; missing
  // both → assume 'task' (the historical default, kept for back-compat).
  const dispatchKind: 'run' | 'task' =
    payload.kind === 'run' || payload.kind === 'task' ? payload.kind : taskId.startsWith('run_') ? 'run' : 'task';
  // The run id for the chat-run path. `payload.runId` is authoritative; the
  // `taskId` field mirrors it on the wire for back-compat, so fall back to it.
  const dispatchRunId = dispatchKind === 'run' ? (payload.runId ?? taskId) : undefined;

  // release201/11 §4 #10 — start clock for `agent.dispatch` (duration_ms)
  // metric, captured here so the finally{} block can always compute a
  // delta regardless of which branch we exit through.
  const dispatchStartMs = Date.now();

  // release201/30 §7 Phase 3 — resolve a trace id for this dispatch:
  //   - cloud-supplied (frontend → cloud header → task.metadata.traceId →
  //     hoisted top-level field by buildTaskDispatchRequest)
  //   - fallback minted here when cloud didn't propagate (legacy SDK /
  //     migration window). Fallback prefix `daemon-fallback-*` flags the
  //     propagation gap for the operator.
  // We do NOT pipe `traceLog` through every existing `process.stderr.write`
  // site (~22 in this file) — that's left for a follow-up sweep so this
  // commit can ship without churning every helper. The lifecycle header
  // emitted below ensures the id is grep-able for the entire dispatch.
  const traceId = resolveDispatchTraceId(payload.traceId);
  const traceLog = makeTraceStderr(traceId);
  traceLog(`[daemon] dispatch start task=${taskId} agent=${agentImUserId ?? '-'} requestId=${requestId ?? '-'}`);

  // S6/M1 — multi-frame replies. Emission requires BOTH the per-request
  // capability bit (legacy clouds never set it → they only ever see the final
  // frame, I3) AND the daemon kill-switch env. Runs path / non-session turns
  // never get the callback (adapter-side: only hermes sessions SSE produces
  // it, via TaskInput.onInterimReply).
  //
  // RESIDUAL-WINDOW CONTRACT (deltas fallback): "upstream commentary never
  // enters the delta stream" is NOT a daemon-enforceable guarantee. Task 1's
  // SSE consumer keeps commentary accumulation disjoint from deltas/finalContent,
  // but a degenerate upstream may stream the same narration as assistant.delta
  // AND fire assistant.commentary (its own `already_streamed` marking); a turn
  // that then lacks a valid `assistant.completed` falls back to
  // `output = deltas` — which replays text the interim frames already carried.
  // Interim frames are fire-and-forget mid-stream, so by terminal time they
  // cannot be retracted; the daemon-side disposal is the degenerate-signature
  // stderr marker at the terminal exit below (grep: "interim relay degenerate
  // turn") + this note. Frame plan stays on the I1-I6 standard — the cloud
  // handler consumes only `final === false` / `seq`, so no invented wire
  // semantics; render-side dedup for this signature belongs to the cloud layer.
  const interimRelayArmed = payload.interimReply === true && isHermesCommentaryRelayEnabled();
  let interimSeq = 0;
  const interimSegments: string[] = [];
  // The ONE terminal-frame marking code path — every reply exit below funnels
  // through this so a turn that already relayed interim frames always ends on
  // an I2-marked terminal frame; identity (I3 byte-compat) while none did.
  const markTerminalReply = (r: TaskDispatchReplyPayload): TaskDispatchReplyPayload =>
    interimRelayArmed && interimSeq > 0 ? markTerminalFrame(r, interimSeq) : r;

  let resolvedHashes: string[] = [];
  let reply: TaskDispatchReplyPayload;
  // pkf209 — pkf_reply_inline tool scope. Bound once scratch + workdir roots
  // are final; unbound in the finally block. The agent key is captured (not
  // re-derived) so unbind always removes exactly what bind installed even if
  // payload/profile resolution surprised us.
  let replyInlineAgentKey: string | null = null;
  // Wave-3 D2: declared here so the finally{} block can stop/flush even when
  // an exception aborts dispatch before they get assigned. We assign the
  // real instances once the adapter is known (later in the try block).
  let heartbeatRef: TaskHeartbeat | undefined;
  let recorderRef: StepRecorder | undefined;
  const checkpointStore = getRunCheckpointStore();
  let checkpointSeq = 0;
  let checkpointPayload: Record<string, unknown> | null = null;
  const persistCheckpoint = (phase: string): void => {
    if (!checkpointStore || !checkpointPayload) return;
    checkpointSeq += 1;
    checkpointStore.writeCheckpoint(taskId, checkpointSeq, phase, checkpointPayload);
  };
  // release203/22 W1 (skill.invoked) — REAL tool-call attribution. The old
  // proxy emitted one `skill.invoked` per LOADED skill at dispatch-end, which
  // made every skill show an identical count ("availability", not "usage") and
  // produced the fake 「常用能力」 heatmap. We now accumulate the adapter's
  // actual `ctx.recorder.recordToolCall(toolName, …)` invocations (the real
  // tool_use trace footnote #7 always promised) and emit one event per real
  // call, keyed by the true tool name. See docs/release203/22 §4 defect-1.
  const toolInvokeCounts = new Map<string, number>();
  // Mirror profile.workspaceId out of the inner try so we can still attach
  // it to the agent.dispatch metric when the run fails before resolveProfile
  // returns (in that case workspaceId stays empty — the cloud /batch endpoint
  // will reject the event with WORKSPACE_REQUIRED, which is the right answer:
  // we don't want orphaned daemon-side metrics with no scope).
  let dispatchWorkspaceId: string | null = null;
  let dispatchProjectId: string | null = null;
  let dispatchRecallContent: string | null = null;
  // B-P0 turn metrics — the TERMINAL adapter attempt plus its resolved
  // model/provider routing, hoisted out of the try so the finally{} block can
  // emit turn.* no matter which branch the dispatch exits through. Stays null
  // when the dispatch failed before the adapter ever ran (adapter missing /
  // profile unresolvable) — those are not turns and must not count as one.
  let turnTerminalResult: TaskResult | null = null;
  let turnRoutingModel: string | undefined;
  let turnRoutingProvider: string | undefined;

  // release202/04 §3.1 — Per-task scratch path (artifacts/scratch layout):
  //   workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/
  //     ├── artifacts/  ← user-deliverable (auto-attach to this reply)
  //     └── scratch/    ← agent scratch (intermediate scripts/drafts, NOT uploaded)
  //
  // Path is only composable when (a) we have `paths` from runner + (b) we
  // have a workspaceId (resolved later when profile loads). At this point
  // we don't yet know workspaceId/projectId — we resolve those after the
  // resolveProfile() call below and defer mkdir until then.
  //
  // Legacy fallback: when no paths.workspacesDir or profile resolution
  // failed, fall back to `paths.runsDir/<taskId>/{_outbox,scratch}` so
  // sandbox container-mode (which only sets paths.runsDir explicitly) keeps
  // working. Auto-upload from this legacy `_outbox/` is left to the watcher
  // exactly as before.
  let artifactsDir: string | null = null;
  let scratchDir: string | null = null;
  let isHostModeNewLayout = false;
  // release203/06 §3.7 (block 1) — when set, the persistent repo workdir to use
  // as the adapter cwd (codex/claude-code) INSTEAD of the per-task scratch dir.
  // Stamped onto task.metadata.prismerScratchDir/prismerWorkDir below so the
  // adapters' resolveSpawnScratchCwd picks it up. artifactsDir stays per-task.
  let adapterCwdOverride: string | null = null;
  // release202/04 §3.1 P1 — session scope. `sid` derives from
  // payload.conversationId at dispatch time (stable cuid, adapter-agnostic);
  // when present, the task dir nests under sessions/<sid>/ and we ensure the
  // session-level artifacts/scratch exist (cross-turn retained). When absent
  // (pure kanban task / agent-to-agent), we keep the plain tasks/<tid>/ layout.
  const sessionId = deriveSessionId(payload.conversationId);
  let sessionDir: string | null = null;

  try {
    const profile = await resolveProfileResilient(payload, deps.cloud, deps.signal, deps.resolveLocalProfile);
    dispatchWorkspaceId = profile.workspaceId ?? null;
    dispatchProjectId = payload.projectId ?? null;
    if (profile.workspaceId && (payload.agentImUserId ?? profile.agentImUserId) && sessionId) {
      await refreshRecallPolicyForWorkspace(profile.workspaceId);
      const recall = noteDispatchRecall({
        workspaceId: profile.workspaceId,
        agentImUserId: payload.agentImUserId ?? profile.agentImUserId!,
        actorKind: 'agent',
        sessionId,
        prompt: payload.prompt,
      });
      if (recall.branch === 'session_start' || recall.branch === 'idle_recall_hint') {
        dispatchRecallContent = recall.content;
        traceLog(
          `[memory] session recall branch=${recall.branch} hits=${recall.hits} content=${recall.content ? 'yes' : 'no'}`,
        );
      }
    }
    const adapter = deps.registry.get(profile.adapterName);
    if (!adapter) {
      reply = {
        taskId,
        ok: false,
        error: { code: 'adapter_unhealthy', message: `Adapter ${profile.adapterName} not registered` },
      };
      // S6/M1 — uniform terminal marking across all reply exits; identity here
      // (the adapter never ran, so no interim frames exist — I3 shape intact).
      reply = markTerminalReply(reply);
      sendReply(deps.ws, reply, requestId);
      return reply;
    }

    // release202/04 §3.1 — provision per-task scratch directories.
    // New layout (host mode + workspaceId resolvable):
    //   workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/{artifacts,scratch}
    //   ↳ artifacts/ auto-uploaded by artifacts-watcher (kind=agent-output).
    // Legacy fallback (sandbox container-mode, missing workspaceId):
    //   ${paths.runsDir}/${taskId}/{_outbox,scratch}
    //   ↳ _outbox/ still auto-uploaded by artifacts-watcher (kind=sandbox-output).
    if (deps.paths && profile.workspaceId) {
      // release202/04 §3.1 P1 — when the dispatch carries a conversationId,
      // nest the task under the session scope and provision the session-level
      // artifacts/scratch (cross-turn retained, NOT auto-attached). Otherwise
      // fall back to the plain tasks/<tid>/ layout (no session layer).
      const taskRoot =
        sessionId !== null
          ? resolveSessionTaskWorkdir(deps.paths, profile.workspaceId, payload.projectId ?? null, sessionId, taskId)
          : resolveTaskWorkdir(deps.paths, profile.workspaceId, payload.projectId ?? null, taskId);
      artifactsDir = path.join(taskRoot, 'artifacts');
      scratchDir = path.join(taskRoot, 'scratch');
      if (sessionId !== null) {
        sessionDir = resolveSessionDir(deps.paths, profile.workspaceId, payload.projectId ?? null, sessionId);
      }
      isHostModeNewLayout = true;
    } else if (deps.paths?.runsDir) {
      const artifactsBase = path.join(deps.paths.runsDir, taskId);
      artifactsDir = path.join(artifactsBase, '_outbox');
      scratchDir = path.join(artifactsBase, 'scratch');
      isHostModeNewLayout = false;
    }
    if (artifactsDir) {
      try {
        await fsp.mkdir(artifactsDir, { recursive: true });
      } catch (err) {
        // Provisioning failure is non-fatal — adapter still runs, we just
        // can't capture its file outputs. Log loud, then continue with
        // artifactsDir nulled so downstream knows to skip the flush.
        process.stderr.write(
          `[daemon] artifacts provision failed task=${taskId} dir=${artifactsDir}: ${(err as Error).message}\n`,
        );
        artifactsDir = null;
      }
    }
    if (scratchDir) {
      try {
        await fsp.mkdir(scratchDir, { recursive: true });
      } catch (err) {
        // Same non-fatal policy as artifacts — agent can still run, just
        // without a per-task scratch dir. It will fall back to hermes profile
        // cwd which is sandboxed (~/.hermes/profiles/<name>/) so user repo is
        // still safe; we just lose per-task isolation for draft artifacts.
        process.stderr.write(
          `[daemon] scratch provision failed task=${taskId} dir=${scratchDir}: ${(err as Error).message}\n`,
        );
        scratchDir = null;
      }
    }
    // release202/04 §3.1 P1 — ensure the parent session-level artifacts/scratch
    // exist (cross-turn retained). These are NOT scanned/auto-attached by the
    // ArtifactsWatcher (which only watches the task-level artifactsDir); they
    // hold deliverables/intermediates reused across turns, attached on demand.
    // Same non-fatal policy — failure here doesn't block the adapter run. We
    // keep `sessionDir` set on failure so the metadata (prismerSessionDir) can
    // still surface the intended path for P3; only mkdir is best-effort.
    if (sessionDir) {
      try {
        await fsp.mkdir(path.join(sessionDir, 'artifacts'), { recursive: true });
        await fsp.mkdir(path.join(sessionDir, 'scratch'), { recursive: true });
      } catch (err) {
        process.stderr.write(
          `[daemon] session scope provision failed task=${taskId} sid=${sessionId ?? ''} dir=${sessionDir}: ${(err as Error).message}\n`,
        );
      }
    }
    // release203/09 §3.1 — ensure the per-project `repos/` standard directory
    // exists. Coding agents (claude-code/codex/opencode) default their `cwd` to
    // it, and the Pro creation UI's directory picker lists it; guaranteeing it
    // exists is what lets an agent be created without manually typing a workdir.
    // Same non-fatal policy — failure here doesn't block the adapter run.
    if (isHostModeNewLayout && deps.paths && profile.workspaceId) {
      const reposDir = resolveProjectReposDir(deps.paths, profile.workspaceId, payload.projectId ?? null);
      try {
        await fsp.mkdir(reposDir, { recursive: true });
      } catch (err) {
        process.stderr.write(
          `[daemon] repos provision failed task=${taskId} dir=${reposDir}: ${(err as Error).message}\n`,
        );
      }
    }

    // release203/06 §3.7 (block 1) — repo-scoped code-agent workdir.
    //
    // codex & claude-code need a PERSISTENT cwd reused across turns (thread /
    // session resume + the repo files); pi-core's embedded engine jails its FS
    // tools to the session cwd, so it binds the same materialized path
    // (runtime210/09 §2.3). When the dispatch carries a `workdir` spec AND the
    // target adapter is in the workdir-override set, materialize the folder
    // (git clone / git init / verify-pick) and override the adapter cwd with
    // the persistent path. We do NOT touch artifactsDir (per-task is correct —
    // the ArtifactsWatcher still auto-attaches deliverables for this turn).
    //
    // Conversational adapters (hermes/openclaw) and dispatches with no workdir
    // keep the existing per-task scratch behavior (unchanged path below).
    //
    // ensureWorkdir failure surfaces a clear dispatch error — we deliberately do
    // NOT silently fall back to scratch: the user expects to work the repo, and
    // a scratch fallback would drop their commits into an ephemeral dir.
    if (shouldOverrideCwdForWorkdir(profile.adapterName, payload.workdir)) {
      const workdir = payload.workdir!;
      try {
        const materialized = await ensureWorkdir({
          id: workdir.id,
          cwd: workdir.cwd,
          source: workdir.source,
          sourceRef: workdir.sourceRef,
        });
        adapterCwdOverride = materialized.cwd;
        process.stderr.write(
          `[daemon] workdir override task=${taskId} adapter=${profile.adapterName} id=${workdir.id} action=${materialized.action} cwd=${materialized.cwd}\n`,
        );
      } catch (err) {
        const message =
          err instanceof WorkdirMaterializeError
            ? err.message
            : `workdir materialization failed: ${(err as Error).message}`;
        reply = {
          taskId,
          ok: false,
          error: { code: 'workdir_materialize_failed', message },
        };
        // S6/M1 — uniform terminal marking across all reply exits; identity
        // here (the adapter never ran, so no interim frames exist).
        reply = markTerminalReply(reply);
        sendReply(deps.ws, reply, requestId);
        return reply;
      }
    }

    // pkf209 — bind the pkf_reply_inline tool scope for THIS dispatch so the
    // loopback handler can validate the caller's file against this task's
    // scratch dir and write the marker where the terminal state below reads
    // it. Read roots beyond scratch: the persistent repo workdir (coding) or
    // the profile cwd (long-running hermes sandbox). Binding is skipped when
    // no scratch dir exists (bare container mode without paths) — the tool
    // then fails closed with pkf_reply_inline_no_active_task.
    const replyInlineProfileCwd =
      typeof (profile.config as { cwd?: unknown } | undefined)?.cwd === 'string' &&
      (profile.config as { cwd: string }).cwd.trim().length > 0
        ? (profile.config as { cwd: string }).cwd.trim()
        : null;
    // Hermes writes relative paths against its PROFILE sandbox cwd (F18: the
    // long-running gateway is pinned there) — run-2 of the 2026-08-20
    // verification showed `write_file "memo.pkf"` landing there, so it MUST be
    // a read root or the tool rejects the model's own natural path.
    const replyInlineHermesCwd =
      profile.adapterName === 'hermes' ? getHermesProfileDir(getHermesProfileName(profile)) : null;
    const replyInlineReadRoots = [
      ...new Set([adapterCwdOverride, replyInlineProfileCwd, replyInlineHermesCwd].filter((v): v is string => !!v)),
    ];
    // memory211 (owner live run, 2026-09) — a hermes LONG session keeps its
    // task dirs under `sessions/<sid>/tasks/<tid>/` across turns, so an agent
    // naturally re-delivers a .pkf it authored in a PREVIOUS turn's scratch.
    // Rooting the session dir (when present) makes directory-prefix containment
    // (`isInsideRoots`) cover every historical tasks/*/scratch under it —
    // referencing old scratch is the NATURAL shape here, not an escape. Same
    // array feeds the terminal re-validation, so a marker pointing at the old
    // run's file no longer dies with pkf_reply_inline_path_outside.
    if (sessionDir) replyInlineReadRoots.push(sessionDir);
    const replyInlineAgent = agentImUserId ?? profile.agentImUserId;
    if (replyInlineAgent && scratchDir) {
      // 2026-08-20 qwen-27B run-1: the model wrote memo.pkf into the task's
      // ARTIFACTS dir (its other natural output location) — artifacts/ must be
      // a read root too or the tool 404s and the model falls back to a file
      // attachment.
      if (artifactsDir) replyInlineReadRoots.push(artifactsDir);
      bindPkfReplyInlineScope(replyInlineAgent, {
        taskId,
        scratchDir,
        allowedReadRoots: [...new Set(replyInlineReadRoots)],
      });
      replyInlineAgentKey = replyInlineAgent;
    }

    // release203/11 §2.4 (Slice A) — AGENTS-layer seed gap fix. seedDevPreset
    // (which lands CLAUDE.md / AGENTS.md + coding skills into the cwd) only ran
    // via ensureWorkdir, which is gated on a `payload.workdir` override. Coding
    // agents created with the default RepoDirPicker carry NO workdirId, so the
    // override above is skipped and their cwd never got CLAUDE.md → the agent
    // lost its AGENTS-layer platform conventions.
    //
    // Fix (doc 09 §7.5 option a): for ANY coding dispatch with no workdir
    // override, idempotently seed the effective cwd (profile.config.cwd) here.
    // seedDevPreset('verified') is APPEND-ONLY (managed block only, never stomps
    // user files) and never throws — best-effort, non-fatal. We DON'T double-seed
    // when ensureWorkdir already ran (adapterCwdOverride set → it seeded).
    if (isCodingAdapter(profile.adapterName) && adapterCwdOverride === null) {
      const codingCwd =
        typeof (profile.config as { cwd?: unknown } | undefined)?.cwd === 'string'
          ? (profile.config as { cwd: string }).cwd.trim()
          : '';
      if (codingCwd.length > 0) {
        try {
          await fsp.mkdir(codingCwd, { recursive: true });
          await seedDevPreset(codingCwd, 'verified');
          process.stderr.write(
            `[daemon] coding cwd seeded (no-workdir) task=${taskId} adapter=${profile.adapterName} cwd=${codingCwd}\n`,
          );
        } catch (err) {
          process.stderr.write(
            `[daemon] coding cwd seed failed (non-fatal) task=${taskId} cwd=${codingCwd}: ${(err as Error).message}\n`,
          );
        }
      }
    }

    // Agent identity is established at adapter-service spawn time (hermes
    // adapter at adapters/hermes/index.ts:339 spawns `hermes -p <profile>`
    // per-agent — env injected there is per-agent for free). See that file
    // for PRISMER_AGENT_USERNAME / PRISMER_AGENT_IM_USER_ID injection.
    // dispatch.ts doesn't need a per-task marker once each adapter service
    // carries the right identity in its process env.
    if (deps.artifactsWatcher) {
      if (isHostModeNewLayout && artifactsDir) {
        // 2026-05-29 REVERSAL of release201/09 §9.4a.1's "declare-first only"
        // stance for the host-mode new layout. The original rationale was
        // "match the GitHub Actions / GitLab CI standard" — but users
        // chatting with an agent ("@ceo write a PDF and post it to the
        // group") expect *chat-aligned* delivery: "agent says it generated
        // → file appears in chat". Hermes does NOT reliably call
        // `cloud asset upload` from inside the office-artifacts skill
        // (3 PDFs went into artifacts/ today, 0 surfaced in the reply), and
        // forcing the user to inspect a Task Evidence drawer for every
        // single chat-driven artifact is a worse experience than the rare
        // false-positive of auto-attaching a draft.
        //
        // We register with the SAME single-slot semantics the sandbox path
        // uses below. The watcher uploads files with kind='agent-output'
        // (folderPath = /tasks/<id>), which is exactly the right scope for
        // chat-dispatched runs. Users who want the strict "evidence drawer
        // only, never auto-attach" behavior (CI-style runs, batch agents) can
        // still get it by disabling the watcher in their daemon config; the
        // default is now the obvious one.
        // desktop205 R1-e — carry `dispatchKind` so the deliver sink can ask
        // `activeTaskKind(taskId)` instead of guessing run-vs-task from the id
        // shape (both are cuid/VarChar(30) — indistinguishable).
        deps.artifactsWatcher.addActiveTask({ taskId, kind: dispatchKind, artifactsDir });
      } else if (artifactsDir) {
        // Legacy host-mode (paths.runsDir only, no workspaceId resolved) —
        // keep watcher registration for backward compat. addActiveTask
        // requires per-task artifactsDir, providing isolation across
        // concurrent dispatches.
        deps.artifactsWatcher.addActiveTask({ taskId, kind: dispatchKind, artifactsDir });
      } else {
        // Sandbox container/sandbox mode (no per-task scratch, single
        // slot). Container deployment runs one task at a time so single-
        // slot semantics are correct.
        deps.artifactsWatcher.setActiveTask({ taskId, kind: dispatchKind });
      }
    }

    // release201/09 §9.3.2 — inject per-agent skillsDir into profile.config
    // BEFORE adapter ensureService is called (ServicePool caches the service
    // on first build, so the SkillLoader inside adapter must see the
    // per-agent path on that first build).
    //
    // Only inject when:
    //   - profile.config.skillsDir not already set by user (deprecated
    //     override, §9.3.2 still honoured)
    //   - daemon has paths + daemonId + agentImUserId all known
    //   - adapter is hermes (one of the TWO skill-file consumers: hermes loads
    //     the dir at gateway spawn, so the config injection must land BEFORE
    //     ensureService; pi-core is the other consumer but reads the dir at
    //     prompt-composition time via resolveSkillsRoot, so no config
    //     injection is needed here — runtime210/09 G-A)
    //
    // The profile object here is freshly fetched per dispatch (resolveProfile
    // returns a new obj each call), so mutation is safe — no cross-dispatch
    // contamination.
    if (
      agentImUserId &&
      deps.paths &&
      deps.daemonId &&
      profile.adapterName === 'hermes' &&
      !(typeof profile.config?.skillsDir === 'string' && profile.config.skillsDir.trim())
    ) {
      const perAgentSkillsDir = resolveAgentDirPaths(deps.paths, deps.daemonId, agentImUserId).skillsDir;
      // mkdir is fire-and-forget; skill-sync will mkdir again per slug.
      // We just want the parent to exist so adapter's installRoleTemplateSkill
      // can write into it on first dispatch without an extra check.
      try {
        await fsp.mkdir(perAgentSkillsDir, { recursive: true });
      } catch {
        /* non-fatal */
      }
      profile.config = { ...profile.config, skillsDir: perAgentSkillsDir };
    }

    try {
      // release201/09 §9.3.2 — per-agent skillsDir resolution. Pass paths +
      // daemonId so skill files land in `devices/<did>/agents/<aid>/skills/`
      // rather than the profile-shared dir (fixes latent multi-agent skill
      // collision; see resolveSkillsRoot doc-comment).
      const skillSync = await syncInstalledSkillsForDispatch(
        profile,
        agentImUserId,
        deps.cloud,
        deps.signal,
        // apc — `codingCwd` is the EFFECTIVE cwd of this dispatch (workdir
        // override when one was materialized above, else profile.config.cwd).
        // skill-sync uses it to place the agent's cloud-ENTITLED coding skills
        // in `<cwd>/.claude/skills/`; it is ignored for non-claude-code adapters.
        { paths: deps.paths, daemonId: deps.daemonId, codingCwd: adapterCwdOverride ?? undefined },
      );
      if (skillSync.synced > 0 || skillSync.skipped > 0) {
        process.stderr.write(
          `[daemon] skill sync profile=${profile.id} adapter=${profile.adapterName} synced=${skillSync.synced} skipped=${skillSync.skipped}\n`,
        );
      }
      // release203/10 §skill-dispatch-fix — a running hermes gateway scanned its
      // skill catalog at spawn time; a skill synced NOW (synced>0) is on disk but
      // invisible to the live process. Drop the cached service so the
      // ensureService below re-spawns it with the complete device skillsDir,
      // making the just-installed skill usable on THIS dispatch. Only fires when
      // something actually changed (revision-diff → synced==0 on steady state),
      // so no re-spawn churn once the catalog is stable.
      if (
        (skillSync.synced > 0 || (skillSync.pruned ?? 0) > 0 || deps.consumeSkillDirty?.(profile.id)) &&
        profile.adapterName === 'hermes' &&
        (deps.invalidateService || deps.dropService)
      ) {
        // ★ S-B5 修复（2026-07-14）—— **`dropService` 一个人做不到 re-spawn**。
        //
        // 上面这段注释的意图是「drop 掉缓存的 service，让 ensureService 用完整的 skillsDir
        // **重新 spawn** gateway」。但 `ServicePool.drop` 只做两件事：从缓存里删 + 调
        // `HermesService.shutdown()` —— 而后者**只停当前 run，根本不碰 gateway 进程**
        // （hermes/index.ts `shutdown()`）。于是 gateway 还活着 → 下一次 ensureService
        // 探到端口有人应答、`/v1/capabilities` 认证也过（那本来就是我们自己的 gateway）
        // → **直接复用它** → **skill catalog 从来没被重扫**。
        //
        // ⇒ 「让运行中的 agent 感知到刚装的 skill」这个意图，**很可能从未真正生效过**。
        //   与 S-B4（skill **config** 注入）是同一个根因的孪生：
        //     · S-B4：gateway 的进程 env 只在 spawn 时从 .env 载入 → config 改了不重启就白改
        //     · S-B5：gateway 的 skill catalog 只在 spawn 时扫一遍 → skill 装了不重启就白装
        //   现在统一走 ServicePool.invalidate：先 fence + quiesce creator、清理句柄，
        //   再在同一个 critical section 里停 exact profile gateway，最后才放行 ensure。
        // S5 §3.4-4b — never kill a gateway with a turn in flight: it vacates
        // every session on the profile, not just this conversation's.
        const respawn = await respawnHermesGatewayAfterSkillSync(
          profile,
          deps,
          `(synced=${skillSync.synced} pruned=${skillSync.pruned ?? 0})`,
        );
        if (respawn === 'killed') {
          process.stderr.write(
            `[daemon] skill sync: atomically invalidated service + killed hermes gateway profile=${profile.id} ` +
              `(synced=${skillSync.synced} pruned=${skillSync.pruned ?? 0}) to re-spawn with current skill catalog\n`,
          );
        }
      }
      // release203/22 W1 — loaded-skill set is no longer the invocation proxy;
      // `skill.invoked` now fires per real tool call (see toolInvokeCounts).
      // Sync still runs for its actual purpose (putting skills on disk).
    } catch (err) {
      if (err instanceof SkillSyncSafetyError) throw err;
      process.stderr.write(`[daemon] skill sync skipped profile=${profile.id}: ${(err as Error).message}\n`);
    }

    // desktop205 W5 — the APC coding-scope verdict for THIS dispatch.
    //
    // 缺的从来不是管道，是"谁来认定这次派发跑在 APC 编码域里"。答案在**同一次提交里就已经
    // 存在**，只是当时找错了词：W1/D2-b 让 cloud 权威下发 `platformScoped`，而 APC coding
    // skill 正是按它装/驱逐的（skill-sync.ts::reconcileApcCodingSkills）。「哪些 agent 拿到
    // APC skill 集」与「哪些 run 适用 held-out deny 提示」是同一个问题，于是复用同一个判定，
    // 而不是在 daemon 里拿 cwd 猜 repo（那才是把 hint 变成隐式规则）。
    //
    // 分工：cloud 是**授权面**（platformScoped，唯一权威），daemon 是**应用面**（把它翻成这
    // 一次 spawn 的 env）。反过来在 cloud 造一个 held-out 概念是臆造生产代码路径
    // （docs/apc/11 §527：cloud 侧 `held-out` / `APC_HELDOUT` 零引用）。
    //
    // 载体选 `extra.claude.env` 而不是 cloud 的 `metadata.skillConfigEnv`：后者只经
    // `applyPrismerScopeEnv` ← `buildProviderProxyInjection`，而 code-agent-driver 在
    // `options.proxy` 未设时提前 return ⇒ BYOK / 官方端点的 claude-code run 收不到。
    // `extra.claude.env` 无条件进 `buildClaudeSpawnEnv`（02 §W5 已知限制那一段点名的备选）。
    const apcCodingScope = await resolveApcCodingScope(
      deps.cloud,
      profile,
      { paths: deps.paths, daemonId: deps.daemonId, codingCwd: adapterCwdOverride ?? undefined },
      deps.signal,
    );

    // ★ product204 · skill-config 注入修复（2026-07-14）—— 与上面 skill-sync 的 respawn **同源同理**。
    //
    // 上面那段（release203/10）已经认识到：**正在跑的 hermes gateway 是在 spawn 那一刻扫描
    // skill catalog 的**，之后同步进来的 skill 它看不见 → 必须 dropService 让它重建。
    //
    // **一模一样的道理适用于 skill 的 config，但当时没人想到。** gateway 的进程 env 是
    // python-dotenv 在 **spawn 那一刻**从 `<profileDir>/.env` 载入的；而 cloud 解析出来的
    // skill config 搭 dispatch payload 来（secret 在装配那一刻才解密，绝不进 profile GET
    // —— 验收 B2），adapter 只能在 `service.dispatch()` 里写 `.env` —— **那时 gateway 早跑起来了**。
    // 于是值只是躺在盘上，永远进不了那个进程 ⇒ **「给 skill 配了参数」对运行中的 agent 完全无效**
    // （M6-03/04/05 三条产品门落空；test204 R2 的 4 条红同根因）。
    //
    // 修法照抄上面：**在 ensureService 之前**把 config 写进 `.env`，**变了就原子 invalidate** →
    // 下面的 ensureService 重建 gateway → dotenv 载入新值 → 工具子进程终于看得见。
    //
    // 只对 hermes 做。claude-code / codex 是 **per-dispatch spawn**，走 `applyPrismerScopeEnv`
    // 在 spawn 那一刻注入 env（prismer-env.ts），**天然正确，不需要也不该 respawn**。
    //
    // 稳态无 churn：`syncSkillConfigEnvToProfile` 只在 `.env` 里的值与本次要注入的值**不同**时
    // 才写、才返回 true（与上面 `skillSync.synced > 0` 的 revision-diff 是同一个哲学）。
    // ⚠️ `dropService` 一个人不够：`HermesService.shutdown()` 不杀 gateway；而独立的
    //    stop→drop 又会与 prewarm/first-dispatch creator 交错。必须由 ServicePool.invalidate
    //    fence/wait creator、清句柄，并在同一 critical section 里停 exact gateway。
    //
    // 2026-07-16 — model/proxyProvider 漂移同理，且**同一个坑**：两者也是 spawn 时才
    // 烤进 gateway 的（config.yaml 的 model/base_url、spawn env 里的 key）。用户在
    // composer 里换了模型 → profile 改了 → 这里必须杀掉带旧模型的进程，否则
    // ensureService 复用它，用户的选择静默无效。
    // 两个条件合到一个 kill 里：一次 dispatch 同时改了 skill-config 和模型时只重启一次。
    if (profile.adapterName === 'hermes' && (deps.invalidateService || deps.dropService)) {
      try {
        const profileName = getHermesProfileName(profile);
        const envChanged = syncSkillConfigEnvToProfile(
          profileName,
          payload.metadata as Record<string, unknown> | undefined,
        );
        const cfgDrifted = hermesGatewayConfigDrifted(profile);
        if (envChanged || cfgDrifted) {
          await invalidateHermesService(profile, deps);
          process.stderr.write(
            `[daemon] hermes gateway respawn profile=${profile.id} (env=${envChanged} model/provider=${cfgDrifted}) → atomically invalidated service + killed gateway\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `[daemon] skill config env sync skipped profile=${profile.id}: ${(err as Error).message}\n`,
        );
      }
    }

    // 0. Resolve #filename references to prismer:// URIs (before uriResolver.rewrite)
    let hashRefResult: HashRefResult = { text: payload.prompt, resolutions: [] };
    if (deps.assetMetadataIndexes && profile.workspaceId) {
      const assetIndex = deps.assetMetadataIndexes.get(profile.workspaceId);
      if (assetIndex) {
        hashRefResult = await resolveHashRefs(payload.prompt, assetIndex, deps.cloud);
        payload.prompt = hashRefResult.text;
      }
    }

    // 1. Rewrite prismer:// + http(s):// in prompt + context.
    //
    // L5: a single shared urlCache + urlObservations array spans prompt +
    // all context entries so identical URLs are fetched once and surface
    // one observation row in the reply.
    const urlCache = new Map<string, UrlResolution>();
    const urlObservations: AssetDispatchObservation[] = [];
    const rewrittenPrompt = await deps.uriResolver.rewrite(payload.prompt, {
      pin: true,
      urlCache,
      urlObservations,
    });
    resolvedHashes.push(...rewrittenPrompt.resolvedHashes);

    let rewrittenContext: TaskDispatchContextEntry[] = [];
    if (payload.context && payload.context.length > 0) {
      const contents = payload.context.map((e) => e.content);
      const r = await deps.uriResolver.rewriteAll(contents, {
        pin: true,
        urlCache,
        urlObservations,
      });
      resolvedHashes.push(...r.resolvedHashes);
      rewrittenContext = payload.context.map((e, i) => ({ ...e, content: r.texts[i]! }));
    }

    // 1b. Wave-8 W1: resolve cloud-attached assets (payload.assetRefs).
    // Each ref is mime-routed: text-like → inline body into the prompt;
    // anything else → expose `file://<cachePath>` URI so the adapter's
    // own read tool can pick it up. Observability rides back on the
    // dispatch.reply.
    const assetResolution = await resolveAssetRefs(
      payload.assetRefs,
      deps.assetCache,
      taskId,
      {
        cloud: deps.cloud,
        enabled: deps.visionAux?.enabled !== false,
        cacheDir: deps.visionAux?.cacheDir ?? (deps.paths ? path.join(deps.paths.cacheDir, 'vision-cache') : undefined),
        timeoutMs: deps.visionAux?.timeoutMs,
        signal: deps.signal,
      },
      adapterHasFilesystemTools(profile),
    );
    resolvedHashes.push(...assetResolution.pinnedHashes);

    // 2. Build prompt: rewrittenPrompt + context + asset blocks (W1)
    //    + (Wave-7 ζ) memory + active goal context appended on top.
    const basePrompt = composePrompt(
      rewrittenPrompt.text,
      rewrittenContext,
      deps.contextMaxChars ?? DEFAULT_CONTEXT_MAX,
      assetResolution.promptBlocks,
    );
    const [memoryContext, goalContext] = await Promise.all([
      loadMemoryContext(profile, deps.cloud, deps.signal),
      loadGoalContext(payload, profile, deps.cloud, deps.signal),
    ]);
    const activeGoalContext = goalContext.filter((goal) => isActiveGoalTask(goal));
    const adapterPrompt = appendArtifactsInstruction(
      appendChannelContext(
        appendMemoryContext(composeActiveGoalContext(basePrompt, activeGoalContext), memoryContext, {
          sessionRecallContent: dispatchRecallContent,
        }),
        payload,
        profile,
      ),
      artifactsDir,
      profile.config as { disableOutboxHints?: unknown } | undefined,
      scratchDir,
    );

    // 3. Dispatch.
    // Surface the profile's systemPrompt to the adapter via metadata so role
    // templates (product-manager / engineer) actually drive the LLM behavior.
    // Without this the agent receives only the user message and behaves as a
    // generic chatbot. If the schema later evolves systemPrompt to a
    // structured object (e.g. { mode: 'composed', parts: [...] }), warn
    // loudly so we get a signal — silently dropping the prompt makes every
    // role-template-driven agent regress to its base persona with no clue.
    const cfg = profile.config as { systemPrompt?: unknown } | undefined;
    let profileSystemPrompt: string | undefined;
    if (typeof cfg?.systemPrompt === 'string') {
      profileSystemPrompt = cfg.systemPrompt;
    } else if (cfg?.systemPrompt !== undefined) {
      process.stderr.write(
        `[daemon] profile ${profile.id}: systemPrompt is non-string (${typeof cfg.systemPrompt}) — agent will run with adapter defaults; check profile schema\n`,
      );
    }
    // release203/11 — daemon dispatch is ALWAYS non-interactive (no human at a
    // prompt to answer an approval), so both agent families AND the embedded
    // runtime engine run FULLY AUTONOMOUS: persistence (hermes, user directive
    // "彻底去审批"), coding (claude-code / codex / opencode, which already
    // launch with bypassPermissions), and runtime-engine pi-core (runtime210/09
    // §3.2 — its approval surface is the runtime permission gate, not an LLM
    // pause). Force it regardless of the stored role template's approvalPolicy
    // — UI-created agents carry a DB role-template snapshot whose
    // operatingPrinciples may still embed approval-seeking prose; the forced
    // override supersedes it without a 205-template DB migration, and keeps the
    // prompt consistent with the autonomous launch (otherwise a coding agent's
    // prompt would still say "request approval for destructive ops" and could
    // confabulate a stall).
    const forceAutonomous =
      profile.adapterName === 'hermes' || profile.adapterName === 'pi-core' || isCodingAdapter(profile.adapterName);
    const operatingPrinciples = resolveOperatingPrinciples(profile.config, forceAutonomous);
    // release203/11 §2.1/§2.2 (Slice A) — canonical identity injection.
    //
    // SOUL (persona) layer — `composedSystemPrompt` carries the persona ONLY:
    //   - persistence: role template persona (profileSystemPrompt) + principles.
    //   - coding净身: profileSystemPrompt is '' (doc 10 stripped business
    //     persona). Substitute CODING_SOUL_DEFAULT so the model has a baseline
    //     engineering voice + answer-style rules instead of leading with its own
    //     generic persona ("who are you?" → generic Claude root cause).
    // Composition order: persona FIRST, principles SECOND.
    //
    // CRITICAL — IDENTITY (name) + USER (peers) lines are NOT folded in here.
    // They are dynamic context, not persona. Hermes writes `composedSystemPrompt`
    // verbatim to SOUL.md (slot #1), which Hermes docs say must stay persona-only
    // (no one-off / per-turn context). So identity/user/scope ride on a SEPARATE
    // metadata key (`identityContext`) below: hermes places them in the per-turn
    // `instructions` slot, and the coding driver prepends them to its
    // `--system-prompt`. This keeps SOUL.md clean while both categories still see
    // the agent's name + who it's talking to.
    const codingAgent = isCodingAdapter(profile.adapterName);
    const personaPrompt =
      typeof profileSystemPrompt === 'string' && profileSystemPrompt.length > 0
        ? profileSystemPrompt
        : codingAgent
          ? CODING_SOUL_DEFAULT
          : undefined;
    // product209/19 WP3 — memory + PKF-report directives are a FIXED operating
    // part of EVERY agent, double-reinforced (this common directive in the
    // persona PLUS the builtin memory/memory-dream/pkf-writing skills). WP3
    // fills the injection gap: memory203/14 originally gave the prompt only to
    // hermes (coding agents stayed净身 per the 2026-07-01 ruling); now all
    // four adapter families receive the SAME verbatim directive text at this
    // single seam (composeCoreDirectives). The directive carries the curate
    // verbs so convergence runs even if skill discovery is unavailable.
    const coreDirectives = composeCoreDirectives(profile.adapterName);
    const pkfRuntimeCapability = deps.resolvePkfRuntimeCapability?.(profile);
    const pkfRuntimeCapabilityDirective = pkfRuntimeCapability
      ? renderPkfRuntimeCapabilityDirective(pkfRuntimeCapability)
      : undefined;
    // release203 web-capability fix — hermes-only (coding agents have their own
    // native web/CLI tools and stay净身). Rides the same seam as the core
    // directives so it reaches every hermes agent regardless of role-template
    // principles.
    const webToolCore = profile.adapterName === 'hermes' ? WEB_TOOL_DIRECTIVE : undefined;
    // runtime210 G-A — pi-core consumes the skill files via its system prompt:
    // the daemon reads the resolved skillsDir and appends the rendered
    // SKILL.md text here. Hermes KEEPS its existing MEMORY.md carrier
    // semantics (its adapter loads the same dir at spawn) — this block is
    // pi-core-only by construction, so the hermes composition is untouched.
    const piCoreSkillsPrompt =
      profile.adapterName === 'pi-core'
        ? await composePiCoreSkillsPrompt(profile, agentImUserId ?? profile.agentImUserId, deps)
        : undefined;
    const composedSystemPrompt = [
      personaPrompt,
      operatingPrinciples,
      ...coreDirectives,
      pkfRuntimeCapabilityDirective,
      piCoreSkillsPrompt,
      webToolCore,
    ]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n');
    // Structured identity lines composed cloud-side (only cloud has the names).
    // Filtered to non-empty so the daemon-side renderers can join cleanly.
    const identityLines = renderIdentityLines(payload.identityContext);
    const hasIdentity =
      identityLines.identity.length > 0 ||
      identityLines.user.length > 0 ||
      identityLines.scope.length > 0 ||
      identityLines.sections.length > 0;
    // Wave-3 D2 — instantiate per-task heartbeat + step recorder.
    //
    // Heartbeat 15s loop reports `currentPhase` to cloud so the
    // sweepStuckPhases reaper can flag silent stalls (>45s) WITHOUT
    // touching the canonical `status` column. Adapter advances phase via
    // ctx.heartbeat.setPhase(); dispatch.ts owns start/stop so a buggy
    // adapter can't leak a timer.
    //
    // StepRecorder fan-outs tool_call / tool_result / reasoning_chunk /
    // phase_change / error frames to im_task_run_steps (Wave 3.5 will
    // land the server-side persister; daemon-side wire path lands now so
    // adapter implementations don't need to retro-fit later).
    //
    // Initial phase: 'thinking'. Adapters that hand off to a long-running
    // service may overwrite immediately via ctx.heartbeat.setPhase().
    let activePhase = 'thinking';
    const heartbeat = new TaskHeartbeat({
      ws: deps.ws,
      onGiveUp: (tid, err) => process.stderr.write(`[daemon] task.heartbeat give-up task=${tid}: ${err.message}\n`),
    });
    heartbeatRef = heartbeat;
    heartbeat.start(taskId, () => activePhase);
    // dispatch.reply mirrors taskId on the cloud as the run id — runtime
    // does not yet maintain a separate taskRunId column, so we send the
    // same identifier. When im_task_runs lands its own id space the
    // adapter ctx will surface that instead; until then "taskRunId" is
    // synonymous with "this dispatch's taskId" on the daemon side.
    const recorder = new StepRecorder({ ws: deps.ws, taskRunId: taskId });
    recorderRef = recorder;
    checkpointPayload = {
      adapterName: profile.adapterName,
      workspaceId: profile.workspaceId,
      agentImUserId: payload.agentImUserId ?? profile.agentImUserId,
      ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
      traceId,
    };
    // Initial phase signal — adapter that overrides simply pushes a new
    // setPhase + recordPhaseChange combo.
    recorder.recordPhaseChange(activePhase);
    persistCheckpoint(activePhase);

    // 2026-05-29 — Hermes /v1/runs context-dropout fix. Adapters that
    // natively understand role-tagged history (hermes /v1/runs,
    // OpenAI Responses) read `contextEntries` + `currentPrompt`; adapters
    // that don't (claude-code, codex, openclaw) keep reading `prompt`,
    // which is still the concatenated form composed above. See
    // contract.ts:TaskInput.contextEntries doc and hermes/index.ts /v1/runs
    // body construction.
    // im_events.ts: senderRole ∈ {'human','agent','admin','system'}.
    // Map to OpenAI/Hermes role vocabulary: agent → assistant, system →
    // system, human/admin → user.
    const toContextEntry = (
      e: TaskDispatchContextEntry,
    ): {
      role: 'user' | 'assistant' | 'system';
      content: string;
      sender?: string;
      senderRole?: string;
      createdAt?: string;
      attachedAssetIds?: string[];
      attachedAssets?: Array<{ id: string; mime?: string; filename?: string; sizeBytes?: number }>;
    } => ({
      role: e.senderRole === 'agent' ? 'assistant' : e.senderRole === 'system' ? 'system' : 'user',
      content: e.content,
      sender: e.sender,
      senderRole: e.senderRole,
      // release201/30 — preserve original IM message createdAt so the
      // sessions-dispatcher can stamp it on the <prior_message at="..."> tag.
      createdAt: e.createdAt,
      // release201/30 §XML-context P0 (2026-05-31) — forward asset
      // attachments from cloud so sessions-dispatcher can render
      // `<attached_assets>` inside `<prior_message>`. Without this the
      // prior PDF/image refs would silently drop at the daemon boundary
      // and the agent would see only the user's text body.
      ...(e.attachedAssetIds && e.attachedAssetIds.length > 0 ? { attachedAssetIds: e.attachedAssetIds } : {}),
      ...(e.attachedAssets && e.attachedAssets.length > 0 ? { attachedAssets: e.attachedAssets } : {}),
    });

    const taskInput: TaskInput = {
      taskId,
      // release202/09 §3.2 — thread the run-vs-task kind to the adapter so its
      // execution_context emits `<run_id>` for chat runs / `<task_id>` for
      // kanban tasks. `taskId` above still mirrors the run id for back-compat.
      kind: dispatchKind,
      ...(dispatchRunId ? { runId: dispatchRunId } : {}),
      prompt: adapterPrompt,
      currentPrompt: rewrittenPrompt.text,
      ...(rewrittenContext.length > 0 ? { contextEntries: rewrittenContext.map(toContextEntry) } : {}),
      heartbeat: {
        setPhase: (phase: string) => {
          activePhase = phase;
          heartbeat.setPhase(phase);
          recorder.recordPhaseChange(phase);
          persistCheckpoint(phase);
        },
        touchStep: () => heartbeat.touchStep(),
      },
      recorder: {
        recordPhaseChange: (phase: string) => {
          activePhase = phase;
          heartbeat.setPhase(phase);
          recorder.recordPhaseChange(phase);
          persistCheckpoint(phase);
        },
        // release203/15 WS-G — forward the 4th `opts` ({detail, status, altitude}).
        // This shim predates the opts arg (WS-C/WS-G) and silently dropped it, so
        // the Hermes tool-call-mapper's structured `detail` never reached the
        // StepRecorder (steps persisted hasDetail=false / altitude=milestone). The
        // mapper + sessions-sse wiring were correct; THIS swallow was the real cause.
        recordToolCall: (toolName, input, toolCallId, opts) => {
          // release203/22 W1 — count the REAL tool call for skill.invoked.
          if (toolName) toolInvokeCounts.set(toolName, (toolInvokeCounts.get(toolName) ?? 0) + 1);
          recorder.recordToolCall(toolName, input, toolCallId, opts as Parameters<typeof recorder.recordToolCall>[3]);
        },
        recordToolResult: (toolCallId, output, opts) =>
          recorder.recordToolResult(toolCallId, output, opts as Parameters<typeof recorder.recordToolResult>[2]),
        recordReasoningChunk: (text) => recorder.recordReasoningChunk(text),
        recordError: (message, payload) => recorder.recordError(message, payload),
        // runtime210/09 §3.1b (C3c ruling, Path B) — pi text deltas ride the
        // steps channel via the recorder's 500ms-batched `text_delta` kind.
        recordTextDelta: (text, opts) => recorder.recordTextDelta(text, opts),
      },
      // 14b rev.3 §9 P3 — multimodal-aware adapters (Hermes, OpenClaw) pick
      // up the resolved bytes/URLs here; text-only adapters ignore the field.
      ...(assetResolution.resolvedRefs.length > 0 ? { assetRefs: assetResolution.resolvedRefs } : {}),
      // 2026-05-29 — surface non-image asset reminder/inline blocks so
      // adapters that bypass `prompt` (sessions-dispatcher) can still
      // include the attachment context in the current-turn message.
      // See comment on TaskInput.assetPromptBlocks for rationale; this is
      // the W1 root-cause fix for "approval redispatch loses pptx".
      ...(assetResolution.promptBlocks.length > 0 ? { assetPromptBlocks: assetResolution.promptBlocks } : {}),
      // release201/30 — fields consumed by sessions-style adapters
      // (hermes/sessions-dispatcher) to compose the <conversation_context>
      // XML wrapper that disambiguates first-person voice in group chats.
      // Legacy /v1/runs path and interactive adapters ignore these.
      conversationType:
        payload.conversationType === 'direct' || payload.conversationType === 'group'
          ? payload.conversationType
          : 'unknown',
      ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
      ...(profile.agentUsername ? { profileAgentUsername: profile.agentUsername } : {}),
      ...(profile.agentImUserId ? { profileAgentImUserId: profile.agentImUserId } : {}),
      ...(Array.isArray(payload.participants) && payload.participants.length > 0
        ? { participants: payload.participants }
        : {}),
      ...(payload.triggerSenderUsername ? { currentMessageSender: payload.triggerSenderUsername } : {}),
      ...(payload.triggerSenderRole ? { currentMessageSenderRole: payload.triggerSenderRole } : {}),
      // release201/25 §7 / release201/26 — typed L3 envelope. Envelope-aware
      // adapter paths (hermes sessions-dispatcher's renderContextEnvelope and
      // the openclaw/claude-code/codex equivalents) consume this directly.
      // When undefined the adapter falls back to the legacy contextEntries +
      // participants + currentMessage* fields above (one release window).
      ...(payload.contextEnvelope ? { contextEnvelope: payload.contextEnvelope } : {}),
      metadata: {
        ...payload.metadata,
        // desktop205 W5 — ALWAYS written (never conditionally spread), and
        // written AFTER `...payload.metadata`, so a stale or hostile cloud
        // payload carrying this key can never switch the boundary on: the only
        // value that survives is the one the daemon just computed from cloud's
        // `platformScoped` verdict. Consumed by code-agent-driver via
        // `apcHeldOutDenyTaskEnv`.
        [APC_HELDOUT_DENY_METADATA_KEY]: apcCodingScope === 'platform',
        conversationId: payload.conversationId,
        // v2.1 §9.5 — context the hermes adapter forwards into the daemon's
        // local_run_sessions table so `/v1/hooks/*` reverse-lookups can
        // stamp memory pages with §4 MemorySourceStamp.
        agentImUserId: payload.agentImUserId,
        workspaceId: profile.workspaceId,
        // product209 D11 — immutable execution identity consumed by provider
        // terminal finalizers; written after payload metadata so it cannot be
        // spoofed by a stale cloud frame.
        runtimeProfileId: profile.id,
        runtimeProfileName: profile.name,
        ...(typeof profile.config.model === 'string' && profile.config.model.trim()
          ? { runtimeExecutionModel: profile.config.model.trim() }
          : {}),
        ...(typeof profile.config.proxyProvider === 'string' && profile.config.proxyProvider.trim()
          ? { runtimeProxyProvider: profile.config.proxyProvider.trim() }
          : {}),
        runtimeCanonicalTurnId: dispatchRunId ?? taskId,
        ...(dispatchRunId ? { runtimeRunId: dispatchRunId } : {}),
        ...(typeof (profile.config as { roleTemplate?: { slug?: unknown } })?.roleTemplate?.slug === 'string'
          ? { roleTemplateSlug: (profile.config as { roleTemplate: { slug: string } }).roleTemplate.slug }
          : {}),
        prismerGoals: goalContext.map(toGoalMirrorPayload),
        prismerObjectives: activeGoalContext.map(toObjectiveMirrorPayload).filter(Boolean),
        ...(composedSystemPrompt ? { systemPrompt: composedSystemPrompt } : {}),
        // release203/11 §2.2 (Slice A) — structured IDENTITY/USER/scope context.
        // Kept SEPARATE from systemPrompt so SOUL.md (written from systemPrompt
        // by the hermes adapter) stays persona-only. The coding driver prepends
        // these to its --system-prompt; the hermes adapter folds identity+user
        // into its per-turn instructions slot. Only present when something
        // resolved → additive (wire frame unchanged for legacy dispatches).
        ...(hasIdentity ? { identityContext: identityLines } : {}),
        // Wave-9 / F18 / release202/04: spawn-style adapters (claude-code,
        // codex, openclaw) read these and inject `PRISMER_ARTIFACTS_DIR` /
        // `PRISMER_SCRATCH_DIR` into the child env so the LLM tool can resolve
        // the paths even if it doesn't read the prompt instruction.
        // Long-running adapters (Hermes) ignore these and rely on the
        // prompt-side instruction added above — but Hermes is now
        // cwd-sandboxed to its profile dir (~/.hermes/profiles/<name>/) so
        // relative-path writes still stay out of the user's source tree.
        //
        // Canonical metadata keys: `prismerArtifactsDir` / `prismerScratchDir`.
        // We no longer write the legacy `prismerOutboxDir` key — PRISMER_OUTBOX_DIR
        // is dead and prismer-env.ts exports only PRISMER_ARTIFACTS_DIR. (It still
        // *reads* `prismerOutboxDir` as a back-compat INPUT for stale cloud
        // payloads, but the daemon itself never re-emits it.) `prismerWorkDir`
        // stays as a scratch alias for stale agents that read PRISMER_WORKDIR.
        ...(artifactsDir ? { prismerArtifactsDir: artifactsDir } : {}),
        // release203/06 §3.7 (block 1) — for repo-scoped code agents with a
        // persistent workdir, the adapter cwd (resolveSpawnScratchCwd reads
        // prismerScratchDir/prismerWorkDir) must be the PERSISTENT repo path,
        // not the ephemeral per-task scratch — so codex thread / claude-code
        // session resume + the repo files survive across turns. When no
        // override, keep the existing per-task scratch value unchanged.
        ...(adapterCwdOverride
          ? {
              prismerScratchDir: adapterCwdOverride,
              prismerWorkDir: adapterCwdOverride,
              // runtime210/09 §2.3 — dedicated persistent-workdir marker for
              // taskCwdPriority engines (pi-core): prismerScratchDir doubles
              // as the per-task scratch for coding adapters, so a pi-core
              // jail must never bind to it when no workdir spec existed.
              prismerWorkdirOverride: adapterCwdOverride,
            }
          : scratchDir
            ? { prismerScratchDir: scratchDir, prismerWorkDir: scratchDir }
            : {}),
        // release202/04 §3.1 P1 — expose the session scope for later phases
        // (P3 surfaces these in <execution_context>). prismerArtifactsDir /
        // prismerScratchDir above point at the TASK level (this turn,
        // auto-attached); these point at the SESSION level (cross-turn,
        // attached on demand). Only present when the dispatch has a
        // conversationId — pure kanban / agent-to-agent runs have no session.
        ...(sessionId !== null ? { prismerSessionId: sessionId } : {}),
        ...(sessionDir ? { prismerSessionDir: sessionDir } : {}),
        // release201/09 §9.9 — 5 PRISMER_* envs to inject into the spawned
        // agent process. Each adapter reads these from task.metadata and
        // mirrors into the child env. NULL projectId is sent as the
        // `_unscoped` sentinel string so built-in skills' --project default
        // logic resolves to `_unscoped` (matching daemon path layout).
        prismerWorkspaceId: profile.workspaceId ?? '',
        prismerActiveProjectId:
          payload.projectId && payload.projectId.length > 0 ? payload.projectId : UNSCOPED_PROJECT_SENTINEL,
        prismerAgentId: payload.agentImUserId ?? '',
        // 2026-05-29 — agent identity for X-IM-Agent on cloud writes.
        // Username is the human handle (ceo / cto / marketer); IM user id
        // is the im_users row this agent owns. Adapter-spawn child env will
        // carry these via applyPrismerScopeEnv → SDK CLI reads them and
        // forwards X-IM-Agent so cloud stamps senderId = agent. Without
        // this, daemon-spawned child writes are stamped as the daemon owner
        // (the human), which broke "@ceo: write PDF and post it" because
        // the file message came back as `tomwinshare` not `ceo`.
        ...(profile.agentUsername ? { prismerAgentUsername: profile.agentUsername } : {}),
        ...(payload.agentImUserId ? { prismerAgentImUserId: payload.agentImUserId } : {}),
        // release202/09 §3.2 — env split. Chat-dispatch RUNs get
        // `prismerRunId` (→ PRISMER_RUN_ID) and NO `prismerTaskId`, so an agent
        // can never `cloud task complete "$PRISMER_TASK_ID"` against a run id
        // (the 404 incident). Kanban TASKs get `prismerTaskId` (→
        // PRISMER_TASK_ID). `prismerKind` is carried so prismer-env.ts splits
        // deterministically without re-deriving from the id shape.
        prismerKind: dispatchKind,
        ...(dispatchKind === 'run' ? { prismerRunId: dispatchRunId ?? taskId } : { prismerTaskId: taskId }),
        // desktop202/20 — the dispatch `taskId` is ALSO the reply's `taskId`
        // (every reply path sends `reply = { taskId, ... }`). We carry it
        // verbatim as a stable run key so the provider-proxy injection can stamp
        // it as `x-prismer-task-run-id` on agent LLM calls, and the cloud reply
        // handler can look the routing outcome back up by the same value —
        // independent of run/task kind or a distinct runId (which would diverge).
        prismerDispatchId: taskId,
        // release202/09 P2 — surface the conversationId to the agent env
        // (PRISMER_CONVERSATION_ID) so `cloud file send` (动作 B, standalone
        // message) can target the session without scraping it from the prompt.
        ...(payload.conversationId ? { prismerConversationId: payload.conversationId } : {}),
        prismerDaemonId: deps.daemonId ?? '',
        prismerObservability: {
          identity: {
            loaded: Boolean(profileSystemPrompt),
            profileId: profile.id,
            adapterName: profile.adapterName,
          },
          memory: {
            status: memoryContext.status,
            filesSummarized: memoryContext.filesSummarized,
            filesTotal: memoryContext.filesTotal,
            totalBytes: memoryContext.totalBytes,
            durationMs: memoryContext.durationMs,
            error: memoryContext.error,
          },
          goals: {
            status: 'loaded',
            count: activeGoalContext.length,
            mirroredCandidates: goalContext.length,
            activeObjectives: activeGoalContext.filter((goal) => goal.okrObjective).length,
          },
        },
      },
      timeoutMs: payload.timeoutMs,
      signal: deps.signal,
      onProgress: (p) => {
        const progressPayload: TaskDispatchProgressPayload = { taskId, ...p };
        deps.onProgress?.(taskId, progressPayload);
        deps.ws.send(envelope('task.dispatch.progress', progressPayload));
      },
    };
    // S6/M1 — arm the mid-turn narration relay only when the double-gate is
    // open (see interimRelayArmed above). Each non-empty commentary segment
    // leaves as an interim frame I1 { ok:true, output:<segment>, seq,
    // final:false }; the adapter-side callback is fire-and-forget, so a
    // sendReply failure here must never break the turn (I6) — sendReply is
    // ws.send, which is already best-effort.
    if (interimRelayArmed) {
      taskInput.onInterimReply = ({ text }: { text: string; seq: number }): void => {
        // S6/M1 fix round 1 — daemon-side single-source seq. The adapter's
        // reported `seq` is per-SSE-stream local (Task 1's commentarySeq
        // restarts 1-based on every consumeSessionsSse call) and the retry
        // loop below reuses THIS closure across attempts, so trusting it
        // would put [1, …, 1, terminal N] on the wire after a transient
        // retry — I4 violated twice (duplicate seq AND a terminal frame that
        // is not the max). `interimSeq` is the only authoritative counter;
        // the adapter-reported value is deliberately ignored.
        const seq = ++interimSeq;
        interimSegments.push(text);
        sendReply(deps.ws, buildInterimFrame(taskId, { text, seq }), requestId);
        traceLog(`[daemon] interim reply task=${taskId} seq=${seq} chars=${text.length}`);
      };
    }

    // P2 (2026-05-24): daemon-side retry with exponential backoff.
    //
    // A single transient failure from the LLM gateway (rate-limit 429, brief
    // network blip, sporadic tool error) should NOT immediately surface as
    // "Agent failed ❌" in chat. We retry up to MAX_ATTEMPTS=3. Approval
    // suspension and user cancel are both legitimate non-failures and exit
    // the loop immediately. The reaper signal aborts any pending backoff so
    // we never delay past cancellation.
    //
    // memory203/18 R3.2 — backoff is limiter-aware: cloud-limiter failures
    // (429 queue-full / RPM, 504 slot-deadline) honor an explicit Retry-After
    // hint when the message carries one, else use longer jittered windows
    // ([3–6s, 8–15s]) instead of the fixed [1s, 3s] — the old schedule burnt
    // all 3 attempts in ~4s, well inside a limiter's queue-drain horizon.
    //
    // On final exhaustion we synthesise a failed TaskResult:
    //   - limiter-class last error → `dispatch_precondition_unavailable`
    //     (memory203/18 R3.1) so the cloud's EXISTING transient-requeue
    //     channel (handler.ts → requeueTransientRun, cap 4) re-delivers the
    //     run once the queue drains — self-heal instead of a permanent red
    //     failure pill;
    //   - anything else → `daemon_local_retry_exhausted` (terminal), so the
    //     cloud handler renders a "retried 3 times" message.
    const MAX_ATTEMPTS = 3;
    const attemptTrace: Array<{
      attempt: number;
      errorCode: string;
      errorMessage: string;
      durationMs: number;
    }> = [];

    let result: TaskResult | null = null;
    let lastError: Error | null = null;

    // S7 (spec 07 Task 1 / 裁决 B) — ONE idempotency nonce per dispatch CALL,
    // minted here (outside the loop) and re-used by every attempt below.
    //
    // Why outside: the loop IS the retry of one intent. Hermes' `/v1/runs`
    // fingerprints `Idempotency-Key` + the whole request body, so a retry that
    // presents a NEW key is not a retry upstream — it is a second run, billed
    // and executed again, while the first acceptance's reply is lost. Minting
    // it per call keeps the two cases apart: a P2 retry (same call) replays,
    // while a cloud requeue (a new call, entering here again) legitimately
    // executes fresh — replaying an already-closed run's terminal result would
    // be worse than running it twice.
    const dispatchCallOpts: DispatchCallOptions = { idempotencyNonce: randomUUID() };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const lastMessage = lastError?.message ?? 'unknown';
        const backoff = resolveRetryBackoffMs(attempt, lastMessage);
        process.stderr.write(
          `[daemon] task=${taskId} retry attempt ${attempt}/${MAX_ATTEMPTS} backoff=${Math.round(backoff)}ms (last: ${lastMessage})\n`,
        );
        // memory203/18 R3.3 — emit progress BEFORE the backoff sleep so the
        // reaper's inactivity window resets (runner.ts lastProgressAt) and the
        // cloud/UI can show "retrying" instead of silence. Without this a long
        // limiter backoff looked like a stall and the 300s reaper
        // (reaper-config.ts) killed runs that were mid-retry.
        taskInput.onProgress?.({
          progress: 0.05,
          message: `retrying(attempt=${attempt}, reason=${retryReasonToken(lastMessage)})`,
          detail: {
            kind: 'retry',
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            backoffMs: Math.round(backoff),
            reason: lastMessage.slice(0, 200),
          },
        });
        await abortableSleep(backoff, deps.signal);
        if (deps.signal?.aborted) {
          // Reaper / user cancel — exit early, don't continue retrying.
          break;
        }
      }
      const attemptStart = Date.now();
      try {
        if (adapter.kind === 'long-running') {
          const service = await deps.ensureService(profile, adapter);
          result = await service.dispatch(taskInput, dispatchCallOpts);
        } else {
          if (!adapter.dispatch) {
            result = {
              ok: false,
              error: {
                code: 'adapter_dispatch_failed',
                message: `Interactive adapter ${adapter.name} missing dispatch()`,
              },
            };
          } else {
            result = await adapter.dispatch(profile, taskInput);
          }
        }
        if (result.ok) break;
        // Non-retryable terminal states — exit the loop without recording an attempt.
        if (
          isApprovalSuspension(result) ||
          isUserCancel(result) ||
          isPermanentUpstreamError(result) ||
          isEmptyReplyFailure(result) ||
          // release203/27 S10 — session_busy is a TRANSIENT precondition (a turn
          // is already running on this hermes session). Don't burn local retries
          // hammering the busy session; surface the `dispatch_precondition_
          // unavailable` code to the cloud, whose requeueTransientRun channel
          // re-delivers with proper spacing.
          isSessionBusyTransient(result)
        )
          break;
        // Retryable failure path.
        attemptTrace.push({
          attempt,
          errorCode: result.error?.code ?? 'unknown',
          errorMessage: result.error?.message ?? '',
          durationMs: Date.now() - attemptStart,
        });
        lastError = new Error(result.error?.message ?? 'adapter returned ok=false');
        if (attempt === MAX_ATTEMPTS) break;
        continue;
      } catch (err) {
        // Adapter threw → also retryable.
        lastError = err as Error;
        attemptTrace.push({
          attempt,
          errorCode: 'adapter_threw',
          errorMessage: lastError.message,
          durationMs: Date.now() - attemptStart,
        });
        if (attempt === MAX_ATTEMPTS) break;
      }
    }

    // If we exhausted retries with no successful result, synthesise a failed result.
    if (!result || (!result.ok && attemptTrace.length === MAX_ATTEMPTS)) {
      const lastMessage = lastError?.message ?? 'unknown';
      // memory203/18 R3.1 — limiter-class exhaustion (429 queue-full / RPM,
      // 504 slot-deadline) is TRANSIENT capacity pressure, not an execution
      // failure. Emit `dispatch_precondition_unavailable` (original message
      // preserved) so the cloud's existing requeueTransientRun channel picks
      // it up (bounded by MAX_TRANSIENT_REQUEUE=4). Everything else stays
      // `daemon_local_retry_exhausted` (terminal).
      result = {
        ok: false,
        output: '',
        error: isLimiterClassError(lastMessage)
          ? {
              code: 'dispatch_precondition_unavailable',
              message: lastMessage,
            }
          : {
              code: 'daemon_local_retry_exhausted',
              message: `daemon attempted dispatch ${MAX_ATTEMPTS} times, all failed. Last error: ${lastMessage}`,
            },
        metrics: result?.metrics,
        metadata: {
          ...((result?.metadata as Record<string, unknown>) ?? {}),
          retryAttempts: attemptTrace,
        },
      };
    }

    const reaperAborted = deps.signal?.aborted && result.error?.code === 'task_cancelled';

    // Approval-deadlock reclassification (2026-05-22, doc 12).
    //
    // When the adapter (currently only Hermes) reports back that an
    // approval-request MCP tool call was observed during the run, a
    // subsequent reaper kill is NOT a real failure — the agent did its
    // job (submitted the approval card) but Hermes didn't close the SSE
    // stream and the inactivity reaper fired. Surface a dedicated
    // `awaiting_human_approval` error code so cloud can park the task
    // in `awaiting_approval` instead of `failed`, and the chat bubble
    // says "⏳ waiting for human review" instead of "⚠️ Agent failed".
    //
    // We deliberately keep `ok: false` on the reply: the run did NOT
    // complete; cloud must keep the task suspended until the human
    // decision arrives and `applyApprovalDecisionAndRedispatch` (see
    // task.service.ts) emits a new dispatch.
    const approvalRequested = Boolean((result.metadata as Record<string, unknown> | undefined)?.approvalRequested);
    // product205/03 §3.6 (M6) — runtime-hook evidence bundle (Hermes
    // dangerous-command bridge / claude canUseTool). Present only when the
    // park originated from the runtime floor, not the agent-honor MCP tool.
    // Forwarded on the dispatch-reply error so cloud materializes a
    // `runtime_action` approval row with the bundle (category-driven).
    const approvalBundle = (result.metadata as Record<string, unknown> | undefined)?.approvalBundle as
      | Record<string, unknown>
      | undefined;

    // Wave-9: drain the artifacts watcher so any files the adapter wrote to
    // ${artifactsDir} land on this reply as assetIds. We force one final
    // scan first so files written right before adapter return are
    // captured (the watcher's poll interval otherwise creates a 2s window
    // where last-second outputs would miss this dispatch).
    let collectedAssetIds: string[] = [];
    if (deps.artifactsWatcher && artifactsDir) {
      try {
        // Background polling stays opt-in, but this bounded final scan is the
        // contract promised in the prompt: files placed in this turn's unique
        // artifacts directory must ride the terminal reply as attachments.
        await deps.artifactsWatcher.scanNow({ force: true });
      } catch (err) {
        process.stderr.write(`[daemon] artifacts final-scan failed task=${taskId}: ${(err as Error).message}\n`);
      }
      collectedAssetIds = deps.artifactsWatcher.flushPending(taskId);
    }
    // P1-2 (2026-05-25): drain any MIME-mismatch rejections recorded by the
    // watcher during this dispatch. Cloud handler persists them on
    // `IMTask.metadata.outboxRejections` (wire field name kept) and
    // v19x-helpers re-injects the list into the next dispatch prompt so the
    // agent sees its mistake before retrying the same broken strategy. Guarded
    // on artifactsWatcher presence for test parity (some dispatch tests stub
    // it out entirely).
    const collectedRejections = deps.artifactsWatcher ? flushArtifactsRejections(taskId) : [];

    // runner.ts uses Math.max(entry.timeoutMs, minInactivityMs) as the actual
    // reaper threshold; @-mention dispatches never carry timeoutMs (see
    // ws/v19x-helpers.ts:175), so `payload.timeoutMs ?? 0` would falsely show
    // "0ms" when the real wait was the configured minimum inactivity window.
    const reaperLimitMs =
      typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
        ? payload.timeoutMs
        : getTaskReaperMinInactivityMs();
    const finalError = approvalRequested
      ? {
          code: 'awaiting_human_approval',
          message:
            'Agent requested human approval and is suspended pending decision. Cloud will redispatch with `approval.decided` once the human responds.',
          // M6 runtime-hook origin: attach the §3.5 bundle so cloud creates a
          // `runtime_action` approval (not the agent-honor fallback). Absent on
          // the MCP-tool path → cloud keeps the existing lookup/fallback behavior.
          ...(approvalBundle ? { approvalBundle } : {}),
        }
      : reaperAborted
        ? {
            code: 'daemon_task_timeout',
            message: `Daemon-side reaper aborted after ${reaperLimitMs}ms inactivity (no progress events from adapter)`,
          }
        : result.error;
    // desktop202/19 §4 L1 — surface which model/provider/chain served this
    // reply so cloud can stamp metadata.llmMetadata and the UI chip lights up.
    // Derived from the resolved profile (+ adapter runtime override if any).
    // Hermes' provider lifecycle hook can observe the actual served route even
    // when the sessions SSE omits its optional model/provider fields. Bind that
    // evidence back through the exact Cloud task/run id. Configured intent
    // (`model` / `proxyProvider`) is never accepted here, and every identity
    // dimension must match before the evidence can enter the durability gate.
    const runtimeRouting = getRunSessionRegistry()?.lookupByTaskId(taskId);
    const expectedAgent = payload.agentImUserId ?? profile.agentImUserId;
    const exactRuntimeRouting =
      runtimeRouting?.routingEvidenceSource === 'adapter' &&
      runtimeRouting.taskId === taskId &&
      runtimeRouting.workspaceId === profile.workspaceId &&
      runtimeRouting.agentImUserId === expectedAgent &&
      runtimeRouting.profileId === profile.id &&
      runtimeRouting.adapterName === profile.adapterName
        ? runtimeRouting
        : null;
    const terminalResultMetadata = {
      ...(result.metadata ?? {}),
      ...(!stringFrom(result.metadata?.modelUsed) && exactRuntimeRouting?.servedModel
        ? { modelUsed: exactRuntimeRouting.servedModel }
        : {}),
      ...(!stringFrom(result.metadata?.providerUsed) && exactRuntimeRouting?.servedProvider
        ? { providerUsed: exactRuntimeRouting.servedProvider }
        : {}),
    };
    const llmMetadata = deriveLlmRoutingMetadata(profile.config, terminalResultMetadata);
    const inlinePkf = result.ok ? extractInlinePkfReply(result.output ?? '') : undefined;
    // pkf209 — mechanical inline-PKF delivery. When the reply text carries NO
    // sentinel carrier, a `pkf_reply_inline` marker written during this turn
    // stands in: re-read the file, re-validate everything (the marker is
    // never trusted — the agent can write files in its own scratch dir), and
    // attach the same contentBlock shape the sentinel extraction produces.
    // Any drift → no block + structured warn; the plain-text reply survives.
    let markerInlineBlocks: AgentDispatchReplyPkfContentBlock[] | undefined;
    if (result.ok && !inlinePkf?.contentBlocks && scratchDir) {
      const markerOutcome = await resolvePkfReplyInlineBlocks(scratchDir, replyInlineReadRoots);
      if (markerOutcome && 'warn' in markerOutcome) {
        process.stderr.write(
          `[daemon] pkf-reply-inline marker NOT emitted task=${taskId} reason=${markerOutcome.reason}\n`,
        );
      } else if (markerOutcome) {
        markerInlineBlocks = markerOutcome.contentBlocks;
      }
    }
    const inlineContentBlocks = inlinePkf?.contentBlocks ?? markerInlineBlocks;
    // product210/03 W1-2 (C2 断双写, ruling R10/A): the post-turn classifier
    // input must NOT carry the deliverable's canonical PKF source. The author
    // agent distills deliverable knowledge IN-TURN via the explicit
    // memory_write lane (ruling A: pure directive autonomy); feeding the full
    // source to the classifier re-created the double-write failure mode
    // (30ef4464e) — re-extracting canonical bytes into shadow pages. Classifier
    // input regresses to the reply text; deliverable provenance rides the
    // terminal silent asset copy (W1-3) + contentBlocks on the wire, not here.
    const durabilityAssistantResponse = inlinePkf?.replyText ?? result.output ?? '';
    // product210/03 W1-3 (R12) — terminal silent archive of the validated
    // inline deliverable bytes as agent-output assets. Idempotent by
    // contentHash inside the uploader; ids ride pkfArchiveAssetIds (NEVER
    // assetIds — no chat double-display) so the deliverable ledger and G9
    // derived-from pointers have a stable artifact target.
    let pkfArchiveAssetIds: string[] | undefined;
    if (deps.uploadInlinePkfArchive && inlineContentBlocks?.length) {
      try {
        const archived = await deps.uploadInlinePkfArchive({
          workspaceId: profile.workspaceId,
          taskId,
          blocks: inlineContentBlocks.map((b) => ({ title: (b as { title?: string | null }).title ?? null, source: b.source })),
        });
        if (archived.length > 0) pkfArchiveAssetIds = archived;
      } catch (err) {
        process.stderr.write(`[daemon] pkf archive upload failed task=${taskId}: ${(err as Error).message}\n`);
      }
    }
    reply = {
      taskId,
      // 2026-05-24 — when approval / reaper is in play we MUST send ok=false
      // even if the adapter optimistically returned ok=true. Before this
      // fix, hermes adapter returned ok:true with `metadata.approvalRequested`
      // signal; dispatch.ts derived finalError.code='awaiting_human_approval'
      // but forwarded ok=true unchanged. Cloud handler then took the
      // `if (payload.ok)` branch → marked the task `completed`, silently
      // skipped the awaiting-approval system_event, and the user saw the
      // task finish without a visible reply. The note above was the design
      // intent; this line now actually implements it.
      ok: approvalRequested || reaperAborted ? false : result.ok,
      output: inlinePkf?.replyText ?? result.output,
      ...(inlineContentBlocks ? { contentBlocks: inlineContentBlocks } : {}),
      error: finalError,
      ...(collectedAssetIds.length > 0 ? { assetIds: collectedAssetIds } : {}),
      ...(pkfArchiveAssetIds ? { pkfArchiveAssetIds } : {}),
      metrics: result.metrics,
      ...(llmMetadata ? { llmMetadata } : {}),
      ...(assetResolution.observability.length > 0 || urlObservations.length > 0
        ? { assetObservability: [...assetResolution.observability, ...urlObservations] }
        : {}),
      ...(collectedRejections.length > 0 ? { outboxRejections: collectedRejections } : {}),
    };
    // product209 D14 — a successful adapter result is not allowed onto the
    // wire until its authoritative Memory classification has reached a
    // bounded terminal state.  The structured receipt is carried on the same
    // terminal envelope; model prose is never treated as persistence proof.
    // product210/03 journey fix — routing context for the durability barrier:
    // adapter-reported values first, profile fallback second (the profile IS
    // the routing authority; see the memory_identity_invalid note below).
    const routingModel =
      stringFrom(llmMetadata?.modelUsed) ??
      stringFrom((profile.config as { model?: unknown }).model) ??
      undefined;
    const routingProvider = stringFrom(llmMetadata?.providerUsed) ?? 'prismer-gateway';
    // B-P0 — hand the terminal attempt + resolved routing to the finally{}
    // block for the turn.* emit (variables declared before the try).
    turnTerminalResult = result;
    turnRoutingModel = routingModel;
    turnRoutingProvider = routingProvider;
    if (reply.ok && deps.preReplyDurabilityBarrier) {
      const resultMetadata = result.metadata as Record<string, unknown> | undefined;
      const durabilityPolicy = resolveReplyDurabilityPolicy({
        userMessage: payload.prompt,
        resultMetadata,
      });
      const hermesMetadata = resultMetadata?.hermes as Record<string, unknown> | undefined;
      const providerTurnId =
        stringFrom(hermesMetadata?.runId) ??
        stringFrom(resultMetadata?.providerTurnId) ??
        stringFrom(resultMetadata?.runId);
      const messageId =
        stringFrom(payload.metadata?.triggerMessageId) ??
        stringFrom(payload.metadata?.replyToMessageId) ??
        stringFrom(payload.metadata?.messageId);
      // Pure task/agent_run dispatches are not always born from an IM message.
      // The Cloud task id is still the authoritative user prompt envelope for
      // this turn, so use it as the message identity fallback instead of
      // dead-lettering a valid desktop agent run as no_message_id.
      const durabilityMessageId = messageId ?? taskId;
      const roleTemplateSlug = stringFrom((profile.config as { roleTemplate?: { slug?: unknown } }).roleTemplate?.slug);
      try {
        const durability = await deps.preReplyDurabilityBarrier({
          workspaceId: profile.workspaceId,
          agentImUserId: payload.agentImUserId ?? profile.agentImUserId,
          ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
          canonicalTurnId: dispatchRunId ?? taskId,
          ...(dispatchRunId ? { runId: dispatchRunId } : {}),
          messageId: durabilityMessageId,
          turnId: providerTurnId ?? dispatchRunId ?? taskId,
          ...(providerTurnId ? { providerTurnId } : {}),
          userMessage: payload.prompt,
          assistantResponse: durabilityAssistantResponse,
          toolFailures: [],
          terminalState: 'completed',
          lane: 'pre-reply',
          profileId: profile.id,
          profileName: profile.name,
          // product210/03 journey fix — session-based hermes turns surface no
          // modelUsed/providerUsed metadata; without a fallback the durability
          // barrier dead-letters `memory_identity_invalid`
          // (invalid_context:no_model,no_provider) and the post-turn lane
          // writes NOTHING while the reply still reports ok=true. The profile
          // IS the routing authority: fall back to it.
          ...(routingModel ? { model: routingModel } : {}),
          ...(routingProvider ? { provider: routingProvider } : {}),
          executionContext: {
            adapterName: profile.adapterName,
            profileId: profile.id,
            profileName: profile.name,
            ...(roleTemplateSlug ? { roleSlug: roleTemplateSlug } : {}),
            ...(routingModel ? { model: routingModel } : {}),
            ...(routingProvider ? { provider: routingProvider } : {}),
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(collectedAssetIds.length > 0 ? { attachedAssetIds: collectedAssetIds } : {}),
          },
        });
        reply.durability = durability;
        const durabilityFailureState =
          durability.state === 'retryable_failure' || durability.state === 'terminal_failure'
            ? durability.state
            : durability.state === 'skipped_duplicate' &&
                (durability.duplicateOf?.state === 'retryable_failure' ||
                  durability.duplicateOf?.state === 'terminal_failure')
              ? durability.duplicateOf.state
              : undefined;
        if (durabilityFailureState && durabilityPolicy === 'required') {
          reply.ok = false;
          reply.error = {
            code: 'memory_write_failed',
            message:
              `Durable Memory was not committed before reply (${durability.error?.code ?? durabilityFailureState}): ` +
              `${durability.error?.message ?? 'authoritative write did not reach a durable terminal state'}`,
          };
        } else if (durabilityFailureState) {
          process.stderr.write(
            `[daemon] pre-reply durability non-blocking failure task=${taskId} ` +
              `policy=${durabilityPolicy} state=${durabilityFailureState} ` +
              `code=${durability.error?.code ?? durabilityFailureState}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const canonicalTurnId = dispatchRunId ?? taskId;
        const agentSubject = payload.agentImUserId ?? profile.agentImUserId;
        reply.durability = {
          commitKey: canonicalDurabilityCommitKey({
            workspaceId: profile.workspaceId,
            agentImUserId: agentSubject,
            canonicalTurnId,
          }),
          postTurnKey: `post-turn:${profile.workspaceId}:${agentSubject}:${canonicalTurnId}`,
          canonicalTurnId,
          ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
          ...(dispatchRunId ? { runId: dispatchRunId } : {}),
          messageId: durabilityMessageId,
          profileId: profile.id,
          profileName: profile.name,
          ...(llmMetadata?.modelUsed ? { model: llmMetadata.modelUsed } : {}),
          ...(llmMetadata?.providerUsed ? { provider: llmMetadata.providerUsed } : {}),
          state: 'terminal_failure',
          receipts: [],
          error: { code: 'memory_barrier_unavailable', message },
          timeoutMs: 0,
          replyCommittedAt: Date.now(),
        };
        if (durabilityPolicy === 'required') {
          reply.ok = false;
          reply.error = {
            code: 'memory_write_failed',
            message: `Durable Memory was not committed before reply (memory_barrier_unavailable): ${message}`,
          };
        } else {
          process.stderr.write(
            `[daemon] pre-reply durability non-blocking failure task=${taskId} ` +
              `policy=${durabilityPolicy} state=terminal_failure code=memory_barrier_unavailable\n`,
          );
        }
      }
    }
    await writeBridgeMetadata(payload.taskId, deps.cloud, result.metadata, deps.signal);
    await writeObservabilityMetadata(
      payload.taskId,
      deps.cloud,
      taskInput.metadata?.prismerObservability as Record<string, unknown> | undefined,
      deps.signal,
    );
  } catch (err) {
    // Classify so the cloud can tell apart a TRANSIENT infra/precondition
    // failure (re-queueable — daemon warm-up 404, rate-limit, network) from a
    // real adapter/execution failure (terminal). resolveProfileResilient
    // already rode out short transient windows; if it still threw here the
    // window outlasted our in-process retries and the cloud should suspend +
    // redeliver rather than show a terminal "Agent failed" pill.
    // (release202 — HTTP 404 dispatch postmortem.)
    const transient = isTransientPreconditionError(err);
    reply = {
      taskId,
      ok: false,
      error: {
        code: transient ? 'dispatch_precondition_unavailable' : 'adapter_dispatch_failed',
        message: (err as Error).message,
      },
    };
  } finally {
    // pkf209 — release the pkf_reply_inline tool scope bound for this
    // dispatch (unbinding only our own task's scope, so a hypothetical
    // concurrent same-agent dispatch is never clobbered).
    if (replyInlineAgentKey) unbindPkfReplyInlineScope(replyInlineAgentKey, taskId);
    // Wave-3 D2 — drain step recorder + stop heartbeat loop.
    // Order matters: flush the recorder FIRST so the trailing reasoning
    // buffer hits the wire BEFORE the heartbeat timer stops (heartbeat
    // dying does not affect step delivery, but we want the timeline to
    // include the final flush). Both calls are idempotent and best-effort.
    try {
      recorderRef?.flush();
    } catch (err) {
      process.stderr.write(`[daemon] step recorder flush failed task=${taskId}: ${(err as Error).message}\n`);
    }
    try {
      heartbeatRef?.stop();
    } catch (err) {
      process.stderr.write(`[daemon] heartbeat stop failed task=${taskId}: ${(err as Error).message}\n`);
    }

    // Unpin every resolved hash so LRU eviction can reclaim space.
    for (const hash of new Set(resolvedHashes)) {
      try {
        deps.assetCache.unpin(hash);
      } catch {
        /* row may have been evicted already */
      }
    }
    // Wave-9: handoff cleanup. Detach **this dispatch's** task slot —
    // leaving it set means stray writes to the (still-existing) artifacts
    // dir would be tagged for the wrong task on the next tick.
    //
    // Host-mode uses `removeActiveTask(taskId)` which only touches this
    // dispatch's slot. Critical: we must NOT call `setActiveTask(null)`
    // here — that would clobber any concurrent dispatch's slot too
    // (orchestrator finishing first would silently lose its still-running
    // worker's artifacts tracking).
    //
    // Legacy container-mode (no per-task artifactsDir) clears the legacy
    // slot via `setActiveTask(null)` — single-slot semantics there are
    // correct because container deployments serialize.
    //
    // Best-effort drain (any unflushed assetIds become orphans, but
    // they're already uploaded to cloud so the asset rows still exist;
    // the user just doesn't see them in this dispatch's chat reply).
    if (deps.artifactsWatcher) {
      const orphaned = deps.artifactsWatcher.flushPending(taskId);
      if (orphaned.length > 0) {
        process.stderr.write(
          `[daemon] artifacts: ${orphaned.length} late assetIds for task ${taskId} not surfaced in reply (uploaded but unflushed)\n`,
        );
      }
      // P1-2: discard any rejection records that didn't make it onto the
      // reply (e.g. dispatch threw before the reply branch ran). Without
      // this, a later dispatch for the same taskId could pick up stale
      // rejections from a prior failed turn.
      const orphanedRejections = flushArtifactsRejections(taskId);
      if (orphanedRejections.length > 0) {
        process.stderr.write(
          `[daemon] artifacts: dropped ${orphanedRejections.length} unflushed rejection records for task ${taskId}\n`,
        );
      }
      if (artifactsDir) {
        deps.artifactsWatcher.removeActiveTask(taskId);
      } else {
        deps.artifactsWatcher.setActiveTask(null);
      }
    }

    // release201/11 §4 #10 + #7 — emit daemon-side metrics.
    //
    //   #10 agent.dispatch  → one event, value = duration_ms
    //   #7  skill.invoked   → one event per loaded skill (slug-level, v2.0.7
    //                         "load-into-dispatch ≈ invoked" proxy semantics;
    //                         see 11-doc §4 footnote #7)
    //
    // Fire-and-forget: we do NOT await the cloud batch ingest. Daemon
    // dispatch reply latency must not include observability network cost.
    // The helper falls back to per-agent metrics.jsonl outbox on cloud
    // failure (release201/11 §7.0); the v2.0.8 metric-pump worker will
    // replay those on reconnect.
    //
    // We skip emit entirely when no workspaceId resolved (cloud /batch
    // would reject WORKSPACE_REQUIRED). In practice this only happens when
    // resolveProfile threw before assigning dispatchWorkspaceId — exactly
    // the dispatches we don't want to count toward agent.dispatch latency
    // anyway (the agent itself never actually ran).
    if (dispatchWorkspaceId && agentImUserId) {
      const dispatchDurationMs = Date.now() - dispatchStartMs;
      const events: DaemonMetricEmit[] = [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: dispatchDurationMs,
          dims: {
            workspaceId: dispatchWorkspaceId,
            agentId: agentImUserId,
            taskId,
            ...(dispatchProjectId ? { projectId: dispatchProjectId } : {}),
            ...(payload.capability ? { capability: payload.capability } : {}),
          },
        },
        // release203/22 W1 — one `skill.invoked` per REAL tool call this
        // dispatch, keyed by the true tool name (`slug`). value carries the
        // call count so both `count` and `sum` aggregations are honest; the
        // BFF groups by `slug`. No tool calls → no rows (honest "didn't use
        // anything"), never the old uniform-per-loaded-skill noise.
        ...[...toolInvokeCounts.entries()].map<DaemonMetricEmit>(([toolName, count]) => ({
          namespace: 'skill',
          name: 'invoked',
          value: count,
          dims: {
            workspaceId: dispatchWorkspaceId!,
            agentId: agentImUserId,
            slug: toolName,
            taskId,
          },
        })),
      ];
      // B-P0 turn metrics — per-turn token / cache / latency / tool-call
      // counters, emitted alongside agent.dispatch in the SAME fire-and-forget
      // batch. The names are a downstream contract (registry entries in
      // src/im/services/metric-registry.ts; TurnMetricsService + SDK aggregate
      // read them), so rename only with the registry.
      //
      // Usage is the LAST attempt's hermes usage only: retry inflation (tokens
      // re-billed across the local retry loop) is carried by agent.dispatch's
      // wall-clock value and must NOT compound into turn.*.
      try {
        if (turnTerminalResult) {
          const turnUsage = (
            (turnTerminalResult.metadata as { hermes?: { usage?: Record<string, unknown> } } | undefined)?.hermes ??
              {}
          ).usage;
          const usageNum = (key: string): number | undefined => {
            const v = turnUsage?.[key];
            return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
          };
          const turnDims = {
            workspaceId: dispatchWorkspaceId,
            agentId: agentImUserId,
            taskId,
            ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
            ...(turnRoutingModel ? { model: turnRoutingModel } : {}),
            ...(turnRoutingProvider ? { provider: turnRoutingProvider } : {}),
            // Terminal state of the adapter attempt (this branch is only
            // reached when an attempt actually ran to a result).
            status: turnTerminalResult.ok ? 'ok' : 'error',
          };
          const turnEvents: DaemonMetricEmit[] = [
            { namespace: 'turn', name: 'count', value: 1, dims: turnDims },
            {
              namespace: 'turn',
              name: 'tool_calls',
              value: [...toolInvokeCounts.values()].reduce((sum, count) => sum + count, 0),
              dims: turnDims,
            },
          ];
          // Token metrics exist only when hermes reported usage, and per-field
          // so an absent counter (e.g. cache on a non-caching provider) never
          // pollutes sum/avg with zeros.
          const tokenMetrics: Array<[string, number | undefined]> = [
            ['tokens_input', usageNum('inputTokens')],
            ['tokens_output', usageNum('outputTokens')],
            ['tokens_cache_read', usageNum('cacheReadTokens')],
            ['tokens_cache_write', usageNum('cacheWriteTokens')],
          ];
          for (const [name, value] of tokenMetrics) {
            if (value !== undefined) turnEvents.push({ namespace: 'turn', name, value, dims: turnDims });
          }
          if (Number.isFinite(turnTerminalResult.metrics?.durationMs)) {
            turnEvents.push({
              namespace: 'turn',
              name: 'duration_ms',
              value: turnTerminalResult.metrics!.durationMs,
              dims: turnDims,
            });
          }
          if (Number.isFinite(turnTerminalResult.metrics?.firstEventMs)) {
            turnEvents.push({
              namespace: 'turn',
              name: 'first_event_ms',
              value: turnTerminalResult.metrics!.firstEventMs,
              dims: turnDims,
            });
          }
          // memory211/01 §6.11 D11-4 (W7 item 4) — did 渐进披露 / the
          // direct-recall shortcut actually HAPPEN this turn? The daemon's
          // memory RPC records every search/load/browse/write it served (verb +
          // page path + duration only, never query content) into a per-workspace
          // ring; the slice inside this dispatch's window answers the question.
          // Both rows exist only when the turn made at least one memory call —
          // the same honest-absence posture as the token metrics above.
          const memoryTurn = summarizeToolTurnFor(dispatchWorkspaceId, dispatchStartMs);
          if (memoryTurn) {
            turnEvents.push({
              namespace: 'turn',
              name: 'navigation_used',
              value: memoryTurn.navigationUsed,
              dims: turnDims,
            });
            turnEvents.push({
              namespace: 'turn',
              name: 'shortcuts_taken',
              value: memoryTurn.shortcutsTaken,
              dims: turnDims,
            });
          }
          // memory211/03 §7.2 B4 (B-3) — the R5 first-round questions: did the
          // turn START hybrid (batch search >=2 queries AND browse in the same
          // first tool round), take the direct-recall shortcut (first round =
          // load with no browse before it), or cost how many tool rounds
          // (a round = the batch issued within R5_ROUND_GAP_MS). Analysis
          // lives daemon-side next to the ring (tool-sequence.ts
          // summarizeR5Turn), the cloud metric-registry is contract authority.
          // Same null-for-empty posture as above: no memory call ⇒ no row.
          const r5Turn = summarizeR5TurnFor(dispatchWorkspaceId, dispatchStartMs);
          if (r5Turn) {
            turnEvents.push({
              namespace: 'turn',
              name: 'first_round_hybrid',
              value: r5Turn.firstRoundHybrid,
              dims: turnDims,
            });
            turnEvents.push({
              namespace: 'turn',
              name: 'first_round_direct_read',
              value: r5Turn.firstRoundDirectRead,
              dims: turnDims,
            });
            turnEvents.push({
              namespace: 'turn',
              name: 'tool_rounds',
              value: r5Turn.toolRounds,
              dims: turnDims,
            });
          }
          events.push(...turnEvents);
        }
      } catch {
        /* observability path is best-effort; a turn-metric failure must never
           reach the dispatch reply. */
      }
      // Fire-and-forget. .catch swallows so we don't fail the dispatch on
      // observability path errors. The helper itself never throws but a
      // synchronous failure (e.g. AbortSignal already aborted at this
      // point) could surface as a rejected promise.
      void daemonMetricEmit(events, {
        cloud: deps.cloud,
        paths: deps.paths,
        daemonId: deps.daemonId,
        agentImUserId,
        signal: deps.signal,
      }).catch(() => {
        /* observability path is best-effort; never bubble. */
      });
    }
    // A terminal reply (success, failure, or cancellation) settles this local
    // recovery record. A hard process crash never reaches finally, leaving the
    // checkpoint for startup host_crashed synthesis.
    checkpointStore?.deleteCheckpoints(taskId);
  }

  // S6/M1 — degenerate deltas-fallback signature (contract note at
  // interimRelayArmed): the terminal output replays the already-relayed
  // commentary segments verbatim, i.e. upstream commentary leaked into the
  // output path. Frames already sent cannot be retracted (fire-and-forget
  // mid-stream), so the daemon-side disposal is this grep-able marker only;
  // the frame plan stays on the I1-I6 standard and render-side dedup for the
  // signature belongs to the cloud layer.
  if (
    interimRelayArmed &&
    interimSeq > 0 &&
    reply.ok &&
    typeof reply.output === 'string' &&
    reply.output.length > 0 &&
    reply.output === interimSegments.join('')
  ) {
    traceLog(
      `[daemon] interim relay degenerate turn task=${taskId}: final output replays ${interimSeq} already-relayed commentary segment(s) verbatim (${reply.output.length} chars) — IM surface may double-render this turn`,
    );
  }
  // S6/M1 — the ONE terminal frame of the turn: I2-marked when interim frames
  // went out, byte-identical legacy shape otherwise (I3).
  reply = markTerminalReply(reply);
  sendReply(deps.ws, reply, requestId);
  // release201/30 §7 Phase 3 — bookend matching the entry trace line so
  // operators can sanity-check (a) which traces survived and (b) duration
  // delta against `dispatchStartMs` without correlating across files.
  traceLog(`[daemon] dispatch end task=${taskId} ok=${reply.ok} duration_ms=${Date.now() - dispatchStartMs}`);
  // For caller (tests, runner observation).
  void agentImUserId;
  return reply;
}

function sendReply(ws: WsClient, reply: TaskDispatchReplyPayload, requestId: string | undefined): void {
  ws.send(envelope('task.dispatch.reply', reply, requestId));
}

/**
 * S6/M1 — interim frame (I1): one relayed commentary segment leaves as
 * `{ taskId, ok: true, output: <segment>, seq, final: false }`. Never fails
 * the turn (I6) — callers treat the ws.send as best-effort.
 */
export function buildInterimFrame(taskId: string, segment: { text: string; seq: number }): TaskDispatchReplyPayload {
  return { taskId, ok: true, output: segment.text, seq: segment.seq, final: false };
}

/**
 * S6/M1 — terminal-frame marking (I2): on a multi-frame turn the ONE terminal
 * reply is stamped `seq: lastInterimSeq + 1` + `final: true`, whatever its
 * ok/error shape. Applied at every reply exit through the
 * `interimSeq > 0` guard in handleDispatch; while no interim frame went out
 * it must NOT be called, so the legacy single-frame shape stays byte-identical
 * (I3 — no seq/final keys on the wire at all).
 */
export function markTerminalFrame(reply: TaskDispatchReplyPayload, lastInterimSeq: number): TaskDispatchReplyPayload {
  return { ...reply, seq: lastInterimSeq + 1, final: true };
}

/**
 * P2 (2026-05-24): retry-loop helpers.
 *
 * Approval suspension is a valid pause — the human still has to decide, so
 * retrying would just push the same agent submission. User cancel is an
 * explicit transition; retrying would defeat the cancel. Both are final.
 */
function isApprovalSuspension(result: TaskResult): boolean {
  return result.error?.code === 'awaiting_human_approval';
}

function isUserCancel(result: TaskResult): boolean {
  return result.error?.code === 'task_cancelled';
}

/**
 * memory203/18 W5 (final-round5 P0) — `empty_reply` from the hermes sessions
 * dispatcher: the turn "completed" with zero user-visible content and nothing
 * was recoverable from the session transcript. Retrying would re-send the
 * same (possibly ~120k-token) prompt into the SAME polluted session — the
 * exact pattern that produced the silent duplicate generation in the first
 * place — so it is terminal: the ok=false reply flows to the cloud, which
 * posts a VISIBLE "Agent failed" system event instead of a phantom
 * completion with an empty DM.
 */
export function isEmptyReplyFailure(result: TaskResult): boolean {
  return result.error?.code === 'empty_reply';
}

/**
 * release203/27 S10 — the hermes sessions single-flight guard rejected a
 * concurrent turn on the same (conversation, agent) session. Carries the
 * transient `dispatch_precondition_unavailable` code + a `session_busy` hermes
 * status marker so it exits the local retry loop and rides the cloud's
 * requeueTransientRun channel (spaced re-delivery) rather than being retried
 * locally against the still-busy session.
 */
export function isSessionBusyTransient(result: TaskResult): boolean {
  if (result.error?.code !== 'dispatch_precondition_unavailable') return false;
  const hermes = (result.metadata as { hermes?: { status?: string } } | undefined)?.hermes;
  return hermes?.status === 'session_busy';
}

/**
 * release202/12: an upstream LLM failure (`upstream_llm_error`, from
 * hermes/sessions-dispatcher) that retrying CANNOT fix — provider chain
 * unconfigured, or a permanent 4xx (auth / unknown model / bad request).
 * Hermes already exhausted its own retries before emitting this, so re-running
 * the whole session for a permanent cause just wastes ~4s and buries the real
 * reason under `daemon_local_retry_exhausted`. Transient upstream failures
 * (429 / 5xx / network) stay retryable.
 */
export function isPermanentUpstreamError(result: TaskResult): boolean {
  if (result.error?.code !== 'upstream_llm_error') return false;
  const msg = result.error.message ?? '';
  // Key on the human message WORDING, not a machine token — hermes'
  // `_summarize_provider_error` drops the JSON `error.type`, so the cloud's
  // `provider_chain_unconfigured` type never reaches us; its message wording
  // ("has no usable upstream source") does. Billing/credits exhaustion is an
  // HTTP 402 that won't fix on retry.
  if (/has no usable upstream source|provider_chain_unconfigured/i.test(msg)) return true;
  if (/Billing or credits exhausted/i.test(msg)) return true;
  const m = msg.match(/(?:^|[\s:])HTTP (\d{3})\b/);
  if (!m) return false;
  const status = Number(m[1]);
  // 402 = insufficient credits (release202/12 P1) — retrying won't add balance.
  return status === 400 || status === 401 || status === 402 || status === 403 || status === 404;
}

/**
 * memory203/18 R3.1 — classify a failure message as LIMITER-class: produced by
 * the cloud's own capacity gates rather than a broken upstream. Three known
 * producers (all reach the daemon as human-readable message text, usually
 * prefixed `HTTP <status>:` by hermes' `_summarize_api_error`):
 *   - workspace concurrency gate queue-full →
 *     HTTP 429 "Workspace LLM concurrency queue is full (depth N); retry shortly."
 *   - workspace concurrency gate slot-deadline →
 *     HTTP 504 "Workspace LLM concurrency slot not available before deadline; retry shortly."
 *   - RPM rate limiter → HTTP 429 "Rate limit exceeded. Limit: N/min. Retry in Ns."
 * A bare `HTTP 429` also counts (any 429 is by definition backpressure). A
 * bare `HTTP 504` does NOT — a generic gateway timeout without the
 * slot-deadline wording is an upstream failure, not our limiter, and stays on
 * the terminal `daemon_local_retry_exhausted` path.
 *
 * memory203/18 W4 — a fourth producer: the sessions-SSE in-flight stall
 * watchdog (`sessions-sse.ts` createStallGuard, "upstream stall: no events
 * for Ns"). A silent upstream hang is transient capacity/provider pressure,
 * same as a limiter shed: retry with the jittered windows, and on exhaustion
 * ride the `dispatch_precondition_unavailable` requeue channel instead of
 * failing permanently (the W2-gate's 3/18 permanent burst failures were all
 * reaper-killed silent stalls that never re-entered any retry lane).
 * W5 — the watchdog is two-phase now; the pre-first-token wording
 * ("no first event for Ns") rides the same lane.
 */
export function isLimiterClassError(message: string | null | undefined): boolean {
  if (!message) return false;
  if (/concurrency queue is full/i.test(message)) return true;
  if (/slot not available before deadline/i.test(message)) return true;
  if (/rate limit exceeded/i.test(message)) return true;
  if (/upstream stall: no (?:first event|events) for/i.test(message)) return true;
  const m = message.match(/(?:^|[\s:(])HTTP (\d{3})\b/);
  return m ? Number(m[1]) === 429 : false;
}

/**
 * memory203/18 R3.2 — extract an explicit retry-after hint from a failure
 * message. Understands `Retry-After: <n>` (header echoed into text) and the
 * rate-limiter's human wording `Retry in <n>s`. Clamped to 60s so a
 * misparsed/hostile value can't park the dispatch loop.
 */
export function parseRetryAfterMs(message: string | null | undefined): number | undefined {
  if (!message) return undefined;
  const m = message.match(/retry[- ]after[:=\s]+(\d+(?:\.\d+)?)/i) ?? message.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  if (!m) return undefined;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return undefined;
  return Math.min(Math.round(sec * 1000), 60_000);
}

// Non-limiter backoff — wait BEFORE attempt 2 (idx 0) and 3 (idx 1).
const RETRY_BACKOFF_MS = [1_000, 3_000];
// Limiter-class jitter windows [lo, hi] — BEFORE attempt 2 and 3.
const LIMITER_BACKOFF_WINDOWS_MS: Array<[number, number]> = [
  [3_000, 6_000],
  [8_000, 15_000],
];

/**
 * memory203/18 R3.2 — resolve the backoff before retry `attempt` (2-based).
 * Limiter-class errors honor an explicit Retry-After when present, else use
 * the longer jittered windows; everything else keeps the legacy [1s, 3s].
 * `PRISMER_DISPATCH_RETRY_BACKOFF_MS` (comma list, ms) overrides ALL classes —
 * ops tuning + deterministic tests.
 */
export function resolveRetryBackoffMs(attempt: number, lastErrorMessage: string | null | undefined): number {
  const idx = Math.max(0, attempt - 2);
  const raw = process.env.PRISMER_DISPATCH_RETRY_BACKOFF_MS;
  if (raw) {
    const parts = raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (parts.length > 0) return parts[Math.min(idx, parts.length - 1)]!;
  }
  if (isLimiterClassError(lastErrorMessage)) {
    const retryAfter = parseRetryAfterMs(lastErrorMessage);
    if (retryAfter !== undefined) return retryAfter;
    const [lo, hi] = LIMITER_BACKOFF_WINDOWS_MS[Math.min(idx, LIMITER_BACKOFF_WINDOWS_MS.length - 1)]!;
    return lo + Math.random() * (hi - lo);
  }
  return RETRY_BACKOFF_MS[idx] ?? 9_000;
}

/**
 * memory203/18 R3.3 — compact machine-ish token for the retry progress phase
 * (`retrying(attempt=N, reason=429)`). HTTP status when the message carries
 * one, else a short class token.
 */
export function retryReasonToken(message: string | null | undefined): string {
  if (!message) return 'error';
  // W4 — stall-watchdog aborts carry no HTTP status; surface a dedicated
  // token so the progress frame reads `retrying(attempt=N, reason=stall)`.
  // W5 — covers both phases ("no first event for" / "no events for").
  if (/upstream stall: no (?:first event|events) for/i.test(message)) return 'stall';
  const m = message.match(/(?:^|[\s:(])HTTP (\d{3})\b/);
  if (m) return m[1]!;
  if (/rate limit exceeded/i.test(message)) return '429';
  return 'error';
}

/**
 * Sleep that resolves early when the abort signal fires. Used by the dispatch
 * retry loop so a reaper / user cancel during backoff doesn't wait out the
 * full delay before bailing.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    handle.unref?.();
    const onAbort = () => {
      clearTimeout(handle);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A dispatch precondition (profile fetch, skill/context load) failed with an
 * error that is very likely TRANSIENT — a cloud cold-start / daemon-reconnect
 * auth-warmup window, a rate-limit, or a network blip — rather than a real
 * permanent misconfiguration. Such failures should be retried in-process and,
 * if they outlast our retries, re-queued by the cloud instead of being
 * surfaced to the user as a terminal "Agent failed" pill.
 *
 * 404 is included deliberately: the cloud only emits a dispatch with a
 * `profileId` it JUST resolved, so a 404 on the daemon's profile re-fetch is
 * almost always a warm-up identity race (the daemon's api-key-proxy identity
 * isn't hot yet so the owner-scoped lookup misses), NOT a deleted profile.
 * 400 / 401 / 403 stay PERMANENT — those are real validation / auth failures
 * that won't fix on retry. (release202 — HTTP 404 dispatch postmortem.)
 */
export function isTransientPreconditionError(err: unknown): boolean {
  if (err instanceof CloudError) {
    const s = err.status;
    if (s === undefined || s === null || Number.isNaN(s) || s === 0) return true; // network / abort
    if (s === 404 || s === 408 || s === 429) return true;
    if (s >= 500) return true;
    if (err.code === 'cloud_unreachable') return true;
    return false;
  }
  return false;
}

/**
 * runtime210/09 review P2-2 — NETWORK-CLASS precondition failures only. This
 * is the narrower predicate the local mirror fallback is allowed to serve on:
 * the cloud was never able to give an authoritative answer (no HTTP status —
 * fetch aborted / unreachable — or a server-side 5xx outage). An HTTP status
 * the cloud DID authoritatively answer (404 / 408 / 429 after retries) is a
 * REAL verdict — 404 means the profile is genuinely absent — and a stale
 * mirror row must not shadow it (it would keep dispatching a retired agent).
 */
export function isNetworkClassPreconditionError(err: unknown): boolean {
  if (!(err instanceof CloudError)) return false;
  const s = err.status;
  if (s === undefined || s === null || Number.isNaN(s) || s === 0) return true; // network / abort
  if (err.code === 'cloud_unreachable') return true;
  if (s >= 500) return true;
  return false;
}

// ~5s total across 4 attempts — long enough to ride out a daemon-reconnect
// auth-warmup window, short enough not to stall a real dispatch noticeably.
const PRECONDITION_RETRY_BACKOFF_MS = [500, 1500, 3000];

/**
 * Resolve the agent profile, retrying TRANSIENT cloud failures with backoff.
 * Permanent errors (400/401/403, missing-agent) throw immediately. This closes
 * the warm-up window where a freshly-(re)connected daemon's first profile fetch
 * 404s before its auth identity is hot — the failure mode behind the
 * "Agent 失败 … HTTP 404" report. (release202 — HTTP 404 dispatch fix.)
 */
export async function resolveProfileResilient(
  payload: TaskDispatchRequestPayload,
  cloud: CloudClient,
  signal?: AbortSignal,
  resolveLocalProfile?: (input: { profileId?: string; agentImUserId?: string }) => AgentProfile | null,
): Promise<AgentProfile> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PRECONDITION_RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await abortableSleep(PRECONDITION_RETRY_BACKOFF_MS[attempt - 1]!, signal);
      if (signal?.aborted) throw lastErr ?? new Error('dispatch aborted during profile retry');
    }
    try {
      return await resolveProfile(payload, cloud);
    } catch (err) {
      lastErr = err;
      if (!isTransientPreconditionError(err)) throw err;
      process.stderr.write(
        `[daemon] resolveProfile transient failure ` +
          `(attempt ${attempt + 1}/${PRECONDITION_RETRY_BACKOFF_MS.length + 1}) ` +
          `task=${payload.taskId}: ${(err as Error).message}\n`,
      );
    }
  }
  // local-first fallback (m4 mirror): after cloud retries are exhausted, serve
  // the local agent_profiles mirror (host.acked / static binding) so standalone
  // or disconnected daemons can still dispatch through the unified pipeline.
  //
  // runtime210/09 review P2-2 — the mirror serves ONLY network-class failures
  // (cloud unreachable / no status / 5xx). An authoritative HTTP verdict that
  // outlasted retries (a persistent 404 — the profile genuinely does not
  // exist) must propagate: serving a stale local row would keep dispatching an
  // agent the cloud has retired.
  if (isNetworkClassPreconditionError(lastErr)) {
    const local = resolveLocalProfile?.({
      profileId: payload.profileId,
      agentImUserId: payload.agentImUserId,
    });
    if (local) {
      process.stderr.write(
        `[daemon] resolveProfile local mirror hit task=${payload.taskId} profile=${local.id} ` +
          `(cloud: ${(lastErr as Error)?.message ?? 'unreachable'})\n`,
      );
      return local;
    }
  }
  throw lastErr;
}

async function resolveProfile(payload: TaskDispatchRequestPayload, cloud: CloudClient): Promise<AgentProfile> {
  // Profile id may be empty when task was created without a mention; the daemon
  // is asked to resolve the agent's first profile in the workspace.
  if (payload.profileId) {
    return await cloud.get<AgentProfile>(`/api/im/agent_profiles/${encodeURIComponent(payload.profileId)}`);
  }
  if (!payload.agentImUserId) {
    throw new Error('agentImUserId is required for agent task dispatch');
  }
  const list = await cloud.get<AgentProfile[]>(
    `/api/im/agent_profiles?agentId=${encodeURIComponent(payload.agentImUserId)}`,
  );
  if (!list || list.length === 0) {
    throw new Error(`No AgentProfile found for agent ${payload.agentImUserId}`);
  }
  // Pick the most-recently-created profile to mirror cloud-side
  // `dispatchToAgent` (message.service.ts uses orderBy createdAt desc).
  // Without symmetry, the daemon and cloud could end up using different
  // profile configs for the same agent — exactly the failure mode that
  // pinned ENG to a stale hermes profile mid-session when we swapped to
  // openclaw. The cloud API doesn't guarantee an order, so we sort here.
  const ts = (v: unknown): number => {
    if (!v) return 0;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return Date.parse(v) || 0;
    return 0;
  };
  const sorted = [...list].sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  return sorted[0]!;
}

/**
 * Concatenate context entries + current prompt. Trims oldest entries first when
 * total chars exceed `maxChars` (matches Track C's `trimContextWindow` behavior).
 *
 * `assetBlocks` (Wave-8 W1) is prepended above the conversation history. They
 * are *not* counted against `maxChars` — assets are content the user
 * explicitly attached, so dropping them silently when the chat history
 * happens to be long would defeat the whole point of the attachment.
 */
export function composePrompt(
  currentPrompt: string,
  context: TaskDispatchContextEntry[],
  maxChars: number,
  assetBlocks: string[] = [],
): string {
  const assetSection = assetBlocks.length > 0 ? `${assetBlocks.join('\n\n')}\n\n` : '';

  if (context.length === 0) return `${assetSection}${currentPrompt}`;

  let entries = context;
  let total = entries.reduce((s, e) => s + e.content.length, 0);
  while (total > maxChars && entries.length > 1) {
    const dropped = entries[0]!;
    entries = entries.slice(1);
    total -= dropped.content.length;
  }

  const history = entries.map((e) => `[${e.senderRole}] @${e.sender}: ${e.content}`).join('\n');

  return `${assetSection}${history}\n\n[当前消息] ${currentPrompt}`;
}

/**
 * Wave-8 W1: classify a mime type as text-like.
 *
 * Conservative whitelist — `text/*`, JSON/XML/CSV/YAML siblings, and the
 * `+json|+xml|+csv` suffix RFC pattern. Anything else (image/*, audio/*,
 * application/pdf, application/zip, etc.) flows to the URI-only path.
 */
function isTextLikeMime(mime: string | null): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m.startsWith('text/')) return true;
  if (m === 'application/json' || m === 'application/xml' || m === 'application/csv') return true;
  if (m === 'application/yaml' || m === 'application/x-yaml') return true;
  if (m.endsWith('+json') || m.endsWith('+xml') || m.endsWith('+csv')) return true;
  return false;
}

function isImageMime(mime: string | null): boolean {
  if (!mime) return false;
  return mime.toLowerCase().split(';')[0]!.trim().startsWith('image/');
}

/**
 * M3: Resolve `#filename` references in prompt text to `prismer://` URIs.
 *
 * Two-pass algorithm:
 *   Pass 1 — Extract `#<ref>` tokens, filtering hex colors and likely hashtags.
 *   Pass 2 — Batch resolve against local AssetMetadataIndex, with cloud
 *            fallback for unresolved refs. Replace in single reverse-order pass.
 *
 * Hex color filter: 3-8 hex chars (e.g. #fff, #f0f0f0, #ff0000ff) are not
 * asset references. Similarly, tokens without a file extension that also have
 * no index match are treated as likely hashtags and left in place.
 *
 * Cloud fallback is essential for assets that were created on a different daemon
 * or after the most recent pullDelta — local index may be slightly stale.
 */
const HASH_REF_RE = /(?:^|\s)#([^\s#]+)/g;
const HEX_COLOR_RE = /^[0-9a-fA-F]{3,8}$/;
const FILE_EXT_RE = /\.[a-zA-Z0-9]{1,10}$/;
const TRAILING_PUNCT_RE = /[,.;:!?)\]}'"]+$/;

interface IndexSearchItem {
  assetId: string;
  contentHash: string;
  filename: string | null;
}

async function resolveHashRefs(
  prompt: string,
  assetIndex: AssetMetadataIndex,
  cloud: CloudClient,
): Promise<HashRefResult> {
  const resolutions: HashRefResolution[] = [];

  // ── Pass 1: Extract candidates ──
  const candidates: Array<{ ref: string; start: number; end: number; hasExtension: boolean }> = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(HASH_REF_RE.source, 'g');
  while ((match = re.exec(prompt)) !== null) {
    const refName = match[1]!;
    const leading = match[0].startsWith('#') ? 0 : 1;
    const start = match.index + leading;
    const end = match.index + match[0].length;

    // Hex color filter (3-8 hex chars, with or without alpha)
    if (HEX_COLOR_RE.test(refName)) continue;

    // Strip trailing punctuation that may have been captured (e.g. "#readme.md,")
    let cleanRef = refName;
    let stripped = '';
    const punctMatch = TRAILING_PUNCT_RE.exec(cleanRef);
    if (punctMatch) {
      stripped = punctMatch[0];
      cleanRef = cleanRef.slice(0, -stripped.length);
    }
    if (!cleanRef) continue; // e.g. "#," or "#." with nothing else
    // Recheck hex after stripping (e.g. "#fff;" → stripped "fff" is hex)
    if (HEX_COLOR_RE.test(cleanRef)) continue;

    const hasExtension = FILE_EXT_RE.test(cleanRef);
    candidates.push({ ref: cleanRef, start, end: end - stripped.length, hasExtension });
  }

  if (candidates.length === 0) {
    return { text: prompt, resolutions: [] };
  }

  // ── Pass 2: Resolve ──
  const allFilenames = candidates.map((c) => c.ref);
  const localResults = assetIndex.resolveByFilenames(allFilenames);

  // Extensionless refs: local-index-only (never hit cloud — would waste API calls
  // on social hashtags). Extensioned refs: local index then cloud fallback.
  const needsCloud = candidates.filter((c) => c.hasExtension && !localResults.has(c.ref));
  const cloudResults = new Map<string, string>();

  if (needsCloud.length > 0) {
    await Promise.allSettled(
      needsCloud.map(async (c) => {
        try {
          const items = await cloud.get<IndexSearchItem[]>(
            `/api/im/assets?workspaceId=${encodeURIComponent(assetIndex.workspaceId)}&q=${encodeURIComponent(c.ref)}&limit=1`,
          );
          if (Array.isArray(items) && items.length > 0) {
            const item = items[0]!;
            cloudResults.set(c.ref, item.contentHash);
          }
        } catch {
          // Cloud fallback failed silently — leave unresolved.
        }
      }),
    );
  }

  // Build resolution records for all candidates
  for (const c of candidates) {
    const local = localResults.get(c.ref);
    if (local) {
      resolutions.push({
        ref: c.ref,
        start: c.start,
        end: c.end,
        resolvedUri: `prismer://workspace/${encodeURIComponent(assetIndex.workspaceId)}/asset/${local.contentHash}`,
      });
    } else if (c.hasExtension) {
      const cloudHash = cloudResults.get(c.ref);
      resolutions.push({
        ref: c.ref,
        start: c.start,
        end: c.end,
        resolvedUri: cloudHash
          ? `prismer://workspace/${encodeURIComponent(assetIndex.workspaceId)}/asset/${cloudHash}`
          : undefined,
      });
    }
    // Extensionless refs not in index: silently leave as-is (likely hashtags)
  }

  // ── Single-pass replace (reverse offset order to preserve positions) ──
  let result = prompt;
  const sorted = [...resolutions].filter((r) => r.resolvedUri).sort((a, b) => b.start - a.start);
  for (const r of sorted) {
    result = result.slice(0, r.start) + r.resolvedUri + result.slice(r.end);
  }

  return { text: result, resolutions };
}

interface AssetResolution {
  /** Multiline blocks to splice into the prompt (one per asset). */
  promptBlocks: string[];
  /** Per-asset observability for the dispatch reply. */
  observability: AssetDispatchObservation[];
  /** Cache hashes pinned during resolution; caller unpins on completion. */
  pinnedHashes: string[];
  /**
   * 14b rev.3 §3.0.4 — refs surfaced to multimodal-aware adapters. Each ref
   * carries cdnUrl (when reachable) or base64 (when daemon prefetched the
   * bytes). The adapter is the one that decides how to translate this into
   * `image_url` / `input_image` / `input_file` wire shapes. Text-like assets
   * stay inlined in the prompt via `promptBlocks` (they don't appear here).
   */
  resolvedRefs: ResolvedAssetRef[];
}

interface VisionAuxResolveOptions {
  cloud: CloudClient;
  enabled: boolean;
  cacheDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface VisionAuxCachedDescription {
  description: string;
  modelUsed: string;
  provider: string;
  generatedAt: string;
  expiresAt: string;
  mime: string;
}

interface VisionAuxResponseEnvelope {
  ok?: boolean;
  data?: {
    description?: string;
    modelUsed?: string;
    provider?: string;
    cached?: boolean;
    cacheTtlSec?: number;
  };
  error?: string | { code?: string; message?: string };
  message?: string;
}

/** Max bytes we're willing to inline as base64 into an LLM request when
 *  cdnUrl is unreachable. Mirrors 14b §D35 / §3.0.1 — beyond 10 MB the
 *  request body itself becomes the latency bottleneck, so we stop inlining
 *  and surface an error block instead of silently shipping a 50 MB blob. */
const ASSET_BASE64_INLINE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 14b rev.3 §D35 — quick reachability probe so the adapter knows whether to
 * pass cdnUrl by reference or inline base64. We do ONE HEAD (or GET on HEAD
 * 405) with a tight timeout; in dev the probe will short-circuit to false
 * for `localhost`/`127.0.0.1` URLs the cloud LLM cannot reach anyway.
 *
 * Exported for tests and to let outboxes (Wave 4 hand-off) reuse the same
 * decision logic when they backfill multimodal results.
 */
export async function probeCdnReachable(cdnUrl: string, timeoutMs = 1_500): Promise<boolean> {
  // Skip obviously-unreachable local URLs (LLM provider can't see them).
  try {
    const u = new URL(cdnUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('192.168.')) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const r = await fetch(cdnUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) return true;
    // Some CDNs reject HEAD with 405; treat as "needs body GET" → mark
    // unreachable for safety. The adapter will use base64 fallback.
    return false;
  } catch {
    return false;
  }
}

/**
 * Wave-8 W1: hydrate `payload.assetRefs` into prompt-ready text blocks.
 *
 * Strategy decision per ref:
 *   - text-like + size ≤ 64 KiB → read full body, mark `inline-text`.
 *   - text-like + size > 64 KiB → read first 16 KiB UTF-8, mark
 *     `inline-text-truncated`.
 *   - other (image, pdf, archive, …) → expose `file://<cachePath>` and
 *     `mark `uri-only`. The adapter is responsible for reading it via its
 *     own tool — we do NOT lie and claim the asset is "consumed".
 *   - download / read failure → `error` strategy with the message.
 *
 * Returns prompt blocks in `assetRefs` order so the agent sees them
 * top-to-bottom in the same order the user attached them.
 */
async function resolveAssetRefs(
  refs: AssetRef[] | undefined,
  cache: AssetCache,
  taskId?: string,
  visionAux?: VisionAuxResolveOptions,
  fsCapable = false,
): Promise<AssetResolution> {
  const out: AssetResolution = {
    promptBlocks: [],
    observability: [],
    pinnedHashes: [],
    resolvedRefs: [],
  };
  if (!refs || refs.length === 0) return out;

  for (const ref of refs) {
    let cached: { localPath: string; sizeBytes: number; mime: string | null };
    try {
      cached = await cache.getOrFetch(ref.contentHash, {
        workspaceIdHint: ref.workspaceId,
        assetId: ref.assetId,
      });
    } catch (err) {
      const errMsg = (err as Error).message;
      logAssetResolveFailure(taskId, ref, errMsg);
      out.promptBlocks.push(formatErrorAssetBlock(ref, ref.mime, errMsg));
      out.observability.push({
        assetId: ref.assetId,
        contentHash: ref.contentHash,
        mime: ref.mime,
        sizeBytes: ref.sizeBytes,
        strategy: 'error',
        error: errMsg,
      });
      continue;
    }
    cache.pin(ref.contentHash);
    out.pinnedHashes.push(ref.contentHash);

    // Prefer the mime the cloud computed (it's the authoritative one in
    // im_assets); fall back to whatever the asset cache discovered from
    // the response Content-Type header.
    const effectiveMime = ref.mime ?? cached.mime;
    const inlineCandidate = isTextLikeMime(effectiveMime);

    if (inlineCandidate) {
      try {
        const buf = readFileSync(cached.localPath);
        let strategy: AssetDispatchStrategy;
        let body: string;
        if (buf.byteLength <= ASSET_INLINE_FULL_MAX_BYTES) {
          body = buf.toString('utf8');
          strategy = 'inline-text';
        } else {
          body = buf.subarray(0, ASSET_INLINE_TRUNCATE_BYTES).toString('utf8');
          strategy = 'inline-text-truncated';
        }
        const block = formatInlineAssetBlock(ref, effectiveMime, body, strategy);
        out.promptBlocks.push(block);
        out.observability.push({
          assetId: ref.assetId,
          contentHash: ref.contentHash,
          mime: effectiveMime,
          sizeBytes: ref.sizeBytes ?? buf.byteLength,
          strategy,
          inlinedBytes: strategy === 'inline-text-truncated' ? ASSET_INLINE_TRUNCATE_BYTES : buf.byteLength,
        });
        continue;
      } catch (err) {
        const errMsg = `read failed: ${(err as Error).message}`;
        logAssetResolveFailure(taskId, ref, errMsg, effectiveMime);
        out.promptBlocks.push(formatErrorAssetBlock(ref, effectiveMime, errMsg));
        out.observability.push({
          assetId: ref.assetId,
          contentHash: ref.contentHash,
          mime: effectiveMime,
          sizeBytes: ref.sizeBytes,
          strategy: 'error',
          error: errMsg,
        });
        continue;
      }
    }

    // ── 14b rev.3 §3.0.4 / §9 P3 — non-text path ────────────────────
    //
    // Pre-rev.3 we synthesized `[Attached file] … path=file://<localPath>` and
    // pushed it into the prompt string. Multimodal adapters can't recover
    // pixel bytes from a `file://` URL the LLM provider has no way to fetch.
    //
    // Rev.3 behavior:
    //   1. Always probe `cdnUrl` for reachability (skipping obvious local
    //      hostnames). Reachable → adapter passes URL through.
    //   2. Unreachable → daemon reads bytes from local cache, base64-encodes
    //      under a 10 MB ceiling, hands the dataURL-equivalent to adapter.
    //   3. Non-multimodal-aware adapters (codex / claude-code) ignore
    //      `task.assetRefs` and still see the short text reminder block so
    //      they at least know "the user attached file X".
    //
    // product209/18 SUPERSEDES part of §3: the reminder block is no longer
    // path-less. Adapters with REAL filesystem tools (adapterHasFilesystemTools)
    // get `path=file://<localPath>` back (byte delivery stays on task.assetRefs
    // — this is a prompt-side breadcrumb only, see formatAttachmentReminderBlock).
    // The rev.3 concern "chat-style adapters hallucinate filesystem access"
    // stays handled by the capability gate: tool-less adapters never see a path.
    let reachable: 'cdn' | 'base64' | 'unknown' = 'unknown';
    let base64: string | undefined;
    if (ref.cdnUrl) {
      const ok = await probeCdnReachable(ref.cdnUrl);
      if (ok) {
        reachable = 'cdn';
      }
    }
    if (reachable !== 'cdn') {
      // Either no cdnUrl, or probe failed → inline base64 (capped).
      try {
        const buf = readFileSync(cached.localPath);
        if (buf.byteLength <= ASSET_BASE64_INLINE_MAX_BYTES) {
          base64 = buf.toString('base64');
          reachable = 'base64';
        } else {
          // Too big to inline AND cdn unreachable → degrade gracefully:
          // pin path so legacy file:// tools keep working, mark uri-only.
          reachable = 'unknown';
        }
      } catch (err) {
        const errMsg = `base64 fallback read failed: ${(err as Error).message}`;
        logAssetResolveFailure(taskId, ref, errMsg, effectiveMime);
      }
    }

    const resolvedRef: ResolvedAssetRef = {
      ...ref,
      mime: effectiveMime,
      localPath: cached.localPath,
      base64,
      reachable,
    };
    out.resolvedRefs.push(resolvedRef);

    if (isImageMime(effectiveMime) && visionAux?.enabled) {
      const block = await describeImageAttachment(ref, effectiveMime, resolvedRef, visionAux, taskId);
      out.promptBlocks.push(block);
    } else {
      // product209/18 Part A — the resolvedRef ALWAYS carries the local cache
      // path (bytes were just fetched above). Multimodal adapters (Hermes
      // /v1/chat/completions, OpenClaw /v1/responses) consume `task.assetRefs`
      // instead; for everyone else this block is the only attachment surface,
      // so it must carry executable addresses: the prismer:// URI for
      // referencing, and — when the adapter has real filesystem tools — the
      // file:// path so the agent reads the bytes directly instead of
      // exploring (measured: 17 terminal commands reverse-engineering the
      // daemon's private DB to locate a PDF we already had on disk).
      out.promptBlocks.push(formatAttachmentReminderBlock(ref, effectiveMime, cached.localPath, fsCapable));
    }
    out.observability.push({
      assetId: ref.assetId,
      contentHash: ref.contentHash,
      mime: effectiveMime,
      sizeBytes: ref.sizeBytes,
      strategy: 'uri-only',
    });
  }

  return out;
}

async function describeImageAttachment(
  ref: AssetRef,
  mime: string | null,
  resolved: ResolvedAssetRef,
  opts: VisionAuxResolveOptions,
  taskId?: string,
): Promise<string> {
  const cached = await readVisionAuxLocalCache(opts.cacheDir, ref.contentHash, mime);
  if (cached) return formatVisionAuxBlock(ref, mime, cached.description, true);

  const source = buildVisionAuxSource(resolved, mime);
  if (!source) {
    return formatVisionAuxUnavailableBlock(ref, mime, 'no reachable URL or inline bytes');
  }

  try {
    const description = await callVisionAux(ref, mime, source, opts);
    await writeVisionAuxLocalCache(opts.cacheDir, ref.contentHash, mime, description);
    return formatVisionAuxBlock(ref, mime, description.description, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[daemon] vision-aux failed task=${taskId ?? 'unknown'} assetId=${ref.assetId} hash=${ref.contentHash}: ${message}\n`,
    );
    return formatVisionAuxUnavailableBlock(ref, mime, message);
  }
}

function buildVisionAuxSource(
  resolved: ResolvedAssetRef,
  mime: string | null,
): { kind: 'url' | 'data_url'; url: string } | null {
  if (resolved.reachable === 'cdn' && resolved.cdnUrl) return { kind: 'url', url: resolved.cdnUrl };
  if (resolved.base64 && mime) return { kind: 'data_url', url: `data:${mime};base64,${resolved.base64}` };
  return null;
}

async function callVisionAux(
  ref: AssetRef,
  mime: string | null,
  source: { kind: 'url' | 'data_url'; url: string },
  opts: VisionAuxResolveOptions,
): Promise<VisionAuxCachedDescription> {
  const secret =
    process.env.VISION_AUX_INTERNAL_SECRET || process.env.INTERNAL_API_SECRET || process.env.PRISMER_INTERNAL_SECRET;
  const headers = secret ? { 'x-prismer-internal-secret': secret } : undefined;
  const res = await opts.cloud.request<VisionAuxResponseEnvelope>('POST', '/api/internal/vision-aux/describe', {
    body: {
      assetId: ref.assetId,
      contentHash: ref.contentHash,
      mime: mime ?? ref.mime ?? 'image/unknown',
      source,
    },
    headers,
    timeoutMs: opts.timeoutMs ?? 12_000,
    signal: opts.signal,
  });
  const env = res.data;
  if (!res.ok || env?.ok === false || !env?.data?.description) {
    const message =
      res.error?.message ||
      (typeof env?.error === 'string' ? env.error : env?.error?.message) ||
      env?.message ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }

  const now = new Date();
  const ttlSec = Number.isFinite(env.data.cacheTtlSec) ? Number(env.data.cacheTtlSec) : 300;
  return {
    description: env.data.description,
    modelUsed: env.data.modelUsed || 'unknown',
    provider: env.data.provider || 'vision-aux',
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Math.max(1, ttlSec) * 1000).toISOString(),
    mime: mime ?? ref.mime ?? 'image/unknown',
  };
}

async function readVisionAuxLocalCache(
  cacheDir: string | undefined,
  contentHash: string,
  mime: string | null,
): Promise<VisionAuxCachedDescription | null> {
  if (!cacheDir) return null;
  const file = visionAuxCachePath(cacheDir, contentHash);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = parseVisionAuxCache(raw);
    if (!parsed) {
      await fsp.unlink(file).catch(() => undefined);
      return null;
    }
    if (parsed.mime !== mime) return null;
    const expiresAt = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fsp.unlink(file).catch(() => undefined);
    }
    return null;
  }
}

async function writeVisionAuxLocalCache(
  cacheDir: string | undefined,
  contentHash: string,
  mime: string | null,
  description: VisionAuxCachedDescription,
): Promise<void> {
  if (!cacheDir || !mime) return;
  const file = visionAuxCachePath(cacheDir, contentHash);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ ...description, mime }, null, 2), 'utf8');
}

function visionAuxCachePath(cacheDir: string, contentHash: string): string {
  const safeHash = /^[a-f0-9]{32,128}$/i.test(contentHash) ? contentHash : createSafeCacheKey(contentHash);
  return path.join(cacheDir, `${safeHash}.json`);
}

function createSafeCacheKey(value: string): string {
  return Buffer.from(value).toString('base64url').slice(0, 128) || 'unknown';
}

function parseVisionAuxCache(raw: string): VisionAuxCachedDescription | null {
  try {
    const parsed = JSON.parse(raw) as Partial<VisionAuxCachedDescription>;
    if (
      typeof parsed.description === 'string' &&
      typeof parsed.modelUsed === 'string' &&
      typeof parsed.provider === 'string' &&
      typeof parsed.generatedAt === 'string' &&
      typeof parsed.expiresAt === 'string' &&
      typeof parsed.mime === 'string'
    ) {
      return parsed as VisionAuxCachedDescription;
    }
  } catch {
    return null;
  }
  return null;
}

function logAssetResolveFailure(taskId: string | undefined, ref: AssetRef, error: string, mime = ref.mime): void {
  const message = error.replace(/\s+/g, ' ').slice(0, 500);
  process.stderr.write(
    `[daemon] asset resolve failed task=${taskId ?? 'unknown'} assetId=${ref.assetId} hash=${ref.contentHash} mime=${mime ?? 'unknown'} error=${message}\n`,
  );
}

function formatInlineAssetBlock(
  ref: AssetRef,
  mime: string | null,
  body: string,
  strategy: AssetDispatchStrategy,
): string {
  const header = `[Attached file] id=${ref.assetId} mime=${mime ?? 'unknown'}${
    strategy === 'inline-text-truncated' ? ' (truncated)' : ''
  }`;
  return `${header}\n---\n${body}\n---`;
}

function formatUriOnlyAssetBlock(ref: AssetRef, mime: string | null, localPath: string): string {
  return `[Attached file] id=${ref.assetId} mime=${mime ?? 'unknown'} path=file://${localPath} — open with your read/parse tool when needed.`;
}

/**
 * 14b rev.3 §3.0.4 — short reminder block for non-text attachments.
 *
 * Multimodal-aware adapters consume `task.assetRefs` and emit native
 * `image_url` / `input_image` / `input_file` wire blocks; they don't need
 * the file path. Legacy text-only adapters (codex/claude-code) only see
 * the prompt string and would otherwise be silent about the attachment —
 * the breadcrumb lets them at least mention "you attached X" rather than
 * deny seeing it.
 *
 * product209/18 Part A — 有文件系统工具的适配器在这里拿不到字节（sessions 路径只
 * 注入 image 且过 vision 门），旧面包屑对它们是一句不可执行的假话（本地 kind pod
 * 实测：hermes text 模型为找 PDF 逆向 daemon 私有 local.db，17 条 terminal）。
 * 现在统一给 prismer:// URI（引用/转发的稳定句柄），并对 fsCapable 适配器附上
 * file:// 容器路径（字节已由 asset-cache 物化，直接用 file/terminal 工具读）。
 */
export function formatAttachmentReminderBlock(
  ref: AssetRef,
  mime: string | null,
  localPath: string,
  fsCapable: boolean,
): string {
  const name = ref.filename ? ` name=${ref.filename}` : '';
  const uri = `prismer://workspace/${ref.workspaceId}/asset/${ref.contentHash}`;
  const lines = [`[Attached file] id=${ref.assetId} mime=${mime ?? 'unknown'}${name}`, `  uri=${uri}`];
  if (fsCapable) {
    lines.push(
      `  path=file://${localPath}`,
      '  — read with your file/terminal tools; use the prismer:// uri when referencing it in replies.',
    );
  } else {
    lines.push('  — the user uploaded this file; multimodal adapters receive the bytes directly.');
  }
  return lines.join('\n');
}

/**
 * product209/18 Part A — 该 profile 的适配器是否真能读本地文件系统。
 * hermes: platform_toolsets 默认含 terminal/file，但角色的 toolsetScope 可禁 →
 * 按 disabledToolsets 判定（配置解析失败时保守放行 true，与 ensureService 同哲学：
 * 配置坏了让 dispatch 自己去报错，别在这儿把附件信息降级）。
 * coding 系（claude-code/codex/opencode）: per-dispatch spawn，cwd 钉在 scratch，
 * 自带 shell/read 工具，绝对路径可读。
 * pi-core（runtime210/09 §3.2）: 内嵌 runtime engine，带 cwd-jailed read/write/edit
 * 工具，任务 workdir 内的附件路径可读。
 */
export function adapterHasFilesystemTools(profile: { adapterName: string; config: unknown }): boolean {
  if (profile.adapterName === 'hermes') {
    try {
      const config = HermesProfileConfigSchema.parse(profile.config);
      const disabled = computeDisabledToolsets(resolveToolsetScope(config));
      return !disabled.includes('terminal') && !disabled.includes('file');
    } catch {
      return true;
    }
  }
  return (
    profile.adapterName === 'claude-code' ||
    profile.adapterName === 'codex' ||
    profile.adapterName === 'opencode' ||
    profile.adapterName === 'pi-core'
  );
}

function formatVisionAuxBlock(ref: AssetRef, mime: string | null, description: string, cached: boolean): string {
  const name = ref.filename ? `: ${ref.filename}` : '';
  const cacheLabel = cached ? ' local-cache' : '';
  return `[Image attachment${name}] id=${ref.assetId} mime=${mime ?? 'unknown'}${cacheLabel}\n${description.trim()}`;
}

function formatVisionAuxUnavailableBlock(ref: AssetRef, mime: string | null, reason: string): string {
  const name = ref.filename ? `: ${ref.filename}` : '';
  return `[Image attachment${name}; description unavailable due to vision-aux error] id=${ref.assetId} mime=${mime ?? 'unknown'} reason=${reason.slice(0, 180)}`;
}

// AI-2 fix (docs/release200/07-asset-preview-experience.md §2.3.1): surface
// asset-load failure to the agent. Without this, resolveAssetRefs silently
// dropped failed assets and the agent — seeing the filename in chat but no
// attachment in prompt — would hallucinate a "platform cache exception"
// rationale (see real user impact 2026-05-16). Now the agent sees the actual
// reason and can tell the user accurately.
function formatErrorAssetBlock(ref: AssetRef, mime: string | null, error: string): string {
  return `[Attached file] id=${ref.assetId} mime=${mime ?? 'unknown'} ERROR: ${error} — this file failed to load on the daemon side. Tell the user the specific error and ask them to re-upload or paste the content directly; do not guess at the cause.`;
}

interface TaskLike {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  assigneeId?: string | null;
  conversationId?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string | Date;
  okrObjective?: OkrObjectiveContext | null;
}

interface OkrObjectiveContext {
  id: string;
  title: string;
  narrative?: string | null;
  state?: string | null;
  cycleLabel?: string | null;
  keyResults: OkrKeyResultContext[];
}

interface OkrKeyResultContext {
  id: string;
  title: string;
  status?: string | null;
  /**
   * spec 11 T3-4（D-7 第 3 件）—— baseline 是「从哪儿开始」的事实，验收判据
   * （baseline → target）少了它，agent 只能看到 current/target 两个点、猜不出
   * 已走多远。云端 `GET /api/im/okr/objectives/:id` 直接返回 KR 行（Prisma 行 =
   * `baselineNumeric`），故这里按现状读现成字段，不新增 wire 字段。
   */
  baseline?: number | null;
  current?: number | null;
  target?: number | null;
  unit?: string | null;
}

export function appendGoalContext(prompt: string, goals: TaskLike[]): string {
  if (goals.length === 0) return prompt;
  const lines = goals.slice(0, GOAL_CONTEXT_MAX).map((goal, index) => {
    const metaGoal = readRecord(goal.metadata?.goal);
    const priority = typeof metaGoal.priority === 'string' ? metaGoal.priority : 'medium';
    const description =
      typeof goal.description === 'string' && goal.description.trim() ? ` — ${goal.description.trim()}` : '';
    return `${index + 1}. [${priority}] ${goal.title ?? goal.id}${description}`;
  });
  return `[Active Goals]\n${lines.join('\n')}\n\n${prompt}`;
}

export function appendActiveObjectiveContext(prompt: string, goals: TaskLike[]): string {
  const objectives = goals
    .map((goal) => goal.okrObjective)
    .filter((objective): objective is OkrObjectiveContext => Boolean(objective))
    .slice(0, GOAL_CONTEXT_MAX);
  if (objectives.length === 0) return prompt;
  const lines = objectives.map((objective, index) => {
    const cycle = objective.cycleLabel ? ` (${objective.cycleLabel})` : '';
    const krSummary = objective.keyResults
      .slice(0, 4)
      .map((kr) => {
        const progress =
          kr.current !== null && kr.current !== undefined && kr.target !== null && kr.target !== undefined
            ? ` ${kr.current}/${kr.target}${kr.unit ?? ''}`
            : '';
        const status = kr.status ? ` [${kr.status}]` : '';
        return `${kr.title}${progress}${status}`;
      })
      .join('; ');
    return `${index + 1}. ${objective.title}${cycle}${krSummary ? ` — KRs: ${krSummary}` : ''}`;
  });
  return `[Active Objectives]\n${lines.join('\n')}\n\n${prompt}`;
}

/**
 * spec 11 T3-4（D-7 第 3 件）—— `[Active Key Results]` 段。
 *
 * `[Active Objectives]` 只把每条 KR 压成一行摘要（title + current/target），
 * baseline 和归属 objective 都丢了。长线任务要的是「我这条线从哪儿开始、要到
 * 哪儿、现在哪儿」——即验收判据本身。这段把每条 active KR 展开成：
 *
 *   <objective title> (cycle) · <kr title>: baseline X, current Y, target Z<unit> [status]
 *
 * 缺失的数字直接省略，不补 0、不推测（与 `[Active Objectives]` 同口径：
 * NO fabrication）；三项全缺时整个「: 数字串」段一并省掉（不留 `<kr>:` 裸尾冒号
 * ——空壳读起来像「有进度但没显示」）。`unit` 只贴在 target 上（同
 * `[Active Objectives]` 的 `current/target<unit>` 口径：单位是目标刻度的单位）。
 * 没有 objective / KR 可注时原样返回 prompt（逐字节不变）。
 */
export function appendActiveKeyResultContext(prompt: string, goals: TaskLike[]): string {
  const rows: string[] = [];
  for (const goal of goals.slice(0, GOAL_CONTEXT_MAX)) {
    const objective = goal.okrObjective;
    if (!objective) continue;
    const cycle = objective.cycleLabel ? ` (${objective.cycleLabel})` : '';
    for (const kr of objective.keyResults.slice(0, GOAL_CONTEXT_MAX)) {
      const numbers: string[] = [];
      if (kr.baseline !== null && kr.baseline !== undefined) numbers.push(`baseline ${kr.baseline}`);
      if (kr.current !== null && kr.current !== undefined) numbers.push(`current ${kr.current}`);
      if (kr.target !== null && kr.target !== undefined) numbers.push(`target ${kr.target}${kr.unit ?? ''}`);
      const progress = numbers.length > 0 ? `: ${numbers.join(', ')}` : '';
      const status = kr.status ? ` [${kr.status}]` : '';
      rows.push(`${objective.title}${cycle} · ${kr.title}${progress}${status}`);
    }
  }
  if (rows.length === 0) return prompt;
  return `[Active Key Results]\n${rows.map((row, index) => `${index + 1}. ${row}`).join('\n')}\n\n${prompt}`;
}

/**
 * spec 11 T3-4 — 三段 OKR 感知段的装配顺序（goal → objective → KR）。抽成
 * 具名函数是为了让「三段都在、顺序固定、没有 OKR 数据时逐字节不变」可被断言
 * ——原先的三层内联嵌套没有任何测试触点。
 */
export function composeActiveGoalContext(prompt: string, goals: TaskLike[]): string {
  return appendActiveKeyResultContext(appendActiveObjectiveContext(appendGoalContext(prompt, goals), goals), goals);
}

interface MemoryContext {
  status: 'loaded' | 'empty' | 'failed';
  digest: string;
  filesSummarized: number;
  filesTotal: number;
  totalBytes: number;
  durationMs: number;
  error?: string;
}

export interface MemoryContextAppendOptions {
  /**
   * spec 11 T5-4 — content produced by the session recall coordinator
   * (`onSessionStart` INDEX preload / idle recall fence). Kept outside the
   * stable digest itself: recall output is per-session and can include grant
   * sourced snippets, while the digest remains cache-stable.
   */
  sessionRecallContent?: string | null;
}

export function appendMemoryContext(
  prompt: string,
  memory: MemoryContext,
  opts: MemoryContextAppendOptions = {},
): string {
  const sections: string[] = [];
  if (memory.status === 'loaded' && memory.digest.trim()) {
    sections.push(memory.digest.trim());
  }
  if (opts.sessionRecallContent?.trim()) {
    sections.push(`[Session Recall]\n${opts.sessionRecallContent.trim()}`);
  }
  if (sections.length === 0) return prompt;
  return `[Memory Context]\n${sections.join('\n\n')}\n\n${prompt}`;
}

export function resolveOperatingPrinciples(
  config: Record<string, unknown> | undefined,
  forceAutonomous = false,
): string {
  const cfg = readRecord(config);
  const roleTemplate = readRecord(cfg.roleTemplate);
  const principles =
    stringifyPrinciples(cfg.operatingPrinciples) ??
    stringifyPrinciples(roleTemplate.operatingPrinciples) ??
    DEFAULT_OPERATING_PRINCIPLES;
  // release203/11 — persistence agents are forced autonomous: append an ENFORCED
  // override that supersedes any approval-seeking prose embedded in the (possibly
  // legacy DB) role-template principles above.
  if (forceAutonomous) {
    return `${principles}\n- Approval policy: autonomous (ENFORCED). You operate fully autonomously in a sandboxed environment — never pause to request human approval for running tools, commands, or delivering artifacts; execute and deliver directly. This supersedes any approval guidance above. Never claim to be waiting for approval.`;
  }
  const policy = typeof cfg.approvalPolicy === 'string' ? cfg.approvalPolicy : roleTemplate.approvalPolicy;
  if (policy === 'strict') {
    return `${principles}\n- Approval policy: strict. Request human approval before destructive, external, spend, access, or publish operations.`;
  }
  if (policy === 'autonomous') {
    return `${principles}\n- Approval policy: autonomous. Do not request human approval unless a platform policy explicitly requires it.`;
  }
  return `${principles}\n- Approval policy: auto-low-risk. Proceed on reversible low-risk work; request human approval for destructive or irreversible operations.`;
}

function stringifyPrinciples(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const bySource = new Map<string, string[]>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const source = typeof record.source === 'string' ? record.source : '';
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (!text) continue;
      const bucket = bySource.get(source) ?? [];
      bucket.push(text);
      bySource.set(source, bucket);
    }
    const ordered = ['agency', '30-acp']
      .flatMap((source) => bySource.get(source) ?? [])
      .join('\n\n')
      .trim();
    if (ordered) return ordered;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['en', 'zh']) {
      const text = record[key];
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
    for (const text of Object.values(record)) {
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return undefined;
}

/**
 * Wave-9 / F18 (2026-05-20) — instruct the agent where to put files.
 *
 * Cloud's chat surface reads `task.dispatch.reply.assetIds` (populated by
 * ArtifactsWatcher scanning the artifacts dir) and renders the corresponding
 * IMAssets as agent_reply attachments.
 *
 * release202/04 §3.1 — two purpose-specific directories:
 *   artifacts/  — user-deliverable files (auto-uploaded as chat attachments)
 *   scratch/    — agent's scratch space (intermediate scripts, drafts, log
 *                 files — NOT uploaded). Prevents pollution of the user's
 *                 source tree when LLM writes relative paths.
 *
 * Both paths are absolute and embedded verbatim so the LLM doesn't need to
 * compose them from environment variables.
 *
 * Skipped when:
 *   - no artifactsDir was provisioned (e.g. test daemons without `paths`)
 *   - the profile sets `disableOutboxHints: true` (token-sensitive
 *     deployments may want to opt out)
 *
 * Length budget: ~20 lines / ~900 chars. Slightly larger than the pre-F18
 * version but still tiny compared to a typical user turn.
 */
export function appendArtifactsInstruction(
  prompt: string,
  artifactsDir: string | null,
  profileConfig: { disableOutboxHints?: unknown } | undefined,
  scratchDir: string | null = null,
): string {
  if (!artifactsDir) return prompt;
  if (profileConfig?.disableOutboxHints === true) return prompt;
  const lines = [
    '[File system rules — MANDATORY, server-enforced]',
    '',
    'You have TWO designated directories for this task. ALWAYS use absolute paths.',
    'NEVER write files with relative paths — they resolve against the agent process',
    'cwd which is sandboxed but unpredictable, and any path outside the two',
    'directories below is treated as malformed.',
    '',
    `1. **Artifacts (auto-uploaded as chat attachments)** — write deliverables here:`,
    `     ${artifactsDir}`,
    '   Any file you place here will be uploaded and shown to the user as an',
    '   attachment in your reply. Use this for the final artifacts the user',
    '   actually wants (PNG charts, DOCX reports, CSV exports, archives).',
    '',
    '   ⚠️ This Artifacts path is UNIQUE TO THIS TURN. Do NOT reuse an',
    '   Artifacts path from an earlier message in this conversation — copy the',
    '   exact path printed above on every turn; a stale path silently drops the file.',
    '',
    '   ⚠️ To DELIVER a file, COPY IT INTO THE PATH ABOVE. Do NOT use',
    '   `cloud file send` for deliverables: it needs a conversationId you',
    '   do not have here AND posts a fragmented separate message. The Artifacts',
    '   dir auto-attaches the file to your normal reply as ONE message.',
    '',
  ];
  if (scratchDir) {
    lines.push(
      `2. **Scratch (intermediate, NOT uploaded)** — write intermediate stuff here:`,
      `     ${scratchDir}`,
      '   Use for draft scripts, log files, intermediate CSVs, temp downloads —',
      "   anything the user doesn't need to see. These files are deleted later",
      '   and never become chat attachments.',
      '',
    );
  }
  // release202/04 §3.2 — explicit routing + /tmp-forbid. Primary lever for
  // long-running adapters (hermes/openclaw) whose shared process cwd CANNOT be
  // pointed at a per-task dir, so the absolute-path discipline must come from
  // the prompt. Spawn adapters (claude-code/codex) get cwd pinned to scratch
  // too, but the same rules keep them honest when they emit absolute paths.
  if (scratchDir) {
    lines.push(
      'ROUTING (mandatory):',
      `  • Intermediate / scratch files (draft scripts, temp downloads, logs,`,
      `    half-finished work) → write to the Scratch dir above (absolute path).`,
      '  • Final deliverables the user should receive → write to the Artifacts',
      '    dir above (absolute path).',
      '',
    );
  }
  lines.push(
    'NEVER write to /tmp, your home directory, the current working directory,',
    'or ANY path outside the ' + (scratchDir ? 'two directories' : 'directory') + ' above. Files written elsewhere are',
    'lost (not delivered), pollute the host machine, and are treated as a',
    'hard error.',
    '',
    'If you produce a file but write it OUTSIDE ' + (scratchDir ? 'both directories' : 'the directory') + ' with a',
    'relative path, it will NOT become a chat attachment and may pollute the',
    "user's working directory. This is treated as a hard error.",
    '',
    'These paths are also exposed via env vars: PRISMER_ARTIFACTS_DIR' +
      (scratchDir ? ' and PRISMER_SCRATCH_DIR' : '') +
      '.',
    '',
  );
  return `${lines.join('\n')}\n${prompt}`;
}

/**
 * Prepend a short `[Channel context]` block so the LLM always knows whether
 * it is in a DM or a group room — even when the prismer-im-collab skill is
 * not fully loaded into the model. Mirrors appendArtifactsInstruction in shape:
 * ≤6 lines, prepended to the existing prompt.
 *
 * Reads `payload.conversationType` (forward-compatible: missing → 'unknown')
 * and `profile.agentUsername` for the "You are" line.
 *
 * @deprecated 2026-05-31 (release201/30) — sessions-style adapters (Hermes
 * /api/sessions/{id}/chat/stream) now use `composeConversationContextXml`
 * which embeds the participant list + first-person disambiguation as XML
 * tags on the user-side message, not as a prose prefix on the system prompt.
 * This function is retained for the legacy /v1/runs flow and for interactive
 * adapters (claude-code, codex, openclaw) that still read the concatenated
 * `prompt`. Remove when /v1/runs is fully retired and every interactive
 * adapter has migrated to the XML conversation context.
 */
export function appendChannelContext(
  prompt: string,
  payload: TaskDispatchRequestPayload,
  profile: AgentProfile,
): string {
  const type: 'direct' | 'group' | 'unknown' =
    payload.conversationType === 'direct' || payload.conversationType === 'group'
      ? payload.conversationType
      : 'unknown';
  const youAre = profile.agentUsername || payload.agentImUserId || 'this agent';
  const lines = ['[Channel context]', `Conversation type: ${type}`, `You are: ${youAre}`];
  if (payload.conversationId) {
    lines.push(`Conversation ID: ${payload.conversationId}`);
  }

  // Render the authoritative participant list when cloud sent one. Without
  // this, agents fall back to scraping chat history and hallucinate ("CEO
  // isn't in this channel") because long-silent participants drop out of
  // the context window. Cloud caps the list at 50; we further compact to
  // 12 visible + tail summary so the prompt doesn't balloon.
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  if (participants.length > 0) {
    if (type === 'direct') {
      // In a DM the "other party" is the unique non-self participant.
      const myUsername = profile.agentUsername || '';
      const myImUserId = payload.agentImUserId || profile.agentImUserId || '';
      const other = participants.find((p) => p.username !== myUsername && p.imUserId !== myImUserId) ?? participants[0];
      if (other) {
        lines.push(`Other party: ${other.username} (${other.displayName})`);
      }
    } else {
      const formatted = participants.map((p) => {
        const roleLabel = p.role === 'agent' ? 'agent' : p.role === 'human' ? 'human' : p.role;
        return `${p.username} (${p.displayName} ${roleLabel})`;
      });
      const visibleCount = 12;
      const headerCount = participants.length;
      const groupLabel = type === 'group' ? 'this group' : 'this conversation';
      if (formatted.length <= visibleCount) {
        lines.push(`Participants in ${groupLabel} (${headerCount}): ${formatted.join(', ')}`);
      } else {
        const head = formatted.slice(0, visibleCount).join(', ');
        const tail = formatted.length - visibleCount;
        lines.push(`Participants in ${groupLabel} (${headerCount}): ${head}, …and ${tail} more`);
      }
    }
  }

  if (type === 'group') {
    lines.push(
      'To continue this discussion, end your reply with @<recipient_username>. Without an @-mention the chain ends. Use prismer.agent.send for verified delegation.',
    );
  } else if (type === 'direct') {
    lines.push('Reply naturally; the other party is the unique recipient. No @-mention needed.');
  }
  lines.push('');
  return `${lines.join('\n')}\n${prompt}`;
}

/**
 * runtime210 G-A — read + render the SKILL.md set for a pi-core profile so
 * dispatch can splice it into the composed system prompt (same renderer the
 * hermes adapter uses for its per-turn skill section).
 *
 * Resolution goes through `resolveSkillsRoot` with the same ctx skill-sync
 * writes into — explicit `config.skillsDir` → per-agent device dir → null.
 * The injected text is observable: it rides `task.metadata.systemPrompt`
 * (assertable) and a stdout line records slug count + bytes per dispatch.
 *
 * Failures degrade to undefined (skill-less prompt) — skill injection must
 * never break a dispatch the way a hard read would.
 */
async function composePiCoreSkillsPrompt(
  profile: AgentProfile,
  agentImUserId: string | undefined,
  deps: DispatchDeps,
): Promise<string | undefined> {
  const skillsRoot = resolveSkillsRoot(profile, agentImUserId, {
    paths: deps.paths,
    daemonId: deps.daemonId,
  });
  if (!skillsRoot) return undefined;
  try {
    const skills = await new FileSystemSkillLoader(skillsRoot).loadForDispatch(profile);
    const prompt = renderSkillsSystemPrompt(skills);
    if (prompt) {
      process.stdout.write(
        `[daemon] pi-core skill injection profile=${profile.id} skills=${skills.length} bytes=${prompt.length}\n`,
      );
    }
    return prompt;
  } catch (err) {
    process.stderr.write(
      `[daemon] pi-core skill injection failed profile=${profile.id}: ${(err as Error).message}\n`,
    );
    return undefined;
  }
}

async function loadMemoryContext(
  profile: AgentProfile,
  cloud: CloudClient,
  signal?: AbortSignal,
): Promise<MemoryContext> {
  const startedAt = Date.now();
  try {
    const digest = await cloud.get<{
      digest?: string;
      filesSummarized?: number;
      filesTotal?: number;
      totalBytes?: number;
    }>(`/api/im/memory/digest?maxLines=120&maxBytes=${MEMORY_DIGEST_MAX_BYTES}`, { signal });
    const content = typeof digest.digest === 'string' ? digest.digest : '';
    const filesSummarized = Number(digest.filesSummarized ?? 0);
    const filesTotal = Number(digest.filesTotal ?? 0);
    return {
      status: filesTotal > 0 && content.trim() ? 'loaded' : 'empty',
      digest: content,
      filesSummarized,
      filesTotal,
      totalBytes: Number(digest.totalBytes ?? content.length),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    process.stderr.write(`[daemon] memory digest load skipped for profile=${profile.id}: ${(err as Error).message}\n`);
    return {
      status: 'failed',
      digest: '',
      filesSummarized: 0,
      filesTotal: 0,
      totalBytes: 0,
      durationMs: Date.now() - startedAt,
      error: (err as Error).message,
    };
  }
}

async function loadGoalContext(
  payload: TaskDispatchRequestPayload,
  profile: AgentProfile,
  cloud: CloudClient,
  signal?: AbortSignal,
): Promise<TaskLike[]> {
  const workspaceId = profile.workspaceId || stringFrom(payload.metadata?.workspaceId);
  if (!workspaceId) return [];
  try {
    const tasks = await cloud.get<TaskLike[]>(
      `/api/im/tasks?workspaceId=${encodeURIComponent(workspaceId)}&kind=goal&view=board&limit=100`,
      { signal },
    );
    const filtered = tasks
      .filter((task) => isGoalTask(task))
      .filter((task) => goalAppliesToDispatch(task, payload, profile))
      .sort((a, b) => updatedTime(b) - updatedTime(a))
      .slice(0, GOAL_CONTEXT_MAX);
    return enrichGoalTasksWithOkrObjectives(filtered, cloud, signal);
  } catch (err) {
    process.stderr.write(`[daemon] goal context load skipped for task=${payload.taskId}: ${(err as Error).message}\n`);
    return [];
  }
}

async function enrichGoalTasksWithOkrObjectives(
  tasks: TaskLike[],
  cloud: CloudClient,
  signal?: AbortSignal,
): Promise<TaskLike[]> {
  const byObjectiveId = new Map<string, OkrObjectiveContext | null>();
  await Promise.all(
    tasks.map(async (task) => {
      const objectiveId = readOkrObjectiveId(task);
      if (!objectiveId || byObjectiveId.has(objectiveId)) return;
      try {
        byObjectiveId.set(objectiveId, await loadOkrObjectiveContext(objectiveId, cloud, signal));
      } catch (err) {
        byObjectiveId.set(objectiveId, null);
        process.stderr.write(
          `[daemon] OKR objective context load skipped objective=${objectiveId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );
  return tasks.map((task) => {
    const objectiveId = readOkrObjectiveId(task);
    if (!objectiveId) return task;
    return { ...task, okrObjective: byObjectiveId.get(objectiveId) ?? null };
  });
}

async function loadOkrObjectiveContext(
  objectiveId: string,
  cloud: CloudClient,
  signal?: AbortSignal,
): Promise<OkrObjectiveContext> {
  const data = await cloud.get<Record<string, unknown>>(`/api/im/okr/objectives/${encodeURIComponent(objectiveId)}`, {
    signal,
  });
  return parseOkrObjectiveContext(data, objectiveId);
}

/**
 * 云端 `GET /api/im/okr/objectives/:id` 的响应 → 注入上下文。导出仅供测试：
 * 两个字段名都要认（云端直接回 Prisma 行 = `baselineNumeric` / `targetNumeric`，
 * 而 `current`/`target` 是 API 侧的别名形态），认漏一个就是静默没有 baseline。
 */
export function parseOkrObjectiveContext(data: Record<string, unknown>, fallbackId: string): OkrObjectiveContext {
  const keyResults = Array.isArray(data.keyResults)
    ? data.keyResults
        .map((kr) => {
          const record = readRecord(kr);
          return {
            id: stringFrom(record.id) ?? '',
            title: stringFrom(record.title) ?? '',
            status: stringFrom(record.status) ?? null,
            baseline: numberOrNull(record.baseline ?? record.baselineNumeric),
            current: numberOrNull(record.current ?? record.currentNumeric),
            target: numberOrNull(record.target ?? record.targetNumeric),
            unit: stringFrom(record.unit) ?? null,
          };
        })
        .filter((kr) => kr.id && kr.title)
    : [];
  return {
    id: stringFrom(data.id) ?? fallbackId,
    title: stringFrom(data.title) ?? fallbackId,
    narrative: stringFrom(data.narrative) ?? null,
    state: stringFrom(data.state) ?? null,
    cycleLabel: stringFrom(data.cycleLabel) ?? null,
    keyResults,
  };
}

function readOkrObjectiveId(task: TaskLike): string | null {
  const okr = readRecord(task.metadata?.okr);
  return stringFrom(okr.objectiveId) ?? null;
}

function isGoalTask(task: TaskLike): boolean {
  const meta = task.metadata ?? {};
  return meta.kind === 'goal' || meta.intent === 'standing_objective';
}

function isActiveGoalTask(task: TaskLike): boolean {
  const meta = task.metadata ?? {};
  if (!isGoalTask(task)) return false;
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') return false;
  const metaGoal = readRecord(meta.goal);
  return metaGoal.status !== 'paused' && metaGoal.status !== 'completed';
}

function goalAppliesToDispatch(task: TaskLike, payload: TaskDispatchRequestPayload, profile: AgentProfile): boolean {
  if (task.assigneeId && task.assigneeId !== payload.agentImUserId && task.assigneeId !== profile.agentImUserId) {
    return false;
  }
  const metaGoal = readRecord(task.metadata?.goal);
  const linkedTaskIds = stringArray(metaGoal.linkedTaskIds);
  if (linkedTaskIds.includes(payload.taskId)) return true;
  const linkedConversationIds = stringArray(metaGoal.linkedConversationIds);
  if (payload.conversationId && linkedConversationIds.includes(payload.conversationId)) return true;
  return !task.assigneeId || task.assigneeId === payload.agentImUserId || task.assigneeId === profile.agentImUserId;
}

function toGoalMirrorPayload(task: TaskLike): Record<string, unknown> {
  const metaGoal = readRecord(task.metadata?.goal);
  const metaStatus = stringFrom(metaGoal.status);
  const status =
    metaStatus ??
    (task.status === 'completed'
      ? 'completed'
      : task.status === 'cancelled' || task.status === 'failed'
        ? 'cleared'
        : 'active');
  return {
    id: task.id,
    title: task.title ?? task.id,
    description: task.description ?? null,
    status,
    taskStatus: task.status ?? null,
    priority: stringFrom(metaGoal.priority) ?? 'medium',
    updatedAt: task.updatedAt ?? null,
  };
}

function toObjectiveMirrorPayload(task: TaskLike): Record<string, unknown> | null {
  const objective = task.okrObjective;
  if (!objective) return null;
  return {
    id: objective.id,
    title: objective.title,
    state: objective.state ?? null,
    cycleLabel: objective.cycleLabel ?? null,
    goalTaskId: task.id,
    keyResults: objective.keyResults.map((kr) => ({
      id: kr.id,
      title: kr.title,
      status: kr.status ?? null,
      current: kr.current ?? null,
      target: kr.target ?? null,
      unit: kr.unit ?? null,
    })),
  };
}

async function writeBridgeMetadata(
  taskId: string,
  cloud: CloudClient,
  resultMetadata?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const hermes = readRecord(resultMetadata?.hermes);
  if (Object.keys(hermes).length === 0) return;
  try {
    const current = await getDispatchRecordById(taskId, cloud, signal);
    const metadata = mergeHermesBridgeMetadata(current.record.metadata ?? {}, hermes);
    const res = await cloud.request(
      'PATCH',
      current.kind === 'run'
        ? `/api/im/runs/${encodeURIComponent(taskId)}`
        : `/api/im/tasks/${encodeURIComponent(taskId)}`,
      {
        body: { metadata },
        signal,
      },
    );
    const env = res.data as { ok?: boolean; error?: { message?: string } } | undefined;
    if (!res.ok || env?.ok === false) {
      const message = res.error?.message ?? env?.error?.message ?? `HTTP ${res.status}`;
      process.stderr.write(`[daemon] Hermes bridge metadata PATCH failed task=${taskId}: ${message}\n`);
    }
  } catch (err) {
    process.stderr.write(`[daemon] Hermes bridge metadata write skipped task=${taskId}: ${(err as Error).message}\n`);
  }
}

async function writeObservabilityMetadata(
  taskId: string,
  cloud: CloudClient,
  observability?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (!observability || Object.keys(observability).length === 0) return;
  try {
    const current = await getDispatchRecordById(taskId, cloud, signal);
    const metadata = mergeObservabilityMetadata(current.record.metadata ?? {}, observability);
    const res = await cloud.request(
      'PATCH',
      current.kind === 'run'
        ? `/api/im/runs/${encodeURIComponent(taskId)}`
        : `/api/im/tasks/${encodeURIComponent(taskId)}`,
      {
        body: { metadata },
        signal,
      },
    );
    const env = res.data as { ok?: boolean; error?: { message?: string } } | undefined;
    if (!res.ok || env?.ok === false) {
      const message = res.error?.message ?? env?.error?.message ?? `HTTP ${res.status}`;
      process.stderr.write(`[daemon] observability metadata PATCH failed task=${taskId}: ${message}\n`);
    }
  } catch (err) {
    process.stderr.write(`[daemon] observability metadata write skipped task=${taskId}: ${(err as Error).message}\n`);
  }
}

async function getDispatchRecordById(
  taskId: string,
  cloud: CloudClient,
  signal?: AbortSignal,
): Promise<{ kind: 'task' | 'run'; record: TaskLike }> {
  try {
    const data = await cloud.get<TaskLike | { task: TaskLike }>(`/api/im/runs/${encodeURIComponent(taskId)}`, {
      signal,
    });
    if (data && typeof data === 'object' && 'run' in data) {
      return { kind: 'run', record: (data as { run: TaskLike }).run };
    }
    return { kind: 'run', record: data as TaskLike };
  } catch {
    const data = await cloud.get<TaskLike | { task: TaskLike }>(`/api/im/tasks/${encodeURIComponent(taskId)}`, {
      signal,
    });
    if (data && typeof data === 'object' && 'task' in data) {
      return { kind: 'task', record: (data as { task: TaskLike }).task };
    }
    return { kind: 'task', record: data as TaskLike };
  }
}

export function mergeHermesBridgeMetadata(
  existing: Record<string, unknown>,
  hermesPatch: Record<string, unknown>,
): Record<string, unknown> {
  const bridge = readRecord(existing.bridge);
  const existingHermes = readRecord(bridge.hermes);
  return {
    ...existing,
    bridge: {
      ...bridge,
      hermes: {
        ...existingHermes,
        ...hermesPatch,
        lastSyncedAt: stringFrom(hermesPatch.lastSyncedAt) ?? new Date().toISOString(),
      },
    },
  };
}

export function mergeObservabilityMetadata(
  existing: Record<string, unknown>,
  observability: Record<string, unknown>,
): Record<string, unknown> {
  const previous = readRecord(existing.observability);
  return {
    ...existing,
    observability: {
      ...previous,
      ...observability,
      lastSyncedAt: new Date().toISOString(),
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function updatedTime(task: TaskLike): number {
  if (!task.updatedAt) return 0;
  if (task.updatedAt instanceof Date) return task.updatedAt.getTime();
  return Date.parse(task.updatedAt) || 0;
}
