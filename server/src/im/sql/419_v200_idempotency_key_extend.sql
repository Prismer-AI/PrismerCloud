-- ============================================================================
-- Migration 419: v2.0 — Extend idempotencyKey VARCHAR(64) → VARCHAR(255)
-- Date: 2026-05-22
-- Spec: evidence/14-g2-idempotency-overflow.md
--
-- Background
-- ----------
-- Migration 402 created `im_messages.idempotencyKey VARCHAR(64) NULL` and
-- migration 404 created `im_dispatch_replies.idempotencyKey VARCHAR(64) NOT
-- NULL`. Both columns are too short for the keys actually produced by
-- production code paths:
--
--   1. Legacy /dispatch/reply path
--      (`agent-dispatcher.ts::dispatchReplyIdempotencyKey`):
--        `dispatch_reply:{conversationId}:{replyToMessageId}:{agentImUserId}`
--      With cuid-style 25-char IDs the total length is ~92 chars, well over
--      the 64-char limit. The server-side write raises
--      "The provided value for the column is too long for the column's type."
--      and the legacy /dispatch/reply endpoint returns HTTP 500
--      DISPATCH_REPLY_PERSIST_FAILED. F2 (Wave 5 Python SDK reply migration)
--      surfaced this and adjusted its 8th test to a weaker assertion as a
--      workaround.
--
--   2. New /dispatch/:taskId/prepare path
--      (`dispatch-reply.service.ts::prepareDispatchReply`):
--        daemon-supplied idempotencyKey persisted verbatim into
--        im_dispatch_replies.idempotencyKey VARCHAR(64).
--      A daemon SDK that uses a UUIDv4-pair (74 chars) or any namespaced
--      key over 64 chars hits the same column-too-long error.
--
-- Choice of fix
-- -------------
-- Schema extension (A) over server-side hashing (C) because:
--   - All existing rows are <= 64 chars → no data migration / rehash needed.
--   - Backward compatible with all SDKs (no protocol change).
--   - Same column type already used on im_sync_event_outbox.idempotencyKey
--     (line 1069 of prisma/schema.mysql.prisma) without issue.
--   - Composite UNIQUE (conversationId VARCHAR(30), idempotencyKey
--     VARCHAR(255)) totals 285 chars × 4 bytes = 1140 bytes per row, well
--     under InnoDB row-format DYNAMIC's 3072-byte index limit.
--
-- Schema deltas
-- -------------
-- 1) im_messages.idempotencyKey         VARCHAR(64) NULL     → VARCHAR(255) NULL
-- 2) im_dispatch_replies.idempotencyKey VARCHAR(64) NOT NULL → VARCHAR(255) NOT NULL
--
-- Idempotent
-- ----------
-- Guarded by information_schema.columns CHARACTER_MAXIMUM_LENGTH lookup so the
-- ALTER is a no-op when the column is already VARCHAR(255).
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_extend_idem_key;
DELIMITER //
CREATE PROCEDURE pc_v200_extend_idem_key()
BEGIN
  DECLARE messages_len INT DEFAULT 0;
  DECLARE replies_len INT DEFAULT 0;

  SELECT CHARACTER_MAXIMUM_LENGTH INTO messages_len
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'im_messages'
      AND column_name = 'idempotencyKey';

  SELECT CHARACTER_MAXIMUM_LENGTH INTO replies_len
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'im_dispatch_replies'
      AND column_name = 'idempotencyKey';

  -- im_messages.idempotencyKey: keep NULL semantics (so existing UNIQUE index
  -- excludes nulls). MySQL ALTER preserves the index automatically; the unique
  -- index `im_messages_idem` over (conversationId, idempotencyKey) is rebuilt
  -- in-place.
  IF messages_len IS NOT NULL AND messages_len < 255 THEN
    ALTER TABLE im_messages MODIFY COLUMN idempotencyKey VARCHAR(255) NULL;
  END IF;

  -- im_dispatch_replies.idempotencyKey: NOT NULL retained. Same index
  -- (uniq_task_idem on (taskId, idempotencyKey)) preserved across the ALTER.
  IF replies_len IS NOT NULL AND replies_len < 255 THEN
    ALTER TABLE im_dispatch_replies MODIFY COLUMN idempotencyKey VARCHAR(255) NOT NULL;
  END IF;
END//
DELIMITER ;
CALL pc_v200_extend_idem_key();
DROP PROCEDURE pc_v200_extend_idem_key;

SELECT
  'migration 419 v200 idempotency_key extend complete' AS status,
  (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_messages' AND column_name = 'idempotencyKey'
  ) AS im_messages_idem_len,
  (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_dispatch_replies' AND column_name = 'idempotencyKey'
  ) AS im_dispatch_replies_idem_len;
