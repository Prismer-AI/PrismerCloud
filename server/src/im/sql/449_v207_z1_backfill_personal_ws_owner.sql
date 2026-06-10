-- ============================================================================
-- Migration 449: v2.0.7 Bug Z1 — re-backfill workspace owner rows after Z1 leak
-- Date: 2026-05-29
-- Spec: R3.E.cloud cookbook real-run / Bug Z1
--
-- Why this migration exists
-- -------------------------
-- M444 (2026-05-27) 把 workspace owner backfill 进 im_workspace_members 一次，
-- 但只覆盖 M444 跑那一刻存在的 workspace。
--
-- 此后 24 小时内：
--   - `src/im/api/workspaces.ts:190` (B2 hotfix, v2.0.7.1) 修了 POST
--     /workspaces 显式路径 — 显式建 workspace 原子写 member 行。
--   - 但 `src/im/auth/middleware.ts:60-83` (Bug Z1) 的 auto-create Personal
--     workspace 路径**没改** — OAuth / native register / API-key 首次访问
--     时 ensureDefaultWorkspace() 仅 prisma.iMWorkspace.create()，缺
--     im_workspace_members owner 行。
--
-- 实测证据（local dev MySQL 2026-05-29 09:xx）：
--   SELECT COUNT(*) total, SUM(CASE WHEN m.id IS NULL THEN 1 ELSE 0 END) missing
--   FROM im_workspaces w
--   LEFT JOIN im_workspace_members m
--     ON m.workspaceId=w.id AND m.memberImUserId=w.ownerImUserId AND m.role='owner'
--   WHERE w.deletedAt IS NULL;
--   → total=2451, missing=2316
--
-- 具体受害 workspace：cmppo9byv0046xzxg9i812net (Personal,
-- ownerImUserId=cmp1uhqwz0000xzwt6usm7m2e, createdAt=2026-05-28 15:52:49) —
-- owner GET /members 返 []，POST /tasks 返 403 NOT_WORKSPACE_MEMBER。
--
-- 修复方案（两段）：
--   1. middleware.ts ensureDefaultWorkspace 改 $transaction 同事务写
--      member 行 (Z1 code fix，跟 B2 同 pattern)。
--   2. 本 migration 把过去 24h auto-create 漏的 owner 行补齐。
--
-- 幂等
-- ----
-- INSERT IGNORE + UNIQUE(workspaceId, memberImUserId) 防重，重跑安全；
-- 已有的 owner 行（包括 M444 已写的）不会重复写入。
--
-- 与 M444 的差异
-- --------------
-- M444 只看 ownerImUserId NOT NULL（不限 deletedAt 内做 anti-join），本
-- migration 用同样语义；差异仅在跑的时间点。M444 是 baseline backfill，
-- 本 migration 是 Z1 修复后的"再 backfill"，作用域同表同 join 条件。
-- 重跑 M444 也可以达到相同效果，但分别留独立 migration 让 audit trail 清晰。
-- ============================================================================

INSERT IGNORE INTO im_workspace_members (id, workspaceId, memberImUserId, role, joinedAt)
SELECT
  CONCAT('wsm_', SUBSTRING(SHA2(CONCAT(w.id, w.ownerImUserId), 256), 1, 24)),
  w.id,
  w.ownerImUserId,
  'owner',
  w.createdAt
FROM im_workspaces w
WHERE w.deletedAt IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM im_workspace_members m
    WHERE m.workspaceId = w.id AND m.memberImUserId = w.ownerImUserId
  );

-- Tracking handled by scripts/db-migrate.sh; no manual schema_migrations INSERT.
--
-- 验证 SQL（运维手动跑）：
--   SELECT COUNT(*) AS missing FROM im_workspaces w
--   LEFT JOIN im_workspace_members m
--     ON m.workspaceId=w.id AND m.memberImUserId=w.ownerImUserId AND m.role='owner'
--   WHERE w.deletedAt IS NULL AND m.id IS NULL;
--   → 期望 0
