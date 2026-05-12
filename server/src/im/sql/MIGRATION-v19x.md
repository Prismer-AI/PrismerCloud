# v1.9.x MySQL Migration Guide

## Overview

v1.9.0–v1.9.7 引入的增量 migration 文件 (100–132 + 300–309)。100-block 已编号
切到三位数（与 029-038 区分），按从小到大 (100 → 132 → 300+) 顺序执行。

## 执行顺序

| 文件                                              | 引入版本      | 说明                                                                                            |
| ------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `100_v191_workspaces.sql`                         | v1.9.1        | Workspace 表族（5 张表：im_workspaces, im_workspace_members, im_assets, im_pages 等）           |
| `101_v191_drop_conversation_workspace_unique.sql` | v1.9.1 m1     | 移除 1.8.2 误加的 `IMConversation.workspaceId @unique`（1 ws → N conversations）                |
| `110_v192_workspace_id_phase1.sql`                | v1.9.2 m2     | 24 张表 ADD COLUMN workspaceId NULLable + 多源 backfill                                         |
| `120_v193_workspace_id_phase2.sql`                | v1.9.3 m3     | 11 张表 workspaceId → NOT NULL + DROP scope (12 张) + DROP im_evolution_acl.resourceId          |
| `121_v193_pairing_offers_create.sql`              | v1.9.3 m3     | im_pairing_offers (QR 配对 5min TTL)                                                            |
| **`122_v193_workspace_id_orphan_cleanup.sql`** ⭐ | v1.9.3 hotfix | **120 的 follow-up**：补充 backfill 残余孤儿 + ws_orphan_fallback 兜底 + 二次尝试 NOT NULL flip |
| `130_v194_native_auth.sql`                        | v1.9.4        | im_users 加 email/phone/googleId/githubId/twitterId/numericId (BIGINT auto-inc)                 |
| `131_v195_asset_deleted_at.sql`                   | v1.9.5        | im_assets 软删除字段                                                                            |
| `132_v196_apple_native_auth.sql`                  | v1.9.6        | im_users.appleId (Sign in with Apple)                                                           |
| `300_v110_sandbox.sql` 起                         | v1.10+        | Sandbox 表族（IMContainer / Snapshot / RunLog）                                                 |
| `305_v197_workspace_asset_ingest.sql`             | v1.9.7        | Workspace asset ingest 字段                                                                     |
| `306_v54_memory_phase_b.sql`                      | v5.4 alpha    | Memory Phase B 表更新                                                                           |
| `307_v54_memory_file_workspace_key.sql`           | v5.4 closeout | im_memory_files workspace/path namespace + bridge metadata                                      |
| `309_v197_schema_convergence_fix.sql`             | v1.9.7 hotfix | 修复已迁移 DB 的 memory/task run/event 形态漂移                                                 |

## 关于 122 (Workspace orphan cleanup) 的特别说明

### 为什么需要 122

migration 120 (`_120_set_workspace_not_null` 过程) **只在零 NULL 行时才 ALTER 列为
NOT NULL**。如果 110 阶段的多源 backfill 因为某种原因有遗漏（例如：

1. agent 的 owner IMUser 的 `userId` 字段为 NULL（即没有绑定到 cloud 用户），
2. cloud user 没有对应的 `role='human'` IMUser 行，
3. human 还没有 `isDefault=TRUE` workspace（如新部署的 cloud 还没跑过
   `scripts/backfill-workspaces.ts` 也没收到任何 register 触发 lazy 创建），
4. 行的所有者列指向已删除/不存在的用户，

这些行的 `workspaceId` 会停留在 NULL，120 会安静地 **跳过** NOT NULL flip — 留下
schema 不一致：Prisma 期望 NOT NULL，MySQL 实际仍是 NULL。

### 122 做了什么

1. **创建系统兜底 workspace**：`ws_orphan_fallback`，由系统 IMUser
   `im_user_orphan_ops` 拥有（INSERT IGNORE，幂等）
2. **重跑 owner-column backfill**（与 110 同样的 join 链，仅作用于剩余 NULL 行）
3. **路由不可解析的孤儿到 fallback workspace**（保证零 NULL）
4. **再次 ALTER 列为 NOT NULL**（11 张表）

