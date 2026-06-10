/**
 * Studio shared types + thin API clients.
 *
 * Layered on top of existing IM endpoints:
 *   GET  /api/im/studio/overview           — counts + recent activity
 *   GET  /api/im/studio/profile?agentId=   — agent identity + personality + workspaces
 *   GET  /api/im/studio/installed?agentId= — agent's installed skills
 *   GET  /api/im/skills/drafts?workspaceId= — drafts in a workspace
 *   GET  /api/im/skills/draft/:id          — single draft detail (incl. files)
 *   POST /api/im/skills/draft              — create a new draft
 *   PATCH /api/im/agents/:agentId/skills/:skillId — update skill config
 *   DELETE /api/im/agents/:agentId/skills/:skillId — uninstall
 *
 * NOTE: the shell never reaches into evolution capsule/gene endpoints — those
 * remain on /evolution proper. Studio is for skill + agent ops only.
 */

import type { TranslationKey } from '@/lib/i18n';

export type StudioView = 'my-agents' | 'skills' | 'metrics';

export const STUDIO_VIEWS: StudioView[] = ['my-agents', 'skills', 'metrics'];

/**
 * Skills view sub-tabs (release201/13 §3.2-3.6, S22 裁决 2026-05-27).
 *
 *   authoring  — current 'Skills' list view (drafts + status filter)
 *   lifecycle  — pipeline rail + Evidence panel (9 sections) + Publish controls
 *   installed  — per-agent installed skill list with Configure modal
 *   evolution  — per-agent capsule / gene tracking
 *
 * Only meaningful when `StudioView === 'skills'`; encoded as `?subview=`.
 */
export type SkillsSubview = 'authoring' | 'lifecycle' | 'installed' | 'evolution';

export const SKILLS_SUBVIEWS: SkillsSubview[] = ['authoring', 'lifecycle', 'installed', 'evolution'];

export function normalizeSkillsSubview(raw: string | null | undefined): SkillsSubview {
  if (raw === 'lifecycle' || raw === 'installed' || raw === 'evolution') return raw;
  return 'authoring';
}

/**
 * Map legacy view names from doc 13's 6-domain split into the collapsed 3.
 *
 * release201/24 §Phase3 — `installed` / `evolution` are now Skills SUB-views
 * (the single canonical home for installed skills lives under Studio → Skills →
 * Installed), so they collapse to `skills`, NOT `my-agents`. `profile` /
 * `overview` remain `my-agents`. Pair this with `legacyViewToSubview` so the
 * sub-tab is preserved when an old `?view=lifecycle` style link is opened.
 */
export function normalizeLegacyView(raw: string | null | undefined): StudioView {
  if (!raw) return 'my-agents';
  if (raw === 'my-agents' || raw === 'skills' || raw === 'metrics') return raw;
  if (raw === 'authoring' || raw === 'lifecycle' || raw === 'installed' || raw === 'evolution') return 'skills';
  if (raw === 'profile' || raw === 'overview') return 'my-agents';
  return 'my-agents';
}

/**
 * release201/24 §Phase3 — when a legacy `?view=` value is actually a Skills
 * sub-tab name, return the canonical subview so `?view=lifecycle` (old) maps to
 * `view=skills&subview=lifecycle` (canonical). Returns null for non-subview
 * legacy views (profile/overview/my-agents/metrics).
 */
export function legacyViewToSubview(raw: string | null | undefined): SkillsSubview | null {
  if (raw === 'lifecycle' || raw === 'installed' || raw === 'evolution' || raw === 'authoring') return raw;
  return null;
}

// ─── Token helpers ────────────────────────────────────────────────────

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const auth = JSON.parse(localStorage.getItem('prismer_auth') ?? '{}');
    if (auth?.token) return auth.token as string;
  } catch {
    /* swallow */
  }
  return localStorage.getItem('prismer_active_api_key');
}

// Exported so the v2 `data/*` clients (role-templates / profile) can reuse the
// same Bearer-token derivation + ok-envelope unwrapping instead of re-rolling
// auth. Both remain internal helpers for the legacy clients above.
export function authHeader(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: authHeader() });
    const data = await res.json();
    if (!res.ok || !data?.ok) return null;
    return data.data as T;
  } catch {
    return null;
  }
}

