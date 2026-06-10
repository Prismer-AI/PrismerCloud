/**
 * Prismer IM — VerifierDispatchService (release201/10 rev 2 §5.2)
 *
 * When a task transitions into `review`, dispatch a `task.verify.requested`
 * IM message + SSE event to each criterion's verifierAgentId. The agent
 * decides AT RUNTIME how to verify (Playwright / endpoint / benchmark /
 * LLM-judge / 人眼) and reports back through the unified `verify` endpoint.
 *
 * **This service ships 0 implementation code** — no fetch / playwright /
 * benchmark / mime detection. Cloud only dispatches + receives outcomes.
 *
 * Routing rules (§4.2):
 *   - verifyMode='qualitative' | 'quantitative' → push to
 *     `criterion.verifierAgentId ?? task.creatorId`. If both NULL,
 *     fall back to manual + log structured warning.
 *   - verifyMode='agent-self-check' → SKIP (assignee already self-evaluated)
 *   - verifyMode='manual' → SKIP (reviewer interacts via ApprovalCard)
 *
 * Forbidden patterns (§0.2.4):
 *   - Log "[verifier] dispatch agent missing" — emit structured fallback instead
 *   - Cloud-side implementation of any specific verifier method
 */

import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import { getTaskAcceptanceService, type Criterion } from './task-acceptance.service';
import { getTaskSpecService } from './task-spec.service';

const log = createModuleLogger('VerifierDispatchService');

export interface VerifierDispatchDeps {
  eventBusService?: {
    publish: (msg: any) => any;
  };
  /** Optional WS push (lazy — service falls back to SSE-only if absent). */
  rooms?: {
    sendToUser: (userId: string, payload: any) => void;
  };
  /** Optional sync stream writer for offline-first SDK pickup. */
  syncService?: {
    writeEvent: (type: string, payload: any, conversationId: string | null, targetUserId: string) => Promise<unknown>;
  };
}

export interface DispatchResult {
  dispatched: number;
  skipped: number;
  fallbackToManual: number;
  perCriterion: Array<{
    criterionId: string;
    verifyMode: string;
    targetAgentId: string | null;
    result: 'dispatched' | 'skipped' | 'manual-fallback';
  }>;
}

export class VerifierDispatchService {
  constructor(private deps: VerifierDispatchDeps = {}) {}

