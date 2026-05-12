-- ============================================================================
-- Migration 303: v1.10.0 Snapshot manifest column TEXT → MEDIUMTEXT (Cloud 3 S3 follow-up)
-- Date: 2026-05-04
--
-- Code review caught: 302 declared `metadata TEXT` (64 KB). FS-manifest payloads
-- realistically run 100-200 bytes per file × thousands of files in any non-trivial
-- workspace, easily exceeding 64 KB. The route accepts up to 50,000 entries
-- (~7.5 MB JSON) — TEXT would silently 500 on real workloads. Phase 1 e2e only
-- wrote a single file, so the issue didn't surface until review.
--
-- Switch to MEDIUMTEXT (16 MB) which comfortably holds the documented 50k cap.
-- Idempotent: only ALTER if current type is text/tinytext/varchar.
-- ============================================================================

DELIMITER //

CREATE PROCEDURE IF NOT EXISTS _303_widen_metadata()
BEGIN
  DECLARE col_type VARCHAR(64);
  SELECT LOWER(DATA_TYPE) INTO col_type
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'im_container_snapshots'
      AND COLUMN_NAME = 'metadata';

  IF col_type IS NULL THEN
    -- Column doesn't exist yet (302 hasn't run). Skip; 302 will add it as TEXT,
    -- then this 303 should be re-run to widen.
    SELECT '[303] WARN im_container_snapshots.metadata not present — run 302 first';
  ELSEIF col_type = 'mediumtext' OR col_type = 'longtext' THEN
    -- Already wide enough.
    SELECT '[303] OK im_container_snapshots.metadata already mediumtext/longtext';
  ELSE
    ALTER TABLE im_container_snapshots
      MODIFY COLUMN metadata MEDIUMTEXT NOT NULL DEFAULT ('{}');
    SELECT '[303] OK widened im_container_snapshots.metadata → MEDIUMTEXT';
  END IF;
END //

DELIMITER ;

CALL _303_widen_metadata();
DROP PROCEDURE _303_widen_metadata;
