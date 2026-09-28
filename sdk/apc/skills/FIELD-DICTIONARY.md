<!-- APC skill authoring 参照：命令真产物的字段字典 -->
# APC skill 真产物字段字典

> **为什么存在**：M1-d/f 探路批（env-doctor + test-runner）4 轮返工里 **2 轮死在字段名漂移**——SKILL.md 照 doc 12 的抽象词（"结构化 TierResult" / "doctor JSON"）写，agent 照着解析真产物却对不上字段名。**写任何引用这些产物的 SKILL.md 前，字段名以本文件为准**（本文件由真跑命令抓取，非文档转述；schema 变了先更新这里）。
>
> 抓取方式（可复现）：`npx tsx sdk/apc/bin/apc.ts env doctor` / `npx tsx scripts/test203/run.ts --tier=T0 --json`。

## `apc env doctor` → stdout JSON

顶层键：`envStatus` · `exitCode` · `generatedAt` · `items[]` · `summary` · `failed[]` · `undetected[]`

- `exitCode`：`0`=全绿 / `78`=env_blocked（**这是权威的 env 判据，不是自己数 items**）
- `envStatus`：`'ok'` | `'env_blocked'`
- `summary`：`{ pass, fail, skip, total }`（`total==pass+fail+skip==items.length`，一项崩不塌全轮）
- `failed[]`：失败项的 **id 字符串**数组（= 各 item 的 `item` 字段值）
- `items[]` 每项：`item`（**id，如 `toolchain.node`**）· `section`（**故障域：infra/toolchain/secrets/project**，分类按这个）· `status`（`'pass'|'fail'|'skip'`）· `label` · `detail` · `fixHint` · `strength` · `durationMs`

⚠️ 字段名是 **`item` / `section` / `status`**，不是 `name` / `category`（首版踩过）。

## `apc test`（= run.ts）`--json` → stdout JSON

顶层键：`doctor` · `envStatus` · `exitCode` · `tiers[]` · `regressions[]` · `fixed[]` · `schema` · `timestamp`

- `doctor`：内嵌一份 doctor 段（同上结构）
- `exitCode`：`0`=通过 / `1`=SUT 红（`--diff` 下=有回归）/ `78`=env_blocked
- `regressions[]` / `fixed[]`：`--diff` 下 vs baseline 的**新增红 / 转绿**（顶层聚合，跨所有 tier）
- `tiers[]` 每项（TierResult）：`tier` · `passed` · `failed` · `skipped` · `total` · **`failedNames`**（失败用例名数组）· `skippedNames` · `regressions` · `envStatus` · `durationMs`

⚠️ 字段名是 **`failedNames`**（驼峰，非 "failed names"）；`command`/`exitCode` 在**顶层**不在每个 tier 内（首版踩过）。

### ⚠️ 并行 flaky：单次 regression ≠ 真回归（2026-07-24 主会话查实）

T0 全量并发跑会偶发 flaky（资源竞争/端口/超时），**每次红的集合都不同**（探路批见 5 条、复查见 1 条 `web-rpc.test.ts`、再跑见 0 条；`web-rpc` 单独跑 10/10 绿）。baseline（26 条，均既有 ACP mock 债）**未被污染**。

⇒ **test-runner skill 的验收 oracle 不能把"单次 `apc test` 出现 regression"直接判 skill 失败**。判据应是：
- regression 命中 baseline 已记的既有红 → 非新增，正常；
- regression 是新面孔 → **单独重跑该文件**确认；单跑绿=flaky（记录不 fail skill），单跑仍红=真回归（如实 `--outcome failed` 上报，是被测栈的红不是 skill 的红）。
- flaky 的签名 = 重跑红的集合漂移；真回归的签名 = 稳定复现同一批。

## `cloud task verify-criterion <task-id> <criterion-id> --outcome <v>`

- `--outcome` 合法值**恰好四个**：`passed` | `failed` | `n/a` | `waived`（`task.ts:1374-1394`）
- 副作用 oracle：criterion 从 `pending` → 上报值，落 acceptance-view（读回确认）

## `cloud skill ack <slug> --task <taskId>` 退出码

`0`=回执落库（`im_task_logs.action='skill_ack'`）/ `3`=无 task 上下文（**产不出回执，非失败；不许 `||true` 吞掉，按 3 分流**）/ `4`=调用身份≠task assignee / `1`=其它。

## 端到端达标配方（env-doctor 2026-07-24 真跑 `ok:true` 验证过的黄金样板）

`cloud skill test <bundle> --agent <id> --json` 要拿 `ok:true`，skill.json 必须满足这些——**照 `sdk/apc/skills/env-doctor/skill.json` 抄**：

