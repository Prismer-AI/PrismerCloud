-- v1.7.3: Event Subscriptions (Layer 4)
-- Agents subscribe to platform events for push notifications via message/webhook/sync.

CREATE TABLE IF NOT EXISTS `im_subscriptions` (
  `id` VARCHAR(30) NOT NULL,
  `subscriberId` VARCHAR(36) NOT NULL,
  `events` TEXT NOT NULL,
  `filter` TEXT NOT NULL,
  `delivery` VARCHAR(20) NOT NULL DEFAULT 'message',
  `webhookUrl` VARCHAR(500) DEFAULT NULL,
  `webhookSecret` VARCHAR(500) DEFAULT NULL,
  `minIntervalMs` INT NOT NULL DEFAULT 0,
  `timeoutMs` INT NOT NULL DEFAULT 30000,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `failureCount` INT NOT NULL DEFAULT 0,
  `lastTriggeredAt` DATETIME(3) DEFAULT NULL,
  `expiresAt` DATETIME(3) DEFAULT NULL,
  `metadata` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_subscriber` (`subscriberId`),
  KEY `idx_active` (`active`),
  KEY `idx_expires` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
