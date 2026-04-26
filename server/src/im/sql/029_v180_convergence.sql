-- v1.8.0 — Evolution-Memory Convergence Schema Changes
-- Phase 0+1: Memory Intelligence fields + Knowledge Links + Capsule Reflection
-- Idempotent: safe to run multiple times

-- Memory Intelligence fields
ALTER TABLE im_memory_files ADD COLUMN IF NOT EXISTS memoryType VARCHAR(20) DEFAULT NULL;
ALTER TABLE im_memory_files ADD COLUMN IF NOT EXISTS description VARCHAR(500) DEFAULT NULL;
ALTER TABLE im_memory_files ADD COLUMN IF NOT EXISTS lastConsolidatedAt DATETIME DEFAULT NULL;
ALTER TABLE im_memory_files ADD COLUMN IF NOT EXISTS stale BOOLEAN DEFAULT FALSE;

-- Capsule reflection field
ALTER TABLE im_evolution_capsules ADD COLUMN IF NOT EXISTS reflection TEXT DEFAULT NULL;

-- Knowledge Links table
CREATE TABLE IF NOT EXISTS im_knowledge_links (
  id          VARCHAR(30) PRIMARY KEY,
  sourceType  VARCHAR(20) NOT NULL,
  sourceId    VARCHAR(36) NOT NULL,
  targetType  VARCHAR(20) NOT NULL,
  targetId    VARCHAR(36) NOT NULL,
  linkType    VARCHAR(20) NOT NULL DEFAULT 'related',
  strength    DOUBLE NOT NULL DEFAULT 1.0,
  scope       VARCHAR(50) NOT NULL DEFAULT 'global',
  createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_link (sourceType, sourceId, targetType, targetId, linkType),
  INDEX idx_source (sourceType, sourceId),
  INDEX idx_target (targetType, targetId),
  INDEX idx_scope (scope)
);

-- FULLTEXT index for memory search (Phase 1)
-- MySQL has no ADD FULLTEXT INDEX IF NOT EXISTS; use procedure guard
DROP PROCEDURE IF EXISTS _add_ft_memory_search;
DELIMITER $$
CREATE PROCEDURE _add_ft_memory_search()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_memory_files' AND INDEX_NAME = 'ft_memory_search'
  ) THEN
    ALTER TABLE im_memory_files ADD FULLTEXT INDEX ft_memory_search (path, description);
  END IF;
END$$
DELIMITER ;
CALL _add_ft_memory_search();
DROP PROCEDURE IF EXISTS _add_ft_memory_search;

-- Capsule Enrichment (P3): transition context for capsule records
ALTER TABLE im_evolution_capsules ADD COLUMN IF NOT EXISTS transitionReason VARCHAR(100) DEFAULT NULL;
ALTER TABLE im_evolution_capsules ADD COLUMN IF NOT EXISTS contextSnapshot TEXT DEFAULT NULL;
