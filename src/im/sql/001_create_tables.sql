-- ==============================================================================
-- Prismer IM Server - MySQL 建表脚本
-- ==============================================================================
--
-- 安全说明:
-- - 此脚本仅创建 im_* 前缀的表，不影响其他表
-- - 使用 CREATE TABLE IF NOT EXISTS，可重复执行
-- - 不包含任何 DROP、TRUNCATE、DELETE 语句
-- - 不修改任何现有数据
--
-- 事务说明:
-- - MySQL DDL 语句会触发隐式提交，无法真正回滚
-- - 但保留事务语句以便将来添加 DML 时使用
-- - 建表顺序已考虑外键依赖关系
--
-- 执行方式:
-- mysql -h <host> -u <user> -p <database> < 001_create_tables.sql
--
-- ==============================================================================

-- 设置字符集
SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- 开启事务 (注意: DDL 会隐式提交)
START TRANSACTION;

-- 设置外键检查 (建表时暂时关闭以避免顺序依赖问题)
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;

-- ==============================================================================
-- 表 1: im_users - IM 用户表
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_users` (
  `id` VARCHAR(30) NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `displayName` VARCHAR(200) NOT NULL,
  `passwordHash` VARCHAR(255) DEFAULT NULL,
  `role` VARCHAR(20) NOT NULL DEFAULT 'human' COMMENT 'human | agent | admin',
  `agentType` VARCHAR(30) DEFAULT NULL COMMENT 'assistant | specialist | orchestrator | tool | bot',
  `avatarUrl` VARCHAR(500) DEFAULT NULL,
  `metadata` TEXT DEFAULT NULL COMMENT 'JSON',
  `userId` VARCHAR(50) DEFAULT NULL COMMENT '关联主应用用户ID',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_users_username_key` (`username`),
  KEY `im_users_userId_idx` (`userId`),
  KEY `im_users_role_idx` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 表 2: im_agent_cards - Agent 能力声明表
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_agent_cards` (
  `id` VARCHAR(30) NOT NULL,
  `imUserId` VARCHAR(30) NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `description` TEXT NOT NULL,
  `agentType` VARCHAR(30) NOT NULL DEFAULT 'assistant',
  `capabilities` JSON NOT NULL DEFAULT ('[]') COMMENT 'AgentCapability[]',
  `protocolVersion` VARCHAR(20) NOT NULL DEFAULT '1.0',
  `endpoint` VARCHAR(500) DEFAULT NULL COMMENT 'HTTP endpoint for direct invocation',
  `metadata` JSON NOT NULL DEFAULT ('{}'),
  `lastHeartbeat` DATETIME(3) DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'offline' COMMENT 'online | busy | idle | offline',
  `load` DOUBLE NOT NULL DEFAULT 0 COMMENT '0-1 utilization',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_agent_cards_imUserId_key` (`imUserId`),
  KEY `im_agent_cards_status_idx` (`status`),
  CONSTRAINT `im_agent_cards_imUserId_fkey` FOREIGN KEY (`imUserId`)
    REFERENCES `im_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 表 3: im_conversations - 对话表
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_conversations` (
  `id` VARCHAR(30) NOT NULL,
  `type` VARCHAR(20) NOT NULL DEFAULT 'direct' COMMENT 'direct | group | channel',
  `title` VARCHAR(255) DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active | archived | deleted',
  `metadata` JSON NOT NULL DEFAULT ('{}'),
  `createdById` VARCHAR(30) NOT NULL,
  `workspaceId` VARCHAR(50) DEFAULT NULL COMMENT '关联 Workspace (1:1)',
  `lastMessageAt` DATETIME(3) DEFAULT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_conversations_workspaceId_key` (`workspaceId`),
  KEY `im_conversations_status_idx` (`status`),
  KEY `im_conversations_createdById_idx` (`createdById`),
  KEY `im_conversations_lastMessageAt_idx` (`lastMessageAt`),
  CONSTRAINT `im_conversations_createdById_fkey` FOREIGN KEY (`createdById`)
    REFERENCES `im_users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 表 4: im_participants - 参与者表
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_participants` (
  `id` VARCHAR(30) NOT NULL,
  `conversationId` VARCHAR(30) NOT NULL,
  `imUserId` VARCHAR(30) NOT NULL,
  `role` VARCHAR(20) NOT NULL DEFAULT 'member' COMMENT 'owner | admin | member | observer',
  `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `leftAt` DATETIME(3) DEFAULT NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_participants_conversationId_imUserId_key` (`conversationId`, `imUserId`),
  KEY `im_participants_imUserId_idx` (`imUserId`),
  CONSTRAINT `im_participants_conversationId_fkey` FOREIGN KEY (`conversationId`)
    REFERENCES `im_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `im_participants_imUserId_fkey` FOREIGN KEY (`imUserId`)
    REFERENCES `im_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 表 5: im_messages - 消息表
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_messages` (
  `id` VARCHAR(30) NOT NULL,
  `conversationId` VARCHAR(30) NOT NULL,
  `senderId` VARCHAR(30) NOT NULL,
  `type` VARCHAR(30) NOT NULL DEFAULT 'text' COMMENT 'text | markdown | code | image | file | tool_call | tool_result | system_event | thinking',
  `content` LONGTEXT NOT NULL,
  `metadata` JSON NOT NULL DEFAULT ('{}') COMMENT 'MessageMetadata',
  `parentId` VARCHAR(30) DEFAULT NULL COMMENT 'For threading',
  `status` VARCHAR(20) NOT NULL DEFAULT 'sent' COMMENT 'sending | sent | delivered | read | failed',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `im_messages_conversationId_idx` (`conversationId`),
  KEY `im_messages_senderId_idx` (`senderId`),
  KEY `im_messages_createdAt_idx` (`createdAt`),
  KEY `im_messages_parentId_idx` (`parentId`),
  CONSTRAINT `im_messages_conversationId_fkey` FOREIGN KEY (`conversationId`)
    REFERENCES `im_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `im_messages_senderId_fkey` FOREIGN KEY (`senderId`)
    REFERENCES `im_users` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 表 6: im_webhooks - Webhook 配置表
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_webhooks` (
  `id` VARCHAR(30) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `events` JSON NOT NULL DEFAULT ('[]') COMMENT 'string[]',
  `secret` VARCHAR(100) DEFAULT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `createdById` VARCHAR(30) NOT NULL,
  `failureCount` INT NOT NULL DEFAULT 0,
  `lastTriggered` DATETIME(3) DEFAULT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `im_webhooks_active_idx` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 恢复设置并提交
-- ==============================================================================

-- 恢复外键检查
SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;

-- 提交事务
COMMIT;

-- ==============================================================================
-- 完成
-- ==============================================================================
SELECT 'IM Server 表创建完成 (6 张表)' AS message;
SELECT '- im_users' AS tables UNION ALL
SELECT '- im_agent_cards' UNION ALL
SELECT '- im_conversations' UNION ALL
SELECT '- im_participants' UNION ALL
SELECT '- im_messages' UNION ALL
SELECT '- im_webhooks';
