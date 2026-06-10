/**
 * Prismer IM — TaskAcceptanceService (release201/10 rev 2 §5.1)
 *
 * Manages the `IMTask.acceptanceCriteriaJson` column + recomputes the
 * rolled-up `IMTask.acceptanceStatus` enum (§4.3):
 *
 *   none / pending / partial / passed / failed
 *
 * rev 2 哲学翻转 — cloud 不预制 verifier 实施方法。具体怎么验是 verifier
 * agent 运行时决定 (Playwright / endpoint / benchmark / LLM-judge / 人眼)。
 * cloud 只负责 dispatch (VerifierDispatchService) + 接收上报 + state +
 * recompute + SSE.
 *
 * 4 类 verifyMode (§4.1，抽象层，不指定方法):
 *   - qualitative       — 主观判断，verifier agent 自决方法
 *   - quantitative      — 客观度量，verifier agent 自决方法
 *   - agent-self-check  — assignee 自评 (反疯跑 baseline)
 *   - manual            — 人类兜底
 *
 * Unified verify entry — `verify(taskId, criterionId, { outcome, note, evidenceRefs }, actorId)`
 * 区分 actor identity:
 *   - actorId == task.assigneeId         → agent-self-check 上报
 *   - actorId == criterion.verifierAgentId → verifier-agent 上报
 *   - actorId == 人类 reviewer            → manual 上报
 *
 * Forbidden patterns (§0.2.4):
 *   - cloud-side 具体 verifier 实施 (Playwright / endpoint runner / benchmark)
 *   - log "[acceptance] recompute drift" — neutral wording
 *   - log "[task] complete without verify" — caller responsibility
 *
 * SSE (§6.5):
 *   - task.criteria.verified   { taskId, criterionId, outcome, byActorId, overallStatus }
 *   - task.acceptance.changed  { taskId, from, to }
 */

import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import { metricEmit } from './metric.service';
import { getTaskCriteriaTemplateService, type TemplateCriterion } from './task-criteria-template.service';

const log = createModuleLogger('TaskAcceptanceService');

/** rev 2 — 4 类 verifyMode 抽象层 (§3.2). 不再有 'automated'. */
export type CriterionVerifyMode = 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';

export type CriterionStatus = 'pending' | 'passed' | 'failed' | 'n/a' | 'waived';
export type CriterionOutcome = 'passed' | 'failed' | 'n/a';
export type AcceptanceOverallStatus = 'none' | 'pending' | 'partial' | 'passed' | 'failed';

export type EvidenceRef = string;

export interface EvidenceEntry {
  ref: EvidenceRef;
  crossTaskConfirmed?: boolean;
  note?: string;
}

/**
 * rev 2 criterion shape (§3.2).
 *
 * Changes from rev 1:
 *   - DROP kind (boolean/numeric/text-match — redundant w/ verifyMode)
 *   - DROP verifierKind → verifyMode (4 class abstract, no method)
 *   - DROP verifierConfig (cloud no longer runs verifier)
 *   - DROP description → expectation (semantic — markdown "what done looks like")
 *   - RENAME verifierNote → verifyOutcomeNote (free markdown — agent self-reports method+result+repro)
 *   - ADD verifierAgentId (agent routing; NULL defaults to creator agent; manual mode can be NULL)
 */
export interface Criterion {
  id: string;
  verifyMode: CriterionVerifyMode;
  expectation: string;
  verifierAgentId: string | null;
  status: CriterionStatus;
  required?: boolean;
  evidenceRefs?: Array<EvidenceRef | EvidenceEntry>;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verifyOutcomeNote?: string | null;
  waiveReason?: string | null;
  weight?: number;
}

export interface AcceptanceView {
  overall: AcceptanceOverallStatus;
  criteria: Criterion[];
  completedCount: number;
  totalCount: number;
  passRate: number; // 0..1
}

