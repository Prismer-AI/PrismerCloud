# v1.8.0 MySQL Migration Guide

## Overview

v1.8.0 引入 6 个增量 migration 文件 (029-034)，需在测试/生产环境的 MySQL 上按顺序执行。

## 执行顺序（必须从小到大）

| 文件                           | 说明                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `029_v180_convergence.sql`     | Evolution-Memory Convergence：im_memory_files 新增 memoryType/description/stale 字段 + im_evolution_capsules 新增 reflection 字段 + 创建 im_knowledge_links 表 |
| `030_v180_leaderboard_v2.sql`  | Leaderboard V2：创建 im_value_metrics / im_anti_cheat_logs / im_token_baselines 表 + im_leaderboard_snapshots 扩展字段                                         |
| `031_v180_community.sql`       | Community Forum：创建 im_community_posts / comments / votes / bookmarks / follows / boards / profiles / drafts 等表                                            |
| `032_v2_community_tags.sql`    | Community V2 Pure Tag System：boardId 改为 nullable + 种子 tag 数据 + im_community_tags / im_community_post_tags 表                                            |
| `033_v180_contact_system.sql`  | Contact & Relationship System：创建 im_friend_requests / im_contact_relations / im_blocks 表                                                                   |
| `034_v180_workspace_scope.sql` | Workspace Scope 隔离：im_agent_skills 和 im_tasks 增加 scope 字段 + 更新唯一索引                                                                               |

## 执行方式

```bash
# 连接到目标 MySQL
mysql -h <host> -u <user> -p prismer_info

# 按顺序执行（不可跳过、不可乱序）
source 029_v180_convergence.sql;
source 030_v180_leaderboard_v2.sql;
source 031_v180_community.sql;
source 032_v2_community_tags.sql;
source 033_v180_contact_system.sql;
source 034_v180_workspace_scope.sql;
```

## 常见问题

**报 "Duplicate column" 错误：** 说明该 migration 已执行过（ALTER TABLE ADD COLUMN 重复执行会报此错误），跳过即可。

**报 "Table already exists" 错误：** 所有 CREATE TABLE 已使用 `IF NOT EXISTS`，不应出现此错误。如果出现，说明手动建过表，可安全忽略。

**报 "Duplicate key name" 错误：** INDEX 创建时该索引已存在，跳过该 migration 即可。

## 注意事项

- 029 和 034 包含 ALTER TABLE 操作，对大表可能需要几秒到几分钟（取决于表行数）
- 032 包含 INSERT IGNORE 种子数据，重复执行安全
- 建议在低峰期执行，特别是 029（修改 im_memory_files 和 im_evolution_capsules）
