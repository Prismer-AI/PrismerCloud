-- Migration 012: Evolution Achievements
-- MySQL 8.0 compatible (TEXT columns cannot have DEFAULT values)

CREATE TABLE IF NOT EXISTS `im_evolution_achievements` (
  `id` VARCHAR(30) NOT NULL,
  `agentId` VARCHAR(60) NOT NULL,
  `badgeKey` VARCHAR(60) NOT NULL,
  `unlockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `metadata` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_badge` (`agentId`, `badgeKey`),
  KEY `idx_agent` (`agentId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
