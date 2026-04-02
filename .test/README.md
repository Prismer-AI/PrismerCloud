# Cookbook Integration Tests

验证 `docs/cookbook/` 中所有文档化 API 能力是否真实可用的集成测试。

## 定位：与 SDK 测试的分工

| 测试套件 | 位置 | 目的 |
|---------|------|------|
| **SDK 测试** | `sdk/prismer-cloud/typescript/tests/` | 回归测试 — 验证 SDK 实现的正确性、跨语言一致性、边界条件 |
| **Cookbook 测试** | `.test/cookbook/` | 契约测试 — 验证文档描述的能力 = 真实可用的 API 行为 |

SDK 测试关心"实现对不对"，Cookbook 测试关心"文档说的做不做得到"。如果 Cookbook 测试挂了，说明文档和 API 脱节了。

## 运行方式

```bash
cd .test
npm install

# 方式 1：显式传入 API Key
PRISMER_API_KEY_TEST="sk-prismer-..." npm test

# 方式 2：自动读取 ~/.prismer/config.toml（如果已 prismer setup）
npm test

# 指定测试环境
PRISMER_API_KEY_TEST="sk-prismer-..." PRISMER_BASE_URL_TEST="https://cloud.prismer.dev" npm test

# 运行单个 cookbook 测试
PRISMER_API_KEY_TEST="sk-prismer-..." npx vitest run cookbook/quickstart.test.ts

# Watch 模式
PRISMER_API_KEY_TEST="sk-prismer-..." npm run test:watch
```

## 测试覆盖

| # | Cookbook | 测试文件 | 验证的 API |
|---|---------|---------|-----------|
| 1 | [Quick Start](../docs/cookbook/en/quickstart.md) | `cookbook/quickstart.test.ts` | register, sendDM, getMessages |
| 2 | [Agent Messaging](../docs/cookbook/en/agent-messaging.md) | `cookbook/agent-messaging.test.ts` | register×2, sendDM, createGroup, sendGroupMsg, listConversations |
| 3 | [Evolution Loop](../docs/cookbook/en/evolution-loop.md) | `cookbook/evolution-loop.test.ts` | evolve(failure), analyze, createGene, record(success), publishGene, browseGenes |
| 4 | [Skill Marketplace](../docs/cookbook/en/skill-marketplace.md) | `cookbook/skill-marketplace.test.ts` | searchSkills, getSkillStats, installSkill, installedSkills, getSkillContent, uninstallSkill |
| 5 | [AIP Identity](../docs/cookbook/en/identity-aip.md) | `cookbook/identity-aip.test.ts` | registerKey(Ed25519), getKey, getServerKey, getAuditLog |
| 6 | [File Upload](../docs/cookbook/en/file-upload.md) | `cookbook/file-upload.test.ts` | presign, upload(multipart), confirm, types, quota |
| 7 | [Real-Time](../docs/cookbook/en/realtime.md) | `cookbook/realtime.test.ts` | WS connect/auth/ping/join/message.new, SSE connect/message.new |
| 8 | [Workspace](../docs/cookbook/en/workspace.md) | `cookbook/workspace.test.ts` | workspace.init, initGroup, sendMessage, mentionAutocomplete, listAgents |

## 架构

```
.test/
├── package.json          # 依赖：vitest + @prismer/sdk (local)
├── tsconfig.json
├── vitest.config.ts      # alias 解析 SDK 源码
├── helpers.ts            # 共享工具：apiClient, imClient, registerAgent, config.toml fallback
└── cookbook/
    ├── quickstart.test.ts
    ├── agent-messaging.test.ts
    ├── evolution-loop.test.ts
    ├── skill-marketplace.test.ts
    ├── identity-aip.test.ts
    ├── file-upload.test.ts
    ├── realtime.test.ts
    └── workspace.test.ts
```

## CI

Cookbook 测试在 `.github/workflows/cookbook-tests.yml` 中自动运行：
- 工作日每天 08:00 UTC
- PR 触及 `.test/`、SDK 源码或 cookbook 文档时
- 手动触发（workflow_dispatch）

需要在 GitHub Secrets 中配置 `PRISMER_API_KEY_TEST`。

## 已知的 API 行为差异

| API | 文档暗示 | 实际行为 | 测试策略 |
|-----|---------|---------|----------|
| `me().username` | 注册时的 username | 可能返回内部 ID | 断言 `toBeDefined()` |
| `realtime senderId` | 与 `imUserId` 一致 | 可能是不同的内部 ID | 断言存在性 |
| `evolution.record()` | 可传 `_explore_` | 需要真实 gene_id | 改用 `evolve()` |
| Group 新成员发消息 | 立即可发 | 可能有权限传播延迟 | 增加容错 |
| `identity.getServerKey()` | 所有身份可调用 | 某些环境/身份不可用 | 非阻断断言 |

## 注意事项

- 这些是 **集成测试**，需要对线上 API 发起真实请求
- 每次运行会创建临时 agent（用 `RUN_ID` 避免命名冲突）
- 测试超时默认 60 秒，适应网络延迟
- WebSocket/SSE 测试需要服务器支持实时连接
- Gene 和 Skill 资源会在 `afterAll` 中清理
