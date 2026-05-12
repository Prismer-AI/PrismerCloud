-- =============================================================================
-- Prismer Cloud - Billing 相关表 (前端先行实现)
-- 版本: 1.0.0
-- 日期: 2026-01-26
-- 
-- 设计原则：
--   ✅ 不修改任何现有表
--   ✅ 新表使用 pc_ 前缀，与后端开发解耦
--   ✅ 不建立外键约束，保持解耦
--   ✅ 后续迁移时，只需将数据迁移到后端正式表
-- 
-- 新建表：
--   pc_payment_methods   - 用户支付方式
--   pc_payments          - 支付/充值记录
--   pc_subscriptions     - 订阅记录 (可选)
-- =============================================================================

USE prismer_info;

-- =============================================================================
-- 预检查：确认不会影响现有表
-- =============================================================================
SELECT '=== 预检查：确认现有表状态 ===' AS step;

-- 检查现有 pc_ 表（之前创建的）
SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME 
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' 
  AND TABLE_NAME LIKE 'pc_%'
ORDER BY TABLE_NAME;

-- 确认要创建的表不存在
SELECT '新表预检查:' AS info,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_payment_methods') AS pc_payment_methods_exists,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_payments') AS pc_payments_exists,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_subscriptions') AS pc_subscriptions_exists;


