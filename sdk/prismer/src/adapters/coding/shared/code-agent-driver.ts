// WS-B (PP-1) — CodeAgentDriver: the keystone bridge that makes a code-agent
// `AgentSession` look like our `AdapterService` (contract.ts).
//
// This is the §7.6 ① shim. The daemon's dispatch/retry/reaper/artifacts-watcher
// are untouched — they don't know the far side is a code-agent session (ported from Paseo). We map:
//
//   AgentSession.run(prompt) → AgentRunResult   ⊇   AdapterService.dispatch(task) → TaskResult
//   finalText                 → output
//   usage                     → metrics
//   canceled                  → error.task_cancelled
//   subscribe(event)          → task.recorder.* / task.heartbeat.setPhase
//
// contract.ts needs NO breaking change — only the optional members WS-A already
// added (setModel?/revert?/listModes?/listCommands? + capabilityFlags?).
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.6 ①, §7.7 WS-B.

import type {
  AdapterService,
  TaskInput,
  TaskResult,
} from "../../contract.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentPersistenceHandle,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentUsage,
} from "./agent-sdk-types.js";
import {
  buildProviderProxyInjection,
  type CodeAgentProxyConfig,
} from "./provider-proxy-env.js";
import { isVisionCapableModel } from "./vision-gate.js";
// desktop205 W5 — the APC_HELDOUT_DENY env name has exactly one owner
// (claude-code/config-isolation.ts); this module only maps the stamped verdict
// onto the per-task env overlay.
import { apcHeldOutDenyTaskEnv } from "../claude-code/config-isolation.js";
// product204/37 WS-3 — behaviour role params ride metadata.roleParams; render
// them into the coding --system-prompt so the agent can read + honour them.
import { renderRoleParamsBlock, roleParamsFromMetadata } from "../../prismer-env.js";

const MODULE = "[CodeAgentDriver]";

/**
 * release203 — DAEMON-SIDE FORCE: coding agents in agent-rt pods are ALWAYS
 * non-interactive. A tool permission prompt can never be answered there, so the
 * provider blocks until the 300s watchdog (confirmed live: run f27vyi hung 328s).
 * The pod IS the isolation boundary, so coding sessions must launch fully
 * autonomous regardless of the stored profile config.
 *
 * Per-provider autonomous mapping (the SDK equivalents of the CLI bypass flags):
 *  - claude-code: permissionMode 'bypassPermissions' (≙ --dangerously-skip-permissions)
 *  - codex:       modeId 'full-access' + sandbox 'danger-full-access' + approval
 *                 'never' (≙ --dangerously-bypass-approvals-and-sandbox)
 *  - opencode:    modeId 'build' + featureValues.auto_accept=true (the
 *                 tryAutoApproveToolPermission path; opencode has no CLI bypass
 *                 flag — auto_accept is its autonomous mechanism)
 *
 * Policy: if the profile's modeId is ALREADY an autonomous value, keep it (don't
 * override an explicit choice); otherwise FORCE the per-provider autonomous mode.
 * Applied on BOTH createSession (buildSessionConfig) and resumeSession (overrides)
 * so existing agents whose stored handle metadata carries a stale/absent modeId
 * are covered, not just new ones.
 */
const OPENCODE_AUTO_ACCEPT_FEATURE_ID = "auto_accept";

/** Fields forced onto a session config to make a provider launch autonomous. */
type AutonomousOverrides = Pick<
  AgentSessionConfig,
  "modeId" | "sandboxMode" | "approvalPolicy" | "featureValues"
>;

/** True when `modeId` already selects the provider's autonomous mode. */
function isAutonomousMode(provider: string, modeId: string | undefined): boolean {
  switch (provider) {
    case "claude":
      return modeId === "bypassPermissions";
    case "codex":
      return modeId === "full-access";
    case "opencode":
      // opencode autonomy rides on the auto_accept feature, not the mode id, so
      // the mode id alone never proves autonomy — always re-assert auto_accept.
      return false;
    default:
      return false;
  }
}

/**
 * Compute the per-provider autonomous overrides for a session config, preserving
 * an already-autonomous modeId. Returns the config unchanged for non-coding /
 * unknown providers.
 */
