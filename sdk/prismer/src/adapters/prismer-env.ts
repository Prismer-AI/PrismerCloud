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
//
// memory203 doc 08 §2 (F4) — this helper is ALSO the daemon's mint+inject seam
// for the per-agent memory capability. When metadata carries both the agent's
// IM user id and a workspace id, we mint a scoped cap (signed with the daemon's
// per-boot key — this runs daemon-side at spawn) and export it as
// PRISMER_MEMORY_CAP. The spawned agent's memory-tool client reads it from env
// and sends it on every memory RPC; the daemon verifies the same per-boot
// signature, enforcing per-agent workspace scope. The cap is NEVER the AES key
// — it only authorizes.

import { mintCapV2 } from '../daemon/memory/cap.js';

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
  // memory203 doc 08 §2 (F4) — per-agent scoped memory capability token.
  PRISMER_MEMORY_CAP?: string;
}

/**
 * Credentials that belong to the daemon/control-plane and must never be
 * inherited by a coding agent.  Keep this deliberately scoped: ordinary
 * developer settings (for example `NODE_ENV`, `DEBUG` or `API_URL`) remain
 * available, while database/config-admin/signing material is scrubbed.
 */
export function isHighRiskCredentialEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  if (/(?:^|_)(?:PASSWORD|PASSWD|PRIVATE_KEY|SIGNING_KEY|SECRET_KEY)$/.test(k)) return true;
  if (/(?:NACOS|RDS|ADMIN|OTA|MYSQL|DB)/.test(k) && /(?:PASSWORD|PASSWD|PRIVATE[_]?KEY|SIGNING|SECRET|TOKEN|ACCESS[_]?KEY|API[_]?KEY)/.test(k)) return true;
  if (/^(?:NACOS|RDS|MYSQL|DB)_(?:USER|USERNAME|PASSWORD|PASSWD|TOKEN|SECRET|ACCESS_KEY|SECRET_KEY)/.test(k)) return true;
  if (/^(?:ADMIN|OTA)_(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|SIGNING_KEY|API_KEY)/.test(k)) return true;
  if (/(?:OTA|ADMIN).*(?:SIGNING|PRIVATE_KEY)/.test(k)) return true;
  return false;
}

