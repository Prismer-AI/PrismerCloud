-- Wave-8 W11 · K8s provisioning wizard — adds runtimeKind discriminator to im_containers.
--
-- Why a column (and not a label/JSON tag): the wizard's badge ("[K8s]") needs
-- O(1) lookup at list time. Existing rows default to "docker" so the column
-- is backwards-compatible with all pre-W11 traffic, including warm-pool reuse.
--
-- Apply via:
--   src/im/sql/run-migration.sh 304_v110_runtime_kind.sql
-- (or manually via mysql client). Local dev SQLite gets this via `prisma db push`.

DROP PROCEDURE IF EXISTS _304_add_runtime_kind;
DELIMITER //
CREATE PROCEDURE _304_add_runtime_kind()
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_containers') > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'im_containers'
             AND COLUMN_NAME = 'runtimeKind') = 0 THEN
    ALTER TABLE im_containers
      ADD COLUMN runtimeKind VARCHAR(16) NOT NULL DEFAULT 'docker' AFTER warmPoolHit;
  END IF;
END //
DELIMITER ;

CALL _304_add_runtime_kind();
DROP PROCEDURE _304_add_runtime_kind;
