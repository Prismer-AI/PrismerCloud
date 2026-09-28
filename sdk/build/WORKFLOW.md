# SDK Build & Release Workflow

> 闭源仓库负责开发、验证与打包；开源 `PrismerCloud` 仓库负责 registry publish。根目录 `/VERSION` 是所有发布版本的单一真相源。

## 产品与包

```text
sdk/
├── aip/
│   ├── typescript/   @prismer/aip-sdk
│   └── python/       prismer-aip
├── cloud/
│   ├── package.json  @prismer/sdk（canonical CLI: cloud）
│   ├── python/       prismer（canonical CLI: prismer-py）
│   ├── mcp/          @prismer/mcp-server
│   └── catalog/      Cloud authoritative skills / roles
├── prismer/          @prismer/runtime（CLI: prismer / prismer-runtime）
└── build/            test / verify / pack / sync / release
```

Claude Code 与 OpenCode 是 `@prismer/runtime` 内的 hosted provider，不是独立发布产品。发布矩阵中没有 coding-agent plugin、Marketplace manifest、plugin tgz 或独立 plugin repo 同步步骤。迁移说明见 `docs/migrations/2.2.5-runtime-hosted-coding-agents.md`。

## 用户安装

### Runtime host

```bash
npm install -g @prismer/runtime
prismer setup
prismer daemon start
```

### Cloud SDK

```bash
npm install @prismer/sdk
pip install prismer
```

`cloud ...` 是 Cloud API client CLI。Python 的 canonical bin 是 `prismer-py`；旧 `prismer` Python bin 只作为兼容入口，不能用来管理 Node Runtime daemon。

### AIP

```bash
npm install @prismer/aip-sdk
pip install prismer-aip
```

AIP 是独立 identity/trust protocol，不拥有 Runtime lifecycle、skill delivery、memory extraction 或 Cloud task wire。

### MCP

```bash
claude mcp add prismer -- npx -y @prismer/mcp-server
```

MCP 是面向第三方 host 的 bounded tool surface。Runtime-hosted provider 的 MCP options 由 adapter 在隔离配置中注入，不需要修改用户全局配置。

## 闭源验证与打包

```bash
sdk/build/test.sh --scope all
sdk/build/verify.sh --scope all
sdk/build/pack.sh --scope all --clean
```

常用 scope：

| scope | 内容 |
| --- | --- |
| `aip` | AIP TypeScript + Python |
| `cloud` | Cloud TypeScript/Python + MCP |
| `prismer` | Prismer Runtime |
| `all` | AIP + Cloud + Runtime |
| `prismer-cloud` | `cloud + prismer` 的兼容 alias；3.0.0 删除，调用时输出 warning |

`sdk/build/sandbox-verify.sh` 对 tgz / wheel 做安装与 import/CLI smoke。它只检查当前发布矩阵中的 artifact。

### 本地 Pod 启动 bundle

`npm run dev:local` 的 Pod 交付路径与 registry publish 分开：

1. 按 AIP → Cloud SDK → Runtime 顺序跑 TypeScript gate；
2. `sdk/build/pack.sh --scope all --npm-only --install` 先产出本地 AIP tgz，
   Cloud SDK 只安装这一个精确 tgz，并把 AIP 作为 bundled dependency 打进
   `prismer-sdk-*.tgz`；
3. Runtime bundle packer 把这个精确 Cloud SDK tgz 安装进 staging；
4. 签名 manifest 记录 Runtime / Cloud SDK / AIP 的实际包名与版本，以及 bundle
   sha256/sha512、签名和 skill fingerprint；
5. Pod 启动后由 frozen image 中的独立 bootstrapper 下载、验签和解包。

这个 bundle 是本地 Pod 获得三套 JavaScript 产品包的唯一入口。Frozen image
只提供 Rust manager、bootstrapper、系统/agent 工具和 `better-sqlite3` ABI floor，
不包含任何 Runtime/Cloud SDK/AIP tgz 或全局 CLI。Runtime、Cloud SDK 或 AIP 源码
变更只走 bundle/OTA，不触发 image build，也不读取或修改 `image-pin.yaml`。