export class AcceptanceError extends Error {
  status: number;
  code: string;
  detail?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AcceptanceError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface TaskAcceptanceDeps {
  eventBusService?: {
    publish: (msg: any) => any;
  };
}

const VERIFY_MODES: CriterionVerifyMode[] = ['qualitative', 'quantitative', 'agent-self-check', 'manual'];

/**
 * rev 2 backfill: rev 1 used `verifierKind ∈ {manual, agent-self-check, automated}`
 * + `kind ∈ {boolean, numeric, text-match}`. We map rev 1 rows to rev 2:
 *   - manual            → manual
 *   - agent-self-check  → agent-self-check
 *   - automated         → quantitative (closest semantic — was usually a metric/check)
 *   - missing           → manual (safe default)
 *
 * Note: SPEC.md / TODO.md not changed (always carried as IMAsset).
 */
function rev1KindToVerifyMode(rev1: unknown): CriterionVerifyMode {
  if (typeof rev1 !== 'string') return 'manual';
  if (rev1 === 'automated') return 'quantitative';
  if (rev1 === 'agent-self-check') return 'agent-self-check';
  if (rev1 === 'manual') return 'manual';
  if (VERIFY_MODES.includes(rev1 as CriterionVerifyMode)) return rev1 as CriterionVerifyMode;
  return 'manual';
}

/**
 * §4.3 — overall acceptance status from individual criteria states.
 *
 *   - no criteria               → 'none'
 *   - all passed or n/a/waived  → 'passed'
 *   - any failed                → 'failed'
 *   - any passed                → 'partial'
 *   - otherwise                 → 'pending'
 */
export function recomputeAcceptanceStatus(criteria: Criterion[]): AcceptanceOverallStatus {
  if (!criteria || criteria.length === 0) return 'none';
  const normalised = criteria.map((c) => (c.status === 'waived' ? 'n/a' : c.status));
  if (normalised.every((s) => s === 'passed' || s === 'n/a')) return 'passed';
  if (normalised.some((s) => s === 'failed')) return 'failed';
  if (normalised.some((s) => s === 'passed')) return 'partial';
  return 'pending';
}

function makeCriterionId(): string {
  return 'c' + crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function parseCriteria(json: string | null | undefined): Criterion[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normaliseCriterion).filter((c): c is Criterion => c !== null);
  } catch (err) {
    log.warn({ err }, 'acceptanceCriteriaJson parse failed — treating as empty');
    return [];
  }
}

function normaliseCriterion(raw: unknown): Criterion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // rev 2 fields with rev 1 fallback (so existing rows parse without
  // breaking — backfill migration 442 rewrites on-disk; this guards reads
  // in the gap).
  const verifyMode: CriterionVerifyMode =
    typeof r.verifyMode === 'string'
      ? VERIFY_MODES.includes(r.verifyMode as CriterionVerifyMode)
        ? (r.verifyMode as CriterionVerifyMode)
        : rev1KindToVerifyMode(r.verifyMode)
      : rev1KindToVerifyMode(r.verifierKind);

  const expectation: string =
    typeof r.expectation === 'string' && r.expectation
      ? r.expectation
      : typeof r.description === 'string'
        ? (r.description as string)
        : '';
  if (!expectation) return null;

  const verifierAgentId: string | null =
    typeof r.verifierAgentId === 'string' && r.verifierAgentId ? (r.verifierAgentId as string) : null;

  const status = r.status as CriterionStatus | undefined;

  const verifyOutcomeNote: string | null =
    typeof r.verifyOutcomeNote === 'string'
      ? r.verifyOutcomeNote
      : typeof r.verifierNote === 'string'
        ? (r.verifierNote as string)
        : null;

  return {
    id: typeof r.id === 'string' ? r.id : makeCriterionId(),
    verifyMode,
    expectation,
    verifierAgentId,
    status: status ?? 'pending',
    required: r.required === true || r.required === undefined ? true : false,
    evidenceRefs: Array.isArray(r.evidenceRefs) ? (r.evidenceRefs as Array<EvidenceRef | EvidenceEntry>) : [],
    verifiedAt: typeof r.verifiedAt === 'string' ? r.verifiedAt : null,
    verifiedBy: typeof r.verifiedBy === 'string' ? r.verifiedBy : null,
    verifyOutcomeNote,
    waiveReason: typeof r.waiveReason === 'string' ? r.waiveReason : null,
    weight: typeof r.weight === 'number' ? r.weight : 1,
  };
}

