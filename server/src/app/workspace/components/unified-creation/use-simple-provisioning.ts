'use client';

/**
 * §30 B3.4 — Simple mode Step 3 provisioning orchestration hook.
 *
 * Drives a 4-phase sequence end-to-end and exposes per-step status so
 * `SimpleStep3Launch.tsx` can render the checklist UI:
 *
 *   1. Device     — reuse an existing online k8s install if it has spare
 *                   capacity, else POST /api/workspace/runtime-installations
 *                   (kind:'k8s', template:sandbox-default, medium/medium/no-gpu)
 *   2. Agent × N  — sequential POST /api/im/register {type:'agent'} per
 *                   role in plan.roles (CEO first, primary:true).
 *                   SEQUENTIAL (not concurrent) — the cookbook's first-
 *                   register call also implicitly creates/binds the owner
 *                   workspace, and concurrent races have been observed.
 *   3. Group      — POST /api/im/groups with all newly-registered agents +
 *                   caller user (caller is auto-added by server as owner).
 *   4. Welcome    — POST /api/im/messages/:id, sent BY THE CALLER as a
 *                   plain text message wording "CEO {handle} 邀请大家入伙
 *                   开始干活". Spec considered sending AS the CEO, but the
 *                   CEO's auth token only exists in the register response
 *                   for the local session — sending from the caller is
 *                   simpler and reads naturally ("Owner introduces team").
 *
 * Each step enforces a 200ms minimum dwell on success — even when the
 * underlying API returns in 30ms — because instant transitions look
 * unreliable. The "felt waiting" cost is intentional per §2.8.4.
 *
 * Failure mode (per §30 §2.8.4 Step 3 spec):
 *   - The failing step's status flips to 'failed' with the API error
 *     message. `error.stepIndex` points to it.
 *   - The hook exposes `retry()` (re-run from the failed step, preserving
 *     completed prior-step results), `skip()` (only for non-critical
 *     steps — conversation/welcome — turns the step into 'skipped' and
 *     advances; device/agent cannot skip), and `cancel()` (mark
 *     subsequent steps cancelled, caller closes modal).
 *
 * KNOWN LEAK (deferred to §30 B4 cleanup task):
 *   On cancel after partial agent register, agent IMUsers persist in DB.
 *   We don't roll back because the user might still want them. The
 *   cleanup hook should be a one-shot "cancel my abandoned creation"
 *   endpoint that DELETEs agents whose conversations don't exist.
 *
 * Determinism: the hook is plain async/await over fetch — no react-query,
 * no SWR. State is consumed by SimpleStep3Launch which is the only
 * intended caller.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { imFetch } from '../../lib/im-api';
import {
  createAgent,
  createGroupConversation,
  sendMessage,
  suggestUsernameSeed,
  type AgentTypeEnum,
  type RegisterAgentResult,
} from '../../lib/mutations';
import type { RenderedRole } from '../../lib/templates/types';
import type { RuntimeInstallationDTO } from '../../lib/types';

// ───────────────────────── Public types ─────────────────────────

export interface SimpleProvisioningPlan {
  workspaceId: string;
  /** CEO must be first (primary:true); specialists follow. */
  roles: readonly RenderedRole[];
  /**
   * User-chosen @handle per role (keyed by role.slug). Task 3 — the simple
   * flow surfaces these in Step 2 so the user sees + edits before commit.
   * Optional for legacy callers (preview harness); the hook falls back to
   * `suggestUsernameSeed(displayName) || role.slug` when omitted.
   */
  usernames?: Record<string, string>;
  /** Defaults to "团队会议" when undefined. */
  conversationTitle?: string;
  /**
   * P3-7 — Preferred reuse target. When supplied, the device step will
   * reuse this installation iff its `agents_used + plan.roles.length` still
   * fits `maxAgents`. When omitted, the device step falls back to the
   * legacy heuristic (first online/provisioning row).
   *
   * Fed by the modal's Step 1→2 capacity probe so Step 2's counter and
   * Step 3's reuse decision share the same source of truth.
   */
  preferredInstallation?: {
    id: string;
    /** `container:<runtimeInstanceId>` — passed to `createAgent.metadata.daemonId` so the server-side capacity check fires on the right row. */
    daemonId: string;
    maxAgents: number;
    used: number;
  } | null;
}

