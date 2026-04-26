-- 027: AIP + E2E 统一迁移 — DID 字段、encrypted 一等字段、新表
-- Date: 2026-03-29
-- Depends: 025_quality_score_reports.sql
-- Note: was originally 025; renumbered due to migration sequence fix

-- 1. im_identity_keys 扩展 (AIP Layer 1-2)
ALTER TABLE im_identity_keys ADD COLUMN didKey VARCHAR(128) NULL UNIQUE;
ALTER TABLE im_identity_keys ADD COLUMN didDocument MEDIUMTEXT NULL;
ALTER TABLE im_identity_keys ADD COLUMN didDocumentHash VARCHAR(64) NULL;

-- 2. im_users 扩展 (AIP Layer 1)
ALTER TABLE im_users ADD COLUMN primaryDid VARCHAR(128) NULL UNIQUE;
ALTER TABLE im_users ADD COLUMN delegatedBy VARCHAR(128) NULL;
CREATE INDEX idx_im_users_did ON im_users(primaryDid);

-- 3. im_messages 扩展 (AIP + E2E S5 修复)
ALTER TABLE im_messages ADD COLUMN senderDid VARCHAR(128) NULL;
ALTER TABLE im_messages ADD COLUMN delegationProof MEDIUMTEXT NULL;
ALTER TABLE im_messages ADD COLUMN encrypted TINYINT(1) NOT NULL DEFAULT 0;
CREATE INDEX idx_im_messages_did ON im_messages(senderDid);

-- 4. im_agent_cards 扩展 (AIP Layer 2)
ALTER TABLE im_agent_cards ADD COLUMN did VARCHAR(128) NULL;
ALTER TABLE im_agent_cards ADD COLUMN didDocumentUrl VARCHAR(512) NULL;

-- 5. im_agent_credentials (新表, AIP Layer 4)
CREATE TABLE IF NOT EXISTS im_agent_credentials (
  id VARCHAR(30) NOT NULL PRIMARY KEY,
  holderDid VARCHAR(128) NOT NULL,
  credentialType VARCHAR(50) NOT NULL,
  issuerDid VARCHAR(128) NOT NULL,
  credential MEDIUMTEXT NOT NULL,
  validFrom DATETIME(3) NOT NULL,
  validUntil DATETIME(3) NULL,
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_holder (holderDid),
  KEY idx_issuer (issuerDid),
  KEY idx_type (credentialType)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. im_did_mappings (新表, AIP Layer 1-2)
CREATE TABLE IF NOT EXISTS im_did_mappings (
  id VARCHAR(30) NOT NULL PRIMARY KEY,
  did VARCHAR(128) NOT NULL UNIQUE,
  imUserId VARCHAR(30) NOT NULL,
  didMethod VARCHAR(10) NOT NULL,
  isPrimary TINYINT(1) NOT NULL DEFAULT 0,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_user (imUserId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. im_revocation_entries (新表, AIP Layer 3)
CREATE TABLE IF NOT EXISTS im_revocation_entries (
  id VARCHAR(30) NOT NULL PRIMARY KEY,
  issuerDid VARCHAR(128) NOT NULL,
  targetDid VARCHAR(128) NOT NULL,
  credentialId VARCHAR(128) NULL,
  reason VARCHAR(500) NOT NULL,
  statusListIndex INT NOT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_revocation (issuerDid, targetDid, credentialId),
  KEY idx_target (targetDid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
