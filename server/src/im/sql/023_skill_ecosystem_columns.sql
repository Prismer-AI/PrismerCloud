-- ============================================================================
-- Migration 021 -> filed as 023: Add Skill Ecosystem columns to im_skills
-- Syncs MySQL schema with SQLite schema (v1.7.2 enhancements)
-- These columns are required by skill.service.ts search/browse functionality.
--
-- Track A m1+ regression fix (2026-05-02): wrapped each ADD COLUMN /
-- CREATE INDEX in INFORMATION_SCHEMA guards. Reason: 012 now creates
-- im_skills with the full final shape, so a fresh chain run would otherwise
-- hit duplicate-column errors here. Idempotent on prod (already-applied)
-- environments.
-- ============================================================================

-- Helper procedure: add a column to im_skills only if it doesn't exist.
-- Wrapped in a procedure so the file stays compact and the guard logic isn't
-- duplicated 14 times.
DROP PROCEDURE IF EXISTS _add_im_skills_column;
DELIMITER //
CREATE PROCEDURE _add_im_skills_column(IN col_name VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'im_skills'
         AND COLUMN_NAME = col_name) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE im_skills ADD COLUMN `', col_name, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _add_im_skills_column('packageUrl',     'VARCHAR(512) NULL');
CALL _add_im_skills_column('packageHash',    'VARCHAR(64)  NULL');
CALL _add_im_skills_column('packageSize',    'INT          NULL');
CALL _add_im_skills_column('fileCount',      'INT          NOT NULL DEFAULT 1');
CALL _add_im_skills_column('compatibility',  'TEXT         NOT NULL');
CALL _add_im_skills_column('signals',        'TEXT         NOT NULL');
CALL _add_im_skills_column('requires',       'TEXT         NOT NULL');
CALL _add_im_skills_column('version',        'VARCHAR(20)  NOT NULL DEFAULT ''1.0.0''');
CALL _add_im_skills_column('ownerAgentId',   'VARCHAR(30)  NULL');
CALL _add_im_skills_column('forkedFrom',     'VARCHAR(30)  NULL');
CALL _add_im_skills_column('forkCount',      'INT          NOT NULL DEFAULT 0');
CALL _add_im_skills_column('license',        'VARCHAR(30)  NOT NULL DEFAULT ''MIT''');
CALL _add_im_skills_column('securityStatus', 'VARCHAR(20)  NOT NULL DEFAULT ''pending''');
CALL _add_im_skills_column('changelog',      'TEXT         NOT NULL');

DROP PROCEDURE _add_im_skills_column;

-- Set defaults for TEXT columns (MySQL doesn't allow DEFAULT on TEXT in strict mode).
-- These UPDATEs are inherently idempotent thanks to the WHERE clauses.
UPDATE im_skills SET compatibility = '[]' WHERE compatibility IS NULL OR compatibility = '';
UPDATE im_skills SET signals       = '[]' WHERE signals       IS NULL OR signals       = '';
UPDATE im_skills SET `requires`    = '{}' WHERE `requires`    IS NULL OR `requires`    = '';
UPDATE im_skills SET changelog     = ''   WHERE changelog     IS NULL;

-- Index for ownerAgentId lookups (idempotent).
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_skills'
     AND INDEX_NAME = 'idx_skills_owner'
);
SET @stmt := IF(
  @idx = 0,
  'CREATE INDEX idx_skills_owner ON im_skills (ownerAgentId)',
  'SELECT ''skip idx_skills_owner: already exists'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SELECT 'migration 023 complete' AS status;
