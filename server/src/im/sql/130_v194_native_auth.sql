-- ============================================================================
-- Migration 130: v1.9.4 — Native Auth: extend im_users with email/phone/OAuth
--                         + numericId bigint allocator
--
-- Problem:
--   im_users has passwordHash (pre-wired) but lacks the identity columns
--   needed for native Next.js authentication (email/password, OAuth, phone).
--   pc_user_credits / pc_api_keys / pc_payments reference a BIGINT user_id
--   by value — we need a BIGINT allocator on im_users for new native-auth
--   users so the same integer key can be reused across all pc_* tables.
--
-- Dual-column transition (intentional, NOT a rename):
--   userId VARCHAR(50)  — KEPT AS-IS. Points to the Go backend's string user
--                         id (prismer_info.users.id). All existing code that
--                         reads im_users.userId continues to work unchanged.
--   numericId BIGINT UNSIGNED AUTO_INCREMENT UNIQUE NULL — NEW. For native-
--                         auth users created by Next.js. The auth flow writes
--                         this column on insert. pc_user_credits / pc_payments
--                         will reference this value for new accounts. Legacy
--                         rows (created by the Go backend flow) leave NULL.
--
-- Columns added (7 total, all NULL on existing rows):
--   email         VARCHAR(255)       UNIQUE NULL
--   phone         VARCHAR(20)        UNIQUE NULL
--   googleId      VARCHAR(64)        UNIQUE NULL
--   githubId      VARCHAR(64)        UNIQUE NULL
--   twitterId     VARCHAR(64)        UNIQUE NULL
--   emailVerified TINYINT(1) NOT NULL DEFAULT 0  (back-fills to 0)
--   numericId     BIGINT UNSIGNED    AUTO_INCREMENT UNIQUE NULL
--
-- Idempotent: every ADD COLUMN / ADD INDEX is INFORMATION_SCHEMA-guarded.
-- Re-running on a DB that already has these columns is a no-op.
-- ============================================================================

DROP FUNCTION IF EXISTS _130_table_exists;
DELIMITER //
CREATE FUNCTION _130_table_exists(tbl VARCHAR(64)) RETURNS TINYINT
  READS SQL DATA
  DETERMINISTIC
BEGIN
  RETURN (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl);
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _130_add_col_if_missing;
DELIMITER //
CREATE PROCEDURE _130_add_col_if_missing(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF _130_table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @_130_stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE _130_s FROM @_130_stmt; EXECUTE _130_s; DEALLOCATE PREPARE _130_s;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _130_add_unique_if_missing;
DELIMITER //
CREATE PROCEDURE _130_add_unique_if_missing(IN tbl VARCHAR(64), IN idx_name VARCHAR(64), IN col VARCHAR(64))
BEGIN
  IF _130_table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx_name) = 0 THEN
    SET @_130_stmt := CONCAT('ALTER TABLE `', tbl, '` ADD UNIQUE KEY `', idx_name, '` (`', col, '`)');
    PREPARE _130_s FROM @_130_stmt; EXECUTE _130_s; DEALLOCATE PREPARE _130_s;
  END IF;
END //
DELIMITER ;

-- ----------------------------------------------------------------------------
-- Step 1: ADD email / phone / OAuth provider id columns
-- ----------------------------------------------------------------------------

CALL _130_add_col_if_missing('im_users', 'email',
  'VARCHAR(255) NULL DEFAULT NULL COMMENT ''primary login email (native auth)''');

CALL _130_add_col_if_missing('im_users', 'phone',
  'VARCHAR(20) NULL DEFAULT NULL COMMENT ''E.164 phone (SMS auth)''');

CALL _130_add_col_if_missing('im_users', 'googleId',
  'VARCHAR(64) NULL DEFAULT NULL');
CALL _130_add_col_if_missing('im_users', 'githubId',
  'VARCHAR(64) NULL DEFAULT NULL');
CALL _130_add_col_if_missing('im_users', 'twitterId',
  'VARCHAR(64) NULL DEFAULT NULL');

CALL _130_add_col_if_missing('im_users', 'emailVerified',
  'TINYINT(1) NOT NULL DEFAULT 0');

-- ----------------------------------------------------------------------------
-- Step 2: ADD numericId — BIGINT UNSIGNED AUTO_INCREMENT UNIQUE NULL
--
-- MySQL 8 InnoDB allows AUTO_INCREMENT on a non-PK column as long as it's
-- covered by a UNIQUE KEY. The column is NULL by default; INSERTs that pass
-- DEFAULT (or omit the column) get an auto-allocated bigint. Existing rows
-- created before this migration retain numericId = NULL — that's fine.
-- ----------------------------------------------------------------------------

-- AUTO_INCREMENT requires the column to be the leading column of an index
-- AT CREATION TIME (ALTER TABLE ADD COLUMN ... AUTO_INCREMENT fails if no
-- index covers the column yet). Two-step: ADD as plain BIGINT, ADD UNIQUE
-- index, then MODIFY to add AUTO_INCREMENT.
CALL _130_add_col_if_missing('im_users', 'numericId',
  'BIGINT UNSIGNED NULL DEFAULT NULL');
CALL _130_add_unique_if_missing('im_users', 'im_users_numericId_key', 'numericId');

-- Now safe to add AUTO_INCREMENT (idempotent: skip if already auto-increment).
-- Use INFORMATION_SCHEMA.COLUMNS.EXTRA to detect existing AUTO_INCREMENT.
DROP PROCEDURE IF EXISTS _130_make_autoincrement;
DELIMITER //
CREATE PROCEDURE _130_make_autoincrement()
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'im_users'
         AND COLUMN_NAME = 'numericId'
         AND EXTRA LIKE '%auto_increment%') = 0 THEN
    ALTER TABLE `im_users`
      MODIFY COLUMN `numericId` BIGINT UNSIGNED NULL DEFAULT NULL AUTO_INCREMENT;
  END IF;
END //
DELIMITER ;
CALL _130_make_autoincrement();
DROP PROCEDURE IF EXISTS _130_make_autoincrement;

-- Unique indices for the auth columns. NULL values don't count for uniqueness
-- in MySQL, so multiple agent rows with NULL email are fine.
CALL _130_add_unique_if_missing('im_users', 'im_users_email_key',     'email');
CALL _130_add_unique_if_missing('im_users', 'im_users_phone_key',     'phone');
CALL _130_add_unique_if_missing('im_users', 'im_users_googleId_key',  'googleId');
CALL _130_add_unique_if_missing('im_users', 'im_users_githubId_key',  'githubId');
CALL _130_add_unique_if_missing('im_users', 'im_users_twitterId_key', 'twitterId');

-- ----------------------------------------------------------------------------
-- Step 3: cleanup helpers
-- ----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS _130_add_col_if_missing;
DROP PROCEDURE IF EXISTS _130_add_unique_if_missing;
DROP FUNCTION  IF EXISTS _130_table_exists;

SELECT 'migration 130 complete' AS status;
