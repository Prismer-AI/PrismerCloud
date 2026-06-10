// release201/09 §9.9 — uniform PRISMER_* env injection helper.
//
// dispatch.ts stamps 5 scope identifiers + 2 path identifiers (artifacts +
// scratch) onto `task.metadata`. Each spawn-style adapter (claude-code /
// codex / openclaw / hermes shell) must mirror them into the child process
// env so built-in skills + SDK commands can pick them up without re-querying
// cloud. release202/04 §3.1 — paths are exposed as PRISMER_ARTIFACTS_DIR /
// PRISMER_SCRATCH_DIR. These are the ONLY agent-facing env names for the
// deliverable + scratch dirs. The legacy `prismerOutboxDir` INBOUND metadata
// key is still read as a fallback INPUT (cloud→daemon plumbing) but is NEVER
// re-exported to the agent process — `PRISMER_OUTBOX_DIR` is dead.
//
// Reading metadata at adapter boundary (vs. dispatch reaching into env
// directly) keeps the dispatch.ts API clean — adapters that don't spawn
// (e.g. http-only providers) simply ignore the helper. Also keeps tests
// runnable: TaskInput.metadata is the documented adapter contract surface.

export interface PrismerScopeEnvFields {
  PRISMER_WORKSPACE_ID?: string;
  PRISMER_ACTIVE_PROJECT_ID?: string;
  PRISMER_AGENT_ID?: string;
  // 2026-05-29 — agent identity for X-IM-Agent. AGENT_ID is the database
  // PK (cuid); USERNAME is the human handle (ceo, cto); IM_USER_ID is the
  // im_users row this agent owns. Cloud middleware accepts the handle on
  // X-IM-Agent and resolves to senderId so messages are stamped as the
  // agent, not the daemon-owning human.
  PRISMER_AGENT_USERNAME?: string;
  PRISMER_AGENT_IM_USER_ID?: string;
  // release202/09 §3.2 — RUN vs TASK split. A chat-dispatch RUN gets ONLY
  // PRISMER_RUN_ID (the turn closes from the agent's reply — no `cloud task`
  // op). A kanban TASK gets ONLY PRISMER_TASK_ID. Never both: that prevented a
  // skill from running `cloud task complete "$PRISMER_TASK_ID"` against a run
  // id (the 404 incident).
  PRISMER_RUN_ID?: string;
  PRISMER_TASK_ID?: string;
  PRISMER_DAEMON_ID?: string;
  // release202/09 P2 — the conversation/session the dispatch belongs to.
  // Read by `cloud file send` (动作 B) to target a standalone message.
  PRISMER_CONVERSATION_ID?: string;
  // release202/04 §3.1 — artifacts/scratch are the canonical (and only)
  // agent-facing names. PRISMER_OUTBOX_DIR is intentionally NOT here — it is
  // dead and must never be exported to the agent.
  PRISMER_ARTIFACTS_DIR?: string;
  PRISMER_SCRATCH_DIR?: string;
  // Backward-compat alias for scratch only (same value) so a stale agent
  // process built before the scratch rename still resolves it.
  PRISMER_WORKDIR?: string;
}

/**
 * Pull the 5+2 PRISMER_* fields out of TaskInput.metadata. Only sets keys
 * for non-empty string values — empty / missing fields are silently
 * omitted so the spawned process env doesn't carry `PRISMER_AGENT_ID=`
 * (which some shells would treat as defined but empty).
 */
