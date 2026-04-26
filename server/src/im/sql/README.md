# IM Server MySQL 迁移指南

## 概述

本目录包含 IM Server 的 MySQL 表创建和验证脚本。

**安全保证**：
- ✅ 仅创建 `im_*` 前缀的表
- ✅ 使用 `CREATE TABLE IF NOT EXISTS`，可重复执行
- ✅ 不包含 DROP、TRUNCATE、DELETE 语句
- ✅ 不修改任何现有数据和表

## 文件说明

| 文件 | 说明 |
|------|------|
| `001_create_tables.sql` | 创建 6 张 IM 表 |
| `002_verify_tables.sql` | 验证表结构和索引 |
| `run-migration.sh` | 便捷执行脚本 |

## 表清单

| 表名 | 说明 |
|------|------|
| `im_users` | IM 用户 |
| `im_agent_cards` | Agent 能力声明 |
| `im_conversations` | 对话 |
| `im_participants` | 参与者 |
| `im_messages` | 消息 |
| `im_webhooks` | Webhook 配置 |

## 操作步骤

### 方式一：使用脚本 (推荐)

```bash
cd src/im/sql
chmod +x run-migration.sh

# 创建表
./run-migration.sh create \
  -h <mysql_host> \
  -u <mysql_user> \
  -p <mysql_password> \
  -d <database_name>

# 验证表
./run-migration.sh verify \
  -h <mysql_host> \
  -u <mysql_user> \
  -p <mysql_password> \
  -d <database_name>

# 创建 + 验证
./run-migration.sh all \
  -h <mysql_host> \
  -u <mysql_user> \
  -p <mysql_password> \
  -d <database_name>
```

### 方式二：使用环境变量

```bash
export MYSQL_HOST=your-mysql-host
export MYSQL_PORT=3306
export MYSQL_USER=your-user
export MYSQL_PASSWORD=your-password
export MYSQL_DATABASE=prismer_cloud

./run-migration.sh all
```

### 方式三：直接执行 SQL

```bash
# 创建表
mysql -h <host> -u <user> -p <database> < 001_create_tables.sql

# 验证表
mysql -h <host> -u <user> -p <database> < 002_verify_tables.sql
```

### 方式四：在 MySQL 客户端中执行

```sql
-- 连接数据库
mysql -h <host> -u <user> -p <database>

-- 执行创建脚本
source /path/to/src/im/sql/001_create_tables.sql;

-- 执行验证脚本
source /path/to/src/im/sql/002_verify_tables.sql;
```

## 测试环境示例

假设测试环境配置：
- Host: `test-db.prismer.dev`
- Port: `3306`
- User: `prismer_test`
- Password: `test_password`
- Database: `prismer_cloud_test`

```bash
# 方式一
./run-migration.sh all \
  -h test-db.prismer.dev \
  -u prismer_test \
  -p test_password \
  -d prismer_cloud_test

# 方式二
mysql -h test-db.prismer.dev -u prismer_test -p prismer_cloud_test < 001_create_tables.sql
# 输入密码后执行
```

## 验证输出示例

执行 `002_verify_tables.sql` 后应看到类似输出：

```
========== IM Server 表验证开始 ==========
--- 1. 检查表是否存在 ---
+------------------+----------+
| 表名             | 状态      |
+------------------+----------+
| im_agent_cards   | ✅ 存在   |
| im_conversations | ✅ 存在   |
| im_messages      | ✅ 存在   |
| im_participants  | ✅ 存在   |
| im_users         | ✅ 存在   |
| im_webhooks      | ✅ 存在   |
+------------------+----------+

--- 2. 统计各表记录数 ---
+------------------+--------+
| 表名             | 记录数  |
+------------------+--------+
| im_users         |      0 |
| im_agent_cards   |      0 |
| im_conversations |      0 |
| im_participants  |      0 |
| im_messages      |      0 |
| im_webhooks      |      0 |
+------------------+--------+
...
========== IM Server 表验证完成 ==========
```

## 回滚说明

如需删除 IM 表（**谨慎操作**），可手动执行：

```sql
-- ⚠️ 警告：此操作会删除所有 IM 数据！
-- 仅在测试环境使用

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS im_webhooks;
DROP TABLE IF EXISTS im_messages;
DROP TABLE IF EXISTS im_participants;
DROP TABLE IF EXISTS im_conversations;
DROP TABLE IF EXISTS im_agent_cards;
DROP TABLE IF EXISTS im_users;
SET FOREIGN_KEY_CHECKS = 1;
```

## Prisma 同步 (可选)

如果使用 Prisma 管理 schema，可以切换 provider 后同步：

```bash
# 1. 修改 prisma/schema.prisma
# provider = "mysql"
# url = env("DATABASE_URL")

# 2. 设置 DATABASE_URL
export DATABASE_URL="mysql://user:pass@host:3306/database"

# 3. 同步
npx prisma db push
```

## 常见问题

### Q: 表已存在怎么办？
A: 脚本使用 `CREATE TABLE IF NOT EXISTS`，已存在的表会被跳过，不会报错。

### Q: 可以多次执行吗？
A: 可以，脚本设计为幂等操作。

### Q: 会影响其他表吗？
A: 不会，脚本只操作 `im_*` 前缀的表。

### Q: 如何检查执行是否成功？
A: 执行 `002_verify_tables.sql` 验证脚本，检查所有表是否存在。
