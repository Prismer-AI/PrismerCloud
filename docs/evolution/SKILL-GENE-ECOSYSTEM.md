# Skill & Gene Ecosystem — 全面改进设计

**Version:** 2.0
**Date:** 2026-03-23
**Status:** 📋 设计审阅
**Scope:** 前端 · 后端 · SDK · Plugin · 数据流 · 同步机制 · Schema · 多平台兼容

---

## 1. 行业调研

### 1.1 skills.sh (Vercel Labs)

| 维度       | 实现                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| **格式**   | SKILL.md — YAML frontmatter (`name`, `description`) + Markdown body                |
| **分发**   | GitHub repo 为源，skills.sh 为 registry（89,777 skills）                           |
| **安装**   | `npx skills add owner/repo@skill -g -y`                                            |
| **发现**   | Leaderboard (All Time / Trending / Hot) + keyword search                           |
| **平台**   | 20+ agent：Claude Code, Copilot, Cursor, OpenCode, Gemini, Codex, AMP, Windsurf... |
| **元数据** | weekly installs, GitHub stars, security audits (3 引擎), platform breakdown        |
| **详情页** | SKILL.md 渲染 + sidebar 统计 + install command + security status                   |
| **CLI**    | `npx skills find/add/check/update/init`                                            |

**关键洞察：** Skill = GitHub repo 中的 SKILL.md 文件。不需要 npm publish，不需要注册。GitHub 是 source of truth，skills.sh 是 index。安装 = 把 SKILL.md 拷贝到本地 agent skills 目录。

### 1.2 ClawHub (OpenClaw)

| 维度       | 实现                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| **格式**   | SKILL.md bundle — frontmatter 含 `metadata.openclaw.requires.env/bins` + 附带文件                      |
| **分发**   | ClawHub registry (Convex 后端) + CLI publish                                                           |
| **安装**   | `npx clawhub@latest install slug`                                                                      |
| **发现**   | Vector search + sort (downloads/installs/stars/newest) + suspicious 过滤                               |
| **Schema** | ArkType runtime validation：`slug, displayName, version, changelog, tags, files[], source{}, forkOf{}` |
| **版本**   | 语义版本 + changelog + rollback                                                                        |
| **安全**   | Moderation system: `verdict: clean/suspicious/malicious`, evidence array                               |
| **所有权** | User handle + transfer + rename + merge                                                                |
| **文件**   | 多文件 publish：每个 file 有 `path, size, storageId, sha256, contentType`                              |
| **Fork**   | `forkOf: { slug, version? }` — 原生 fork 支持                                                          |

**关键洞察：**

1. Skill = 多文件 bundle，不只是单个 SKILL.md
2. 每个文件有 sha256 校验 + content type
3. 版本化 publish：slug + version + changelog
4. Fork 是一等公民
5. 安全审计集成（suspicious detection + evidence）

### 1.3 共性提炼

```
Skill 标准格式:
├── SKILL.md           # 必须 — frontmatter + 指令 body
│   ├── name           # slug identifier
│   ├── description    # 触发描述
│   └── metadata       # 平台特定配置（requires, env, bins）
├── 附加文件           # 可选 — scripts, data, configs
└── 版本 + 校验        # version, sha256, changelog

安装流程:
1. 发现: search API / leaderboard / 推荐
2. 选择: 查看详情 (installs, security, compatibility)
3. 安装: CLI 或 API 拉取 bundle 到本地 skills 目录
4. 加载: Agent 启动时扫描 skills 目录
5. 执行: 匹配触发条件时加载 skill 内容

分发模型:
- GitHub repo 为 source of truth
- Registry (skills.sh / clawhub.ai) 为 index + metrics
- CLI (npx skills / clawhub) 为安装工具
```

---

## 2. Prismer 的差异化定位

Prismer 不仅仅做 Skill registry。Prismer 的独特价值是 **Skill → Gene → Evolution 闭环**：

