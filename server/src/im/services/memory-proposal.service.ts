/**
 * Memory proposal lifecycle (A4 of Memory Line A).
 *
 * Stores agent-authored draft edits awaiting workspace-owner approval. The
 * critical guarantee is `baseVersion`: when an owner approves a proposal,
 * the page version at apply-time must equal the version snapshot the agent
 * captured when authoring the proposal. Mismatch ⇒ 409 baseVersion_drift.
 *
 * Brief reference: doc 23 §8 U5, §11 R8.
 */

import * as crypto from 'node:crypto';
import prisma from '../db';
import type { MemoryAclContext } from './memory-acl';
import { MemoryWriteError } from './memory-write.service';

// Prisma is dynamically imported, so its type is `any` (see src/lib/prisma.ts).
// `tx` inside $transaction inherits the same shape — narrowing to `any` keeps
// strict-mode noise off without losing runtime correctness.
type PrismaTx = typeof prisma;

export type ProposalOperation = 'create' | 'append' | 'replace_section' | 'archive';

const VALID_OPERATIONS: Set<ProposalOperation> = new Set(['create', 'append', 'replace_section', 'archive']);

const DEFAULT_TTL_DAYS = 14;

export interface CreateProposalInput {
  acl: MemoryAclContext;
  pagePath: string;
  baseVersion: number;
  operation: ProposalOperation;
  contentDiff: string;
  rationale?: string;
  confidence: number;
  sourceRefs: string[];
  sessionId?: string;
  ttlDays?: number;
}

export interface ListProposalsInput {
  acl: MemoryAclContext;
  status?: string;
  sessionId?: string;
  pagePath?: string;
  limit?: number;
}

export interface BulkApproveInput {
  acl: MemoryAclContext;
  sessionId?: string;
  proposalIds?: string[];
}

