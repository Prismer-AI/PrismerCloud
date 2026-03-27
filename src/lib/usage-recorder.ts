/**
 * Usage Recorder - 使用量记录工具
 * 
 * 用于在 API 调用完成后自动记录使用量
 * 支持 load, save, compress, search, parse 等操作类型
 * 
 * Feature Flag: FF_USAGE_RECORD_LOCAL
 * - true: 直连数据库 (pc_usage_records)
 * - false: 代理到后端
 */

import { getBackendApiBase } from './backend-api';
import { FEATURE_FLAGS } from './feature-flags';
import { getUserFromAuth } from './auth-utils';
import { createUsageRecord } from './db-usage';
import { deductCredits, getUserCredits } from './db-credits';
import { withTransaction } from './db';
import { ensureNacosConfig } from './nacos-config';
import { emitLowCreditAlert } from './notification-emitter';

// ============================================================================
// 定价模型 (基于成本 + 利润率 50%)
// ============================================================================
// 
// 成本基线:
//   - OCR (Parse): 1000页 = $2, 即 $0.002/页
//   - 大模型输出: $8/百万 tokens, 即 $0.008/1K tokens
//   - Exa 搜索: ~$0.02/次
// 
// Credit 换算 (1 Credit = $0.002):
// 
// | 操作 | 成本 | 售价(50%利润) | Credits |
// |------|------|---------------|---------|
// | Parse Fast | $0.002/页 | $0.004/页 | 2 |
// | Parse HiRes (含图片) | $0.005/页 | $0.01/页 | 5 |
// | 压缩 (HQCC) | $0.008/1K tokens | $0.016/1K | 8/1K (0.008/token) |
// | Exa 搜索 | $0.02/次 | $0.04/次 | 20 |
// | Load URL | 按压缩计费 | - | 按 tokens |
// | Save | 免费 | 免费 | 0 |
// | 缓存命中 | 免费 | 免费 | 0 |
// 
// 配置项格式 (在 Nacos 中设置):
//   PRICING_SEARCH_CREDIT_COST=20
//   PRICING_COMPRESSION_TOKEN_RATE=0.008
//   PRICING_PARSE_FAST_PAGE_COST=2
//   PRICING_PARSE_HIRES_PAGE_COST=5
//   PRICING_PARSE_HIRES_IMAGE_COST=0
// ============================================================================

// 默认值 (Nacos 未配置时使用)
const DEFAULT_PRICING = {
  // Exa 搜索: 20 credits/次
  // 成本: ~$0.02/次, 售价: $0.04/次, 利润率 50%
  SEARCH_CREDIT_COST: 20,
  
  // 大模型压缩 (HQCC): 0.008 credits/token = 8 credits/1K tokens
  // 成本: $0.008/1K, 售价: $0.016/1K, 利润率 50%
  COMPRESSION_TOKEN_RATE: 0.008,
  
  // 缓存命中不收费
  CACHE_HIT_CREDIT: 0,
  
  // Parse Fast: 2 credits/页
  // 成本: $0.002/页, 售价: $0.004/页, 利润率 50%
  PARSE_FAST_PAGE_COST: 2,
  
  // Parse HiRes: 5 credits/页 (含图片提取)
  // 成本: ~$0.005/页, 售价: $0.01/页, 利润率 50%
  PARSE_HIRES_PAGE_COST: 5,
  
  // HiRes 图片: 0 credits (已包含在页面费用中)
  PARSE_HIRES_IMAGE_COST: 0,

  // IM API 定价 (极低费用，主要用于跟踪使用量)
  // 0.001 credits ≈ $0.000002
  IM_SEND_MESSAGE_COST: 0.001,      // 发送消息
  IM_WORKSPACE_INIT_COST: 0.01,    // 初始化 Workspace
  IM_AGENT_INGEST_COST: 0.001,     // Agent 内容处理

  // IM 文件上传: 0.5 credits/MB
  // 成本: ~$0.0005/MB (S3 PUT + bandwidth), 售价: $0.001/MB, 利润率 50%
  IM_FILE_UPLOAD_COST_PER_MB: 0.5,
};