本地 bundle 版本使用 `X.Y.Z-dev.<epoch>.<source-fingerprint>`，只用于
`im_runtime_releases` canary，不改变根 `/VERSION` 或 registry package version。

启动安装的 `current` / `previous` / `boot-attempt.json` 采用同目录临时文件
加 rename 的原子写，并固定为 `0640 user:user`。Runtime 用户拥有文件，常驻
`sandbox-mgr` 通过 `user` 组只读；禁止依赖进程 umask，否则 `0077` 会让 manager
无法执行下次启动的 settle/rollback。

## 版本同步

```bash
sdk/build/version.sh 2.2.5 --scope all
npx tsx scripts/check-version-consistency.ts
```

`version.sh` 只接受 monorepo-wide `--scope all`，同步 `/VERSION`、root/desktop/active SDK manifests、tracked lockfile root、Python version、必要的硬编码 server/CLI version，以及 Cloud→AIP 的 npm/PyPI dependency range。

不要手工只改某一个 manifest，也不要发布 npm 不接受的四段 package version。所有 registry package 只使用根 `/VERSION` 驱动的 `X.Y.Z`。紧急处置先回退部署、npm dist-tag 或安装文档到上一已验证版本，再用 `sdk/build/version.sh --patch --scope all` 协调发布下一正常 patch。

## 同步与发布

```bash
# 闭源仓库：同步整个 sdk/ 到开源 release 仓库
sdk/build/sync.sh --yes

# 开源仓库：单次按依赖顺序发布全部产品
sdk/build/release.sh --scope all

# 需要拆批时使用产品 scope；各 scope 使用独立 product tag
sdk/build/release.sh --scope aip
sdk/build/release.sh --scope cloud
sdk/build/release.sh --scope prismer
```

发布顺序：

1. `@prismer/aip-sdk` / `prismer-aip`
2. `@prismer/sdk` / `prismer` / `@prismer/mcp-server`
3. `@prismer/runtime`

Cloud SDK 依赖刚发布的 AIP release line；Runtime 最后发布，使 agent host 只面向已经可安装的协议与 Cloud client 组合。

## Registry 与凭据

| 包 | Registry |
| --- | --- |
| `@prismer/aip-sdk` | npm |
| `prismer-aip` | PyPI |
| `@prismer/runtime` | npm |
| `@prismer/sdk` | npm |
| `prismer` | PyPI |
| `@prismer/mcp-server` | npm |

发布凭据只存在于开源 release 仓库的 ignored 文件中：`.npmrc`、`.pypirc`。不要把 token 写入脚本、artifact 或 migration 文档。

## 发布前检查

```bash
npx tsx scripts/check-version-consistency.ts
sdk/build/verify.sh --scope all
sdk/build/pack.sh --scope all --clean
bash sdk/build/sandbox-verify.sh
```

并确认：

- `@prismer/runtime` 的 tarball 包含 bundled catalog fallback；
- `@prismer/sdk` 使用 `cloud` bin，不争用 Runtime 的 canonical bin；
- Python `prismer-py` 可用，legacy `prismer` 冲突诊断清晰；
- AIP TypeScript/Python conformance vectors 同时通过；
- 构建产物中不存在已退休语言或 coding-agent plugin artifact。

## 回滚

已发布 registry artifact 不做覆盖或删除。紧急回滚先把部署、npm dist-tag 或安装文档 pin 回上一已验证版本，再通过统一 `--patch` 发布新的合法 `X.Y.Z`；不能用单包后缀制造 npm/PyPI 版本漂移。不要恢复已退休的 Marketplace plugin 控制路径；coding-agent lifecycle 的唯一可靠性边界是 Runtime durable post-turn pipeline。
