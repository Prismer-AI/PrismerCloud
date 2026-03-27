/**
 * Admin Analytics — Platform-Level Aggregate Queries
 *
 * 平台级统计数据，用于内部管理后台 /admin/analytics
 * 数据源：pc_usage_records, pc_user_credits, pc_credit_transactions,
 *         pc_payments, pc_subscriptions, pc_api_keys + Prisma (im_*)
 *
 * Layer 1: Latency distribution, IM message types, agent online rate, credit by type
 * Layer 2: v1.7.2 feature usage, external API metrics, connection counts
 */

import { query, queryOne } from './db';
import prisma from './prisma';
import type { RowDataPacket } from 'mysql2/promise';
import { metrics } from './metrics';
import type { MetricsSnapshot } from './metrics';

// ============================================================================
// Types
// ============================================================================

export interface AdminAnalyticsData {
  overview: {
    totalUsers: number;
    activeUsers30d: number;
    totalApiKeys: number;
    activeApiKeys: number;
    totalBalance: number;
    creditsUsed30d: number;
    revenue30d: number;
  };
  usage: {
    chart: Array<{ date: string; requests: number; credits: number; activeUsers: number }>;
    byType: Array<{ type: string; count: number; credits: number; avgTime: number }>;
    cacheHitRate: number;
    avgProcessingTime: number;
    errorRate: number;
  };
  im: {
    chart: Array<{ date: string; messages: number }>;
    totalUsers: number;
    totalAgents: number;
    totalMessages: number;
    activeConversations: number;
    topAgents: Array<{ userId: string; username: string; displayName: string; messageCount: number }>;
  };
  revenue: {
    chart: Array<{ date: string; revenue: number; creditsSold: number }>;
    totalRevenue: number;
    totalPayments: number;
    avgPayment: number;
    totalCreditsSold: number;
    planDistribution: Array<{ plan: string; count: number }>;
  };
  topUsers: Array<{ userId: number; requests: number; creditsUsed: number; lastActive: string }>;
  // Layer 1: Observability
  latency: {
    p50: number;
    p95: number;
    p99: number;
    byEndpoint: Array<{ endpoint: string; p50: number; p95: number; count: number }>;
  };
  imDetail: {
    messagesByType: Array<{ type: string; count: number }>;
    agentOnlineRate: number;
    onlineAgents: number;
    totalAgentsWithCard: number;
  };
  creditsByType: Array<{ date: string; context: number; parse: number; im: number; other: number }>;
  // Layer 2: Feature usage + runtime metrics
  features: {
    tasks: { total: number; completed: number; failed: number; pending: number };
    memoryFiles: number;
    memoryAgents: number;
    evolutionCapsules: { total: number; success: number; failed: number };
    evolutionAgents: number;
    signingKeys: number;
    signedMessages: number;
  };
  evolutionExperiment: {
    standard: {
      ssr: number | null;
      rp: number | null;
      gd: number | null;
      er: number | null;
      totalCapsules: number;
    } | null;
    hypergraph: {
      ssr: number | null;
      rp: number | null;
      gd: number | null;
      er: number | null;
      totalCapsules: number;
    } | null;
    verdict: string;
  } | null;
  realtime: MetricsSnapshot;
}

// ============================================================================
// Helpers
// ============================================================================

function parseDays(period: string): number {
  if (period === '90d') return 90;
  if (period === '30d') return 30;
  return 7;
}

function fillDates(rows: Array<Record<string, any>>, days: number, defaults: Record<string, any>): any[] {
  const map = new Map<string, any>();
  for (const row of rows) {
    const d = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).slice(0, 10);
    map.set(d, row);
  }
  const result: any[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - i);
    const key = dt.toISOString().split('T')[0];
    result.push(map.get(key) || { date: key, ...defaults });
  }
  return result;
}

// ============================================================================
// Platform Overview
// ============================================================================

