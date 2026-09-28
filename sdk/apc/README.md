# `sdk/apc/` — Auto Prismer Cloud 自动化开发工具链

> 命名与落点裁决：[[apc/00-INDEX]] §2.45 / §2.5 · 实施状态：[[apc/11-impl-tracker]]

## 本目录是什么

**只放"自动化开发工具链"——只有开发者 / agent 在开发循环里跑的东西。**

## ⚠️ 依赖方向铁律（不可违反）

```
sdk/apc/  ──(可以读)──▶  src/lib/ 的纯函数库
   ▲
   └── src/**  绝对禁止 import sdk/apc/**
```

产品代码依赖开发工具是架构错误。判定法则：**"这段逻辑会被 `src/` 的生产路径调用吗？"**
会 → 落 `src/lib/`（或其它正常位置）；只有工具链自己跑 → 落这里。

历史教训：上一轮把卡校验器放在 `sdk/prismer-cloud/autocloud/cards/`，再让
`src/im/services/memory-card-gate.service.ts` 反向 import——目录一删就全仓编译断裂。

## 当前状态（2026-09-13；状态核实见 [[apc/24-post-freeze-analysis-and-implementation-spec]]、[[apc/25-cross-review-ledger]]）

| 产出 | 里程碑 | 状态 |
| --- | --- | --- |
| `env/`：manifest 四段 · doctor · up · fingerprint | M1-a | **代码已落，typecheck 仍阻断**（见下） |
| `bin/apc.ts`（`npm run apc` 已恢复） | M1-a | **已落**（wire env/test/skills/release 四族，见下） |
| `cli/`：test 编排包装、发版 5 verb | M1-b · M3-a | **部分已落**（5 个 verb 已接线；`release-verify` 尚不存在；独立 typecheck 当前未通过） |
| `cli/inject-ack.ts` · `cli/ack-receipts.ts` · `cli/bundle-guard.ts`（层1 调用回执基座） | M1-c | **已落**（见下；⚠️ `apc skills ack-receipts` 生产者接线仍缺，见 doc23 §2.2 M3） |
| `cli/platform-install.ts`（catalog 私域导入 + 装平台方 workspace agent） | M1-e | **已落**（见下） |
| `skills/<slug>/`：专项 21 个目录 / 18 个标准 `skill.json` bundle（SS-01 格式，**不进** `built-in-skills/`；平台方 workspace 专属） | M1-d/f | **目录已落；三目录尚无 `skill.json`，ack 也未全部接入** |
| `harness/`：截图 harness（`ui-screenshot.ts`）+ ReportCard 生成器（`report-card.ts`）+ 卡扫描 helper（`card-scan.ts`） | M2-b · M3-c · M4 | **已落**（见下） |
| repo `scripts/ui-canvas-evidence.ts`：产品 registry deep link → task screenshot + ReportCard；产品侧 runner 不反向塞进 SDK | M4 | **已落** |

### `env/`（M1-a）

```bash
npm run apc -- env doctor        # 只读判定 · stdout 纯 JSON · exit 0 / 78(env_blocked)
npm run apc -- env up            # 幂等修复（凭据/签名 key 不代办）· exit 0 / 1
npm run apc -- env fingerprint   # 环境指纹（机器等价性证明）
npx tsc --noEmit -p sdk/apc/tsconfig.json   # 本目录的 tsc 门（根 tsconfig exclude 了 sdk/）
npx vitest run sdk/apc                       # 本目录的测试门
```

### `cli/` — ack 回执基座（M1-c）+ platform-install（M1-e）

```bash
# 注入层1 调用回执纪律块（幂等；拒绝 sdk/prismer-cloud/built-in-skills/ 下的目录）
npm run apc -- skills inject-ack sdk/apc/skills/git-ops [--json]

# 读 im_task_logs 回执行，判定某 skill 这次 run 里是否真被调度
APC_CLOUD_BASE_URL=http://127.0.0.1:3000 \
  npm run apc -- skills ack-receipts <taskId> --expect git-ops,test-runner --json

# catalog 私域导入 + 逐 agent 装到平台方 workspace（IMAgentSkill 一行/agent）
npm run apc -- skills platform-install sdk/apc/skills/git-ops \
  --workspace <workspaceId> --agent <agentIMUserId> --agent <agentIMUserId> --json

# 真栈端到端（需要本机 cloud:3000 + MySQL:3307；oracle 全取 DB 行）
APC_API_KEY=sk-prismer-live-… npx tsx sdk/apc/cli/__tests__/real-stack.e2e.ts
```

