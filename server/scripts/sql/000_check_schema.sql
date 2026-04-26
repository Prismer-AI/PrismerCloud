-- =============================================================================
-- Prismer Cloud - 数据库 Schema 检查脚本 (只读，安全)
-- 版本: 2.0.0
-- 日期: 2026-01-25
-- 
-- ✅ 此脚本只读取信息，不做任何修改
-- =============================================================================

USE prismer_info;

-- =============================================================================
-- Step 1: 检查现有表 (后端管理，不修改)
-- =============================================================================

SELECT '=== 现有表状态 (后端管理) ===' AS section;

SELECT 
  'users' AS table_name,
  CASE WHEN COUNT(*) > 0 THEN '✅ 存在' ELSE '❌ 不存在' END AS status,
  (SELECT COUNT(*) FROM users) AS row_count
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'users'
UNION ALL
SELECT 
  'api_keys',
  CASE WHEN COUNT(*) > 0 THEN '✅ 存在' ELSE '❌ 不存在' END,
  (SELECT COUNT(*) FROM api_keys)
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'api_keys'
UNION ALL
SELECT 
  'usage_records (后端)',
  CASE WHEN COUNT(*) > 0 THEN '✅ 存在' ELSE '❌ 不存在' END,
  IFNULL((SELECT COUNT(*) FROM usage_records), 0)
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'usage_records';

-- =============================================================================
-- Step 2: 检查前端先行表 (pc_ 前缀)
-- =============================================================================

SELECT '=== 前端先行表状态 (pc_ 前缀) ===' AS section;

SELECT 
  'pc_usage_records' AS table_name,
  CASE WHEN COUNT(*) > 0 THEN '✅ 存在' ELSE '❌ 待创建' END AS status
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_usage_records'
UNION ALL
SELECT 
  'pc_credit_transactions',
  CASE WHEN COUNT(*) > 0 THEN '✅ 存在' ELSE '❌ 待创建' END
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_credit_transactions'
UNION ALL
SELECT 
  'pc_user_credits',
  CASE WHEN COUNT(*) > 0 THEN '✅ 存在' ELSE '❌ 待创建' END
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'pc_user_credits';

-- =============================================================================
-- Step 3: 验证 users.id 类型
-- =============================================================================

SELECT '=== users.id 类型验证 ===' AS section;
SELECT 
  COLUMN_TYPE AS id_type,
  CASE 
    WHEN DATA_TYPE = 'bigint' THEN '✅ BIGINT (正确)'
    ELSE '⚠️ 非 BIGINT'
  END AS verification
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'prismer_info' 
  AND TABLE_NAME = 'users' 
  AND COLUMN_NAME = 'id';

-- =============================================================================
-- Step 4: 示例用户
-- =============================================================================

SELECT '=== 示例用户 ===' AS section;
SELECT id, email, created_at FROM users ORDER BY id LIMIT 3;

-- =============================================================================
-- 完成
-- =============================================================================
SELECT '
检查完成!

如果 pc_* 表显示 "❌ 待创建"，执行:
  mysql ... < scripts/sql/010_create_pc_tables.sql
' AS next_steps;