export function prismerScopeEnvFromMetadata(
  metadata: Record<string, unknown> | undefined,
): PrismerScopeEnvFields {
  const out: PrismerScopeEnvFields = {};
  if (!metadata) return out;
  const wsId = metadata.prismerWorkspaceId;
  if (typeof wsId === 'string' && wsId.length > 0) out.PRISMER_WORKSPACE_ID = wsId;
  const projectId = metadata.prismerActiveProjectId;
  if (typeof projectId === 'string' && projectId.length > 0) out.PRISMER_ACTIVE_PROJECT_ID = projectId;
  const agentId = metadata.prismerAgentId;
  if (typeof agentId === 'string' && agentId.length > 0) out.PRISMER_AGENT_ID = agentId;
  const agentUsername = metadata.prismerAgentUsername;
  if (typeof agentUsername === 'string' && agentUsername.length > 0) out.PRISMER_AGENT_USERNAME = agentUsername;
  const agentImUserId = metadata.prismerAgentImUserId;
  if (typeof agentImUserId === 'string' && agentImUserId.length > 0) out.PRISMER_AGENT_IM_USER_ID = agentImUserId;
  // release202/09 §3.2 — RUN vs TASK env split (resolves the chat-vs-task
  // TODO). dispatch.ts now stamps `prismerKind` ('run' | 'task') plus exactly
  // ONE of `prismerRunId` / `prismerTaskId`. We honour that split:
  //   - kind='run'  → export PRISMER_RUN_ID only (NO PRISMER_TASK_ID), so a
  //     skill can never `cloud task complete "$PRISMER_TASK_ID"` against a run
  //     id — the platform closes the turn from the agent's reply.
  //   - kind='task' → export PRISMER_TASK_ID only.
  // Fallbacks (legacy daemons / stale payloads that lack the new keys):
  //   - if `prismerRunId` is present (or `prismerKind==='run'`), treat as run;
  //   - else if `prismerTaskId` is `run_`-prefixed, treat it as a run id and
  //     route it to PRISMER_RUN_ID (never PRISMER_TASK_ID);
  //   - else export PRISMER_TASK_ID as before.
  const kind = typeof metadata.prismerKind === 'string' ? metadata.prismerKind : undefined;
  const runIdRaw = typeof metadata.prismerRunId === 'string' ? metadata.prismerRunId : undefined;
  const taskIdRaw = typeof metadata.prismerTaskId === 'string' ? metadata.prismerTaskId : undefined;
  const isRun = kind === 'run' || !!runIdRaw || (!!taskIdRaw && taskIdRaw.startsWith('run_'));
  if (isRun) {
    const runId =
      (runIdRaw && runIdRaw.length > 0 ? runIdRaw : undefined) ??
      (taskIdRaw && taskIdRaw.length > 0 ? taskIdRaw : undefined);
    if (runId) out.PRISMER_RUN_ID = runId;
    // Intentionally NO PRISMER_TASK_ID for runs.
  } else if (taskIdRaw && taskIdRaw.length > 0) {
    out.PRISMER_TASK_ID = taskIdRaw;
  }
  const daemonId = metadata.prismerDaemonId;
  if (typeof daemonId === 'string' && daemonId.length > 0) out.PRISMER_DAEMON_ID = daemonId;
  // release202/09 P2 — conversation id for `cloud file send` (动作 B).
  const conversationId = metadata.prismerConversationId;
  if (typeof conversationId === 'string' && conversationId.length > 0) {
    out.PRISMER_CONVERSATION_ID = conversationId;
  }
  // release202/04 §3.1 — prefer the new `prismerArtifactsDir` metadata key;
  // fall back to the legacy INBOUND `prismerOutboxDir` key ONLY (a stale cloud
  // dispatch payload may carry the old metadata name — cloud→daemon plumbing,
  // not agent-visible). We export the resolved dir under the canonical
  // PRISMER_ARTIFACTS_DIR only — PRISMER_OUTBOX_DIR is dead and never emitted.
  const artifactsDir =
    (typeof metadata.prismerArtifactsDir === 'string' && metadata.prismerArtifactsDir.length > 0
      ? metadata.prismerArtifactsDir
      : undefined) ??
    (typeof metadata.prismerOutboxDir === 'string' && metadata.prismerOutboxDir.length > 0
      ? metadata.prismerOutboxDir // legacy inbound metadata key — back-compat input only
      : undefined);
  if (artifactsDir) {
    out.PRISMER_ARTIFACTS_DIR = artifactsDir;
  }
  const scratchDir =
    (typeof metadata.prismerScratchDir === 'string' && metadata.prismerScratchDir.length > 0
      ? metadata.prismerScratchDir
      : undefined) ??
    (typeof metadata.prismerWorkDir === 'string' && metadata.prismerWorkDir.length > 0
      ? metadata.prismerWorkDir
      : undefined);
  if (scratchDir) {
    out.PRISMER_SCRATCH_DIR = scratchDir;
    out.PRISMER_WORKDIR = scratchDir;
  }
  return out;
}

/**
 * release202/04 §3.2 — resolve the per-dispatch scratch dir for a SPAWN-style
 * adapter's child-process cwd. Spawn adapters (claude-code, codex) fork a
 * FRESH child per dispatch, so it is safe — and desirable — to point the
 * child's cwd at the per-task scratch dir: any relative-path write the LLM
 * emits then lands inside the task sandbox instead of /tmp or the daemon's
 * own cwd (the F18 incident — 5 .py files dumped into the source tree).
 *
 * Prefers the canonical `prismerScratchDir`, falls back to the legacy
 * `prismerWorkDir` (stale dispatch payload), and returns undefined when
 * neither is present so the caller can keep using its profile `config.cwd`.
 *
 * NOT for long-running adapters (hermes, openclaw): those share ONE process
 * across many dispatches/conversations, so a per-task cwd would be stale the
 * instant the next turn arrives and would cross-contaminate conversations.
 * They keep their fixed profile/sandbox cwd and rely on the absolute-path
 * instruction (`appendArtifactsInstruction`) instead.
 */
export function resolveSpawnScratchCwd(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const scratch = metadata.prismerScratchDir;
  if (typeof scratch === 'string' && scratch.length > 0) return scratch;
  const legacy = metadata.prismerWorkDir;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  return undefined;
}

/**
 * Apply the scope envs to a child-process env object, mutating in place.
 * Returns the same object for fluent style. Existing keys are not
 * overridden — adapters that already wired a specific PRISMER_* keep their
 * value (defensive against e.g. dev-overrides via config.envVars).
 */
export function applyPrismerScopeEnv(
  env: Record<string, string | undefined>,
  metadata: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  const fields = prismerScopeEnvFromMetadata(metadata);
  for (const [k, v] of Object.entries(fields)) {
    if (v && env[k] == null) env[k] = v;
  }
  return env;
}