// ─── Overview ─────────────────────────────────────────────────────────

export interface StudioOverview {
  counts: {
    drafts: number;
    inEval: number;
    pendingReview: number;
    publishedThisWeek: number;
  };
  recentLifecycle: Array<{
    skillId: string;
    slug: string;
    name: string;
    status: string;
    updatedAt: string;
  }>;
  recentActivity: Array<{ summary: string; timestamp: string }>;
}

export function fetchOverview(workspaceId: string | null): Promise<StudioOverview | null> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return getJson(`/api/im/studio/overview${qs}`);
}

// ─── Profile ──────────────────────────────────────────────────────────

export interface AgentIdentity {
  agentId: string;
  displayName: string;
  did?: string;
  agentType: string;
  status: string;
  capabilities: string[];
}

export interface AgentPersonality {
  rigor: number;
  creativity: number;
  risk_tolerance: number;
  soul?: string;
}

export interface StudioProfile {
  agentId: string | null;
  identity: AgentIdentity | null;
  personality: AgentPersonality | null;
  credits: { balance: number; totalSpent: number; totalEarned: number } | null;
  workspaces: Array<{ workspaceId: string; name: string }>;
}

export function fetchProfile(agentId: string | null): Promise<StudioProfile | null> {
  const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  return getJson(`/api/im/studio/profile${qs}`);
}

// ─── Installed skills ─────────────────────────────────────────────────

export interface InstalledSkill {
  skillId: string;
  slug: string;
  name: string;
  version: string;
  installedAt: string;
  lastInvokedAt: string | null;
  status: 'active' | 'needs-sync' | 'error';
}

export interface StudioInstalled {
  agentId: string | null;
  /** Active selection per the BFF — same as `agentId` for legacy callers. */
  activeAgentId?: string | null;
  /** All agents the caller may inspect inside this workspace. */
  agents?: Array<{
    agentId: string;
    username?: string;
    displayName: string;
    agentType?: string;
    status?: string;
    workspaceId?: string;
    capabilities?: string[];
  }>;
  workspaceId?: string | null;
  skills: InstalledSkill[];
}

export function fetchInstalled(agentId: string | null, workspaceId?: string | null): Promise<StudioInstalled | null> {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  // release201 v2.0.8 hotfix X2 — explicit workspaceId pins the BFF query to
  // the user-selected workspace. Without it, /studio/installed falls back to
  // the caller's first-owned workspace (resolveWorkspaceId in studio.ts),
  // which produces wrong `agents[]` when the active workspace is not the
  // oldest one (e.g. "Prismer" workspace selected, but resolver picks the
  // user's original onboarding workspace).
  if (workspaceId) params.set('workspaceId', workspaceId);
  const qs = params.toString();
  return getJson(`/api/im/studio/installed${qs ? `?${qs}` : ''}`);
}

// ─── Skill drafts ─────────────────────────────────────────────────────

export interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: 'draft' | 'in_eval' | 'review' | 'published' | string;
  lifecycleStage?: string;
  publishScope?: string;
  contentManifestRevision?: string | null;
  updatedAt?: string;
  metadata?: unknown;
}

export async function fetchDrafts(workspaceId: string | null): Promise<SkillRow[]> {
  if (!workspaceId) return [];
  const data = await getJson<SkillRow[]>(`/api/im/skills/drafts?workspaceId=${encodeURIComponent(workspaceId)}`);
  return data ?? [];
}

export interface DraftFile {
  path: string;
  content?: string;
  size?: number;
}

export interface SkillDraftDetail extends SkillRow {
  files: DraftFile[];
}

export function fetchDraftDetail(id: string): Promise<SkillDraftDetail | null> {
  return getJson(`/api/im/skills/draft/${encodeURIComponent(id)}`);
}

export interface CreateDraftInput {
  slug: string;
  name: string;
  description: string;
  workspaceId: string;
  files: Array<{ path: string; content?: string; contentBase64?: string }>;
  metadata?: Record<string, unknown>;
}

