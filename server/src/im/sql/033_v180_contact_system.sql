-- ============================================================
-- v1.8.0 P9: Contact & Relationship System
-- ============================================================

-- 1. Friend Requests
CREATE TABLE IF NOT EXISTS im_friend_requests (
  id            VARCHAR(36) PRIMARY KEY,
  fromUserId    VARCHAR(36) NOT NULL,
  toUserId      VARCHAR(36) NOT NULL,
  reason        TEXT,
  source        VARCHAR(50),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_request (fromUserId, toUserId, status),
  INDEX idx_to_pending (toUserId, status),
  INDEX idx_from_pending (fromUserId, status),
  CONSTRAINT fk_fr_from FOREIGN KEY (fromUserId) REFERENCES im_users(id),
  CONSTRAINT fk_fr_to FOREIGN KEY (toUserId) REFERENCES im_users(id)
);

-- 2. Contacts (bidirectional friendship)
CREATE TABLE IF NOT EXISTS im_contacts (
  userId        VARCHAR(36) NOT NULL,
  contactId     VARCHAR(36) NOT NULL,
  remark        VARCHAR(100),
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (userId, contactId),
  INDEX idx_contact_reverse (contactId),
  CONSTRAINT fk_ct_user FOREIGN KEY (userId) REFERENCES im_users(id),
  CONSTRAINT fk_ct_contact FOREIGN KEY (contactId) REFERENCES im_users(id)
);

-- 3. Block list
CREATE TABLE IF NOT EXISTS im_blocks (
  userId        VARCHAR(36) NOT NULL,
  blockedId     VARCHAR(36) NOT NULL,
  reason        VARCHAR(200),
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (userId, blockedId),
  CONSTRAINT fk_bl_user FOREIGN KEY (userId) REFERENCES im_users(id),
  CONSTRAINT fk_bl_blocked FOREIGN KEY (blockedId) REFERENCES im_users(id)
);

-- 4 + 5: ADD COLUMN guards (Track A m3 phase 2 fix — MariaDB-only `IF NOT
-- EXISTS` syntax replaced with MySQL 8 INFORMATION_SCHEMA pattern).
DROP PROCEDURE IF EXISTS _033_add_col;
DELIMITER //
CREATE PROCEDURE _033_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- 4. Conversation controls (on existing table)
CALL _033_add_col('im_participants', 'pinned',   'TINYINT(1) NOT NULL DEFAULT 0');
CALL _033_add_col('im_participants', 'muted',    'TINYINT(1) NOT NULL DEFAULT 0');
CALL _033_add_col('im_participants', 'pinnedAt', 'DATETIME(3) DEFAULT NULL');

-- 5. User profile extensions
CALL _033_add_col('im_users', 'institution', 'VARCHAR(200) DEFAULT NULL');
CALL _033_add_col('im_users', 'description', 'VARCHAR(500) DEFAULT NULL');
CALL _033_add_col('im_users', 'lastSeenAt',  'DATETIME(3) DEFAULT NULL');

DROP PROCEDURE _033_add_col;
