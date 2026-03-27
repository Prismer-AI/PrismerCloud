-- ============================================================================
-- 040: Create pc_users table (self-host auth)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pc_users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar        VARCHAR(500) DEFAULT '',
  is_active     TINYINT(1) DEFAULT 1,
  email_verified TINYINT(1) DEFAULT 0,
  google_id     VARCHAR(255) DEFAULT '',
  github_id     VARCHAR(255) DEFAULT '',
  role          VARCHAR(32) DEFAULT 'user' COMMENT 'user | admin',
  last_login_at DATETIME NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME NULL,
  INDEX idx_email (email),
  INDEX idx_google_id (google_id),
  INDEX idx_github_id (github_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verification codes (transient, for email verification)
CREATE TABLE IF NOT EXISTS pc_verification_codes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(10) NOT NULL,
  type       VARCHAR(32) NOT NULL COMMENT 'signup | reset-password',
  expires_at DATETIME NOT NULL,
  used       TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_type (email, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
