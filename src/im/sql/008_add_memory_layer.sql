-- ============================================================================
-- Migration 008: Memory Layer (v1.7.2)
--
-- Adds two tables for the Agent Memory System:
--   1. im_compaction_summaries — Working Memory (conversation-level compaction)
--   2. im_memory_files — Episodic Memory (persistent Markdown files)
--
-- Run: mysql -h <host> -u <user> -p <database> < 008_add_memory_layer.sql
-- ============================================================================

-- ─── Compaction Summaries (Working Memory) ───────────────────

CREATE TABLE IF NOT EXISTS `im_compaction_summaries` (
  `id`                  VARCHAR(30) NOT NULL,
  `conversationId`      VARCHAR(30) NOT NULL,
  `summary`             LONGTEXT NOT NULL,
  `messageRangeStart`   VARCHAR(30) DEFAULT NULL,
  `messageRangeEnd`     VARCHAR(30) DEFAULT NULL,
  `tokenCount`          INT NOT NULL DEFAULT 0,
  `createdAt`           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `idx_compaction_conversation` (`conversationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Memory Files (Episodic Memory) ─────────────────────────

CREATE TABLE IF NOT EXISTS `im_memory_files` (
  `id`          VARCHAR(30) NOT NULL,
  `ownerId`     VARCHAR(30) NOT NULL,
  `ownerType`   VARCHAR(10) NOT NULL DEFAULT 'agent',
  `scope`       VARCHAR(50) NOT NULL DEFAULT 'global',
  `path`        VARCHAR(255) NOT NULL DEFAULT 'MEMORY.md',
  `content`     MEDIUMTEXT NOT NULL,
  `version`     INT NOT NULL DEFAULT 1,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `idx_owner_scope_path` (`ownerId`, `scope`, `path`),
  INDEX `idx_owner` (`ownerId`, `ownerType`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Verify ─────────────────────────────────────────────────

SELECT 'im_compaction_summaries' AS `table`, COUNT(*) AS `rows` FROM `im_compaction_summaries`
UNION ALL
SELECT 'im_memory_files', COUNT(*) FROM `im_memory_files`;
