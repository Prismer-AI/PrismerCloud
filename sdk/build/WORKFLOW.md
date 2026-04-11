# SDK Build & Release Workflow

> 本文件同时存在于闭源 (`prismer-cloud-next/sdk/build/`) 和开源 (`PrismerCloud/sdk/build/`) 仓库。
> 两边脚本完全一致。闭源跑到 pack 为止，开源执行 release。

---

## 架构

```
prismer-cloud-next/sdk/     (闭源 — 开发 + 编译 + 打包 + 测试)
├── aip/                    @prismer/aip-sdk (独立身份协议)
│   ├── typescript/         npm
│   ├── python/             PyPI
│   ├── golang/             Go modules
│   └── rust/               crates.io
├── prismer-cloud/          @prismer/sdk (平台 SDK + 插件)
│   ├── typescript/         npm (deps: @prismer/aip-sdk)
│   ├── python/             PyPI (deps: aip)
│   ├── golang/             Go modules
│   ├── rust/               crates.io
│   ├── mcp/                npm (@prismer/mcp-server, 47 tools)
│   ├── claude-code-plugin/ npm (@prismer/claude-code-plugin, 9 hooks + 12 skills)
│   ├── opencode-plugin/    npm (@prismer/opencode-plugin)
│   └── openclaw-channel/   npm (@prismer/openclaw-channel)
└── build/                  脚本（两边完全一致）
    ├── lib/common.sh       共享函数 + --scope 支持
    ├── sync.sh             闭源 → 开源同步
    ├── test.sh             运行测试
    ├── verify.sh           版本一致性 + 编译验证
    ├── pack.sh             打包产物
    ├── version.sh          版本号 bump
    └── release.sh          发布到 npm/PyPI/crates.io/GitHub

        sync.sh 把整个 sdk/ 同步到 ↓

PrismerCloud/sdk/           (开源 — release 专用)
├── aip/                    完全镜像
├── prismer-cloud/          完全镜像
└── build/                  完全镜像
```

### 发布目标仓库

| 仓库 | 用途 | 地址 |
|------|------|------|
| `PrismerCloud` | SDK + Plugin 源码 + release | `github.com/Prismer-AI/PrismerCloud` |
| `claude-code-plugin` | Plugin 独立仓库 (Anthropic marketplace 要求) | `github.com/Prismer-AI/claude-code-plugin` |
| `anthropics/claude-plugins-official` | Anthropic 官方 marketplace (提 PR 合入) | `github.com/anthropics/claude-plugins-official` |

**Plugin 双发布：** `claude-code-plugin/` 同时存在于 `PrismerCloud/sdk/prismer-cloud/claude-code-plugin/` (源码) 和独立 repo `Prismer-AI/claude-code-plugin` (marketplace 引用)。sync 脚本会自动同步两处。

---

## 用户侧安装

### Claude Code Plugin (推荐)

**当前（自有 marketplace）：**

```bash
# In Claude Code:
/plugin marketplace add Prismer-AI/PrismerCloud
/plugin install prismer@prismer-cloud
```

**目标（Anthropic 官方 marketplace 合入后）：**

```bash
# In Claude Code — 无需 marketplace add，官方预装：
/plugin install prismer@claude-plugins-official
```

> **状态：** Submission 已通过 (Published 2026-04-01)，需向 `anthropics/claude-plugins-official` 提 PR 合入。
> PR 内容：在 `external_plugins/prismer/` 加 plugin.json + 在 `marketplace.json` 加 source 条目指向 `Prismer-AI/claude-code-plugin`。

### MCP Server (任意 AI 编辑器)

```bash
# Claude Code
claude mcp add prismer -- npx -y @prismer/mcp-server

# Cursor / Windsurf / VS Code
npx -y @prismer/mcp-server    # 47 tools, 自动读取 ~/.prismer/config

# 手动设置 API Key
PRISMER_API_KEY=sk-prismer-... npx -y @prismer/mcp-server
```

### SDK (编程集成)

```bash
npm install @prismer/sdk                        # TypeScript
pip install prismer                             # Python
go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang  # Go
cargo add prismer-sdk                           # Rust
```

### 首次配置 (CLI)

```bash
prismer setup           # 开浏览器 → 登录 → key 自动保存 (推荐)
prismer setup --agent   # 无浏览器，自动注册 agent + 100 免费 credits (CI/脚本用)
```

---