1. **命令固化进 `sampleTasks[].prompt` 本体**：到达 agent 的是 prompt，**不是 SKILL.md**（SKILL.md 不进 dispatch 上下文）。prompt 里每条命令必须是 agent 在 cwd 真能跑的形态：
   - **`apc` 不在 PATH** → 一律写 `npx tsx sdk/apc/bin/apc.ts <sub>`（不是裸 `apc`，不是 `npm run apc`）。
   - 涉 `apc env up` → **强制 `--safe`**（bare `env up` 的 docker 步 `colima start` 在非交互 dispatch 里 block 数分钟 → reaper 杀）。prompt 里点明这一点。
2. **`acceptanceCriteria` 必须机器可判 + 不可蒙混**：
   - 用 `{label,match,type:"regex",required}` 对象，**不要**纯字符串（纯字符串走大小写敏感 substring = 要求 agent 逐字复述人话 → 假阴）。
   - `match` 匹配 **agent 自然汇报里稳定出现的机器特征**（exit 码、`pass/fail/skip` 计数、字段值），**不是**要求贴原始 JSON。
   - 正则要吃**多种合法排版**（inline `pass=15` / 表格 `| pass | 16 |` / dash）——否则同样正确的工作因排版一绿一红（脆性）。参考 env-doctor count 那条：`(pass|fail|skip)\w*\s*[:=|\-]*\s*\d+|\d+\s*[|:=\-]*\s*(pass|fail|skip)`。
   - **必须自测负控**：蒙混文本（"looks fine to me"）喂 `matchAcceptanceCriteria` 要 `ok:false`；真汇报要 `ok:true`。放松到蒙混能过 = 作废。
3. **写完立即端到端验**（daemon 活着时）：`cloud skill test <bundle> --agent <id> --json` 看 `ok:true` + `taskStatus:completed`；再造蒙混 prompt 的临时 bundle 验 `ok:false`。**这是达标定义，不是可选。**

> harness 侧已修（`extractAgentReply` type 过滤 + 反向取最新 + `afterIso` 锚，只认比 prompt 发送时刻更新的 agent 回复）——authoring 不用管，但别写出依赖"首轮 poll"的假设。

## 平台字段陷阱（authoring 必读）

- **`compatibility` ≠ `scope`**：`compatibility` 是枚举，合法值 `claude-code/codex/opencode/openclaw/prismer-sdk`——**不接受 `hermes`**（写进去 422 `STD_COMPATIBILITY_INVALID`）。hermes 可用性由 `scope: common` 授予。
- **⚠️ SKILL.md frontmatter 的 `scope:` 是描述性的、代码零消费**（2026-07-24 查实：`grep fm.scope` 全仓无命中）。真正决定"谁能装这个 skill"的 install-side 角色门是 **`role_scope`**（`built-in-skill.service.ts:354/467`），当前唯一约束值 = `orchestrator-only`（只装给 orchestrator）。约定（照 built-in `memory-dream`）：**两个都写** —— `scope: common|coding` 给人读，`role_scope: orchestrator-only` 仅在该 skill 真要限制为 orchestrator-only 时加。
  - **APC coding/common skill 默认不写 `role_scope`**：common 装给所有 agent（正确）；coding 的限定靠 `platform-install` 的 agent 选择，**不是靠 frontmatter**。别以为写了 `scope: coding` 就把非 coding agent 挡在外面——那个字段没人读。若将来要"coding skill 只给 coding-role agent"的硬门，需在 `built-in-skill.service.ts` 扩 `role_scope` 值域（服务端改，不是 authoring）。
- **skill.json 无 `scope` 字段**：真实字段 = `schemaVersion/slug/name/description/category/version/license/compatibility/runtime/sampleTasks/security/provenance`。发布可见性（private/workspace/public）由 `platform-install` 的 `publishScope` 承载，不在 skill.json。
- **catalog slug 派生**：`platform-install` 后服务端 `toSlug(name,'community')` 把 slug 变成 `community-<name>`，与 bundle 目录名分叉——装载/查询按**返回的 slug**，不是 bundle 目录名。
- **双身份债**：同一 API key 在 `/api/im/me`、skills-install actor、task-event actor 可能解析成**不同 imUserId**（P0 验签债 `api-guard.validateJwt` 只解码不验签的下游症状）。task assignee 必须对齐 key 的**真** identity（task-event actor 那个），不是 me-endpoint 返回的。凡 coding-scope skill 涉 task 归属都会踩。

## 发版 5 verb 真跑 `--json` 字段字典（§0.25 抓取，供发版 skill authoring）

`apc release <verb> --json` 输出形状（真跑抓取；退出码 green/staged/blocked ⇄ 0/3/1）：

