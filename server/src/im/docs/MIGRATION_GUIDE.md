# Prismer IM Server - 测试环境 MySQL 迁移指南

## 概述

本指南描述如何将 IM Server 的数据库从本地 SQLite 迁移到测试环境的 MySQL。

## 前置条件

- 已有可访问的 MySQL 服务器
- 具有创建表的数据库权限
- MySQL 客户端工具已安装

## 迁移步骤

### 第一步：获取迁移脚本

迁移脚本位于: `src/im/sql/`

| 文件 | 说明 |
|------|------|
| `001_create_tables.sql` | 创建 6 张 IM 表 |
| `002_verify_tables.sql` | 验证表结构和索引 |
| `run-migration.sh` | 便捷执行脚本 |

### 第二步：连接信息准备

准备以下信息：

```bash
MYSQL_HOST=<your-mysql-host>      # 例如: test-db.prismer.dev
MYSQL_PORT=3306                   # 默认端口
MYSQL_USER=<your-username>        # 例如: prismer_test
MYSQL_PASSWORD=<your-password>    # 数据库密码
MYSQL_DATABASE=<database-name>    # 例如: prismer_cloud_test
```

### 第三步：执行迁移

**方式一：使用便捷脚本 (推荐)**

```bash
cd src/im/sql

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

# 或者一次执行创建+验证
./run-migration.sh all \
  -h <mysql_host> \
  -u <mysql_user> \
  -p <mysql_password> \
  -d <database_name>
```

**方式二：使用环境变量**

```bash
export MYSQL_HOST=test-db.prismer.dev
export MYSQL_PORT=3306
export MYSQL_USER=prismer_test
export MYSQL_PASSWORD=your_password
export MYSQL_DATABASE=prismer_cloud_test

cd src/im/sql
./run-migration.sh all
```

**方式三：直接执行 SQL 文件**

```bash
# 创建表
mysql -h <host> -u <user> -p <database> < src/im/sql/001_create_tables.sql

# 验证表
mysql -h <host> -u <user> -p <database> < src/im/sql/002_verify_tables.sql
```

**方式四：在 MySQL 客户端中执行**

```sql
-- 1. 连接数据库
mysql -h <host> -u <user> -p

-- 2. 选择数据库
USE prismer_cloud_test;

-- 3. 执行创建脚本
source /path/to/src/im/sql/001_create_tables.sql;

-- 4. 执行验证脚本
source /path/to/src/im/sql/002_verify_tables.sql;
```

### 第四步：验证迁移结果

执行验证脚本后，应看到类似输出：

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

## 表清单

| 表名 | 说明 | 主要字段 |
|------|------|----------|
| `im_users` | IM 用户表 | id, username, displayName, role, agentType |
| `im_agent_cards` | Agent 能力卡片 | id, imUserId, name, capabilities, status |
| `im_conversations` | 对话表 | id, type, workspaceId, createdById |
| `im_participants` | 参与者表 | id, conversationId, imUserId, role |
| `im_messages` | 消息表 | id, conversationId, senderId, type, content |
| `im_webhooks` | Webhook 配置 | id, url, events, active |

## 安全保证

迁移脚本的安全特性：

- ✅ 仅创建 `im_*` 前缀的表
- ✅ 使用 `CREATE TABLE IF NOT EXISTS`，可重复执行
- ✅ 不包含 DROP、TRUNCATE、DELETE 语句
- ✅ 不修改任何现有数据和表
- ✅ 验证脚本仅使用 SELECT 查询

## 配置 IM Server 使用 MySQL

迁移完成后，配置 IM Server 连接 MySQL：

### 1. 设置环境变量

```bash
# .env 或环境配置
DATABASE_URL="mysql://user:password@host:3306/database"
```

### 2. 修改 Prisma Schema (如需)

```prisma
// prisma/schema.prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

### 3. 重新生成 Prisma Client

```bash
npx prisma generate
```

### 4. 启动 IM Server

```bash
npm run im:start
```

## 故障排除

### Q: 表已存在怎么办？
A: 脚本使用 `CREATE TABLE IF NOT EXISTS`，已存在的表会被跳过，不会报错。

### Q: 可以多次执行吗？
A: 可以，脚本设计为幂等操作。

### Q: 会影响其他表吗？
A: 不会，脚本只操作 `im_*` 前缀的表。

### Q: 如何回滚？
A: 参考 `src/im/sql/README.md` 中的回滚说明（仅在测试环境使用）。

### Q: 连接失败？
A: 检查：
- 网络连通性 (`ping <host>`)
- 端口开放 (`telnet <host> 3306`)
- 用户权限 (`SHOW GRANTS;`)
- 防火墙设置

## 下一步

迁移完成后：

1. 运行集成测试验证功能
   ```bash
   npx tsx src/im/tests/integration.test.ts
   ```

2. 测试 Workspace 初始化
   ```bash
   curl -X POST http://<im-server>/api/workspace/init ...
   ```

3. 测试 @提及功能
   ```bash
   curl -X POST http://<im-server>/api/messages/<convId> \
     -d '{"content": "@agent-name 你好"}'
   ```