// 动态获取定价配置
export const PRICING = {
  get SEARCH_CREDIT_COST(): number {
    return parseFloat(process.env.PRICING_SEARCH_CREDIT_COST || '') || DEFAULT_PRICING.SEARCH_CREDIT_COST;
  },
  get COMPRESSION_TOKEN_RATE(): number {
    return parseFloat(process.env.PRICING_COMPRESSION_TOKEN_RATE || '') || DEFAULT_PRICING.COMPRESSION_TOKEN_RATE;
  },
  get CACHE_HIT_CREDIT(): number {
    return parseFloat(process.env.PRICING_CACHE_HIT_CREDIT || '') || DEFAULT_PRICING.CACHE_HIT_CREDIT;
  },
  get PARSE_FAST_PAGE_COST(): number {
    return parseFloat(process.env.PRICING_PARSE_FAST_PAGE_COST || '') || DEFAULT_PRICING.PARSE_FAST_PAGE_COST;
  },
  get PARSE_HIRES_PAGE_COST(): number {
    return parseFloat(process.env.PRICING_PARSE_HIRES_PAGE_COST || '') || DEFAULT_PRICING.PARSE_HIRES_PAGE_COST;
  },
  get PARSE_HIRES_IMAGE_COST(): number {
    return parseFloat(process.env.PRICING_PARSE_HIRES_IMAGE_COST || '') || DEFAULT_PRICING.PARSE_HIRES_IMAGE_COST;
  },
  // IM API
  get IM_SEND_MESSAGE_COST(): number {
    return parseFloat(process.env.PRICING_IM_SEND_MESSAGE_COST || '') || DEFAULT_PRICING.IM_SEND_MESSAGE_COST;
  },
  get IM_WORKSPACE_INIT_COST(): number {
    return parseFloat(process.env.PRICING_IM_WORKSPACE_INIT_COST || '') || DEFAULT_PRICING.IM_WORKSPACE_INIT_COST;
  },
  get IM_AGENT_INGEST_COST(): number {
    return parseFloat(process.env.PRICING_IM_AGENT_INGEST_COST || '') || DEFAULT_PRICING.IM_AGENT_INGEST_COST;
  },
  get IM_FILE_UPLOAD_COST_PER_MB(): number {
    return parseFloat(process.env.PRICING_IM_FILE_UPLOAD_COST_PER_MB || '') || DEFAULT_PRICING.IM_FILE_UPLOAD_COST_PER_MB;
  },
};

// 使用量指标
export interface UsageMetrics {
  exa_searches?: number;
  urls_processed?: number;
  urls_cached?: number;
  urls_compressed?: number;
  tokens_input?: number;
  tokens_output?: number;
  processing_time_ms?: number;
  // Parse 相关
  pages_parsed?: number;
  images_extracted?: number;
  parse_mode?: 'fast' | 'hires' | 'auto';
}

// 费用明细
export interface UsageCost {
  search_credits?: number;
  compression_credits?: number;
  parse_credits?: number;
  total_credits: number;
}

// 来源详情
export interface UsageSource {
  url: string;
  cached: boolean;
  tokens: number;
}

// 完整的使用记录请求
export interface UsageRecordRequest {
  task_id: string;
  task_type: 'load' | 'save' | 'search' | 'compress' | 'parse' | 'send' | 'receive' | 'agent_ingest' | 'file_upload';
  input: {
    type: 'query' | 'url' | 'urls' | 'file' | 'content';
    value: string;
  };
  metrics: UsageMetrics;
  cost: UsageCost;
  sources?: UsageSource[];
}

/**
 * 生成唯一任务 ID
 */
