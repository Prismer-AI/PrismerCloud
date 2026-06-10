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
  ResolvedAssetRef,
  TaskDispatchContextEntry,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskDispatchRequestPayload,
} from '../types/im-events.js';
import type { CloudClient } from '../auth.js';
import type { UrlResolution } from '../uri-resolver.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type {
  AdapterDef,
  AdapterService,
  AgentProfile,
  TaskInput,
  TaskResult,
} from '../adapters/contract.js';
import type { AssetCache } from '../asset-cache.js';
import type { UriResolver } from '../uri-resolver.js';
import { envelope } from '../envelope.js';
import type { WsClient } from './ws-client.js';
import type { ArtifactsWatcher } from './artifacts-watcher.js';
import { flushRejections as flushArtifactsRejections } from './artifacts-watcher.js';
import type { ConfigPaths } from '../config.js';
import {
  deriveSessionId,
  resolveSessionDir,
  resolveSessionTaskWorkdir,
  resolveTaskWorkdir,
  UNSCOPED_PROJECT_SENTINEL,
} from '../config.js';
import type { AssetMetadataIndex } from './asset/metadata-index.js';
import { syncInstalledSkillsForDispatch } from './skill-sync.js';
import { resolveAgentDirPaths } from './agent-dir.js';
import { TaskHeartbeat } from './task-heartbeat.js';
import { StepRecorder } from './step-recorder.js';
import { getTaskReaperMinInactivityMs } from './reaper-config.js';
import { daemonMetricEmit, type DaemonMetricEmit } from './metric-emit.js';
import { makeTraceStderr, resolveDispatchTraceId } from './trace.js';

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
  /** Aborts the in-flight adapter dispatch when cloud sends task.cancel. */
  signal?: AbortSignal;
  /** Hook for tests / observability. */
  onProgress?: (taskId: string, p: TaskDispatchProgressPayload) => void;
  /**
   * Artifacts uploader. When provided, dispatch creates a per-task artifacts
   * directory, points the watcher at it via setActiveTask, and drains its
   * assetIds into reply.assetIds at flush time. Optional so tests can omit it.
   */
  artifactsWatcher?: ArtifactsWatcher;
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
}