```
                    skills.sh / ClawHub
                    (静态知识库)
                         │
                         │ Skill = 文档 + 指令
                         │ 安装 = 拷贝文件
                         │ 使用 = Agent 读文档
                         │
                         ▼
              ┌─────── Prismer ──────┐
              │                      │
              │  Skill → Gene 转化   │ ← 独有
              │  Gene → 进化网络     │ ← 独有
              │  Thompson Sampling   │ ← 独有
              │  跨 Agent 学习       │ ← 独有
              │  蒸馏 → 新 Skill     │ ← 独有
              │                      │
              └──────────────────────┘

区别:
- skills.sh: Skill 被安装后是静态文档
- Prismer: Skill 安装后转为 Gene，进入进化网络
           Gene 有执行统计 → Thompson Sampling 排序
           成功 Gene 被蒸馏为新 Skill → 反向贡献回社区
```

**Prismer 不是第 3 个 skills.sh / clawhub，而是把 Skill 接入进化引擎的中间层。**

---

## 3. Skill 数据标准

### 3.1 Prismer SKILL.md 格式（兼容 skills.sh + ClawHub）

````yaml
---
# === 核心字段（兼容 skills.sh）===
name: timeout-recovery
description: "Handles timeout errors with exponential backoff retry strategies"

# === 分发字段（兼容 ClawHub）===
version: "1.0.0"
author: prismer
tags: [timeout, retry, backoff, http]
license: MIT

# === 运行时字段（兼容 ClawHub metadata.openclaw）===
metadata:
  prismer:                              # Prismer 扩展命名空间
    category: repair                    # repair | optimize | innovate | diagnostic
    signals:                            # 对应 Gene signals_match
      - type: "error:timeout"
        provider: http
      - type: "error:connection_refused"
    gene:                               # 安装时自动创建的 Gene 模板
      strategy:
        - "Increase timeout to 30s"
        - "Add exponential backoff (base 1s, factor 2)"
        - "Retry up to 3 times"
      preconditions:
        - "Service endpoint is reachable"
      constraints:
        max_retries: 5
        max_credits_per_run: 1.0
  openclaw:                             # OpenClaw 兼容
    requires:
      env: [PRISMER_API_KEY]
      bins: [curl]
    primaryEnv: PRISMER_API_KEY

# === 平台兼容 ===
compatibility:
  - claude-code
  - opencode
  - openclaw
  - prismer-sdk
  - cursor
  - copilot
---

# Timeout Recovery

When an HTTP request times out, apply this graduated retry strategy...

## When to Use
- HTTP 408/504 responses
- Connection timeout errors
- DNS resolution timeouts
- `ETIMEDOUT` / `ECONNRESET` errors

## Strategy
1. Check current timeout setting
2. Increase by 2x (cap at 60s)
3. Add jitter: random(0, timeout × 0.1)
4. Retry with exponential backoff (base 1s, max 3 retries)
5. If persistent, try fallback URL

## For Agents (Installation)
```bash
# Prismer CLI
prismer skill install timeout-recovery

# skills.sh
npx skills add prismer/skills@timeout-recovery

# ClawHub
npx clawhub install timeout-recovery
````

## For Humans

This skill teaches your agent to handle HTTP timeout errors gracefully...

```

### 3.2 多文件 Skill Bundle

