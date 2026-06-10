/**
 * Prismer IM — Task Permission Resolver (v2.0 release 200 §3 + §5)
 *
 * Single source of truth for "can this actor mutate this task?".
 *
 * Replaces the 6 散落 access gates that previously lived inline in
 * `task.service.ts` (updateTask access check, assignee-only transitions,
 * creator-only metadata, approve/reject/cancel, force-transition).
 *
 * Trust hierarchy (15-task-state-machine-and-kanban.md §3.1):
 *   L0 owner            (human, workspace ownerImUserId)            — all allow
 *   L1 admin            (human, workspace role='admin' OR global admin / trustTier>=4)
 *                                                                    — all allow
 *   L2 orchestrator     (agent, workspace.orchestratorAgentId == actor.id,
 *                        orchestratorRevokedAt IS NULL)              — edit / assign /
 *                                                                      transition / reorder allow
 *                                                                      (force-transition NOT covered here)
 *   L3 member-creator   (human, workspace member, task.creatorId == actor.id)
 *                                                                    — edit on own task allow;
 *                                                                      transition per matrix as 'creator';
 *                                                                      reorder allow
 *   L3 member-other     (human, workspace member, NOT creator/assignee)
 *                                                                    — reorder only;
 *                                                                      transition denied; edit denied
 *   L4 executor agent   (agent, task.assigneeId == actor.id)         — transition per matrix as 'assignee';
 *                                                                      reorder allow; edit/assign DENY
 *   L5 observer         (not in workspace)                            — full deny
 *
 * The transition matrix here is THE source of truth for `review → completed`
 * and `review → assigned` rejecting assignees (核心契约 §3.2).
 *
 * Force-transition (L0/L1 only escape hatch) is NOT routed through this
 * resolver. Callers must use `isForceTransitionAllowed(actor)`.
 */

import prisma from '../db';
import type { TaskStatus } from '../types';

// ─── Public types ───────────────────────────────────────────────────────────

export type AllowedActor =
  | 'owner'
  | 'admin'
  | 'orchestrator'
  | 'creator'
  | 'assignee'
  | 'system';

export type SideEffect =
  | 'enqueue-run'
  | 'cancel-run'
  | 'notify-creator'
  | 'notify-assignee'
  | 'record-completion';

export type TaskActionKind =
  | { kind: 'transition'; from: TaskStatus; to: TaskStatus }
  | { kind: 'edit-content' } // title / description / priority / labels / parentTaskId / deps
  | { kind: 'assign' } // assigneeId change (not paired with a transition)
  | { kind: 'reorder' } // position-only change
  | { kind: 'create' }; // create + initial assignee dispatch (release202/08 §3.2)

// ─── Dispatch scope (release202/08 §3.2 — config-driven, role-agnostic) ──────

/**
 * The dispatch capability an actor resolves to. This is **never** derived from
 * a role-name `switch` — it is read from a three-layer merge (workspace policy
 * > role/profile config > DEFAULT_DISPATCH_POLICY data table). See
 * `resolveDispatchScope`.
 */
export type TaskDispatchScope =
  | 'any' // may assign to any assignee (agent + human + self)
  | 'agents' // may assign to agents (and self) only — never a human peer
  | 'self' // may only self-create / self-assign
  | 'none'; // may not create / dispatch at all

/**
 * The class of the *initial assignee* of a create / assign action, computed
 * relative to the actor. `scope × assigneeClass → allow`.
 */
export type AssigneeClass = 'agent' | 'human' | 'self';

/**
 * Internal default-policy tier label. This is **only** the fallback key into
 * `DEFAULT_DISPATCH_POLICY`; it is NOT a role name and carries no per-role
 * branching. Any of these defaults can be overridden by role/profile config or
 * a workspace policy (see `resolveDispatchScope`).
 */
