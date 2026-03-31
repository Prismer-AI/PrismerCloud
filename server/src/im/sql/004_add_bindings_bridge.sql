-- ==============================================================================
-- Prismer IM Server - v0.3.0 迁移: 添加 im_bindings + im_bridge_messages
-- ==============================================================================
--
-- 新增社交平台绑定表和消息桥接记录表
-- im_credits / im_credit_transactions 仅用于 dev (SQLite)，
-- 生产环境通过 CloudCreditService 桥接到 pc_user_credits / pc_credit_transactions
--
-- 执行方式:
-- node src/im/sql/run-migration.js 004
-- 或手动:
-- mysql -h <host> -u <user> -p <database> < 004_add_bindings_bridge.sql
--
-- ==============================================================================

SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- ==============================================================================
-- 表: im_bindings - 社交平台绑定
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_bindings` (
  `id` VARCHAR(30) NOT NULL,
  `imUserId` VARCHAR(30) NOT NULL,
  `platform` VARCHAR(30) NOT NULL COMMENT 'telegram | discord | slack | wechat | x | line',
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending | active | failed | revoked',

  -- 平台侧信息
  `externalId` VARCHAR(200) DEFAULT NULL COMMENT '平台用户 ID',
  `externalName` VARCHAR(200) DEFAULT NULL COMMENT '平台用户名',

  -- 认证信息
  `botToken` VARCHAR(500) DEFAULT NULL COMMENT 'Bot Token',
  `webhookUrl` VARCHAR(500) DEFAULT NULL COMMENT 'Webhook URL',
  `channelId` VARCHAR(100) DEFAULT NULL COMMENT 'channel/chat ID',

  -- 验证
  `verificationCode` VARCHAR(10) DEFAULT NULL,
  `verifiedAt` DATETIME(3) DEFAULT NULL,

  -- 能力
  `capabilities` JSON NOT NULL DEFAULT (JSON_ARRAY()) COMMENT '["receive_message","send_message"]',

  -- 配置
  `config` JSON NOT NULL DEFAULT (JSON_OBJECT()),

  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_bindings_imUserId_platform_key` (`imUserId`, `platform`),
  KEY `im_bindings_platform_status_idx` (`platform`, `status`),
  CONSTRAINT `im_bindings_imUserId_fkey` FOREIGN KEY (`imUserId`)
    REFERENCES `im_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 表: im_bridge_messages - 消息桥接记录
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_bridge_messages` (
  `id` VARCHAR(30) NOT NULL,
  `bindingId` VARCHAR(30) NOT NULL,
  `direction` VARCHAR(10) NOT NULL COMMENT 'inbound | outbound',

  -- IM 侧
  `imMessageId` VARCHAR(30) DEFAULT NULL,
  `imConversationId` VARCHAR(30) DEFAULT NULL,

  -- 外部侧
  `externalMessageId` VARCHAR(200) DEFAULT NULL,

  -- 状态
  `status` VARCHAR(20) NOT NULL DEFAULT 'sent' COMMENT 'sent | delivered | failed',
  `errorMessage` TEXT DEFAULT NULL,

  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `im_bridge_messages_bindingId_idx` (`bindingId`),
  KEY `im_bridge_messages_imMessageId_idx` (`imMessageId`),
  CONSTRAINT `im_bridge_messages_bindingId_fkey` FOREIGN KEY (`bindingId`)
    REFERENCES `im_bindings` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 完成
-- ==============================================================================
SELECT 'im_bindings + im_bridge_messages 表创建完成 (v0.3.0)' AS message;