```

timeout-recovery/
├── SKILL.md # 必须 — 核心文件
├── scripts/ # 可选
│ └── health-check.sh # 附带的检测脚本
├── data/ # 可选
│ └── retry-config.json # 默认配置数据
├── examples/ # 可选
│ └── usage.ts # 使用示例
└── README.md # 可选 — 人类友好文档

````

**打包：** tarball (`.tar.gz`)，上传到 S3/Blob，通过 `packageUrl` 引用。
**校验：** SHA-256 per file（兼容 ClawHub 的 `CliPublishFile.sha256`）。

### 3.3 双面内容设计

每个 Skill 必须同时服务两类读者：

**给人看的（Skill Card + README）：**
- 一句话描述
- 使用场景列表
- 安装命令（多平台）
- 效果截图/统计
- 作者 + 版本 + license

**给 Agent 读的（SKILL.md body + metadata.prismer）：**
- 精确的触发信号 (`signals`)
- 可执行的策略步骤 (`gene.strategy`)
- 前置条件 (`gene.preconditions`)
- 约束限制 (`gene.constraints`)
- 运行依赖 (`requires.env`, `requires.bins`)

---

## 4. Schema 变更

### 4.1 IMSkill 扩展

```sql
ALTER TABLE im_skills ADD COLUMN package_url VARCHAR(500) DEFAULT NULL;
ALTER TABLE im_skills ADD COLUMN package_hash VARCHAR(64) DEFAULT NULL;       -- sha256
ALTER TABLE im_skills ADD COLUMN package_size INT DEFAULT NULL;               -- bytes
ALTER TABLE im_skills ADD COLUMN file_count INT DEFAULT 1;
ALTER TABLE im_skills ADD COLUMN compatibility TEXT DEFAULT '[]';             -- JSON: platform[]
ALTER TABLE im_skills ADD COLUMN signals TEXT DEFAULT '[]';                   -- JSON: SignalTag[]
ALTER TABLE im_skills ADD COLUMN requires TEXT DEFAULT '{}';                  -- JSON: { env[], bins[], capabilities[] }
ALTER TABLE im_skills ADD COLUMN version VARCHAR(20) DEFAULT '1.0.0';
ALTER TABLE im_skills ADD COLUMN owner_agent_id VARCHAR(36) DEFAULT NULL;
ALTER TABLE im_skills ADD COLUMN forked_from VARCHAR(36) DEFAULT NULL;
ALTER TABLE im_skills ADD COLUMN fork_count INT DEFAULT 0;
ALTER TABLE im_skills ADD COLUMN license VARCHAR(20) DEFAULT 'MIT';
ALTER TABLE im_skills ADD COLUMN security_status VARCHAR(20) DEFAULT 'pending'; -- pending | clean | suspicious | malicious
ALTER TABLE im_skills ADD COLUMN changelog TEXT DEFAULT '';
````

### 4.2 IMAgentSkill（新表）

```sql
CREATE TABLE im_agent_skills (
  id VARCHAR(36) PRIMARY KEY,
  agent_id VARCHAR(36) NOT NULL,
  skill_id VARCHAR(36) NOT NULL,
  gene_id VARCHAR(36),                 -- 安装时自动创建的 Gene
  installed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,                 -- Skill 版本更新时间
  config TEXT DEFAULT '{}',            -- JSON: Agent 自定义配置
  status VARCHAR(20) DEFAULT 'active', -- active | disabled | uninstalled
  version VARCHAR(20),                 -- 安装时的版本

  UNIQUE KEY idx_agent_skill (agent_id, skill_id),
  INDEX idx_agent (agent_id),
  INDEX idx_skill (skill_id)
);
```

---

## 5. API 设计

### 5.1 Skill 安装（核心改造）

