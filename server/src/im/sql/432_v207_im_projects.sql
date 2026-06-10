-- ============================================================================
-- Migration 430: v2.0.7 Phase 1 — IMProject + IMAgentProjectMembership
-- Date: 2026-05-26
-- Spec: docs/release201/09-project-abstraction.md §3.1 + §3.2 + §15.1 Phase 1
--
-- Why this migration exists
-- -------------------------
-- workspace → task hierarchy 缺少 project scope 中间层。本迁移建立 IMProject
-- 主体 + 成员关系表,作为 v2.0.7 Phase 1 主体:不动任何已有关联表 (im_tasks /
-- im_assets / im_conversations / im_memory_*),保证现有 list endpoint 行为
-- 不变。后续 Phase 2 才会在 im_tasks 加 project_id 列。
--
-- 设计决策 (§16 决策记录):
--   D1  projectId NULL 是合法状态;不创建 default project 兜底
--   D3  membership 不分 user/agent 两张表;用 principal_kind 区分
--   D5  IMSkill 不加 projectId 列 (skill 跨 project 共享)
--   D6  IMAgentProfile 不加 projectId 列 (agent 通过 membership 进 project)
--
-- 验收 (§0.2.1 Phase 1):
--   - 创建/列/删 project 通;membership 增删通
--   - workspace owner 自动作为 project owner (service 层短路, §5.2)
--   - 现有所有资源 list 不受影响
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_projects (
  id            VARCHAR(30) NOT NULL,
  workspaceId   VARCHAR(30) NOT NULL,
  slug          VARCHAR(64) NOT NULL,
  name          VARCHAR(128) NOT NULL,
  description   TEXT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  ownerUserId   VARCHAR(30) NOT NULL,
  metadata      TEXT NOT NULL,
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  archivedAt    DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_im_projects_ws_slug (workspaceId, slug),
  KEY idx_im_projects_ws (workspaceId),
  KEY idx_im_projects_owner (ownerUserId),
  KEY idx_im_projects_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_agent_project_memberships (
  id            VARCHAR(30) NOT NULL,
  projectId     VARCHAR(30) NOT NULL,
  principalKind VARCHAR(10) NOT NULL,
  principalId   VARCHAR(36) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'contributor',
  joinedAt      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_im_apm_project_principal (projectId, principalKind, principalId),
  KEY idx_im_apm_project (projectId),
  KEY idx_im_apm_principal (principalKind, principalId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Acceptance — both tables must exist with their indexes after the apply.
SELECT
  'migration 430 im_projects complete' AS status,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'im_projects') AS im_projects_exists,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'im_agent_project_memberships') AS im_apm_exists,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_projects'
      AND index_name = 'uk_im_projects_ws_slug') AS im_projects_ws_slug_unique_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_agent_project_memberships'
      AND index_name = 'uk_im_apm_project_principal') AS im_apm_principal_unique_present;
