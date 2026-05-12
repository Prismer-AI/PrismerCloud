-- ============================================================
-- v1.8.0 Workspace Scope: IMAgentSkill + IMTask
-- Idempotent: safe to run multiple times
-- ============================================================

-- 1. IMAgentSkill 增加 scope (Track A m3 phase 2 fix: MariaDB-only
--    `IF NOT EXISTS` replaced with MySQL 8 INFORMATION_SCHEMA guard)
DROP PROCEDURE IF EXISTS _034_add_col;
DELIMITER //
CREATE PROCEDURE _034_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _034_add_col('im_agent_skills', 'scope', "VARCHAR(100) NOT NULL DEFAULT 'global' AFTER geneId");

-- 先建新约束再删旧约束，避免并发写入时出现无约束窗口
-- (现有数据 scope 全是 'global'，新约束不会冲突)
-- MySQL has no ADD UNIQUE INDEX IF NOT EXISTS; use procedure guard
DROP PROCEDURE IF EXISTS _add_uq_agent_skill_scope;
DELIMITER $$
CREATE PROCEDURE _add_uq_agent_skill_scope()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_agent_skills' AND INDEX_NAME = 'uq_agent_skill_scope'
  ) THEN
    ALTER TABLE im_agent_skills
      ADD UNIQUE INDEX uq_agent_skill_scope (agentId, skillId, scope);
  END IF;
END$$
DELIMITER ;
CALL _add_uq_agent_skill_scope();
DROP PROCEDURE IF EXISTS _add_uq_agent_skill_scope;

-- Drop old unique index (only if it still exists)
DROP PROCEDURE IF EXISTS _drop_old_skill_uq;
DELIMITER $$
CREATE PROCEDURE _drop_old_skill_uq()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_agent_skills' AND INDEX_NAME = 'im_agent_skills_agentId_skillId_key'
  ) THEN
    ALTER TABLE im_agent_skills
      DROP INDEX im_agent_skills_agentId_skillId_key;
  END IF;
END$$
DELIMITER ;
CALL _drop_old_skill_uq();
DROP PROCEDURE IF EXISTS _drop_old_skill_uq;

DROP PROCEDURE IF EXISTS _034_add_idx;
DELIMITER //
CREATE PROCEDURE _034_add_idx(IN tbl VARCHAR(64), IN idx_name VARCHAR(64), IN cols TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx_name) = 0 THEN
    SET @stmt := CONCAT('CREATE INDEX `', idx_name, '` ON `', tbl, '` (', cols, ')');
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _034_add_idx('im_agent_skills', 'idx_agent_skills_scope', 'agentId, scope, status');

-- 2. IMTask 增加 scope
CALL _034_add_col('im_tasks', 'scope', "VARCHAR(100) NOT NULL DEFAULT 'global' AFTER assigneeId");

CALL _034_add_idx('im_tasks', 'idx_tasks_scope', 'creatorId, scope, status');

DROP PROCEDURE _034_add_col;
DROP PROCEDURE _034_add_idx;