export async function createDraft(input: CreateDraftInput): Promise<{ id: string } | { error: string }> {
  try {
    const res = await fetch('/api/im/skills/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      return { error: data?.error ?? `HTTP ${res.status}` };
    }
    return { id: data.data.id as string };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// release201/24 §UX — dispatch a real authoring run to a workspace agent.
// The agent fetches the source, distills it, and creates the draft itself
// (replaces the old client-side manifest stuffer).
export interface AuthoringRequestInput {
  intent: string;
  sourceKind: SourceKind;
  sourceRefs: string[];
  sampleTask?: string | null;
  workspaceId: string;
  agentId?: string | null;
  /** release201/24 §Phase1a — converged spec from the conversational wizard. */
  spec?: AuthoringSpec | null;
}

// release201/24 §Phase1a (Path B) — the conversational intake spec + chat turn.
export interface AuthoringSampleTask {
  input: string;
  acceptanceCriteria: string[];
}
export interface AuthoringSpec {
  slug?: string;
  name?: string;
  triggers?: string[];
  inputs?: string;
  outputs?: string;
  sourceKind?: SourceKind;
  sourceRefs?: string[];
  scope?: 'private' | 'workspace' | 'public';
  acceptanceCriteria?: string[];
  sampleTasks?: AuthoringSampleTask[];
}
export interface AuthoringChatDecision {
  key: string;
  label: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  multiple?: boolean;
}
export interface AuthoringChatTurn {
  reply: string;
  spec: AuthoringSpec;
  decisions: AuthoringChatDecision[];
  ready: boolean;
}
export type AuthoringChatResult = { ok: true; turn: AuthoringChatTurn } | { ok: false; error: string; message?: string };

export async function authoringChat(input: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  workspaceId: string;
  specSoFar?: AuthoringSpec;
}): Promise<AuthoringChatResult> {
  try {
    const res = await fetch('/api/im/skills/authoring-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error ?? `HTTP ${res.status}`, message: data?.message };
    }
    return { ok: true, turn: data.data as AuthoringChatTurn };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type AuthoringRequestResult =
  | { ok: true; taskId: string; agentId: string; agentOnline: boolean }
  | { ok: false; error: string; message?: string };

export async function requestAuthoring(input: AuthoringRequestInput): Promise<AuthoringRequestResult> {
  try {
    const res = await fetch('/api/im/skills/authoring-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error ?? `HTTP ${res.status}`, message: data?.message };
    }
    return { ok: true, taskId: data.data.taskId, agentId: data.data.agentId, agentOnline: !!data.data.agentOnline };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Skill ops ────────────────────────────────────────────────────────

export async function uninstallSkill(agentId: string, skillId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/im/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
      headers: authHeader(),
    });
    const data = await res.json();
    return res.ok && data?.ok === true;
  } catch {
    return false;
  }
}

// ─── Workspace / agent context resolution ─────────────────────────────

export function readActiveWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    for (const key of ['prismer_active_workspace_id', 'prismer_workspace_id', 'activeWorkspaceId']) {
      const v = localStorage.getItem(key);
      if (v) return v;
    }
    const url = new URL(window.location.href);
    return url.searchParams.get('workspaceId');
  } catch {
    return null;
  }
}

export async function resolveWorkspaceIdFromBackend(): Promise<string | null> {
  try {
    const res = await fetch('/api/im/workspaces?mine=1', { headers: authHeader() });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.data) && data.data.length > 0) {
      return data.data[0]?.id ?? null;
    }
  } catch {
    /* swallow */
  }
  return null;
}

export interface WorkspaceAgent {
  agentId: string;
  displayName: string;
  agentType: string;
}

/**
 * List agents the current user can pick in the agent picker.
 *
 * Strategy: first call /api/im/studio/profile (returns my-self agent + workspaces);
 * the picker shows just the caller's agent for now. Multi-agent picker is a
 * future feature once contributor agents land properly in studio scope.
 */
export async function listMyAgents(): Promise<WorkspaceAgent[]> {
  const profile = await fetchProfile(null);
  if (!profile?.identity) return [];
  return [
    {
      agentId: profile.identity.agentId,
      displayName: profile.identity.displayName,
      agentType: profile.identity.agentType,
    },
  ];
}

