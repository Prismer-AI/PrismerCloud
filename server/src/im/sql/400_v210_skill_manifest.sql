-- ============================================================================
-- Migration 400: v2.1 — Skill Multi-file Manifest Upgrade (§A.7 Phase 1)
-- Date: 2026-05-20
-- Spec: docs/release200/05-skill-system-design.md §A.7
--
-- Background
-- ----------
-- v2.0 IMSkill stores SKILL.md as a single `content` MediumText column. v2.1
-- introduces the agentskills.io-compliant multi-file manifest: an IMSkill row
-- carries an ordered files[] (SKILL.md + scripts/* + references/* + assets/*),
-- each file with `sha256` + `size` + either inline `content` (base64) or
-- presigned-S3 `url`. The wire protocol packs files[] + merkle root.
--
-- v2.1 D24 decision (§A.5.7): single-column MediumText `contentManifest` (Hybrid).
-- ≤100 KB files inline base64; > threshold goes to S3 (packageUrl path).
--
-- Schema deltas
-- -------------
--   • contentManifest          MEDIUMTEXT NULL — JSON [{path,sha256,size,
--                                                       content?,url?,inline}]
--   • contentManifestRevision  VARCHAR(64) NULL — merkle root over files[]
--   • publishedAt              DATETIME(3) NULL — marketplace publish stamp
--
-- Backfill
-- --------
-- All rows where `content != ''` and `contentManifest IS NULL` are wrapped into
-- a single-file manifest `[{path:"SKILL.md", size, sha256, content(base64),
-- inline:true}]`. The merkle root is computed as
-- `SHA2(CONCAT("SKILL.md:", SHA2(content,256)), 256)` — same input shape the
-- application layer uses (sorted path:hash lines joined with newline).
-- Empty-content rows (the ClawHub catalog majority; §A.7.9) stay NULL and will
-- be populated by the dedicated re-sync scripts in Phase 1 deliverable 10.
--
-- Idempotent
-- ----------
-- • Column add uses a stored procedure that checks information_schema before
--   ALTER, so re-runs are safe.
-- • Backfill predicate `contentManifest IS NULL` skips already-migrated rows.
-- ============================================================================

-- ─── Step A: add contentManifest, contentManifestRevision, publishedAt ───
DROP PROCEDURE IF EXISTS pc_v210_add_skill_manifest_columns;
DELIMITER //
CREATE PROCEDURE pc_v210_add_skill_manifest_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_skills' AND column_name = 'contentManifest'
  ) THEN
    ALTER TABLE im_skills ADD COLUMN contentManifest MEDIUMTEXT NULL AFTER content;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_skills' AND column_name = 'contentManifestRevision'
  ) THEN
    ALTER TABLE im_skills ADD COLUMN contentManifestRevision VARCHAR(64) NULL AFTER contentManifest;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_skills' AND column_name = 'publishedAt'
  ) THEN
    ALTER TABLE im_skills ADD COLUMN publishedAt DATETIME(3) NULL AFTER updatedAt;
  END IF;
END//
DELIMITER ;
CALL pc_v210_add_skill_manifest_columns();
DROP PROCEDURE pc_v210_add_skill_manifest_columns;

-- ─── Step B: idempotent index on contentManifestRevision ────────────────
DROP PROCEDURE IF EXISTS pc_v210_add_skill_manifest_index;
DELIMITER //
CREATE PROCEDURE pc_v210_add_skill_manifest_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_skills'
      AND index_name = 'idx_im_skills_contentManifestRevision'
  ) THEN
    CREATE INDEX idx_im_skills_contentManifestRevision
      ON im_skills (contentManifestRevision);
  END IF;
END//
DELIMITER ;
CALL pc_v210_add_skill_manifest_index();
DROP PROCEDURE pc_v210_add_skill_manifest_index;

-- ─── Step C: backfill manifest for rows with existing content ───────────
-- Wrap single-file `content` into a one-entry manifest. Merkle root mirrors
-- the application layer's `sha256(joined("path:file_sha256" lines))` shape
-- for a single SKILL.md entry: `SHA2(CONCAT('SKILL.md:', SHA2(content,256)),256)`.
UPDATE im_skills
SET
  contentManifest = JSON_ARRAY(
    JSON_OBJECT(
      'path',    'SKILL.md',
      'size',    OCTET_LENGTH(content),
      'sha256',  SHA2(content, 256),
      'content', TO_BASE64(content),
      'inline',  CAST(TRUE AS JSON)
    )
  ),
  contentManifestRevision = SHA2(CONCAT('SKILL.md:', SHA2(content, 256)), 256)
WHERE content IS NOT NULL
  AND content <> ''
  AND contentManifest IS NULL;

-- ─── Step D: report ──────────────────────────────────────────────────────
SELECT
  'migration 400 v210 skill manifest complete' AS status,
  (SELECT COUNT(*) FROM im_skills WHERE contentManifest IS NOT NULL) AS rows_with_manifest,
  (SELECT COUNT(*) FROM im_skills WHERE content IS NOT NULL AND content <> '' AND contentManifest IS NULL) AS rows_with_content_but_no_manifest,
  (SELECT COUNT(*) FROM im_skills) AS total_skills;