interface ProposalRow {
  id: string;
  workspaceId: string;
  proposingAgentId: string;
  sessionId: string | null;
  status: string;
  pagePath: string;
  baseVersion: number;
  operation: string;
  contentDiff: string;
  rationale: string | null;
  confidence: number;
  sourceRefs: string;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByImUserId: string | null;
  rejectionReason: string | null;
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryProposalService {
  // ─── POST /memory/proposals (agent caller) ─────────────────
  async create(input: CreateProposalInput) {
    const { acl } = input;
    if (acl.callerKind !== 'agent') {
      throw new MemoryWriteError('agent_only', 'proposals are authored by agents only', 403);
    }
    if (!VALID_OPERATIONS.has(input.operation)) {
      throw new MemoryWriteError('invalid_operation', `unsupported operation ${input.operation}`);
    }
    if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
      throw new MemoryWriteError('invalid_confidence', 'confidence must be in [0, 1]');
    }
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
      throw new MemoryWriteError('source_refs_required', 'sourceRefs[] must be non-empty');
    }
    const ttlDays = Math.max(1, Math.min(input.ttlDays ?? DEFAULT_TTL_DAYS, 60));
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const created = await prisma.iMMemoryProposal.create({
      data: {
        workspaceId: acl.workspaceId,
        proposingAgentId: acl.callerImUserId,
        sessionId: input.sessionId ?? null,
        pagePath: input.pagePath,
        baseVersion: Math.floor(input.baseVersion),
        operation: input.operation,
        contentDiff: input.contentDiff,
        rationale: input.rationale ?? null,
        confidence: input.confidence,
        sourceRefs: JSON.stringify(input.sourceRefs),
        expiresAt,
      },
    });
    return created;
  }

  // ─── GET /memory/proposals ─────────────────────────────────
  async list(input: ListProposalsInput) {
    const { acl } = input;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    return prisma.iMMemoryProposal.findMany({
      where: {
        workspaceId: acl.workspaceId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.pagePath ? { pagePath: input.pagePath } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ─── POST /memory/proposals/:id/approve (owner) ────────────
  async approve(acl: MemoryAclContext, proposalId: string) {
    if (acl.callerKind !== 'user') {
      throw new MemoryWriteError('owner_only', 'approve requires the workspace owner', 403);
    }
    return prisma.$transaction(async (tx: PrismaTx) => {
      const proposal = await this.loadProposal(tx, acl.workspaceId, proposalId);
      if (proposal.status !== 'pending') {
        throw new MemoryWriteError('not_pending', `proposal already ${proposal.status}`, 409, {
          status: proposal.status,
        });
      }
      if (proposal.expiresAt && proposal.expiresAt < new Date()) {
        throw new MemoryWriteError('expired', 'proposal has expired', 409);
      }

      const page = await tx.iMMemoryPage.findFirst({
        where: { workspaceId: acl.workspaceId, path: proposal.pagePath, deletedAt: null },
      });

      if (proposal.operation === 'create') {
        if (page) {
          throw new MemoryWriteError('baseVersion_drift', 'page already exists at the proposed path', 409, {
            currentVersion: page.version,
            proposalBaseVersion: proposal.baseVersion,
          });
        }
        if (proposal.baseVersion !== 0) {
          throw new MemoryWriteError('invalid_create_baseVersion', 'create proposals must use baseVersion=0', 409, {
            proposalBaseVersion: proposal.baseVersion,
          });
        }
        await this.applyCreate(tx, acl, proposal);
      } else if (proposal.operation === 'archive') {
        if (!page) {
          throw new MemoryWriteError('not_found', 'page not found at proposed path', 404);
        }
        // Optimistic-lock fence: updateMany with the version predicate. If a
        // concurrent approval landed first, count=0 and we throw drift —
        // the original `findFirst` + `update` pattern was racy because the
        // version read happened outside the row lock.
        const archived = await tx.iMMemoryPage.updateMany({
          where: { id: page.id, version: proposal.baseVersion },
          data: { archivedAt: new Date() },
        });
        if (archived.count === 0) {
          const refreshed = await tx.iMMemoryPage.findFirst({
            where: { id: page.id },
            select: { version: true },
          });
          throw new MemoryWriteError('baseVersion_drift', 'page version drifted', 409, {
            currentVersion: refreshed?.version ?? null,
            proposalBaseVersion: proposal.baseVersion,
          });
        }
      } else {
        // append | replace_section
        if (!page) {
          throw new MemoryWriteError('not_found', 'page not found at proposed path', 404);
        }
        const nextContent =
          proposal.operation === 'append'
            ? `${page.content}\n${proposal.contentDiff}`.trimEnd() + '\n'
            : proposal.contentDiff;
        const newHash = contentHash(nextContent);
        const targetVersion = proposal.baseVersion + 1;
        // Optimistic-lock fence: only apply the content + bump if version
        // still matches baseVersion. count=0 means a concurrent approval
        // beat us to it.
        const applied = await tx.iMMemoryPage.updateMany({
          where: { id: page.id, version: proposal.baseVersion },
          data: { content: nextContent, contentHash: newHash, version: targetVersion },
        });
        if (applied.count === 0) {
          const refreshed = await tx.iMMemoryPage.findFirst({
            where: { id: page.id },
            select: { version: true },
          });
          throw new MemoryWriteError('baseVersion_drift', 'page version drifted', 409, {
            currentVersion: refreshed?.version ?? null,
            proposalBaseVersion: proposal.baseVersion,
          });
        }
        await tx.iMMemoryPageVersion.create({
          data: {
            workspaceId: acl.workspaceId,
            pageId: page.id,
            version: targetVersion,
            content: nextContent,
            contentHash: newHash,
            createdByImUserId: acl.callerImUserId,
            parentVersion: page.version,
            changeSummary: `Approved proposal ${proposal.id} (${proposal.operation})`,
            sourceKind: 'proposal',
            sourceRef: `proposal://${proposal.id}`,
            encrypted: false,
          },
        });
      }

      return tx.iMMemoryProposal.update({
        where: { id: proposal.id },
        data: {
          status: 'applied',
          decidedAt: new Date(),
          decidedByImUserId: acl.callerImUserId,
        },
      });
    });
  }

  private async applyCreate(tx: PrismaTx, acl: MemoryAclContext, proposal: ProposalRow) {
    const hash = contentHash(proposal.contentDiff);
    const provenance = [
      {
        at: nowIso(),
        kind: 'proposal_apply',
        actor: acl.callerImUserId,
        actorKind: acl.callerKind,
        proposalId: proposal.id,
        proposingAgent: proposal.proposingAgentId,
        sourceRefs: JSON.parse(proposal.sourceRefs),
      },
    ];
    const page = await tx.iMMemoryPage.create({
      data: {
        workspaceId: acl.workspaceId,
        path: proposal.pagePath,
        title: null,
        content: proposal.contentDiff,
        version: 1,
        createdByImUserId: acl.callerImUserId,
        pageType: 'leaf',
        visibility: 'workspace',
        provenanceJson: JSON.stringify(provenance),
        encrypted: false,
        contentHash: hash,
      },
    });
    await tx.iMMemoryPageVersion.create({
      data: {
        workspaceId: acl.workspaceId,
        pageId: page.id,
        version: 1,
        content: proposal.contentDiff,
        contentHash: hash,
        createdByImUserId: acl.callerImUserId,
        changeSummary: `Created from approved proposal ${proposal.id}`,
        sourceKind: 'proposal',
        sourceRef: `proposal://${proposal.id}`,
        encrypted: false,
      },
    });
  }

  private async loadProposal(tx: PrismaTx, workspaceId: string, proposalId: string): Promise<ProposalRow> {
    const proposal = await tx.iMMemoryProposal.findFirst({
      where: { id: proposalId, workspaceId },
    });
    if (!proposal) throw new MemoryWriteError('not_found', 'proposal not found', 404);
    return proposal as ProposalRow;
  }

  // ─── POST /memory/proposals/:id/reject (owner) ─────────────
  async reject(acl: MemoryAclContext, proposalId: string, reason: string) {
    if (acl.callerKind !== 'user') {
      throw new MemoryWriteError('owner_only', 'reject requires the workspace owner', 403);
    }
    if (!reason || !reason.trim()) {
      throw new MemoryWriteError('reason_required', 'rejection reason is required');
    }
    const updated = await prisma.iMMemoryProposal.updateMany({
      where: { id: proposalId, workspaceId: acl.workspaceId, status: 'pending' },
      data: {
        status: 'rejected',
        decidedAt: new Date(),
        decidedByImUserId: acl.callerImUserId,
        rejectionReason: reason,
      },
    });
    if (updated.count === 0) {
      throw new MemoryWriteError('not_found_or_not_pending', 'proposal not found or not pending', 404);
    }
    return prisma.iMMemoryProposal.findUnique({ where: { id: proposalId } });
  }

  // ─── POST /memory/proposals/bulk-approve ───────────────────
  async bulkApprove(input: BulkApproveInput) {
    const { acl } = input;
    if (acl.callerKind !== 'user') {
      throw new MemoryWriteError('owner_only', 'bulk-approve requires the workspace owner', 403);
    }
    const candidates = await prisma.iMMemoryProposal.findMany({
      where: {
        workspaceId: acl.workspaceId,
        status: 'pending',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.proposalIds?.length ? { id: { in: input.proposalIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    const approved: string[] = [];
    const skipped: { id: string; reason: string; currentVersion?: number }[] = [];
    for (const p of candidates as ProposalRow[]) {
      try {
        await this.approve(acl, p.id);
        approved.push(p.id);
      } catch (err) {
        if (err instanceof MemoryWriteError && err.code === 'baseVersion_drift') {
          skipped.push({
            id: p.id,
            reason: 'baseVersion_drift',
            currentVersion: (err.meta?.currentVersion as number | undefined) ?? undefined,
          });
        } else if (err instanceof MemoryWriteError) {
          skipped.push({ id: p.id, reason: err.code });
        } else {
          throw err;
        }
      }
    }
    return { approved, skipped };
  }

  // ─── Cron: expire pending proposals past expiresAt ─────────
  async expireOverdue(now: Date = new Date()): Promise<{ expired: number }> {
    const result = await prisma.iMMemoryProposal.updateMany({
      where: { status: 'pending', expiresAt: { lt: now } },
      data: { status: 'expired', decidedAt: now },
    });
    return { expired: result.count };
  }
}
