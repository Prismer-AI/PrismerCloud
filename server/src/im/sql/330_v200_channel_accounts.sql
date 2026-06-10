-- ============================================================================
-- Migration 330: v2.0 — Channel accounts and external routing
--
-- Adds the v2.0 channel persistence surface without mutating the legacy
-- im_bindings table. Existing Telegram/Discord binding code keeps working;
-- Phase 2 channel code moves to im_channel_accounts explicitly.
--
-- MySQL strict mode note: JSON columns are nullable or use expression defaults;
-- no TEXT/LONGTEXT literal defaults are introduced.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _330_add_col_if_missing$$
CREATE PROCEDURE _330_add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _330_add_idx_if_missing$$
CREATE PROCEDURE _330_add_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_cols TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_idx, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _330_add_fk_if_missing$$
CREATE PROCEDURE _330_add_fk_if_missing(
  IN p_table VARCHAR(64),
  IN p_fk VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = p_table
      AND constraint_name = p_fk
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_fk, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CREATE TABLE IF NOT EXISTS `im_channel_accounts` (
  `id`                VARCHAR(30) NOT NULL,
  `ownerImUserId`     VARCHAR(30) NOT NULL,
  `workspaceId`       VARCHAR(30) NULL,
  `platform`          VARCHAR(30) NOT NULL,
  `label`             VARCHAR(200) NOT NULL,
  `status`            VARCHAR(20) NOT NULL DEFAULT 'pending',
  `credentials`       TEXT NOT NULL,
  `accountIdentifier` VARCHAR(200) NULL,
  `lastConnectedAt`   DATETIME(3) NULL,
  `lastErrorMessage`  TEXT NULL,
  `capabilities`      TEXT NOT NULL,
  `config`            TEXT NOT NULL,
  `createdAt`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `im_channel_accounts_owner_platform_idx` (`ownerImUserId`, `platform`),
  KEY `im_channel_accounts_workspace_platform_idx` (`workspaceId`, `platform`),
  KEY `im_channel_accounts_platform_status_idx` (`platform`, `status`),
  CONSTRAINT `im_channel_accounts_ownerImUserId_fkey`
    FOREIGN KEY (`ownerImUserId`) REFERENCES `im_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `im_channel_accounts_workspaceId_fkey`
    FOREIGN KEY (`workspaceId`) REFERENCES `im_workspaces` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE `im_channel_accounts`
SET
  `credentials` = COALESCE(NULLIF(`credentials`, ''), '{}'),
  `capabilities` = COALESCE(NULLIF(`capabilities`, ''), '{}'),
  `config` = COALESCE(NULLIF(`config`, ''), '{}');

CREATE TABLE IF NOT EXISTS `im_external_identities` (
  `id`               VARCHAR(30) NOT NULL,
  `channelAccountId` VARCHAR(30) NOT NULL,
  `externalUserId`   VARCHAR(200) NOT NULL,
  `externalName`     VARCHAR(200) NULL,
  `avatarUrl`        TEXT NULL,
  `linkedImUserId`   VARCHAR(30) NULL,
  `linkedAt`         DATETIME(3) NULL,
  `linkSource`       VARCHAR(50) NULL,
  `lastContextToken` VARCHAR(512) NULL,
  `tokenExpiresAt`   DATETIME(3) NULL,
  `firstSeenAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastSeenAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `metadata`         TEXT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `im_external_identities_channel_external_key` (`channelAccountId`, `externalUserId`),
  KEY `im_external_identities_linkedImUserId_idx` (`linkedImUserId`),
  KEY `im_external_identities_tokenExpiresAt_idx` (`tokenExpiresAt`),
  CONSTRAINT `im_external_identities_channelAccountId_fkey`
    FOREIGN KEY (`channelAccountId`) REFERENCES `im_channel_accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `im_external_identities_linkedImUserId_fkey`
    FOREIGN KEY (`linkedImUserId`) REFERENCES `im_users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE `im_external_identities`
SET `metadata` = COALESCE(NULLIF(`metadata`, ''), '{}');

CREATE TABLE IF NOT EXISTS `im_external_routings` (
  `id`                 VARCHAR(30) NOT NULL,
  `externalIdentityId` VARCHAR(30) NOT NULL,
  `conversationId`     VARCHAR(30) NOT NULL,
  `isDefault`          BOOLEAN NOT NULL DEFAULT FALSE,
  `lastInboundAt`      DATETIME(3) NULL,
  `lastOutboundAt`     DATETIME(3) NULL,
  `createdAt`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `im_external_routings_identity_conversation_key` (`externalIdentityId`, `conversationId`),
  KEY `im_external_routings_identity_default_idx` (`externalIdentityId`, `isDefault`),
  KEY `im_external_routings_conversationId_idx` (`conversationId`),
  CONSTRAINT `im_external_routings_externalIdentityId_fkey`
    FOREIGN KEY (`externalIdentityId`) REFERENCES `im_external_identities` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `im_external_routings_conversationId_fkey`
    FOREIGN KEY (`conversationId`) REFERENCES `im_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CALL _330_add_col_if_missing('im_bridge_messages', 'channelAccountId', 'VARCHAR(30) NULL AFTER `bindingId`');
CALL _330_add_col_if_missing('im_bridge_messages', 'externalIdentityId', 'VARCHAR(30) NULL AFTER `channelAccountId`');
CALL _330_add_col_if_missing('im_bridge_messages', 'externalGroupId', 'VARCHAR(200) NULL AFTER `externalMessageId`');
CALL _330_add_idx_if_missing('im_bridge_messages', 'im_bridge_messages_channelAccountId_direction_createdAt_idx', '`channelAccountId`, `direction`, `createdAt`');
CALL _330_add_idx_if_missing('im_bridge_messages', 'im_bridge_messages_externalMessageId_idx', '`externalMessageId`');
CALL _330_add_idx_if_missing('im_bridge_messages', 'im_bridge_messages_externalIdentityId_idx', '`externalIdentityId`');
CALL _330_add_fk_if_missing(
  'im_bridge_messages',
  'im_bridge_messages_channelAccountId_fkey',
  'FOREIGN KEY (`channelAccountId`) REFERENCES `im_channel_accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE'
);
CALL _330_add_fk_if_missing(
  'im_bridge_messages',
  'im_bridge_messages_externalIdentityId_fkey',
  'FOREIGN KEY (`externalIdentityId`) REFERENCES `im_external_identities` (`id`) ON DELETE SET NULL ON UPDATE CASCADE'
);

DROP PROCEDURE IF EXISTS _330_add_col_if_missing;
DROP PROCEDURE IF EXISTS _330_add_idx_if_missing;
DROP PROCEDURE IF EXISTS _330_add_fk_if_missing;

SELECT 'migration 330 v200 channel accounts complete' AS status;