export type DispatchTier =
  | 'owner-admin' // L0 owner / L1 admin (or trustTier>=4)
  | 'orchestrator' // L2 orchestrator agent
  | 'member' // L3 human workspace member
  | 'executor-agent'; // L4 non-orchestrator agent

/**
 * **DEFAULT_DISPATCH_POLICY** — pure data table (release202/08 §3.2c).
 *
 * Maps the internal trust tier → its *default* dispatch scope. This is the
 * lowest-priority layer in `resolveDispatchScope`: a role template /
 * agent-profile `config.taskDispatchScope` or a workspace
 * `metadata.dispatchPolicy` entry overrides it.
 *
 * There is deliberately NO `if (role === 'ceo')` anywhere — a brand-new role
 * declares `taskDispatchScope` in its template and the resolver honours it
 * without a code change.
 */
export const DEFAULT_DISPATCH_POLICY: Record<DispatchTier, TaskDispatchScope> = {
  'owner-admin': 'any',
  orchestrator: 'any',
  member: 'agents',
  'executor-agent': 'none',
};

/** Valid scope values — used to validate config/policy overrides before trust. */
const VALID_SCOPES: ReadonlySet<string> = new Set<TaskDispatchScope>([
  'any',
  'agents',
  'self',
  'none',
]);

function isValidScope(v: unknown): v is TaskDispatchScope {
  return typeof v === 'string' && VALID_SCOPES.has(v);
}

export type TaskActor = {
  id: string;
  type: 'human' | 'agent';
  /** workspace role from im_workspace_members; null if not a member */
  role: 'owner' | 'admin' | 'member' | null;
  trustTier: number;
};

export type TaskRef = {
  id: string;
  creatorId: string;
  assigneeId: string | null;
  workspaceId: string;
  status: TaskStatus;
};

export type PermissionAllow = {
  allow: true;
  via:
    | 'owner'
    | 'admin'
    | 'orchestrator'
    | 'creator'
    | 'assignee'
    | 'admin-trust-tier';
};

export type PermissionDeny = {
  allow: false;
  reason: string;
  /**
   * Tiers that COULD have done this action. The API layer uses this in
   * the 403 envelope so clients can render "needs orchestrator / creator".
   */
  requiredTiers: string[];
};

export type PermissionResult = PermissionAllow | PermissionDeny;

// ─── Transition matrix (15 §5.2 — source of truth) ──────────────────────────

export type TransitionRule = {
  allowedActors: AllowedActor[];
  sideEffects: SideEffect[];
};

/**
 * `TRANSITIONS[from][to]` returns the rule, or undefined if the transition
 * is structurally invalid (409 invalid-transition).
 *
 * **Critical contract:** `review → completed` and `review → assigned`
 * (rejection) do NOT list `assignee`. This is what enforces "no self-approval".
 */
export const TRANSITIONS: Record<
  TaskStatus,
  Partial<Record<TaskStatus, TransitionRule>>