| 文件 | 职责 |
| --- | --- |
| `cli/bundle-guard.ts` | **built-in 守卫**（apc/00 §2.4）：任何落在 `sdk/prismer-cloud/built-in-skills/` 内的目录一律 fail-closed 拒绝——ack 是平台方运营纪律，不下发 39 个通用 built-in。守卫在任何 fs 写 / HTTP 调用**之前**跑 |
| `cli/inject-ack.ts` | 把 canonical 纪律块注入 SKILL.md 尾部（`<!-- APC-ACK:v1 -->` 起止标记界定，原地替换 ⇒ 幂等零 diff）。块把 `cloud skill ack` 的 **4 个退出码逐条分流**，`exit 3`（无 task 上下文）明写「本次没有回执」——注入 `\|\| true` 是错的（apc/11 §0.7），生成器自带 fail-closed 扫描拦这类写法 |
| `cli/ack-receipts.ts` | 回执读取 / 校验。走**既有** `GET /api/im/tasks/:id` → `logs[].action='skill_ack'`，不新建服务端能力。`--expect` 缺失即 exit 1 |
| `cli/platform-install.ts` | `readBundle`/`validateBundle`/`buildSkillCreateBody`（复用 runtime bundle 库）→ `POST /api/im/skills`（私域 `publishScope='workspace'`）→ `POST /api/im/agents/:agentId/skills`。公域行（marketplace）fail-closed 中止 |

**环境变量**：`APC_CLOUD_BASE_URL`（默认 `http://127.0.0.1:3000`——本机优先，00 §3 不变量 4）·
`APC_API_KEY`（缺省回落 SDK 的 `PRISMER_API_KEY` → `~/.prismer/config.toml`）。

⚠️ **`--agent` 要的是 agent 的 IMUser id**（`im_users.id`），不是 `GET /api/im/agents` 响应里的
`agentId` 字段（那是 IMAgent 行 id）；IMUser id 在同一响应的 `userId` 字段。传错会被
`canManageAgentSkills`（`src/im/api/agents.ts:1146`）判 403。

| 文件 | 职责 |
| --- | --- |
| `env/types.ts` | 三态（pass/fail/**skip=未检测**）· `envStatus` · `ENV_BLOCKED_EXIT=78` |
| `env/probes.ts` | 协议级探针：MySQL 握手+查询 · Redis RESP PING · Nacos HTTP readiness · kind API server；`writeStdout` 等 flush |
| `env/manifest.ts` | 四段清单（infra / 工具链 / 密钥·配置 / 工程态）。**pin 不硬编码**，全部读 canonical 源（`Dockerfile` / `image-pin.yaml` / `package-lock.json` / `/VERSION`） |
| `env/doctor.ts` | 逐项 try/catch + 超时 → 收敛 fail；`env_blocked` 物化 |
| `env/up.ts` | 每步先跑 manifest 的 **guard 项**，pass 即 skip ⇒ 幂等；包装 `dev-stack.sh` / `dev-loop.sh` / `db-migrate.sh` / `prisma:generate:all` / `npm ci`，不重造 |
| `env/fingerprint.ts` | **复用** `scripts/test204/lib/{manifest,machine-gate,env-preflight}`，不重写 |

**承重接线**：`scripts/test203/run.ts:175` 已经把 `sdk/apc/env/doctor.ts` 写进
`EXTERNAL_DOCTOR_CANDIDATES`，跑 `npx tsx <path>` 后 `parseExternalDoctor(stdout)`。
所以 doctor 的 **stdout 必须是纯 JSON**（日志走 stderr），且 item id/label 必须让
`mysql` / `redis` / `cloud` 三个子串匹配得上（run.ts:234 `TIER_ENV_REQUIRES`），
否则 T3/T4 恒 `env_blocked`。守这条的用例：`env/__tests__/run-ts-contract.test.ts`。

**bare-repo 替身**落 `.dev-stack/apc-bare-origin.git`（已 gitignore），由 `env up` 幂等建。

## 落在别处的专项产出（一并登记，便于一处找全）

| 产出 | 落点 | 为什么不在这里 |
| --- | --- | --- |
| 卡 profile 校验器 + 证据核验器 | `src/lib/apc-cards/` | dispatch 门（生产路径）消费 |
| 卡扫描器 | `src/lib/apc-card-scan.ts` | scheduler / watchdog 消费 |
| 卡派发门 seam | `src/im/services/memory-card-gate.service.ts` | 平台 hook 原位 |
| 卡 watchdog | `src/im/services/apc-watchdog.service.ts` | 平台定时任务原位 |
| gated-actions / rollout / S11 hook / 迁移 SQL | `src/im`、`src/app`、`src/im/sql` | 层规则 + 既有 canonical 路径 |
| ui-kit registry / 分片 | `src/app/ui-kit/` | route 即产物 |
