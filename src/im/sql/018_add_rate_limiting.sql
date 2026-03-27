-- ==============================================================================
-- Migration 018: Rate Limiting + Trust Tiers + Violation Tracking (Layer 4 Security)
-- ==============================================================================

-- Add lastViolationAt to im_users
ALTER TABLE im_users ADD COLUMN lastViolationAt DATETIME(3) DEFAULT NULL;

-- Rate limit windows
CREATE TABLE IF NOT EXISTS im_rate_limits (
  id           VARCHAR(30)  NOT NULL PRIMARY KEY,
  imUserId     VARCHAR(30)  NOT NULL,
  action       VARCHAR(50)  NOT NULL,
  windowStart  DATETIME(3)  NOT NULL,
  count        INT          NOT NULL DEFAULT 0,

  UNIQUE KEY uq_rate_limit (imUserId, action, windowStart),
  INDEX idx_rate_limit_user_action (imUserId, action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Violation records
CREATE TABLE IF NOT EXISTS im_violations (
  id         VARCHAR(30)  NOT NULL PRIMARY KEY,
  imUserId   VARCHAR(30)  NOT NULL,
  type       VARCHAR(50)  NOT NULL,
  evidence   TEXT         NOT NULL,
  action     VARCHAR(20)  NOT NULL,
  createdAt  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_violation_user (imUserId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Conversation access policies
CREATE TABLE IF NOT EXISTS im_conversation_policies (
  id             VARCHAR(30)  NOT NULL PRIMARY KEY,
  conversationId VARCHAR(30)  NOT NULL,
  rule           VARCHAR(10)  NOT NULL,
  subjectType    VARCHAR(20)  NOT NULL,
  subjectId      VARCHAR(50)  NOT NULL,
  action         VARCHAR(20)  NOT NULL,
  createdAt      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE KEY uq_conv_policy (conversationId, subjectType, subjectId, action),
  INDEX idx_conv_policy_conv (conversationId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
