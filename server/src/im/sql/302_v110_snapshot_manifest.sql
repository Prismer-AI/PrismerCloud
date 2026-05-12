-- ============================================================================
-- Migration 302: v1.10.0 Cloud-3 sandbox snapshot manifest field (S3)
-- Date: 2026-05-04
--
-- Adds a `metadata` TEXT column (default '{}') to im_container_snapshots so
-- daemon-first snapshots can store a JSON file manifest:
--   {
--     "kind": "fs-manifest",
--     "files": [{"path": "...", "sha256": "...", "sizeBytes": N, "mtime": ...}]
--   }
--
-- Phase 1 (this release): manifest-only snapshots (no docker commit). The
-- daemon walks /workspace and POSTs to /api/sandboxes/:id/snapshot/manifest
-- which writes a row with imageTag=manifest-<ts>, imageDigest=NULL,
-- sizeBytes=NULL, metadata=<JSON>.
--
-- Phase 2 (v5.5): real docker commit will populate imageTag/imageDigest/
-- sizeBytes alongside the manifest. The metadata JSON stays compatible.
--
-- ADD-only; no DROP / RENAME. Idempotent via INFORMATION_SCHEMA guards
-- (Track A 029-037 + 300/301 pattern).
-- ============================================================================

DROP PROCEDURE IF EXISTS _302_add_col;
DELIMITER //
CREATE PROCEDURE _302_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
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

-- imageTag/imageDigest were NOT NULL in 300; relax imageTag to optional so
-- manifest-only rows (no docker commit) can omit it. Use a separate proc that
-- only acts when imageTag is currently NOT NULL — idempotent.
DROP PROCEDURE IF EXISTS _302_relax_col;
DELIMITER //
CREATE PROCEDURE _302_relax_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
         AND COLUMN_NAME = col AND IS_NULLABLE = 'NO') > 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` MODIFY COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _302_add_col('im_container_snapshots', 'metadata', "TEXT");
CALL _302_relax_col('im_container_snapshots', 'imageTag', "VARCHAR(64) NULL");

DROP PROCEDURE _302_add_col;
DROP PROCEDURE _302_relax_col;