-- =============================================================================
-- Table 1: pc_payment_methods - 用户支付方式
-- 存储用户绑定的支付方式（银行卡、支付宝等）
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_payment_methods (
  -- 主键
  id VARCHAR(36) PRIMARY KEY COMMENT '记录 UUID',
  
  -- 用户关联 (不建外键约束，关联 users.id)
  user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID',
  
  -- Stripe 关联
  stripe_payment_method_id VARCHAR(64) NOT NULL COMMENT 'Stripe PaymentMethod ID (pm_xxx)',
  stripe_customer_id VARCHAR(64) COMMENT 'Stripe Customer ID (cus_xxx)',
  
  -- 支付方式类型
  type ENUM('card', 'alipay', 'wechat') NOT NULL COMMENT '支付方式类型',
  
  -- 银行卡信息 (type='card' 时填写)
  card_brand VARCHAR(32) COMMENT '卡品牌: visa, mastercard, amex, etc.',
  card_last4 CHAR(4) COMMENT '卡号后四位',
  card_exp_month TINYINT UNSIGNED COMMENT '过期月份 (1-12)',
  card_exp_year SMALLINT UNSIGNED COMMENT '过期年份 (如 2027)',
  card_funding VARCHAR(16) COMMENT '卡类型: credit, debit, prepaid',
  
  -- 支付宝/微信信息 (type='alipay'/'wechat' 时填写)
  wallet_email VARCHAR(255) COMMENT '关联邮箱',
  
  -- 状态
  is_default BOOLEAN DEFAULT FALSE COMMENT '是否为默认支付方式',
  is_active BOOLEAN DEFAULT TRUE COMMENT '是否有效',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  
  -- 索引
  UNIQUE KEY uk_stripe_pm (stripe_payment_method_id),
  INDEX idx_user_id (user_id),
  INDEX idx_user_default (user_id, is_default),
  INDEX idx_user_type (user_id, type)
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='用户支付方式表 (前端先行版)';


-- =============================================================================
-- Table 2: pc_payments - 支付/充值记录
-- 记录所有支付行为：充值、订阅付款等
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_payments (
  -- 主键
  id VARCHAR(36) PRIMARY KEY COMMENT '记录 UUID',
  
  -- 用户关联
  user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID',
  
  -- Stripe 关联
  stripe_payment_intent_id VARCHAR(64) COMMENT 'Stripe PaymentIntent ID (pi_xxx)',
  stripe_charge_id VARCHAR(64) COMMENT 'Stripe Charge ID (ch_xxx)',
  stripe_invoice_id VARCHAR(64) COMMENT 'Stripe Invoice ID (in_xxx) - 订阅付款时',
  
  -- 支付方式
  payment_method_id VARCHAR(36) COMMENT '关联 pc_payment_methods.id',
  payment_method_type ENUM('card', 'alipay', 'wechat') COMMENT '支付方式类型',
  
  -- 金额信息
  amount_cents INT UNSIGNED NOT NULL COMMENT '支付金额 (分/cents)',
  currency CHAR(3) DEFAULT 'USD' COMMENT '货币代码: USD, CNY',
  credits_purchased DECIMAL(10,2) DEFAULT 0 COMMENT '购买的 credits 数量',
  
  -- 支付类型和状态
  type ENUM('topup', 'subscription', 'one_time') NOT NULL COMMENT '支付类型',
  status ENUM('pending', 'processing', 'succeeded', 'failed', 'canceled', 'refunded') DEFAULT 'pending' COMMENT '状态',
  
  -- 描述
  description VARCHAR(255) COMMENT '支付描述',
  failure_reason VARCHAR(255) COMMENT '失败原因',
  
  -- 发票
  invoice_pdf_url TEXT COMMENT '发票 PDF URL',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  completed_at TIMESTAMP NULL COMMENT '完成时间',
  
  -- 索引
  INDEX idx_user_id (user_id),
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_stripe_pi (stripe_payment_intent_id),
  INDEX idx_status (status),
  INDEX idx_type_status (type, status)
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='支付记录表 (前端先行版)';


-- =============================================================================
-- Table 3: pc_subscriptions - 订阅记录 (可选)
-- 如果需要支持订阅模式
-- =============================================================================

CREATE TABLE IF NOT EXISTS pc_subscriptions (
  -- 主键
  id VARCHAR(36) PRIMARY KEY COMMENT '记录 UUID',
  
  -- 用户关联
  user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID',
  
  -- Stripe 关联
  stripe_subscription_id VARCHAR(64) COMMENT 'Stripe Subscription ID (sub_xxx)',
  stripe_customer_id VARCHAR(64) COMMENT 'Stripe Customer ID (cus_xxx)',
  
  -- 订阅信息
  plan ENUM('free', 'pro', 'enterprise') DEFAULT 'free' COMMENT '套餐',
  price_cents INT UNSIGNED DEFAULT 0 COMMENT '月费 (分/cents)',
  credits_monthly INT UNSIGNED DEFAULT 100 COMMENT '每月赠送 credits',
  
  -- 状态
  status ENUM('active', 'canceled', 'past_due', 'trialing', 'paused') DEFAULT 'active' COMMENT '状态',
  
  -- 周期
  current_period_start TIMESTAMP NULL COMMENT '当前周期开始',
  current_period_end TIMESTAMP NULL COMMENT '当前周期结束',
  canceled_at TIMESTAMP NULL COMMENT '取消时间',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  
  -- 索引
  UNIQUE KEY uk_stripe_sub (stripe_subscription_id),
  INDEX idx_user_id (user_id),
  INDEX idx_user_status (user_id, status),
  INDEX idx_status (status)
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='订阅记录表 (前端先行版)';


-- =============================================================================
-- 验证表创建
-- =============================================================================

SELECT '=== 验证新表创建 ===' AS step;

SELECT '--- pc_payment_methods 表结构 ---' AS info;
DESCRIBE pc_payment_methods;

SELECT '--- pc_payments 表结构 ---' AS info;
DESCRIBE pc_payments;

SELECT '--- pc_subscriptions 表结构 ---' AS info;
DESCRIBE pc_subscriptions;

-- 确认没有影响现有表
SELECT '=== 确认现有表未受影响 ===' AS step;
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' 
  AND TABLE_NAME IN ('users', 'api_keys', 'usage_records', 'pc_usage_records', 'pc_user_credits', 'pc_credit_transactions')
ORDER BY TABLE_NAME;


-- =============================================================================
-- 完成
-- =============================================================================
SELECT '✅ Billing 表创建完成!' AS result;
SELECT '
新建表:
  - pc_payment_methods  (用户支付方式)
  - pc_payments         (支付/充值记录)
  - pc_subscriptions    (订阅记录)

特性:
  ✅ 不修改任何现有表
  ✅ 无外键约束，保持解耦
  ✅ 使用 pc_ 前缀

下一步:
  1. 在 Nacos 配置 STRIPE_SECRET_KEY
  2. 安装 stripe npm 包
  3. 创建 src/lib/db-billing.ts
  4. 改造 /api/billing/* 路由
' AS next_steps;
