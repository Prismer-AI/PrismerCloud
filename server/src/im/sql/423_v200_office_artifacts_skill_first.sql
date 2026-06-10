-- ============================================================================
-- Migration 423: v2.0 — office artifacts skill-first repair
-- Date: 2026-05-22
--
-- Fixes two live prompt defects:
--   1. Skill-first text referenced non-existent MCP tool `prismer.skill.list`.
--      The shipped tool is `prismer.skill.installed`.
--   2. Office deliverables were described generically, so agents could finish
--      with prose instead of task-linked DOCX/PPTX/XLSX/PDF artifacts.
--
-- This is intentionally a text repair over existing JSON/TEXT blobs; the
-- values remain valid JSON because only string contents are replaced.
-- ============================================================================

UPDATE im_role_templates
SET operatingPrinciples = REPLACE(
  REPLACE(
    REPLACE(
      operatingPrinciples,
      'prismer.skill.list',
      'prismer.skill.installed'
    ),
    'File-output tasks (PDF / Excel / Image / video) MUST use real libraries — do NOT just rename an extension',
    'Office/file-output tasks (DOCX / PPTX / XLSX / PDF / CSV / Image / video) MUST use office-artifacts when applicable and real generation libraries — do NOT just rename an extension'
  ),
  '输出文件类任务(PDF / Excel / Image / video)必须用真正的库生成',
  'Office/输出文件类任务(DOCX / PPTX / XLSX / PDF / CSV / Image / video)必须在适用时使用 office-artifacts skill,并用真正的库生成'
)
WHERE operatingPrinciples LIKE '%prismer.skill.list%'
   OR operatingPrinciples LIKE '%File-output tasks (PDF / Excel / Image / video)%'
   OR operatingPrinciples LIKE '%输出文件类任务(PDF / Excel / Image / video)%';

UPDATE im_agent_profiles
SET
  config = REPLACE(
    REPLACE(
      config,
      'prismer.skill.list',
      'prismer.skill.installed'
    ),
    'File-output tasks (PDF / Excel / Image / video) MUST use real libraries — do NOT just rename an extension',
    'Office/file-output tasks (DOCX / PPTX / XLSX / PDF / CSV / Image / video) MUST use office-artifacts when applicable and real generation libraries — do NOT just rename an extension'
  ),
  version = version + 1,
  updatedAt = CURRENT_TIMESTAMP(3)
WHERE deletedAt IS NULL
  AND (
    config LIKE '%prismer.skill.list%'
    OR config LIKE '%File-output tasks (PDF / Excel / Image / video)%'
  );

SELECT
  'migration 423 office-artifacts skill-first repair complete' AS status,
  (SELECT COUNT(*) FROM im_role_templates WHERE operatingPrinciples LIKE '%office-artifacts%') AS role_templates_with_office_skill,
  (SELECT COUNT(*) FROM im_agent_profiles WHERE config LIKE '%office-artifacts%' AND deletedAt IS NULL) AS agent_profiles_with_office_skill;
