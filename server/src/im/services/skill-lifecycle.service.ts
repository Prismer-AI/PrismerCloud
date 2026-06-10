/**
 * Skill Lifecycle Service — release201/08
 *
 * State machine for the skill SOP (`draft → eval → review → published →
 * archived`). The service is the single authoritative writer of
 * `IMSkill.lifecycleStage` + `IMSkill.publishScope` + `IMSkill.status` +
 * `IMSkill.publishedAt` triples — invariants live here, not in callers.
 *
 * Design: docs/release201/08-skill-lifecycle-sop.md §2 (state machine), §3
 * (eval session protocol), §4 (publish scope), §6 (service surface), §10
 * (endpoints), §10.6 (SSE events).
 */

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import prisma from '../db';
import type { SyncService } from './sync.service';
import type { ConversationService } from './conversation.service';
import { metricEmit } from './metric.service';
import { getTaskAcceptanceService } from './task-acceptance.service';

const LOG = '[SkillLifecycleService]';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type LifecycleStage = 'draft' | 'eval' | 'review' | 'published' | 'archived';

export type PublishScope = 'private' | 'workspace' | 'org' | 'community';

/**
 * release201/08 §2.0 — 11 sub-stages mapped onto the 5 main lifecycle states.
 * Persisted in `IMSkill.metadata.lifecycleSubStage`. NOT a schema column —
 * progresses inside the metadata JSON blob so we don't add migrations for a
 * UI-only refinement.
 */
export type LifecycleSubStage =
  | 'intake' // draft.intake — createDraft entry
  | 'source_review' // draft.source_review — authoring agent ingests sources
  | 'design' // draft.design — skill.json composed
  | 'scaffold' // draft.scaffold — manifest persisted
  | 'implement' // draft.implement — patchDraft edits
  | 'static_validate' // eval.static_validate — 7 gates running
  | 'sandbox_smoke' // eval.sandbox_smoke — daemon eval session
  | 'sample_task' // eval.sample_task — sample task pending
  | 'human_review' // review.human_review — reviewer reading evidence
  | 'publish_ready' // review.publish_ready — reviewer ready to publish
  | 'published'; // published.

/**
 * release201/08 §10.7 — 7 failure subStates. Carried as
 * `payload.failureKind` on every `skill.authoring.failed` emit. NOT a schema
 * column — reused via IMSyncEvent + IMTaskEvent.payload.
 */
export type FailureKind =
  | 'needs_input'
  | 'duplicate_or_reuse'
  | 'validation_failed'
  | 'requires_unavailable'
  | 'smoke_failed'
  | 'acceptance_failed'
  | 'review_blocked';

export interface EvalTestCase {
  id: string;
  input: string;
  expectedOutputPattern?: string;
  /**
   * release201/24 §2.1 — per-criterion assertions matched against the skill's
   * dispatch output by the daemon scorer. When neither pattern nor criteria
   * are present, the daemon records the case as `inconclusive` (never an
   * auto-pass).
   */
  acceptanceCriteria?: string[];
  timeout_ms?: number;
  /** Display label (gate-7 smoke + eval UI); cosmetic, ignored by the scorer. */
  title?: string;
}

/**
 * release201/24 §3 — cloud → daemon eval push. Wired at the composition root
 * (routes.ts) over the WS reverse channel. When absent (unit tests / no
 * daemon attached), `startEvalRun` leaves the run `queued` and marks it
 * `queued_no_runner` rather than pretending it ran.
 */
export interface EvalDaemonDispatch {
  (req: {
    runId: string;
    skillId: string;
    skillSlug: string;
    skillManifest: Array<{ path: string; content?: string }>;
    allowlistBuiltins: string[];
    testCases: EvalTestCase[];
    workspaceId: string | null;
    ownerAgentId: string | null;
  }): Promise<{ accepted: boolean; daemonId?: string; reason?: string }>;
}

