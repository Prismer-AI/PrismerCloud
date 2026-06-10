-- ============================================================================
-- Migration 444: v2.0.8 Phase 8 — Workspace owner backfill into im_workspace_members
-- Date: 2026-05-27
-- Spec: docs/release201/16-human-collaboration-onboarding.md §3.2.1 + §0.2.1 Phase 1
--
-- Why this migration exists
-- -------------------------
-- v1.9.1 创建 `im_workspace_members` 表 (migration 100) 时标注 "schema only,
-- collab UX in 1.10+"，但**从未有任何 endpoint 往里写**。同时 `task-permission.ts`
-- (release200 §3 + §5) 的 ACL 路径在 line 395 已经在读这张表 —
--
--     prisma.iMWorkspaceMember.findFirst({
--       where: { workspaceId, memberImUserId: actorId }
--     })
--
-- 结果：owner 之外的任何人**永远是 non-member**（L3 / L5 路径都返回 null）。
-- L0 owner 通过 `IMWorkspace.ownerImUserId` 字段判定不受影响，但 owner 本身
-- 也没在 members 表 — 即"workspace 永远是单人"，是 1.9.x 设计的 latent bug，
-- 不是 feature。
--
-- 本 migration backfill：把每个 active workspace 的 owner 写入 members 表
-- 作 role='owner' 行。配合 Phase 8 即将上线的 4 个 members CRUD endpoint，
-- task-permission.ts 的 L3 ACL 路径才能真正生效（多人协作前提）。
--
-- 表已有约束 (migration 100)：
--   UNIQUE KEY uk_ws_member (workspaceId, memberImUserId)   ← 防重
--   ON DELETE CASCADE on im_workspaces                       ← workspace 删时自动清理
-- 本 migration 不动 schema，仅 backfill 数据。
--
-- 与 Project ACL 策略的关系
-- -------------------------
-- 09 doc §5.2 决议：project owner 走"service 层短路"（不入 members 表）。
-- 本 migration 让 workspace owner **入 members 表**，是有意为之的不对称：
--   - workspace owner 入表：因为 task-permission.ts 已经依赖 members 表读取
--   - project owner 不入表：因为 ProjectService 直接查 ownerImUserId 字段
-- 详见 16 doc §5.1 决策表。
--
-- 幂等性
-- ------
-- INSERT IGNORE + UNIQUE 防重 → 重跑安全；已 backfill 的行不会重写。
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

-- Sanity check: 每个 active workspace 必须有 owner 行。
-- 不抛错（migration runner 不支持 stored procedure 校验），但留下 SELECT 给手动核对：
--
--   SELECT w.id, w.ownerImUserId, COUNT(m.id) as owner_rows
--   FROM im_workspaces w
--   LEFT JOIN im_workspace_members m
--     ON m.workspaceId = w.id AND m.memberImUserId = w.ownerImUserId AND m.role = 'owner'
--   WHERE w.deletedAt IS NULL
--   GROUP BY w.id
--   HAVING owner_rows != 1;
--
-- 期望返回 0 行。若不为 0 行说明 backfill 漏，需排查 ownerImUserId 是否合法 FK。
