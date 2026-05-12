-- ============================================================================
-- Migration 100: v1.9.1 Workspace Data Model (5 new tables)
-- Date: 2026-05-02
-- Track: A (refactor)
--
-- Why: 1.8.0 baseline used `scope: 'global' | 'ws_{id}'` string convention on
-- 12 IM tables, but no `im_workspaces` entity existed. This migration creates
-- Workspace as a first-class FK target. 1.9.x phase: 1:1 with IMUser; future
-- versions may relax to N:1.
--
-- Tables created:
--   1. im_workspaces        — workspace entity (1.9.x: one per human user)
--   2. im_workspace_members — owner/admin/member rows (schema only in 1.9.1)
--   3. im_assets            — content-addressed immutable blobs (sha256)
--   4. im_workspace_files   — mutable path → asset binding (workspace files)
--   5. im_agent_profiles    — adapter-local config (cwd/model/MCP/env/prompt)
--
-- Column names use camelCase to match Prisma's default mapping.
-- See docs/refactor/02-workspace-data-model.md and
-- docs/refactor/10-asset-network-drive.md for full design.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. im_workspaces
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_workspaces (
  id            VARCHAR(30)  PRIMARY KEY,
  ownerImUserId VARCHAR(30)  NOT NULL,
  name          VARCHAR(128) NOT NULL,                                -- 'Personal' | 'Acme Inc'
  slug          VARCHAR(64)  NOT NULL,                                -- URL-friendly
  isDefault     BOOLEAN      NOT NULL DEFAULT FALSE,
  metadata      TEXT         NOT NULL,                                -- JSON (avatar / color / description)
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deletedAt     DATETIME(3)  NULL,
  UNIQUE KEY uk_owner_slug_deleted (ownerImUserId, slug, deletedAt),
  INDEX idx_owner_default (ownerImUserId, isDefault),
  CONSTRAINT fk_workspace_owner FOREIGN KEY (ownerImUserId) REFERENCES im_users(id)
);

-- Note: "one default workspace per owner" is enforced at the application layer.
-- MySQL 8 doesn't support partial unique indexes, so backfill + creation paths
-- must check `isDefault = TRUE AND deletedAt IS NULL` before insert/update.
--
-- Soft-delete uniqueness gotcha: the unique keys below include `deletedAt`,
-- which is NULL for active rows. MySQL/SQLite consider NULLs distinct in unique
-- indexes, so two active rows with the same (slug | path | name) ARE legally
-- insertable from raw SQL even though the unique key looks like it forbids
-- them. The application layer (POST /workspaces, POST /workspaces/:id/files,
-- POST /agent_profiles) enforces "one active row per logical key" via lookup +
-- transaction. The unique key on (..., deletedAt) prevents simultaneous
-- duplicates among soft-deleted rows that share the same exact deletion
-- timestamp — minor protection but not load-bearing.

-- ----------------------------------------------------------------------------
-- 2. im_workspace_members  (1.9.x: schema only, collab UX in 1.10+)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_workspace_members (
  id             VARCHAR(30) PRIMARY KEY,
  workspaceId    VARCHAR(30) NOT NULL,
  memberImUserId VARCHAR(30) NOT NULL,
  role           VARCHAR(32) NOT NULL,                                -- 'owner' | 'admin' | 'member'
  joinedAt       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_ws_member (workspaceId, memberImUserId),
  INDEX idx_member (memberImUserId),
  CONSTRAINT fk_member_workspace FOREIGN KEY (workspaceId) REFERENCES im_workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_user FOREIGN KEY (memberImUserId) REFERENCES im_users(id)
);

