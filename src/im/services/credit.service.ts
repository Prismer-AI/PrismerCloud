/**
 * Prismer IM — Credit Service
 *
 * Abstraction over credit operations.
 * - LocalCreditService: Prisma im_credits (SQLite, dev)
 * - CloudCreditService: bridges to pc_user_credits (MySQL, prod/test)
 */

import type { PrismaClient } from "@prisma/client";
import type { CreditBalance, DeductResult, CreditTx, TransferResult } from "../types/index";

/** Initial credits for new IM users — allows 100M messages at 0.001 per message */
export const IM_INITIAL_CREDITS = 100_000;
/** Non-transferable reserve: bonus/gifted credits cannot be transferred */
const REGISTRATION_BONUS = IM_INITIAL_CREDITS;

export interface CreditService {
  getBalance(imUserId: string): Promise<CreditBalance>;
  deduct(
    imUserId: string,
    amount: number,
    description: string,
    refType?: string,
    refId?: string
  ): Promise<DeductResult>;
  credit(
    imUserId: string,
    amount: number,
    type: string,
    description: string
  ): Promise<{ balanceAfter: number }>;
  transfer(
    fromUserId: string,
    toUserId: string,
    amount: number,
    description?: string
  ): Promise<TransferResult>;
  getTransactions(
    imUserId: string,
    limit: number,
    offset: number
  ): Promise<{ transactions: CreditTx[]; total: number }>;
  ensureCredit(imUserId: string): Promise<void>;
}

/**
 * Local credit service using Prisma (im_credits + im_credit_transactions).
 * For development / SQLite environment.
 */
export class LocalCreditService implements CreditService {
  constructor(private prisma: PrismaClient) {}

  async ensureCredit(imUserId: string): Promise<void> {
    const existing = await this.prisma.iMCredit.findUnique({
      where: { imUserId },
    });
    if (!existing) {
      await this.prisma.iMCredit.create({
        data: { imUserId, balance: IM_INITIAL_CREDITS, totalEarned: 0, totalSpent: 0 },
      });
    }
  }

  async getBalance(imUserId: string): Promise<CreditBalance> {
    await this.ensureCredit(imUserId);
    const credit = await this.prisma.iMCredit.findUnique({
      where: { imUserId },
    });
    return {
      balance: credit!.balance,
      totalEarned: credit!.totalEarned,
      totalSpent: credit!.totalSpent,
    };
  }

  async deduct(
    imUserId: string,
    amount: number,
    description: string,
    refType?: string,
    refId?: string
  ): Promise<DeductResult> {
    await this.ensureCredit(imUserId);

    // Use a transaction for atomic deduction
    return this.prisma.$transaction(async (tx: any) => {
      const credit = await tx.iMCredit.findUnique({ where: { imUserId } });
      if (!credit || credit.balance < amount) {
        return {
          success: false,
          balanceAfter: credit?.balance ?? 0,
          error: "Insufficient credits",
        };
      }

      const newBalance = credit.balance - amount;
      await tx.iMCredit.update({
        where: { imUserId },
        data: {
          balance: newBalance,
          totalSpent: credit.totalSpent + amount,
        },
      });

      await tx.iMCreditTransaction.create({
        data: {
          creditId: credit.id,
          type: "usage",
          amount: -amount,
          balanceAfter: newBalance,
          description,
          referenceType: refType,
          referenceId: refId,
        },
      });

      return { success: true, balanceAfter: newBalance };
    });
  }

  async credit(
    imUserId: string,
    amount: number,
    type: string,
    description: string
  ): Promise<{ balanceAfter: number }> {
    await this.ensureCredit(imUserId);

    return this.prisma.$transaction(async (tx: any) => {
      const creditRecord = await tx.iMCredit.findUnique({
        where: { imUserId },
      });
      const newBalance = creditRecord!.balance + amount;

      await tx.iMCredit.update({
        where: { imUserId },
        data: {
          balance: newBalance,
          totalEarned: creditRecord!.totalEarned + amount,
        },
      });

      await tx.iMCreditTransaction.create({
        data: {
          creditId: creditRecord!.id,
          type,
          amount,
          balanceAfter: newBalance,
          description,
        },
      });

      return { balanceAfter: newBalance };
    });
  }

