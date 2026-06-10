-- ============================================================================
-- Migration 324: v1.9.0 — agent username scope: global → per-workspace
-- Date: 2026-05-12
-- Track: §30 Q2 follow-up — agent slug uniqueness scoped to workspace
--
-- Problem
-- -------
-- im_users.username has a UNIQUE constraint (global scope). Two agents in
-- different workspaces cannot share the same name, which breaks the expected
-- UX where workspace isolation implies namespace isolation.
--
-- Fix
-- ----
-- 1. Drop the UNIQUE index on im_users.username (re-creating as a plain
--    index for lookup performance).
-- 2. Per-workspace uniqueness is enforced in application code (register.ts)
--    by querying IMAgentCard.workspaceId + IMUser.username.
-- 3. Human users still get globally unique usernames via application-layer
--    enforcement in the register endpoint (role === 'human').
--
-- Idempotent: information_schema-guarded.
-- ============================================================================

DROP PROCEDURE IF EXISTS _324_drop_global_username_unique;
DELIMITER //
CREATE PROCEDURE _324_drop_global_username_unique()
BEGIN
  DECLARE idx_found INT DEFAULT 0;

  -- Check if the UNIQUE index exists on im_users.username
  SELECT COUNT(*) INTO idx_found
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'im_users'
    AND column_name = 'username'
    AND non_unique = 0
    AND index_name != 'PRIMARY';

  IF idx_found > 0 THEN
    -- Find the exact index name (may vary by schema version)
    SET @index_name = (
      SELECT index_name
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'im_users'
        AND column_name = 'username'
        AND non_unique = 0
        AND index_name != 'PRIMARY'
      LIMIT 1
    );

    SET @drop_sql = CONCAT('ALTER TABLE im_users DROP INDEX `', @index_name, '`');
    PREPARE stmt FROM @drop_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;

  -- Re-add as plain index (for lookup performance)
  SET @add_sql = 'CREATE INDEX idx_im_users_username ON im_users (username)';
  PREPARE stmt FROM @add_sql;
  EXECUTE stmt;
  DEALLOCATE PREPARE stmt;
END //
DELIMITER ;

CALL _324_drop_global_username_unique();
DROP PROCEDURE IF EXISTS _324_drop_global_username_unique;
