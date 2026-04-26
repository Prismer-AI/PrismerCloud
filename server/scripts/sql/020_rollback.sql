-- =============================================================================
-- Prismer Cloud - Billing 表回滚脚本
-- 版本: 1.0.0
-- 日期: 2026-01-26
-- 
-- ⚠️ 警告: 此脚本会删除 pc_payment_methods, pc_payments, pc_subscriptions 表
--          及其所有数据，请谨慎执行！
-- 
-- 安全说明：
--   ✅ 只删除 pc_payment_methods, pc_payments, pc_subscriptions 表
--   ✅ 不影响任何其他表
--   ✅ 不影响 pc_usage_records, pc_user_credits, pc_credit_transactions
-- =============================================================================

USE prismer_info;

-- =============================================================================
-- 预检查
-- =============================================================================
SELECT '=== 回滚前检查 ===' AS step;

-- 显示要删除的表的当前状态
SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME 
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' 
  AND TABLE_NAME IN ('pc_payment_methods', 'pc_payments', 'pc_subscriptions')
ORDER BY TABLE_NAME;

-- =============================================================================
-- 删除表 (按依赖顺序)
-- =============================================================================
SELECT '=== 开始删除表 ===' AS step;

DROP TABLE IF EXISTS pc_subscriptions;
SELECT '  ✓ pc_subscriptions 已删除' AS status;

DROP TABLE IF EXISTS pc_payments;
SELECT '  ✓ pc_payments 已删除' AS status;

DROP TABLE IF EXISTS pc_payment_methods;
SELECT '  ✓ pc_payment_methods 已删除' AS status;

-- =============================================================================
-- 验证
-- =============================================================================
SELECT '=== 验证删除完成 ===' AS step;

-- 确认表已删除
SELECT 
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_payment_methods') AS pm_exists,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_payments') AS pay_exists,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_subscriptions') AS sub_exists;

-- 确认其他表未受影响
SELECT '=== 确认其他表完好 ===' AS step;
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' 
  AND TABLE_NAME LIKE 'pc_%'
ORDER BY TABLE_NAME;

-- =============================================================================
-- 完成
-- =============================================================================
SELECT '✅ Billing 表回滚完成!' AS result;
SELECT '
已删除:
  - pc_payment_methods
  - pc_payments
  - pc_subscriptions

未受影响:
  - pc_usage_records
  - pc_user_credits
  - pc_credit_transactions
  - 所有其他表
' AS summary;