/**
 * Thrown by the agent step when the cloud returns 409 CAPACITY_EXCEEDED
 * (device hosts >= maxAgents). Caught in `runFrom` and routed to
 * `opts.onCapacityExceeded` so the shell can surface inline error UI.
 *
 * Separate from `SlugConflictError` because both share the 409 status but
 * have distinct UX paths (slug → edit handle, capacity → upgrade / delete).
 */
export class CapacityExceededError extends Error {
  readonly used: number;
  readonly max: number;
  readonly daemonId: string | null;
  constructor(used: number, max: number, daemonId: string | null, message: string) {
    super(message);
    this.name = 'CapacityExceededError';
    this.used = used;
    this.max = max;
    this.daemonId = daemonId;
  }
}

/**
 * Thrown by the agent step when the cloud returns 409 (`Username already
 * taken`). Caught in `runFrom` and routed to `opts.onSlugConflict` so the
 * shell can populate inline errors on Step 2.
 */
export class SlugConflictError extends Error {
  readonly roleSlug: string;
  readonly attemptedUsername: string;
  constructor(roleSlug: string, attemptedUsername: string, message: string) {
    super(message);
    this.name = 'SlugConflictError';
    this.roleSlug = roleSlug;
    this.attemptedUsername = attemptedUsername;
  }
}

export interface UseSimpleProvisioningOptions {
  /**
   * Called when an agent register hits 409 with the "username already
   * taken" phrasing. The shell uses this to set `slugErrors[roleSlug]` so
   * the user can edit the handle on Step 2.
   */
  onSlugConflict?: (roleSlug: string, message: string) => void;
  /**
   * P3-7 — called when an agent register hits 409 CAPACITY_EXCEEDED. The
   * shell surfaces an inline error on Step 3 ("Device 已满 — 升级 / 删
   * 除现有 agent / 取消") and the user has to back out. We do NOT auto-
   * open CapacityExceededModal here because the user is mid-flow; let the
   * Step 3 failure region own the messaging.
   */
  onCapacityExceeded?: (used: number, max: number, message: string) => void;
}

export type ProvisioningStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export type ProvisioningStep =
  | {
      kind: 'device';
      status: ProvisioningStepStatus;
      durationMs?: number;
      error?: string;
      installationId?: string;
      reused?: boolean;
    }
  | {
      kind: 'agent';
      roleSlug: string;
      agentName: string;
      primary: boolean;
      status: ProvisioningStepStatus;
      durationMs?: number;
      error?: string;
      agentId?: string;
    }
  | {
      kind: 'conversation';
      status: ProvisioningStepStatus;
      durationMs?: number;
      error?: string;
      conversationId?: string;
    }
  | {
      kind: 'welcome';
      status: ProvisioningStepStatus;
      durationMs?: number;
      error?: string;
      messageId?: string;
    };

export interface SimpleProvisioningResult {
  conversationId: string;
  agentIds: string[];
}

export interface UseSimpleProvisioningReturn {
  steps: ProvisioningStep[];
  /** Index into `steps` of the step currently running, or null if none. */
  currentStepIndex: number | null;
  totalDurationMs: number;
  /** Set when a step has failed; cleared once retry succeeds. */
  error: { stepIndex: number; message: string } | null;
  /** Re-run from the failed step, keeping completed steps. */
  retry: () => void;
  /** Mark current failed step as skipped (only allowed on non-critical steps). */
  skip: () => void;
  /** Mark remaining steps as cancelled — caller closes modal. */
  cancel: () => void;
  /** Begin (or restart from scratch). Idempotent — re-calling does nothing if a run is in flight. */
  start: () => void;
  /** Populated when all 4 phases finish successfully. */
  result: SimpleProvisioningResult | null;
}

// ───────────────────────── Tunables ─────────────────────────

/** Spec §2.8.4 — minimum dwell per step. */
const STEP_FLOOR_MS = 200;

/** Critical (non-skippable) step kinds. */
const CRITICAL_KINDS = new Set<ProvisioningStep['kind']>(['device', 'agent']);

