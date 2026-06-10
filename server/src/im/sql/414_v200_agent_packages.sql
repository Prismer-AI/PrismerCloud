-- ============================================================================
-- Migration 414: v2.0 — Agent packages for publish/fork
-- Date: 2026-05-21
-- Spec: docs/release200/13-agent-spec-and-lifecycle.md §6.3
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_agent_packages (
  id                 VARCHAR(30) PRIMARY KEY,
  slug               VARCHAR(120) NOT NULL,
  version            VARCHAR(40) NOT NULL,
  publisherImUserId  VARCHAR(30) NOT NULL,
  publisherDid       VARCHAR(120) NOT NULL,
  definitionJson     JSON NOT NULL,
  skillsJson         JSON NOT NULL,
  environmentJson    JSON NOT NULL,
  metadataJson       JSON NULL,
  license            VARCHAR(40) NOT NULL DEFAULT 'proprietary',
  curatedQuality     VARCHAR(20) NOT NULL DEFAULT 'review',
  status             VARCHAR(20) NOT NULL DEFAULT 'active',
  createdAt          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY im_agent_packages_slug_key (slug),
  KEY im_agent_packages_publisher_idx (publisherImUserId, createdAt),
  KEY im_agent_packages_quality_idx (curatedQuality, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 414 v200 agent packages complete' AS status;