```
POST /api/skills/:idOrSlug/install
Authorization: Bearer <agent-token>

Response:
{
  "ok": true,
  "data": {
    "agentSkill": {
      "id": "...",
      "status": "active",
      "version": "1.0.0"
    },
    "gene": {                          // 自动创建的 Gene
      "id": "...",
      "category": "repair",
      "strategy": ["Increase timeout...", "Add backoff...", "Retry..."],
      "signals_match": [{ "type": "error:timeout" }]
    },
    "skill": {
      "id": "...",
      "slug": "timeout-recovery",
      "name": "Timeout Recovery",
      "content": "---\nname: timeout-recovery\n...(完整 SKILL.md)...",
      "packageUrl": "https://cdn.prismer.cloud/skills/timeout-recovery-1.0.0.tar.gz",
      "files": ["SKILL.md", "scripts/health-check.sh"],
      "compatibility": ["claude-code", "opencode", "openclaw", "prismer-sdk"]
    },
    "installGuide": {
      "claude_code": {
        "auto": "Gene loaded via MCP evolution tools",
        "manual": "Save SKILL.md to ~/.claude/skills/timeout-recovery/SKILL.md"
      },
      "opencode": {
        "auto": "Gene loaded via plugin event hooks",
        "manual": "Save to ~/.config/opencode/skills/timeout-recovery/SKILL.md"
      },
      "openclaw": {
        "command": "openclaw plugins install @prismer/timeout-recovery"
      },
      "sdk": {
        "typescript": "client.im.skills.install('timeout-recovery')",
        "python": "client.im.skills.install('timeout-recovery')",
        "cli": "prismer skill install timeout-recovery"
      },
      "skills_sh": "npx skills add prismer/skills@timeout-recovery",
      "clawhub": "npx clawhub install timeout-recovery"
    }
  }
}
```

**安装服务端逻辑：**

```typescript
async installSkill(agentId: string, skillIdOrSlug: string): Promise<InstallResult> {
  // 1. 查找 Skill
  const skill = await findSkill(skillIdOrSlug);

  // 2. 检查是否已安装
  const existing = await prisma.iMAgentSkill.findUnique({
    where: { agentId_skillId: { agentId, skillId: skill.id } },
  });
  if (existing?.status === 'active') return { alreadyInstalled: true, ... };

  // 3. 从 Skill 的 metadata.prismer 提取 Gene 数据
  const skillMeta = parseSkillMdFrontmatter(skill.content);
  const geneMeta = skillMeta?.metadata?.prismer?.gene;
  const signals = skillMeta?.metadata?.prismer?.signals || [];

  // 4. 创建 Gene（如果有 gene 模板）
  let gene = null;
  if (geneMeta && signals.length > 0) {
    gene = await evolutionService.createAndSaveGene(agentId, {
      category: skillMeta.metadata.prismer.category || 'general',
      title: skill.name,
      signals_match: signals,
      strategy: geneMeta.strategy || [],
      preconditions: geneMeta.preconditions || [],
      constraints: geneMeta.constraints || {},
    });
  }

  // 5. 创建安装记录
  const agentSkill = await prisma.iMAgentSkill.upsert({
    where: { agentId_skillId: { agentId, skillId: skill.id } },
    create: { agentId, skillId: skill.id, geneId: gene?.id, version: skill.version, status: 'active' },
    update: { geneId: gene?.id, version: skill.version, status: 'active', updatedAt: new Date() },
  });

  // 6. 增加安装计数
  await prisma.iMSkill.update({ where: { id: skill.id }, data: { installs: { increment: 1 } } });

  // 7. 生成安装指引
  const installGuide = generateInstallGuide(skill);

  return { agentSkill, gene, skill, installGuide };
}
```

### 5.2 已安装 Skill 列表

```
GET /api/skills/installed
Authorization: Bearer <agent-token>
Query: ?status=active

Response:
{
  "ok": true,
  "data": [
    {
      "agentSkill": { "id", "status", "version", "installedAt" },
      "skill": { "slug", "name", "category", "version", "compatibility" },
      "gene": { "id", "category", "successCount", "failureCount" }
    }
  ]
}
```

### 5.3 Skill 内容获取

```
GET /api/skills/:idOrSlug/content
Authorization: Bearer <token>

Response:
{
  "ok": true,
  "data": {
    "content": "---\nname: timeout-recovery\n...(完整 SKILL.md)...",
    "packageUrl": "https://cdn.../skill.tar.gz",
    "files": [
      { "path": "SKILL.md", "size": 2340, "sha256": "abc..." },
      { "path": "scripts/health-check.sh", "size": 890, "sha256": "def..." }
    ]
  }
}
```

### 5.4 Skill Publish（多文件上传）

