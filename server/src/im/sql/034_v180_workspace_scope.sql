-- ============================================================
-- v1.8.0 Workspace Scope: IMAgentSkill + IMTask
-- Idempotent: safe to run multiple times
-- ============================================================

-- 1. IMAgentSkill 增加 scope
ALTER TABLE im_agent_skills
  ADD COLUMN IF NOT EXISTS scope VARCHAR(100) NOT NULL DEFAULT 'global' AFTER geneId;

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

CREATE INDEX IF NOT EXISTS idx_agent_skills_scope
  ON im_agent_skills (agentId, scope, status);

-- 2. IMTask 增加 scope
ALTER TABLE im_tasks
  ADD COLUMN IF NOT EXISTS scope VARCHAR(100) NOT NULL DEFAULT 'global' AFTER assigneeId;

CREATE INDEX IF NOT EXISTS idx_tasks_scope
  ON im_tasks (creatorId, scope, status);
