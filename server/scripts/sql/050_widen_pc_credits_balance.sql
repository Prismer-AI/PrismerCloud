-- ============================================================================
-- Migration 050: Widen pc_user_credits + pc_credit_transactions balance columns
-- Date: 2026-05-10
-- Track: hotfix for v1.9.56 test deploy
--
-- Background
-- ----------
-- pc_user_credits.balance / total_earned / total_spent and
-- pc_credit_transactions.amount / balance_after were declared DECIMAL(10,4),
-- giving max value 999_999.9999. The test environment hit overflow on
-- agent registration: existing balance ~991_406 + 10_000 grant > 999_999,
-- triggering ER_WARN_DATA_OUT_OF_RANGE (sqlState 22003) on the credit
-- grant UPDATE. The same column width has been propagating through
-- billing flows since the schema was first cut for the dev cap.
--
-- Fix: widen all five money-amount columns to DECIMAL(15,4) — max
-- 99_999_999_999.9999, well above any realistic credits-as-currency
-- range. Existing rows are losslessly migrated since the new precision
-- is a strict superset.
--
-- Idempotent: every MODIFY guards on current column type via
-- information_schema lookup.
-- ============================================================================

DROP PROCEDURE IF EXISTS _050_widen_decimal_if_narrow;
DELIMITER //
CREATE PROCEDURE _050_widen_decimal_if_narrow(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_default VARCHAR(32)
)
BEGIN
  DECLARE current_precision INT DEFAULT NULL;
  SELECT NUMERIC_PRECISION
    INTO current_precision
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = p_table
     AND column_name = p_col
   LIMIT 1;

  IF current_precision IS NOT NULL AND current_precision < 15 THEN
    SET @sql = CONCAT(
      'ALTER TABLE `', p_table,
      '` MODIFY COLUMN `', p_col,
      '` DECIMAL(15,4)',
      IF(p_default IS NOT NULL AND p_default <> '', CONCAT(' DEFAULT ', p_default), '')
    );
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- pc_user_credits — three balance columns + optional defaults
CALL _050_widen_decimal_if_narrow('pc_user_credits', 'balance',      '100.0000');
CALL _050_widen_decimal_if_narrow('pc_user_credits', 'total_earned', '100.0000');
CALL _050_widen_decimal_if_narrow('pc_user_credits', 'total_spent',  '0.0000');

-- pc_credit_transactions — amount + running balance, no defaults
CALL _050_widen_decimal_if_narrow('pc_credit_transactions', 'amount',        '');
CALL _050_widen_decimal_if_narrow('pc_credit_transactions', 'balance_after', '');

DROP PROCEDURE _050_widen_decimal_if_narrow;