> = {
  pending: {
    assigned: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: ['notify-assignee'],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: [],
    },
  },
  assigned: {
    pending: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator', 'assignee'],
      sideEffects: ['cancel-run'],
    },
    running: {
      // 2026-05-22 — dispatch chokepoint auto-transitions assigned → running
      // the moment the daemon actually receives the `task.dispatch.request`
      // frame (task.service.ts `emitDaemonDispatchRequest`). 'system' carries
      // that transition so agents don't need to send a synthetic progress=0
      // update just to flip status; this closes the kanban "stuck at
      // assigned" loop where assignees never appeared to start work.
      allowedActors: ['owner', 'admin', 'orchestrator', 'assignee', 'system'],
      sideEffects: ['enqueue-run'],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: ['cancel-run'],
    },
  },
  running: {
    review: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'assignee'],
      sideEffects: ['notify-creator'],
    },
    blocked: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'assignee'],
      sideEffects: ['notify-creator'],
    },
    // 2026-05-22 doc 12 — approval-deadlock fix. Daemon (system actor)
    // transitions a run to awaiting_approval when the agent invoked
    // `prismer.approval.request_human_approval` mid-run and the reaper
    // would otherwise stamp `failed`. Reversed when the human decides
    // (see awaiting_approval → running below).
    awaiting_approval: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'assignee', 'system'],
      sideEffects: ['notify-creator'],
    },
    failed: {
      allowedActors: [
        'owner',
        'admin',
        'orchestrator',
        'assignee',
        'system',
      ],
      sideEffects: ['notify-creator'],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: ['cancel-run'],
    },
  },
  review: {
    // ⚠️ No 'assignee' — this is the "no self-approval" contract.
    completed: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: ['record-completion', 'notify-assignee'],
    },
    // ⚠️ No 'assignee' — same contract for rejection (review → assigned).
    assigned: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: ['notify-assignee'],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: [],
    },
  },
  blocked: {
    running: {
      // assignee allowed (agent self-unblocks once blocker resolved).
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator', 'assignee'],
      sideEffects: ['enqueue-run'],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: [],
    },
  },
  awaiting_approval: {
    // System redispatches after the human decides (approval.decided
    // emits a new task.dispatch.request; on first heartbeat the run
    // re-enters running). 'system' carries this transition; humans
    // making the decision through the approvals UI route through the
    // approval service, which then issues this transition under the
    // system actor.
    running: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'assignee', 'system'],
      sideEffects: ['enqueue-run'],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: ['cancel-run'],
    },
  },
  failed: {
    assigned: {
      // retry — assignee may self-restart.
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator', 'assignee'],
      sideEffects: [],
    },
    cancelled: {
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: [],
    },
  },
  cancelled: {
    pending: {
      // Recycle-bin restore.
      allowedActors: ['owner', 'admin', 'orchestrator', 'creator'],
      sideEffects: [],
    },
  },
  completed: {
    // Terminal. Only owner/admin via force-transition (separate path).
  },
};

// ─── Workspace orchestrator resolution ──────────────────────────────────────

/**
 * Primary path uses the v2.0 workspace field `orchestratorAgentId`
 * (migration 343). Falls back to the legacy 30-acp agent-profile +
 * ceoPermissions.canDispatch combo for 3 sprints (§3.2).
 *
 * Exported so `task.service.ts::hasTaskOrchestratorAuthority` can compose
 * with it without circular-importing the whole resolver.
 */
export async function isOrchestratorOf(
  workspaceId: string,
  actorId: string,
  opts: { includeLegacyFallback?: boolean } = {},
): Promise<boolean> {
  // Primary path — new schema (workspace authoritative source).
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: {
      orchestratorAgentId: true,
      orchestratorRevokedAt: true,
      ownerImUserId: true,
    },
  });
  if (
    ws?.orchestratorAgentId === actorId &&
    ws.orchestratorRevokedAt === null
  ) {
    return true;
  }

  // Optional legacy fallback (30-acp agent profile + CEO canDispatch).
  // Disabled by default — callers that still need the 3-sprint transition
  // period pass includeLegacyFallback:true. `hasTaskOrchestratorAuthority`
  // (task.service.ts) is the production caller during the transition.
  if (opts.includeLegacyFallback) {
    const agentProfile = await prisma.iMAgentProfile.findFirst({
      where: { agentImUserId: actorId, workspaceId },
    });
    if (!agentProfile) return false;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(agentProfile.config || '{}');
    } catch {
      return false;
    }
    if (config.taskAuthority !== 'orchestrator') return false;
    return checkCeoDispatchAuthorization(actorId, workspaceId, ws?.ownerImUserId ?? null);
  }

  return false;
}

/**
 * Legacy 30-acp authorization probe — owner's metadata.ceoPermissions.canDispatch
 * must be true. Re-implemented here (and in task.service.ts as
 * `hasHumanCeoDispatchAuthorization`) so the resolver can answer without
 * circular-importing task.service.ts.
 */
