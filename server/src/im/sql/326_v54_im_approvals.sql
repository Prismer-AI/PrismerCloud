-- ACP P4: Human approval inbox.
-- Agents create structured approval requests; humans decide in workspace UI.

CREATE TABLE IF NOT EXISTS `im_approvals` (
  `id`             VARCHAR(30) NOT NULL,
  `workspaceId`    VARCHAR(30) NOT NULL,
  `conversationId` VARCHAR(36) NULL,
  `taskId`         VARCHAR(30) NULL,
  `requestedById`  VARCHAR(36) NOT NULL,
  `decidedById`    VARCHAR(36) NULL,
  `category`       VARCHAR(50) NOT NULL,
  `title`          VARCHAR(255) NOT NULL,
  `context`        TEXT NULL,
  `options`        TEXT NOT NULL,
  `status`         VARCHAR(20) NOT NULL DEFAULT 'pending',
  `selectedValue`  VARCHAR(100) NULL,
  `metadata`       TEXT NOT NULL,
  `expiresAt`      DATETIME(3) NULL,
  `decidedAt`      DATETIME(3) NULL,
  `createdAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `im_approvals_workspaceId_status_createdAt_idx` (`workspaceId`, `status`, `createdAt`),
  KEY `im_approvals_conversationId_status_createdAt_idx` (`conversationId`, `status`, `createdAt`),
  KEY `im_approvals_taskId_status_idx` (`taskId`, `status`),
  KEY `im_approvals_requestedById_createdAt_idx` (`requestedById`, `createdAt`),
  KEY `im_approvals_decidedById_decidedAt_idx` (`decidedById`, `decidedAt`),
  CONSTRAINT `im_approvals_surface_chk` CHECK (`conversationId` IS NOT NULL OR `taskId` IS NOT NULL),
  CONSTRAINT `im_approvals_status_chk` CHECK (`status` IN ('pending', 'approved', 'rejected', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 326 im_approvals complete' AS status;
