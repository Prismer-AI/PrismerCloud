/**
 * Feature Flags
 * 
 * 控制前端先行实现与后端代理的切换
 * 
 * 使用方式：
 * - true: 使用 Next.js 直连数据库（前端先行）
 * - false: 代理到后端 API
 * 
 * 环境变量：
 * - FF_USAGE_RECORD_LOCAL=true
 * - FF_ACTIVITIES_LOCAL=true
 * - FF_DASHBOARD_STATS_LOCAL=true
 * - FF_USER_CREDITS_LOCAL=true
 * - FF_BILLING_LOCAL=true
 */

/**
 * Feature Flags - 动态读取
 * 
 * 使用 getter 确保每次访问时都读取最新的环境变量值
 * 这解决了 Nacos 配置异步加载的时序问题
 */
export const FEATURE_FLAGS = {
  /**
   * Usage Record API
   * POST /api/usage/record → 写入 pc_usage_records
   */
  get USAGE_RECORD_LOCAL(): boolean {
    const value = process.env.FF_USAGE_RECORD_LOCAL === 'true';
    return value;
  },
  
  /**
   * Activities API
   * GET /api/activities → 读取 pc_usage_records
   */
  get ACTIVITIES_LOCAL(): boolean {
    const value = process.env.FF_ACTIVITIES_LOCAL === 'true';
    return value;
  },
  
  /**
   * Dashboard Stats API
   * GET /api/dashboard/stats → 聚合 pc_usage_records
   */
  get DASHBOARD_STATS_LOCAL(): boolean {
    const value = process.env.FF_DASHBOARD_STATS_LOCAL === 'true';
    return value;
  },
  
  /**
   * User Credits API
   * GET /api/credits/balance → 读取 pc_user_credits
   */
  get USER_CREDITS_LOCAL(): boolean {
    const value = process.env.FF_USER_CREDITS_LOCAL === 'true';
    return value;
  },
  
  /**
   * Billing API (Payment Methods, Topup, Subscriptions)
   * /api/billing/* → 直接调用 Stripe + 写入 pc_payment_methods, pc_payments
   */
  get BILLING_LOCAL(): boolean {
    const value = process.env.FF_BILLING_LOCAL === 'true';
    return value;
  },

  /**
   * API Key Management
   * /api/keys/* → 直接管理 pc_api_keys 表
   * api-guard.ts → 本地 DB 验证 API Key（替代后端探测）
   */
  get API_KEYS_LOCAL(): boolean {
    const value = process.env.FF_API_KEYS_LOCAL === 'true';
    return value;
  },

  /**
   * Context Cache (v1.6.0)
   * /api/context/load (withdraw) + /api/context/save (deposit)
   * → use Prisma im_context_cache (local) instead of backend /cloud/context/*
   */
  get CONTEXT_CACHE_LOCAL(): boolean {
    const value = process.env.FF_CONTEXT_CACHE_LOCAL === 'true';
    return value;
  },

  /**
   * Notifications API
   * /api/notifications → read/write pc_notifications
   */
  get NOTIFICATIONS_LOCAL(): boolean {
    return process.env.FF_NOTIFICATIONS_LOCAL === 'true';
  },
};

/**
 * 检查是否启用了任何本地实现
 */
export function isAnyLocalEnabled(): boolean {
  return (
    FEATURE_FLAGS.USAGE_RECORD_LOCAL ||
    FEATURE_FLAGS.ACTIVITIES_LOCAL ||
    FEATURE_FLAGS.DASHBOARD_STATS_LOCAL ||
    FEATURE_FLAGS.USER_CREDITS_LOCAL ||
    FEATURE_FLAGS.BILLING_LOCAL ||
    FEATURE_FLAGS.API_KEYS_LOCAL ||
    FEATURE_FLAGS.CONTEXT_CACHE_LOCAL ||
    FEATURE_FLAGS.NOTIFICATIONS_LOCAL
  );
}

/**
 * 获取当前启用的 Feature Flags
 */
export function getEnabledFlags(): string[] {
  const flags: string[] = [];
  if (FEATURE_FLAGS.USAGE_RECORD_LOCAL) flags.push('USAGE_RECORD_LOCAL');
  if (FEATURE_FLAGS.ACTIVITIES_LOCAL) flags.push('ACTIVITIES_LOCAL');
  if (FEATURE_FLAGS.DASHBOARD_STATS_LOCAL) flags.push('DASHBOARD_STATS_LOCAL');
  if (FEATURE_FLAGS.USER_CREDITS_LOCAL) flags.push('USER_CREDITS_LOCAL');
  if (FEATURE_FLAGS.BILLING_LOCAL) flags.push('BILLING_LOCAL');
  if (FEATURE_FLAGS.API_KEYS_LOCAL) flags.push('API_KEYS_LOCAL');
  if (FEATURE_FLAGS.CONTEXT_CACHE_LOCAL) flags.push('CONTEXT_CACHE_LOCAL');
  if (FEATURE_FLAGS.NOTIFICATIONS_LOCAL) flags.push('NOTIFICATIONS_LOCAL');
  return flags;
}

/**
 * 日志输出当前状态（用于调试）
 */
export function logFeatureFlags(): void {
  console.log('[Feature Flags]', {
    USAGE_RECORD_LOCAL: FEATURE_FLAGS.USAGE_RECORD_LOCAL,
    ACTIVITIES_LOCAL: FEATURE_FLAGS.ACTIVITIES_LOCAL,
    DASHBOARD_STATS_LOCAL: FEATURE_FLAGS.DASHBOARD_STATS_LOCAL,
    USER_CREDITS_LOCAL: FEATURE_FLAGS.USER_CREDITS_LOCAL,
    BILLING_LOCAL: FEATURE_FLAGS.BILLING_LOCAL,
    API_KEYS_LOCAL: FEATURE_FLAGS.API_KEYS_LOCAL,
    CONTEXT_CACHE_LOCAL: FEATURE_FLAGS.CONTEXT_CACHE_LOCAL,
    NOTIFICATIONS_LOCAL: FEATURE_FLAGS.NOTIFICATIONS_LOCAL,
  });
}

export default FEATURE_FLAGS;