async function checkCeoDispatchAuthorization(
  actorId: string,
  workspaceId: string,
  workspaceOwnerImUserId: string | null,
): Promise<boolean> {
  const actor = await prisma.iMUser.findUnique({
    where: { id: actorId },
    select: { role: true, userId: true },
  });
  if (!actor) return false;
  if (actor.role !== 'agent') return true;

  const readCanDispatch = (metadata: string | null | undefined): boolean => {
    if (!metadata) return false;
    try {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      const node = parsed?.ceoPermissions as Record<string, unknown> | undefined;
      return Boolean(
        node && typeof node === 'object' && !Array.isArray(node) && node.canDispatch === true,
      );
    } catch {
      return false;
    }
  };

  // Owner via actor.userId (cloud account chain)
  if (actor.userId) {
    const owner = await prisma.iMUser.findFirst({
      where: { role: 'human', userId: actor.userId },
      select: { metadata: true },
    });
    if (readCanDispatch(owner?.metadata)) return true;
  }
  // Workspace owner direct
  if (workspaceOwnerImUserId) {
    const owner = await prisma.iMUser.findUnique({
      where: { id: workspaceOwnerImUserId },
      select: { metadata: true },
    });
    if (readCanDispatch(owner?.metadata)) return true;
  }
  // workspaceId param kept for symmetry with the legacy helper; if owner
  // wasn't pre-resolved (ws lookup miss), retry from workspace row.
  if (!workspaceOwnerImUserId) {
    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (workspace?.ownerImUserId) {
      const owner = await prisma.iMUser.findUnique({
        where: { id: workspace.ownerImUserId },
        select: { metadata: true },
      });
      if (readCanDispatch(owner?.metadata)) return true;
    }
  }
  return false;
}

// ─── Dispatch scope resolution (release202/08 §3.2 — role-agnostic) ──────────

/**
 * Resolve the actor's internal trust tier for the *default* policy lookup.
 *
 * This classifies by **structural facts** (workspace owner/admin role,
 * orchestrator binding, agent vs human) — never by a role *name*. The result
 * is only used as the fallback key into `DEFAULT_DISPATCH_POLICY`; both higher
 * layers (config / workspace policy) can override the resulting scope.
 */
async function resolveDispatchTier(
  actor: TaskActor,
  workspaceId: string,
): Promise<DispatchTier> {
  // L0/L1: workspace owner / admin, or global admin trust tier.
  if (actor.trustTier >= 4) return 'owner-admin';
  if (actor.type === 'human' && (actor.role === 'owner' || actor.role === 'admin')) {
    return 'owner-admin';
  }

  // L2: orchestrator agent (workspace.orchestratorAgentId, not revoked;
  // legacy fallback retained during the v2.0 transition window).
  if (actor.type === 'agent') {
    const isOrch = await isOrchestratorOf(workspaceId, actor.id, {
      includeLegacyFallback: true,
    });
    if (isOrch) return 'orchestrator';
    // Any non-orchestrator agent is an executor — no peer-delegation default.
    return 'executor-agent';
  }

  // L3: human workspace member (creator/other handled by assigneeClass, not here).
  return 'member';
}

/**
 * Read a `taskDispatchScope` declaration from an agent profile's `config`
 * JSON, if present and valid. Role templates flow their `configSchema` into
 * the same `im_agent_profiles.config` blob at provision time (alongside the
 * existing `taskAuthority` precedent), so a role's declared scope lands here.
 *
 * Returns `null` when the actor has no profile / no declaration — the caller
 * then falls through to the DEFAULT_DISPATCH_POLICY tier mapping.
 */