## 日常流程

### 开发（在闭源仓库）

```bash
cd prismer-cloud-next

# 改代码
vim sdk/aip/typescript/src/identity.ts
vim sdk/prismer-cloud/typescript/src/index.ts

# 测试
sdk/build/test.sh --scope aip
sdk/build/test.sh --scope prismer-cloud

# 编译验证
sdk/build/verify.sh --scope all --skip-build

# 打包（不发布）
sdk/build/pack.sh --scope all --clean
```

### 发布（在开源仓库）

```bash
cd PrismerCloud

# 1. 同步
sdk/build/sync.sh

# 2. 版本号 bump
sdk/build/version.sh --scope aip 1.8.0
sdk/build/version.sh --scope prismer-cloud 1.8.0

# 3. 验证
sdk/build/verify.sh --scope all

# 4. 发布（AIP 先发，因为 prismer-cloud 依赖它）
sdk/build/release.sh --scope aip
sleep 30
sdk/build/release.sh --scope prismer-cloud
```

### Plugin 独立 Repo 同步

Plugin 发布后同步到独立 repo（Anthropic marketplace 引用此 repo）：

```bash
# 5. 同步到独立 plugin repo
sdk/build/sync-plugin.sh    # rsync claude-code-plugin → Prismer-AI/claude-code-plugin
```

#### sync-plugin.sh 行为

```
源: prismer-cloud-next/sdk/prismer-cloud/claude-code-plugin/
目标: ~/workspace/claude-code-plugin/  (独立 repo)

1. rsync --delete (排除 node_modules/.dev-cache 等)
2. git add -A && git commit
3. git tag v{VERSION}
4. git push origin main v{VERSION}
```

#### Anthropic 官方 Marketplace

`anthropics/claude-plugins-official` **不接受外部 PR**，只有 Anthropic 团队成员可以合入。

