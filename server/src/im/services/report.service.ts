/**
 * Report Service — handles content reporting with credit freeze/refund.
 *
 * Flow: user submits report → credits frozen → admin resolves →
 *   upheld: credits refunded, content quarantined
 *   dismissed: credits deducted as penalty, reporter may get banned
 */

import prisma from '../db';
import type { CreditService } from './credit.service';
import { quarantineGene, quarantineSkill } from './quality-score.service';

const STANDARD_FREEZE = 0.5;
const HIGH_REP_FREEZE = 0.1;
const HIGH_REP_THRESHOLD = 0.5;
const DISMISS_BAN_THRESHOLD = 3;
const BAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReportInput {
  targetType: 'gene' | 'skill';
  targetId: string;
  reason: 'spam' | 'inappropriate' | 'misleading' | 'broken' | 'other';
  reasonDetail?: string;
}

export class ReportService {
  constructor(private creditService: CreditService) {}

  async submitReport(reporterId: string, input: ReportInput): Promise<{ id: string; frozenCredits: number }> {
    // Check reporter is not banned
    const reporter = await prisma.iMUser.findUnique({
      where: { id: reporterId },
      select: { banned: true, reportBanUntil: true },
    });
    if (!reporter) throw new Error('User not found');
    if (reporter.banned) throw new Error('Account is banned');
    if (reporter.reportBanUntil && reporter.reportBanUntil > new Date()) {
      throw new Error('Report privilege suspended until ' + reporter.reportBanUntil.toISOString());
    }

    // Check balance >= 1 credit
    const balance = await this.creditService.getBalance(reporterId);
    if (balance.balance < 1) {
      throw new Error('Insufficient credits (minimum 1.0 required to report)');
    }

    // Determine freeze amount based on reporter reputation
    const freezeAmount = await this.computeFreezeAmount(reporterId);

    // Check not already reported
    const existing = await prisma.iMReport.findUnique({
      where: {
        reporterId_targetType_targetId: {
          reporterId,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      },
    });
    if (existing) throw new Error('You have already reported this content');

    // Verify target exists
    if (input.targetType === 'gene') {
      const gene = await prisma.iMGene.findUnique({ where: { id: input.targetId } });
      if (!gene) throw new Error('Gene not found');
    } else {
      const skill = await prisma.iMSkill.findUnique({ where: { id: input.targetId } });
      if (!skill) throw new Error('Skill not found');
    }

    // Freeze credits
    const deductResult = await this.creditService.deduct(
      reporterId,
      freezeAmount,
      `Report deposit: ${input.targetType}/${input.targetId}`,
      'report_freeze',
    );
    if (!deductResult.success) {
      throw new Error('Failed to freeze credits');
    }

    // Create report
    const report = await prisma.iMReport.create({
      data: {
        reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        reasonDetail: input.reasonDetail || null,
        frozenCredits: freezeAmount,
      },
    });

    return { id: report.id, frozenCredits: freezeAmount };
  }

  async getMyReports(reporterId: string, page = 1, limit = 20): Promise<{ reports: any[]; total: number }> {
    const [reports, total] = await Promise.all([
      prisma.iMReport.findMany({
        where: { reporterId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.iMReport.count({ where: { reporterId } }),
    ]);
    return { reports, total };
  }

  async listReports(opts: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ reports: any[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (opts.status) where.status = opts.status;

    const page = opts.page || 1;
    const limit = opts.limit || 20;

    const [reports, total] = await Promise.all([
      prisma.iMReport.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.iMReport.count({ where }),
    ]);

    const enriched = await Promise.all(
      reports.map(async (r: any) => {
        let targetTitle = '';
        let targetAuthor = '';
        if (r.targetType === 'gene') {
          const gene = await prisma.iMGene.findUnique({
            where: { id: r.targetId },
            select: { title: true, ownerAgentId: true },
          });
          targetTitle = gene?.title || r.targetId;
          targetAuthor = gene?.ownerAgentId || '';
        } else {
          const skill = await prisma.iMSkill.findUnique({
            where: { id: r.targetId },
            select: { name: true, author: true },
          });
          targetTitle = skill?.name || r.targetId;
          targetAuthor = skill?.author || '';
        }
        const reporter = await prisma.iMUser.findUnique({
          where: { id: r.reporterId },
          select: { username: true, displayName: true },
        });
        return {
          ...r,
          targetTitle,
          targetAuthor,
          reporterName: reporter?.displayName || reporter?.username || r.reporterId,
        };
      }),
    );

    return { reports: enriched, total };
  }

  async resolveReport(reportId: string, decision: 'upheld' | 'dismissed', adminId: string): Promise<void> {
    const report = await prisma.iMReport.findUnique({ where: { id: reportId } });
    if (!report) throw new Error('Report not found');
    if (report.status !== 'pending') throw new Error('Report already resolved');

    if (decision === 'upheld') {
      await this.creditService.credit(
        report.reporterId,
        report.frozenCredits,
        'report_refund',
        `Report upheld: refund deposit for ${report.targetType}/${report.targetId}`,
      );

      if (report.targetType === 'gene') {
        await quarantineGene(report.targetId);
        const gene = await prisma.iMGene.findUnique({
          where: { id: report.targetId },
          select: { ownerAgentId: true },
        });
        if (gene) {
          await prisma.iMUser
            .update({
              where: { id: gene.ownerAgentId },
              data: { quarantineCount: { increment: 1 } },
            })
            .catch(() => {});
        }
      } else {
        await quarantineSkill(report.targetId);
        const skill = await prisma.iMSkill.findUnique({
          where: { id: report.targetId },
          select: { ownerAgentId: true },
        });
        if (skill?.ownerAgentId) {
          await prisma.iMUser
            .update({
              where: { id: skill.ownerAgentId },
              data: { quarantineCount: { increment: 1 } },
            })
            .catch(() => {});
        }
      }
    } else {
      const dismissedCount = await prisma.iMReport.count({
        where: { reporterId: report.reporterId, status: 'dismissed' },
      });
      if (dismissedCount + 1 >= DISMISS_BAN_THRESHOLD) {
        await prisma.iMUser.update({
          where: { id: report.reporterId },
          data: { reportBanUntil: new Date(Date.now() + BAN_DURATION_MS) },
        });
      }
    }

    await prisma.iMReport.update({
      where: { id: reportId },
      data: {
        status: decision,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    });
  }

  private async computeFreezeAmount(reporterId: string): Promise<number> {
    const publishedGenes = await prisma.iMGene.findMany({
      where: { ownerAgentId: reporterId, visibility: { in: ['published', 'canary'] } },
      select: { qualityScore: true },
    });
    if (publishedGenes.length >= 3) {
      const avgScore =
        publishedGenes.reduce((s: number, g: { qualityScore: number }) => s + g.qualityScore, 0) /
        publishedGenes.length;
      if (avgScore > HIGH_REP_THRESHOLD) return HIGH_REP_FREEZE;
    }
    return STANDARD_FREEZE;
  }
}