async function readProfileScopeOverride(
  actorId: string,
  workspaceId: string,
): Promise<TaskDispatchScope | null> {
  const profile = await prisma.iMAgentProfile.findFirst({
    where: { agentImUserId: actorId, workspaceId },
    select: { config: true },
  });
  if (!profile?.config) return null;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(profile.config) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Match the `taskAuthority` precedent (agent-spec.service.ts reads it from
  // BOTH the top-level config and a nested `roleTemplate` block). A role
  // template may declare `taskDispatchScope` at either level.
  if (isValidScope(config.taskDispatchScope)) return config.taskDispatchScope;
  const roleTemplate = config.roleTemplate;
  if (roleTemplate && typeof roleTemplate === 'object' && !Array.isArray(roleTemplate)) {
    const declared = (roleTemplate as Record<string, unknown>).taskDispatchScope;
    if (isValidScope(declared)) return declared;
  }
  return null;
}

/**
 * Read a workspace-level dispatch-policy override from
 * `im_workspace.metadata.dispatchPolicy` (JSON — no new column / migration).
 *
 * Two override shapes are supported (both data, no role-name branching):
 *   - per-tier:  `{ "owner-admin": "any", "member": "self" }`
 *   - global:    `{ "default": "self" }` applies to every tier
 *
 * `tierForGlobalGuard` lets a global override still respect a hard floor for
 * executor agents (a workspace can't accidentally grant peer-delegation to
 * every executor via a blanket `default`). We keep it simple: global applies
 * to all tiers; if a workspace wants finer control it lists tiers explicitly.
 */
async function readWorkspacePolicyOverride(
  workspaceId: string,
  tier: DispatchTier,
): Promise<TaskDispatchScope | null> {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { metadata: true },
  });
  if (!ws?.metadata) return null;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(ws.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
  const policy = metadata.dispatchPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const node = policy as Record<string, unknown>;
  // Per-tier override wins over a global `default`.
  if (isValidScope(node[tier])) return node[tier] as TaskDispatchScope;
  if (isValidScope(node.default)) return node.default as TaskDispatchScope;
  return null;
}

/**
 * **resolveDispatchScope** — the role-agnostic dispatch-capability resolver
 * (release202/08 §3.2). Three-layer merge, highest priority first:
 *
 *   1. workspace `metadata.dispatchPolicy` override (per-tier or `default`)
 *   2. role template / agent profile `config.taskDispatchScope` declaration
 *   3. DEFAULT_DISPATCH_POLICY[tier] data-table fallback
 *
 * `tier` is a structural classification (owner/admin/orchestrator/member/
 * executor) — there is **no** `if (role === '<name>')` switch anywhere. Adding
 * a new role + declaring `taskDispatchScope` in its template changes behaviour
 * with zero resolver code edits.
 */
export async function resolveDispatchScope(
  actor: TaskActor,
  workspaceId: string,
): Promise<TaskDispatchScope> {
  const tier = await resolveDispatchTier(actor, workspaceId);

  // Layer 1 (highest): workspace policy override.
  const wsOverride = await readWorkspacePolicyOverride(workspaceId, tier);
  if (wsOverride) return wsOverride;

  // Layer 2: role template / agent profile config declaration (agents only —
  // humans carry no agent profile; their scope is tier-default unless the
  // workspace policy in layer 1 overrode it).
  if (actor.type === 'agent') {
    const profileOverride = await readProfileScopeOverride(actor.id, workspaceId);
    if (profileOverride) return profileOverride;
  }

  // Layer 3: data-table default.
  return DEFAULT_DISPATCH_POLICY[tier];
}

/**
 * Pure `scope × assigneeClass → allow` matrix (release202/08 §3.2c).
 * No I/O, no role names — just the capability table.
 */
export function isAssigneeAllowedByScope(
  scope: TaskDispatchScope,
  assigneeClass: AssigneeClass,
): boolean {
  switch (scope) {
    case 'any':
      return true; // agent + human + self
    case 'agents':
      return assigneeClass === 'agent' || assigneeClass === 'self';
    case 'self':
      return assigneeClass === 'self';
    case 'none':
      return false;
  }
}