```
POST /api/skills/publish
Authorization: Bearer <token>
Content-Type: multipart/form-data

Body:
  slug: "my-skill"
  displayName: "My Skill"
  version: "1.0.0"
  changelog: "Initial release"
  tags: ["timeout", "retry"]
  files[]: (SKILL.md binary)
  files[]: (scripts/setup.sh binary)

Response:
{
  "ok": true,
  "data": {
    "skillId": "...",
    "versionId": "...",
    "slug": "my-skill",
    "packageUrl": "https://cdn.../my-skill-1.0.0.tar.gz"
  }
}
```

### 5.5 Skill 搜索（增强）

```
GET /api/skills/search
Query: ?query=timeout&compatibility=claude-code&category=repair&sort=installs&limit=10&hasGene=true

Response 每条增加:
{
  "signals": [{ "type": "error:timeout" }],       // 触发信号
  "compatibility": ["claude-code", "opencode"],     // 兼容平台
  "hasPackage": true,                               // 有附件包
  "fileCount": 3,                                   // 文件数
  "version": "1.0.0",
  "securityStatus": "clean",                        // 安全状态
  "installCommand": {
    "prismer": "prismer skill install timeout-recovery",
    "skills_sh": "npx skills add prismer/skills@timeout-recovery"
  }
}
```

### 5.6 Gene 导出为 Skill

```
POST /api/evolution/genes/:geneId/export-skill
Authorization: Bearer <token>
Body: { slug?, displayName?, changelog? }

→ 从 Gene 数据自动生成 SKILL.md
→ 创建 IMSkill 记录
→ 返回 Skill + 生成的 SKILL.md 内容
```

### 5.7 Agent Profile Fork

```
POST /api/agents/fork-profile
Authorization: Bearer <token>
Body: {
  sourceAgentId: "agent-a",
  includeSkills: true,
  includeGenes: true,
  includePersonality: false
}

→ 复制所有 IMAgentSkill 记录到当前 agent
→ Fork 所有 Gene（新 ownerAgentId）
→ 返回 { skills: N, genes: M }
```

---

## 6. SDK 支持

### 6.1 TypeScript SDK

```typescript
// 搜索（兼容 Agent 自主发现）
const results = await client.im.skills.search({
  query: 'timeout',
  compatibility: 'claude-code',
  category: 'repair',
  hasGene: true,
});

// 安装（自动创建 Gene + 返回内容 + 安装指引）
const result = await client.im.skills.install('timeout-recovery');
console.log(result.gene.strategy); // Gene 策略
console.log(result.skill.content); // SKILL.md 全文
console.log(result.installGuide.sdk); // SDK 安装指引

// 已安装列表（Agent 重启恢复）
const installed = await client.im.skills.installed();

// 获取内容（懒加载，需要时下载）
const detail = await client.im.skills.getContent('timeout-recovery');

// 卸载
await client.im.skills.uninstall('timeout-recovery');

// 发布（开发者上传）
await client.im.skills.publish({
  slug: 'my-skill',
  displayName: 'My Skill',
  version: '1.0.0',
  files: [{ path: 'SKILL.md', content: '...' }],
});

// Gene 导出为 Skill
await client.im.evolution.exportAsSkill(geneId, {
  slug: 'my-gene-skill',
  changelog: 'Auto-generated from gene',
});

// Fork 其他 Agent 的能力
await client.im.agents.forkProfile('source-agent-id', {
  includeSkills: true,
  includeGenes: true,
});
```

### 6.2 CLI

```bash
# 搜索
prismer skill search "timeout retry"
prismer skill search --category repair --compatibility claude-code

# 安装
prismer skill install timeout-recovery
prismer skill install timeout-recovery --platform claude-code  # 附带平台安装

# 已安装
prismer skill list
prismer skill list --status active

# 内容查看
prismer skill show timeout-recovery

# 卸载
prismer skill uninstall timeout-recovery

# 发布
prismer skill publish ./my-skill/ --version 1.0.0

# Gene 导出
prismer evolve export-skill --gene gene-id --slug my-gene-skill

# Fork Profile
prismer agent fork --from source-agent-id --skills --genes
```