  async transfer(
    fromUserId: string,
    toUserId: string,
    amount: number,
    description?: string
  ): Promise<TransferResult> {
    if (amount <= 0) {
      return { success: false, senderBalanceAfter: 0, recipientBalanceAfter: 0, error: "Amount must be positive" };
    }

    await this.ensureCredit(fromUserId);
    await this.ensureCredit(toUserId);

    return this.prisma.$transaction(async (tx: any) => {
      const sender = await tx.iMCredit.findUnique({ where: { imUserId: fromUserId } });
      if (!sender) {
        return { success: false, senderBalanceAfter: 0, recipientBalanceAfter: 0, error: "Sender not found" };
      }

      // Non-transferable reserve (REGISTRATION_BONUS); 0 = all balance is transferable
      const transferableBalance = Math.max(0, sender.balance - REGISTRATION_BONUS);
      if (amount > transferableBalance) {
        return {
          success: false,
          senderBalanceAfter: sender.balance,
          recipientBalanceAfter: 0,
          error: `Insufficient transferable credits. Balance: ${sender.balance}, non-transferable reserve: ${REGISTRATION_BONUS}, transferable: ${transferableBalance}`,
        };
      }

      const recipient = await tx.iMCredit.findUnique({ where: { imUserId: toUserId } });
      if (!recipient) {
        return { success: false, senderBalanceAfter: sender.balance, recipientBalanceAfter: 0, error: "Recipient not found" };
      }

      const senderNewBalance = sender.balance - amount;
      const recipientNewBalance = recipient.balance + amount;
      const desc = description || `Transfer to ${toUserId}`;

      await tx.iMCredit.update({
        where: { imUserId: fromUserId },
        data: { balance: senderNewBalance, totalSpent: sender.totalSpent + amount },
      });
      await tx.iMCredit.update({
        where: { imUserId: toUserId },
        data: { balance: recipientNewBalance, totalEarned: recipient.totalEarned + amount },
      });

      await tx.iMCreditTransaction.create({
        data: {
          creditId: sender.id,
          type: "transfer_out",
          amount: -amount,
          balanceAfter: senderNewBalance,
          description: desc,
          referenceType: "transfer",
          referenceId: toUserId,
        },
      });
      await tx.iMCreditTransaction.create({
        data: {
          creditId: recipient.id,
          type: "transfer_in",
          amount,
          balanceAfter: recipientNewBalance,
          description: `Transfer from ${fromUserId}`,
          referenceType: "transfer",
          referenceId: fromUserId,
        },
      });

      return { success: true, senderBalanceAfter: senderNewBalance, recipientBalanceAfter: recipientNewBalance };
    });
  }

  async getTransactions(
    imUserId: string,
    limit: number,
    offset: number
  ): Promise<{ transactions: CreditTx[]; total: number }> {
    await this.ensureCredit(imUserId);

    const creditRecord = await this.prisma.iMCredit.findUnique({
      where: { imUserId },
    });
    if (!creditRecord) {
      return { transactions: [], total: 0 };
    }

    const [transactions, total] = await Promise.all([
      this.prisma.iMCreditTransaction.findMany({
        where: { creditId: creditRecord.id },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.iMCreditTransaction.count({
        where: { creditId: creditRecord.id },
      }),
    ]);

    return {
      transactions: transactions.map((t: any) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        balanceAfter: t.balanceAfter,
        description: t.description,
        referenceType: t.referenceType,
        referenceId: t.referenceId,
        createdAt: t.createdAt,
      })),
      total,
    };
  }
}

