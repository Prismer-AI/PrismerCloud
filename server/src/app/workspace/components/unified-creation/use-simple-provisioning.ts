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
 *   On cancel after fully completed agent steps but before conversation,
 *   agent IMUsers persist in DB. We don't roll back because the user might
 *   still want them. Profile-creation failures inside an agent step are
 *   recoverable in-place: retry reuses the already registered agent and
 *   resumes profile setup instead of registering a second agent or hitting
 *   a username conflict.
 *
 * Determinism: the hook is plain async/await over fetch — no react-query,
 * no SWR. State is consumed by SimpleStep3Launch which is the only
 * intended caller.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProxyProvider } from '../proxy-provider-select';
import { imFetch } from '../../lib/im-api';
import {
  createProject,
  PROJECT_FILTER_ALL,
  PROJECT_FILTER_UNSCOPED,
  readActiveProjectFromStorage,
  writeActiveProjectToStorage,
} from '../../lib/projects-api';
import {
  createAgent,
  createAgentProfile,
  createGroupConversation,
  sendMessage,
  suggestUsernameSeed,
  type AgentTypeEnum,
  type MessageAttachmentDTO,
  type RegisterAgentResult,
} from '../../lib/mutations';
import type { RenderedRole } from '../../lib/templates/types';
import type { AssetDTO, RuntimeInstallationDTO } from '../../lib/types';
import {
  buildWorkspaceRoleTemplateSnapshot,
  buildWorkspaceKickoffMessage,
  buildWorkspaceSystemPrompt,
} from '@/lib/role-runtime-policy';

// ───────────────────────── Public types ─────────────────────────

