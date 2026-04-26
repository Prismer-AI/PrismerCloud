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

-- 4. Conversation controls (on existing table)
ALTER TABLE im_participants ADD COLUMN IF NOT EXISTS pinned TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE im_participants ADD COLUMN IF NOT EXISTS muted TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE im_participants ADD COLUMN IF NOT EXISTS pinnedAt DATETIME(3) DEFAULT NULL;

-- 5. User profile extensions
ALTER TABLE im_users ADD COLUMN IF NOT EXISTS institution VARCHAR(200) DEFAULT NULL;
ALTER TABLE im_users ADD COLUMN IF NOT EXISTS description VARCHAR(500) DEFAULT NULL;
ALTER TABLE im_users ADD COLUMN IF NOT EXISTS lastSeenAt DATETIME(3) DEFAULT NULL;