/**
 * Cloud credit service — bridges to existing pc_user_credits system.
 * For production / MySQL environment.
 *
 * Maps IM user IDs to cloud user IDs via im_users.userId field,
 * then delegates to pc_user_credits / pc_credit_transactions via mysql2.
 */
export class CloudCreditService implements CreditService {
  private prisma: any;

  constructor(prismaClient: any) {
    this.prisma = prismaClient;
  }

  /**
   * Resolve IM user ID to cloud (numeric) user ID.
   * Uses im_users.userId field which stores the cloud user's ID.
   *
   * If the IM user has no linked cloud user, auto-assign a synthetic ID
   * based on a hash of the IM user ID (range: 900_000_000+).
   * This allows standalone IM users to have credits in MySQL mode.
   */
  private async resolveCloudUserId(imUserId: string): Promise<number> {
    const imUser = await this.prisma.iMUser.findUnique({
      where: { id: imUserId },
      select: { userId: true },
    });
    if (imUser?.userId) {
      return parseInt(imUser.userId, 10);
    }

    // Auto-assign synthetic cloud user ID for standalone IM users
    let hash = 0;
    for (let i = 0; i < imUserId.length; i++) {
      hash = ((hash << 5) - hash + imUserId.charCodeAt(i)) | 0;
    }
    const syntheticId = 900_000_000 + Math.abs(hash % 100_000_000);

    // Persist the link so it's stable across calls
    await this.prisma.iMUser.update({
      where: { id: imUserId },
      data: { userId: String(syntheticId) },
    });

    return syntheticId;
  }

  async ensureCredit(imUserId: string): Promise<void> {
    try {
      const cloudUserId = await this.resolveCloudUserId(imUserId);
      const { getUserCredits } = require("@/lib/db-credits");
      await getUserCredits(cloudUserId, IM_INITIAL_CREDITS);
    } catch {
      // No-op if IM user not linked to cloud account
    }
  }

  async getBalance(imUserId: string): Promise<CreditBalance> {
    try {
      const cloudUserId = await this.resolveCloudUserId(imUserId);
      const { getUserCredits } = require("@/lib/db-credits");
      const credits = await getUserCredits(cloudUserId, IM_INITIAL_CREDITS);
      return {
        balance: credits.balance,
        totalEarned: credits.total_earned,
        totalSpent: credits.total_spent,
      };
    } catch {
      // IM user not linked to cloud account — return zero balance
      return { balance: 0, totalEarned: 0, totalSpent: 0 };
    }
  }

  async deduct(
    imUserId: string,
    amount: number,
    description: string,
    _refType?: string,
    refId?: string
  ): Promise<DeductResult> {
    try {
      await this.ensureCredit(imUserId);
      const cloudUserId = await this.resolveCloudUserId(imUserId);
      const { deductCredits } = require("@/lib/db-credits");
      const result = await deductCredits(
        cloudUserId,
        amount,
        description,
        refId
      );
      return {
        success: result.success,
        balanceAfter: result.balance_after,
        error: result.error,
      };
    } catch (e: any) {
      return {
        success: false,
        balanceAfter: 0,
        error: e.message || "Cloud credit deduction failed",
      };
    }
  }

  async credit(
    imUserId: string,
    amount: number,
    type: string,
    description: string
  ): Promise<{ balanceAfter: number }> {
    try {
      const cloudUserId = await this.resolveCloudUserId(imUserId);
      const { addCredits } = require("@/lib/db-credits");
      const result = await addCredits(
        cloudUserId,
        amount,
        type as "purchase" | "refund" | "bonus" | "gift",
        description
      );
      return { balanceAfter: result.balance_after };
    } catch {
      return { balanceAfter: 0 };
    }
  }

