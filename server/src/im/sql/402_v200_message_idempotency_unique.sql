-- ============================================================================
-- Migration 402: v2.0 — IMMessage.idempotencyKey first-class + DB UNIQUE
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.1
--
-- Background
-- ----------
-- X-Idempotency-Key header is already accepted by POST /messages
-- (message.service.ts:194 findByIdempotencyKey). But the key currently lives in
-- metadata JSON (`_idempotencyKey`), not as a first-class column with a UNIQUE
-- constraint. App-level findByIdempotencyKey + insert is two steps and is
-- racy under concurrent POST (no SELECT FOR UPDATE).
--
-- Schema deltas
-- -------------
-- ALTER im_messages: add idempotencyKey VARCHAR(64) NULL + composite UNIQUE
-- (conversationId, idempotencyKey). MySQL semantics: NULLs are excluded from
-- UNIQUE checks, so existing rows (which leave NULL) are fine.
--
-- Idempotent
-- ----------
-- Column add + index add guarded by information_schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_alter_messages_idem;
DELIMITER //
CREATE PROCEDURE pc_v200_alter_messages_idem()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_messages' AND column_name = 'idempotencyKey'
  ) THEN
    ALTER TABLE im_messages ADD COLUMN idempotencyKey VARCHAR(64) NULL AFTER metadata;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_messages' AND index_name = 'im_messages_idem'
  ) THEN
    CREATE UNIQUE INDEX im_messages_idem ON im_messages (conversationId, idempotencyKey);
  END IF;
END//
DELIMITER ;
CALL pc_v200_alter_messages_idem();
DROP PROCEDURE pc_v200_alter_messages_idem;

SELECT
  'migration 402 v200 message idempotency unique complete' AS status,
  (SELECT COUNT(*) FROM im_messages) AS total_messages,
  (SELECT COUNT(*) FROM im_messages WHERE idempotencyKey IS NOT NULL) AS messages_with_idem_key;