**我们的操作：**
1. 通过 [submission form](https://clau.de/plugin-directory-submission) 提交 plugin
2. 保持独立 repo `Prismer-AI/claude-code-plugin` 更新
3. 等 Anthropic 审核后自行合入到 `claude-plugins-official`

**当前状态：** Submission 已 Published (2026-04-01)，等待 Anthropic 合入。

---

## --scope 参数

所有脚本支持 `--scope`：

| 值 | 含义 |
|---|------|
| `aip` | 只操作 `sdk/aip/` 下的 4 个包 |
| `prismer-cloud` | 只操作 `sdk/prismer-cloud/` 下的 8 个包 |
| `all` | 两者都操作（默认） |

## 版本管理

- **AIP SDK 版本独立** — `sdk/aip/typescript/package.json` 单独管理
- **Prismer Cloud 版本统一** — `sdk/prismer-cloud/*/package.json` 全部同一版本
- **发布顺序: AIP 先 → Prismer Cloud 后**（依赖关系）

### AIP 版本文件 (4 个)

```
sdk/aip/typescript/package.json
sdk/aip/python/pyproject.toml
sdk/aip/golang/go.mod           (module path)
sdk/aip/rust/Cargo.toml
```

### Prismer Cloud 版本文件 (10 个)

```
sdk/prismer-cloud/typescript/package.json
sdk/prismer-cloud/mcp/package.json
sdk/prismer-cloud/mcp/src/index.ts              (hardcoded version string)
sdk/prismer-cloud/opencode-plugin/package.json
sdk/prismer-cloud/claude-code-plugin/package.json
sdk/prismer-cloud/claude-code-plugin/.claude-plugin/plugin.json
sdk/prismer-cloud/openclaw-channel/package.json
sdk/prismer-cloud/python/pyproject.toml
sdk/prismer-cloud/python/prismer/__init__.py    (__version__)
sdk/prismer-cloud/rust/Cargo.toml
```

## 注册表

### AIP 包

| 包 | 注册表 | 安装 |
|---|--------|------|
| `@prismer/aip-sdk` | npm | `npm i @prismer/aip-sdk` |
| `aip` | PyPI | `pip install aip` |
| `aip-sdk-go` | Go Proxy | `go get github.com/Prismer-AI/PrismerCloud/sdk/aip/golang` |
| `aip-sdk` | crates.io | `cargo add aip-sdk` |

### Prismer Cloud 包

| 包 | 注册表 | 安装 |
|---|--------|------|
| `@prismer/sdk` | npm | `npm i @prismer/sdk` |
| `prismer` | PyPI | `pip install prismer` |
| `prismer-sdk-go` | Go Proxy | `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` |
| `prismer-sdk` | crates.io | `cargo add prismer-sdk` |
| `@prismer/mcp-server` | npm | `npx -y @prismer/mcp-server` (47 tools) |
| `@prismer/claude-code-plugin` | npm + GitHub repo | `/plugin install prismer@prismer-cloud` (自有) 或 `@claude-plugins-official` (官方) |
| `@prismer/opencode-plugin` | npm | `opencode plugins install @prismer/opencode-plugin` |
| `@prismer/openclaw-channel` | npm | `openclaw plugins install @prismer/openclaw-channel` |

## Release 密钥

**只放在开源仓库，已 gitignore：**

| 文件 | 用途 |
|------|------|
| `.npmrc` | npm token (`//registry.npmjs.org/:_authToken=...`) |
| `.pypirc` | PyPI credentials |
| `.cargo-credentials` | crates.io token (`export CARGO_REGISTRY_TOKEN=...`) |
| `gh auth` | GitHub CLI login |

## 常见操作

```bash
# 只改了 AIP
sdk/build/test.sh --scope aip
sdk/build/sync.sh --scope aip        # 在开源仓库
sdk/build/release.sh --scope aip

# 只改了平台 SDK
sdk/build/test.sh --scope prismer-cloud
sdk/build/sync.sh --scope prismer-cloud
sdk/build/release.sh --scope prismer-cloud

# 全量发布
sdk/build/sync.sh
sdk/build/release.sh --scope aip
sleep 30
sdk/build/release.sh --scope prismer-cloud

# Plugin 独立 repo 同步 (每次 release 后)
sdk/build/sync-plugin.sh

# Dry run（预览不执行）
sdk/build/release.sh --scope all --dry-run

# 版本号 bump
sdk/build/version.sh --scope aip --patch      # 1.7.3 → 1.7.4
sdk/build/version.sh --scope prismer-cloud 1.8.0

# 只打包，不发布
sdk/build/pack.sh --scope prismer-cloud --clean
```

## sync.sh 行为

- 检测闭源 `sdk/` 目录结构（v2: `aip/` + `prismer-cloud/`）
- rsync 排除: `node_modules`, `dist`, `target`, `.next`, `__pycache__`, `*.egg-info`, `*.tgz`, `package-lock.json`, `.venv`, `.cache`, `.pytest_cache`
- `--scope` 控制只同步 aip 或 prismer-cloud
- `--no-clean` 增量同步（默认先删后同步）
- `--dry-run` 预览

## sync-plugin.sh 行为

- 源: `sdk/prismer-cloud/claude-code-plugin/`
- 目标: `~/workspace/claude-code-plugin/` (独立 GitHub repo `Prismer-AI/claude-code-plugin`)
- rsync 排除: `node_modules`, `.dev-cache`, `*.tgz`, `.DS_Store`
- 自动 commit + tag + push
- Anthropic 官方 marketplace 的 source URL 指向此 repo

## 产物清单 (v1.8.0)

```
artifacts/
├── npm/
│   ├── prismer-aip-sdk-1.7.3.tgz          6.5K
│   ├── prismer-sdk-1.8.0.tgz              187K
│   ├── prismer-mcp-server-1.8.0.tgz       27K
│   ├── prismer-claude-code-plugin-1.8.0.tgz 47K
│   ├── prismer-opencode-plugin-1.8.0.tgz  17K
│   └── prismer-openclaw-channel-1.8.0.tgz 22K
├── pypi/
│   ├── prismer-1.8.0-py3-none-any.whl     134K
│   └── prismer-1.8.0.tar.gz               160K
└── crates/
    └── prismer-sdk-1.8.0.crate            86K
```

## Anthropic Marketplace 上架清单

| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. Submission form 提交 | ✅ Published (2026-04-01) | `@prismer/claude-code-plugin` |
| 2. 创建独立 plugin repo | ✅ 完成 | `Prismer-AI/claude-code-plugin` (v1.8.0) |
| 3. sync-plugin.sh 同步 | ✅ 完成 | 闭源 → 独立 repo |
| 4. Anthropic 审核合入 | ⏳ 等待 | Anthropic 内部操作，不接受外部 PR |
| 5. 用户可 `/plugin install prismer@claude-plugins-official` | ⏳ 待合入 | |