async function getOverview() {
  const [totalUsers, activeUsers, apiKeys, balance, credits30d, revenue30d] = await Promise.all([
    queryOne<{ cnt: number } & RowDataPacket>(`SELECT COUNT(*) as cnt FROM pc_user_credits`, []),
    queryOne<{ cnt: number } & RowDataPacket>(
      `SELECT COUNT(DISTINCT user_id) as cnt FROM pc_usage_records
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status = 'completed'`,
      [],
    ),
    queryOne<{ total: number; active: number } & RowDataPacket>(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active
       FROM pc_api_keys`,
      [],
    ),
    queryOne<{ val: string } & RowDataPacket>(`SELECT COALESCE(SUM(balance), 0) as val FROM pc_user_credits`, []),
    queryOne<{ val: string } & RowDataPacket>(
      `SELECT COALESCE(SUM(total_credits), 0) as val FROM pc_usage_records
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status = 'completed'`,
      [],
    ),
    queryOne<{ val: string } & RowDataPacket>(
      `SELECT COALESCE(SUM(amount_cents), 0) as val FROM pc_payments
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status = 'succeeded'`,
      [],
    ),
  ]);

  return {
    totalUsers: totalUsers?.cnt ?? 0,
    activeUsers30d: activeUsers?.cnt ?? 0,
    totalApiKeys: apiKeys?.total ?? 0,
    activeApiKeys: apiKeys?.active ?? 0,
    totalBalance: parseFloat(balance?.val ?? '0'),
    creditsUsed30d: parseFloat(credits30d?.val ?? '0'),
    revenue30d: parseFloat(revenue30d?.val ?? '0') / 100,
  };
}

// ============================================================================
// API Usage
// ============================================================================

async function getUsageStats(days: number) {
  const [chartRows, typeRows, metricsRow] = await Promise.all([
    query<Array<{ date: Date; requests: number; credits: string; active_users: number } & RowDataPacket>>(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as requests,
        COALESCE(SUM(total_credits), 0) as credits,
        COUNT(DISTINCT user_id) as active_users
       FROM pc_usage_records
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND status = 'completed'
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [days],
    ),
    query<Array<{ task_type: string; cnt: number; credits: string; avg_time: string } & RowDataPacket>>(
      `SELECT task_type, COUNT(*) as cnt,
        COALESCE(SUM(total_credits), 0) as credits,
        COALESCE(AVG(processing_time_ms), 0) as avg_time
       FROM pc_usage_records
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND status = 'completed'
       GROUP BY task_type ORDER BY cnt DESC`,
      [days],
    ),
    queryOne<
      {
        total_urls: number;
        cached_urls: number;
        error_count: number;
        total_count: number;
        avg_time: string;
      } & RowDataPacket
    >(
      `SELECT
        COALESCE(SUM(urls_processed), 0) as total_urls,
        COALESCE(SUM(urls_cached), 0) as cached_urls,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as error_count,
        COUNT(*) as total_count,
        COALESCE(AVG(processing_time_ms), 0) as avg_time
       FROM pc_usage_records
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days],
    ),
  ]);

  const chart = fillDates(
    chartRows.map((r) => ({
      date: r.date,
      requests: r.requests,
      credits: parseFloat(r.credits),
      activeUsers: r.active_users,
    })),
    days,
    { requests: 0, credits: 0, activeUsers: 0 },
  );

  const totalUrls = metricsRow?.total_urls ?? 0;
  const totalCount = metricsRow?.total_count ?? 0;
  const errorCount = metricsRow?.error_count ?? 0;

  return {
    chart,
    byType: typeRows.map((r) => ({
      type: r.task_type,
      count: r.cnt,
      credits: parseFloat(r.credits),
      avgTime: Math.round(parseFloat(r.avg_time)),
    })),
    cacheHitRate: totalUrls > 0 ? Math.round(((metricsRow?.cached_urls ?? 0) / totalUrls) * 100) : 0,
    avgProcessingTime: Math.round(parseFloat(metricsRow?.avg_time ?? '0')),
    errorRate: totalCount > 0 ? Math.round((errorCount / totalCount) * 10000) / 100 : 0,
  };
}

// ============================================================================
// IM & Agents (Prisma)
// ============================================================================

async function getIMStats(days: number) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totalUsers, totalAgents, totalMessages, activeConvs, dailyMsgs, topSenders] = await Promise.all([
    prisma.iMUser.count(),
    prisma.iMUser.count({ where: { role: 'agent' } }),
    prisma.iMMessage.count(),
    prisma.iMConversation.count({ where: { lastMessageAt: { gte: cutoff } } }),
    prisma.$queryRawUnsafe(
      `SELECT DATE(createdAt) as date, COUNT(*) as count FROM im_messages WHERE createdAt >= ? GROUP BY DATE(createdAt) ORDER BY date ASC`,
      cutoff,
    ) as Promise<Array<{ date: string; count: bigint }>>,
    prisma.iMMessage.groupBy({
      by: ['senderId'],
      _count: true,
      where: { createdAt: { gte: cutoff } },
      orderBy: { _count: { senderId: 'desc' } },
      take: 10,
    }),
  ]);

  // Resolve agent names
  const senderList = topSenders as Array<{ senderId: string; _count: number }>;
  const senderIds = senderList.map((a: { senderId: string }) => a.senderId);
  const agentUsers: Array<{ id: string; username: string; displayName: string }> =
    senderIds.length > 0
      ? await prisma.iMUser.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, username: true, displayName: true },
        })
      : [];
  const userMap = new Map(agentUsers.map((u: { id: string; username: string; displayName: string }) => [u.id, u]));

  const chart = fillDates(
    (dailyMsgs as any[]).map((r: any) => ({
      date: r.date,
      messages: Number(r.count),
    })),
    days,
    { messages: 0 },
  );

  return {
    chart,
    totalUsers,
    totalAgents,
    totalMessages,
    activeConversations: activeConvs,
    topAgents: senderList.map((a: { senderId: string; _count: number }) => ({
      userId: a.senderId,
      username: userMap.get(a.senderId)?.username ?? a.senderId,
      displayName: userMap.get(a.senderId)?.displayName ?? '',
      messageCount: a._count,
    })),
  };
}

