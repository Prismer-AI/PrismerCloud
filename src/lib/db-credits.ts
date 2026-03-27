/**
 * Database Operations for User Credits
 * 
 * 操作表：pc_user_credits, pc_credit_transactions
 * 前端先行实现，与后端解耦
 */

import { query, execute, queryOne, withTransaction, generateUUID } from './db';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';

// ============================================================================
// Types
// ============================================================================

export interface UserCredits {
  user_id: number;
  balance: number;
  total_earned: number;
  total_spent: number;
  plan: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreditTransaction {
  id: string;
  user_id: number;
  type: 'usage' | 'purchase' | 'refund' | 'bonus' | 'gift';
  amount: number;
  balance_after: number;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_at: Date;
}

// ============================================================================
// User Credits
// ============================================================================

/**
 * 获取用户积分信息（不存在则创建）
 * @param initialBalanceIfNew 仅当新创建时使用的初始额度（默认 1000）；IM 注册用户传 100000 以支持约 1 亿条消息
 */
export async function getUserCredits(
  userId: number,
  initialBalanceIfNew?: number
): Promise<UserCredits> {
  const sql = `SELECT * FROM pc_user_credits WHERE user_id = ?`;
  let row = await queryOne<UserCredits & RowDataPacket>(sql, [userId]);
  
  if (!row) {
    await initUserCredits(userId, initialBalanceIfNew ?? 1000);
    row = await queryOne<UserCredits & RowDataPacket>(sql, [userId]);
  }
  
  return {
    user_id: row!.user_id,
    balance: parseFloat(row!.balance as unknown as string),
    total_earned: parseFloat(row!.total_earned as unknown as string),
    total_spent: parseFloat(row!.total_spent as unknown as string),
    plan: row!.plan,
    created_at: row!.created_at,
    updated_at: row!.updated_at
  };
}

/**
 * 初始化新用户积分
 */
export async function initUserCredits(
  userId: number,
  initialBalance: number = 1000
): Promise<void> {
  const sql = `
    INSERT IGNORE INTO pc_user_credits (user_id, balance, total_earned, total_spent, plan)
    VALUES (?, ?, ?, 0, 'free')
  `;
  const result = await execute(sql, [userId, initialBalance, initialBalance]);

  // 仅当实际插入了新行时才记录初始赠送交易（INSERT IGNORE 在重复时 affectedRows=0）
  if (result.affectedRows > 0) {
    await createCreditTransaction({
      userId,
      type: 'bonus',
      amount: initialBalance,
      balanceAfter: initialBalance,
      description: 'Welcome bonus',
      referenceType: 'admin'
    });
  }
}

/**
 * 扣除积分（使用时）
 */
export async function deductCredits(
  userId: number,
  amount: number,
  description: string,
  referenceId?: string,
  externalConn?: PoolConnection
): Promise<{ success: boolean; balance_after: number; error?: string }> {
  const doDeduct = async (conn: PoolConnection) => {
    // 获取当前余额（加锁）
    const [rows] = await conn.execute<(UserCredits & RowDataPacket)[]>(
      `SELECT * FROM pc_user_credits WHERE user_id = ? FOR UPDATE`,
      [userId]
    );

    if (rows.length === 0) {
      // 用户不存在，先初始化
      await conn.execute(
        `INSERT INTO pc_user_credits (user_id, balance, total_earned, total_spent, plan) VALUES (?, 1000, 1000, 0, 'free')`,
        [userId]
      );
      const [newRows] = await conn.execute<(UserCredits & RowDataPacket)[]>(
        `SELECT * FROM pc_user_credits WHERE user_id = ? FOR UPDATE`,
        [userId]
      );
      rows.push(newRows[0]);
    }

    const currentBalance = parseFloat(rows[0].balance as unknown as string);

    // 检查余额是否足够
    if (currentBalance < amount) {
      return {
        success: false,
        balance_after: currentBalance,
        error: 'Insufficient credits'
      };
    }

    const newBalance = currentBalance - amount;
    const totalSpent = parseFloat(rows[0].total_spent as unknown as string) + amount;

    // 更新余额
    await conn.execute(
      `UPDATE pc_user_credits SET balance = ?, total_spent = ? WHERE user_id = ?`,
      [newBalance, totalSpent, userId]
    );

    // 记录交易
    const txId = generateUUID();
    await conn.execute(
      `INSERT INTO pc_credit_transactions (id, user_id, type, amount, balance_after, description, reference_type, reference_id)
       VALUES (?, ?, 'usage', ?, ?, ?, 'usage_record', ?)`,
      [txId, userId, -amount, newBalance, description, referenceId || null]
    );

    return {
      success: true,
      balance_after: newBalance
    };
  };

  // If an external connection is provided, use it directly (caller manages the transaction)
  if (externalConn) {
    return doDeduct(externalConn);
  }
  return withTransaction(doDeduct);
}

/**
 * 增加积分（充值/赠送）
 */
export async function addCredits(
  userId: number,
  amount: number,
  type: 'purchase' | 'refund' | 'bonus' | 'gift',
  description: string,
  referenceType?: string,
  referenceId?: string
): Promise<{ balance_after: number }> {
  return withTransaction(async (conn: PoolConnection) => {
    // 获取当前余额（加锁）
    const [rows] = await conn.execute<(UserCredits & RowDataPacket)[]>(
      `SELECT * FROM pc_user_credits WHERE user_id = ? FOR UPDATE`,
      [userId]
    );
    
    let currentBalance = 0;
    let totalEarned = 0;
    
    if (rows.length === 0) {
      // 用户不存在，先初始化（不包含 welcome bonus）
      await conn.execute(
        `INSERT INTO pc_user_credits (user_id, balance, total_earned, total_spent, plan) VALUES (?, 0, 0, 0, 'free')`,
        [userId]
      );
    } else {
      currentBalance = parseFloat(rows[0].balance as unknown as string);
      totalEarned = parseFloat(rows[0].total_earned as unknown as string);
    }
    
    const newBalance = currentBalance + amount;
    const newTotalEarned = totalEarned + amount;
    
    // 更新余额
    await conn.execute(
      `UPDATE pc_user_credits SET balance = ?, total_earned = ? WHERE user_id = ?`,
      [newBalance, newTotalEarned, userId]
    );
    
    // 记录交易
    const txId = generateUUID();
    await conn.execute(
      `INSERT INTO pc_credit_transactions (id, user_id, type, amount, balance_after, description, reference_type, reference_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [txId, userId, type, amount, newBalance, description, referenceType || null, referenceId || null]
    );
    
    return { balance_after: newBalance };
  });
}

// ============================================================================
// Credit Transactions
// ============================================================================

interface CreateTransactionParams {
  userId: number;
  type: 'usage' | 'purchase' | 'refund' | 'bonus' | 'gift';
  amount: number;
  balanceAfter: number;
  description: string;
  referenceType?: string;
  referenceId?: string;
}

/**
 * 创建交易记录（内部使用）
 */
async function createCreditTransaction(params: CreateTransactionParams): Promise<string> {
  const id = generateUUID();
  const sql = `
    INSERT INTO pc_credit_transactions (id, user_id, type, amount, balance_after, description, reference_type, reference_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  await execute(sql, [
    id,
    params.userId,
    params.type,
    params.amount,
    params.balanceAfter,
    params.description,
    params.referenceType || null,
    params.referenceId || null
  ]);
  return id;
}

/**
 * 获取用户交易记录
 */
export async function getUserTransactions(
  userId: number,
  page: number = 1,
  limit: number = 20
): Promise<{ transactions: CreditTransaction[]; total: number }> {
  const offset = (page - 1) * limit;
  
  // 获取总数
  const countSql = `SELECT COUNT(*) as total FROM pc_credit_transactions WHERE user_id = ?`;
  const countResult = await queryOne<{ total: number } & RowDataPacket>(countSql, [userId]);
  const total = countResult?.total || 0;
  
  // 获取记录
  const sql = `
    SELECT * FROM pc_credit_transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = await query<(CreditTransaction & RowDataPacket)[]>(sql, [userId, Number(limit), Number(offset)]);
  
  const transactions = rows.map(row => ({
    ...row,
    amount: parseFloat(row.amount as unknown as string),
    balance_after: parseFloat(row.balance_after as unknown as string)
  }));
  
  return { transactions, total };
}