/** Remove daemon/control-plane credentials from a child-process environment. */
export function scrubHighRiskCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (isHighRiskCredentialEnvKey(key)) delete env[key];
  }
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
  // product209/16 §8.3 — mint + inject the per-agent memory cap v2. The cap is
  // minted ONLY from a valid registered Cloud authority snapshot (the daemon
  // registers it from the RuntimeConfigBundle's `memoryAuthority` field).
  // Claims (principal/task/council/verbs) come EXCLUSIVELY from the snapshot
  // actor row — server-derived and epoch-bound; per-dispatch local hints are
  // intentionally not accepted (they could widen the Cloud snapshot). No
  // valid snapshot (never fetched / expired / actor not hosted) → NO cap is
  // injected and every agent Memory RPC fails closed with
  // `memory_cap_required` (spec16 §8.1/§8.3).
  if (out.PRISMER_AGENT_IM_USER_ID && out.PRISMER_WORKSPACE_ID) {
    const cap = mintCapV2(out.PRISMER_AGENT_IM_USER_ID, out.PRISMER_WORKSPACE_ID);
    if (cap) out.PRISMER_MEMORY_CAP = cap;
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
 * product204/09 §2.3 — cloud-resolved skill config env. TaskService resolves
 * each installed skill's declared config (agent override → role default) and
 * ships the final KEY→value map on `metadata.skillConfigEnv`; the daemon's
 * only job is to mirror it into the child-process env. Declared keys can
 * never carry the PRISMER_ prefix (cloud ingest gate), so this can't shadow
 * the scope fields above. Empty/absent → {} (global-env status quo).
 */
export function skillConfigEnvFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> {
  const raw = metadata?.skillConfigEnv;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0 && /^[A-Z][A-Z0-9_]{0,63}$/.test(k) && !k.startsWith('PRISMER_')) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * product204/37 WS-3 — SECRET / user-kind role parameters resolved cloud-side and
 * shipped ENV-ONLY on `metadata.roleParamsEnv` (mirror skillConfigEnv). Same
 * validation: UPPER_SNAKE key, non-empty string value, PRISMER_-free (cloud gate
 * guarantees it, defence-in-depth here). Behaviour (non-secret) role params ride
 * `metadata.roleParams` and are NEVER env — see {@link roleParamsFromMetadata}.
 */
export function roleParamsEnvFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> {
  const raw = metadata?.roleParamsEnv;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0 && /^[A-Z][A-Z0-9_]{0,63}$/.test(k) && !k.startsWith('PRISMER_')) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * product204/37 WS-3 — the STRUCTURED, non-secret behaviour role parameters (e.g.
 * `speakingStyle`) shipped on `metadata.roleParams`. Keys are human-readable
 * knobs (camelCase or UPPER_SNAKE); values are short strings. These are meant to
 * reach the agent's PROMPT (never env) so it can read `roleParams.<key>` and
 * shift behaviour — cloud already excluded secrets from this map. Empty/absent → {}.
 */
export function roleParamsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> {
  const raw = metadata?.roleParams;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length > 0 && k.length <= 64 && typeof v === 'string' && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * product204/37 WS-3 — render the behaviour role parameters as a compact
 * per-turn instruction block the adapter folds into the agent's identity /
 * instructions slot (hermes) or `--system-prompt` (coding). Deterministic key
 * order (ascending) so the block is byte-stable. Returns '' when the map is
 * empty (nothing to render → no block).
 */
export function renderRoleParamsBlock(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return '';
  return [
    '## Role parameters',
    'Your role sets these behaviour parameters for this turn. Honour them:',
    ...keys.map((k) => `- ${k}: ${params[k]}`),
  ].join('\n');
}

/**
 * Apply the scope envs to a child-process env object, mutating in place.
 * Returns the same object for fluent style. Existing keys are not
 * overridden — adapters that already wired a specific PRISMER_* keep their
 * value (defensive against e.g. dev-overrides via config.envVars).
 *
 * product204/09 §2.2/§2.3 — skillConfigEnv entries DO override an existing
 * env value: the three-level resolution puts the cloud-resolved agent/role
 * value ABOVE the daemon/K8s global env (a cloud value only exists when an
 * agent override or role default was set — absence is the global-env
 * fallback). Key namespace is disjoint from the PRISMER_ scope fields by the
 * ingest gate, so the two loops can't fight.
 *
 * product204/37 WS-3 — roleParamsEnv (secret/user-kind role params) merges the
 * same way, AFTER skillConfigEnv. Cloud keeps the two key namespaces disjoint;
 * a collision would be last-writer (roleParamsEnv wins), matching the intent
 * that a role's own declared secret is the most specific source.
 */
export function applyPrismerScopeEnv(
  env: Record<string, string | undefined>,
  metadata: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  // The daemon inherits its own process environment (which may contain
  // Nacos/RDS/admin/OTA credentials). Scrub before and after metadata merge so
  // neither inherited values nor cloud-supplied role config can leak.
  scrubHighRiskCredentialEnv(env);
  const fields = prismerScopeEnvFromMetadata(metadata);
  for (const [k, v] of Object.entries(fields)) {
    if (v && env[k] == null) env[k] = v;
  }
  for (const [k, v] of Object.entries(skillConfigEnvFromMetadata(metadata))) {
    env[k] = v;
  }
  for (const [k, v] of Object.entries(roleParamsEnvFromMetadata(metadata))) {
    env[k] = v;
  }
  scrubHighRiskCredentialEnv(env);
  return env;
}