export function generateTaskId(prefix: string = 'task'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * 计算费用
 */
export function calculateCost(metrics: UsageMetrics): UsageCost {
  const searchCredits = (metrics.exa_searches || 0) * PRICING.SEARCH_CREDIT_COST;
  const tokensTotal = (metrics.tokens_input || 0) + (metrics.tokens_output || 0);
  const compressionCredits = tokensTotal * PRICING.COMPRESSION_TOKEN_RATE;
  
  // Parse 费用计算 (根据模式区分)
  let parseCredits = 0;
  if (metrics.pages_parsed) {
    const isHires = metrics.parse_mode === 'hires';
    const pageRate = isHires ? PRICING.PARSE_HIRES_PAGE_COST : PRICING.PARSE_FAST_PAGE_COST;
    parseCredits = metrics.pages_parsed * pageRate;
    
    // HiRes 模式还要计算图片费用
    if (isHires && metrics.images_extracted) {
      parseCredits += metrics.images_extracted * PRICING.PARSE_HIRES_IMAGE_COST;
    }
  }
  
  return {
    search_credits: Math.round(searchCredits * 10000) / 10000,
    compression_credits: Math.round(compressionCredits * 10000) / 10000,
    parse_credits: parseCredits > 0 ? Math.round(parseCredits * 10000) / 10000 : undefined,
    total_credits: Math.round((searchCredits + compressionCredits + parseCredits) * 10000) / 10000
  };
}

/**
 * 记录使用量 (异步后台执行，不阻塞主流程)
 * 
 * @param record - 使用记录请求
 * @param authHeader - 认证头 (Bearer token)
 * @returns Promise<boolean> - 是否成功记录
 */
export async function recordUsage(
  record: UsageRecordRequest,
  authHeader: string | null
): Promise<boolean> {
  // 如果没有认证，跳过记录
  if (!authHeader) {
    console.log('[UsageRecorder] Skipping - no auth header');
    return false;
  }

  try {
    // 确保 Nacos 配置已加载
    await ensureNacosConfig();
    
    // 检查 Feature Flag
    const useLocal = FEATURE_FLAGS.USAGE_RECORD_LOCAL;
    console.log(`[UsageRecorder] FF_USAGE_RECORD_LOCAL=${process.env.FF_USAGE_RECORD_LOCAL}, useLocal=${useLocal}`);
    
    if (useLocal) {
      return recordUsageLocal(record, authHeader);
    } else {
      return recordUsageProxy(record, authHeader);
    }
  } catch (error) {
    console.error('[UsageRecorder] Error:', error);
    return false;
  }
}

/**
 * 本地实现：直连数据库
 */
async function recordUsageLocal(
  record: UsageRecordRequest,
  authHeader: string
): Promise<boolean> {
  console.log('[UsageRecorder] Using LOCAL implementation');
  
  try {
    // 解析用户 ID
    const authResult = await getUserFromAuth(authHeader);
    if (!authResult.success || !authResult.user) {
      console.error('[UsageRecorder] Auth failed:', authResult.error);
      return false;
    }
    
    const userId = authResult.user.id;
    const totalCredits = record.cost?.total_credits || 0;
    
    console.log(`[UsageRecorder] User: ${userId}, Task: ${record.task_id}, Credits: ${totalCredits}`);

    // 注意：input.type 可能包含 'content'，需要映射到数据库支持的类型
    const inputType = record.input.type === 'content' ? 'file' : record.input.type;
    const usageInput = {
      task_id: record.task_id,
      task_type: record.task_type,
      input: {
        type: inputType as 'query' | 'url' | 'urls' | 'file',
        value: record.input.value
      },
      metrics: record.metrics,
      cost: record.cost,
      sources: record.sources,
      status: 'completed' as const
    };

    // Atomic: create usage record + deduct credits in a single transaction
    let recordId: string;
    let creditsRemaining = 0;

    if (totalCredits > 0) {
      const result = await withTransaction(async (conn) => {
        // 1. 创建使用记录
        const { id } = await createUsageRecord(userId, usageInput, conn);

        // 2. 扣除积分
        const description = `${record.task_type}: ${record.input?.value?.substring(0, 50) || 'unknown'}`;
        const deductResult = await deductCredits(userId, totalCredits, description, id, conn);

        if (!deductResult.success) {
          console.warn('[UsageRecorder] Credits deduction failed:', deductResult.error);
        }

        return { recordId: id, creditsRemaining: deductResult.balance_after };
      });

      recordId = result.recordId;
      creditsRemaining = result.creditsRemaining;
    } else {
      // No credits to deduct — no need for a transaction
      const { id } = await createUsageRecord(userId, usageInput);
      recordId = id;
      const credits = await getUserCredits(userId);
      creditsRemaining = credits.balance;
    }

    console.log('[UsageRecorder] Recorded successfully (LOCAL):', {
      task_id: record.task_id,
      task_type: record.task_type,
      record_id: recordId,
      credits_deducted: totalCredits,
      credits_remaining: creditsRemaining
    });

    // Fire-and-forget: check if credits are low
    emitLowCreditAlert(userId, creditsRemaining);

    return true;
  } catch (error) {
    console.error('[UsageRecorder] Local record error:', error);
    return false;
  }
}

/**
 * 代理实现：调用后端 API
 */
async function recordUsageProxy(
  record: UsageRecordRequest,
  authHeader: string
): Promise<boolean> {
  const backendBase = await getBackendApiBase();
  const url = `${backendBase}/cloud/usage/record`;
  
  // 清理 undefined 字段，确保 JSON 格式正确
  const cleanRecord = {
    task_id: record.task_id,
    task_type: record.task_type,
    input: record.input,
    metrics: {
      exa_searches: record.metrics.exa_searches || 0,
      urls_processed: record.metrics.urls_processed || 0,
      urls_cached: record.metrics.urls_cached || 0,
      urls_compressed: record.metrics.urls_compressed || 0,
      tokens_input: record.metrics.tokens_input || 0,
      tokens_output: record.metrics.tokens_output || 0,
      processing_time_ms: record.metrics.processing_time_ms || 0
    },
    cost: {
      search_credits: record.cost.search_credits || 0,
      compression_credits: record.cost.compression_credits || 0,
      total_credits: record.cost.total_credits || 0
    },
    sources: record.sources || []
  };
  
  console.log('[UsageRecorder] POST', url);
  console.log('[UsageRecorder] Request body:', JSON.stringify(cleanRecord, null, 2));
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify(cleanRecord)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[UsageRecorder] Failed to record:', errorData);
    console.error('[UsageRecorder] Response status:', response.status);
    return false;
  }

  const data = await response.json();
  console.log('[UsageRecorder] Recorded successfully:', {
    task_id: record.task_id,
    task_type: record.task_type,
    credits_deducted: data.data?.credits_deducted
  });
  return true;
}