### 部署后审计 query

```sql
SELECT 'im_agent_cards' AS t, COUNT(*) AS orphans FROM im_agent_cards
 WHERE workspaceId = 'ws_orphan_fallback'
UNION ALL SELECT 'im_tasks',         COUNT(*) FROM im_tasks         WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_genes',         COUNT(*) FROM im_genes         WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_gene_signals',  COUNT(*) FROM im_gene_signals  WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_memory_files',  COUNT(*) FROM im_memory_files  WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_evolution_capsules',     COUNT(*) FROM im_evolution_capsules     WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_agent_skills',           COUNT(*) FROM im_agent_skills           WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_unmatched_signals',      COUNT(*) FROM im_unmatched_signals      WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_evolution_achievements', COUNT(*) FROM im_evolution_achievements WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_community_drafts',       COUNT(*) FROM im_community_drafts       WHERE workspaceId='ws_orphan_fallback'
UNION ALL SELECT 'im_community_bookmarks',    COUNT(*) FROM im_community_bookmarks    WHERE workspaceId='ws_orphan_fallback'
;
```

非零行需人工核对（多半是测试 fixture 残留 / pre-1.9.3 老数据）。处理方式：

- 测试 fixture：DELETE 掉
- 真实业务行：UPDATE workspaceId 到合适的真实 workspace（基于 owner 推断）

## 标准部署步骤（test/prod）

```bash
# 1. (推荐) 先跑应用层 backfill — 保证每个 human 都有 default workspace
DATABASE_URL="mysql://..." npx tsx scripts/backfill-workspaces.ts --dry-run
DATABASE_URL="mysql://..." npx tsx scripts/backfill-workspaces.ts

# 2. 按顺序跑 SQL migration
mysql -h <host> -u <user> -p prismer_info <<SQL
source 100_v191_workspaces.sql;
source 101_v191_drop_conversation_workspace_unique.sql;
source 110_v192_workspace_id_phase1.sql;
source 120_v193_workspace_id_phase2.sql;
source 121_v193_pairing_offers_create.sql;
source 122_v193_workspace_id_orphan_cleanup.sql;  -- 此次新增
source 130_v194_native_auth.sql;
source 131_v195_asset_deleted_at.sql;
source 132_v196_apple_native_auth.sql;
source 300_v110_sandbox.sql;
source 301_v110_task_container_link.sql;
source 302_v110_snapshot_manifest.sql;
source 303_v110_snapshot_manifest_mediumtext.sql;
source 304_v110_runtime_kind.sql;
source 305_v197_workspace_asset_ingest.sql;
source 306_v54_memory_phase_b.sql;
source 307_v54_memory_file_workspace_key.sql;
source 309_v197_schema_convergence_fix.sql;
SQL

# 3. 跑审计 query 看 ws_orphan_fallback 兜底命中数
# (零 = 110 全部 backfill 成功；非零 = 留待人工处理)

# 4. (可选) regenerate Prisma MySQL client
npx prisma generate --schema prisma/schema.mysql.prisma
```

## 常见问题

**报 "Duplicate column" / "Duplicate key name"**：所有 ALTER 都用
INFORMATION_SCHEMA 守卫，不应出现。如果看到，说明该 migration 已部分应用，跳过即可。

**122 跑完仍有 NULL 行**：检查 join 链 — 可能是 owner IMUser 已被删除或
`role` 字段不是 `'human'`。fallback workspace `ws_orphan_fallback` 兜底应该能让
所有行有值；如仍 NULL，说明该表的 `workspaceId` 列不存在（110 也跳过了 — 需先跑 110）。

**附录：Phase B 收口经验**：dev push 时撞上 4 个 `comp_ax_*` / `comp_ay_*`
companion 测试 fixture 行 `workspaceId IS NULL`，根因是它们由
`comprehensive.test.ts` 直接 register 创建（无 cloud user 绑定），110 的
`_backfill_via_imuser` join 链失败。122 通过 fallback workspace 兜住了它们。
