-- ==============================================================================
-- Prismer IM Server - v0.2.0 迁移: 添加 im_read_cursors 表
-- ==============================================================================
--
-- 新增已读位置追踪表，用于未读消息计数
--
-- 执行方式:
-- mysql -h <host> -u <user> -p <database> < 003_add_read_cursors.sql
--
-- ==============================================================================

SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- ==============================================================================
-- 表 7: im_read_cursors - 已读位置追踪
-- ==============================================================================
CREATE TABLE IF NOT EXISTS `im_read_cursors` (
  `id` VARCHAR(30) NOT NULL,
  `conversationId` VARCHAR(30) NOT NULL,
  `imUserId` VARCHAR(30) NOT NULL,
  `lastReadAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastReadMsgId` VARCHAR(30) DEFAULT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_read_cursors_conversationId_imUserId_key` (`conversationId`, `imUserId`),
  KEY `im_read_cursors_imUserId_idx` (`imUserId`),
  CONSTRAINT `im_read_cursors_conversationId_fkey` FOREIGN KEY (`conversationId`)
    REFERENCES `im_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `im_read_cursors_imUserId_fkey` FOREIGN KEY (`imUserId`)
    REFERENCES `im_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==============================================================================
-- 完成
-- ==============================================================================
SELECT 'im_read_cursors 表创建完成' AS message;