### 6.3 MCP Server

新增 tools：

| Tool            | 描述                                         |
| --------------- | -------------------------------------------- |
| `skill_search`  | 搜索 Skill（query, category, compatibility） |
| `skill_install` | 安装 Skill → 创建 Gene + 返回内容            |
| `skill_list`    | 列出已安装 Skills                            |
| `skill_content` | 获取 Skill 完整内容                          |

---

## 7. Plugin 动态 Skill 加载

### 7.1 Claude Code Plugin

**当前：** 3 个硬编码 Skills
**改进：** 硬编码 Skills 保留 + 支持从云端动态安装

```
Agent 通过 MCP tool 安装 Skill:
  skill_install("timeout-recovery")
    │
    ├── MCP server 调 POST /api/skills/:id/install
    │   → 返回 { gene, skill.content, installGuide }
    │
    ├── Gene 通过 evolution sync 自动加入候选池（已有机制）
    │
    └── SKILL.md 写入 Claude Code 可发现的位置:
        选项 A: 写入 ~/.claude/skills/{slug}/SKILL.md
          → Claude Code 自动发现
          → Agent 可以调用 /prismer:{slug} 命令
        选项 B: 仅通过 MCP evolution tools 使用
          → Gene 匹配时返回策略
          → 不需要本地文件（云端 Gene 够用）
```

**推荐：选项 B 优先。** Gene 进入候选池后，Agent 遇到匹配信号时自动获取策略。不需要写本地文件，减少文件系统副作用。如果用户需要本地 Skill（自定义修改等），提供选项 A 作为高级功能。

### 7.2 OpenCode Plugin

```
Plugin event hook: skill.install
  → 调 POST /api/skills/:id/install
  → Gene 通过 evolution sync 自动同步
  → 可选: 写入 ~/.config/opencode/skills/{slug}/SKILL.md
```

### 7.3 OpenClaw Channel Plugin

```
Agent 收到 Skill 推荐消息
  → 通过 Prismer channel 调 install API
  → Gene 自动创建
  → 通过 OpenClaw tool API 注册新能力
```

---

## 8. 云端管理 & 同步

### 8.1 Agent 启动恢复

```
Agent 启动 / 重启 / 迁移
  │
  ├── 1. Evolution sync (已有)
  │     GET /api/evolution/sync/snapshot
  │     → genes, edges, globalPrior, cursor
  │     → 包含从 Skill 安装的 Gene
  │
  ├── 2. Skill sync (新增)
  │     GET /api/skills/installed
  │     → 已安装 Skill 列表 + 版本 + Gene ID
  │     → Agent 知道自己有什么能力
  │
  └── 3. 内容按需加载 (lazy)
        需要时: GET /api/skills/:id/content
        → 完整 SKILL.md + packageUrl
```

### 8.2 Sync 协议扩展

在现有 `POST /api/evolution/sync` 中增加：

```json
{
  "pull": {
    "since": 1711100000000,
    "includeSkills": true
  }
}

Response.pulled 增加:
{
  "installedSkills": [
    { "skillId": "...", "slug": "timeout-recovery", "geneId": "...", "version": "1.0.0", "action": "installed" }
  ],
  "skillUpdates": [
    { "skillId": "...", "slug": "timeout-recovery", "newVersion": "1.1.0", "action": "updated" }
  ]
}
```

### 8.3 Skill 继承 & Fork

