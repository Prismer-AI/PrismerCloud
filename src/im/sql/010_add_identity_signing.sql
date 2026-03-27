-- Migration 010: E2E Encryption Layer 1+2 — Identity Keys & Message Signing
-- Date: 2026-03-09
-- Version: v1.7.2

-- ─── Layer 1: Identity Key Store ───────────────────────────────

CREATE TABLE IF NOT EXISTS `im_identity_keys` (
  `id` VARCHAR(30) NOT NULL,
  `imUserId` VARCHAR(30) NOT NULL,
  `publicKey` VARCHAR(64) NOT NULL COMMENT 'Base64 Ed25519 public key (32 bytes)',
  `keyId` VARCHAR(16) NOT NULL COMMENT 'SHA-256(publicKey)[0:8] hex',
  `attestation` TEXT NULL COMMENT 'Server Ed25519 attestation signature (Base64)',
  `derivationMode` VARCHAR(20) NOT NULL DEFAULT 'generated',
  `registeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revokedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `im_identity_keys_imUserId_key` (`imUserId`),
  KEY `im_identity_keys_keyId_idx` (`keyId`),
  CONSTRAINT `im_identity_keys_imUserId_fkey` FOREIGN KEY (`imUserId`) REFERENCES `im_users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Layer 1: Key Audit Log (append-only, hash-chained) ───────

CREATE TABLE IF NOT EXISTS `im_key_audit_log` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `imUserId` VARCHAR(30) NOT NULL,
  `action` VARCHAR(20) NOT NULL COMMENT 'register | rotate | revoke',
  `publicKey` VARCHAR(64) NOT NULL,
  `keyId` VARCHAR(16) NOT NULL,
  `attestation` TEXT NOT NULL,
  `prevLogHash` VARCHAR(64) NULL COMMENT 'SHA-256 hash chain link',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `im_key_audit_log_imUserId_createdAt_idx` (`imUserId`, `createdAt`),
  KEY `im_key_audit_log_keyId_idx` (`keyId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Layer 2: Conversation Security Policy ────────────────────

CREATE TABLE IF NOT EXISTS `im_conversation_security` (
  `id` VARCHAR(30) NOT NULL,
  `conversationId` VARCHAR(30) NOT NULL,
  `signingPolicy` VARCHAR(20) NOT NULL DEFAULT 'optional' COMMENT 'optional | recommended | required',
  `encryptionMode` VARCHAR(20) NOT NULL DEFAULT 'none',
  `lastSequences` TEXT NOT NULL COMMENT 'JSON: { senderId: { highestSeq, windowBitmap } }',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `im_conversation_security_conversationId_key` (`conversationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Layer 2: Message Signing Fields ──────────────────────────

ALTER TABLE `im_messages`
  ADD COLUMN `secVersion` INT NULL COMMENT 'Security protocol version (null = unsigned)',
  ADD COLUMN `senderKeyId` VARCHAR(16) NULL COMMENT 'Identity key ID used for signing',
  ADD COLUMN `sequence` INT NULL COMMENT 'Per-sender per-conversation sequence number',
  ADD COLUMN `contentHash` VARCHAR(64) NULL COMMENT 'SHA-256(content) hex',
  ADD COLUMN `prevHash` VARCHAR(64) NULL COMMENT 'Previous message contentHash (hash chain)',
  ADD COLUMN `signature` TEXT NULL COMMENT 'Ed25519 signature (Base64, 64 bytes)';

ALTER TABLE `im_messages`
  ADD INDEX `im_messages_conversationId_senderId_sequence_idx` (`conversationId`, `senderId`, `sequence`);

-- ─── Layer 1: User Trust Fields ───────────────────────────────

ALTER TABLE `im_users`
  ADD COLUMN `trustTier` INT NOT NULL DEFAULT 0,
  ADD COLUMN `violationCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `suspendedUntil` DATETIME(3) NULL;
