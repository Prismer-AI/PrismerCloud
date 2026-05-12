-- ==============================================================================
-- Migration 007: Sync Events table (v1.7.0 offline-first SDK)
-- ==============================================================================
--
-- Each mutation (message, conversation, participant) writes a sync event.
-- Clients poll GET /api/im/sync?since=<cursor> or subscribe to SSE /sync/stream.
-- Auto-increment ID serves as the monotonic cursor.
--
-- Usage:
--   mysql -u prismer_cloud -p prismer_cloud < 007_add_sync_events.sql
--
-- ==============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `im_sync_events` (
  `id`              INT          NOT NULL AUTO_INCREMENT,
  `type`            VARCHAR(50)  NOT NULL COMMENT 'message.new | message.edit | message.delete | conversation.create | conversation.update | conversation.archive | participant.add | participant.remove',
  `data`            TEXT         NOT NULL COMMENT 'JSON payload',
  `conversationId`  VARCHAR(30)  DEFAULT NULL,
  `imUserId`        VARCHAR(30)  NOT NULL COMMENT 'Target user who should see this event',
  `createdAt`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `im_sync_events_imUserId_idx` (`imUserId`),
  KEY `im_sync_events_conversationId_idx` (`conversationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify
SELECT COUNT(*) AS sync_events_table_exists
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'im_sync_events';