// ─── Time formatting ──────────────────────────────────────────────────

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function localizedTimeAgo(
  iso: string | null | undefined,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string {
  if (!iso) return '—';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '—';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t('workspace.topbar.justNow');
  if (diff < 3_600_000) return t('workspace.topbar.minutesAgo', { count: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return t('workspace.topbar.hoursAgo', { count: Math.round(diff / 3_600_000) });
  if (diff < 30 * 86_400_000) return t('workspace.topbar.daysAgo', { count: Math.round(diff / 86_400_000) });
  return new Date(iso).toISOString().slice(0, 10);
}

// ─── Source kind detection ────────────────────────────────────────────

export type SourceKind = 'inline-spec' | 'doc-url' | 'code-source' | 'service-endpoint';

export function detectSourceKind(input: string): SourceKind {
  const trimmed = input.trim();
  if (!trimmed) return 'inline-spec';
  // URL detection
  if (/^https?:\/\//i.test(trimmed)) {
    if (/\/api\/|\/v\d+\/|\.(json|yaml|openapi)/i.test(trimmed)) return 'service-endpoint';
    return 'doc-url';
  }
  // Path detection (unix-like absolute or relative)
  if (/^[~./]/.test(trimmed) || /^[a-zA-Z]:\\/.test(trimmed)) return 'code-source';
  return 'inline-spec';
}

// ─── Full skill detail (any lifecycle stage) ─────────────────────────
//
// Used by the Lifecycle sub-tab to pull data for the 9 evidence sections.
// GET /api/im/skills/:idOrSlug returns IMSkill row (lifecycleStage may be any
// of draft|eval|review|published|archived) — broader than the draft-only
// /api/im/skills/draft/:id route.

export interface SkillFile {
  path: string;
  size?: number;
  content?: string;
}

export interface SkillProvenance {
  sourceKind?: string;
  sourceRefs?: Array<{ kind?: string; url?: string; path?: string; label?: string }>;
}

export interface SkillSecurity {
  dataAccess?: string[];
  humanApprovalRequiredFor?: string[];
  riskLevel?: 'low' | 'medium' | 'high' | string;
}

export interface SkillRuntimeRequires {
  env?: string[];
  bins?: string[];
  python?: string;
  node?: string;
  capabilities?: string[];
}

export interface SkillConfigSchema {
  type?: 'object';
  properties?: Record<
    string,
    {
      type?: 'string' | 'number' | 'boolean';
      default?: unknown;
      enum?: Array<unknown>;
      description?: string;
    }
  >;
  required?: string[];
}

export interface SkillExecutableJson {
  configSchema?: SkillConfigSchema;
  [key: string]: unknown;
}

export interface SkillValidationWarning {
  gate: string;
  severity?: 'info' | 'warning' | 'error';
  message: string;
}

export interface SkillDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  status?: string;
  lifecycleStage?: string;
  publishScope?: string;
  contentManifestRevision?: string | null;
  contentManifest?: string | null;
  updatedAt?: string;
  createdAt?: string;
  publishedAt?: string | null;
  files?: SkillFile[];
  executableJson?: SkillExecutableJson;
  requires?: SkillRuntimeRequires;
  metadata?: {
    lifecycleSubStage?: string;
    skillJson?: {
      description?: string;
      provenance?: SkillProvenance;
      security?: SkillSecurity;
      runtime?: { requires?: SkillRuntimeRequires };
      sampleTasks?: Array<{ title: string; description?: string }>;
    };
    validationWarnings?: SkillValidationWarning[];
    sessions?: {
      business?: string;
      dev?: string;
      test?: string;
      review?: string;
    };
    // release201/24 §Phase2/4 — per-revision eval pass-rate history powering
    // the Studio success-rate curve. Written by SkillLifecycleService.
    authoring?: {
      autoOptimize?: boolean;
      maxIterations?: number;
      autoOptimizeIteration?: number;
      draftRevisionHistory?: Array<{
        revision?: string | null;
        passRate?: number;
        evalRunId?: string;
        evaluatedAt?: string;
        regenerated?: boolean;
        reason?: string;
        createdAt?: string;
      }>;
    };
    activeEvalRunId?: string;
    sampleTaskId?: string;
    publishPlan?: {
      scope?: string;
      version?: string;
      changelog?: string;
      installTargets?: string[];
    };
    [key: string]: unknown;
  };
}

export async function fetchSkillDetail(skillId: string): Promise<SkillDetail | null> {
  return getJson<SkillDetail>(`/api/im/skills/${encodeURIComponent(skillId)}`);
}

// ─── Lifecycle pipeline ────────────────────────────────────────────

export const LIFECYCLE_PIPELINE_STAGES = [
  { key: 'intake', label: 'Intake' },
  { key: 'source_review', label: 'Source' },
  { key: 'design', label: 'Design' },
  { key: 'scaffold', label: 'Scaffold' },
  { key: 'implement', label: 'Implement' },
  { key: 'static_validate', label: 'Validate' },
  { key: 'sandbox_smoke', label: 'Smoke' },
  { key: 'sample_task', label: 'Sample' },
  { key: 'human_review', label: 'Review' },
  { key: 'publish_ready', label: 'Publish ready' },
  { key: 'published', label: 'Published' },
] as const;

export type LifecycleSubStage = (typeof LIFECYCLE_PIPELINE_STAGES)[number]['key'];

/** Derive sub-stage from skill detail, falling back to main stage. */
export function deriveLifecycleSubStage(skill: SkillDetail | null): LifecycleSubStage {
  const sub = skill?.metadata?.lifecycleSubStage as LifecycleSubStage | undefined;
  if (sub) return sub;
  const stage = (skill?.lifecycleStage ?? skill?.status ?? '').toLowerCase();
  if (stage === 'published') return 'published';
  if (stage === 'review') return 'human_review';
  if (stage === 'eval') return 'static_validate';
  return 'intake';
}

// ─── Workspace skills (any stage) ────────────────────────────────────

/**
 * List skills in any lifecycle stage for the Lifecycle sub-tab's selector.
 * Uses /api/im/skills/created which already supports filtering by workspace
 * + status. We accept stages = draft|eval|review|published.
 */
export async function fetchWorkspaceSkillsByStage(
  workspaceId: string | null,
  stages: Array<'draft' | 'eval' | 'review' | 'published'> = ['draft', 'eval', 'review', 'published'],
): Promise<SkillRow[]> {
  if (!workspaceId) return [];
  // The drafts endpoint already returns workspace-scoped rows. To get rows in
  // other stages we hit /skills/created with `workspaceId` and filter; if that
  // endpoint doesn't honour the filter we fall back to multiple drafts calls.
  // For now we rely on /drafts (status=draft) + /skills/created (any status
  // in caller's workspace) merged.
  const draftRows = await fetchDrafts(workspaceId);
  // Pull additional lifecycle-stage rows directly from IMSkill via the
  // generic created endpoint (auth user owned skills).
  const created = await getJson<SkillRow[]>(
    `/api/im/skills/created?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
  );
  const all = new Map<string, SkillRow>();
  for (const r of draftRows) all.set(r.id, r);
  for (const r of created ?? []) {
    if (!all.has(r.id)) all.set(r.id, r);
  }
  const wanted = new Set<string>(stages);
  return Array.from(all.values()).filter((row) => {
    const stage = (row.lifecycleStage ?? row.status ?? '').toLowerCase();
    if (stage === 'in_eval') return wanted.has('eval');
    if (stage === 'eval' || stage === 'review' || stage === 'draft' || stage === 'published') {
      return wanted.has(stage as 'draft' | 'eval' | 'review' | 'published');
    }
    // `status=active + publishedAt` rows look published
    if (stage === 'active') return wanted.has('published');
    return false;
  });
}

// ─── Eval run progress ────────────────────────────────────────────

export interface EvalRunStatus {
  runId: string;
  skillId: string;
  status: 'queued' | 'running' | 'finished' | 'aborted' | 'error' | string;
  passCount: number;
  failCount: number;
  testCases?: Array<{ id: string; input?: string }>;
  results?: Array<{
    id: string;
    passed: boolean;
    durationMs?: number;
    output?: string;
    error?: string;
  }>;
  agentTraceUrl?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
}

export async function fetchEvalRun(skillId: string, runId: string): Promise<EvalRunStatus | null> {
  return getJson<EvalRunStatus>(`/api/im/skills/${encodeURIComponent(skillId)}/eval/runs/${encodeURIComponent(runId)}`);
}

// ─── Metrics aggregate (release201/11) ──────────────────────────────

export interface MetricBucket {
  ts: string | null;
  groups: Array<{ groupKey: Record<string, string | null>; value: number | null }>;
}

export interface AggregateResult {
  namespace: string;
  name: string;
  agg: string;
  range: { from: string; to: string };
  buckets: MetricBucket[];
}

export interface AggregateOptions {
  namespace: string;
  name: string;
  workspaceId: string;
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p95' | 'p99';
  range?: string; // e.g. '1h' | '24h' | '7d'
  bucket?: '5m' | '1h' | '1d';
  groupBy?: string[];
  filter?: Record<string, string>;
}

/**
 * GET /api/im/metrics/aggregate — release201/11 §4-§5.
 * Returns null when the endpoint fails or workspaceId is missing (UI shows
 * empty state).
 */
export async function fetchMetricAggregate(opts: AggregateOptions): Promise<AggregateResult | null> {
  if (!opts.workspaceId) return null;
  const params = new URLSearchParams();
  params.set('namespace', opts.namespace);
  params.set('name', opts.name);
  params.set('agg', opts.agg);
  if (opts.range) params.set('range', opts.range);
  if (opts.bucket) params.set('bucket', opts.bucket);
  if (opts.groupBy && opts.groupBy.length > 0) params.set('groupBy', opts.groupBy.join(','));
  const allFilters: Record<string, string> = { workspaceId: opts.workspaceId, ...(opts.filter ?? {}) };
  const filterStr = Object.entries(allFilters)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  params.set('filter', filterStr);
  return getJson<AggregateResult>(`/api/im/metrics/aggregate?${params.toString()}`);
}

/** Single-number value from an aggregate result (no groupBy, single bucket). */
export function singleAggregateValue(result: AggregateResult | null): number {
  if (!result || !result.buckets.length) return 0;
  for (const b of result.buckets) {
    for (const g of b.groups) {
      if (typeof g.value === 'number') return g.value;
    }
  }
  return 0;
}

// ─── Skill ops — write paths (lifecycle / config) ───────────────────

export async function promoteSkill(
  skillId: string,
  to: 'eval' | 'review' | 'published' | 'archived' | 'draft',
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/im/skills/${encodeURIComponent(skillId)}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ to, reason }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface PublishSkillInput {
  scope: 'workspace' | 'org' | 'community';
  license?: string;
  changelog?: string;
  includeBoilerplateTask?: boolean;
}

export async function publishSkill(
  skillId: string,
  input: PublishSkillInput,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/im/skills/${encodeURIComponent(skillId)}/publish-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function startEvalRun(
  skillId: string,
  testCases: Array<{ id: string; input: string }> = [],
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  try {
    const res = await fetch(`/api/im/skills/${encodeURIComponent(skillId)}/eval/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ testCases }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: true, runId: data.data?.runId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function createSnapshot(
  skillId: string,
  ttlDays: number = 7,
): Promise<{ ok: boolean; snapshotUrl?: string; snapshotKey?: string; error?: string }> {
  try {
    const res = await fetch(`/api/im/skills/${encodeURIComponent(skillId)}/share/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ ttlDays }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: true, snapshotUrl: data.data?.snapshotUrl, snapshotKey: data.data?.snapshotKey };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Agent skill config update (release201/13 §3.4) ─────────────────

export async function updateAgentSkillConfig(
  agentId: string,
  skillId: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/im/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ config }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Studio evolution (capsules / genes per agent) ───────────────────

export interface StudioCapsule {
  id: string;
  title?: string;
  intent?: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface StudioGene {
  id: string;
  name?: string;
  category?: string;
  status?: string;
  createdAt?: string;
  signals_match?: unknown;
  [key: string]: unknown;
}

export interface StudioEvolutionCapsules {
  agentId: string;
  capsules: StudioCapsule[];
  total: number;
  page: number;
  limit: number;
}

export interface StudioEvolutionGenes {
  agentId: string;
  genes: StudioGene[];
  distilled: Array<{ geneId: string; skillId: string; status: string; installedAt: string }>;
}

export function fetchStudioCapsules(agentId: string, page = 1, limit = 20): Promise<StudioEvolutionCapsules | null> {
  if (!agentId) return Promise.resolve(null);
  return getJson<StudioEvolutionCapsules>(
    `/api/im/studio/evolution/capsules?agentId=${encodeURIComponent(agentId)}&page=${page}&limit=${limit}`,
  );
}

export function fetchStudioGenes(agentId: string): Promise<StudioEvolutionGenes | null> {
  if (!agentId) return Promise.resolve(null);
  return getJson<StudioEvolutionGenes>(`/api/im/studio/evolution/genes?agentId=${encodeURIComponent(agentId)}`);
}

// ─── Session memory (release201/26 Phase 3 — admin drawer) ─────────────
//
// Backend (admin-only, `user.role === 'admin'`):
//   GET  /api/im/conversations/:id/memory[?includeSuperseded=1]
//        → { ok, data: { segments, identifiers } }
//   POST /api/im/conversations/:id/memory/segments/:seq/regenerate
//        → { ok, data: { segment } }
//
// We need to distinguish 403 (non-admin) / 404 (no such conv) / empty from a
// generic failure, so these clients return a discriminated result rather than
// collapsing everything to null like getJson.

export interface MemorySegment {
  id?: string;
  segmentSeq: number;
  segmentKind: string;
  summary: string | null;
  salientFacts: string[] | null;
  coversFromCreatedAt: string | null;
  coversToCreatedAt: string | null;
  tokenCountCl100k: number | null;
  producerModel: string | null;
  producerVersion: string | null;
  supersededBy: string | null;
}

export interface MemoryIdentifier {
  identifierKind: string;
  canonicalId: string;
  displayLabel: string | null;
  updatedAt?: string;
}

export interface ConversationMemory {
  segments: MemorySegment[];
  identifiers: MemoryIdentifier[];
}

export type MemoryFetchResult =
  | { status: 'ok'; data: ConversationMemory }
  | { status: 'forbidden' }
  | { status: 'not-found' }
  | { status: 'error' };

export async function fetchConversationMemory(
  conversationId: string,
  includeSuperseded: boolean,
): Promise<MemoryFetchResult> {
  const id = conversationId.trim();
  if (!id) return { status: 'error' };
  const qs = includeSuperseded ? '?includeSuperseded=1' : '';
  try {
    const res = await fetch(`/api/im/conversations/${encodeURIComponent(id)}/memory${qs}`, {
      headers: authHeader(),
    });
    if (res.status === 403) return { status: 'forbidden' };
    if (res.status === 404) return { status: 'not-found' };
    const body = await res.json();
    if (!res.ok || !body?.ok) return { status: 'error' };
    const data = (body.data ?? {}) as Partial<ConversationMemory>;
    return {
      status: 'ok',
      data: {
        segments: Array.isArray(data.segments) ? (data.segments as MemorySegment[]) : [],
        identifiers: Array.isArray(data.identifiers) ? (data.identifiers as MemoryIdentifier[]) : [],
      },
    };
  } catch {
    return { status: 'error' };
  }
}

export type RegenerateResult =
  | { status: 'ok'; segment: MemorySegment }
  | { status: 'forbidden' }
  | { status: 'not-found' }
  | { status: 'error' };

export async function regenerateMemorySegment(
  conversationId: string,
  segmentSeq: number,
): Promise<RegenerateResult> {
  const id = conversationId.trim();
  if (!id) return { status: 'error' };
  try {
    const res = await fetch(
      `/api/im/conversations/${encodeURIComponent(id)}/memory/segments/${segmentSeq}/regenerate`,
      { method: 'POST', headers: authHeader() },
    );
    if (res.status === 403) return { status: 'forbidden' };
    if (res.status === 404) return { status: 'not-found' };
    const body = await res.json();
    if (!res.ok || !body?.ok || !body?.data?.segment) return { status: 'error' };
    return { status: 'ok', segment: body.data.segment as MemorySegment };
  } catch {
    return { status: 'error' };
  }
}

/** Generate a slug from free-form intent text. */
export function slugify(text: string): string {
  const normalized = text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (normalized) return normalized;
  let hash = 0;
  for (const char of text.trim()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `skill-${hash.toString(36).slice(0, 8) || 'draft'}`;
}
