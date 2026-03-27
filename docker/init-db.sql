-- ============================================================================
-- PrismerCloud Database Initialization
-- Executed automatically on first `docker compose up`
-- ============================================================================

USE prismer_cloud;

-- pc_* tables are loaded via /docker-entrypoint-initdb.d/pc/*.sql
-- im_* tables are loaded via /docker-entrypoint-initdb.d/im/*.sql
-- MySQL processes files in /docker-entrypoint-initdb.d/ alphabetically

SELECT 'PrismerCloud database initialization complete' AS status;