function serialise(criteria: Criterion[]): string {
  return JSON.stringify(criteria);
}

/** Extract `asset:<id>` ids from a mixed evidence list. */
export function extractEvidenceAssetIds(
  refs: Array<EvidenceRef | EvidenceEntry> | undefined,
): { assetId: string; crossTaskConfirmed: boolean }[] {
  if (!refs || refs.length === 0) return [];
  const out: { assetId: string; crossTaskConfirmed: boolean }[] = [];
  for (const r of refs) {
    if (typeof r === 'string') {
      if (r.startsWith('asset:')) {
        out.push({ assetId: r.slice('asset:'.length), crossTaskConfirmed: false });
      }
    } else if (r && typeof r === 'object' && typeof r.ref === 'string' && r.ref.startsWith('asset:')) {
      out.push({
        assetId: r.ref.slice('asset:'.length),
        crossTaskConfirmed: r.crossTaskConfirmed === true,
      });
    }
  }
  return out;
}

export class TaskAcceptanceService {
  private deps: TaskAcceptanceDeps;
  constructor(deps: TaskAcceptanceDeps = {}) {
    this.deps = deps;
  }

  // ─── Reads ────────────────────────────────────────────────────────────

  async getAcceptance(taskId: string): Promise<AcceptanceView> {
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { acceptanceCriteriaJson: true, acceptanceStatus: true } as never,
    });
    if (!task) throw new AcceptanceError('task_not_found', `task ${taskId} not found`, 404);
    const criteria = parseCriteria((task as any).acceptanceCriteriaJson);
    const passed = criteria.filter((c) => c.status === 'passed').length;
    const total = criteria.length;
    return {
      overall: (task as any).acceptanceStatus as AcceptanceOverallStatus,
      criteria,
      completedCount: criteria.filter((c) => c.status !== 'pending').length,
      totalCount: total,
      passRate: total > 0 ? passed / total : 0,
    };
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  async addCriterion(
    taskId: string,
    input: Omit<Criterion, 'id' | 'status' | 'verifiedAt' | 'verifiedBy'>,
    actorId: string,
  ): Promise<{ task: AcceptanceView; criterion: Criterion }> {
    if (!input.verifyMode || !VERIFY_MODES.includes(input.verifyMode)) {
      throw new AcceptanceError('validation', `verifyMode must be one of ${VERIFY_MODES.join(' | ')}`);
    }
    if (!input.expectation || !input.expectation.trim()) {
      throw new AcceptanceError('validation', 'expectation is required (markdown describing the expected outcome)');
    }
    const list = await this.loadCriteria(taskId);
    const criterion: Criterion = {
      id: makeCriterionId(),
      verifyMode: input.verifyMode,
      expectation: input.expectation,
      verifierAgentId: input.verifierAgentId ?? null,
      status: 'pending',
      required: input.required ?? true,
      evidenceRefs: input.evidenceRefs ?? [],
      verifiedAt: null,
      verifiedBy: null,
      verifyOutcomeNote: null,
      weight: input.weight ?? 1,
    };
    list.push(criterion);
    const view = await this.persistAndEmit(taskId, list, { changedCriterion: criterion, actorId });
    return { task: view, criterion };
  }

  async updateCriterion(
    taskId: string,
    criterionId: string,
    patch: Partial<
      Pick<Criterion, 'expectation' | 'verifyMode' | 'verifierAgentId' | 'weight' | 'required' | 'evidenceRefs'>
    >,
    actorId: string,
  ): Promise<AcceptanceView> {
    const list = await this.loadCriteria(taskId);
    const idx = list.findIndex((c) => c.id === criterionId);
    if (idx < 0) throw new AcceptanceError('criterion_not_found', `criterion ${criterionId} not found`, 404);
    const target = list[idx]!;
    if (patch.verifyMode !== undefined && !VERIFY_MODES.includes(patch.verifyMode)) {
      throw new AcceptanceError('validation', `verifyMode must be one of ${VERIFY_MODES.join(' | ')}`);
    }
    // §0.2.3 — modifying expectation / verifyMode resets verification state.
    const significantChange =
      (patch.expectation !== undefined && patch.expectation !== target.expectation) ||
      (patch.verifyMode !== undefined && patch.verifyMode !== target.verifyMode);
    // v2.0.7.1 hotfix B6 — defensive merge. PATCH endpoint already filters
    // omitted keys, but service must also drop `undefined` values so direct
    // service callers (tests, other services) don't accidentally null out
    // fields by passing `{ verifierAgentId: undefined }`. Only fields with
    // a defined value should land in the merged object. `null` is preserved
    // intentionally for fields like `verifierAgentId` where clearing is a
    // valid update.
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<
      typeof target
    >;
    list[idx] = {
      ...target,
      ...cleanPatch,
      ...(significantChange ? { status: 'pending', verifiedAt: null, verifiedBy: null, verifyOutcomeNote: null } : {}),
    };
    return this.persistAndEmit(taskId, list, { changedCriterion: list[idx], actorId });
  }

  async removeCriterion(taskId: string, criterionId: string, actorId: string): Promise<AcceptanceView> {
    const list = await this.loadCriteria(taskId);
    const idx = list.findIndex((c) => c.id === criterionId);
    if (idx < 0) throw new AcceptanceError('criterion_not_found', `criterion ${criterionId} not found`, 404);
    list.splice(idx, 1);
    return this.persistAndEmit(taskId, list, { actorId });
  }

  // ─── Verify — unified entry (rev 2 §6.2) ─────────────────────────────

  /**
   * Unified verify entry. Replaces rev 1's `verifyManual` / `verifySelf`
   * / `verifyAutomated` trio. actor identity (resolved by caller) is used
   * for audit only — the endpoint accepts the same body shape for all
   * three callers and dispatches by who is calling.
   */
  async verify(
    taskId: string,
    criterionId: string,
    input: { outcome: CriterionOutcome | 'waived'; note?: string; evidenceRefs?: EvidenceRef[]; waiveReason?: string },
    actorId: string,
  ): Promise<AcceptanceView> {
    const list = await this.loadCriteria(taskId);
    const idx = list.findIndex((c) => c.id === criterionId);
    if (idx < 0) throw new AcceptanceError('criterion_not_found', `criterion ${criterionId} not found`, 404);
    const target = list[idx]!;
    if (input.outcome === 'waived' && !input.waiveReason) {
      throw new AcceptanceError('waive_reason_required', 'status=waived requires waiveReason', 400);
    }

    // release201/08 §0.2.3 + §0.2.4 — Reviewer ≠ ownerAgentId.
    //
    // The publish-template / promote-state guards (skill-lifecycle.service.ts
    // L246 + L698) reject self-review at the lifecycle boundary, but the
    // verify-criterion endpoint was missing the same invariant — a skill
    // owner could still individually mark each criterion on their own
    // skill-review IMTask as passed. Plug the gap at the verify boundary.
    //
    // Scope: only `capability='skill-review'` tasks carrying
    // `metadata.skillId` — other task types are unaffected. agent-self-check
    // verifyMode has its own actor identity guard (task.service.ts L2628
    // `self_check_wrong_actor` B5) and is intentionally allowed here so the
    // assignee can self-evaluate; this guard catches the **non-self-check**
    // path (qualitative / quantitative / manual) where the owner is acting
    // as reviewer.
    if (target.verifyMode !== 'agent-self-check') {
      const taskRow = (await prisma.iMTask.findUnique({
        where: { id: taskId },
        select: { capability: true, metadata: true } as never,
      })) as unknown as { capability: string | null; metadata: string | null } | null;
      if (taskRow?.capability === 'skill-review') {
        let skillId: string | null = null;
        try {
          const meta = taskRow.metadata ? JSON.parse(taskRow.metadata) : null;
          if (meta && typeof meta === 'object' && typeof (meta as any).skillId === 'string') {
            skillId = (meta as any).skillId;
          }
        } catch {
          /* swallow metadata parse errors — skill-link is best-effort */
        }
        if (skillId) {
          const skill = (await prisma.iMSkill.findUnique({
            where: { id: skillId },
            select: { ownerAgentId: true } as never,
          })) as unknown as { ownerAgentId: string | null } | null;
          if (skill?.ownerAgentId && skill.ownerAgentId === actorId) {
            throw new AcceptanceError(
              'forbidden_self_review',
              'Skill owner cannot verify criteria on their own skill-review task (release201/08 §0.2.3)',
              403,
              { taskId, criterionId, skillId, ownerAgentId: skill.ownerAgentId },
            );
          }
        }
      }
    }

    const status: CriterionStatus = input.outcome;

    // Merge new evidence refs (additive — caller cleans / replaces explicitly via update).
    let nextEvidenceRefs = target.evidenceRefs ?? [];
    if (input.evidenceRefs && input.evidenceRefs.length > 0) {
      // De-dup by string ref / .ref.
      const seen = new Set<string>();
      const merged: Array<EvidenceRef | EvidenceEntry> = [];
      for (const ref of [...(target.evidenceRefs ?? []), ...input.evidenceRefs]) {
        const key = typeof ref === 'string' ? ref : (ref as EvidenceEntry).ref;
        if (key && !seen.has(key)) {
          seen.add(key);
          merged.push(ref);
        }
      }
      nextEvidenceRefs = merged;
    }

    list[idx] = {
      ...target,
      status,
      evidenceRefs: nextEvidenceRefs,
      verifiedAt: new Date().toISOString(),
      verifiedBy: actorId,
      verifyOutcomeNote: input.note ?? null,
      waiveReason: input.waiveReason ?? target.waiveReason ?? null,
    };
    return this.persistAndEmit(taskId, list, {
      changedCriterion: list[idx],
      actorId,
      verification: { status, verifyMode: target.verifyMode },
    });
  }

  // ─── Template ─────────────────────────────────────────────────────────

  async applyTemplate(taskId: string, templateId: string, actorId: string): Promise<AcceptanceView> {
    const tpl = await getTaskCriteriaTemplateService().getById(templateId);
    if (!tpl) throw new AcceptanceError('template_not_found', `template ${templateId} not found`, 404);
    const existing = await this.loadCriteria(taskId);
    const fresh: Criterion[] = tpl.criteria.map((c: TemplateCriterion) => ({
      id: makeCriterionId(),
      verifyMode: c.verifyMode,
      expectation: c.expectation,
      verifierAgentId: c.verifierAgentId ?? null,
      status: 'pending' as CriterionStatus,
      required: c.required ?? true,
      evidenceRefs: [] as EvidenceRef[],
      verifiedAt: null,
      verifiedBy: null,
      verifyOutcomeNote: null,
      weight: c.weight ?? 1,
    }));
    const merged = [...existing, ...fresh];
    return this.persistAndEmit(taskId, merged, { actorId });
  }

  async applyDefaultTemplateOnCreate(
    taskId: string,
    capability: string | null | undefined,
    workspaceId: string | null | undefined,
    actorId: string,
  ): Promise<{ applied: boolean; templateId?: string }> {
    if (!capability) return { applied: false };
    const existing = await this.loadCriteria(taskId);
    if (existing.length > 0) return { applied: false };
    const tpl = await getTaskCriteriaTemplateService().getDefault(capability, workspaceId ?? null);
    if (!tpl) return { applied: false };
    await this.applyTemplate(taskId, tpl.id, actorId);
    return { applied: true, templateId: tpl.id };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async loadCriteria(taskId: string): Promise<Criterion[]> {
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { acceptanceCriteriaJson: true } as never,
    });
    if (!task) throw new AcceptanceError('task_not_found', `task ${taskId} not found`, 404);
    return parseCriteria((task as any).acceptanceCriteriaJson);
  }

  private async persistAndEmit(
    taskId: string,
    criteria: Criterion[],
    ctx: {
      changedCriterion?: Criterion;
      actorId: string;
      verification?: { status: CriterionStatus; verifyMode: CriterionVerifyMode };
    },
  ): Promise<AcceptanceView> {
    const overall = recomputeAcceptanceStatus(criteria);
    const before = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: {
        acceptanceStatus: true,
        workspaceId: true,
        projectId: true,
        capability: true,
        assigneeId: true,
      } as never,
    });
    if (!before) throw new AcceptanceError('task_not_found', `task ${taskId} not found`, 404);
    const previous = (before as any).acceptanceStatus as AcceptanceOverallStatus;
    await prisma.iMTask.update({
      where: { id: taskId },
      data: {
        acceptanceCriteriaJson: serialise(criteria),
        acceptanceStatus: overall,
      } as never,
    });

    const passed = criteria.filter((c) => c.status === 'passed').length;
    const view: AcceptanceView = {
      overall,
      criteria,
      completedCount: criteria.filter((c) => c.status !== 'pending').length,
      totalCount: criteria.length,
      passRate: criteria.length > 0 ? passed / criteria.length : 0,
    };

    const dims = {
      workspaceId: (before as any).workspaceId ?? '',
      taskId,
      projectId: (before as any).projectId ?? undefined,
      capability: (before as any).capability ?? 'general',
      // release201/11 §4 #5 + getAgentMetrics filter — prod path required for
      // acceptanceRate.available=true. F5 BFF queries dims.assigneeId on
      // `task.acceptance.status_changed`; absence makes acceptanceRate
      // permanently `available=false`. assigneeId is undefined for tasks
      // emitted before assignment, which is acceptable: those events simply
      // don't aggregate into any agent.
      assigneeId: (before as any).assigneeId ?? undefined,
    };
    if (ctx.verification && ctx.changedCriterion) {
      try {
        const ret = this.deps.eventBusService?.publish({
          type: 'task.criteria.verified',
          timestamp: Date.now(),
          data: {
            taskId,
            criterionId: ctx.changedCriterion.id,
            outcome: ctx.verification.status,
            verifyMode: ctx.verification.verifyMode,
            byActorId: ctx.actorId,
            overallStatus: overall,
          },
        });
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* swallow */
      }

      metricEmit({
        namespace: 'task.criteria',
        name: 'verified',
        value: ctx.verification.status,
        dims: {
          ...dims,
          criterionId: ctx.changedCriterion.id,
          verifyMode: ctx.verification.verifyMode,
        },
      });
    }

    if (previous !== overall) {
      try {
        const ret = this.deps.eventBusService?.publish({
          type: 'task.acceptance.changed',
          timestamp: Date.now(),
          data: { taskId, from: previous, to: overall },
        });
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* swallow */
      }

      metricEmit({
        namespace: 'task.acceptance',
        name: 'status_changed',
        source: 'cloud',
        value: overall,
        dims: { ...dims, acceptanceStatus: overall },
      });
    }

    return view;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _singleton: TaskAcceptanceService | null = null;
export function getTaskAcceptanceService(deps?: TaskAcceptanceDeps): TaskAcceptanceService {
  if (!_singleton) {
    _singleton = new TaskAcceptanceService(deps);
  } else if (deps?.eventBusService && !(_singleton as any).deps?.eventBusService) {
    (_singleton as any).deps = { ...((_singleton as any).deps ?? {}), eventBusService: deps.eventBusService };
  }
  return _singleton;
}

export function __setTaskAcceptanceServiceForTests(svc: TaskAcceptanceService | null): void {
  _singleton = svc;
}
