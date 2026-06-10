-- ============================================================================
-- Migration 415: v2.0 — IMSkill executableJson
-- Date: 2026-05-21
-- Spec: docs/release200/13-agent-spec-and-lifecycle.md §6.4
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_skill_executable_json;
DELIMITER //
CREATE PROCEDURE pc_v200_skill_executable_json()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_skills' AND column_name = 'executableJson'
  ) THEN
    ALTER TABLE im_skills ADD COLUMN executableJson JSON NULL AFTER metadata;
  END IF;
END//
DELIMITER ;
CALL pc_v200_skill_executable_json();
DROP PROCEDURE pc_v200_skill_executable_json;

SELECT 'migration 415 v200 skill executableJson complete' AS status;
