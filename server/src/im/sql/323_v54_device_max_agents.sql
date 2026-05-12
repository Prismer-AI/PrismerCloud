-- ============================================================================
-- Migration 323: v5.4 — §30 B1 device capacity model (maxAgents column)
-- Date: 2026-05-11
-- Track: §30 Unified Creation Interface — Device 容量模型
--
-- Background
-- ----------
-- §30 §2.6 introduces a per-device agent-capacity ceiling so that the Web
-- tier (no free tier; base subscription = 1 × Cloud Device) can enforce a
-- sane upper bound on how many agents register against one device. The
-- default of 3 matches the base subscription quota.
--
-- This migration adds a single column:
--   maxAgents — INT NOT NULL DEFAULT 3
--
-- All existing rows automatically backfill to 3 via the DEFAULT, so no
-- separate backfill script is required. Server-side enforcement (the read
-- path at agent.register time) lands in §30 B3 — this migration is
-- schema-only.
--
-- Table name: im_containers (§26 B5 rename to im_devices has not shipped
-- yet; this column rides through the rename as-is since it has no @map).
--
-- Idempotent: information_schema-guarded ADD COLUMN.
-- ============================================================================

DROP PROCEDURE IF EXISTS _323_add_col_if_missing;
DELIMITER //
CREATE PROCEDURE _323_add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- Per-device agent registration ceiling. Default 3 = base Web subscription
-- tier. Existing rows backfill to 3 via DEFAULT.
CALL _323_add_col_if_missing(
  'im_containers',
  'maxAgents',
  'INT NOT NULL DEFAULT 3'
);

DROP PROCEDURE _323_add_col_if_missing;