// ============================================================================
// Revenue & Credits
// ============================================================================

async function getRevenueStats(days: number) {
  const [chartRows, totals, plans] = await Promise.all([
    query<Array<{ date: Date; revenue: string; credits_sold: string } & RowDataPacket>>(
      `SELECT DATE(created_at) as date,
        COALESCE(SUM(amount_cents), 0) as revenue,
        COALESCE(SUM(credits_purchased), 0) as credits_sold
       FROM pc_payments
       WHERE status = 'succeeded' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [days],
    ),
    queryOne<{ total_revenue: string; cnt: number; total_credits: string } & RowDataPacket>(
      `SELECT COALESCE(SUM(amount_cents), 0) as total_revenue,
        COUNT(*) as cnt,
        COALESCE(SUM(credits_purchased), 0) as total_credits
       FROM pc_payments
       WHERE status = 'succeeded' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days],
    ),
    query<Array<{ plan: string; cnt: number } & RowDataPacket>>(
      `SELECT plan, COUNT(*) as cnt FROM pc_user_credits GROUP BY plan ORDER BY cnt DESC`,
      [],
    ),
  ]);

  const chart = fillDates(
    chartRows.map((r) => ({
      date: r.date,
      revenue: parseFloat(r.revenue) / 100,
      creditsSold: parseFloat(r.credits_sold),
    })),
    days,
    { revenue: 0, creditsSold: 0 },
  );

  const totalRevenue = parseFloat(totals?.total_revenue ?? '0') / 100;
  const totalPayments = totals?.cnt ?? 0;

  return {
    chart,
    totalRevenue,
    totalPayments,
    avgPayment: totalPayments > 0 ? Math.round((totalRevenue / totalPayments) * 100) / 100 : 0,
    totalCreditsSold: parseFloat(totals?.total_credits ?? '0'),
    planDistribution: plans.map((p) => ({ plan: p.plan || 'free', count: p.cnt })),
  };
}

// ============================================================================
// Top Users
// ============================================================================

async function getTopUsers(days: number) {
  const rows = await query<
    Array<{ user_id: number; requests: number; credits_used: string; last_active: Date } & RowDataPacket>
  >(
    `SELECT user_id, COUNT(*) as requests,
      COALESCE(SUM(total_credits), 0) as credits_used,
      MAX(created_at) as last_active
     FROM pc_usage_records
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND status = 'completed'
     GROUP BY user_id ORDER BY requests DESC LIMIT 20`,
    [days],
  );

  return rows.map((r) => ({
    userId: r.user_id,
    requests: r.requests,
    creditsUsed: parseFloat(r.credits_used),
    lastActive: r.last_active?.toISOString?.() ?? '',
  }));
}

// ============================================================================
// Layer 1: Latency Distribution (from pc_usage_records)
// ============================================================================