/**
 * 后台记录使用量 (fire-and-forget)
 * 不等待结果，不阻塞主流程
 */
export function recordUsageBackground(
  record: UsageRecordRequest,
  authHeader: string | null
): void {
  if (!authHeader) {
    return;
  }

  // 异步执行，不等待
  recordUsage(record, authHeader).catch(err => {
    console.error('[UsageRecorder] Background record failed:', err);
  });
}

/**
 * 创建 Load API 的使用记录
 */
export function createLoadUsageRecord(params: {
  taskId: string;
  input: string;
  inputType: 'query' | 'url' | 'urls';
  searchCount: number;
  urlsProcessed: number;
  urlsCached: number;
  urlsCompressed: number;
  tokensInput?: number;
  tokensOutput?: number;
  processingTimeMs: number;
  sources?: UsageSource[];
}): UsageRecordRequest {
  const metrics: UsageMetrics = {
    exa_searches: params.searchCount,
    urls_processed: params.urlsProcessed,
    urls_cached: params.urlsCached,
    urls_compressed: params.urlsCompressed,
    tokens_input: params.tokensInput || 0,
    tokens_output: params.tokensOutput || 0,
    processing_time_ms: params.processingTimeMs
  };

  return {
    task_id: params.taskId,
    task_type: 'load',
    input: {
      type: params.inputType === 'urls' ? 'urls' : params.inputType,
      value: params.input
    },
    metrics,
    cost: calculateCost(metrics),
    sources: params.sources
  };
}

/**
 * 创建 Save API 的使用记录
 */
export function createSaveUsageRecord(params: {
  taskId: string;
  url: string;
  itemCount: number;
  processingTimeMs: number;
}): UsageRecordRequest {
  const metrics: UsageMetrics = {
    urls_processed: params.itemCount,
    processing_time_ms: params.processingTimeMs
  };

  // Save 操作目前免费
  return {
    task_id: params.taskId,
    task_type: 'save',
    input: {
      type: params.itemCount > 1 ? 'urls' : 'url',
      value: params.url
    },
    metrics,
    cost: { total_credits: 0 }
  };
}

/**
 * 创建 IM File Upload 的使用记录
 *
 * 费用计算: 0.5 credits/MB (可通过 PRICING_IM_FILE_UPLOAD_COST_PER_MB 配置)
 */
export function createFileUploadUsageRecord(params: {
  taskId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadId: string;
  processingTimeMs: number;
}): UsageRecordRequest {
  const fileSizeMB = params.fileSize / (1024 * 1024);
  const totalCredits = Math.round(fileSizeMB * PRICING.IM_FILE_UPLOAD_COST_PER_MB * 10000) / 10000;

  return {
    task_id: params.taskId,
    task_type: 'file_upload',
    input: {
      type: 'file',
      value: params.fileName,
    },
    metrics: {
      processing_time_ms: params.processingTimeMs,
    },
    cost: {
      total_credits: totalCredits,
    },
  };
}

/**
 * 创建 Parse API 的使用记录
 * 
 * 费用计算:
 * - Fast 模式: 0.01 credits/页
 * - HiRes 模式: 0.1 credits/页 + 0.05 credits/图
 */
export function createParseUsageRecord(params: {
  taskId: string;
  fileName: string;
  pageCount: number;
  imageCount?: number;
  mode?: 'fast' | 'hires' | 'auto';
  tokensOutput?: number;
  processingTimeMs: number;
}): UsageRecordRequest {
  const metrics: UsageMetrics = {
    pages_parsed: params.pageCount,
    images_extracted: params.imageCount || 0,
    parse_mode: params.mode || 'fast',
    tokens_output: params.tokensOutput || 0,
    processing_time_ms: params.processingTimeMs
  };

  return {
    task_id: params.taskId,
    task_type: 'parse',
    input: {
      type: 'file',
      value: params.fileName
    },
    metrics,
    cost: calculateCost(metrics)
  };
}