// ───────────────────────── Helpers ─────────────────────────

/** Build initial steps array from a plan. */
function buildInitialSteps(plan: SimpleProvisioningPlan): ProvisioningStep[] {
  const out: ProvisioningStep[] = [{ kind: 'device', status: 'pending' }];
  for (const role of plan.roles) {
    out.push({
      kind: 'agent',
      roleSlug: role.slug,
      agentName: role.displayName,
      primary: role.primary,
      status: 'pending',
    });
  }
  out.push({ kind: 'conversation', status: 'pending' });
  out.push({ kind: 'welcome', status: 'pending' });
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort);
  });
}

/** Pad a fast step to the dwell floor so the UI doesn't strobe. */
async function dwellFloor(elapsedMs: number, signal?: AbortSignal): Promise<void> {
  const remaining = STEP_FLOOR_MS - elapsedMs;
  if (remaining > 0) await sleep(remaining, signal);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function agentTypeFromRole(role: RenderedRole): AgentTypeEnum {
  if (role.primary) return 'orchestrator';
  if (role.agentType === 'support') return 'assistant';
  return 'specialist';
}

// ───────────────────────── Hook ─────────────────────────

export function useSimpleProvisioning(
  plan: SimpleProvisioningPlan | null,
  opts?: UseSimpleProvisioningOptions,
): UseSimpleProvisioningReturn {
  const onSlugConflictRef = useRef<UseSimpleProvisioningOptions['onSlugConflict']>(undefined);
  useEffect(() => {
    onSlugConflictRef.current = opts?.onSlugConflict;
  }, [opts?.onSlugConflict]);

  const onCapacityExceededRef = useRef<UseSimpleProvisioningOptions['onCapacityExceeded']>(undefined);
  useEffect(() => {
    onCapacityExceededRef.current = opts?.onCapacityExceeded;
  }, [opts?.onCapacityExceeded]);

  const [steps, setSteps] = useState<ProvisioningStep[]>(() => (plan ? buildInitialSteps(plan) : []));
  const [currentStepIndex, setCurrentStepIndex] = useState<number | null>(null);
  const [totalDurationMs, setTotalDurationMs] = useState(0);
  const [error, setError] = useState<{ stepIndex: number; message: string } | null>(null);
  const [result, setResult] = useState<SimpleProvisioningResult | null>(null);

  // Run lifecycle ref — guards against double-start and lets cancel() abort
  // mid-flight fetches via AbortSignal.
  const runningRef = useRef<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  // Persistent step results across retries: when retry() re-runs from the
  // failed step, we MUST keep already-registered agents / created device.
  // Mirror these alongside `steps` because we may build a new steps array
  // when the plan changes.
  const persistentRef = useRef<{
    installation?: { id: string; daemonId: string | null; reused: boolean };
    agentResults: Map<string, RegisterAgentResult>; // keyed by roleSlug
    conversationId?: string;
  }>({ agentResults: new Map() });

  // Live mirror of `steps` so the run loop can peek without setState-in-promise
  // shenanigans. Updated synchronously inside patchStep + state effects.
  const stepsRef = useRef<ProvisioningStep[]>(steps);
  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);

  // Live ref to the latest plan so the run loop reads current usernames
  // without restarting when the user edits a draft on Step 2 (Task 3 —
  // re-entry after slug-conflict must not nuke already-registered agents).
  const planRef = useRef<SimpleProvisioningPlan | null>(plan);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  // Reset trigger keyed on role-set identity, NOT the whole plan object.
  // Edits to `usernames` flow via planRef without resetting persistent state.
  const roleSetKey = useMemo(() => {
    if (!plan) return null;
    return plan.roles.map((r) => r.slug).join('|');
  }, [plan]);

  useEffect(() => {
    if (!plan) {
      stepsRef.current = [];
      setSteps([]);
      setCurrentStepIndex(null);
      setError(null);
      setResult(null);
      persistentRef.current = { agentResults: new Map() };
      return;
    }
    const initial = buildInitialSteps(plan);
    stepsRef.current = initial;
    setSteps(initial);
    setCurrentStepIndex(null);
    setError(null);
    setResult(null);
    setTotalDurationMs(0);
    persistentRef.current = { agentResults: new Map() };
    // The plan-level deps that warrant a hard reset are: presence + role set.
    // Username edits are intentionally NOT in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleSetKey]);

  // Cleanup: abort any in-flight run when the consumer unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ─── Step writer helper ──────────────────────────────────────
  const patchStep = useCallback((idx: number, patch: Partial<ProvisioningStep>) => {
    setSteps((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
      const next = prev.slice();
      // The discriminated union makes spread awkward; cast through unknown.
      next[idx] = { ...prev[idx], ...patch } as ProvisioningStep;
      stepsRef.current = next;
      return next;
    });
  }, []);

  // ─── Per-step executors ──────────────────────────────────────
  const runDeviceStep = useCallback(
    async (idx: number, signal: AbortSignal): Promise<void> => {
      if (!plan) throw new Error('no_plan');
      const startedAt = nowMs();
      patchStep(idx, { status: 'running' });

      // If we already have an installation cached (from a prior partial run),
      // reuse it without hitting the API.
      const cached = persistentRef.current.installation;
      if (cached) {
        patchStep(idx, {
          status: 'done',
          installationId: cached.id,
          reused: cached.reused,
          durationMs: Math.round(nowMs() - startedAt),
        });
        await dwellFloor(nowMs() - startedAt, signal);
        return;
      }

      // 1. List existing installations — reuse if any has spare capacity.
      // P3-7: when the modal supplied a `preferredInstallation` (from the
      // Step 1→2 capacity probe), trust that decision verbatim — the modal
      // already enforced `used + roles.length <= maxAgents` against the same
      // wire data we'd be re-fetching. Fall back to a live list query +
      // capacity-aware heuristic when no preference exists.
      let reuseTarget: { id: string; daemonId: string } | null = null;
      const preferred = plan.preferredInstallation;
      if (preferred) {
        // Per-installation maxAgents is the source of truth. Solo template
        // currently caps at 3 selected roles, but a future "team" mode could
        // bring more — gate on the real ceiling rather than hardcoded 3.
        if (preferred.used + plan.roles.length <= preferred.maxAgents) {
          reuseTarget = { id: preferred.id, daemonId: preferred.daemonId };
        }
      } else {
        try {
          const list = await imFetch<RuntimeInstallationDTO[]>(
            `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(plan.workspaceId)}`,
            { signal },
          );
          if (list.ok && Array.isArray(list.data)) {
            // Now that maxAgents is exposed on the DTO, pick the first
            // online/provisioning row whose `hostedAgentSummary.declared +
            // plan.roles.length` still fits its real ceiling.
            const fitsCapacity = (row: RuntimeInstallationDTO): boolean => {
              const used = row.hostedAgentSummary?.declared ?? 0;
              return used + plan.roles.length <= row.maxAgents;
            };
            const candidate =
              list.data.find((row) => row.phase === 'online' && fitsCapacity(row)) ??
              list.data.find((row) => row.phase === 'provisioning' && fitsCapacity(row));
            if (candidate) reuseTarget = { id: candidate.id, daemonId: candidate.daemonId };
          }
        } catch (err) {
          if ((err as DOMException)?.name === 'AbortError') throw err;
          // Non-fatal — fall through to provision a new one.
        }
      }

      if (reuseTarget) {
        persistentRef.current.installation = { id: reuseTarget.id, daemonId: reuseTarget.daemonId, reused: true };
        patchStep(idx, {
          status: 'done',
          installationId: reuseTarget.id,
          reused: true,
          durationMs: Math.round(nowMs() - startedAt),
        });
        await dwellFloor(nowMs() - startedAt, signal);
        return;
      }

      // 2. Provision new k8s installation. Defaults match the K8sProvisionWizard
      //    "sandbox-default + medium + medium + none" preset.
      const provisionRes = await imFetch<RuntimeInstallationDTO>('/api/workspace/runtime-installations', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: plan.workspaceId,
          kind: 'k8s',
          template: 'sandbox-default',
          // Omit image — server resolves via Nacos CONTAINER_IMAGE (daemon-v1.9.6+).
          cpuRequest: '500m',
          cpuLimit: '2000m',
          memoryRequest: '2Gi',
          memoryLimit: '4Gi',
          gpu: 0,
        }),
        signal,
      });
      if (!provisionRes.ok) {
        throw new Error(provisionRes.message || 'Cloud Device provision failed');
      }
      const newId = provisionRes.data?.id ?? '';
      const newDaemonId = provisionRes.data?.daemonId ?? null;
      persistentRef.current.installation = { id: newId, daemonId: newDaemonId, reused: false };
      patchStep(idx, {
        status: 'done',
        installationId: newId,
        reused: false,
        durationMs: Math.round(nowMs() - startedAt),
      });
      await dwellFloor(nowMs() - startedAt, signal);
    },
    [plan, patchStep],
  );

  const runAgentStep = useCallback(
    async (idx: number, role: RenderedRole, signal: AbortSignal): Promise<void> => {
      const livePlan = planRef.current;
      if (!livePlan) throw new Error('no_plan');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const startedAt = nowMs();
      patchStep(idx, { status: 'running' });

      // Cached result from a prior partial run → skip the API round-trip.
      const cached = persistentRef.current.agentResults.get(role.slug);
      if (cached) {
        patchStep(idx, {
          status: 'done',
          agentId: cached.imUserId,
          durationMs: Math.round(nowMs() - startedAt),
        });
        await dwellFloor(nowMs() - startedAt, signal);
        return;
      }

      // Task 3 — username comes from the plan's per-role draft. Empty/missing
      // falls back to the displayName seed (no random suffix — Discord-2023
      // lesson), then to `role.slug` verbatim. The production path always
      // supplies `usernames`; this fallback exists for the preview harness.
      const chosen = livePlan.usernames?.[role.slug]?.trim();
      const username = chosen && chosen.length > 0 ? chosen : suggestUsernameSeed(role.displayName) || role.slug;
      // P3-7: pass `daemonId` so the server-side capacity guard
      // (assertDeviceCapacityAvailable) can resolve the device row and
      // enforce `im_containers.maxAgents`. Device step always populates
      // `persistentRef.current.installation.daemonId` before this step runs,
      // either from `preferredInstallation` (modal probe) or from the
      // POST response (fresh provision); when both are null the server-side
      // check silently no-ops (no device row → nothing to enforce).
      const daemonId = persistentRef.current.installation?.daemonId ?? null;
      const res = await createAgent({
        username,
        displayName: role.displayName,
        agentType: agentTypeFromRole(role),
        workspaceId: livePlan.workspaceId,
        capabilities: [...role.capabilities],
        description: role.rationale,
        ...(daemonId ? { daemonId } : {}),
      });
      // createAgent doesn't accept an abort signal in its current signature;
      // but we keep the check post-completion so a cancel during the call
      // bubbles up before we patch state.
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res.ok) {
        // P3-7: capacity 409 is its own class — distinct UX from slug-conflict
        // 409 (edit handle) because the resolution is "upgrade / delete an
        // existing agent". Check the error.code first; the `raw` envelope
        // surfaces it as `{ error: { code: 'CAPACITY_EXCEEDED' }, meta: { used, max } }`.
        const rawEnvelope =
          (res as { raw?: { error?: { code?: string }; meta?: { used?: number; max?: number } } }).raw ?? null;
        const errCode = res.error;
        const isCapacity = errCode === 'CAPACITY_EXCEEDED' || rawEnvelope?.error?.code === 'CAPACITY_EXCEEDED';
        if (isCapacity) {
          const used = rawEnvelope?.meta?.used ?? 0;
          const max = rawEnvelope?.meta?.max ?? 3;
          throw new CapacityExceededError(used, max, daemonId, res.message || 'Device capacity exceeded');
        }
        // Detect 409 username-conflict → SlugConflictError so the run loop
        // can route the user back to Step 2 to edit the @handle. Server
        // phrasing varies: `/register` returns `Username '<x>' is already
        // taken`, `/agents` returns `Username already taken`. Anchor on the
        // phrase only — bare `status === 409` would now overlap with
        // CAPACITY_EXCEEDED above, which has different UX.
        const conflictPhrase = /username.*already taken/i;
        const looksLikeConflict = conflictPhrase.test(res.message ?? '') || conflictPhrase.test(res.error ?? '');
        if (looksLikeConflict) {
          throw new SlugConflictError(role.slug, username, res.message || 'Username already taken');
        }
        throw new Error(res.message || `Register agent failed: ${role.displayName}`);
      }
      persistentRef.current.agentResults.set(role.slug, res.data);
      patchStep(idx, {
        status: 'done',
        agentId: res.data.imUserId,
        durationMs: Math.round(nowMs() - startedAt),
      });
      await dwellFloor(nowMs() - startedAt, signal);
    },
    [patchStep],
  );

  const runConversationStep = useCallback(
    async (idx: number, signal: AbortSignal): Promise<void> => {
      if (!plan) throw new Error('no_plan');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const startedAt = nowMs();
      patchStep(idx, { status: 'running' });

      const cached = persistentRef.current.conversationId;
      if (cached) {
        patchStep(idx, {
          status: 'done',
          conversationId: cached,
          durationMs: Math.round(nowMs() - startedAt),
        });
        await dwellFloor(nowMs() - startedAt, signal);
        return;
      }

      const memberIds = Array.from(persistentRef.current.agentResults.values()).map((r) => r.imUserId);
      const res = await createGroupConversation({
        title: plan.conversationTitle ?? '团队会议',
        members: memberIds,
      });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res.ok) {
        throw new Error(res.message || 'Create group conversation failed');
      }
      const conversationId = res.data.groupId;
      persistentRef.current.conversationId = conversationId;
      patchStep(idx, {
        status: 'done',
        conversationId,
        durationMs: Math.round(nowMs() - startedAt),
      });
      await dwellFloor(nowMs() - startedAt, signal);
    },
    [plan, patchStep],
  );

  const runWelcomeStep = useCallback(
    async (idx: number, signal: AbortSignal): Promise<void> => {
      if (!plan) throw new Error('no_plan');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const startedAt = nowMs();
      patchStep(idx, { status: 'running' });

      const conversationId = persistentRef.current.conversationId;
      if (!conversationId) throw new Error('Missing conversation id for welcome message');

      const ceoEntry = Array.from(persistentRef.current.agentResults.values()).find((r) => {
        // The CEO is the first registered agent (plan.roles[0] is primary).
        return r.imUserId === persistentRef.current.agentResults.get(plan.roles[0]?.slug ?? '')?.imUserId;
      });
      const ceoHandle = ceoEntry?.username ?? plan.roles[0]?.slug ?? 'CEO';

      const res = await sendMessage({
        conversationId,
        type: 'text',
        content: `CEO @${ceoHandle} 邀请大家入伙开始干活`,
        metadata: { source: 'simple_mode_welcome' },
      });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res.ok) {
        throw new Error(res.message || 'Welcome message failed');
      }
      patchStep(idx, {
        status: 'done',
        messageId: res.data.message.id,
        durationMs: Math.round(nowMs() - startedAt),
      });
      await dwellFloor(nowMs() - startedAt, signal);
    },
    [plan, patchStep],
  );

  // ─── Run loop ─────────────────────────────────────────────────
  const runFrom = useCallback(
    async (fromIdx: number) => {
      if (!plan || runningRef.current) return;
      runningRef.current = true;
      setError(null);

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      const signal = controller.signal;

      const runStartedAt = nowMs();
      try {
        const live = stepsRef.current;
        for (let i = fromIdx; i < live.length; i++) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

          // Skip steps marked 'skipped' or already 'done' from a prior partial
          // run (preserved across retry).
          const liveStatus = stepsRef.current[i]?.status ?? 'pending';
          if (liveStatus === 'skipped' || liveStatus === 'done') {
            continue;
          }

          setCurrentStepIndex(i);

          const step = stepsRef.current[i];
          if (step.kind === 'device') {
            await runDeviceStep(i, signal);
          } else if (step.kind === 'agent') {
            const role = plan.roles.find((r) => r.slug === step.roleSlug);
            if (!role) throw new Error(`Role not found: ${step.roleSlug}`);
            await runAgentStep(i, role, signal);
          } else if (step.kind === 'conversation') {
            // Conversation step depends on agents — if user skipped any
            // critical agent (can't happen; agents are critical), bail. If
            // welcome was skipped earlier and they retry from conversation,
            // we'll handle that next iter.
            await runConversationStep(i, signal);
          } else if (step.kind === 'welcome') {
            // Welcome is non-critical — if conversation was skipped this
            // step would have nothing to send to. Mark skipped silently.
            if (!persistentRef.current.conversationId) {
              patchStep(i, { status: 'skipped' });
              continue;
            }
            await runWelcomeStep(i, signal);
          }
        }

        setCurrentStepIndex(null);
        setTotalDurationMs(Math.round(nowMs() - runStartedAt));

        // Success — build result and surface it.
        const conversationId = persistentRef.current.conversationId;
        const agentIds = Array.from(persistentRef.current.agentResults.values()).map((r) => r.imUserId);
        if (conversationId) {
          setResult({ conversationId, agentIds });
        }
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
          // Cancel path — already handled in cancel(); no error to set.
        } else {
          const message = err instanceof Error ? err.message : String(err);
          // Locate the running step index — patchStep had already flipped it.
          const failedIdx = stepsRef.current.findIndex((s) => s.status === 'running');
          if (failedIdx >= 0) {
            patchStep(failedIdx, { status: 'failed', error: message });
            setError({ stepIndex: failedIdx, message });
          }
          setCurrentStepIndex(null);
          // Task 3 — slug-conflict gets routed back to Step 2 so the user
          // can edit the @handle. SWC can mangle the prototype chain on
          // custom Error subclasses, so check both instanceof and the
          // tagged `name` (see ~/memory: feedback_instanceof_swc_unreliable).
          if (err instanceof SlugConflictError || (err as Error | undefined)?.name === 'SlugConflictError') {
            const conflict = err as SlugConflictError;
            onSlugConflictRef.current?.(conflict.roleSlug, message);
          }
          // P3-7 — capacity-exceeded routes to the shell so it can surface
          // an inline error region (no Step 2 routing — the user can't fix
          // it by re-editing handles; they need to upgrade / free a slot).
          if (err instanceof CapacityExceededError || (err as Error | undefined)?.name === 'CapacityExceededError') {
            const cap = err as CapacityExceededError;
            onCapacityExceededRef.current?.(cap.used, cap.max, message);
          }
        }
      } finally {
        runningRef.current = false;
      }
    },
    [plan, runDeviceStep, runAgentStep, runConversationStep, runWelcomeStep, patchStep],
  );

  // ─── Public actions ─────────────────────────────────────────
  const start = useCallback(() => {
    if (!plan) return;
    if (runningRef.current) return;
    if (result) return; // Already done — don't re-run.
    void runFrom(0);
  }, [plan, result, runFrom]);

  const retry = useCallback(() => {
    if (!error || !plan || runningRef.current) return;
    const idx = error.stepIndex;
    // Reset the failed step to pending so the run loop picks it up.
    patchStep(idx, { status: 'pending', error: undefined });
    setError(null);
    void runFrom(idx);
  }, [error, plan, patchStep, runFrom]);

  const skip = useCallback(() => {
    if (!error || !plan || runningRef.current) return;
    const idx = error.stepIndex;
    setSteps((prev) => {
      const step = prev[idx];
      if (!step) return prev;
      if (CRITICAL_KINDS.has(step.kind)) return prev; // disallow
      const next = prev.slice();
      next[idx] = { ...step, status: 'skipped', error: undefined } as ProvisioningStep;
      stepsRef.current = next;
      return next;
    });
    setError(null);
    void runFrom(idx + 1);
  }, [error, plan, runFrom]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    runningRef.current = false;
    setSteps((prev) => {
      const next = prev.map((step) => {
        if (step.status === 'pending' || step.status === 'running') {
          return { ...step, status: 'cancelled' } as ProvisioningStep;
        }
        return step;
      });
      stepsRef.current = next;
      return next;
    });
    setCurrentStepIndex(null);
  }, []);

  return useMemo(
    () => ({
      steps,
      currentStepIndex,
      totalDurationMs,
      error,
      retry,
      skip,
      cancel,
      start,
      result,
    }),
    [steps, currentStepIndex, totalDurationMs, error, retry, skip, cancel, start, result],
  );
}
