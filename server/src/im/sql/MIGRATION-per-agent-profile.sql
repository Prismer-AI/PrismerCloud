-- =============================================================================
-- MIGRATION: per-agent Hermes profile isolation (one-shot dev-env fixup)
-- =============================================================================
-- NOT a numbered/versioned schema migration. This is a data fixup script that
-- backfills existing rows so each agent gets its own Hermes profileDir / port /
-- SOUL.md / MCP env. After this runs, the daemon's Hermes adapter can read
-- AgentProfile.config.{hermesProfileName,port,systemPrompt} per-agent and the
-- API-key path (`cloudUserId='2'` → `ensureIMUser`) can resolve every agent.
--
-- Idempotent: safe to re-run. JSON_SET overwrites existing keys with the same
-- computed values; the agent userId update is a no-op if already '2'.
--
-- Run against the dev DB only:
--   docker exec -e MYSQL_PWD=devpass prismer-dev-mysql \
--     mysql -uprismer prismer_cloud < src/im/sql/MIGRATION-per-agent-profile.sql
-- =============================================================================

START TRANSACTION;

-- -----------------------------------------------------------------------------
-- (1) Update im_agent_profiles.config for hermes adapter rows.
--     Sets hermesProfileName = agent username, port = 8642 + CRC32(username)%1000.
--     systemPrompt is filled in step (3); other fields (apiKey, model, etc.)
--     are left untouched.
-- -----------------------------------------------------------------------------
UPDATE im_agent_profiles ap
JOIN   im_users u ON u.id = ap.agentImUserId
SET    ap.config = JSON_SET(
         CASE
           WHEN ap.config IS NULL OR ap.config = '' THEN '{}'
           ELSE ap.config
         END,
         '$.hermesProfileName', u.username,
         '$.port', CAST(8642 + (CRC32(u.username) MOD 1000) AS UNSIGNED)
       ),
       ap.version = ap.version + 1,
       ap.updatedAt = CURRENT_TIMESTAMP(3)
WHERE  ap.adapterName = 'hermes'
  AND  ap.deletedAt IS NULL;

-- -----------------------------------------------------------------------------
-- (2) Update agents (role='agent', not banned) whose userId is NULL or wrong.
--     Force userId='2' so ensureIMUser(cloudUserId='2', agentHint=username)
--     finds them via the API-key path.
-- -----------------------------------------------------------------------------
UPDATE im_users
SET    userId = '2',
       updatedAt = CURRENT_TIMESTAMP(3)
WHERE  role = 'agent'
  AND  banned = 0
  AND  (userId IS NULL OR userId <> '2');

-- -----------------------------------------------------------------------------
-- (3) Fill NULL/missing systemPrompt with a fallback derived from displayName.
-- -----------------------------------------------------------------------------
UPDATE im_agent_profiles ap
JOIN   im_users u ON u.id = ap.agentImUserId
SET    ap.config = JSON_SET(
         CASE
           WHEN ap.config IS NULL OR ap.config = '' THEN '{}'
           ELSE ap.config
         END,
         '$.systemPrompt',
         CONCAT(
           'You are an agent named ', u.displayName,
           ' in this Prismer workspace. Be helpful, concise, and use the ',
           'prismer-im-collab skill plus prismer-tasks MCP tools to collaborate.'
         )
       ),
       ap.version = ap.version + 1,
       ap.updatedAt = CURRENT_TIMESTAMP(3)
WHERE  ap.deletedAt IS NULL
  AND  (
         JSON_EXTRACT(ap.config, '$.systemPrompt') IS NULL
         OR JSON_UNQUOTE(JSON_EXTRACT(ap.config, '$.systemPrompt')) = ''
         OR JSON_UNQUOTE(JSON_EXTRACT(ap.config, '$.systemPrompt')) = 'null'
       );

COMMIT;

-- -----------------------------------------------------------------------------
-- (4) Verification queries — print final state.
-- -----------------------------------------------------------------------------
SELECT  '--- im_agent_profiles after migration ---' AS info;
SELECT  ap.agentImUserId,
        u.username                                                   AS agent_username,
        JSON_UNQUOTE(JSON_EXTRACT(ap.config, '$.hermesProfileName')) AS hp,
        JSON_EXTRACT(ap.config, '$.port')                            AS port,
        (JSON_EXTRACT(ap.config, '$.systemPrompt') IS NOT NULL)      AS has_sp
FROM    im_agent_profiles ap
LEFT JOIN im_users u ON u.id = ap.agentImUserId
WHERE   ap.deletedAt IS NULL
ORDER BY ap.updatedAt DESC;

SELECT  '--- im_users (agent role, not banned) after migration ---' AS info;
SELECT  id, username, userId
FROM    im_users
WHERE   role = 'agent'
  AND   banned = 0
ORDER BY username;