```
Agent A (10 skills, 5 genes)
  │
  ├── Fork Profile → Agent B
  │     POST /api/agents/fork-profile
  │     → 复制 10 个 IMAgentSkill 记录
  │     → Fork 5 个 Gene（新 owner = B）
  │     → Agent B 启动后立即具备 A 的能力
  │
  ├── Workspace Template
  │     创建 workspace skill set
  │     → 新加入的 Agent 自动安装 workspace 的 skills
  │
  └── Skill 版本更新
      作者发布 v1.1.0
      → 通过 sync 通知已安装的 Agent
      → Agent 可选择 auto-update 或手动确认
```

---

## 9. 前端改进

### 9.1 Library Skill Card 增强

```
┌────────────────────────────────────────┐
│ Skill                  repair          │
│                                        │
│ Timeout Recovery          v1.0.0       │
│ Handles timeout errors with            │
│ exponential backoff retry strategies   │
│                                        │
│ ⚡ error:timeout  ⚡ error:conn_refused │ ← signals 标签
│                                        │
│ 🟣Claude Code  🔵OpenCode  🟢OpenClaw  │ ← compatibility 图标
│                                        │
│ 📦 1,234 installs  ★ 56  📁 3 files   │
│                                        │
│ ┌──────────┐ ┌────────┐ ┌──────────┐  │
│ │ Install  │ │  Fork  │ │ ★ Star  │  │ ← 登录后显示
│ └──────────┘ └────────┘ └──────────┘  │
│                                        │
│ ✓ Installed · Gene: 83% success       │ ← 已安装状态
└────────────────────────────────────────┘
```

### 9.2 Skill Detail Drawer（4 Tab）

| Tab               | 内容                                                           |
| ----------------- | -------------------------------------------------------------- |
| **Overview**      | 描述, signals 标签, compatibility 图标, requires, files, stats |
| **SKILL.md**      | Markdown 完整渲染（给人读）+ 代码高亮                          |
| **Install Guide** | 多平台安装命令（Prismer / skills.sh / ClawHub / SDK / CLI）    |
| **Gene**          | 关联 Gene 的 strategy, stats, edges, capsules                  |

### 9.3 Install Confirmation Dialog

点 [Install] 后弹出确认：

- 将要做什么（创建 Gene + 下载内容）
- Skill 的 signals 列表
- 多平台后续步骤
- [Cancel] + [Install 📦]

### 9.4 My Skills 增强

从"显示所有 community skills"改为"显示我安装的 skills"：

```
GET /api/skills/installed (替代 /api/skills/search)
```

每行显示：Skill 名 + 版本 + Gene 成功率 + 安装时间 + [Uninstall] [Disable] [Update]

---

## 10. 身份闭环

### 10.1 所有权链

```
人类用户 (API Key)
  └── Agent (imUserId, JWT, trustTier)
       ├── 安装的 Skills: IMAgentSkill[] (agent-skill 绑定, 含 geneId)
       ├── 拥有的 Genes: IMGene[] (ownerAgentId)
       ├── 创建的 Skills: IMSkill[] (ownerAgentId)
       ├── 执行记录: IMEvolutionCapsule[] → 影响 Gene 评分
       └── 人格: IMAgentPersonality (rigor, creativity, risk_tolerance)
```

### 10.2 权限矩阵

| 操作          | 匿名 | Tier 0     | Tier 1      | Tier 2+ |
| ------------- | ---- | ---------- | ----------- | ------- |
| 搜索 Skill    | ✅   | ✅         | ✅          | ✅      |
| 查看详情      | ✅   | ✅         | ✅          | ✅      |
| 安装 Skill    | ❌   | ✅ (5/day) | ✅ (50/day) | ✅ 无限 |
| 上传 Skill    | ❌   | ❌         | ✅          | ✅      |
| Publish Skill | ❌   | ❌         | ❌          | ✅      |
| Fork Profile  | ❌   | ❌         | ✅          | ✅      |

---

## 11. 实施计划

### Phase 1: Schema + 安装闭环 (3d)

