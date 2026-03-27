-- ==============================================================================
-- Prismer IM Server - MySQL 表验证脚本
-- ==============================================================================
--
-- 安全说明:
-- - 此脚本仅包含 SELECT 查询，不修改任何数据
-- - 用于验证表结构是否正确创建
--
-- 执行方式:
-- mysql -h <host> -u <user> -p <database> < 002_verify_tables.sql
--
-- ==============================================================================

SELECT '========== IM Server 表验证开始 ==========' AS '';

-- ==============================================================================
-- 1. 检查表是否存在
-- ==============================================================================
SELECT '--- 1. 检查表是否存在 ---' AS '';

SELECT
  table_name AS '表名',
  CASE WHEN table_name IS NOT NULL THEN '✅ 存在' ELSE '❌ 不存在' END AS '状态'
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN ('im_users', 'im_agent_cards', 'im_conversations', 'im_participants', 'im_messages', 'im_webhooks')
ORDER BY table_name;

-- ==============================================================================
-- 2. 统计各表记录数
-- ==============================================================================
SELECT '--- 2. 统计各表记录数 ---' AS '';

SELECT 'im_users' AS '表名', COUNT(*) AS '记录数' FROM im_users
UNION ALL
SELECT 'im_agent_cards', COUNT(*) FROM im_agent_cards
UNION ALL
SELECT 'im_conversations', COUNT(*) FROM im_conversations
UNION ALL
SELECT 'im_participants', COUNT(*) FROM im_participants
UNION ALL
SELECT 'im_messages', COUNT(*) FROM im_messages
UNION ALL
SELECT 'im_webhooks', COUNT(*) FROM im_webhooks;

-- ==============================================================================
-- 3. 检查 im_users 表结构
-- ==============================================================================
SELECT '--- 3. im_users 表结构 ---' AS '';

SELECT
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '类型',
  IS_NULLABLE AS '允许NULL',
  COLUMN_DEFAULT AS '默认值',
  COLUMN_KEY AS '索引'
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'im_users'
ORDER BY ORDINAL_POSITION;

-- ==============================================================================
-- 4. 检查 im_agent_cards 表结构
-- ==============================================================================
SELECT '--- 4. im_agent_cards 表结构 ---' AS '';

SELECT
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '类型',
  IS_NULLABLE AS '允许NULL',
  COLUMN_DEFAULT AS '默认值',
  COLUMN_KEY AS '索引'
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'im_agent_cards'
ORDER BY ORDINAL_POSITION;

-- ==============================================================================
-- 5. 检查 im_conversations 表结构
-- ==============================================================================
SELECT '--- 5. im_conversations 表结构 ---' AS '';

SELECT
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '类型',
  IS_NULLABLE AS '允许NULL',
  COLUMN_DEFAULT AS '默认值',
  COLUMN_KEY AS '索引'
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'im_conversations'
ORDER BY ORDINAL_POSITION;

-- ==============================================================================
-- 6. 检查 im_participants 表结构
-- ==============================================================================
SELECT '--- 6. im_participants 表结构 ---' AS '';

SELECT
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '类型',
  IS_NULLABLE AS '允许NULL',
  COLUMN_DEFAULT AS '默认值',
  COLUMN_KEY AS '索引'
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'im_participants'
ORDER BY ORDINAL_POSITION;

-- ==============================================================================
-- 7. 检查 im_messages 表结构
-- ==============================================================================
SELECT '--- 7. im_messages 表结构 ---' AS '';

SELECT
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '类型',
  IS_NULLABLE AS '允许NULL',
  COLUMN_DEFAULT AS '默认值',
  COLUMN_KEY AS '索引'
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'im_messages'
ORDER BY ORDINAL_POSITION;

-- ==============================================================================
-- 8. 检查 im_webhooks 表结构
-- ==============================================================================
SELECT '--- 8. im_webhooks 表结构 ---' AS '';

SELECT
  COLUMN_NAME AS '字段名',
  COLUMN_TYPE AS '类型',
  IS_NULLABLE AS '允许NULL',
  COLUMN_DEFAULT AS '默认值',
  COLUMN_KEY AS '索引'
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'im_webhooks'
ORDER BY ORDINAL_POSITION;

-- ==============================================================================
-- 9. 检查外键约束
-- ==============================================================================
SELECT '--- 9. 外键约束 ---' AS '';

SELECT
  CONSTRAINT_NAME AS '约束名',
  TABLE_NAME AS '表名',
  COLUMN_NAME AS '字段',
  REFERENCED_TABLE_NAME AS '引用表',
  REFERENCED_COLUMN_NAME AS '引用字段'
FROM information_schema.key_column_usage
WHERE table_schema = DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL
  AND TABLE_NAME LIKE 'im_%'
ORDER BY TABLE_NAME, CONSTRAINT_NAME;

-- ==============================================================================
-- 10. 检查索引
-- ==============================================================================
SELECT '--- 10. 索引列表 ---' AS '';

SELECT
  TABLE_NAME AS '表名',
  INDEX_NAME AS '索引名',
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS '字段',
  CASE NON_UNIQUE WHEN 0 THEN 'UNIQUE' ELSE 'INDEX' END AS '类型'
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND TABLE_NAME LIKE 'im_%'
GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
ORDER BY TABLE_NAME, INDEX_NAME;

SELECT '========== IM Server 表验证完成 ==========' AS '';