export interface SimpleProvisioningPlan {
  workspaceId: string;
  /** Organization context entered in Simple mode Step 1. */
  organizationName: string;
  /** Model applied to every Hermes profile created by this simple-flow run. */
  model?: string;
  /**
   * 2026-05-30 — per-agent LLM proxy provider for every Hermes profile
   * created by this run. Defaults to `'newapi'` when omitted. Mirrors the Pro
   * mode's `ProfileConfigFields.proxyProvider` so Simple + Pro write the same
   * config-blob shape.
   */
  proxyProvider?: ProxyProvider;
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
  /**
   * Task 42 — Materials uploaded during the Simple-mode "Upload" step. When
   * non-empty, the orchestration appends a trailing "attach materials" step
   * after Welcome that posts a markdown message into the group conversation
   * with the assets as attachments, so the CEO/team see them as context from
   * the very first turn. Empty / undefined skips the step silently.
   *
   * Read through `planRef` so edits between Step 2 (upload) and Step 3
   * (launch) don't churn the steps array — the step is appended only at
   * `buildInitialSteps` time but the actual attachment data is resolved live.
   */
  uploadedAssets?: readonly AssetDTO[];
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
    }
  | {
      kind: 'attach-materials';
      status: ProvisioningStepStatus;
      durationMs?: number;
      error?: string;
      messageId?: string;
      assetCount?: number;
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
  // Task 42 — only append the materials-attach step when the user actually
  // uploaded files. Keeps the checklist short for the 0-file path.
  if ((plan.uploadedAssets?.length ?? 0) > 0) {
    out.push({ kind: 'attach-materials', status: 'pending', assetCount: plan.uploadedAssets?.length ?? 0 });
  }
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

// v2.0 — orchestrator authority is reserved for CEO only. Other primary
// roles (coo / operations / pm) default to executor under the new
// "one orchestrator + N specialists" model. See
// docs/release200/evidence/v20-acceptance/06-ceo-orchestrator-discipline-2026-05-22.md.
function isOrchestratorRole(role: RenderedRole): boolean {
  return role.slug === 'ceo';
}

export function buildSimpleProfileConfig(
  role: RenderedRole,
  username: string,
  organizationName: string,
  model = 'us-kimi-k2.6',
  proxyProvider: ProxyProvider = 'newapi',
): Record<string, unknown> {
  const authority = isOrchestratorRole(role) ? 'orchestrator' : 'executor';
  const roleTemplate = buildWorkspaceRoleTemplateSnapshot({
    slug: role.slug,
    displayName: role.displayName,
    rationale: role.rationale,
    organizationName,
    authority,
  });
  return {
    hermesProfileName: username,
    apiKey: generateSimpleHermesApiKey(username),
    autoStart: true,
    startupTimeoutMs: 30_000,
    configurePrismerProvider: true,
    model,
    // 2026-05-30 — per-agent proxy provider, parallels the Pro mode
    // `buildLongRunningProfileConfig` hermes branch. zod default on the daemon
    // side (HermesProfileConfigSchema) makes the field optional on the wire
    // but we always emit it from Simple mode to keep the config blob
    // self-documenting.
    proxyProvider,
    prismerProviderName: 'prismer',
    systemPrompt: buildWorkspaceSystemPrompt({
      displayName: role.displayName,
      rationale: role.rationale,
      organizationName,
    }),
    organizationName,
    roleTemplate,
    mcpAllowlist: (roleTemplate.mcpServers as Array<{ toolsAllowlist?: string[] }>)[0]?.toolsAllowlist,
    taskAuthority: roleTemplate.taskAuthority,
    approvalPolicy: roleTemplate.approvalPolicy,
    operatingPrinciples: roleTemplate.operatingPrinciples,
  };
}

async function persistSimpleOrganizationName(workspaceId: string, organizationName: string, signal: AbortSignal) {
  const existing = await imFetch<{ metadata?: Record<string, unknown> }>(
    `/workspaces/${encodeURIComponent(workspaceId)}`,
    { signal },
  );
  if (!existing.ok) {
    throw new Error(existing.message || 'Load workspace failed');
  }
  const metadata = {
    ...(existing.data?.metadata ?? {}),
    organizationName,
    simpleModeOrganizationName: organizationName,
  };
  const updated = await imFetch(`/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: organizationName, metadata }),
    signal,
  });
  if (!updated.ok) {
    throw new Error(updated.message || 'Update workspace organization failed');
  }
}

/**
 * Mark workspace metadata.onboardingComplete=true so page.tsx's
 * auto-open-simple-modal gate (line ~1679) stops re-triggering on F5.
 *
 * Fires at the top of `runFrom` — user clicking Launch is the intent signal,
 * independent of whether the device step succeeds. Without this, a failed
 * device (e.g. test EKS pod stuck in Pending) traps every fresh F5 inside
 * the wizard modal because all three other gates (no connected device, no
 * recent attempt after 24h, autoOpenedSimple resets on F5) fall through.
 *
 * Best-effort: PATCH failure is logged but never blocks the wizard flow.
 */
async function markWorkspaceOnboardingComplete(workspaceId: string, signal: AbortSignal): Promise<void> {
  try {
    const existing = await imFetch<{ metadata?: Record<string, unknown> }>(
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      { signal },
    );
    if (!existing.ok) return;
    const prevMeta = (existing.data?.metadata ?? {}) as Record<string, unknown>;
    if (prevMeta.onboardingComplete === true) return;
    const metadata = {
      ...prevMeta,
      onboardingComplete: true,
      onboardingCompletedAt: new Date().toISOString(),
    };
    await imFetch(`/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ metadata }),
      signal,
    });
  } catch {
    /* best-effort — never block wizard flow on metadata write */
  }
}

/**
 * release201 v2.0.8 F-bug follow-up — auto-create a default "main" project on
 * first Simple-mode launch so the user never has to leave the wizard to set
 * up project scope.
 *
 * Spec: Simple mode = "one click, sensible defaults". Before this helper, the
 * Simple flow left ProjectSwitcher in 'all' / '__unscoped' state and forced
 * the user to mid-flow click "先创建项目 →" and bounce out to the switcher
 * dropdown — which violates simple-mode semantics.
 *
 * Guard: if the workspace already has an active project sentinel that points
 * at a real project id (not 'all' / '__unscoped'), we DO NOT recreate. This
 * keeps the helper idempotent across re-entries (e.g. user closes modal
 * mid-flow, reopens, re-launches) and avoids stomping on a project the user
 * created via ProjectSwitcher between runs.
 *
 * Best-effort: failure (network / 409 on slug conflict / etc.) is logged via
 * console.warn but never throws. Downstream device step's
 * `readActiveProjectFromStorage` still works (falls back to sentinel →
 * workspace-level scope) so the wizard continues even if project creation
 * fails.
 */