- IMSkill schema 扩展（signals, compatibility, version, ownerAgentId, packageUrl）
- IMAgentSkill 新表
- `POST /api/skills/:id/install` 改造（创建 AgentSkill + Gene）
- `GET /api/skills/installed` 端点
- `GET /api/skills/:id/content` 端点
- `DELETE /api/skills/:id/install` 卸载端点

### Phase 2: SDK + CLI + MCP (2d)

- TypeScript SDK: skills.install/installed/getContent/uninstall/publish
- Python/Go SDK 同步
- MCP: skill_search + skill_install tools
- CLI: prismer skill install/list/uninstall/publish/search

### Phase 3: 前端 (2d)

- Library Skill Card 增强（signals, compatibility, 已安装状态）
- Skill Detail Drawer（4 tab）
- Install Confirmation Dialog
- My Skills → 改为已安装列表

### Phase 4: Gene↔Skill 双向 + 继承 (2d)

- Gene 导出为 Skill API
- Agent Profile Fork API
- Sync 协议 Skill 扩展
- Skill 版本更新通知

### Phase 5: 多平台 Publish + 打包 (1d)

- 多文件 Skill Publish（multipart upload → S3 tarball）
- SHA-256 校验
- Skill 安全扫描（基础 suspicious detection）

**总计: 10d**

---

## 12. 验收标准

### 对人类用户

- [ ] Library 中 Skill 卡片显示 signals + compatibility + 已安装状态
- [ ] 点 Install 弹确认 → Gene 创建 → 出现在 My Genes
- [ ] My Skills 显示已安装 Skill + 关联 Gene 成功率
- [ ] Skill Detail 有 4 个 tab（Overview / SKILL.md / Install Guide / Gene）
- [ ] 能上传多文件 Skill（SKILL.md + scripts）
- [ ] Gene 能导出为 Skill

### 对 Agent

- [ ] `skills.search()` 返回 signals + compatibility + installCommand
- [ ] `skills.install()` 返回完整 SKILL.md + Gene + 安装指引
- [ ] Agent 重启后 `skills.installed()` 恢复所有 Skill
- [ ] Gene sync 包含 Skill 安装的 Gene
- [ ] MCP `skill_install` tool 能触发安装
- [ ] CLI `prismer skill install` 完整工作

### 对平台

- [ ] Skill → Gene 自动转化闭环
- [ ] Gene → Skill 导出闭环
- [ ] Fork Profile 继承闭环
- [ ] 安装/卸载审计（IMAgentSkill 记录）
- [ ] Trust Tier 控制权限
- [ ] SKILL.md 格式兼容 skills.sh + ClawHub

---

## Appendix: 与竞品对比

| 维度              | skills.sh                     | ClawHub                  | **Prismer**                                 |
| ----------------- | ----------------------------- | ------------------------ | ------------------------------------------- |
| Skill 格式        | SKILL.md 单文件               | SKILL.md bundle + 多文件 | SKILL.md + 多文件 + **Gene 模板**           |
| 安装结果          | 文件拷贝到本地                | 文件拷贝到本地           | **文件 + Gene 进入进化网络**                |
| 安装后价值        | 静态文档                      | 静态文档                 | **动态进化（Thompson Sampling）**           |
| 跨 Agent 学习     | ❌                            | ❌                       | **✅ Gene 共享 + Pooled Prior**             |
| 蒸馏              | ❌                            | ❌                       | **✅ 成功执行 → LLM 合成新 Gene**           |
| Gene → Skill 反哺 | ❌                            | ❌                       | **✅ 导出为 Skill 回馈社区**                |
| 版本管理          | GitHub 管                     | semver + changelog       | semver + changelog                          |
| 安全审计          | 3 引擎 (TrustHub/Socket/Snyk) | suspicious detection     | 基础 detection (v1)                         |
| 平台兼容          | 20+                           | OpenClaw 生态            | **Claude Code + OpenCode + OpenClaw + SDK** |
| 云端状态          | ❌ (本地)                     | 部分 (sync)              | **✅ 完整云端管理 + 继承 + Fork**           |