/**
 * Classify the *initial assignee* of a create/assign relative to the actor.
 * `null` / `'self'` / actor-id → 'self'. Otherwise look up the assignee's
 * IMUser.role to decide agent vs human.
 */
export async function classifyAssignee(
  actorId: string,
  assigneeId: string | null | undefined,
): Promise<AssigneeClass> {
  if (!assigneeId || assigneeId === 'self' || assigneeId === actorId) return 'self';
  const user = await prisma.iMUser.findUnique({
    where: { id: assigneeId },
    select: { role: true },
  });
  return user?.role === 'agent' ? 'agent' : 'human';
}

/**
 * **resolveDispatchPermission** — combines `resolveDispatchScope` (actor →
 * scope) with `scope × assigneeClass`. This is the single gate for BOTH the
 * `create` action (initial assignee) AND the `assign` action (reassignment) —
 * §3.4 "create and assign are the same source" / no-bypass invariant.
 *
 * Returns the same structured PermissionResult shape so the API layer can
 * reuse the 403 envelope (`requiredTiers`).
 */
export async function resolveDispatchPermission(
  actor: TaskActor,
  workspaceId: string,
  assigneeId: string | null | undefined,
): Promise<PermissionResult> {
  const scope = await resolveDispatchScope(actor, workspaceId);
  const assigneeClass = await classifyAssignee(actor.id, assigneeId);

  if (isAssigneeAllowedByScope(scope, assigneeClass)) {
    // `via` is best-effort audit label derived from structural facts.
    const via =
      actor.type === 'human' && actor.role === 'owner'
        ? 'owner'
        : actor.type === 'human' && actor.role === 'admin'
          ? 'admin'
          : actor.trustTier >= 4
            ? 'admin-trust-tier'
            : actor.type === 'agent'
              ? 'orchestrator'
              : 'creator';
    return { allow: true, via };
  }

  // Build a specific, machine-readable reason for each denial shape.
  let reason: string;
  if (scope === 'none') {
    reason = 'dispatch-not-permitted';
  } else if (scope === 'agents' && assigneeClass === 'human') {
    reason = 'member-cannot-assign-human';
  } else if (scope === 'self') {
    reason = 'dispatch-self-only';
  } else {
    reason = 'dispatch-not-permitted';
  }

  return {
    allow: false,
    reason,
    requiredTiers:
      scope === 'agents' && assigneeClass === 'human'
        ? ['orchestrator', 'admin', 'owner']
        : ['orchestrator', 'admin', 'owner', 'creator'],
  };
}

// ─── Actor enrichment ───────────────────────────────────────────────────────

/**
 * Builds a TaskActor from prisma. Used by all 6 callsites collapsed into the
 * resolver — they pass an id, we look up role + trustTier + workspace role.
 *
 * `null` is returned when actor doesn't exist (handle as L5 observer / deny).
 */
export async function loadTaskActor(
  actorId: string,
  workspaceId: string,
): Promise<TaskActor | null> {
  const user = await prisma.iMUser.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, trustTier: true },
  });
  if (!user) return null;

  // Workspace role: prefer owner, then explicit member row.
  const workspace = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { ownerImUserId: true },
  });

  let wsRole: TaskActor['role'] = null;
  if (workspace?.ownerImUserId === actorId) {
    wsRole = 'owner';
  } else {
    const member = await prisma.iMWorkspaceMember.findFirst({
      where: { workspaceId, memberImUserId: actorId },
      select: { role: true },
    });
    if (member?.role === 'owner') wsRole = 'owner';
    else if (member?.role === 'admin') wsRole = 'admin';
    else if (member?.role) wsRole = 'member';
  }

  return {
    id: actorId,
    type: user.role === 'agent' ? 'agent' : 'human',
    role: wsRole,
    trustTier: user.trustTier ?? 0,
  };
}