  /**
   * Read the task's criteria + dispatch IM message to each criterion's
   * verifier agent. Idempotent on retries (cloud doesn't track per-dispatch
   * tickets — verifier agent decides whether to re-run).
   */
  async dispatchVerifyRequest(taskId: string): Promise<DispatchResult> {
    const acceptance = await getTaskAcceptanceService({ eventBusService: this.deps.eventBusService }).getAcceptance(
      taskId,
    );
    const task = (await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        workspaceId: true,
        creatorId: true,
        assigneeId: true,
        capability: true,
        metadata: true,
      } as never,
    })) as unknown as {
      id: string;
      title: string;
      workspaceId: string;
      creatorId: string;
      assigneeId: string | null;
      capability: string | null;
      metadata: string | null;
    } | null;
    if (!task) {
      log.warn({ taskId }, 'dispatchVerifyRequest: task not found, nothing to dispatch');
      return { dispatched: 0, skipped: 0, fallbackToManual: 0, perCriterion: [] };
    }

    // Read SPEC.md once — included in the verify-request payload so the
    // verifier agent has full context without an extra round-trip.
    const spec = await getTaskSpecService({ eventBusService: this.deps.eventBusService })
      .get(taskId)
      .catch(() => ({ markdown: '', revision: 0, updatedAt: null }));

    // release201/08 §0.2.3 — Reviewer ≠ ownerAgentId. For skill lifecycle
    // tasks (skill-review / skill-publish / skill-tryout — these carry
    // `metadata.skillId`), resolve the underlying skill's ownerAgentId so
    // we can refuse to dispatch a verify-request to the skill author
    // (anti-pattern: agent verifies their own skill). Manual fallback +
    // structured log instead of raising — the criterion still surfaces in
    // the reviewer UI as needing a human gate.
    let skillOwnerAgentId: string | null = null;
    try {
      const meta = task.metadata ? JSON.parse(task.metadata) : null;
      const skillId: string | undefined =
        meta && typeof meta === 'object' && typeof (meta as any).skillId === 'string'
          ? (meta as any).skillId
          : undefined;
      if (skillId) {
        const skill = (await prisma.iMSkill.findUnique({
          where: { id: skillId },
          select: { ownerAgentId: true } as never,
        })) as unknown as { ownerAgentId: string | null } | null;
        skillOwnerAgentId = skill?.ownerAgentId ?? null;
      }
    } catch {
      /* swallow metadata parse errors — skill-link is best-effort */
    }

    const result: DispatchResult = { dispatched: 0, skipped: 0, fallbackToManual: 0, perCriterion: [] };

    for (const c of acceptance.criteria) {
      const mode = c.verifyMode;
      if (mode === 'agent-self-check' || mode === 'manual') {
        result.skipped++;
        result.perCriterion.push({
          criterionId: c.id,
          verifyMode: mode,
          targetAgentId: null,
          result: 'skipped',
        });
        continue;
      }
      // qualitative / quantitative — needs a verifier agent.
      const target = c.verifierAgentId ?? task.creatorId ?? null;
      if (!target) {
        // §0.2.4 forbidden log avoidance — use structured wording instead
        // of the verbatim forbidden string.
        log.warn(
          { taskId, criterionId: c.id },
          'verifier_agent_unresolved: falling back to manual (no verifierAgentId, no creator)',
        );
        result.fallbackToManual++;
        result.perCriterion.push({
          criterionId: c.id,
          verifyMode: mode,
          targetAgentId: null,
          result: 'manual-fallback',
        });
        continue;
      }

      // release201/08 §0.2.3 — block self-review: the verifier agent must
      // NOT be the skill author. We fall back to manual instead of raising
      // (the reviewer UI surfaces the criterion as a human gate), but log
      // structured WARN so the audit trail captures the divergence.
      if (skillOwnerAgentId && target === skillOwnerAgentId) {
        log.warn(
          { taskId, criterionId: c.id, verifierAgentId: target, skillOwnerAgentId },
          'verifier_self_review_blocked: criterion verifier equals skill owner, falling back to manual',
        );
        result.fallbackToManual++;
        result.perCriterion.push({
          criterionId: c.id,
          verifyMode: mode,
          targetAgentId: null,
          result: 'manual-fallback',
        });
        continue;
      }

      const payload = {
        taskId,
        taskTitle: task.title,
        criterionId: c.id,
        verifyMode: mode,
        expectation: c.expectation,
        verifierAgentId: target,
        evidenceRefs: c.evidenceRefs ?? [],
        spec: spec.markdown,
        specRevision: spec.revision,
      };

      // 1. SSE event (creator-side observability + verifier-side
      //    inbox if they subscribe by /sync/stream).
      if (this.deps.eventBusService) {
        try {
          const ret = this.deps.eventBusService.publish({
            type: 'task.verify.requested',
            timestamp: Date.now(),
            data: { ...payload, recipientHint: target },
          });
          if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
            (ret as Promise<unknown>).catch(() => {});
          }
        } catch {
          /* swallow */
        }
      }

      // 2. WS push (immediate online delivery, when verifier agent is connected).
      if (this.deps.rooms) {
        try {
          this.deps.rooms.sendToUser(target, {
            type: 'task.verify.requested',
            payload,
            timestamp: Date.now(),
          });
        } catch (err) {
          log.warn(`WS push to ${target} failed: ${(err as Error).message}`);
        }
      }

      // 3. Sync stream — guarantees offline-first pickup for daemon SDKs.
      if (this.deps.syncService) {
        try {
          await Promise.race([
            this.deps.syncService.writeEvent('task.verify.requested', payload, null, target),
            new Promise((_, reject) => setTimeout(() => reject(new Error('sync timeout')), 5000)),
          ]);
        } catch (err) {
          log.warn(`Sync event write failed for ${target}: ${(err as Error).message}`);
        }
      }

      result.dispatched++;
      result.perCriterion.push({
        criterionId: c.id,
        verifyMode: mode,
        targetAgentId: target,
        result: 'dispatched',
      });
    }

    log.info({ taskId, ...result, perCriterion: undefined }, 'verifier dispatch complete');
    return result;
  }

  /**
   * Lightweight helper for tests / orchestrators that want to see who'd
   * be dispatched without actually pushing. Returns the same shape
   * dispatchVerifyRequest returns but does not emit any message.
   */
  async dryRunDispatch(taskId: string): Promise<DispatchResult> {
    const acceptance = await getTaskAcceptanceService({ eventBusService: this.deps.eventBusService }).getAcceptance(
      taskId,
    );
    const task = (await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { creatorId: true, metadata: true } as never,
    })) as unknown as { creatorId: string; metadata: string | null } | null;
    const creatorId = task?.creatorId ?? null;

    // release201/08 §0.2.3 — same self-review guard as dispatchVerifyRequest.
    let skillOwnerAgentId: string | null = null;
    try {
      const meta = task?.metadata ? JSON.parse(task.metadata) : null;
      const skillId: string | undefined =
        meta && typeof meta === 'object' && typeof (meta as any).skillId === 'string'
          ? (meta as any).skillId
          : undefined;
      if (skillId) {
        const skill = (await prisma.iMSkill.findUnique({
          where: { id: skillId },
          select: { ownerAgentId: true } as never,
        })) as unknown as { ownerAgentId: string | null } | null;
        skillOwnerAgentId = skill?.ownerAgentId ?? null;
      }
    } catch {
      /* swallow */
    }

    const result: DispatchResult = { dispatched: 0, skipped: 0, fallbackToManual: 0, perCriterion: [] };
    for (const c of acceptance.criteria as Criterion[]) {
      if (c.verifyMode === 'agent-self-check' || c.verifyMode === 'manual') {
        result.skipped++;
        result.perCriterion.push({
          criterionId: c.id,
          verifyMode: c.verifyMode,
          targetAgentId: null,
          result: 'skipped',
        });
        continue;
      }
      const target = c.verifierAgentId ?? creatorId ?? null;
      if (!target) {
        result.fallbackToManual++;
        result.perCriterion.push({
          criterionId: c.id,
          verifyMode: c.verifyMode,
          targetAgentId: null,
          result: 'manual-fallback',
        });
        continue;
      }
      if (skillOwnerAgentId && target === skillOwnerAgentId) {
        result.fallbackToManual++;
        result.perCriterion.push({
          criterionId: c.id,
          verifyMode: c.verifyMode,
          targetAgentId: null,
          result: 'manual-fallback',
        });
        continue;
      }
      result.dispatched++;
      result.perCriterion.push({
        criterionId: c.id,
        verifyMode: c.verifyMode,
        targetAgentId: target,
        result: 'dispatched',
      });
    }
    return result;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _singleton: VerifierDispatchService | null = null;
export function getVerifierDispatchService(deps?: VerifierDispatchDeps): VerifierDispatchService {
  if (!_singleton) {
    _singleton = new VerifierDispatchService(deps);
  } else if (deps) {
    // Late-binding deps (eventBus / rooms / sync get wired in later).
    (_singleton as any).deps = { ...((_singleton as any).deps ?? {}), ...deps };
  }
  return _singleton;
}

export function __setVerifierDispatchServiceForTests(svc: VerifierDispatchService | null): void {
  _singleton = svc;
}
