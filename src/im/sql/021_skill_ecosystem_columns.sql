-- ============================================================================
-- Migration 021: Add Skill Ecosystem columns to im_skills
-- Syncs MySQL schema with SQLite schema (v1.7.2 enhancements)
-- These columns are required by skill.service.ts search/browse functionality.
-- ============================================================================

ALTER TABLE im_skills ADD COLUMN packageUrl    VARCHAR(512) NULL;
ALTER TABLE im_skills ADD COLUMN packageHash   VARCHAR(64)  NULL;
ALTER TABLE im_skills ADD COLUMN packageSize   INT          NULL;
ALTER TABLE im_skills ADD COLUMN fileCount     INT          NOT NULL DEFAULT 1;
ALTER TABLE im_skills ADD COLUMN compatibility TEXT         NOT NULL;
ALTER TABLE im_skills ADD COLUMN signals       TEXT         NOT NULL;
ALTER TABLE im_skills ADD COLUMN `requires`    TEXT         NOT NULL;
ALTER TABLE im_skills ADD COLUMN version       VARCHAR(20)  NOT NULL DEFAULT '1.0.0';
ALTER TABLE im_skills ADD COLUMN ownerAgentId  VARCHAR(30)  NULL;
ALTER TABLE im_skills ADD COLUMN forkedFrom    VARCHAR(30)  NULL;
ALTER TABLE im_skills ADD COLUMN forkCount     INT          NOT NULL DEFAULT 0;
ALTER TABLE im_skills ADD COLUMN license       VARCHAR(30)  NOT NULL DEFAULT 'MIT';
ALTER TABLE im_skills ADD COLUMN securityStatus VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE im_skills ADD COLUMN changelog     TEXT         NOT NULL;

-- Set defaults for TEXT columns (MySQL doesn't allow DEFAULT on TEXT in strict mode)
UPDATE im_skills SET compatibility = '[]' WHERE compatibility IS NULL OR compatibility = '';
UPDATE im_skills SET signals = '[]' WHERE signals IS NULL OR signals = '';
UPDATE im_skills SET `requires` = '{}' WHERE `requires` IS NULL OR `requires` = '';
UPDATE im_skills SET changelog = '' WHERE changelog IS NULL;

-- Index for ownerAgentId lookups
CREATE INDEX idx_skills_owner ON im_skills (ownerAgentId);

SELECT 'migration 021 complete' AS status;