export interface EvalTestCaseResult {
  id: string;
  passed: boolean;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface EvalRunSummary {
  runId: string;
  skillId: string;
  status: 'queued' | 'running' | 'finished' | 'aborted' | 'error';
  passCount: number;
  failCount: number;
  testCases: EvalTestCase[];
  results?: EvalTestCaseResult[];
  daemonId?: string | null;
  agentTraceUrl?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

export interface PromoteOptions {
  to: LifecycleStage;
  actorId: string;
  reason?: string;
  /**
   * release201/08 §3.0 — optional conversation linkage. When the promote
   * target is `review`, the supplied conversation is tagged with
   * `metadata.skillDev.role='review'` so Studio Lifecycle session-links can
   * thread it from the parent business session. Other targets ignore this.
   */
  reviewConversationId?: string;
  parentConversationId?: string;
}

export interface PublishOptions {
  scope: PublishScope;
  actorId: string;
  license?: string;
  changelog?: string;
  includeBoilerplateTask?: boolean;
}

export interface MakeSnapshotResult {
  snapshotUrl: string;
  snapshotKey: string;
  expiresAt: string;
}

/**
 * release201/24 §Phase2 — auto-optimize rewrite trigger. Wired to
 * `SkillDraftService.regenerateDraft` at the composition root.
 */
export type AutoOptimizeRegenerator = (
  skillId: string,
  ownerAgentId: string,
  reason: string,
  failedCases: Array<{ id: string; error?: string }>,
) => Promise<void>;

export interface ImportSnapshotResult {
  newSkillId: string;
  importedFrom: { sourceSkillId: string; sourceWorkspaceId: string | null; importedAt: string };
}

// ───────────────────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────────────────

export class SkillLifecycleError extends Error {
  statusCode: number;
  code: string;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Transition table (§2.1)
// ───────────────────────────────────────────────────────────────────────────

/** Allowed direct transitions (only those callable through `promote()`). */
const VALID_TRANSITIONS: Record<LifecycleStage, LifecycleStage[]> = {
  draft: ['eval', 'archived'],
  eval: ['review', 'draft', 'archived'],
  review: ['published', 'draft', 'archived'],
  published: ['review', 'archived'],
  archived: [],
};

// Default eval pass rate auto-promote threshold (§2.1 row 2)
const EVAL_AUTO_PROMOTE_PASS_RATE = 0.8;

// release201/24 §Phase2 — auto-optimize loop default iteration cap.
const DEFAULT_AUTO_OPTIMIZE_MAX_ITERATIONS = 3;

/**
 * release201/24 §Phase2 — pure decision for the auto-optimize loop. Given an
 * eval pass rate, decide whether to publish (promote), regenerate (rewrite +
 * re-eval), or stop (hand back to the human). Exported for unit tests.
 */
export function decideAutoOptimize(input: {
  passRate: number;
  threshold: number;
  iteration: number;
  maxIterations: number;
  autoOptimize: boolean;
}): 'publish' | 'regenerate' | 'stop' {
  if (input.passRate >= input.threshold) return 'publish';
  if (input.autoOptimize && input.iteration < input.maxIterations) return 'regenerate';
  return 'stop';
}

/**
 * release201/08 §2.0 — when promoting between main states, the conventional
 * sub-stage to settle on. The entry sub-stage for each main state per the
 * SOP table (intake / static_validate / human_review / published).
 */
const STAGE_ENTRY_SUB_STAGE: Record<LifecycleStage, LifecycleSubStage | null> = {
  draft: 'intake',
  eval: 'static_validate',
  review: 'human_review',
  published: 'published',
  archived: null,
};

// Stage → status mapping (§0.2.3)
function statusForStage(stage: LifecycleStage): 'draft' | 'active' | 'deprecated' {
  if (stage === 'published') return 'active';
  if (stage === 'archived') return 'deprecated';
  return 'draft';
}

// ───────────────────────────────────────────────────────────────────────────
// SSE event emitter
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cloud-side SSE event topics defined by §10.6 (14 skill.authoring.* + 2
 * skill.* lifecycle events). SyncService writes one per recipient (owner
 * agent + workspace owner + reviewer when relevant); the SDK side bridges
 * these to /sync/stream.
 */
const SSE_EVENTS = {
  AUTHORING_STARTED: 'skill.authoring.started',
  AUTHORING_SOURCE_REVIEWED: 'skill.authoring.source_reviewed',
  AUTHORING_BUNDLE_SCAFFOLDED: 'skill.authoring.bundle_scaffolded',
  AUTHORING_STATE_CHANGED: 'skill.authoring.state_changed',
  AUTHORING_VALIDATION_STARTED: 'skill.authoring.validation_started',
  AUTHORING_VALIDATION_COMPLETED: 'skill.authoring.validation_completed',
  AUTHORING_SMOKE_STARTED: 'skill.authoring.smoke_started',
  AUTHORING_SMOKE_COMPLETED: 'skill.authoring.smoke_completed',
  AUTHORING_SAMPLE_TASK_STARTED: 'skill.authoring.sample_task_started',
  AUTHORING_SAMPLE_TASK_COMPLETED: 'skill.authoring.sample_task_completed',
  AUTHORING_REVIEW_REQUESTED: 'skill.authoring.review_requested',
  AUTHORING_PUBLISH_REQUESTED: 'skill.authoring.publish_requested',
  AUTHORING_PUBLISHED: 'skill.authoring.published',
  AUTHORING_FAILED: 'skill.authoring.failed',
  LIFECYCLE_CHANGED: 'skill.lifecycle.changed',
  EVAL_PROGRESS: 'skill.eval.progress',
} as const;

export type SkillSseEventType = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export class SkillLifecycleService {
  constructor(
    private readonly deps: {
      sync?: SyncService;
      conversations?: ConversationService;
      /** release201/24 §3 — push a queued eval run to a daemon over WS. */
      dispatchEvalToDaemon?: EvalDaemonDispatch;
      /**
       * release201/24 §Phase2 — auto-optimize hook. When eval pass-rate is
       * below threshold and the draft has `autoOptimize` enabled, the loop
       * calls this to trigger a real rewrite (skillDraftService.regenerateDraft)
       * carrying the failed cases. Absent in unit tests.
       */
      requestRegenerate?: AutoOptimizeRegenerator;
    } = {},
  ) {
    this.autoOptimizeRegenerator = deps.requestRegenerate;
  }

  /**
   * release201/24 §Phase2 — wire the auto-optimize rewrite trigger after
   * construction (routes.ts sets this to skillDraftService.regenerateDraft,
   * which would otherwise create a service-construction cycle).
   */
  private autoOptimizeRegenerator?: AutoOptimizeRegenerator;
  setAutoOptimizeRegenerator(fn: AutoOptimizeRegenerator): void {
    this.autoOptimizeRegenerator = fn;
  }

  /** Public alias used by tests + endpoints; SSE consumers see the typed name. */
  static readonly EVENTS = SSE_EVENTS;

  // ── Stage transitions ───────────────────────────────────────────────

  /**
   * Promote a skill from its current lifecycleStage to `to`. Validates
   * transition legality, ownership, optional reviewer-distinct invariant,
   * mirrors `status` + `publishedAt` per §0.2.3, and emits SSE.
   */
  async promote(skillId: string, opts: PromoteOptions): Promise<{ skill: any; taskId?: string }> {
    const skill = await this.requireSkill(skillId);
    const from = skill.lifecycleStage as LifecycleStage;
    const { to, actorId, reason } = opts;

    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      // release201/08 §10.7 — invalid transitions surface as
      // `acceptance_failed` (the state machine declined to accept the
      // transition; reviewer must rework before retrying).
      await this.emitAuthoringFailed(
        skill,
        'acceptance_failed',
        `${from}→${to}`,
        `cannot promote from '${from}' to '${to}'`,
        'error',
      );
      throw new SkillLifecycleError('invalid_transition', `cannot promote from '${from}' to '${to}'`, 409);
    }

    // Special validation: review → published requires reviewer ≠ ownerAgentId
    if (from === 'review' && to === 'published') {
      if (skill.ownerAgentId && actorId === skill.ownerAgentId) {
        await this.emitAuthoringFailed(
          skill,
          'review_blocked',
          'review→published',
          'reviewer must not be the owner agent (release201/08 §0.2.3)',
          'error',
        );
        throw new SkillLifecycleError(
          'self_review',
          'reviewer must not be the owner agent (release201/08 §0.2.3)',
          403,
        );
      }
    }

    // Special validation: draft → eval requires at least 1 sample task
    if (from === 'draft' && to === 'eval') {
      const meta = this.parseMetadata(skill.metadata);
      const skillJson = (meta?.skillJson as any) ?? {};
      const samples: any[] = Array.isArray(skillJson.sampleTasks) ? skillJson.sampleTasks : [];
      if (samples.length === 0) {
        await this.emitAuthoringFailed(
          skill,
          'needs_input',
          'draft→eval',
          'cannot promote to eval: at least 1 sampleTask is required (07 §2.7 gate 6)',
          'warning',
        );
        throw new SkillLifecycleError(
          'no_sample_tasks',
          'cannot promote to eval: at least 1 sampleTask is required (07 §2.7 gate 6)',
          400,
        );
      }
    }

    const nextStatus = statusForStage(to);

    // release201/08 §2.0 — settle the canonical entry sub-stage for `to` in
    // the same metadata JSON write that flips lifecycleStage. This keeps the
    // sub-stage write atomic with the main-state transition for the common
    // case (Studio pipeline rail consumes via metadata.lifecycleSubStage).
    const meta = this.parseMetadata(skill.metadata);
    const prevSubStage = (meta.lifecycleSubStage as LifecycleSubStage | undefined) ?? null;
    const newSubStage = STAGE_ENTRY_SUB_STAGE[to];
    if (newSubStage) meta.lifecycleSubStage = newSubStage;
    else delete meta.lifecycleSubStage;

    const updates: Record<string, any> = {
      lifecycleStage: to,
      status: nextStatus,
      metadata: JSON.stringify(meta),
    };

    if (to === 'published') {
      if (!skill.publishedAt) updates.publishedAt = new Date();
    }
    if (to === 'archived') {
      // Service-layer-only side-effect: unbind all IMAgentSkill rows.
      await prisma.iMAgentSkill.updateMany({
        where: { skillId: skill.id, status: 'active' },
        data: { status: 'unbound' },
      });
    }

    const updated = await prisma.iMSkill.update({
      where: { id: skillId },
      data: updates as any,
    });

    // SSE — skill.lifecycle.changed (§10.6)
    await this.emit(
      SSE_EVENTS.LIFECYCLE_CHANGED,
      {
        skillId,
        from,
        to,
        by: actorId,
        reason: reason ?? null,
        at: new Date().toISOString(),
      },
      skill,
    );

    // SSE — skill.authoring.state_changed (§10.6) for sub-stage observers.
    // Emitted on every main-state promotion (the sub-stage settles too) and
    // additionally by setLifecycleSubStage for intra-state transitions.
    if (newSubStage && newSubStage !== prevSubStage) {
      await this.emit(
        SSE_EVENTS.AUTHORING_STATE_CHANGED,
        {
          draftId: skill.id,
          skillId: skill.id,
          prevSubStage,
          newSubStage,
          reason: `promote ${from}→${to}`,
          at: new Date().toISOString(),
        },
        skill,
      );
    }

    // Create the lifecycle-stage IMTask (mirrors §2.1 "副作用" column)
    let taskId: string | undefined;
    if (to === 'eval') {
      taskId = await this.createLifecycleTask(skill, actorId, 'skill-eval', `Eval session pending for '${skill.slug}'`);
      // release201/08 §10.6 — validation_started is the first concrete
      // sub-stage event after entering eval (static_validate). The
      // companion validation_completed fires after gate result resolution
      // by upstream callers (skill-draft.service emits at createDraft after
      // running the 7 gates).
      await this.emit(
        SSE_EVENTS.AUTHORING_VALIDATION_STARTED,
        {
          draftId: skill.id,
          skillId: skill.id,
          gates: ['manifest', 'frontmatter', 'package', 'requires', 'security', 'sample', 'runtime'],
          at: new Date().toISOString(),
        },
        skill,
      );
    } else if (to === 'review') {
      // Auto-assign to workspace owner (different from ownerAgent).
      taskId = await this.createLifecycleTask(
        skill,
        actorId,
        'skill-review',
        `Skill '${skill.slug}' awaiting human review`,
      );
      await this.emit(
        SSE_EVENTS.AUTHORING_REVIEW_REQUESTED,
        {
          draftId: skill.id,
          skillId: skill.id,
          reviewerUserId: skill.workspaceId, // workspace owner resolution happens client-side
        },
        skill,
      );
      // release201/08 §3.0 — tag the review conversation (when callers
      // thread one through). 4 session-role plumbing (business / dev / test
      // / review) lives on `conversation.metadata.skillDev.role`.
      if (opts.reviewConversationId && this.deps.conversations) {
        try {
          await this.deps.conversations.setSkillDevRole(opts.reviewConversationId, skill.id, 'review', {
            parentConversationId: opts.parentConversationId,
          });
        } catch (cErr) {
          console.warn(`${LOG} tag review conversation failed: ${(cErr as Error).message}`);
        }
      }
    } else if (to === 'archived') {
      // release201/08 §10.7 — archive is an explicit terminal failure
      // surface; classify under `acceptance_failed` when no other context
      // applies (final state for review/eval that won't progress).
      await this.emitAuthoringFailed(skill, 'acceptance_failed', 'archived', reason ?? 'archived by owner', 'info');
    }

    console.log(
      `${LOG} promoted ${skillId.slice(-8)} ${from} → ${to} by ${actorId.slice(-8)}${reason ? ` (${reason})` : ''}`,
    );
    return { skill: updated, taskId };
  }

  /**
   * Owner-requested revoke: published → review. The skill becomes
   * invisible to new installs; existing IMAgentSkill rows are NOT unbound
   * (revoke ≠ archive). Cloud emits skill.lifecycle.changed so daemons can
   * mark their skill-sync state.
   */
  async revoke(skillId: string, actorId: string, reason: string): Promise<{ skill: any }> {
    return this.promote(skillId, { to: 'review', actorId, reason: `revoke: ${reason}` }).then((r) => ({
      skill: r.skill,
    }));
  }

  /** Terminal-state transition. */
  async archive(skillId: string, actorId: string, reason: string): Promise<{ skill: any }> {
    const { skill } = await this.promote(skillId, { to: 'archived', actorId, reason });
    return { skill };
  }

  // ── Eval runs ───────────────────────────────────────────────────────

  /**
   * Create a queued eval run. Daemon-side EvalSessionRunner picks it up via
   * the dispatch / WS channel (S4 wires the daemon end). For the cloud unit
   * tests + Phase 1 of the doc, callers can manually finish via
   * `recordEvalFinish` to exercise the auto-promote path.
   */
  async startEvalRun(
    skillId: string,
    testCases: EvalTestCase[],
    actorId: string,
    options: {
      allowlistBuiltins?: string[];
      /**
       * release201/08 §3.0 — optional conversation owning the eval session
       * (daemon eval-session HOME). Tagged with `metadata.skillDev.role='test'`
       * so Studio session-links can thread it from the parent business
       * session.
       */
      testConversationId?: string;
      parentConversationId?: string;
    } = {},
  ): Promise<EvalRunSummary> {
    const skill = await this.requireSkill(skillId);
    if (skill.lifecycleStage !== 'eval' && skill.lifecycleStage !== 'draft') {
      throw new SkillLifecycleError(
        'wrong_stage_for_eval',
        `cannot start eval run when lifecycleStage='${skill.lifecycleStage}'`,
        409,
      );
    }
    if (!Array.isArray(testCases) || testCases.length === 0) {
      throw new SkillLifecycleError('no_test_cases', 'testCases must be non-empty', 400);
    }
    // If the skill is still in draft, advance to eval first (single hop).
    if (skill.lifecycleStage === 'draft') {
      await this.promote(skillId, { to: 'eval', actorId, reason: 'auto-promote on startEvalRun' });
    }

    const runId = `er_${this.shortId()}`;
    const row = await (prisma as any).iMSkillEvalRun.create({
      data: {
        id: runId,
        skillId,
        status: 'queued',
        passCount: 0,
        failCount: 0,
        testCasesJson: JSON.stringify({
          allowlistBuiltins: options.allowlistBuiltins ?? ['tasks'],
          testCases,
        }),
      },
    });

    // release201/08 §2.0 — eval session transitions sub-stage from
    // static_validate → sandbox_smoke at startEvalRun. The skill row was
    // reloaded above (via requireSkill); pass it to avoid a second lookup.
    await this.setLifecycleSubStage(skill, 'sandbox_smoke', `startEvalRun ${runId}`);

    // release201/08 §3.0 — tag the test session (eval-session daemon HOME)
    // when caller supplies one. 4 session-role plumbing.
    if (options.testConversationId && this.deps.conversations) {
      try {
        await this.deps.conversations.setSkillDevRole(options.testConversationId, skillId, 'test', {
          parentConversationId: options.parentConversationId,
        });
      } catch (cErr) {
        console.warn(`${LOG} tag test conversation failed: ${(cErr as Error).message}`);
      }
    }

    await this.emit(
      SSE_EVENTS.AUTHORING_SMOKE_STARTED,
      {
        runId,
        draftId: skillId,
      },
      skill,
    );

    // release201/24 §3 — push the queued run to a daemon over the WS reverse
    // channel. Fire-and-forget: the daemon runs the skill in an isolated HOME
    // and POSTs results to /eval/runs/:runId/finish. When no dispatcher is
    // wired (unit tests) or no daemon accepts, the row stays `queued` and we
    // tag it `queued_no_runner` so the UI does NOT show it as passing.
    if (this.deps.dispatchEvalToDaemon) {
      const manifestFiles = this.extractManifestFiles(skill);
      void this.deps
        .dispatchEvalToDaemon({
          runId,
          skillId,
          skillSlug: skill.slug,
          skillManifest: manifestFiles,
          allowlistBuiltins: options.allowlistBuiltins ?? ['tasks'],
          testCases,
          workspaceId: skill.workspaceId ?? null,
          ownerAgentId: skill.ownerAgentId ?? null,
        })
        .then(async (res) => {
          if (res.accepted) {
            await this.markEvalRunRunning(runId, res.daemonId).catch(() => {});
          } else {
            await this.markEvalRunQueuedNoRunner(runId, res.reason ?? 'no daemon accepted').catch(() => {});
          }
        })
        .catch(async (err) => {
          await this.markEvalRunQueuedNoRunner(runId, (err as Error).message).catch(() => {});
        });
    } else {
      await this.markEvalRunQueuedNoRunner(runId, 'no daemon dispatcher wired').catch(() => {});
    }

    console.log(`${LOG} startEvalRun ${runId} skill=${skillId.slice(-8)} cases=${testCases.length}`);
    return this.summarizeRun(row);
  }

  /** Fetch a single eval run by id. */
  async getEvalRun(runId: string): Promise<EvalRunSummary | null> {
    const row = await (prisma as any).iMSkillEvalRun.findUnique({ where: { id: runId } });
    if (!row) return null;
    return this.summarizeRun(row);
  }

  /**
   * Mark an eval run started; idempotent. Daemons call this when they pick
   * up a queued run (or cloud may call it directly during unit tests).
   */
  async markEvalRunRunning(runId: string, daemonId?: string): Promise<void> {
    await (prisma as any).iMSkillEvalRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        startedAt: new Date(),
        ...(daemonId ? { daemonId } : {}),
      },
    });
  }

  /**
   * release201/24 §3 — no daemon picked up the run. We keep the row `queued`
   * (so a daemon may still claim it on a later resync) but stamp the reason
   * into `resultsJson` so the UI can surface `queued_no_runner` honestly
   * instead of an indefinite spinner or a fake pass.
   */
  async markEvalRunQueuedNoRunner(runId: string, reason: string): Promise<void> {
    await (prisma as any).iMSkillEvalRun
      .update({
        where: { id: runId },
        data: {
          status: 'queued',
          resultsJson: JSON.stringify({ queuedNoRunner: true, reason, at: new Date().toISOString() }),
        },
      })
      .catch(() => {});
    console.warn(`${LOG} eval run ${runId} queued_no_runner: ${reason}`);
  }

  /**
   * release201/07 gate-7 + release201/24 §3 honesty — dispatch a gate-7
   * sandbox smoke run (created by SkillDraftService.runGate7Smoke) to the owner
   * agent's bound daemon, mirroring startEvalRun's dispatch tail. Without this
   * the gate-7 row sits `queued` with `resultsJson=null` forever — the
   * forbidden "permanent queued" pattern (cookbook §5). Here the run either
   * executes on a bound daemon (→ running → finish) or is honestly stamped
   * `queued_no_runner`. Returns the dispatch outcome so the caller can record
   * an accurate validation warning.
   */
  async dispatchSmokeRun(args: {
    runId: string;
    skill: any;
    testCases: EvalTestCase[];
    allowlistBuiltins: string[];
  }): Promise<{ accepted: boolean; daemonId?: string; reason?: string }> {
    const { runId, skill, testCases, allowlistBuiltins } = args;
    if (!this.deps.dispatchEvalToDaemon) {
      await this.markEvalRunQueuedNoRunner(runId, 'no daemon dispatcher wired').catch(() => {});
      return { accepted: false, reason: 'no daemon dispatcher wired' };
    }
    try {
      const res = await this.deps.dispatchEvalToDaemon({
        runId,
        skillId: skill.id,
        skillSlug: skill.slug,
        skillManifest: this.extractManifestFiles(skill),
        allowlistBuiltins,
        testCases,
        workspaceId: skill.workspaceId ?? null,
        ownerAgentId: skill.ownerAgentId ?? null,
      });
      if (res.accepted) {
        await this.markEvalRunRunning(runId, res.daemonId).catch(() => {});
      } else {
        await this.markEvalRunQueuedNoRunner(runId, res.reason ?? 'no daemon accepted').catch(() => {});
      }
      return res;
    } catch (err) {
      const reason = (err as Error).message;
      await this.markEvalRunQueuedNoRunner(runId, reason).catch(() => {});
      return { accepted: false, reason };
    }
  }

  /**
   * release201/24 §3 — turn a persisted skill row's `contentManifest` into the
   * `{ path, content }[]` shape the daemon EvalSessionRunner writes into the
   * isolated eval HOME.
   */
  /** release201/24 §Phase2 — parse `metadata.authoring` from a skill row. */
  private readAuthoringMeta(skill: any): Record<string, any> {
    let meta: any = {};
    try {
      meta = typeof skill?.metadata === 'string' ? JSON.parse(skill.metadata) : skill?.metadata ?? {};
    } catch {
      meta = {};
    }
    return (meta.authoring as Record<string, any>) ?? {};
  }

  /**
   * release201/24 §Phase2 — attach an eval pass-rate sample to the current
   * manifest revision's entry in `metadata.authoring.draftRevisionHistory`,
   * so the Studio success-rate curve can plot per-revision improvement. If no
   * entry exists for the current revision (eg. first eval on the original
   * draft), append one.
   */
  private async recordRevisionPassRate(skill: any, runId: string, passRate: number): Promise<void> {
    let meta: any = {};
    try {
      meta = typeof skill?.metadata === 'string' ? JSON.parse(skill.metadata) : skill?.metadata ?? {};
    } catch {
      meta = {};
    }
    const authoring = (meta.authoring as Record<string, any>) ?? {};
    const history: any[] = Array.isArray(authoring.draftRevisionHistory) ? authoring.draftRevisionHistory : [];
    const rev = skill?.contentManifestRevision ?? null;
    const rounded = Math.round(passRate * 1000) / 1000;
    const at = new Date().toISOString();

    const existing = rev ? history.find((h) => h && h.revision === rev) : undefined;
    if (existing) {
      existing.passRate = rounded;
      existing.evalRunId = runId;
      existing.evaluatedAt = at;
    } else {
      history.push({ revision: rev, passRate: rounded, evalRunId: runId, evaluatedAt: at });
    }
    meta.authoring = { ...authoring, draftRevisionHistory: history };
    await prisma.iMSkill.update({ where: { id: skill.id }, data: { metadata: JSON.stringify(meta) } });
  }

  /** release201/24 §Phase2 — persist the auto-optimize iteration counter. */
  private async bumpAutoOptimizeIteration(skill: any, iteration: number): Promise<void> {
    let meta: any = {};
    try {
      meta = typeof skill?.metadata === 'string' ? JSON.parse(skill.metadata) : skill?.metadata ?? {};
    } catch {
      meta = {};
    }
    const authoring = (meta.authoring as Record<string, any>) ?? {};
    meta.authoring = { ...authoring, autoOptimizeIteration: iteration };
    await prisma.iMSkill.update({ where: { id: skill.id }, data: { metadata: JSON.stringify(meta) } });
  }

  private extractManifestFiles(skill: any): Array<{ path: string; content?: string }> {
    const raw = skill?.contentManifest;
    let parsed: any = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    // release201/24 §Phase2 — contentManifest is persisted as a BARE ARRAY of
    // files (`[{ path, content }, ...]`); older call sites assumed an object
    // wrapper (`{ files: [...] }`). Accept both, else the eval ships an empty
    // skill manifest and every dispatch fails ("skill doesn't exist on disk").
    const files = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.files) ? parsed.files : [];
    return files
      .filter((f: any) => f && typeof f.path === 'string')
      .map((f: any) => ({
        path: f.path as string,
        content:
          typeof f.content === 'string'
            ? f.content
            : typeof f.contentBase64 === 'string'
              ? f.contentBase64
              : undefined,
      }));
  }

  /**
   * Record the final per-case results of an eval run and, when pass rate
   * passes the threshold, auto-promote the skill from eval → review.
   */
  async recordEvalFinish(
    runId: string,
    payload: {
      results: EvalTestCaseResult[];
      agentTraceUrl?: string;
      actorId?: string;
    },
  ): Promise<{ run: EvalRunSummary; autoPromoted: boolean }> {
    const row = await (prisma as any).iMSkillEvalRun.findUnique({ where: { id: runId } });
    if (!row) throw new SkillLifecycleError('eval_run_not_found', `eval run ${runId} not found`, 404);
    const passCount = payload.results.filter((r) => r.passed).length;
    const failCount = payload.results.length - passCount;
    const updated = await (prisma as any).iMSkillEvalRun.update({
      where: { id: runId },
      data: {
        status: 'finished',
        finishedAt: new Date(),
        passCount,
        failCount,
        resultsJson: JSON.stringify(payload.results),
        ...(payload.agentTraceUrl ? { agentTraceUrl: payload.agentTraceUrl } : {}),
      },
    });

    const skill = await this.requireSkill(row.skillId);
    await this.emit(
      SSE_EVENTS.AUTHORING_SMOKE_COMPLETED,
      {
        runId,
        draftId: skill.id,
        passed: failCount === 0,
        passCount,
        failCount,
      },
      skill,
    );

    // release201/08 §10.6 — validation_completed is the eval-run analogue of
    // the static-validate completed event (the per-case results are the
    // "gates" of the runtime gate). Surfaced even on partial failure so the
    // UI's gates panel always closes.
    await this.emit(
      SSE_EVENTS.AUTHORING_VALIDATION_COMPLETED,
      {
        draftId: skill.id,
        skillId: skill.id,
        runId,
        gates: payload.results.map((r) => ({ name: r.id, status: r.passed ? 'pass' : 'fail' })),
        failedGates: payload.results.filter((r) => !r.passed).map((r) => r.id),
        at: new Date().toISOString(),
      },
      skill,
    );

    // release201/08 §10.7 — surface `smoke_failed` whenever any case failed
    // so the UI's failure card path lights up alongside the standard
    // SMOKE_COMPLETED progress event.
    if (failCount > 0) {
      await this.emitAuthoringFailed(
        skill,
        'smoke_failed',
        'sandbox_smoke',
        `${failCount}/${passCount + failCount} eval cases failed`,
        passCount === 0 ? 'error' : 'warning',
      );
    }

    // release201/11 §4 #9 — emit skill.eval.run_finished metric. The value is
    // a string enum 'pass' | 'fail' per registry; passCount/failCount are
    // captured as dims so dashboards can compute aggregate pass-rate.
    try {
      metricEmit({
        namespace: 'skill.eval',
        name: 'run_finished',
        value: failCount === 0 && passCount > 0 ? 'pass' : 'fail',
        dims: {
          workspaceId: skill.workspaceId ?? '',
          skillId: skill.id,
          runId,
          passCount: String(passCount),
          failCount: String(failCount),
        },
      });
    } catch (mErr) {
      console.warn(`${LOG} metric skill.eval.run_finished failed:`, (mErr as Error).message);
    }

    let autoPromoted = false;
    if (passCount + failCount > 0) {
      const passRate = passCount / (passCount + failCount);

      // release201/24 §Phase2 — persist per-revision passRate so the Studio
      // success-rate curve can plot improvement across regenerate iterations.
      await this.recordRevisionPassRate(skill, runId, passRate).catch((e) =>
        console.warn(`${LOG} recordRevisionPassRate failed: ${(e as Error).message}`),
      );

      const authoring = this.readAuthoringMeta(skill);
      const autoOptimize = authoring.autoOptimize === true;
      const maxIterations =
        typeof authoring.maxIterations === 'number' ? authoring.maxIterations : DEFAULT_AUTO_OPTIMIZE_MAX_ITERATIONS;
      const iteration = typeof authoring.autoOptimizeIteration === 'number' ? authoring.autoOptimizeIteration : 0;

      const decision = decideAutoOptimize({
        passRate,
        threshold: EVAL_AUTO_PROMOTE_PASS_RATE,
        iteration,
        maxIterations,
        autoOptimize,
      });

      if (decision === 'publish' && skill.lifecycleStage === 'eval') {
        await this.promote(skill.id, {
          to: 'review',
          actorId: payload.actorId ?? skill.ownerAgentId ?? 'system',
          reason: `auto-promote: eval pass rate ${(passRate * 100).toFixed(0)}%`,
        });
        autoPromoted = true;
      } else if (decision === 'regenerate' && skill.ownerAgentId && this.autoOptimizeRegenerator) {
        // Below threshold + auto-optimize on + under cap → trigger a real
        // rewrite of the failing files, then a fresh eval can re-run.
        const failedCases = payload.results
          .filter((r) => !r.passed)
          .map((r) => ({ id: r.id, error: r.error }));
        await this.bumpAutoOptimizeIteration(skill, iteration + 1).catch(() => {});
        await this.autoOptimizeRegenerator(
            skill.id,
            skill.ownerAgentId,
            `auto-optimize iteration ${iteration + 1}: eval pass rate ${(passRate * 100).toFixed(0)}% < ${(
              EVAL_AUTO_PROMOTE_PASS_RATE * 100
            ).toFixed(0)}%`,
            failedCases,
          )
          .catch((e) => console.warn(`${LOG} auto-optimize regenerate failed: ${(e as Error).message}`));
        console.log(
          `${LOG} auto-optimize iteration ${iteration + 1}/${maxIterations} for skill=${skill.id.slice(-8)} (passRate=${(
            passRate * 100
          ).toFixed(0)}%)`,
        );
      }
      // decision === 'stop' → leave at eval; smoke_failed already emitted so
      // the human can review and decide manually (bypass / manual regenerate).
    }

    return { run: this.summarizeRun(updated), autoPromoted };
  }

  /**
   * SSE incremental update for in-flight runs (called per case finished).
   */
  async emitEvalProgress(
    runId: string,
    payload: { passCount: number; failCount: number; currentCase?: string },
  ): Promise<void> {
    const row = await (prisma as any).iMSkillEvalRun.findUnique({ where: { id: runId } });
    if (!row) return;
    const skill = await prisma.iMSkill.findUnique({ where: { id: row.skillId } });
    if (!skill) return;
    await this.emit(
      SSE_EVENTS.EVAL_PROGRESS,
      {
        runId,
        skillId: row.skillId,
        passCount: payload.passCount,
        failCount: payload.failCount,
        currentCase: payload.currentCase ?? null,
      },
      skill,
    );
  }

  // ── Publish + sample-task + README (§8) ─────────────────────────────

  /**
   * Reviewer-driven publish. Performs review → published promotion plus
   * downstream side-effects: README.md auto-gen and boilerplate task.
   */
  async publish(
    skillId: string,
    opts: PublishOptions,
  ): Promise<{
    skill: any;
    sampleTaskId?: string;
    readmeFileId?: string;
  }> {
    const skill = await this.requireSkill(skillId);
    if (skill.lifecycleStage !== 'review') {
      throw new SkillLifecycleError(
        'wrong_stage_for_publish',
        `skill must be at lifecycleStage='review' to publish (got '${skill.lifecycleStage}')`,
        409,
      );
    }
    if (!['private', 'workspace', 'org', 'community'].includes(opts.scope)) {
      throw new SkillLifecycleError('invalid_scope', `unknown scope '${opts.scope}'`, 400);
    }
    if (opts.scope === 'private') {
      throw new SkillLifecycleError(
        'invalid_scope',
        "cannot publish at scope='private' — promote to archived instead, or pick workspace/org/community",
        400,
      );
    }
    if (skill.ownerAgentId && opts.actorId === skill.ownerAgentId) {
      throw new SkillLifecycleError('self_review', 'reviewer must not be the owner agent (release201/08 §0.2.3)', 403);
    }
    if (!skill.license || skill.license.trim().length === 0) {
      throw new SkillLifecycleError('license_required', 'license is required before publish', 400);
    }

    // release201/08 §2.0 — settle sub-stage to `publish_ready` before
    // executing the main-state promotion. Studio Lifecycle rail uses this
    // to render the "Approve & Publish" button armed state.
    await this.setLifecycleSubStage(skill, 'publish_ready', 'publish entry');

    // Emit publish_requested → run promote → emit published
    await this.emit(
      SSE_EVENTS.AUTHORING_PUBLISH_REQUESTED,
      {
        draftId: skill.id,
        scope: opts.scope,
      },
      skill,
    );

    const promoted = await this.promote(skillId, {
      to: 'published',
      actorId: opts.actorId,
      reason: 'reviewer approved',
    });
    const updates: Record<string, any> = { publishScope: opts.scope };
    if (opts.license) updates.license = opts.license;
    if (opts.changelog) updates.changelog = opts.changelog;
    const finalSkill = await prisma.iMSkill.update({
      where: { id: skillId },
      data: updates as any,
    });

    await this.emit(
      SSE_EVENTS.AUTHORING_PUBLISHED,
      {
        skillId,
        scope: opts.scope,
        publishedAt: finalSkill.publishedAt?.toISOString(),
      },
      skill,
    );

    // release201/11 §4 #8 — emit skill.published metric. workspaceId/skillId/
    // publishScope are the required dims (per metric-registry).
    try {
      metricEmit({
        namespace: 'skill',
        name: 'published',
        value: 1,
        dims: {
          workspaceId: finalSkill.workspaceId ?? '',
          skillId,
          publishScope: opts.scope,
        },
      });
    } catch (mErr) {
      console.warn(`${LOG} metric skill.published failed:`, (mErr as Error).message);
    }

    // README + sample task auto-gen — `private` is already rejected above
    // (only workspace/org/community reach here).
    let sampleTaskId: string | undefined;
    let readmeFileId: string | undefined;
    if (opts.includeBoilerplateTask !== false) {
      sampleTaskId = await this.createBoilerplateTask(finalSkill, opts.actorId);
      readmeFileId = await this.writeReadmeAsset(finalSkill);
      // release201/08 §10.6 — sample_task_started fires the moment we create
      // the boilerplate IMTask (it lives in pending until the user / agent
      // runs through it; task.service.completeTask emits the companion
      // sample_task_completed event when it transitions to completed). We
      // also surface the canonical `sample_task` sub-stage label so Studio
      // pipeline rail tracks it even though the main lifecycle has already
      // advanced to `published`.
      if (sampleTaskId) {
        await this.setLifecycleSubStage(finalSkill, 'sample_task', `publish boilerplate ${sampleTaskId}`);
        await this.emit(
          SSE_EVENTS.AUTHORING_SAMPLE_TASK_STARTED,
          {
            runId: sampleTaskId,
            draftId: finalSkill.id,
            skillId: finalSkill.id,
            sampleTaskId,
          },
          finalSkill,
        );
      }
    }

    void promoted;
    return { skill: finalSkill, sampleTaskId, readmeFileId };
  }

  /**
   * release201/08 §10.6 — companion event to AUTHORING_SAMPLE_TASK_STARTED.
   * Invoked from TaskService.completeTask when a `capability='skill-tryout'`
   * task reaches `completed` so the Studio Lifecycle rail closes the
   * sample-task lane. Idempotent: if the skill is not found, no-op.
   */
  async notifySampleTaskCompleted(args: {
    skillId: string;
    sampleTaskId: string;
    passed: boolean;
    evidenceAssetIds?: string[];
  }): Promise<void> {
    const skill = await prisma.iMSkill.findUnique({ where: { id: args.skillId } }).catch(() => null);
    if (!skill) {
      console.warn(`${LOG} notifySampleTaskCompleted: skill ${args.skillId} not found`);
      return;
    }
    await this.emit(
      SSE_EVENTS.AUTHORING_SAMPLE_TASK_COMPLETED,
      {
        runId: args.sampleTaskId,
        draftId: skill.id,
        skillId: skill.id,
        sampleTaskId: args.sampleTaskId,
        passed: args.passed,
        evidenceAssetIds: args.evidenceAssetIds ?? [],
        at: new Date().toISOString(),
      },
      skill,
    );
    if (!args.passed) {
      await this.emitAuthoringFailed(
        skill,
        'acceptance_failed',
        'sample_task',
        `sample task ${args.sampleTaskId} did not pass acceptance`,
        'warning',
      );
    }
  }

  // ── Snapshot + import (§4.3) ────────────────────────────────────────

  /**
   * Generate a presigned snapshot URL + one-time snapshotKey. Snapshot
   * metadata is appended to IMSkill.metadata.shareSnapshots[]; the actual
   * upload uses the S3 path referenced by §A.7 D24=D. For local-dev /
   * test environments without S3, the URL falls back to a synthetic
   * `prismer-snapshot://` scheme so cookbooks can still verify the flow.
   */
  async makeSnapshot(skillId: string, actorId: string, ttlDays = 7): Promise<MakeSnapshotResult> {
    const skill = await this.requireSkill(skillId);
    if (skill.lifecycleStage !== 'published') {
      throw new SkillLifecycleError(
        'wrong_stage_for_snapshot',
        `only published skills can be snapshotted (got '${skill.lifecycleStage}')`,
        409,
      );
    }
    const snapshotId = `snap_${this.shortId()}`;
    const snapshotKey = randomBytes(16).toString('hex'); // 32 chars
    const snapshotKeyHash = createHash('sha256').update(snapshotKey).digest('hex');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    // In local-first dev, expose a synthetic URL; production should swap to
    // the S3 presigned URL emitter (out of scope for this service).
    const snapshotUrl = `prismer-snapshot://${snapshotId}`;

    const meta = this.parseMetadata(skill.metadata);
    const existing = Array.isArray(meta.shareSnapshots) ? (meta.shareSnapshots as any[]) : [];
    existing.push({
      snapshotId,
      keyHash: snapshotKeyHash,
      consumed: false,
      revoked: false,
      createdAt: new Date().toISOString(),
      createdBy: actorId,
      expiresAt,
    });
    meta.shareSnapshots = existing;
    await prisma.iMSkill.update({
      where: { id: skillId },
      data: { metadata: JSON.stringify(meta) },
    });

    return { snapshotUrl, snapshotKey, expiresAt };
  }

  /**
   * release201/19 D6 — owner-only revoke of a previously-issued snapshot.
   * doc 08 §4.3 lists `revoked` as a snapshot row invariant (importSnapshot
   * already returns 410 snapshot_revoked when the flag is set) but until
   * v2.0.8 there was no HTTP path to flip it. Only the skill's
   * ownerAgentId (the actor that issued the snapshot) can revoke; anyone
   * else gets 403. Idempotent: revoking a non-existent / already-revoked
   * snapshot returns the current row state without throwing.
   */
  async revokeSnapshot(
    skillId: string,
    snapshotId: string,
    actorId: string,
  ): Promise<{ snapshotId: string; revoked: true; revokedAt: string }> {
    const skill = await this.requireSkill(skillId);
    // Only the original owner can revoke. Mirrors the makeSnapshot
    // permission posture (createdBy=actorId on mint).
    if (skill.ownerAgentId && actorId !== skill.ownerAgentId) {
      throw new SkillLifecycleError(
        'snapshot_revoke_forbidden',
        'only the skill owner can revoke a share snapshot',
        403,
      );
    }
    const meta = this.parseMetadata(skill.metadata);
    const list = Array.isArray(meta.shareSnapshots) ? (meta.shareSnapshots as any[]) : [];
    const target = list.find((s: any) => s?.snapshotId === snapshotId);
    if (!target) {
      throw new SkillLifecycleError('snapshot_not_found', `snapshot ${snapshotId} not found`, 404);
    }
    const revokedAt = target.revokedAt ?? new Date().toISOString();
    target.revoked = true;
    target.revokedAt = revokedAt;
    target.revokedBy = target.revokedBy ?? actorId;
    meta.shareSnapshots = list;
    await prisma.iMSkill.update({
      where: { id: skillId },
      data: { metadata: JSON.stringify(meta) },
    });
    return { snapshotId, revoked: true, revokedAt };
  }

  /**
   * Import a snapshot into a target workspace. snapshotKey is consumed
   * (marked `consumed=true` on the source row) — re-use is rejected.
   */
  async importSnapshot(
    snapshotUrl: string,
    snapshotKey: string,
    targetWorkspaceId: string,
    actorId: string,
  ): Promise<ImportSnapshotResult> {
    if (!snapshotUrl.startsWith('prismer-snapshot://')) {
      throw new SkillLifecycleError('invalid_snapshot_url', 'snapshotUrl must use prismer-snapshot:// scheme', 400);
    }
    const snapshotId = snapshotUrl.replace('prismer-snapshot://', '');
    const candidates = await prisma.iMSkill.findMany({
      where: { metadata: { contains: snapshotId } },
      take: 5,
    });
    let sourceSkill: any = null;
    let snapshotRow: any = null;
    for (const c of candidates) {
      const m = this.parseMetadata(c.metadata);
      const snaps = Array.isArray(m.shareSnapshots) ? (m.shareSnapshots as any[]) : [];
      const row = snaps.find((s: any) => s.snapshotId === snapshotId);
      if (row) {
        sourceSkill = c;
        snapshotRow = row;
        break;
      }
    }
    if (!sourceSkill || !snapshotRow) {
      throw new SkillLifecycleError('snapshot_not_found', 'snapshot does not exist or was revoked', 404);
    }
    if (snapshotRow.revoked) {
      throw new SkillLifecycleError('snapshot_revoked', 'snapshot has been revoked by the source owner', 410);
    }
    if (snapshotRow.consumed) {
      throw new SkillLifecycleError('snapshot_reused', 'snapshotKey is one-time-use and already consumed', 410);
    }
    if (new Date(snapshotRow.expiresAt).getTime() <= Date.now()) {
      throw new SkillLifecycleError('snapshot_expired', 'snapshot has expired', 410);
    }
    const expectedHash = createHash('sha256').update(snapshotKey).digest('hex');
    if (expectedHash !== snapshotRow.keyHash) {
      throw new SkillLifecycleError('invalid_snapshot_key', 'snapshotKey verification failed', 403);
    }

    // Copy the IMSkill row into the target workspace with importedFrom metadata.
    const newSlug = `${sourceSkill.slug}-import-${this.shortId(4)}`;
    const newMetadata = this.parseMetadata(sourceSkill.metadata);
    newMetadata.importedFrom = {
      sourceSkillId: sourceSkill.id,
      sourceWorkspaceId: sourceSkill.workspaceId ?? null,
      importedAt: new Date().toISOString(),
      importedBy: actorId,
    };
    delete newMetadata.shareSnapshots; // do NOT carry source's snapshot list forward.

    const newSkill = await prisma.iMSkill.create({
      data: {
        slug: newSlug,
        name: sourceSkill.name,
        description: sourceSkill.description,
        category: sourceSkill.category,
        tags: sourceSkill.tags ?? '[]',
        author: sourceSkill.author,
        source: 'community',
        sourceUrl: sourceSkill.sourceUrl ?? '',
        sourceId: `import:${sourceSkill.slug}`,
        content: sourceSkill.content,
        contentManifest: sourceSkill.contentManifest,
        contentManifestRevision: sourceSkill.contentManifestRevision,
        license: sourceSkill.license,
        compatibility: sourceSkill.compatibility ?? '[]',
        requires: sourceSkill.requires ?? '{}',
        version: sourceSkill.version ?? '1.0.0',
        executableJson: sourceSkill.executableJson as any,
        ownerAgentId: actorId,
        workspaceId: targetWorkspaceId,
        metadata: JSON.stringify(newMetadata),
        status: 'active',
        signals: sourceSkill.signals ?? '[]',
        lifecycleStage: 'published',
        publishScope: 'workspace',
        publishedAt: new Date(),
      } as any,
    });

    // Mark snapshot consumed.
    const sourceMeta = this.parseMetadata(sourceSkill.metadata);
    const snaps = Array.isArray(sourceMeta.shareSnapshots) ? (sourceMeta.shareSnapshots as any[]) : [];
    const updatedSnaps = snaps.map((s: any) =>
      s.snapshotId === snapshotId
        ? { ...s, consumed: true, consumedAt: new Date().toISOString(), consumedBy: actorId, consumedInto: newSkill.id }
        : s,
    );
    sourceMeta.shareSnapshots = updatedSnaps;
    await prisma.iMSkill.update({
      where: { id: sourceSkill.id },
      data: { metadata: JSON.stringify(sourceMeta) },
    });

    return {
      newSkillId: newSkill.id,
      importedFrom: newMetadata.importedFrom as any,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async requireSkill(id: string): Promise<any> {
    const skill = await prisma.iMSkill.findUnique({ where: { id } });
    if (!skill) throw new SkillLifecycleError('skill_not_found', `skill ${id} not found`, 404);
    return skill;
  }

  private parseMetadata(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * release201/08 §10.6 — emit the `skill.authoring.*` event family for
   * authoring-side sub-stage transitions. SkillDraftService injects this
   * service (lifecycle) so the draft pipeline can fan out the same
   * `skill.authoring.started / source_reviewed / bundle_scaffolded /
   * validation_started / validation_completed` events that downstream
   * consumers (Studio pipeline rail, Evidence panel) consume. Centralising
   * the wire here keeps the 14-event contract owned by one module.
   */
  async notifyAuthoringStarted(args: { skill: any; sourceKind: string; projectId?: string | null }): Promise<void> {
    await this.emit(
      SSE_EVENTS.AUTHORING_STARTED,
      {
        draftId: args.skill.id,
        skillId: args.skill.id,
        slug: args.skill.slug,
        sourceKind: args.sourceKind,
        projectId: args.projectId ?? null,
        at: new Date().toISOString(),
      },
      args.skill,
    );
  }

  async notifySourceReviewed(args: { skill: any; sourceRefs: string[]; referenceAssetIds?: string[] }): Promise<void> {
    await this.emit(
      SSE_EVENTS.AUTHORING_SOURCE_REVIEWED,
      {
        draftId: args.skill.id,
        skillId: args.skill.id,
        sourceRefs: args.sourceRefs,
        referenceAssetIds: args.referenceAssetIds ?? [],
        at: new Date().toISOString(),
      },
      args.skill,
    );
  }

  async notifyBundleScaffolded(args: { skill: any; manifestRevision: string; fileCount: number }): Promise<void> {
    await this.emit(
      SSE_EVENTS.AUTHORING_BUNDLE_SCAFFOLDED,
      {
        draftId: args.skill.id,
        skillId: args.skill.id,
        manifestRevision: args.manifestRevision,
        fileCount: args.fileCount,
        at: new Date().toISOString(),
      },
      args.skill,
    );
  }

  async notifyValidationStarted(args: { skill: any; gates: string[] }): Promise<void> {
    await this.emit(
      SSE_EVENTS.AUTHORING_VALIDATION_STARTED,
      {
        draftId: args.skill.id,
        skillId: args.skill.id,
        gates: args.gates,
        at: new Date().toISOString(),
      },
      args.skill,
    );
  }

  async notifyValidationCompleted(args: {
    skill: any;
    gates: Array<{ name: string; status: 'pass' | 'warn' | 'fail' }>;
    failedGates: string[];
  }): Promise<void> {
    await this.emit(
      SSE_EVENTS.AUTHORING_VALIDATION_COMPLETED,
      {
        draftId: args.skill.id,
        skillId: args.skill.id,
        gates: args.gates,
        failedGates: args.failedGates,
        at: new Date().toISOString(),
      },
      args.skill,
    );
    // release201/08 §10.7 — if any gate failed, fan out the canonical
    // `validation_failed` failure card alongside the completion event so the
    // UI's failure panel surfaces the gate names without polling.
    if (args.failedGates.length > 0) {
      await this.emitAuthoringFailed(
        args.skill,
        'validation_failed',
        'static_validate',
        `gates failed: ${args.failedGates.join(', ')}`,
        'error',
      );
    }
  }

  /**
   * release201/08 §10.7 — `requires_unavailable` failure surface. Invoked by
   * daemon eval-session callbacks when `manifest.runtime.requires` declares
   * env / bins / python / node that are not present in the sandbox profile.
   * Until daemon integration lands (S4+), callers may invoke this from
   * cloud-side admin paths to test the failure card.
   */
  async notifyRequiresUnavailable(args: {
    skillId: string;
    stage?: string;
    missing: string[];
    reason?: string;
  }): Promise<void> {
    await this.emitAuthoringFailed(
      args.skillId,
      'requires_unavailable',
      args.stage ?? 'sandbox_smoke',
      args.reason ?? `runtime requires not available in sandbox: ${args.missing.join(', ')}`,
      'warning',
    );
  }

  /**
   * release201/08 §2.0 — write the canonical sub-stage label into
   * `IMSkill.metadata.lifecycleSubStage` and emit
   * `skill.authoring.state_changed` for any consumer that needs sub-stage
   * granularity (Studio pipeline rail, S22). Idempotent: if the sub-stage
   * already matches the requested one, the DB update is skipped (event still
   * emits so external observers re-confirm — keeps semantics simple).
   *
   * `skill` MAY be a pre-loaded row; otherwise we refetch by id so callers
   * inside a transition don't have to thread the row through.
   */
  async setLifecycleSubStage(
    skillIdOrRow: string | any,
    newSubStage: LifecycleSubStage,
    reason?: string,
  ): Promise<void> {
    const skill: any =
      typeof skillIdOrRow === 'string'
        ? await prisma.iMSkill.findUnique({ where: { id: skillIdOrRow } })
        : skillIdOrRow;
    if (!skill) return;
    const meta = this.parseMetadata(skill.metadata);
    const prev = (meta.lifecycleSubStage as LifecycleSubStage | undefined) ?? null;
    if (prev !== newSubStage) {
      meta.lifecycleSubStage = newSubStage;
      try {
        await prisma.iMSkill.update({
          where: { id: skill.id },
          data: { metadata: JSON.stringify(meta) },
        });
      } catch (err) {
        console.warn(`${LOG} setLifecycleSubStage update failed for ${skill.id}: ${(err as Error).message}`);
      }
    }
    await this.emit(
      SSE_EVENTS.AUTHORING_STATE_CHANGED,
      {
        draftId: skill.id,
        skillId: skill.id,
        prevSubStage: prev,
        newSubStage,
        reason: reason ?? null,
        at: new Date().toISOString(),
      },
      skill,
    );
  }

  /**
   * release201/08 §10.7 — fan out a `skill.authoring.failed` SSE event with
   * the prescribed `failureKind` discriminator. Centralised so every failure
   * path in the lifecycle SOP emits with the same payload shape (UI relies on
   * `failureKind` for the 7 distinct cards).
   */
  async emitAuthoringFailed(
    skillOrId: string | any,
    failureKind: FailureKind,
    stage: string,
    reason: string,
    severity: 'info' | 'warning' | 'error' = 'error',
  ): Promise<void> {
    const skill: any =
      typeof skillOrId === 'string'
        ? await prisma.iMSkill.findUnique({ where: { id: skillOrId } }).catch(() => null)
        : skillOrId;
    if (!skill) {
      console.warn(`${LOG} emitAuthoringFailed: skill not found, kind=${failureKind}`);
      return;
    }
    await this.emit(
      SSE_EVENTS.AUTHORING_FAILED,
      {
        draftId: skill.id,
        skillId: skill.id,
        stage,
        failureKind,
        reason,
        severity,
        at: new Date().toISOString(),
      },
      skill,
    );
  }

  private summarizeRun(row: any): EvalRunSummary {
    let cases: EvalTestCase[] = [];
    try {
      const parsed = JSON.parse(row.testCasesJson || '{}');
      cases = Array.isArray(parsed.testCases) ? parsed.testCases : Array.isArray(parsed) ? parsed : [];
    } catch {
      cases = [];
    }
    let results: EvalTestCaseResult[] | undefined;
    if (row.resultsJson) {
      try {
        results = JSON.parse(row.resultsJson);
      } catch {
        results = undefined;
      }
    }
    return {
      runId: row.id,
      skillId: row.skillId,
      status: row.status,
      passCount: row.passCount,
      failCount: row.failCount,
      testCases: cases,
      results,
      daemonId: row.daemonId ?? null,
      agentTraceUrl: row.agentTraceUrl ?? null,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async createLifecycleTask(
    skill: any,
    actorId: string,
    capability: string,
    title: string,
  ): Promise<string | undefined> {
    if (!skill.workspaceId) return undefined;
    const ws = await prisma.iMWorkspace.findUnique({
      where: { id: skill.workspaceId },
      select: { ownerImUserId: true },
    });
    if (!ws?.ownerImUserId) return undefined;
    const task = await prisma.iMTask.create({
      data: {
        title,
        description: `Lifecycle task auto-created by SkillLifecycleService for skill '${skill.slug}'. See Studio Lifecycle domain (/evolution?tab=studio&view=skills&subview=lifecycle&skillId=${skill.id}).`,
        capability,
        creatorId: actorId,
        assigneeId: ws.ownerImUserId,
        workspaceId: skill.workspaceId,
        status: 'pending',
        metadata: JSON.stringify({
          skillId: skill.id,
          skillSlug: skill.slug,
          source: 'release201/08 lifecycle SOP',
        }),
      },
    });

    // release201/10 §5.3 — auto-apply default acceptance template by
    // capability. release201/07-08 acceptance gate (P0-2): lifecycle-created
    // tasks must NEVER ship without the default template so reviewer surface
    // sees the 3-item checklist.
    try {
      const applied = await getTaskAcceptanceService().applyDefaultTemplateOnCreate(
        task.id,
        capability,
        skill.workspaceId,
        actorId,
      );
      if (applied.applied) {
        console.log(`${LOG} applied ${capability} acceptance template ${applied.templateId} to task ${task.id}`);
      }
    } catch (tplErr) {
      console.warn(
        `${LOG} failed to apply ${capability} acceptance template to ${task.id}:`,
        (tplErr as Error).message,
      );
    }
    return task.id;
  }

  /**
   * release201 v2.0.8 G1 — resolve the workspace's "default" project so
   * server-side task seeders (boilerplate sample tasks, launch-tour content,
   * etc.) inherit the same projectId the board's active-project filter is
   * looking at. Otherwise tasks land with projectId=null and get hidden from
   * the default workspace view.
   *
   * Resolution order (no schema additions — `workspace.metadata.defaultProjectId`
   * is NOT an established convention in this codebase, so we only honour it
   * if a future caller starts persisting it; the practical path is the
   * fallback):
   *   (a) parse `workspace.metadata.defaultProjectId` if present
   *   (b) earliest active project in the workspace (createdAt asc) — i.e.
   *       the "main" project created when the workspace was bootstrapped
   *   (c) null (preserves prior behaviour for workspaces with no projects)
   */
  private async resolveWorkspaceDefaultProject(workspaceId: string): Promise<string | null> {
    try {
      const ws = await prisma.iMWorkspace.findUnique({
        where: { id: workspaceId },
        select: { metadata: true },
      });
      if (ws?.metadata) {
        try {
          const meta = JSON.parse(ws.metadata);
          const fromMeta = meta?.defaultProjectId;
          if (typeof fromMeta === 'string' && fromMeta.length > 0) {
            return fromMeta;
          }
        } catch {
          // metadata JSON parse failure is non-fatal — fall through to (b).
        }
      }
      const firstActive = await prisma.iMProject.findFirst({
        where: { workspaceId, status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      return firstActive?.id ?? null;
    } catch (err) {
      console.warn(`${LOG} resolveWorkspaceDefaultProject(${workspaceId}) failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * §8.2 — auto-generate a `Try out '<skill>'` task.
   */
  private async createBoilerplateTask(skill: any, actorId: string): Promise<string | undefined> {
    if (!skill.workspaceId) return undefined;
    const ws = await prisma.iMWorkspace.findUnique({
      where: { id: skill.workspaceId },
      select: { ownerImUserId: true },
    });
    if (!ws?.ownerImUserId) return undefined;
    // release201 v2.0.8 G1 — inject default projectId so the sample task is
    // visible under the workspace board's active-project filter. Symmetric
    // to A3 (mutations.ts:seedLaunchTourContent) which reads activeProject
    // from client-side storage; here we're on the server so we resolve via
    // workspace.metadata → first active project → null.
    const defaultProjectId = await this.resolveWorkspaceDefaultProject(skill.workspaceId);
    const task = await prisma.iMTask.create({
      data: {
        title: `Try out '${skill.name}'`,
        description: [
          `Verify that '${skill.name}' (${skill.slug}) works in your workflow.`,
          ``,
          `Sample prompt suggestion: ${skill.description || 'use the skill in a real conversation.'}`,
          ``,
          `Acceptance checklist:`,
          `- [ ] skill installed to at least one agent`,
          `- [ ] skill triggered at least once in a real conversation`,
          `- [ ] user manually marks "works as expected" or files an issue`,
        ].join('\n'),
        capability: 'skill-tryout',
        creatorId: actorId,
        assigneeId: ws.ownerImUserId,
        workspaceId: skill.workspaceId,
        projectId: defaultProjectId,
        status: 'pending',
        metadata: JSON.stringify({ skillId: skill.id, skillSlug: skill.slug, kind: 'boilerplate-tryout' }),
      },
    });

    // release201/10 §5.3 — auto-apply default skill-tryout acceptance template
    // so the freshly published skill's sample task surfaces with the 3-item
    // checklist (installed / triggered / output matches expected).
    try {
      const applied = await getTaskAcceptanceService().applyDefaultTemplateOnCreate(
        task.id,
        'skill-tryout',
        skill.workspaceId,
        actorId,
      );
      if (applied.applied) {
        console.log(`${LOG} applied skill-tryout template ${applied.templateId} to task ${task.id}`);
      }
    } catch (tplErr) {
      console.warn(`${LOG} failed to apply skill-tryout acceptance template to ${task.id}:`, (tplErr as Error).message);
    }
    return task.id;
  }

  /**
   * §8.1 — render a README.md for the workspace files surface. The
   * structured body is derived from skill manifest + description; no
   * external rendering deps.
   */
  private async writeReadmeAsset(skill: any): Promise<string | undefined> {
    if (!skill.workspaceId) return undefined;
    const meta = this.parseMetadata(skill.metadata);
    const skillJson = (meta?.skillJson as any) ?? {};
    const sampleTasks: any[] = Array.isArray(skillJson.sampleTasks) ? skillJson.sampleTasks : [];
    const provenance = (skillJson.provenance as any) ?? {};
    const dataAccess = (skillJson.security as any)?.dataAccess ?? [];
    const inputs = Array.isArray(skillJson.inputs) ? skillJson.inputs : [];
    const outputs = Array.isArray(skillJson.outputs) ? skillJson.outputs : [];

    const lines = [
      `# ${skill.name}`,
      ``,
      `> Source: workspace \`${skill.workspaceId}\` · Author: \`${skill.author || provenance.authoredBy || skill.ownerAgentId || 'unknown'}\` · License: \`${skill.license}\` · Published: \`${(skill.publishedAt ?? new Date()).toISOString().slice(0, 10)}\``,
      ``,
      `## What it does`,
      ``,
      skill.description || '(no description)',
      ``,
      `## Install`,
      ``,
      '```bash',
      `cloud skill install ${skill.slug}`,
      '```',
      ``,
    ];
    if (inputs.length || outputs.length) {
      lines.push(`## Inputs / Outputs`, ``);
      if (inputs.length) {
        lines.push(`Inputs:`);
        for (const i of inputs) {
          lines.push(
            `- \`${i.name}\` (${i.type})${i.required ? ' — required' : ''}${i.description ? `: ${i.description}` : ''}`,
          );
        }
        lines.push(``);
      }
      if (outputs.length) {
        lines.push(`Outputs:`);
        for (const o of outputs) {
          lines.push(
            `- \`${o.name}\` (${o.type})${o.required ? ' — required' : ''}${o.description ? `: ${o.description}` : ''}`,
          );
        }
        lines.push(``);
      }
    }
    if (sampleTasks.length) {
      lines.push(`## Sample tasks`, ``);
      for (const s of sampleTasks.slice(0, 3)) {
        lines.push(`- ${s.title}: ${s.prompt}`);
      }
      lines.push(``);
    }
    if (dataAccess.length) {
      lines.push(`## Security`, ``, `Data access: ${dataAccess.map((d: string) => `\`${d}\``).join(', ')}`, ``);
    }

    const content = lines.join('\n');
    // release201 v2.0.7.1 hotfix (B7): workspace-files normalizePath rejects
    // leading '/' (api/workspace-files.ts:84). Use relative path so
    // `GET /workspaces/:id/files?path=skills/<slug>/README.md` resolves.
    const path = `skills/${skill.slug}/README.md`;

    // release201/08 §8.1 + release201/09 §9.4a §6 — publish README is a
    // workspace-library artifact, NOT a task-bound asset (no `sourceTaskId`,
    // not produced by a sandbox task). boundKind='workspace-file' so the
    // Library Files panel (default filter) surfaces it; sourceKind=
    // 'skill-readme' so consumers can distinguish auto-gen READMEs from
    // user uploads.
    //
    // Schema (prisma/schema.mysql.prisma model IMAsset): workspaceId,
    // ownerImUserId, contentHash, storageUri, kind, sourceKind, boundKind
    // are the canonical columns. We mirror the task-spec.service pattern
    // (inline-markdown:// storageUri) to keep the persistence shape
    // consistent across SOP-produced markdown.
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const storageUri = `inline-markdown://skill-readme/${skill.id}/${contentHash.slice(0, 12)}`;
    const sizeBytes = BigInt(Buffer.byteLength(content, 'utf8'));

    // Attempt to attach to im_workspace_files if asset write is reachable.
    // We materialise as a plain IMAsset → IMWorkspaceFile pair for the
    // library files panel to surface. When the surrounding asset service
    // isn't initialised (unit tests), gracefully skip.
    try {
      const asset = await prisma.iMAsset.create({
        data: {
          workspaceId: skill.workspaceId,
          ownerImUserId: skill.ownerAgentId ?? skill.workspaceId,
          contentHash,
          storageUri,
          sizeBytes,
          mime: 'text/markdown',
          kind: 'document',
          filename: `${skill.slug}-README.md`,
          sourceKind: 'skill-readme',
          boundKind: 'workspace-file',
          metadata: JSON.stringify({
            kind: 'skill-readme',
            skillId: skill.id,
            skillSlug: skill.slug,
            body: content,
          }),
          ingestStatus: 'ready',
          visibility: 'workspace',
        } as any,
      });
      const file = await prisma.iMWorkspaceFile.create({
        data: {
          workspaceId: skill.workspaceId,
          assetId: asset.id,
          path,
          modifierImUserId: skill.ownerAgentId ?? skill.workspaceId,
        } as any,
      });
      return file.id;
    } catch (err) {
      // soft-fail; README is a nice-to-have, not a publish blocker
      console.warn(`${LOG} README write skipped: ${(err as Error).message}`);
      return undefined;
    }
  }

  private shortId(len = 10): string {
    return randomUUID().replace(/-/g, '').slice(0, len);
  }

  /**
   * Persist a sync event so /sync/stream consumers (workspace UI / Studio /
   * SDK) see lifecycle events. SyncService is optional — when absent (eg.
   * standalone unit tests) we no-op and log instead.
   */
  private async emit(type: SkillSseEventType, payload: Record<string, unknown>, skill: any): Promise<void> {
    if (!this.deps.sync) {
      return;
    }
    // Fanout target heuristic: when a skill has a workspace, scope to that
    // workspace's owner; otherwise scope to the owner agent.
    let recipient = skill?.ownerAgentId ?? null;
    if (skill?.workspaceId) {
      try {
        const ws = await prisma.iMWorkspace.findUnique({
          where: { id: skill.workspaceId },
          select: { ownerImUserId: true },
        });
        recipient = ws?.ownerImUserId ?? recipient;
      } catch {
        /* swallow */
      }
    }
    if (!recipient) return;
    try {
      // Lifecycle events are not bound to a single conversation — pass null
      // for conversationId so SyncPublisher's fan-out treats it as a user-
      // global event.
      await this.deps.sync.writeEvent(type, { ...payload, _skillId: skill?.id }, null, recipient);
    } catch (err) {
      console.warn(`${LOG} emit ${type} failed: ${(err as Error).message}`);
    }
  }
}

export const SkillLifecycle = SkillLifecycleService; // alias for shorter imports