const DEFAULT_CONTEXT_MAX = 8_000;
const GOAL_CONTEXT_MAX = 4;
const MEMORY_DIGEST_MAX_BYTES = 4_000;
const DEFAULT_OPERATING_PRINCIPLES = [
  '- Decide and act; only request human approval for destructive operations or irreversible external effects.',
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
    payload.kind === 'run' || payload.kind === 'task'
      ? payload.kind
      : taskId.startsWith('run_')
        ? 'run'
        : 'task';
  // The run id for the chat-run path. `payload.runId` is authoritative; the
  // `taskId` field mirrors it on the wire for back-compat, so fall back to it.
  const dispatchRunId = dispatchKind === 'run' ? payload.runId ?? taskId : undefined;

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
  traceLog(
    `[daemon] dispatch start task=${taskId} agent=${agentImUserId ?? '-'} requestId=${requestId ?? '-'}`,
  );

  let resolvedHashes: string[] = [];
  let reply: TaskDispatchReplyPayload;
  // Wave-3 D2: declared here so the finally{} block can stop/flush even when
  // an exception aborts dispatch before they get assigned. We assign the
  // real instances once the adapter is known (later in the try block).
  let heartbeatRef: TaskHeartbeat | undefined;
  let recorderRef: StepRecorder | undefined;
  // release201/11 §4 #7 (skill.invoked) — captured outside the inner try so
  // the finally{} block can emit one event per loaded skill regardless of
  // whether dispatch succeeded or threw. We treat "skill on disk for this
  // dispatch" as the invocation proxy until adapters surface explicit
  // tool_use traces (v2.1+; see 11-doc §4 footnote #7).
  let loadedSkillsForMetric: Array<{ slug: string; skillId?: string | null }> = [];
  // Mirror profile.workspaceId out of the inner try so we can still attach
  // it to the agent.dispatch metric when the run fails before resolveProfile
  // returns (in that case workspaceId stays empty — the cloud /batch endpoint
  // will reject the event with WORKSPACE_REQUIRED, which is the right answer:
  // we don't want orphaned daemon-side metrics with no scope).
  let dispatchWorkspaceId: string | null = null;
  let dispatchProjectId: string | null = null;

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
  // release202/04 §3.1 P1 — session scope. `sid` derives from
  // payload.conversationId at dispatch time (stable cuid, adapter-agnostic);
  // when present, the task dir nests under sessions/<sid>/ and we ensure the
  // session-level artifacts/scratch exist (cross-turn retained). When absent
  // (pure kanban task / agent-to-agent), we keep the plain tasks/<tid>/ layout.
  const sessionId = deriveSessionId(payload.conversationId);
  let sessionDir: string | null = null;

  try {
    const profile = await resolveProfile(payload, deps.cloud);
    dispatchWorkspaceId = profile.workspaceId ?? null;
    dispatchProjectId = payload.projectId ?? null;
    const adapter = deps.registry.get(profile.adapterName);
    if (!adapter) {
      reply = {
        taskId,
        ok: false,
        error: { code: 'adapter_unhealthy', message: `Adapter ${profile.adapterName} not registered` },
      };
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
          ? resolveSessionTaskWorkdir(
              deps.paths,
              profile.workspaceId,
              payload.projectId ?? null,
              sessionId,
              taskId,
            )
          : resolveTaskWorkdir(
              deps.paths,
              profile.workspaceId,
              payload.projectId ?? null,
              taskId,
            );
      artifactsDir = path.join(taskRoot, 'artifacts');
      scratchDir = path.join(taskRoot, 'scratch');
      if (sessionId !== null) {
        sessionDir = resolveSessionDir(
          deps.paths,
          profile.workspaceId,
          payload.projectId ?? null,
          sessionId,
        );
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
        deps.artifactsWatcher.addActiveTask({ taskId, artifactsDir });
      } else if (artifactsDir) {
        // Legacy host-mode (paths.runsDir only, no workspaceId resolved) —
        // keep watcher registration for backward compat. addActiveTask
        // requires per-task artifactsDir, providing isolation across
        // concurrent dispatches.
        deps.artifactsWatcher.addActiveTask({ taskId, artifactsDir });
      } else {
        // Sandbox container/sandbox mode (no per-task scratch, single
        // slot). Container deployment runs one task at a time so single-
        // slot semantics are correct.
        deps.artifactsWatcher.setActiveTask({ taskId });
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
    //   - adapter is hermes/openclaw (the two skill-file consumers)
    //
    // The profile object here is freshly fetched per dispatch (resolveProfile
    // returns a new obj each call), so mutation is safe — no cross-dispatch
    // contamination.
    if (
      agentImUserId &&
      deps.paths &&
      deps.daemonId &&
      (profile.adapterName === 'hermes' || profile.adapterName === 'openclaw') &&
      !(typeof profile.config?.skillsDir === 'string' && profile.config.skillsDir.trim())
    ) {
      const perAgentSkillsDir = resolveAgentDirPaths(
        deps.paths,
        deps.daemonId,
        agentImUserId,
      ).skillsDir;
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
        { paths: deps.paths, daemonId: deps.daemonId },
      );
      if (skillSync.synced > 0 || skillSync.skipped > 0) {
        process.stderr.write(
          `[daemon] skill sync profile=${profile.id} adapter=${profile.adapterName} synced=${skillSync.synced} skipped=${skillSync.skipped}\n`,
        );
      }
      // Capture loaded skills (synced + unchanged) for skill.invoked emit in
      // the finally{} block (release201/11 §4 #7). Skipped entries are not
      // visible to the LLM in this dispatch.
      loadedSkillsForMetric = skillSync.loadedSkills;
    } catch (err) {
      process.stderr.write(`[daemon] skill sync skipped profile=${profile.id}: ${(err as Error).message}\n`);
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
    const assetResolution = await resolveAssetRefs(payload.assetRefs, deps.assetCache, taskId, {
      cloud: deps.cloud,
      enabled: deps.visionAux?.enabled !== false,
      cacheDir: deps.visionAux?.cacheDir ?? (deps.paths ? path.join(deps.paths.cacheDir, 'vision-cache') : undefined),
      timeoutMs: deps.visionAux?.timeoutMs,
      signal: deps.signal,
    });
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
        appendMemoryContext(appendGoalContext(basePrompt, activeGoalContext), memoryContext),
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
    const operatingPrinciples = resolveOperatingPrinciples(profile.config);
    // v2.0 (A3) — single composed system prompt for ALL adapters. Prior to
    // this, dispatch.ts surfaced `systemPrompt` and `operatingPrinciples` as
    // two separate metadata fields. Only Hermes read both; openclaw/codex/
    // claude-code read just one (or neither) → operating principles silently
    // dropped on three of four adapters. Now we concatenate here so every
    // adapter sees the same authoritative string via `metadata.systemPrompt`.
    // Composition order: profile persona FIRST, principles SECOND — the
    // persona owns identity ("You are a product manager"), principles are
    // cross-cutting guidance the persona must operate under.
    const composedSystemPrompt = [profileSystemPrompt, operatingPrinciples]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n');
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
      onGiveUp: (tid, err) =>
        process.stderr.write(
          `[daemon] task.heartbeat give-up task=${tid}: ${err.message}\n`,
        ),
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
    // Initial phase signal — adapter that overrides simply pushes a new
    // setPhase + recordPhaseChange combo.
    recorder.recordPhaseChange(activePhase);

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
      role:
        e.senderRole === 'agent'
          ? 'assistant'
          : e.senderRole === 'system'
            ? 'system'
            : 'user',
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
      ...(e.attachedAssetIds && e.attachedAssetIds.length > 0
        ? { attachedAssetIds: e.attachedAssetIds }
        : {}),
      ...(e.attachedAssets && e.attachedAssets.length > 0
        ? { attachedAssets: e.attachedAssets }
        : {}),
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
      ...(rewrittenContext.length > 0
        ? { contextEntries: rewrittenContext.map(toContextEntry) }
        : {}),
      heartbeat: {
        setPhase: (phase: string) => {
          activePhase = phase;
          heartbeat.setPhase(phase);
          recorder.recordPhaseChange(phase);
        },
        touchStep: () => heartbeat.touchStep(),
      },
      recorder: {
        recordPhaseChange: (phase: string) => {
          activePhase = phase;
          heartbeat.setPhase(phase);
          recorder.recordPhaseChange(phase);
        },
        recordToolCall: (toolName, input, toolCallId) =>
          recorder.recordToolCall(toolName, input, toolCallId),
        recordToolResult: (toolCallId, output) =>
          recorder.recordToolResult(toolCallId, output),
        recordReasoningChunk: (text) => recorder.recordReasoningChunk(text),
        recordError: (message, payload) => recorder.recordError(message, payload),
      },
      // 14b rev.3 §9 P3 — multimodal-aware adapters (Hermes, OpenClaw) pick
      // up the resolved bytes/URLs here; text-only adapters ignore the field.
      ...(assetResolution.resolvedRefs.length > 0
        ? { assetRefs: assetResolution.resolvedRefs }
        : {}),
      // 2026-05-29 — surface non-image asset reminder/inline blocks so
      // adapters that bypass `prompt` (sessions-dispatcher) can still
      // include the attachment context in the current-turn message.
      // See comment on TaskInput.assetPromptBlocks for rationale; this is
      // the W1 root-cause fix for "approval redispatch loses pptx".
      ...(assetResolution.promptBlocks.length > 0
        ? { assetPromptBlocks: assetResolution.promptBlocks }
        : {}),
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
      ...(payload.triggerSenderUsername
        ? { currentMessageSender: payload.triggerSenderUsername }
        : {}),
      ...(payload.triggerSenderRole
        ? { currentMessageSenderRole: payload.triggerSenderRole }
        : {}),
      // release201/25 §7 / release201/26 — typed L3 envelope. Envelope-aware
      // adapter paths (hermes sessions-dispatcher's renderContextEnvelope and
      // the openclaw/claude-code/codex equivalents) consume this directly.
      // When undefined the adapter falls back to the legacy contextEntries +
      // participants + currentMessage* fields above (one release window).
      ...(payload.contextEnvelope ? { contextEnvelope: payload.contextEnvelope } : {}),
      metadata: {
        ...payload.metadata,
        conversationId: payload.conversationId,
        // v2.1 §9.5 — context the hermes adapter forwards into the daemon's
        // local_run_sessions table so `/v1/hooks/*` reverse-lookups can
        // stamp memory pages with §4 MemorySourceStamp.
        agentImUserId: payload.agentImUserId,
        workspaceId: profile.workspaceId,
        ...(typeof (profile.config as { roleTemplate?: { slug?: unknown } })?.roleTemplate?.slug === 'string'
          ? { roleTemplateSlug: (profile.config as { roleTemplate: { slug: string } }).roleTemplate.slug }
          : {}),
        prismerGoals: goalContext.map(toGoalMirrorPayload),
        ...(composedSystemPrompt ? { systemPrompt: composedSystemPrompt } : {}),
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
        ...(scratchDir ? { prismerScratchDir: scratchDir, prismerWorkDir: scratchDir } : {}),
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
          payload.projectId && payload.projectId.length > 0
            ? payload.projectId
            : UNSCOPED_PROJECT_SENTINEL,
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
        ...(dispatchKind === 'run'
          ? { prismerRunId: dispatchRunId ?? taskId }
          : { prismerTaskId: taskId }),
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

    // P2 (2026-05-24): daemon-side retry with exponential backoff.
    //
    // A single transient failure from the LLM gateway (rate-limit 429, brief
    // network blip, sporadic tool error) should NOT immediately surface as
    // "Agent failed ❌" in chat. We retry up to MAX_ATTEMPTS=3 with
    // exponential backoff (1s, 3s). Approval suspension and user cancel are
    // both legitimate non-failures and exit the loop immediately. The reaper
    // signal aborts any pending backoff so we never delay past cancellation.
    //
    // On final exhaustion we synthesise a `daemon_local_retry_exhausted`
    // TaskResult so the cloud handler can render a "retried 3 times" message
    // instead of an opaque adapter error.
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1_000, 3_000];  // wait BEFORE attempt 2 (idx 0) and 3 (idx 1)
    const attemptTrace: Array<{
      attempt: number;
      errorCode: string;
      errorMessage: string;
      durationMs: number;
    }> = [];

    let result: TaskResult | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        process.stderr.write(
          `[daemon] task=${taskId} retry attempt ${attempt}/${MAX_ATTEMPTS} (last: ${lastError?.message ?? 'unknown'})\n`,
        );
        const backoff = BACKOFF_MS[attempt - 2] ?? 9_000;
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
          result = await service.dispatch(taskInput);
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
        if (isApprovalSuspension(result) || isUserCancel(result) || isPermanentUpstreamError(result)) break;
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
      result = {
        ok: false,
        output: '',
        error: {
          code: 'daemon_local_retry_exhausted',
          message: `daemon attempted dispatch ${MAX_ATTEMPTS} times, all failed. Last error: ${lastError?.message ?? 'unknown'}`,
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
    const approvalRequested = Boolean(
      (result.metadata as Record<string, unknown> | undefined)?.approvalRequested,
    );

    // Wave-9: drain the artifacts watcher so any files the adapter wrote to
    // ${artifactsDir} land on this reply as assetIds. We force one final
    // scan first so files written right before adapter return are
    // captured (the watcher's poll interval otherwise creates a 2s window
    // where last-second outputs would miss this dispatch).
    let collectedAssetIds: string[] = [];
    if (deps.artifactsWatcher && artifactsDir) {
      try {
        await deps.artifactsWatcher.scanNow();
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
        }
      : reaperAborted
        ? {
            code: 'daemon_task_timeout',
            message: `Daemon-side reaper aborted after ${reaperLimitMs}ms inactivity (no progress events from adapter)`,
          }
        : result.error;
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
      output: result.output,
      error: finalError,
      ...(collectedAssetIds.length > 0 ? { assetIds: collectedAssetIds } : {}),
      metrics: result.metrics,
      ...((assetResolution.observability.length > 0 || urlObservations.length > 0)
        ? { assetObservability: [...assetResolution.observability, ...urlObservations] }
        : {}),
      ...(collectedRejections.length > 0 ? { outboxRejections: collectedRejections } : {}),
    };
    await writeBridgeMetadata(payload.taskId, deps.cloud, result.metadata, deps.signal);
    await writeObservabilityMetadata(
      payload.taskId,
      deps.cloud,
      taskInput.metadata?.prismerObservability as Record<string, unknown> | undefined,
      deps.signal,
    );
  } catch (err) {
    reply = {
      taskId,
      ok: false,
      error: {
        code: 'adapter_dispatch_failed',
        message: (err as Error).message,
      },
    };
  } finally {
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
        ...loadedSkillsForMetric.map<DaemonMetricEmit>((s) => ({
          namespace: 'skill',
          name: 'invoked',
          value: 1,
          dims: {
            workspaceId: dispatchWorkspaceId!,
            agentId: agentImUserId,
            // Prefer skillId (canonical row id) when present; fall back to slug
            // so older entries that lack an explicit id still get attribution.
            skillId: s.skillId && s.skillId.length > 0 ? s.skillId : s.slug,
            ...(s.skillId ? { slug: s.slug } : {}),
            taskId,
          },
        })),
      ];
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
  }

  sendReply(deps.ws, reply, requestId);
  // release201/30 §7 Phase 3 — bookend matching the entry trace line so
  // operators can sanity-check (a) which traces survived and (b) duration
  // delta against `dispatchStartMs` without correlating across files.
  traceLog(
    `[daemon] dispatch end task=${taskId} ok=${reply.ok} duration_ms=${Date.now() - dispatchStartMs}`,
  );
  // For caller (tests, runner observation).
  void agentImUserId;
  return reply;
}

function sendReply(ws: WsClient, reply: TaskDispatchReplyPayload, requestId: string | undefined): void {
  ws.send(envelope('task.dispatch.reply', reply, requestId));
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

async function resolveProfile(
  payload: TaskDispatchRequestPayload,
  cloud: CloudClient,
): Promise<AgentProfile> {
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

  const history = entries
    .map((e) => `[${e.senderRole}] @${e.sender}: ${e.content}`)
    .join('\n');

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
  const needsCloud = candidates.filter(
    (c) => c.hasExtension && !localResults.has(c.ref),
  );
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
  const sorted = [...resolutions]
    .filter((r) => r.resolvedUri)
    .sort((a, b) => b.start - a.start);
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
export async function probeCdnReachable(
  cdnUrl: string,
  timeoutMs = 1_500,
): Promise<boolean> {
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
      // Short, content-free reminder for adapters that read only the prompt
      // string. Multimodal adapters (Hermes /v1/chat/completions, OpenClaw
      // /v1/responses) consume `task.assetRefs` instead — this block is just
      // a fallback breadcrumb. We do NOT include the file:// localPath anymore
      // because (a) the LLM cannot resolve it, (b) chat-style adapters
      // hallucinate filesystem access from it.
      out.promptBlocks.push(formatAttachmentReminderBlock(ref, effectiveMime));
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
    process.env.VISION_AUX_INTERNAL_SECRET ||
    process.env.INTERNAL_API_SECRET ||
    process.env.PRISMER_INTERNAL_SECRET;
  const headers = secret ? { 'x-prismer-internal-secret': secret } : undefined;
  const res = await opts.cloud.request<VisionAuxResponseEnvelope>(
    'POST',
    '/api/internal/vision-aux/describe',
    {
      body: {
        assetId: ref.assetId,
        contentHash: ref.contentHash,
        mime: mime ?? ref.mime ?? 'image/unknown',
        source,
      },
      headers,
      timeoutMs: opts.timeoutMs ?? 12_000,
      signal: opts.signal,
    },
  );
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
 */
function formatAttachmentReminderBlock(ref: AssetRef, mime: string | null): string {
  const name = ref.filename ? ` name=${ref.filename}` : '';
  return `[Attached file] id=${ref.assetId} mime=${mime ?? 'unknown'}${name} — the user uploaded this file; multimodal adapters receive the bytes directly.`;
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
}

export function appendGoalContext(prompt: string, goals: TaskLike[]): string {
  if (goals.length === 0) return prompt;
  const lines = goals.slice(0, GOAL_CONTEXT_MAX).map((goal, index) => {
    const metaGoal = readRecord(goal.metadata?.goal);
    const priority = typeof metaGoal.priority === 'string' ? metaGoal.priority : 'medium';
    const description = typeof goal.description === 'string' && goal.description.trim() ? ` — ${goal.description.trim()}` : '';
    return `${index + 1}. [${priority}] ${goal.title ?? goal.id}${description}`;
  });
  return `[Active Goals]\n${lines.join('\n')}\n\n${prompt}`;
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

export function appendMemoryContext(prompt: string, memory: MemoryContext): string {
  if (memory.status !== 'loaded' || !memory.digest.trim()) return prompt;
  return `[Memory Context]\n${memory.digest.trim()}\n\n${prompt}`;
}

export function resolveOperatingPrinciples(config: Record<string, unknown> | undefined): string {
  const cfg = readRecord(config);
  const roleTemplate = readRecord(cfg.roleTemplate);
  const principles =
    stringifyPrinciples(cfg.operatingPrinciples) ??
    stringifyPrinciples(roleTemplate.operatingPrinciples) ??
    DEFAULT_OPERATING_PRINCIPLES;
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
    "cwd which is sandboxed but unpredictable, and any path outside the two",
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
    'or ANY path outside the ' +
      (scratchDir ? 'two directories' : 'directory') +
      ' above. Files written elsewhere are',
    'lost (not delivered), pollute the host machine, and are treated as a',
    'hard error.',
    '',
    'If you produce a file but write it OUTSIDE ' +
      (scratchDir ? 'both directories' : 'the directory') +
      ' with a',
    "relative path, it will NOT become a chat attachment and may pollute the",
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
      const other =
        participants.find(
          (p) => p.username !== myUsername && p.imUserId !== myImUserId,
        ) ?? participants[0];
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
        lines.push(
          `Participants in ${groupLabel} (${headerCount}): ${head}, …and ${tail} more`,
        );
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
    }>(
      `/api/im/memory/digest?maxLines=120&maxBytes=${MEMORY_DIGEST_MAX_BYTES}`,
      { signal },
    );
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
    return tasks
      .filter((task) => isGoalTask(task))
      .filter((task) => goalAppliesToDispatch(task, payload, profile))
      .sort((a, b) => updatedTime(b) - updatedTime(a))
      .slice(0, GOAL_CONTEXT_MAX);
  } catch (err) {
    process.stderr.write(`[daemon] goal context load skipped for task=${payload.taskId}: ${(err as Error).message}\n`);
    return [];
  }
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

function goalAppliesToDispatch(
  task: TaskLike,
  payload: TaskDispatchRequestPayload,
  profile: AgentProfile,
): boolean {
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
    const res = await cloud.request('PATCH', current.kind === 'run' ? `/api/im/runs/${encodeURIComponent(taskId)}` : `/api/im/tasks/${encodeURIComponent(taskId)}`, {
      body: { metadata },
      signal,
    });
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
    const res = await cloud.request('PATCH', current.kind === 'run' ? `/api/im/runs/${encodeURIComponent(taskId)}` : `/api/im/tasks/${encodeURIComponent(taskId)}`, {
      body: { metadata },
      signal,
    });
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
    const data = await cloud.get<TaskLike | { task: TaskLike }>(`/api/im/runs/${encodeURIComponent(taskId)}`, { signal });
    if (data && typeof data === 'object' && 'run' in data) {
      return { kind: 'run', record: (data as { run: TaskLike }).run };
    }
    return { kind: 'run', record: data as TaskLike };
  } catch {
    const data = await cloud.get<TaskLike | { task: TaskLike }>(`/api/im/tasks/${encodeURIComponent(taskId)}`, { signal });
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

function updatedTime(task: TaskLike): number {
  if (!task.updatedAt) return 0;
  if (task.updatedAt instanceof Date) return task.updatedAt.getTime();
  return Date.parse(task.updatedAt) || 0;
}
