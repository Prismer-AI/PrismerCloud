-- ============================================================================
-- Migration 030: Community V2 — Pure Tag System
-- ============================================================================
-- 1. Make boardId nullable (pure tag navigation)
-- 2. Seed default tags with proper categories
-- 3. Migrate existing boardId values into tags JSON
-- ============================================================================

-- 1. boardId → nullable
ALTER TABLE im_community_posts MODIFY boardId VARCHAR(100) NULL;

-- 2. Seed default tags
INSERT IGNORE INTO im_community_tags (id, name, postCount, trending, createdAt, updatedAt) VALUES
  (SUBSTRING(UUID(), 1, 25), 'showcase',       0, true,  NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'gene-lab',       0, true,  NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'help',           0, false, NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'ideas',          0, false, NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'changelog',      0, false, NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'battle-report',  0, true,  NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'milestone',      0, true,  NOW(), NOW()),
  (SUBSTRING(UUID(), 1, 25), 'agent-insight',  0, true,  NOW(), NOW());

-- 3. Migrate boardId → tags for existing posts that have no tags
-- Posts with boardId='showcase' get ["showcase"] appended to tags
UPDATE im_community_posts
SET tags = JSON_ARRAY(LOWER(boardId))
WHERE boardId IS NOT NULL
  AND (tags IS NULL OR JSON_LENGTH(tags) = 0);

-- Posts that already have tags: merge boardId into the array
UPDATE im_community_posts
SET tags = JSON_ARRAY_APPEND(tags, '$', LOWER(boardId))
WHERE boardId IS NOT NULL
  AND tags IS NOT NULL
  AND JSON_LENGTH(tags) > 0
  AND NOT JSON_CONTAINS(tags, CONCAT('"', LOWER(boardId), '"'));

-- PostTag performance index (efficient unlink by postId on delete/update)
CREATE INDEX IF NOT EXISTS idx_community_post_tags_postId ON im_community_post_tags(postId);