-- ----------------------------------------------------------------------------
-- 3. im_assets — content-addressed immutable blobs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_assets (
  id                  VARCHAR(30)  PRIMARY KEY,
  workspaceId         VARCHAR(30)  NOT NULL,
  ownerImUserId       VARCHAR(30)  NOT NULL,
  contentHash         CHAR(64)     NOT NULL,                          -- sha256 hex
  storageUri          VARCHAR(512) NOT NULL,                          -- 's3://bucket/<hash>' | 'file:///abs/path'
  sizeBytes           BIGINT       NULL,
  mime                VARCHAR(128) NULL,
  kind                VARCHAR(32)  NOT NULL DEFAULT 'file',           -- 'file' | 'image' | 'transcript' | 'snippet'
  sourceAgentImUserId VARCHAR(30)  NULL,                              -- which agent produced this
  sourceTaskId        VARCHAR(30)  NULL,                              -- which task produced this
  metadata            TEXT         NOT NULL,                          -- JSON
  createdAt           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_ws_hash (workspaceId, contentHash),                    -- same-ws dedup
  INDEX idx_hash (contentHash),
  INDEX idx_ws_kind (workspaceId, kind),
  INDEX idx_ws_task (workspaceId, sourceTaskId),
  CONSTRAINT fk_asset_workspace FOREIGN KEY (workspaceId) REFERENCES im_workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_asset_owner FOREIGN KEY (ownerImUserId) REFERENCES im_users(id)
);

-- ----------------------------------------------------------------------------
-- 4. im_workspace_files — mutable path → asset binding
-- ----------------------------------------------------------------------------
-- path is VARCHAR(700) — must satisfy MySQL InnoDB 3072-byte unique-index
-- limit: 30(ws) + 700*4(path utf8mb4) + 6(deletedAt) = 2926 bytes < 3072.
-- Wider VARCHAR caused "Specified key was too long" on MySQL 8 default
-- DYNAMIC row format. 700 chars is generous for real-world workspace paths.
CREATE TABLE IF NOT EXISTS im_workspace_files (
  id               VARCHAR(30)  PRIMARY KEY,
  workspaceId      VARCHAR(30)  NOT NULL,
  path             VARCHAR(700) NOT NULL,
  assetId          VARCHAR(30)  NOT NULL,
  version          INT          NOT NULL DEFAULT 1,
  parentVersionId  VARCHAR(30)  NULL,                                  -- self-reference (history chain)
  modifierImUserId VARCHAR(30)  NOT NULL,
  createdAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deletedAt        DATETIME(3)  NULL,
  UNIQUE KEY uk_ws_path_deleted (workspaceId, path, deletedAt),
  INDEX idx_ws_updated (workspaceId, updatedAt),
  INDEX idx_asset (assetId),
  CONSTRAINT fk_file_workspace FOREIGN KEY (workspaceId) REFERENCES im_workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_file_asset FOREIGN KEY (assetId) REFERENCES im_assets(id),
  CONSTRAINT fk_file_modifier FOREIGN KEY (modifierImUserId) REFERENCES im_users(id),
  CONSTRAINT fk_file_parent FOREIGN KEY (parentVersionId) REFERENCES im_workspace_files(id) ON DELETE SET NULL
);

-- ----------------------------------------------------------------------------
-- 5. im_agent_profiles — adapter-local config
-- ----------------------------------------------------------------------------
-- OpenClaw / Hermes call this concept "workspace"; in our taxonomy it's
-- AgentProfile (an adapter-local config instance, multiple per Agent).
CREATE TABLE IF NOT EXISTS im_agent_profiles (
  id            VARCHAR(30)  PRIMARY KEY,
  workspaceId   VARCHAR(30)  NOT NULL,
  agentImUserId VARCHAR(30)  NOT NULL,                                -- FK → im_users.id (agent role)
  adapterName   VARCHAR(64)  NOT NULL,                                -- 'hermes' | 'claude-code' | 'openclaw' | 'codex'
  name          VARCHAR(128) NOT NULL,                                -- 'Project A backend'
  config        TEXT         NOT NULL,                                -- JSON (adapter-specific schema)
  version       INT          NOT NULL DEFAULT 1,                      -- optimistic-lock cursor
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deletedAt     DATETIME(3)  NULL,
  UNIQUE KEY uk_ws_agent_name_deleted (workspaceId, agentImUserId, name, deletedAt),
  INDEX idx_ws_agent (workspaceId, agentImUserId),
  CONSTRAINT fk_profile_workspace FOREIGN KEY (workspaceId) REFERENCES im_workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_profile_agent FOREIGN KEY (agentImUserId) REFERENCES im_users(id)
);
