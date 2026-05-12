-- ============================================================================
-- Migration 012: Skill Catalog — full schema (Track A m1+ regression fix)
-- Date: 2026-05-02
--
-- This file resurrects the original `012_add_skill_catalog.sql` that was
-- deleted in commit c3a808f ("v1.7.2: Skillhub removal", 2026-03-16). The
-- deletion left migrations 022 / 023 / 025 / 035 referencing `im_skills`
-- without any prior CREATE TABLE — fine on prod (which had already applied
-- the original 012 before deletion) but fatal on a fresh dev MySQL.
--
-- Schema below is the FINAL shape of im_skills (all columns from the
-- original 012 + columns added by 023 + qualityScore from 025), so a fresh
-- chain run picks up the correct shape in one shot. Migrations 022 / 023 /
-- 025 are made idempotent in their own files so they no-op when this file
-- has already created the columns/indexes.
--
-- Source of truth: prisma/schema.mysql.prisma `model IMSkill { ... }`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_skills (
  id             VARCHAR(30)   NOT NULL PRIMARY KEY,
  slug           VARCHAR(200)  NOT NULL,
  name           VARCHAR(256)  NOT NULL,
  description    TEXT          NOT NULL,
  category       VARCHAR(50)   NOT NULL DEFAULT 'general',
  tags           TEXT          NOT NULL,
  author         VARCHAR(128)  NOT NULL DEFAULT '',
  source         VARCHAR(30)   NOT NULL DEFAULT 'community',
  sourceUrl      VARCHAR(512)  NOT NULL DEFAULT '',
  sourceId       VARCHAR(256)  NOT NULL DEFAULT '',
  content        MEDIUMTEXT    NOT NULL,
  installs       INT           NOT NULL DEFAULT 0,
  stars          INT           NOT NULL DEFAULT 0,
  qualityScore   DOUBLE        NOT NULL DEFAULT 0.01,
  status         VARCHAR(20)   NOT NULL DEFAULT 'active',
  geneId         VARCHAR(128)  NULL,
  metadata       TEXT          NOT NULL,
  createdAt      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  -- v1.7.2 Skill Ecosystem (originally added in migration 023)
  packageUrl     VARCHAR(512)  NULL,
  packageHash   VARCHAR(64)   NULL,
  packageSize    INT           NULL,
  fileCount      INT           NOT NULL DEFAULT 1,
  compatibility  TEXT          NOT NULL,
  signals        TEXT          NOT NULL,
  `requires`     TEXT          NOT NULL,
  version        VARCHAR(20)   NOT NULL DEFAULT '1.0.0',
  ownerAgentId   VARCHAR(30)   NULL,
  forkedFrom     VARCHAR(30)   NULL,
  forkCount      INT           NOT NULL DEFAULT 0,
  license        VARCHAR(30)   NOT NULL DEFAULT 'MIT',
  securityStatus VARCHAR(20)   NOT NULL DEFAULT 'pending',
  changelog      TEXT          NOT NULL,

  UNIQUE KEY uk_slug (slug),
  INDEX idx_category (category),
  INDEX idx_source (source),
  INDEX idx_installs (installs),
  INDEX idx_status (status),
  INDEX idx_sourceId (sourceId),
  INDEX idx_skills_owner (ownerAgentId),
  FULLTEXT INDEX ft_skills_search (name, description, tags),
  FULLTEXT INDEX ft_skills_signals (signals)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note: TEXT columns (description, tags, content, metadata, compatibility,
-- signals, requires, changelog) intentionally have no DEFAULT clause because
-- MySQL 8 strict mode rejects literal DEFAULT '...' on TEXT/BLOB. The Prisma
-- model assigns sensible defaults (empty string / "[]" / "{}") at the ORM
-- layer; raw inserts must supply values.