- **preflight** → `{decision, tier{tier,exitCode,envBlocked,regressions[]}, version{aligned,rootVersion,mismatches[]}, prisma{ok,stale[]}, blockers[], staged[]}`
- **db-config-sync** → `{decision, migration{exitCode,pending[],stderr}, keyDiff:{status:'skipped',reason}|{status:'computed',missing[],extra[],common}, blockers[], staged[]}`（真跑：本地 replica 217 pending、无 dump 时 keyDiff=skipped ⬜）
- **tag** → `{decision, tag, target, channel, tier{...}, approved, pushed, mirror, blockers[], notes[]}`（prod 拒时 `tier.exitCode=-1`，tag 算得出但 decision=blocked、pushed=false）
- **ota-promote** → `{decision, env, deliveryMode, k8s:{invoked,exitCode,rolledOut,output}|{skipped,reason}, desktop:{status:'not-wired',missing[],deliveryMode}, blockers[], notes[]}`（`k8s.invoked=true` 靠 `[runtime-ota]` banner 判真 spawn；桌面 not-wired=⬜；deliveryMode=line1-kill1 非 drain_respawn）
- **rollback** → `{decision, ledgerPath, plan:{ok:true,from,to,next[]}|{ok:false,reason}, approved, applied, mirrorRepointed, blockers[], notes[]}`

**真环境事实**：`/VERSION=2.2.4`（tag 算 v2.2.4）；`prisma/schema.mysql.prisma` ⇄ generated client **真 drift** → preflight 真跑落 staged（非误报，与 §0.21 一致，需 `npm run prisma:generate:all`）。

## 截图/资产 + 验收/观测 skill 字段（ui-canvas evidence + §0.33 S5b/S10 抓取）

**资产上传（ui-canvas/report-card 用）**：
- `POST /api/im/assets` 成功响应 asset id 在 **`data.id`**，不是 `data.assetId`（别处 `toAssetResponse` 用后者）。上传截图/产物一律 `data.assetId ?? data.id` 兜。
- 主题态截图：Playwright `addInitScript` 预置 `localStorage['prismer-theme']=light|dark|system`（`src/contexts/theme-context.tsx` 挂 `.dark`/`.light` 到 `<html>`），必须在页面脚本前种。目标必须是 registry 校验过的 `/ui-canvas?set=&version=&journey=&node=`；稳定锚是 `[data-testid="ui-canvas-overview"]` 或 `[data-testid="ui-canvas-viewport"]`。

**验收/观测（S5b/S10 用）**：
- `cloud task verify-criterion <task-id> <criterion-id> --outcome passed|failed|n/a|waived [--evidence <ref...>可重复 --note]`；`--evidence` 落 `criterion.evidence[]`（`taskRun:`/`asset:`/`url:`），`cloud task acceptance` 回读字段名 `evidence`；**任一 required criterion=failed → overall=failed**（别软化真红）。
- `cloud task add-criterion <taskId> --mode qualitative|quantitative|agent-self-check|manual --expectation <md> [--optional]` 返短 criterion id。criteria 存 **task metadata JSON 无专表**（仅 `im_task_criteria_templates`）。
- `cloud task create --kind work_item` → kind 存 `im_tasks.metadata.kind`（JSON），`--priority`→`metadata.priority`，`--json` 返 `data.id`。
- `scripts/debug/*`：`bundle.ts` 默认**写文件** `./debug-bundle-*.json`（打屏加 `--stdout`）；`--env=local` 走 dev admin 短路免凭据。
- **harness `dispatch_not_created`（§0.29 修后的失败态）= 活 daemon 未为本 prompt 建 run（领养/路由层），非 criteria 失败**——真判据永远是 `im_task_runs` 真行,不是 skill-test output。

### 结构化判据 checker（`type: "structured"` 的 `checker` 取值）

| checker | 真值来源 | 备注 |
| --- | --- | --- |
| `cited-evidence` | **磁盘**：每个 `path:line` 读回复核（存在/行范围/非空行/锚定命中） | 层 2 |
| `dimension-coverage` | **磁盘**：每维独占一行，答案是可复核引用或 `N/A — 理由` | 层 2；N/A 只校验长度不校验理由为真 |
| `doc-sync-obligations` | **磁盘**：从 delta 自行重算义务集与 gap 集再比对 | 层 2 |
| `json-claim` | **命令产物**：重解析 fenced JSON，钉 schema/算术/派生判定/baseline 重算/产物 mtime 新鲜度 | 层 3 |
| `declared-id-readback` | **云端真 API**：`TASK:/ASSET:/CRITERION:/META:` 声明的 id 回读比对（含存储 JS 类型） | 层 3 |
| `git-claim-readback` | **真 git 只读 plumbing**：commit 文件集/branch tip/bare 替身/`MERGE_HEAD` 仍在 | 层 3；硬拒 `.e2e-tmp/` 之外的仓库 |

> **层 2 = 复核报告关于「文件」的声称；层 3 = 复核关于「运行时副作用」的声称。**
> 共同边界：核的是**副作用存在性**不是**通道**；杀的是廉价伪造，不提供不可伪造性。
