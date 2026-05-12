-- =============================================================================
-- Prismer Cloud - 前端先行实现表
-- 版本: 1.0.0
-- 日期: 2026-01-25
-- 
-- 设计原则：
--   ✅ 不修改任何现有表 (users, api_keys, usage_records 等)
--   ✅ 新表使用 pc_ 前缀，与后端开发解耦
--   ✅ 后续迁移时，只需将数据迁移到后端正式表
-- 
-- 表命名：
--   pc_usage_records      - 使用量记录 (前端先行版)
--   pc_credit_transactions - 积分交易记录
--   pc_user_credits       - 用户积分余额快照
-- =============================================================================

USE prismer_info;

-- =============================================================================
-- Table 1: pc_usage_records - 使用量记录
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_usage_records (
  -- 主键
  id VARCHAR(36) PRIMARY KEY COMMENT '记录 UUID',
  
  -- 用户关联 (关联现有 users.id，但不建外键约束)
  user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID (对应 users.id)',
  
  -- 任务标识
  task_id VARCHAR(64) NOT NULL COMMENT '任务 ID (前端生成，唯一)',
  task_type VARCHAR(32) NOT NULL DEFAULT 'load' COMMENT '任务类型: load/save/parse/search/compress',
  
  -- 输入信息
  input_type VARCHAR(16) NOT NULL COMMENT '输入类型: url/urls/query/file',
  input_value TEXT NOT NULL COMMENT '输入值 (URL/查询内容/文件名)',
  
  -- 处理指标 (通用)
  exa_searches INT DEFAULT 0 COMMENT 'Exa 搜索调用次数',
  urls_processed INT DEFAULT 0 COMMENT '处理的 URL 总数',
  urls_cached INT DEFAULT 0 COMMENT '缓存命中数',
  urls_compressed INT DEFAULT 0 COMMENT '新压缩数',
  tokens_input BIGINT DEFAULT 0 COMMENT 'LLM 输入 tokens',
  tokens_output BIGINT DEFAULT 0 COMMENT 'LLM 输出 tokens',
  processing_time_ms BIGINT DEFAULT 0 COMMENT '处理时间 (毫秒)',
  
  -- Parse API 相关指标
  pages_parsed INT DEFAULT 0 COMMENT '解析的页数 (PDF/文档)',
  images_extracted INT DEFAULT 0 COMMENT '提取的图片数',
  parse_mode VARCHAR(16) DEFAULT NULL COMMENT '解析模式: fast/hires/auto',
  
  -- 费用明细
  search_credits DECIMAL(10,4) DEFAULT 0.0000 COMMENT '搜索费用',
  compression_credits DECIMAL(10,4) DEFAULT 0.0000 COMMENT '压缩费用',
  parse_credits DECIMAL(10,4) DEFAULT 0.0000 COMMENT '解析费用',
  total_credits DECIMAL(10,4) DEFAULT 0.0000 COMMENT '总费用',
  
  -- 详细信息
  sources_json JSON COMMENT '来源详情 [{url, cached, tokens}, ...]',
  error_message TEXT DEFAULT NULL COMMENT '错误信息 (如果失败)',
  status VARCHAR(16) DEFAULT 'completed' COMMENT '状态: completed/failed/processing',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  
  -- 索引
  UNIQUE KEY uk_task_id (task_id),
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_user_task_type (user_id, task_type),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at DESC)
  
  -- 注意：不建外键约束，保持与 users 表解耦
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='API 使用量记录表 (前端先行版)';


-- =============================================================================
-- Table 2: pc_credit_transactions - 积分交易记录
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_credit_transactions (
  -- 主键
  id VARCHAR(36) PRIMARY KEY COMMENT '交易 UUID',
  
  -- 用户关联 (不建外键约束)
  user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID (对应 users.id)',
  
  -- 交易信息
  type VARCHAR(16) NOT NULL COMMENT '交易类型: usage/purchase/refund/bonus/gift',
  amount DECIMAL(10,4) NOT NULL COMMENT '金额 (正数=增加, 负数=扣除)',
  balance_after DECIMAL(10,4) NOT NULL COMMENT '交易后余额',
  
  -- 描述和关联
  description VARCHAR(255) COMMENT '交易描述',
  reference_type VARCHAR(32) COMMENT '关联类型: usage_record/payment/admin',
  reference_id VARCHAR(64) COMMENT '关联 ID (如 pc_usage_records.id)',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  
  -- 索引
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_type (type),
  INDEX idx_reference (reference_type, reference_id)
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='积分交易记录表 (前端先行版)';


-- =============================================================================
-- Table 3: pc_user_credits - 用户积分余额快照
-- 避免每次都聚合 transactions 表计算余额
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_user_credits (
  -- 用户 ID 作为主键 (一个用户一条记录)
  user_id BIGINT UNSIGNED PRIMARY KEY COMMENT '用户 ID (对应 users.id)',
  
  -- 积分信息
  balance DECIMAL(10,4) DEFAULT 100.0000 COMMENT '当前积分余额',
  total_earned DECIMAL(10,4) DEFAULT 100.0000 COMMENT '累计获得积分',
  total_spent DECIMAL(10,4) DEFAULT 0.0000 COMMENT '累计消费积分',
  
  -- 套餐信息
  plan VARCHAR(32) DEFAULT 'free' COMMENT '套餐: free/pro/enterprise',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='用户积分余额表 (前端先行版)';


-- =============================================================================
-- 验证表创建
-- =============================================================================

SELECT '=== pc_usage_records 表结构 ===' AS info;
DESCRIBE pc_usage_records;

SELECT '=== pc_credit_transactions 表结构 ===' AS info;
DESCRIBE pc_credit_transactions;

SELECT '=== pc_user_credits 表结构 ===' AS info;
DESCRIBE pc_user_credits;

-- =============================================================================
-- 完成
-- =============================================================================
SELECT '✅ 前端先行表创建完成!' AS result;
SELECT '
下一步:
  1. 在 Next.js 中配置数据库连接
  2. 实现 /api/usage/record (写入 pc_usage_records)
  3. 实现 /api/activities (读取 pc_usage_records)
  4. 实现 /api/dashboard/stats (聚合查询)
' AS next_steps;
