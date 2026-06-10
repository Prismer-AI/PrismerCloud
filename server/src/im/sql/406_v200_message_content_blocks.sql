-- ============================================================================
-- Migration 406: v2.0 — IMMessage.contentBlocksJson multimodal column
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.6
--       docs/release200/14b-multimodal-input-pipeline.md §4.1 / §4.2
--
-- Background
-- ----------
-- §4.6 / 14b: ContentBlock[] becomes the canonical multimodal payload
-- (text / image / audio / video / file / tool_use / tool_result / reasoning).
-- The existing `content` (string) and `attachments` (JSON) fields are kept
-- read-only / dual-write for ≥6 sprints (§4.6 evaluation: ~10+ files involved
-- in message creation / copy / render must be migrated in phases).
--
-- §14b §4.1: IMAsset already carries everything (kind, mime, cdnUrl,
-- thumbnailUrl) — no IMAsset changes needed; ContentBlock references assets
-- by assetId.
--
-- Schema deltas
-- -------------
-- ALTER im_messages: add contentBlocksJson JSON NULL. NULL during dual-write
-- window for legacy rows; readers fall back to `content + attachments`.
--
-- Idempotent
-- ----------
-- Column add guarded by information_schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_alter_messages_blocks;
DELIMITER //
CREATE PROCEDURE pc_v200_alter_messages_blocks()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_messages' AND column_name = 'contentBlocksJson'
  ) THEN
    ALTER TABLE im_messages ADD COLUMN contentBlocksJson JSON NULL AFTER attachments;
  END IF;
END//
DELIMITER ;
CALL pc_v200_alter_messages_blocks();
DROP PROCEDURE pc_v200_alter_messages_blocks;

SELECT
  'migration 406 v200 message contentBlocksJson complete' AS status,
  (SELECT COUNT(*) FROM im_messages) AS total_messages,
  (SELECT COUNT(*) FROM im_messages WHERE contentBlocksJson IS NOT NULL) AS messages_with_blocks;