  async transfer(
    fromUserId: string,
    toUserId: string,
    amount: number,
    description?: string
  ): Promise<TransferResult> {
    if (amount <= 0) {
      return { success: false, senderBalanceAfter: 0, recipientBalanceAfter: 0, error: "Amount must be positive" };
    }

    try {
      const senderCloudId = await this.resolveCloudUserId(fromUserId);
      const recipientCloudId = await this.resolveCloudUserId(toUserId);

      const { deductCredits, addCredits } = require("@/lib/db-credits");
      const { withTransaction } = require("@/lib/db");

      return await withTransaction(async (conn: any) => {
        // Read balance with FOR UPDATE lock to prevent race conditions
        const [balanceRows] = await conn.execute(
          `SELECT * FROM pc_user_credits WHERE user_id = ? FOR UPDATE`,
          [senderCloudId]
        );
        if (balanceRows.length === 0) {
          // Auto-init if missing
          await conn.execute(
            `INSERT INTO pc_user_credits (user_id, balance, total_earned, total_spent, plan) VALUES (?, ?, ?, 0, 'free')`,
            [senderCloudId, IM_INITIAL_CREDITS, IM_INITIAL_CREDITS]
          );
          // New user with only bonus credits — nothing transferable
          return {
            success: false,
            senderBalanceAfter: IM_INITIAL_CREDITS,
            recipientBalanceAfter: 0,
            error: `Insufficient transferable credits. All ${IM_INITIAL_CREDITS} credits are non-transferable bonus.`,
          };
        }
        const senderBalance = parseFloat(balanceRows[0].balance as unknown as string);

        // Query total bonus credits within the same transaction connection
        const [bonusRows] = await conn.execute(
          `SELECT COALESCE(SUM(amount), 0) as total_bonus FROM pc_credit_transactions WHERE user_id = ? AND type = 'bonus' AND amount > 0`,
          [senderCloudId]
        );
        const totalBonus = parseFloat(bonusRows[0]?.total_bonus ?? '0');
        const transferableBalance = Math.max(0, senderBalance - totalBonus);

        if (amount > transferableBalance) {
          return {
            success: false,
            senderBalanceAfter: senderBalance,
            recipientBalanceAfter: 0,
            error: `Insufficient transferable credits. Balance: ${senderBalance}, non-transferable bonus: ${totalBonus}, transferable: ${transferableBalance}`,
          };
        }

        const desc = description || `Transfer to ${toUserId}`;
        const deductResult = await deductCredits(senderCloudId, amount, desc, toUserId, conn);
        if (!deductResult.success) {
          return {
            success: false,
            senderBalanceAfter: deductResult.balance_after,
            recipientBalanceAfter: 0,
            error: deductResult.error,
          };
        }

        const creditResult = await addCredits(recipientCloudId, amount, "gift", `Transfer from ${fromUserId}`, "transfer", fromUserId);

        return {
          success: true,
          senderBalanceAfter: deductResult.balance_after,
          recipientBalanceAfter: creditResult.balance_after,
        };
      });
    } catch (e: any) {
      return {
        success: false,
        senderBalanceAfter: 0,
        recipientBalanceAfter: 0,
        error: e.message || "Transfer failed",
      };
    }
  }

  async getTransactions(
    imUserId: string,
    limit: number,
    offset: number
  ): Promise<{ transactions: CreditTx[]; total: number }> {
    try {
      const cloudUserId = await this.resolveCloudUserId(imUserId);
      const { getUserTransactions } = require("@/lib/db-credits");
      const page = Math.floor(offset / limit) + 1;
      const result = await getUserTransactions(cloudUserId, page, limit);
      return {
        transactions: result.transactions.map((t: any) => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          balanceAfter: t.balance_after,
          description: t.description,
          referenceType: t.reference_type,
          referenceId: t.reference_id,
          createdAt: t.created_at,
        })),
        total: result.total,
      };
    } catch {
      return { transactions: [], total: 0 };
    }
  }
}

/**
 * Factory: select credit service based on database provider.
 * Detects MySQL via DATABASE_URL prefix.
 */
export function createCreditService(prisma: any): CreditService {
  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("mysql://")) {
    return new CloudCreditService(prisma);
  }
  return new LocalCreditService(prisma);
}