function withAutonomousLaunch(
  provider: string,
  config: AgentSessionConfig,
): AgentSessionConfig {
  if (isAutonomousMode(provider, config.modeId)) return config;

  let overrides: AutonomousOverrides;
  switch (provider) {
    case "claude":
      overrides = { modeId: "bypassPermissions" };
      break;
    case "codex":
      overrides = {
        modeId: "full-access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      };
      break;
    case "opencode":
      overrides = {
        modeId: "build",
        featureValues: {
          ...config.featureValues,
          [OPENCODE_AUTO_ACCEPT_FEATURE_ID]: true,
        },
      };
      break;
    default:
      return config;
  }
  console.log(
    `${MODULE} forcing autonomous launch provider=${provider} modeId=${overrides.modeId} (was ${config.modeId ?? "(absent)"})`,
  );
  return { ...config, ...overrides };
}

/**
 * Error code used to mark a turn-execution failure as NON-RETRYABLE.
 *
 * 🔴 TRAP 1 (retry × live session), doc 08 §7.6 ①:
 * dispatch.ts's retry loop (MAX_ATTEMPTS=3) assumes dispatch() is idempotent.
 * But a Paseo session is STATEFUL — re-running run() against an already-advanced
 * session appends a DUPLICATE turn and pollutes the context window. We defend
 * with BOTH belts the doc allows:
 *
 *   (a) Per-task guard: we record the outcome per taskId. A second dispatch()
 *       with the same taskId returns the cached terminal result without
 *       touching the live session (so even a future change to dispatch.ts's
 *       break conditions can't double-run).
 *   (b) Non-retryable marker: turn failures surface as error.code ===
 *       'task_cancelled' (an existing dispatch.ts break condition via
 *       isUserCancel) so the retry loop exits WITHOUT re-invoking run(). We do
 *       NOT throw (a thrown error is always retried by dispatch.ts).
 *
 * We deliberately reuse the existing 'task_cancelled' break-condition rather
 * than asking for a new non-retryable hook in dispatch.ts — per the WS-B
 * constraint "if TRAP 1's non-retryable marking requires a dispatch.ts change,
 * STOP". It does not: the existing isUserCancel/isPermanentUpstreamError gates
 * are sufficient, and the per-task guard is the primary defense regardless.
 */
const TURN_FAILED_CODE = "task_cancelled";

interface TaskOutcome {
  /** 'running' while a turn is in flight; terminal once run() settles. */
  state: "running" | "terminal";
  /** The terminal TaskResult, once settled. */
  result?: TaskResult;
}

function readMetaString(task: TaskInput, key: string): string | undefined {
  const v = task.metadata?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * release203/11 §2.2 (Slice A) — compose the effective coding system prompt
 * from the dispatch metadata: IDENTITY + USER + scope lines first (canonical
 * order), then the persona/SOUL portion (`metadata.systemPrompt`, which carries
 * either the role persona or the CODING_SOUL_DEFAULT dispatch.ts substituted for
 * 净身 coding agents). Falls back to the static profile systemPrompt when the
 * daemon didn't compose one (e.g. driver invoked outside the daemon in tests).
 *
 * This is what fixes "who are you?" answering as generic Claude: the净身 coding
 * agent's profile.config.systemPrompt is '', so without folding the dynamic
 * identity + the SOUL default into --system-prompt the model leads with its own
 * persona. Empty when nothing resolves (undefined → provider default).
 */
function composeCodingSystemPrompt(
  task: TaskInput,
  fallbackSystemPrompt: string | undefined,
): string | undefined {
  const idCtx = task.metadata?.identityContext as
    | { identity?: unknown; user?: unknown; scope?: unknown; sections?: unknown }
    | undefined;
  const identityLines = idCtx
    ? [idCtx.identity, idCtx.user, idCtx.scope].filter(
        (line): line is string => typeof line === "string" && line.trim().length > 0,
      )
    : [];
  // product204/07 Phase C — named identityContext sections (分段注册制).
  // dispatch.ts pre-renders them to ordered content strings; they join AFTER
  // the identity triple, same slot. Non-strings filtered for direct-invoke
  // (non-daemon) callers that might pass the raw wire shape.
  const identitySections = Array.isArray(idCtx?.sections)
    ? idCtx.sections.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  const persona = readMetaString(task, "systemPrompt") ?? fallbackSystemPrompt;
  // product204/37 WS-3 — behaviour role params (metadata.roleParams) render as a
  // block AFTER persona so the agent reads its role's tone/behaviour knobs.
  const roleParamsBlock = renderRoleParamsBlock(
    roleParamsFromMetadata(task.metadata as Record<string, unknown> | undefined),
  );
  const parts = [
    ...identityLines,
    ...identitySections,
    ...(persona ? [persona] : []),
    ...(roleParamsBlock ? [roleParamsBlock] : []),
  ];
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Decode a persistence handle round-tripped through metadata.providerSessionId. */
function decodePersistenceHandle(raw: string | undefined): AgentPersistenceHandle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AgentPersistenceHandle;
    if (parsed && typeof parsed.sessionId === "string" && typeof parsed.provider === "string") {
      return parsed;
    }
  } catch {
    /* not a JSON handle */
  }
  return null;
}

function encodePersistenceHandle(handle: AgentPersistenceHandle | null): string | undefined {
  return handle ? JSON.stringify(handle) : undefined;
}

function isImageMime(mime: string | null | undefined): boolean {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
}

function usageToMetrics(usage: AgentUsage | undefined): TaskResult["metrics"] {
  if (!usage) return undefined;
  const tokensUsed =
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  return tokensUsed > 0 ? { tokensUsed } : undefined;
}

/** Options for constructing a session config from a task (provider-agnostic). */
export interface CodeAgentDriverOptions {
  /** Working directory for the agent session (repo-scoped cwd, doc 06 §3.7). */
  cwd: string;
  /** Optional system prompt forwarded to the session config. */
  systemPrompt?: string;
  /** Optional model id. */
  model?: string;
  /** Optional mode id. */
  modeId?: string;
  /**
   * WS-B2.5 — provider-chain routing config (route / proxyProvider / key env).
   * When set (route:'prismer' or proxyProvider), each session is launched with
   * our cloud-gateway base_url + token injected via launchContext.env so the
   * ported provider authenticates through OUR gateway, NOT official login.
   */
  proxy?: CodeAgentProxyConfig;
  /**
   * runtime210/09 §3.1b (C3c ruling, Path B) — which channel carries pi
   * `text_delta` stream frames. Default 'off' preserves pre-pi behaviour
   * (deltas not forwarded — only the settled message is recorded). Only
   * pi-core opts into 'steps' (recorder `text_delta` step kind, 500ms batch);
   * the progress channel was measured in the §3.1a spike and ruled out.
   */
  textDeltaChannel?: "off" | "steps";
  /**
   * runtime210/09 §3.1b — emit task.onProgress heartbeats on turn/tool events.
   * Default off (coding adapters keep their existing progress behaviour — only
   * hermes / legacy codex emit progress today). pi-core opts in: its turn and
   * tool events carry a legal monotonic `progress` placeholder (never the text
   * stream — deltas ride the steps channel above).
   */
  progressHeartbeat?: boolean;
  /**
   * runtime210/09 §2.3 (review P1-C) — prefer the dispatch's materialized
   * workdir (task.metadata.prismerScratchDir / legacy prismerWorkDir — the
   * paths dispatch.ts stamps from `adapterCwdOverride`) over the profile cwd
   * when creating the session. pi-core opts in: its engine jails read/write/
   * edit to the SESSION cwd, so the jail must bind the materialized workdir,
   * not the profile default. Coding adapters keep this off — their session cwd
   * must stay the stable profile/repo cwd for cross-turn resume.
   */
  taskCwdPriority?: boolean;
}

/**
 * A long-running AdapterService backed by a Paseo AgentClient. Holds one
 * AgentSession per (conversationId × agentImUserId) so multi-turn chat reuses a
 * single stateful session instead of paying full-resume each turn.
 */
export class CodeAgentDriver implements AdapterService {
  readonly id: string;

  private sessions = new Map<string, AgentSession>();
  /** Off-band key for the slash-command warm session (ensureWarmSession). */
  private static readonly WARM_SESSION_KEY = "__warm__";
  /** In-flight guard so concurrent listCommands() calls share one warm session. */
  private warmSessionPromise?: Promise<AgentSession | undefined>;
  /** TRAP 1 per-task guard (see TURN_FAILED_CODE doc). */
  private taskOutcomes = new Map<string, TaskOutcome>();
  /** runtime210/09 §3.1b — per-task heartbeat progress (progressHeartbeat on). */
  private progressByTask = new Map<string, number>();
  private shuttingDown = false;

  constructor(
    private readonly client: AgentClient,
    private readonly options: CodeAgentDriverOptions,
  ) {
    this.id = `code-agent:${client.provider}`;
  }

  /** sessionKey scopes a Paseo session to one (conversation × agent) pair. */
  private sessionKey(task: TaskInput): string {
    const conversationId = readMetaString(task, "conversationId") ?? task.conversationId ?? "";
    const agentImUserId =
      readMetaString(task, "agentImUserId") ?? task.profileAgentImUserId ?? "";
    return `${conversationId}${agentImUserId}${this.client.provider}`;
  }

  private buildSessionConfig(task: TaskInput): AgentSessionConfig {
    // runtime210/09 §2.3 (review P1-C) — taskCwdPriority engines (pi-core)
    // bind the session jail cwd to the dispatch's materialized workdir when
    // one was stamped; otherwise keep the profile cwd. Default off — coding
    // adapters keep their stable profile/repo cwd for cross-turn resume.
    const taskCwd = this.options.taskCwdPriority
      ? readMetaString(task, "prismerWorkdirOverride") ?? undefined
      : undefined;
    const config: AgentSessionConfig = {
      provider: this.client.provider,
      cwd: taskCwd ?? this.options.cwd,
      // release203/11 §2.2 (Slice A) — prefer the daemon-composed prompt
      // (identity + USER + scope + persona/SOUL default) over the static
      // profile systemPrompt so净身 coding agents stop answering as generic
      // Claude. Falls back to options.systemPrompt outside the daemon.
      systemPrompt: composeCodingSystemPrompt(task, this.options.systemPrompt),
      model: this.options.model,
      modeId: this.options.modeId,
      ...this.apcHeldOutExtra(task),
    };
    // Daemon-side FORCE: coding sessions are non-interactive in agent-rt pods, so
    // launch fully autonomous (covers profiles whose modeId is absent/non-autonomous).
    return withAutonomousLaunch(this.client.provider, config);
  }

  /**
   * desktop205 W5 — carry the dispatch's APC coding-scope verdict into the
   * per-task env overlay (`extra.claude.env` → `buildClaudeSpawnEnv`'s
   * `taskEnv` → `apcHeldOutDenySettings(sdkEnv)` in claude-code/agent.ts).
   *
   * This is the FIRST writer of `extra.claude.env`; before W5 the seam existed
   * and was wired all the way to the spawn, but nothing ever set it, so the
   * held-out deny hint could only be turned on daemon-globally (F7) or not at
   * all. `{}` when the verdict says no, so the field is simply absent.
   *
   * Upstream already restricts the stamp to claude-code profiles with a coding
   * cwd (`skill-sync.ts::resolveApcCodingScope`); `extra.claude` is inert for
   * the other providers regardless.
   */
  private apcHeldOutExtra(task: TaskInput): Pick<AgentSessionConfig, "extra"> | Record<string, never> {
    const env = apcHeldOutDenyTaskEnv(task.metadata as Record<string, unknown> | undefined);
    return env ? { extra: { claude: { env } } } : {};
  }

  /**
   * WS-B2.5 — build the launch context carrying our cloud-gateway provider
   * injection (env) for this task. Returns undefined when no proxy config is
   * present so providers keep their default (official) launch env unchanged.
   */
  private buildLaunchContext(task: TaskInput): AgentLaunchContext | undefined {
    if (!this.options.proxy) return undefined;
    const injection = buildProviderProxyInjection(
      this.client.provider,
      this.options.proxy,
      task.metadata as Record<string, unknown> | undefined,
    );
    if (!injection) return undefined;
    return { env: injection.env };
  }

  /**
   * Resolve-or-create the session for this task:
   *   - live in-process session for the key → reuse.
   *   - prior providerSessionId handle in task.metadata → resumeSession.
   *   - otherwise → createSession (first turn).
   */
  private async resolveSession(task: TaskInput): Promise<AgentSession> {
    const key = this.sessionKey(task);
    const live = this.sessions.get(key);
    if (live) {
      console.log(`${MODULE} reuse session key=${key} id=${live.id}`);
      return live;
    }

    // WS-B2.5 — inject OUR cloud-gateway provider (base_url + token) per the
    // profile's provider-chain config. Forwarded via launchContext.env, the seam
    // every Paseo provider overlays onto its spawned subprocess env. null when
    // routing not requested / env missing (→ official endpoint, as before).
    const launchContext = this.buildLaunchContext(task);

    const handle = decodePersistenceHandle(readMetaString(task, "providerSessionId"));
    let session: AgentSession;
    if (handle && this.client.capabilities.supportsSessionPersistence) {
      console.log(`${MODULE} resumeSession provider=${this.client.provider} sid=${handle.sessionId}`);
      // Daemon-side FORCE on resume too: the stored handle metadata may carry a
      // stale/absent modeId (existing agents created before this force). Pass the
      // per-provider autonomous overrides so resumed sessions are non-interactive.
      // desktop205 W5 — the verdict must ride the RESUME path too. A session is
      // reused per (conversation × agent), and `resumeSession` merges only what
      // it is handed; omitting `extra` here would silently drop the boundary on
      // every turn after the first (and on any daemon restart that resumes from
      // a stored handle).
      const resumeOverrides = withAutonomousLaunch(this.client.provider, {
        provider: this.client.provider,
        cwd: this.options.cwd,
        ...this.apcHeldOutExtra(task),
      });
      session = await this.client.resumeSession(handle, resumeOverrides, launchContext);
    } else {
      console.log(`${MODULE} createSession provider=${this.client.provider}`);
      session = await this.client.createSession(this.buildSessionConfig(task), launchContext);
    }
    this.sessions.set(key, session);
    return session;
  }

  async dispatch(task: TaskInput): Promise<TaskResult> {
    // TRAP 1 (a) — per-task guard. A retried dispatch for the same taskId must
    // NOT re-run against the (now advanced) live session.
    const prior = this.taskOutcomes.get(task.taskId);
    if (prior) {
      if (prior.state === "terminal" && prior.result) {
        console.log(`${MODULE} task=${task.taskId} replaying cached terminal result (retry guard)`);
        return prior.result;
      }
      // A turn is already in flight for this taskId — refuse to start a second.
      console.log(`${MODULE} task=${task.taskId} already in-flight; refusing duplicate run (retry guard)`);
      return {
        ok: false,
        error: { code: TURN_FAILED_CODE, message: "Turn already in progress for this task" },
      };
    }
    this.taskOutcomes.set(task.taskId, { state: "running" });

    let session: AgentSession;
    try {
      session = await this.resolveSession(task);
    } catch (err) {
      const result: TaskResult = {
        ok: false,
        error: {
          code: TURN_FAILED_CODE,
          message: `Failed to resolve code-agent session: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      this.taskOutcomes.set(task.taskId, { state: "terminal", result });
      return result;
    }

    // TRAP 2 (abort → interrupt, NOT close), doc 08 §7.6 ①:
    // the reaper / user-cancel fires task.signal.abort(). Paseo interrupt() is
    // TURN-SCOPED and keeps the session alive; close() would discard it and the
    // next turn would pay a full resume. So we map abort → session.interrupt().
    // close() is reserved for service shutdown() only.
    const onAbort = (): void => {
      console.log(`${MODULE} task=${task.taskId} abort → session.interrupt() (TRAP 2)`);
      void session.interrupt().catch((err) => {
        console.error(`${MODULE} interrupt failed`, err);
      });
    };
    if (task.signal) {
      if (task.signal.aborted) onAbort();
      else task.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Forward stream events → recorder + heartbeat.
    const unsubscribe = session.subscribe((event) =>
      this.forwardEvent(event, task),
    );

    try {
      task.heartbeat?.setPhase("thinking");
      const prompt = this.buildPromptInput(task);
      const workspaceId = readMetaString(task, "workspaceId");
      const agentImUserId = readMetaString(task, "agentImUserId");
      const conversationId = readMetaString(task, "conversationId") ?? task.conversationId;
      const traceId = readMetaString(task, "traceId");
      const canonicalTurnId = readMetaString(task, "runtimeCanonicalTurnId") ?? task.taskId;
      const runId = readMetaString(task, "runtimeRunId") ??
        (task.taskId?.startsWith("run_") ? task.taskId : undefined);
      const messageId = readMetaString(task, "triggerMessageId") ?? readMetaString(task, "messageId");
      const executionModel = readMetaString(task, "runtimeExecutionModel") ??
        this.options.proxy?.model ?? this.options.model;
      const runResult = await session.run(prompt, {
        messageId: task.taskId,
        ...(workspaceId && agentImUserId
          ? {
              postTurn: {
                workspaceId,
                agentImUserId,
                ...(conversationId ? { conversationId } : {}),
                ...(runId ? { runId } : {}),
                ...(messageId ? { messageId } : {}),
                canonicalTurnId,
                turnId: task.taskId,
                lane: "async-repair",
                userMessage: task.currentPrompt ?? task.prompt,
                ...(traceId ? { traceId } : {}),
                executionContext: {
                  adapterName: this.client.provider,
                  ...(readMetaString(task, "runtimeProfileId")
                    ? { profileId: readMetaString(task, "runtimeProfileId") }
                    : {}),
                  ...(readMetaString(task, "runtimeProfileName")
                    ? { profileName: readMetaString(task, "runtimeProfileName") }
                    : {}),
                  ...(readMetaString(task, "roleTemplateSlug")
                    ? { roleSlug: readMetaString(task, "roleTemplateSlug") }
                    : {}),
                  ...(executionModel ? { model: executionModel } : {}),
                  ...(readMetaString(task, "runtimeProxyProvider") ?? this.options.proxy?.proxyProvider
                    ? { proxyProvider: readMetaString(task, "runtimeProxyProvider") ?? this.options.proxy?.proxyProvider }
                    : {}),
                },
              },
            }
          : {}),
      });
      const result = this.mapRunResult(runResult, session);
      this.taskOutcomes.set(task.taskId, { state: "terminal", result });
      return result;
    } catch (err) {
      // Any thrown error from run() is a turn-execution failure. Mark
      // NON-RETRYABLE (TRAP 1 (b)) — return, never throw, with the
      // 'task_cancelled' break code so dispatch.ts's loop exits without re-run.
      const aborted = task.signal?.aborted || (err as { name?: string })?.name === "AbortError";
      const result: TaskResult = {
        ok: false,
        error: {
          code: TURN_FAILED_CODE,
          message: aborted
            ? "Task cancelled by client"
            : `Code-agent turn failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      this.taskOutcomes.set(task.taskId, { state: "terminal", result });
      return result;
    } finally {
      unsubscribe();
      this.progressByTask.delete(task.taskId);
      if (task.signal) {
        try {
          task.signal.removeEventListener("abort", onAbort);
        } catch {
          /* never throws in standards-compliant runtimes */
        }
      }
    }
  }

  /**
   * Build the AgentPromptInput for this turn, FORWARDING input attachments the
   * daemon resolved onto the task. The bare-text path is unchanged.
   *
   * 🔴 Regression fix (vs the OLD CLI adapters which sent `task.prompt`): the
   * previous driver sent only `task.currentPrompt ?? task.prompt`. `currentPrompt`
   * is the bare rewritten user text with NO asset blocks and is ALWAYS set, so
   * the `??` never fired → text-file bodies AND image attachments were dropped.
   *
   * Resolution (mirrors what dispatch.ts already computed onto the task):
   *
   *  1. TEXT base — when ANY attachment is present (`assetPromptBlocks` or
   *     image `assetRefs`), use `task.prompt`: dispatch.ts:composePrompt already
   *     inlined the text-file bodies + asset reminder blocks into it (the source
   *     the legacy CLI adapters consumed). With no attachment, keep the existing
   *     `currentPrompt ?? prompt` behavior so the no-attachment case is identical.
   *
   *  2. IMAGE blocks (vision) — for each image-type `assetRef`, emit an
   *     `{type:'image', data, mimeType}` content block (raw base64 / cdnUrl —
   *     the shape every ported provider consumes), BUT ONLY when the target model
   *     is vision-capable. Non-vision models reject image parts at the wire level,
   *     so for them we send NO image block and rely on the as-file reminder text
   *     (already inlined into `task.prompt`) — graceful as-file degradation.
   */
  private buildPromptInput(task: TaskInput): AgentPromptInput {
    // Only base64-backed image refs can become content blocks: every ported
    // provider treats `image.data` as RAW base64 (claude → source.data, codex →
    // Buffer.from(data,'base64'), opencode → data:<mime>;base64,<data>). A cdnUrl
    // is NOT base64, so a URL-only ref stays as the as-file reminder text (the
    // daemon's reachability fallback already inlines base64 when the cdnUrl is
    // unreachable by the upstream LLM — see dispatch.ts resolveAssetRefs).
    const imageRefs = (task.assetRefs ?? []).filter(
      (ref) => isImageMime(ref.mime) && !!ref.base64,
    );
    const hasAssetBlocks = (task.assetPromptBlocks?.length ?? 0) > 0;
    const hasAttachments = hasAssetBlocks || imageRefs.length > 0;

    // (1) text base
    const text: string = hasAttachments
      ? task.prompt
      : (task.currentPrompt ?? task.prompt);

    // (2) vision-gated image blocks
    const model = this.options.proxy?.model ?? this.options.model;
    const visionCapable = isVisionCapableModel(model);
    if (imageRefs.length === 0 || !visionCapable) {
      if (imageRefs.length > 0 && !visionCapable) {
        console.log(
          `${MODULE} task=${task.taskId} ${imageRefs.length} image attachment(s) NOT sent as pixels — model=${model ?? "(default)"} non-vision; degrading to as-file (reminder text in prompt)`,
        );
      }
      return text;
    }

    const blocks: AgentPromptContentBlock[] = [{ type: "text", text }];
    for (const ref of imageRefs) {
      blocks.push({
        type: "image",
        data: ref.base64 as string,
        mimeType: ref.mime ?? "image/png",
      });
    }
    console.log(
      `${MODULE} task=${task.taskId} forwarding ${blocks.length - 1} image block(s) (vision model=${model})`,
    );
    return blocks;
  }

  /** Map a Paseo AgentRunResult into our TaskResult. */
  private mapRunResult(runResult: AgentRunResult, session: AgentSession): TaskResult {
    const metadata = this.persistenceMetadata(session, runResult);
    if (runResult.canceled) {
      return {
        ok: false,
        error: { code: "task_cancelled", message: "Task cancelled by client" },
        metadata,
      };
    }
    return {
      ok: true,
      output: runResult.finalText,
      metrics: usageToMetrics(runResult.usage),
      metadata,
    };
  }

  /** Round-trip the Paseo persistence handle through metadata.providerSessionId. */
  private persistenceMetadata(
    session: AgentSession,
    runResult?: Pick<AgentRunResult, "servedModel" | "servedProvider">,
  ): Record<string, unknown> | undefined {
    const handle = session.describePersistence();
    const encoded = encodePersistenceHandle(handle);
    const metadata = {
      ...(encoded ? { providerSessionId: encoded } : {}),
      ...(runResult?.servedModel ? { modelUsed: runResult.servedModel } : {}),
      ...(runResult?.servedProvider ? { providerUsed: runResult.servedProvider } : {}),
    };
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /** Forward a Paseo stream event into the task recorder / heartbeat. */
  private forwardEvent(event: AgentStreamEvent, task: TaskInput): void {
    const recorder = task.recorder;
    const heartbeat = task.heartbeat;
    switch (event.type) {
      case "turn_started":
        heartbeat?.setPhase("thinking");
        // runtime210/09 §3.1b — pi-core turn heartbeat (hermes/codex already
        // emit progress; pi-core was the missing engine). progressHeartbeat is
        // off for the coding adapters — their progress behaviour is unchanged.
        if (this.options.progressHeartbeat) {
          this.emitProgressHeartbeat(task, "thinking", {
            kind: "turn",
            event: "turn_started",
          });
        }
        break;
      case "timeline": {
        heartbeat?.touchStep();
        const item = event.item;
        if (item.type === "tool_call") {
          heartbeat?.setPhase("tool_use");
          // WS-C — thread the lifted ToolCallDetail + lifecycle status through
          // to the recorder. altitude is derived from the detail type inside
          // the recorder (shell/read/edit/write/search/fetch → 'action', else
          // 'milestone'), keeping the long-horizon timeline from drowning.
          if (item.status === "running") {
            recorder?.recordToolCall(item.name, item.detail, item.callId, {
              detail: item.detail,
              status: "running",
            });
            if (this.options.progressHeartbeat) {
              this.emitProgressHeartbeat(task, item.name, {
                kind: "tool",
                event: "tool_call.running",
                tool: item.name,
              });
            }
          } else if (
            item.status === "completed" ||
            item.status === "failed" ||
            item.status === "canceled"
          ) {
            recorder?.recordToolResult(item.callId, item.detail, {
              detail: item.detail,
              status: item.status,
            });
          }
        } else if (item.type === "reasoning") {
          recorder?.recordReasoningChunk(item.text);
        } else if (item.type === "todo") {
          // WS-C — todo snapshots are milestones (recorder tags them).
          recorder?.recordTodo?.(item.items);
        } else if (item.type === "error") {
          recorder?.recordError(item.message);
        }
        break;
      }
      case "usage_updated":
      case "turn_completed":
        // WS-C — surface usage so RunMetrics.tokens stops being known-zero.
        if (event.usage) recorder?.recordUsage?.(event.usage);
        break;
      case "turn_failed":
        recorder?.recordError(event.error, event.code ? { code: event.code } : undefined);
        break;
      case "text_delta":
        // runtime210/09 §3.1b (C3c ruling, Path B) — pi-native text deltas ride
        // the steps channel (recorder batches 500ms into `text_delta` steps).
        // Never mixed with the progress channel: task.dispatch.progress keeps
        // its heartbeat/typing-dot semantics and progress stays a ratio.
        if (this.options.textDeltaChannel === "steps") {
          recorder?.recordTextDelta?.(event.delta, { deltaKind: event.deltaKind });
        }
        break;
      default:
        break;
    }
  }

  /**
   * runtime210/09 §3.1b — progress heartbeat for engines that opted in
   * (pi-core). `progress` is a legal monotonic placeholder NORMALIZED TO THE
   * SAME 0..1 contract the rest of the daemon emits (0.05 → +0.05 per event,
   * capped at 0.95 — the dispatcher owns 1.0; cf. hermes sessions-sse's
   * 0.01–0.99 clamp and dispatch.ts's retry 0.05), never a stream ratio, and
   * the detail carries only event metadata — the text stream rides the steps
   * channel instead. State is per-task and dropped when the dispatch settles.
   */
  private emitProgressHeartbeat(
    task: TaskInput,
    message: string,
    detail: Record<string, unknown>,
  ): void {
    const current = this.progressByTask.get(task.taskId) ?? 0;
    const next = Math.min(0.95, current + 0.05);
    this.progressByTask.set(task.taskId, next);
    task.onProgress?.({ progress: next, message, detail });
  }

  async healthy(): Promise<boolean> {
    try {
      return await this.client.isAvailable();
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    // TRAP 2 — close() is reserved for shutdown ONLY (never per-turn abort).
    for (const [key, session] of this.sessions) {
      try {
        await session.close();
      } catch (err) {
        console.error(`${MODULE} close failed key=${key}`, err);
      }
    }
    this.sessions.clear();
    try {
      await this.client.shutdown?.();
    } catch (err) {
      console.error(`${MODULE} client.shutdown failed`, err);
    }
  }

  // ───────────────────────────────────────────────────────────
  // Optional session-control members — delegate to the most-recently-used
  // session, respecting capability flags. (contract.ts WS-A optional members.)
  // ───────────────────────────────────────────────────────────

  private lastSession(): AgentSession | undefined {
    let last: AgentSession | undefined;
    for (const s of this.sessions.values()) last = s;
    return last;
  }

  async setModel(modelId: string): Promise<void> {
    const session = this.lastSession();
    if (session?.setModel) await session.setModel(modelId);
  }

  async listModes(): Promise<AgentMode[]> {
    const session = this.lastSession();
    if (!session) return [];
    return session.getAvailableModes();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    // The live slash-command catalog reads lastSession(), but a session only
    // exists AFTER the first dispatch — so the composer's slash menu was empty
    // until the user sent their first message ("slash commands appear very late
    // / completely fail"). The catalog is profile/cwd-scoped (skills + builtin),
    // not conversation-specific, so warm a dedicated session to enumerate it
    // before any dispatch.
    const session = this.lastSession() ?? (await this.ensureWarmSession());
    if (session?.listCommands) return session.listCommands();
    return [];
  }

  /**
   * release203 — warm a single dedicated session so listCommands() works BEFORE
   * the first dispatch. Keyed off-band (`WARM_SESSION_KEY`) so it never collides
   * with a real `(conversation × agent)` dispatch session: those carry the
   * per-conversation composed identity prompt (release203/11) and must stay
   * separate, whereas the command catalog only needs the profile's cwd + proxy
   * to enumerate skills. At most one extra provider subprocess per driver
   * (= per profile), created lazily on the composer's first catalog fetch.
   * Best-effort: a failure degrades to the pre-fix empty catalog, never throws.
   */
  private async ensureWarmSession(): Promise<AgentSession | undefined> {
    const existing = this.sessions.get(CodeAgentDriver.WARM_SESSION_KEY);
    if (existing) return existing;
    if (!this.warmSessionPromise) {
      this.warmSessionPromise = (async () => {
        try {
          const config = withAutonomousLaunch(this.client.provider, {
            provider: this.client.provider,
            cwd: this.options.cwd,
            systemPrompt: this.options.systemPrompt,
            model: this.options.model,
            modeId: this.options.modeId,
          });
          let launchContext: AgentLaunchContext | undefined;
          if (this.options.proxy) {
            const injection = buildProviderProxyInjection(this.client.provider, this.options.proxy, undefined);
            if (injection) launchContext = { env: injection.env };
          }
          console.log(`${MODULE} warmSession provider=${this.client.provider} (slash-command catalog)`);
          const session = await this.client.createSession(config, launchContext);
          this.sessions.set(CodeAgentDriver.WARM_SESSION_KEY, session);
          return session;
        } catch (err) {
          console.error(`${MODULE} warmSession failed: ${(err as Error).message}`);
          return undefined;
        } finally {
          this.warmSessionPromise = undefined;
        }
      })();
    }
    return this.warmSessionPromise;
  }

  async revert(input: { messageId: string; scope?: "conversation" | "files" | "both" }): Promise<void> {
    const session = this.lastSession();
    if (!session) return;
    const scope = input.scope ?? "both";
    const flags = this.client.capabilities;
    if (scope === "conversation" && flags.supportsRewindConversation && session.revertConversation) {
      await session.revertConversation({ messageId: input.messageId });
    } else if (scope === "files" && flags.supportsRewindFiles && session.revertFiles) {
      await session.revertFiles({ messageId: input.messageId });
    } else if (scope === "both" && flags.supportsRewindBoth && session.revertBoth) {
      await session.revertBoth({ messageId: input.messageId });
    } else {
      throw new Error(`${MODULE} revert scope='${scope}' not supported by provider ${this.client.provider}`);
    }
  }
}