// ─── Force-transition gate (L0/L1 only, §5.3 escape hatch) ──────────────────

/**
 * Force-transition is the production-incident escape hatch. It bypasses
 * TRANSITIONS entirely. Only L0 (owner) and L1 (admin) may invoke it.
 *
 * UI does not expose this; only ops curl / admin tools.
 */
export function isForceTransitionAllowed(actor: TaskActor): boolean {
  if (actor.type === 'human' && (actor.role === 'owner' || actor.role === 'admin')) {
    return true;
  }
  // Global admin / trustTier escape hatch (preserves 30-acp behavior).
  if (actor.trustTier >= 4) return true;
  return false;
}

// ─── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolve whether `actor` may apply `action` to `task`.
 *
 * Pure data-in, decision-out — no DB writes, no event publishes. Caller is
 * responsible for side-effects (which are described in the TRANSITIONS
 * matrix as `sideEffects`).
 */
export async function resolveTaskMutationPermission(
  actor: TaskActor,
  task: TaskRef,
  action: TaskActionKind,
): Promise<PermissionResult> {
  // ─── create + initial assignee (release202/08 §3.2) ────────────────────
  // `create` is dispatch-scope-gated, not tier-gated like the mutation
  // matrix. It shares the SAME resolver as `assign` (§3.4 no-bypass: build
  // unassigned then PATCH-assign hits this exact path via the assign action
  // below). `task.assigneeId` here is the *intended initial* assignee.
  if (action.kind === 'create') {
    return resolveDispatchPermission(actor, task.workspaceId, task.assigneeId);
  }

  // ─── L1 admin (global trustTier or global admin role) ──────────────────
  // 30-acp escape hatch: trustTier >= 4 OR role='admin' (the actor.type
  // can be 'agent' for admin-tier agents, kept for backward compat).
  if (actor.trustTier >= 4) {
    return { allow: true, via: 'admin-trust-tier' };
  }

  // ─── L0 owner (human, workspace owner) ─────────────────────────────────
  if (actor.type === 'human' && actor.role === 'owner') {
    return { allow: true, via: 'owner' };
  }

  // ─── L1 admin (human, workspace admin) ─────────────────────────────────
  if (actor.type === 'human' && actor.role === 'admin') {
    return { allow: true, via: 'admin' };
  }

  // ─── L2 orchestrator (agent, workspace.orchestratorAgentId == actor) ──
  // Orchestrator gets all mutation kinds except force-transition (which
  // is not routed through this resolver). force-transition is gated by
  // isForceTransitionAllowed instead.
  //
  // Legacy fallback (30-acp `taskAuthority='orchestrator'` + owner
  // `ceoPermissions.canDispatch=true`) is included for 3 sprints during
  // the v2.0 transition. Remove once all workspaces have been migrated
  // via `POST /workspaces/:id/orchestrator`.
  if (actor.type === 'agent') {
    const isOrch = await isOrchestratorOf(task.workspaceId, actor.id, {
      includeLegacyFallback: true,
    });
    if (isOrch) {
      return { allow: true, via: 'orchestrator' };
    }
  }

  const isCreator = task.creatorId === actor.id;
  const isAssignee = task.assigneeId === actor.id;

  // ─── L4 executor agent — assignee can only transition assigned tasks ──
  // IMPORTANT: this branch fires BEFORE the L5 "no workspace role" deny
  // because executor agents often have no formal workspace-member row;
  // their relationship to the task IS the only thing that grants them
  // any tier above observer.
  if (actor.type === 'agent') {
    // Edit / assign always denied for executor agents (only orchestrator
    // agents at L2 above could do that, and they short-circuited earlier).
    if (action.kind === 'edit-content' || action.kind === 'assign') {
      return {
        allow: false,
        reason: 'executor agents cannot edit content or reassign tasks',
        requiredTiers: ['creator', 'orchestrator', 'admin'],
      };
    }
    if (action.kind === 'reorder') {
      // Even executor agents can reorder their own kanban view, but only
      // if they're the assignee of the task (otherwise pure L5 observer).
      if (isAssignee) return { allow: true, via: 'assignee' };
      return {
        allow: false,
        reason: 'agent is not the assignee of this task',
        requiredTiers: ['assignee', 'orchestrator', 'admin'],
      };
    }
    if (action.kind === 'transition') {
      if (!isAssignee) {
        return {
          allow: false,
          reason: 'agent is not the assignee of this task',
          requiredTiers: ['assignee', 'orchestrator', 'admin'],
        };
      }
      return resolveTransition(action.from, action.to, {
        isCreator,
        isAssignee: true,
        actorTierLabel: 'assignee',
      });
    }
  }

  // ─── Reorder for humans is liberal — any workspace member can drag-sort.
  // (Position is a per-actor UX preference in §7; persistent server-side
  // value is shared but reordering authority isn't a high-trust action.)
  if (action.kind === 'reorder') {
    // Humans need a workspace role; L5 observers fall through to deny.
    if (actor.role !== null) {
      return { allow: true, via: isCreator ? 'creator' : 'assignee' };
    }
  }

  // ─── L5 observer (human, no workspace role) ────────────────────────────
  if (actor.role === null) {
    return {
      allow: false,
      reason: 'actor is not a member of the task workspace',
      requiredTiers: ['owner', 'admin', 'orchestrator', 'creator'],
    };
  }

  // ─── L3 member (human) — only creator can edit / assign their own task ─
  if (actor.type === 'human' && actor.role === 'member') {
    if (action.kind === 'edit-content') {
      if (isCreator) return { allow: true, via: 'creator' };
      return {
        allow: false,
        reason: 'only the task creator may edit content',
        requiredTiers: ['creator', 'orchestrator', 'admin'],
      };
    }
    if (action.kind === 'assign') {
      if (isCreator) return { allow: true, via: 'creator' };
      return {
        allow: false,
        reason: 'only the task creator may reassign their task',
        requiredTiers: ['creator', 'orchestrator', 'admin'],
      };
    }
    if (action.kind === 'transition') {
      return resolveTransition(action.from, action.to, {
        isCreator,
        isAssignee,
        actorTierLabel: isCreator ? 'creator' : 'observer',
      });
    }
  }

  // Catch-all: deny.
  return {
    allow: false,
    reason: `actor (type=${actor.type}, role=${actor.role ?? 'none'}) lacks permission for ${action.kind}`,
    requiredTiers: ['owner', 'admin', 'orchestrator', 'creator'],
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveTransition(
  from: TaskStatus,
  to: TaskStatus,
  ctx: { isCreator: boolean; isAssignee: boolean; actorTierLabel: string },
): PermissionResult {
  const rule = TRANSITIONS[from]?.[to];
  if (!rule) {
    return {
      allow: false,
      reason: `invalid transition ${from} → ${to}`,
      requiredTiers: [],
    };
  }
  const eligibleLabels: string[] = [];
  if (ctx.isCreator && rule.allowedActors.includes('creator')) {
    eligibleLabels.push('creator');
  }
  if (ctx.isAssignee && rule.allowedActors.includes('assignee')) {
    eligibleLabels.push('assignee');
  }
  if (eligibleLabels.length > 0) {
    // Prefer 'assignee' label when transition is assignee-only-ish to
    // make audit logs clearer. But creator wins for ties (creator is the
    // contractually responsible party).
    if (eligibleLabels.includes('creator')) {
      return { allow: true, via: 'creator' };
    }
    return { allow: true, via: 'assignee' };
  }
  return {
    allow: false,
    reason: `transition ${from} → ${to} is not permitted for actor tier=${ctx.actorTierLabel}`,
    requiredTiers: rule.allowedActors.map((a) => String(a)),
  };
}