async function getLatencyDistribution(days: number) {
  // Fetch all latency values with task_type for app-layer percentile calculation
  // (avoids GROUP_CONCAT which has default 1024-byte limit in MySQL)
  const rows = await query<Array<{ processing_time_ms: number; task_type: string } & RowDataPacket>>(
    `SELECT processing_time_ms, task_type FROM pc_usage_records
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND status = 'completed' AND processing_time_ms IS NOT NULL
     ORDER BY processing_time_ms ASC`,
    [days],
  );

  const durations = rows.map((r) => r.processing_time_ms);
  const p50 = pct(durations, 0.5);
  const p95 = pct(durations, 0.95);
  const p99 = pct(durations, 0.99);

  // Group by task_type in application layer
  const byTypeMap = new Map<string, number[]>();
  for (const r of rows) {
    if (!byTypeMap.has(r.task_type)) byTypeMap.set(r.task_type, []);
    byTypeMap.get(r.task_type)!.push(r.processing_time_ms);
  }

  const byEndpoint = Array.from(byTypeMap.entries())
    .map(([type, times]) => ({
      endpoint: type,
      p50: pct(times, 0.5),
      p95: pct(times, 0.95),
      count: times.length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { p50, p95, p99, byEndpoint };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]);
}

// ============================================================================
// Layer 1: IM Detail Stats (message types, agent online rate)
// ============================================================================

async function getIMDetailStats(days: number) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const heartbeatCutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 min

  const [messagesByType, agentCards] = await Promise.all([
    prisma.iMMessage.groupBy({
      by: ['type'],
      _count: true,
      where: { createdAt: { gte: cutoff } },
      orderBy: { _count: { type: 'desc' } },
    }),
    prisma.iMAgentCard.findMany({
      select: { lastHeartbeat: true },
    }),
  ]);

  const totalAgentsWithCard = agentCards.length;
  const onlineAgents = agentCards.filter(
    (a: { lastHeartbeat: Date | null }) => a.lastHeartbeat && a.lastHeartbeat >= heartbeatCutoff,
  ).length;
  const agentOnlineRate = totalAgentsWithCard > 0 ? Math.round((onlineAgents / totalAgentsWithCard) * 100) / 100 : 0;

  return {
    messagesByType: (messagesByType as Array<{ type: string; _count: number }>).map((r) => ({
      type: r.type,
      count: r._count,
    })),
    agentOnlineRate,
    onlineAgents,
    totalAgentsWithCard,
  };
}

// ============================================================================
// Layer 1: Credits by Type (stacked area data)
// ============================================================================

async function getCreditsByType(days: number) {
  const rows = await query<
    Array<
      {
        date: Date;
        context_credits: string;
        parse_credits: string;
        im_credits: string;
        other_credits: string;
      } & RowDataPacket
    >
  >(
    `SELECT DATE(created_at) as date,
       COALESCE(SUM(CASE WHEN task_type IN ('context_load', 'context_save') THEN total_credits ELSE 0 END), 0) as context_credits,
       COALESCE(SUM(CASE WHEN task_type = 'parse' THEN total_credits ELSE 0 END), 0) as parse_credits,
       COALESCE(SUM(CASE WHEN task_type = 'im_message' THEN total_credits ELSE 0 END), 0) as im_credits,
       COALESCE(SUM(CASE WHEN task_type NOT IN ('context_load', 'context_save', 'parse', 'im_message') THEN total_credits ELSE 0 END), 0) as other_credits
     FROM pc_usage_records
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND status = 'completed'
     GROUP BY DATE(created_at) ORDER BY date ASC`,
    [days],
  );

  return fillDates(
    rows.map((r) => ({
      date: r.date,
      context: parseFloat(r.context_credits),
      parse: parseFloat(r.parse_credits),
      im: parseFloat(r.im_credits),
      other: parseFloat(r.other_credits),
    })),
    days,
    { context: 0, parse: 0, im: 0, other: 0 },
  );
}

// ============================================================================
// Layer 2: v1.7.2 Feature Usage
// ============================================================================

async function getFeatureUsage(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [taskStats, memoryFiles, memoryAgents, capsuleStats, evolutionAgents, signingKeys, signedMessages] =
    await Promise.all([
      // Tasks (within period)
      prisma.iMTask.groupBy({
        by: ['status'],
        _count: true,
        where: { createdAt: { gte: since } },
      }),
      // Memory (within period)
      prisma.iMMemoryFile.count({ where: { updatedAt: { gte: since } } }),
      prisma.iMMemoryFile
        .groupBy({ by: ['ownerId'], _count: true, where: { updatedAt: { gte: since } } })
        .then((r: unknown[]) => r.length),
      // Evolution (within period)
      prisma.iMEvolutionCapsule.groupBy({
        by: ['outcome'],
        _count: true,
        where: { createdAt: { gte: since } },
      }),
      prisma.iMEvolutionCapsule
        .groupBy({ by: ['ownerAgentId'], _count: true, where: { createdAt: { gte: since } } })
        .then((r: unknown[]) => r.length),
      // Signing (all-time for keys, within period for signed messages)
      prisma.iMIdentityKey.count(),
      prisma.iMMessage.count({ where: { signature: { not: null }, createdAt: { gte: since } } }),
    ]);

  const tasksByStatus = Object.fromEntries(
    (taskStats as Array<{ status: string; _count: number }>).map((r) => [r.status, r._count]),
  );
  const capsulesByOutcome = Object.fromEntries(
    (capsuleStats as Array<{ outcome: string; _count: number }>).map((r) => [r.outcome, r._count]),
  );

  return {
    tasks: {
      total: Object.values(tasksByStatus).reduce((a: number, b: number) => a + b, 0),
      completed: (tasksByStatus['completed'] ?? 0) as number,
      failed: (tasksByStatus['failed'] ?? 0) as number,
      pending: ((tasksByStatus['pending'] ?? 0) +
        (tasksByStatus['assigned'] ?? 0) +
        (tasksByStatus['running'] ?? 0)) as number,
    },
    memoryFiles,
    memoryAgents,
    evolutionCapsules: {
      total: Object.values(capsulesByOutcome).reduce((a: number, b: number) => a + b, 0),
      success: (capsulesByOutcome['success'] ?? 0) as number,
      failed: (capsulesByOutcome['failed'] ?? 0) as number,
    },
    evolutionAgents,
    signingKeys,
    signedMessages,
  };
}

