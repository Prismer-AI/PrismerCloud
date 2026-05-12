-- v1.8.0 — Evolution-Memory Convergence Schema Changes
-- Phase 0+1: Memory Intelligence fields + Knowledge Links + Capsule Reflection
-- Idempotent: safe to run multiple times
--
-- Track A m3 phase 2 fix: replaced MariaDB-only `ADD COLUMN IF NOT EXISTS`
-- syntax with MySQL 8 INFORMATION_SCHEMA guard procedure.

DROP PROCEDURE IF EXISTS _029_add_col;
DELIMITER //
CREATE PROCEDURE _029_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
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

-- Memory Intelligence fields
CALL _029_add_col('im_memory_files', 'memoryType',         'VARCHAR(20) DEFAULT NULL');
CALL _029_add_col('im_memory_files', 'description',        'VARCHAR(500) DEFAULT NULL');
CALL _029_add_col('im_memory_files', 'lastConsolidatedAt', 'DATETIME DEFAULT NULL');
CALL _029_add_col('im_memory_files', 'stale',              'BOOLEAN DEFAULT FALSE');

-- Capsule reflection field
CALL _029_add_col('im_evolution_capsules', 'reflection', 'TEXT DEFAULT NULL');

-- Knowledge Links table
CREATE TABLE IF NOT EXISTS im_knowledge_links (
  id          VARCHAR(30) PRIMARY KEY,
  sourceType  VARCHAR(20) NOT NULL,
  sourceId    VARCHAR(36) NOT NULL,
  targetType  VARCHAR(20) NOT NULL,
  targetId    VARCHAR(36) NOT NULL,
  linkType    VARCHAR(20) NOT NULL DEFAULT 'related',
  strength    DOUBLE      NOT NULL DEFAULT 1.0,
  scope       VARCHAR(50) NOT NULL DEFAULT 'global',
  createdAt   DATETIME    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_link (sourceType, sourceId, targetType, targetId, linkType),
  INDEX idx_source (sourceType, sourceId),
  INDEX idx_target (targetType, targetId),
  INDEX idx_scope (scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- FULLTEXT index for memory search (Phase 1)
DROP PROCEDURE IF EXISTS _add_ft_memory_search;
DELIMITER //
CREATE PROCEDURE _add_ft_memory_search()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_memory_files' AND INDEX_NAME = 'ft_memory_search'
  ) THEN
    ALTER TABLE im_memory_files ADD FULLTEXT INDEX ft_memory_search (path, description);
  END IF;
END //
DELIMITER ;
CALL _add_ft_memory_search();
DROP PROCEDURE _add_ft_memory_search;

-- Capsule Enrichment (P3): transition context for capsule records
CALL _029_add_col('im_evolution_capsules', 'transitionReason', 'VARCHAR(100) DEFAULT NULL');
CALL _029_add_col('im_evolution_capsules', 'contextSnapshot',  'TEXT DEFAULT NULL');

DROP PROCEDURE _029_add_col;
