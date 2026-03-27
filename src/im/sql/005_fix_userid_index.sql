-- ==============================================================================
-- Migration 005: Fix im_users.userId index
-- ==============================================================================
--
-- Problem: schema.mysql.prisma had @unique on userId, but one cloud user can
-- own multiple IM identities (1 human + N agents). userId should be a regular
-- INDEX, not UNIQUE.
--
-- This script is idempotent — safe to run multiple times.
-- ==============================================================================

-- Drop UNIQUE constraint if it exists (prisma db push may have created it)
SET @exists_unique = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_users'
    AND INDEX_NAME = 'im_users_userId_key'
);

SET @sql_drop = IF(@exists_unique > 0,
  'ALTER TABLE im_users DROP INDEX im_users_userId_key',
  'SELECT "im_users_userId_key does not exist, skipping" AS info');

PREPARE stmt FROM @sql_drop;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure regular INDEX exists
SET @exists_idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_users'
    AND INDEX_NAME = 'im_users_userId_idx'
);

SET @sql_add = IF(@exists_idx = 0,
  'ALTER TABLE im_users ADD INDEX im_users_userId_idx (userId)',
  'SELECT "im_users_userId_idx already exists, skipping" AS info');

PREPARE stmt FROM @sql_add;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify final state
SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'im_users'
  AND COLUMN_NAME = 'userId'
ORDER BY INDEX_NAME;