export async function ensureSimpleModeProject(
  workspaceId: string,
  organizationName: string,
  signal: AbortSignal,
  createProjectFn: typeof createProject = createProject,
): Promise<void> {
  const existingActive = readActiveProjectFromStorage(workspaceId);
  if (existingActive && existingActive !== PROJECT_FILTER_ALL && existingActive !== PROJECT_FILTER_UNSCOPED) {
    // User already has a real project selected — respect it.
    return;
  }
  try {
    const trimmedOrg = organizationName.trim();
    const projectName = trimmedOrg ? `${trimmedOrg} 主项目` : '主项目';
    const resp = await createProjectFn({
      workspaceId,
      slug: 'main',
      name: projectName,
      description: '自动创建于 Simple mode 引导流程',
      metadata: { createdBy: 'simple-mode-bootstrap' },
    });
    if (signal.aborted) return;
    if (resp.ok && resp.data?.id) {
      writeActiveProjectToStorage(workspaceId, resp.data.id);
    } else if (!resp.ok) {
      console.warn('[useSimpleProvisioning] auto-create main project failed:', resp.message ?? resp.error);
    }
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return;
    console.warn('[useSimpleProvisioning] auto-create main project threw:', err);
  }
}

function generateSimpleHermesApiKey(username: string): string {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24) || 'agent';
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return `hermes-${safe}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `hermes-${safe}-${Math.random().toString(36).slice(2, 14)}`;
}

export async function registerOrReuseSimpleProvisioningAgent(
  input: {
    role: RenderedRole;
    username: string;
    workspaceId: string;
    daemonId: string | null;
    pendingAgent?: RegisterAgentResult | { agent: RegisterAgentResult; profileCreated: boolean };
  },
  create: typeof createAgent = createAgent,
): Promise<{ agent: RegisterAgentResult; reusedPending: boolean }> {
  if (input.pendingAgent) {
    const agent = 'agent' in input.pendingAgent ? input.pendingAgent.agent : input.pendingAgent;
    return { agent, reusedPending: true };
  }

  const res = await create({
    username: input.username,
    displayName: input.role.displayName,
    agentType: agentTypeFromRole(input.role),
    workspaceId: input.workspaceId,
    capabilities: [...input.role.capabilities],
    description: input.role.rationale,
    ...(input.daemonId ? { daemonId: input.daemonId } : {}),
  });
  if (!res.ok) {
    const rawEnvelope =
      (res as { raw?: { error?: { code?: string }; meta?: { used?: number; max?: number } } }).raw ?? null;
    const errCode = res.error;
    const isCapacity = errCode === 'CAPACITY_EXCEEDED' || rawEnvelope?.error?.code === 'CAPACITY_EXCEEDED';
    if (isCapacity) {
      const used = rawEnvelope?.meta?.used ?? 0;
      const max = rawEnvelope?.meta?.max ?? 3;
      throw new CapacityExceededError(used, max, input.daemonId, res.message || 'Device capacity exceeded');
    }
    const conflictPhrase = /username.*already taken/i;
    const looksLikeConflict = conflictPhrase.test(res.message ?? '') || conflictPhrase.test(res.error ?? '');
    if (looksLikeConflict) {
      throw new SlugConflictError(input.role.slug, input.username, res.message || 'Username already taken');
    }
    throw new Error(res.message || `Register agent failed: ${input.role.displayName}`);
  }

  return { agent: res.data, reusedPending: false };
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
    profilePendingAgentResults: Map<string, { agent: RegisterAgentResult; profileCreated: boolean }>; // register succeeded; profile/preinstall still needs retry
    conversationId?: string;
  }>({ agentResults: new Map(), profilePendingAgentResults: new Map() });

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
  //
  // Task 42 — also include the asset-count slice of identity so the steps
  // array picks up / drops the "attach-materials" entry when the user toggles
  // their upload set on Step 2 before launching. Identity of which specific
  // assets they are flows live via planRef, so swapping one asset for another
  // (same count) doesn't churn the steps array.
  const roleSetKey = useMemo(() => {
    if (!plan) return null;
    return `${plan.roles.map((r) => r.slug).join('|')}::assets=${plan.uploadedAssets?.length ?? 0}`;
  }, [plan]);

  useEffect(() => {
    if (!plan) {
      stepsRef.current = [];
      setSteps([]);
      setCurrentStepIndex(null);
      setError(null);
      setResult(null);
      persistentRef.current = { agentResults: new Map(), profilePendingAgentResults: new Map() };
      return;
    }
    const initial = buildInitialSteps(plan);
    stepsRef.current = initial;
    setSteps(initial);
    setCurrentStepIndex(null);
    setError(null);
    setResult(null);
    setTotalDurationMs(0);
    persistentRef.current = { agentResults: new Map(), profilePendingAgentResults: new Map() };
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
      await persistSimpleOrganizationName(plan.workspaceId, plan.organizationName, signal);

      // 2. List existing installations — reuse if any has spare capacity.
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

      // 3. Provision new k8s installation. Defaults match the K8sProvisionWizard
      //    "sandbox-default + medium + medium + none" preset.
      //
      // M448 (doc 20 Gap A) — when the workspace has an active ProjectSwitcher
      // selection that's a real project id (not the 'all' / '__unscoped'
      // sentinels), thread it through so the new device lands inside that
      // project's scope. Sentinels collapse to workspace-level (NULL).
      const activeProject = readActiveProjectFromStorage(plan.workspaceId);
      const scopedProjectId =
        activeProject && activeProject !== PROJECT_FILTER_ALL && activeProject !== PROJECT_FILTER_UNSCOPED
          ? activeProject
          : undefined;
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
          ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
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

      const pendingAgent = persistentRef.current.profilePendingAgentResults.get(role.slug);
      const { agent, reusedPending } = await registerOrReuseSimpleProvisioningAgent({
        role,
        username,
        workspaceId: livePlan.workspaceId,
        daemonId,
        pendingAgent,
      });
      // createAgent doesn't accept an abort signal in its current signature;
      // but we keep the check post-completion so a cancel during the call
      // bubbles up before we patch state.
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!reusedPending) {
        persistentRef.current.profilePendingAgentResults.set(role.slug, { agent, profileCreated: false });
      }

      const pending = persistentRef.current.profilePendingAgentResults.get(role.slug);
      if (!pending?.profileCreated) {
        const profile = await createAgentProfile({
          workspaceId: livePlan.workspaceId,
          agentImUserId: agent.imUserId,
          adapterName: 'hermes',
          name: 'default',
          config: buildSimpleProfileConfig(
            role,
            username,
            livePlan.organizationName,
            livePlan.model,
            livePlan.proxyProvider,
          ),
        });
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!profile.ok) {
          const profileAlreadyExists =
            profile.status === 409 && /profile.*already exists/i.test(`${profile.error} ${profile.message}`);
          if (profileAlreadyExists) {
            if (pending) pending.profileCreated = true;
          } else {
            throw new Error(
              `Agent @${agent.username} was created, but profile setup failed: ${
                profile.message || `Create agent profile failed: ${role.displayName}`
              }. Retry will resume profile setup for this agent.`,
            );
          }
        } else if (pending) {
          pending.profileCreated = true;
        }
      }

      // Simple mode uses local template snapshots embedded into the profile
      // config above. Do not call cloud role-template preinstall here: test
      // environments may not seed the matching server-side role template rows,
      // and a 404 would be noisy while adding no capability beyond the embedded
      // roleTemplate/mcpAllowlist already written to the AgentProfile.

      persistentRef.current.profilePendingAgentResults.delete(role.slug);
      persistentRef.current.agentResults.set(role.slug, agent);
      patchStep(idx, {
        status: 'done',
        agentId: agent.imUserId,
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

      // Kick the all-hands group off with a CEO-directed introduction.
      // The @-mention dispatches to the CEO agent so the actual greeting
      // ("大家认识一下") will land as the CEO's first message in the
      // bubble feed, not as the human's voice. Wording is deliberately
      // direct so the agent prompt picks up the intent verbatim.
      const res = await sendMessage({
        conversationId,
        type: 'text',
        content: buildWorkspaceKickoffMessage(ceoHandle),
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

  // Task 42 — Post-welcome step that attaches uploaded company materials to
  // the new group conversation as a markdown message with `attachments` so
  // teammates see them as first-turn context. Non-fatal on failure:
  // the group + welcome already succeeded, so we log and mark the step
  // as failed but the whole flow's result is unaffected.
  const runAttachMaterialsStep = useCallback(
    async (idx: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const livePlan = planRef.current;
      if (!livePlan) throw new Error('no_plan');
      const conversationId = persistentRef.current.conversationId;
      if (!conversationId) throw new Error('Missing conversation id for attach-materials step');

      const assets = livePlan.uploadedAssets ?? [];
      const startedAt = nowMs();
      patchStep(idx, { status: 'running', assetCount: assets.length });

      if (assets.length === 0) {
        // Should not normally hit this — buildInitialSteps gates on length>0 —
        // but if the user removed assets between mounts of the hook, treat as
        // a no-op skip rather than an error.
        patchStep(idx, { status: 'skipped', durationMs: Math.round(nowMs() - startedAt) });
        await dwellFloor(nowMs() - startedAt, signal);
        return;
      }

      // Build attachments + markdown body. Backend resolves attachments by
      // `assetId`; the markdown body is a human-readable summary so the
      // message renders nicely in non-rich clients too. We use filename-only
      // links (no prismer:// URL) because contentHash isn't strictly needed —
      // backend resolves via the `attachments[].assetId` array.
      const attachments: MessageAttachmentDTO[] = assets.map((asset) => {
        const m = (asset.mime ?? '').toLowerCase();
        const kind: MessageAttachmentDTO['kind'] =
          asset.kind === 'file' || asset.kind === 'image' || asset.kind === 'audio' || asset.kind === 'video'
            ? asset.kind
            : m.startsWith('image/')
              ? 'image'
              : m.startsWith('audio/')
                ? 'audio'
                : m.startsWith('video/')
                  ? 'video'
                  : 'file';
        const title = asset.filename ?? asset.id;
        return {
          kind,
          assetId: asset.id,
          title,
          filename: title,
          mime: asset.mime ?? null,
          sizeBytes: asset.sizeBytes ?? null,
          contentHash: asset.contentHash ?? null,
          thumbnailUrl: asset.thumbnailUrl ?? null,
          revision: asset.revision ?? null,
          role: 'context',
        };
      });

      const lines = assets.map((a) => `- ${a.filename ?? a.id}`).join('\n');
      const body = `📎 已附上企业材料供大家参考:\n\n${lines}`;

      const res = await sendMessage({
        conversationId,
        type: 'markdown',
        content: body,
        attachments,
        metadata: {
          source: 'simple_mode_company_materials',
          kind: 'workspace_asset_attachment',
          assetIds: assets.map((a) => a.id),
        },
      });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res.ok) {
        throw new Error(res.message || 'Attach materials message failed');
      }
      patchStep(idx, {
        status: 'done',
        messageId: res.data.message.id,
        durationMs: Math.round(nowMs() - startedAt),
      });
      await dwellFloor(nowMs() - startedAt, signal);
    },
    [patchStep],
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

      // Mark onboarding complete the moment the user kicks the wizard off
      // — independent of whether device step succeeds. See
      // markWorkspaceOnboardingComplete docstring for the gate context.
      // Fire-and-forget; never await so a slow PATCH doesn't delay step 0.
      void markWorkspaceOnboardingComplete(plan.workspaceId, signal);

      // release201 v2.0.8 F-bug follow-up — Simple mode auto-creates a
      // default "main" project so the user never has to leave the wizard.
      // Awaited (not fire-and-forget) because the device step downstream
      // reads `readActiveProjectFromStorage` and we want the new project id
      // visible before that runs. Idempotent + best-effort; see helper.
      await ensureSimpleModeProject(plan.workspaceId, plan.organizationName, signal);

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
          } else if (step.kind === 'attach-materials') {
            // Task 42 — non-critical: if conversation never got created, skip
            // silently (nothing to attach to). Otherwise run the step; failure
            // surfaces as a step error but doesn't sink the overall result.
            if (!persistentRef.current.conversationId) {
              patchStep(i, { status: 'skipped' });
              continue;
            }
            await runAttachMaterialsStep(i, signal);
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
    [plan, runDeviceStep, runAgentStep, runConversationStep, runWelcomeStep, runAttachMaterialsStep, patchStep],
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
