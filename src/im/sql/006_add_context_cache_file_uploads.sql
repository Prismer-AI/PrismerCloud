-- ==============================================================================
-- v1.6.0: Context Cache + File Uploads
-- ==============================================================================
--
-- Adds two new tables:
--   1. im_context_cache  — Prisma-first context cache (replaces backend context_data)
--   2. im_file_uploads   — IM file transfer upload records
--
-- Usage:
--   mysql -u prismer_cloud -p prismer_cloud < 006_add_context_cache_file_uploads.sql
--
-- ==============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- --------------------------------------------------------------------------
-- Context Cache
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `im_context_cache` (
  `id`            VARCHAR(30)  NOT NULL,
  `userId`        VARCHAR(50)  NOT NULL,
  `rawLink`       TEXT         NOT NULL,
  `rawLinkHash`   VARCHAR(64)  NOT NULL,
  `contentUri`    VARCHAR(500) DEFAULT NULL,
  `hqccContent`   LONGTEXT     NOT NULL,
  `intrContent`   LONGTEXT     DEFAULT NULL,
  `visibility`    VARCHAR(20)  NOT NULL DEFAULT 'private',
  `meta`          TEXT         NOT NULL,
  `sizeBytes`     INT          NOT NULL DEFAULT 0,
  `expiresAt`     DATETIME(3)  DEFAULT NULL,
  `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_context_cache_rawLinkHash_key` (`rawLinkHash`),
  KEY `im_context_cache_userId_idx` (`userId`),
  KEY `im_context_cache_userId_visibility_idx` (`userId`, `visibility`),
  KEY `im_context_cache_expiresAt_idx` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- File Uploads
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `im_file_uploads` (
  `id`            VARCHAR(30)  NOT NULL,
  `imUserId`      VARCHAR(30)  NOT NULL,
  `uploadId`      VARCHAR(200) NOT NULL,
  `fileName`      VARCHAR(500) NOT NULL,
  `fileSize`      INT          NOT NULL,
  `mimeType`      VARCHAR(100) NOT NULL,
  `sha256`        VARCHAR(64)  DEFAULT NULL,
  `s3Key`         VARCHAR(500) DEFAULT NULL,
  `cdnUrl`        VARCHAR(500) DEFAULT NULL,
  `status`        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  `expiresAt`     DATETIME(3)  DEFAULT NULL,
  `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `im_file_uploads_uploadId_key` (`uploadId`),
  KEY `im_file_uploads_imUserId_idx` (`imUserId`),
  KEY `im_file_uploads_status_idx` (`status`),
  CONSTRAINT `im_file_uploads_imUserId_fkey`
    FOREIGN KEY (`imUserId`) REFERENCES `im_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