// ============================================================================
// Evolution A/B Experiment Metrics
// ============================================================================

async function getEvolutionExperiment() {
  try {
    const [std, hyper] = await Promise.all([
      prisma.iMEvolutionMetrics.findFirst({ where: { mode: 'standard', scope: 'global' }, orderBy: { ts: 'desc' } }),
      prisma.iMEvolutionMetrics.findFirst({ where: { mode: 'hypergraph', scope: 'global' }, orderBy: { ts: 'desc' } }),
    ]);
    let verdict = 'insufficient_data';
    if (std && hyper && std.totalCapsules >= 200 && hyper.totalCapsules >= 200) {
      if (hyper.ssr != null && std.ssr != null) {
        const delta = hyper.ssr - std.ssr;
        verdict = delta > 0.05 ? 'hypergraph_better' : delta < -0.05 ? 'standard_better' : 'no_significant_difference';
      }
    }
    return {
      standard: std ? { ssr: std.ssr, rp: std.rp, gd: std.gd, er: std.er, totalCapsules: std.totalCapsules } : null,
      hypergraph: hyper
        ? { ssr: hyper.ssr, rp: hyper.rp, gd: hyper.gd, er: hyper.er, totalCapsules: hyper.totalCapsules }
        : null,
      verdict,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function getAdminAnalytics(period: string = '30d'): Promise<AdminAnalyticsData> {
  const days = parseDays(period);

  const results = await Promise.allSettled([
    getOverview(),
    getUsageStats(days),
    getIMStats(days),
    getRevenueStats(days),
    getTopUsers(days),
    getLatencyDistribution(days),
    getIMDetailStats(days),
    getCreditsByType(days),
    getFeatureUsage(days),
    getEvolutionExperiment(),
  ]);

  const settled = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled'
      ? r.value
      : (console.error('[AdminAnalytics] Query failed:', (r as PromiseRejectedResult).reason), fallback);

  const emptyOverview = {
    totalUsers: 0,
    activeUsers30d: 0,
    totalApiKeys: 0,
    activeApiKeys: 0,
    totalBalance: 0,
    creditsUsed30d: 0,
    revenue30d: 0,
  };
  const emptyUsage = { chart: [], byType: [], cacheHitRate: 0, avgProcessingTime: 0, errorRate: 0 };
  const emptyIM = { chart: [], totalUsers: 0, totalAgents: 0, totalMessages: 0, activeConversations: 0, topAgents: [] };
  const emptyRevenue = {
    chart: [],
    totalRevenue: 0,
    totalPayments: 0,
    avgPayment: 0,
    totalCreditsSold: 0,
    planDistribution: [],
  };
  const emptyLatency = { p50: 0, p95: 0, p99: 0, byEndpoint: [] };
  const emptyImDetail = { messagesByType: [], agentOnlineRate: 0, onlineAgents: 0, totalAgentsWithCard: 0 };
  const emptyFeatures = {
    tasks: { total: 0, completed: 0, failed: 0, pending: 0 },
    memoryFiles: 0,
    memoryAgents: 0,
    evolutionCapsules: { total: 0, success: 0, failed: 0 },
    evolutionAgents: 0,
    signingKeys: 0,
    signedMessages: 0,
  };
  const realtime = metrics.getSnapshot();

  return {
    overview: settled(results[0], emptyOverview),
    usage: settled(results[1], emptyUsage),
    im: settled(results[2], emptyIM),
    revenue: settled(results[3], emptyRevenue),
    topUsers: settled(results[4], []),
    latency: settled(results[5], emptyLatency),
    imDetail: settled(results[6], emptyImDetail),
    creditsByType: settled(results[7], []),
    features: settled(results[8], emptyFeatures),
    evolutionExperiment: settled(results[9], null),
    realtime,
  };
}
