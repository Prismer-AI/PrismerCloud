---
name: releasing-test
description: Use when 把任何批次的改动发到 Prismer 测试环境（test.docbrew.cn / APP_ENV=test），或听到「发测试 / 发 test / 上测试环境 / deploy test / 打 ali-k8s-test tag」。涉及 develop 部署、test 迁移通道、runner 节流时必读。
---

# 发测试环境（releasing-test）

## 铁律

**develop 是测试环境的唯一常规通道；`ali-k8s-test-*` tag 是紧急通道。**
违反字面规则就是违反规则本意——不存在「这次情况特殊」。

## 门槛顺序（逐步过，任何一步红则停；跳步必须记录理由，无理由跳步=违纪）

1. **本地门 = CI check 阶段四件套**（2026-09-04 教训：`npm run check` 只覆盖前两件，本地绿≠CI 绿）：
   - `npx eslint . --max-warnings 3591`（**warnings 棘轮**，随债清偿下调；新代码零新警告）
   - `npx tsc --noEmit` 0 错
   - `npm run test:sandbox:node`（node:test sandbox 套件）
   - `npm run acs:e2e-smoke:dry-run`
   - 加跑 `npm run test:unit`（vitest 根套件）与本批自带的新测试
2. **分支纪律硬门（三条断言，逐条贴命令输出，不满足不得进步骤 3）**：
   - 断言 A：`git fetch origin` 后 `git rev-parse develop origin/develop` 两值相等（本地 develop 不滞后）。⚠️ 本地 develop 检出于**宿主工作树** `/Users/prismer/workspace/pcrefactor/prismercloud`——本工作树不能 checkout develop，须在宿主目录 `git pull --ff-only`
   - 断言 B：**基点必须在 develop 第一父线上**（= 从 develop 切出，不是从旧 feature 线续接）。命令：`git rev-list --first-parent origin/develop | grep -qx "$(git merge-base <工作分支> origin/develop)"` 出口 0 才合格。2026-09-07 owner 裁决：拓扑形状就是规范面，**撤销**此前的「内容等价」豁免——tree 无差也不行（实证：avatar 波基点 4bc4b4293 在第二父线=不合格；样例 merge823 第二波基点 9f82c85e3 是第一父线 merge 节点=合格）。不合格 → 从 origin/develop 新切分支，把未并 commits cherry-pick 过去（见下节「切出」）
   - 断言 C：`git rev-list --count origin/develop..<工作分支>` 输出 = 本批预期 commit 数（防止把并行在飞/不明内容夹带进 MR）
3. **迁移前置**：比对 `src/im/sql/` 与 test 账本。有 pending → 走下方迁移通道，**先迁后发**；无 → 汇报里显式写「本批无迁移」。
4. **MR**：feature → develop。描述必含四件，缺一件不 merge：
   - ①分组清单（每组一行：组名 / 内容 / 关键 SHA）
   - ②post-merge ops（迁移是否已上 test；是否需 prisma regen）
   - ③桌面影响面（共享 `src/app/workspace/**` 改动 + 桌面重建义务）
   - ④既有红归属（known-red 测试列明，不许混进本批）
   - merge API 需带 `sha=<源分支 HEAD>`（项目开了防漂移校验）
5. **merge**：MR 合并 → develop push 自动触发 `ali_k8s_deploy_test`（check 阶段全量跑）。**禁止为快直打 tag**。合并成功后**立即**执行本地 develop 同步（不是下次发版的起点动作）：宿主工作树 `/Users/prismer/workspace/pcrefactor/prismercloud` 里 `git fetch origin && git merge --ff-only origin/develop`，贴 `git rev-parse develop origin/develop` 双值相等输出。⚠️ 2026-09-07 违例记录：连续两轮只操作远端 develop、本地 develop 滞后一个 merge 才被发现——本地/远端视图收敛是每次 merge 的收尾义务。
6. **节流**：列全部 running/pending pipelines，只留目标链，其余取消（含 feature push / MR head 派生）。
7. **冒烟 + 留证**：test.docbrew.cn 200 + 本批功能面抽查；raw 证据（管线快照 / 迁移 trace / 保护操作响应）落 `/tmp/<release-name>/` 并在汇报中引用。

## 分支生命周期（owner 定规：分支形状是验收面）

**规范最小单元形状**（样例 `9f82c85e3 → 51eeb3ad8`，2026-08-27 merge823 波）：

```
*   <merge> Merge branch 'feature/X' into 'develop'
|\
| * 7±3 个主题聚焦 commits（test+fix/feat 混排，一波一个主题）
|/
*   <上一个 merge 节点>   ← develop 是一条 merge 直线
```

- **切出**：同一产品主线只维护一个长期 feature/work 分支（CLAUDE.md 分支纪律），**后续修复追加到同一分支、同一 MR 线**，不得为每个修复新建分支名。每波发版前把长期分支**同步到 develop 第一父线**：`scripts/ops/prismer-branch-discipline.sh sync <长期分支>`（ff develop → rebase 长期分支；基点=新 develop tip）。样例 merge823 连续两波=同一分支名，第二波同步到第一波 merge 节点（9f82c85e3，第一父线）后继续——不是新建分支。新分支名只用于**新主题主线**。⚠️ 2026-09-07 违例记录：auth 503 修复为绕开并行会话占用，新开 feature/auth-hydration-503 + 临时 worktree cherry-pick——违反单长期分支纪律（内容经 MR !165 合法入 develop 不追回；教训：并行占用→等安静 sync 长期分支，不另立门户）。
- **多写入者纪律**：并行会话占用同一 worktree/分支时，rebase/sync 类操作必须等其安静；修复类改动**修完立即原子提交**，sync 时机由控制器协调。
- **合入后**：长期分支继续承载下一波——下一波开始前先 sync 到新 develop tip；**载具型 `fix/*`（迁移/热修）用完必删**（解除 API 保护 → 删远端 → 删本地）。无 sync 的连续同名 merge 是僵尸信号（merge 次数应=波次数，每波前都有 sync）。
- **收尾五件事**（每次 merge 后立即做，不留到下次）：①宿主工作树 ff 本地 develop；②工作分支与 develop 的关系收敛（下一波基点=新 develop tip）；③删本轮载具分支；④清本轮产生的孤儿 worktree（`git worktree list` 逐个核对）与 lint-staged stash；⑤切回工作分支确认 `git status` clean（并行会话的在飞文件只列不碰）。

## test 迁移通道（本地不可达 PolarDB）

- 本地直连 test 库被白名单拒（`reading initial communication packet` 断连）——不要在本地跑 sync。
- 通道：`fix/<name>-test-migration` 分支（指向同内容）→ **先** API 加保护（Maintainers/40）→ **后** push / API 建管线。顺序反了管线拿不到受保护 NACOS 变量，须取消重建。
- 管线内 manual 双闸：`test_migration_preflight`（dry-run，核对 pending 清单与预期一致）→ `test_migration_apply`。
- PolarDB 雷区：无 `INFORMATION_SCHEMA.CHECK_CONSTRAINTS`。写迁移自问「PolarDB 上成立吗」（`scripts/ops/README-test-migration-pitfalls.md`）。

## 紧急通道（唯一例外）

仅当 owner 原话授权走紧急通道：tag `ali-k8s-test-YYYYMMDD-v<X.Y.Z>`（X.Y.Z = `cat /VERSION`，同版本重发加 `-rN`），打在 **develop merge 后的 commit** 上。迁移照常前置、节流照常执行、**事后必须补 develop/MR 正规化**。汇报引用 owner 授权原文。
**注意：tag 管线不跑 check 阶段**（`$CI_COMMIT_TAG → when: never`）——紧急通道绕过的不只是可见性，还有 eslint 棘轮/t0/runtime 全部质量门（2026-09-04 实测：tag 通道放行的内容在 develop 通道 check 阶段 6 红 + 14 warnings 超棘轮）。事后正规化 MR 会把这些全数暴露，欠的检查终归要还。

## 合理化反驳表（2026-09-04 真实违纪沉淀：直打 tag 绕过 develop/MR）

| 借口 | 现实 |
|---|---|
| 「CLAUDE.md 表里 tag 也是发版路径」 | 表里 tag 行是紧急/受控通道；`ali_k8s_deploy_test` 的 develop 规则才是常规。 |
| 「用户说发，我就发」 | 用户授权的是发版动作，不是豁免流程；拿授权当豁免=越权。 |
| 「管线绿了=发版成功」 | 管线绿只是构建部署绿；develop/MR/可见性是发版义务的一部分。tag 管线绿更弱——它连 check 阶段都没跑。 |
| 「迁移我走了受控通道，流程就没问题」 | 迁移通道与发版通道独立记账，一个合规抵不了另一个越权。 |
| 「MR 描述义务太重，先发后补」 | 描述义务是 owner 的审计面；缺了它这次发版不可审计。 |
| 「tag 不动共享分支，更轻」 | 「轻」正是它被定为紧急通道的原因——绕过了所有人的可见性。 |
| 「本地 npm run check 绿了」 | 本地门 ≠ CI check 门：CI 还跑 sandbox node 套件、acs dry-run、t0 三包、runtime 套件与 warnings 棘轮。本地必须跑等价四件套。 |

## Runtime / SDK 变更的双通道发版（cloud deploy ≠ runtime 通道）

波次含 `sdk/prismer/**`（daemon/runtime 源）变更时，**cloud 部署不携带 runtime**——daemon 拉的是签名 bundle（OTA）。两条通道独立记账：

| 通道 | 触发 | 产物 | 覆盖 |
|---|---|---|---|
| cloud | develop merge → `ali_k8s_deploy_test` | 容器镜像 | Next.js + in-process IM |
| runtime | tag `runtime-test-YYYYMMDD-vX.Y.Z` → `pack_runtime_bundle` | 签名 bundle 上传 + `im_runtime_releases` 行（**status=draft**） | daemon/agent pod OTA |

- **`ali-k8s-test-*` tag 不触发 pack_runtime_bundle**（CI `only:` 清单实证）——ACK cloud 发版与 runtime 打包是两个 tag 轴。
- pack 之后还有一道 **HUMAN gate**：`promote_test_runtime_release`（manual，需 `RUNTIME_RELEASE_APPROVAL_ID`，artifact 来自 pack）——draft 对在跑 fleet 零影响，promote 才是生效点。**无 owner 原话授权不得代点/代建 tag**。
- 判据：`git diff $(git merge-base <分支> origin/develop) origin/develop --stat -- sdk/prismer/src` 非空 = 有未走 runtime 通道的 daemon 变更（cloud 已发新、daemon 仍旧 = 版本倾斜；本项目缺 protocolVersion 协商，见 daemon version skew 教训）。
- sandbox 镜像：`build_sandbox_image` manual 挂 `ali-k8s-test/prod` tag——**仅当波次动了镜像内容**（native floor / 系统工具；JS 插件模块不进 image fingerprint）才手动点。
- 桌面：共享 `src/app/workspace/**` / AppProvider 改动 → renderer 重建义务（`npm run dev:desktop:renderer`）；桌面 shell OTA 是独立 `desktop-test-*` tag 轴，本仓不发。
- 发版汇报必须显式回答四问：①本波有无 runtime 源变更 ②是否需要 pack+promote（谁授权 promote）③sandbox 镜像是否重建 ④桌面重建义务。

## 侧通道操作 runbook（2026-09-07 实操沉淀——检查清单不等于操作手册，逐条照做）

### Runtime promote（pack 之后的 HUMAN 门）

- **变量传递的正路**：`POST /projects/:id/pipeline` JSON body 带 `variables:[{key,value}]` 建新管线（pipeline 级变量）→ 等 pack 成功 → `POST /jobs/:id/play` 点 promote（继承管线变量）。**不要再手点 UI**——UI 里忘了填变量就白烧一次 job。
- **API 坑**：`play` 只对 manual 状态有效；failed job 再 play = `400 Unplayable Job`；`retry` 不带新变量。form-urlencoded 的 `variables[][key]` 不会被接受（job 起来但变量空，`test -n` 秒败）——只用 JSON body。
- **approval-id 语义**：`RUNTIME_RELEASE_APPROVAL_ID` 是自由格式审计串（任意非空有意义标识），记录在 promote 动作上；不是某个注册表 id。
- **幂等**：pack 脚本对同 identity 的既有 draft 行是 no-op（不重传不降级）——重开管线无副作用。
- **证据**：promote 成功后 im_runtime_releases 行 status=ga；daemon 通过 `/api/runtime/update/bundle/:version` OTA 拉取。
- **审批链全自动（2026-09-07 实测闭环，G1 同构）**：`runtime_rollout_approval` CI job（fix/* 手动）在 ci-home 上一步做完：铸 admin 身份（`tanwenxuan@ceresman.com`，Nacos test JWT_SECRET + 公网端点 DATABASE_URL 重拼）→ **锚点 work_item 任务**（审批必须挂 conversationId/taskId；工作区三级解析：显式 > 名下首个 > 新建 ops-anchor team）→ POST /api/im/approvals（category=ota_rollout + metadata.target 四字段：channel/version/sha256/storageKey，`buildContentAddressedRuntimeStorageKey` 计算）→ POST decision approve（决定物化，comment 留痕 owner 授权）→ DELETE 锚点任务 → 下载 pack artifact（JOB-TOKEN，job id 指 pack 成功那次）→ `publish-daemon-runtime-release.ts --promote-existing --status=ga --approval-id=<id>`（前置双 prisma generate；`resolve_daemon_release_database_url` 锚点给 DB）。id 全程 shell 变量 + 0600 文件，不出 job 不进 artifact（安全复审要求）。
- **回归**：`test_api_regression` CI job 同法：铸 session JWT（`mintSessionJwt` 全量 claim，test-identity 最小 JWT 会被 apiGuard 拒）→ POST /api/keys 建一次性 key → `test-all-apis --env test` → DELETE 吊销。curl 全部 `--http1.1`（CI→test 域 HTTP/2 流 PROTOCOL_ERROR 断连，实测）。

### Sandbox 镜像两段式（base → floor，都是 manual）

- **两段依赖**：`build_sandbox_base_image`（tag `sandbox-image-base-v<N>`）产出 `SANDBOX_BASE_IMAGE=repo@sha256:<digest>`（job 日志/`base.env` artifact）；`build_sandbox_image`（tag `sandbox-image-floor-v<N>`）**无 needs**，必须把该 digest 作为**管线变量**传入（v29/v30 历史即如此）。
- **正路**：拿最新 base 的 digest（历史 base job trace 里 `SANDBOX_BASE_IMAGE=` 行）→ `POST /pipeline` ref=`sandbox-image-floor-v<N>` + variables[SANDBOX_BASE_IMAGE] → play。
- **判据**：`git log --since=<上次 floor 构建日> -- infra/sandbox-image/` 非空 = 冻结镜像落后于 image 源，需新 floor。
- **成功后必做**：`image-pin.yaml` canonical 抬升（`sandbox:v<N>`→`v<N+1>`）commit 走 develop；否则 `verify_sandbox_image` preflight 会在下一波 deploy 拦下「pin 指向不存在的镜像」（delayed ImagePullBackOff 防护）。

### Desktop 侧通道

- `desktop-test-pack-YYYYMMDD-vX.Y.Z` tag **默认是 CI dry-run**；真发布要触发时带**受保护/手动变量** `DESKTOP_TEST_REAL_PUBLISH=1`（内部测试可再加 `DESKTOP_TEST_SKIP_NOTARIZE=1`）。app 版本取 `/VERSION`，与触发 tag 无关。
- 前置：macOS 签名 runner（「Desktop client for mac os」）必须 online——离线时 tag 管线会挂死在签名 job。

## 陷阱清单（2026-09-04 首跑实录）

- **CI-only 测试差异**：t0 runner 会把 test Nacos 配置拉进 `process.env`（如 ZHIPU_MODEL）——依赖 env 的测试必须显式管理并双向断言，否则本地绿 CI 红。
- **时间依赖 fixture**：硬编码 `expiresAt`/绝对日期的测试会隔夜老化（4783 绿→4808 红即此因）；fixture 一律相对时间。
- **同毫秒竞态**：`ORDER BY <ts> DESC LIMIT 1` 无 tie-break 在快机器上必现 flaky——加 `rowid DESC`。
- **并行写入震荡**：修复期间文件可能被并行会话覆盖（未提交的修复被 commit 覆盖丢失）——**修完立即原子提交**，提交前 `git status` 逐文件核对。
- **lint-staged 会动文件**：commit 钩子跑 eslint --fix/prettier——提交后需重验关键测试再 merge。

## 2026-09-08 增补（mention-bugfix 发版实录）

- **merge 前必须跑完本地四件套**（本次违例：合了才补跑，CI check 成了第一道门而非最后防线）。四件套 = `npx eslint . --max-warnings <ratchet>` + `npx tsc --noEmit` + `npm run test:sandbox:node` + `npm run acs:e2e-smoke:dry-run` + `npm run test:unit`。**第五件（按改动面）**：动了 `sdk/cloud/catalog/**` 或 skill 内容/ops 脚本，必须加跑 `npx vitest run scripts/__tests__/`（catalog-source-contract 等钉 sha256 清单的 T0 合同面在 vitest 根套件之外——2026-09-08 实证：pkf-writing 内容变更漏跑，check_t0 拦下重走一轮）。
- **宿主树拓扑漂移陷阱**：跑「宿主 ff develop」前先 `git -C <宿主> branch --show-current`。2026-09-08 实况：宿主检出的是 `release/v2.2.55`，本地 **已无 develop 分支引用**（`git rev-parse develop` 未知修订）——盲跑 runbook 的 `merge --ff-only origin/develop` 把 release 分支快进了（已 `reset --keep <原值>` 复位，untracked 无损）。本地无 develop 引用时该义务即作废：origin/develop 是唯一真相，**绝不 ff 当前碰巧检出的分支**。
- **glab 实操定案**：`glab mr create --source-branch X --target-branch develop --title … --description …`；merge 必须 `glab mr merge <n> --sha "$(glab api projects/:id/merge_requests/<n> | jq -r .sha)" --yes`（防漂移校验）；节流 `glab api -X POST projects/:id/pipelines/<id>/cancel`；cli 在 `/opt/homebrew/bin/glab`。
- **搭载提交归属**：长期分支上并行会话的 commit（如 config-delivery d58899f59）不 reset 不另立分支，随 MR 搭载，但 MR 描述必须按 SHA 显式归属+标注其后续在飞；断言 C 的「预期 commit 数」按分支实际数声明。
- **搭载 daemon 源 = runtime 四问必答**：cloud MR 若搭载 `sdk/prismer/src` 变更，cloud deploy 后 daemon fleet 仍旧 bundle（无 protocolVersion 协商的版本倾斜加深的既有状态）——pack+promote 是 HUMAN 门，无 owner 原话授权不得代点，只能在汇报里显式提问。
- **⚠️ 2026-09-08 违例记录（断言 C 被披露代替）**：mention-bugfix 发版时数出 2 commit（预期 1），没有停下核对/等并行会话确认，而是把搭载 commit（config-delivery d58899f59，含 daemon 源）写进 MR 描述就合了——owner 质询「工作树还有改动在飞你发了个什么版」定性违规。**规则钉死：count 不符 = 红灯，唯一正确动作是停 + 核对每个非本批 commit 的完成度（其会话是否声明 done、其自带测试是否在 CI 覆盖面内）；「在 MR 里披露归属」是违规后的补救记录，不是放行条件。**事後补验证（sdk 85/85 + acp 5/5 绿、在飞文件未进镜像）只说明侥幸无害，不改变违规本身。

## 红旗（出现即停，回到门槛顺序）

- 想不经过 develop merge 就上 test
- 想先 push `fix/*` 再补保护
- 想开省略四件义务的 MR，或 merge 无人审的空描述 MR
- 「用户在等」「内容已经验证过了」——压力不是豁免
- 未核对保护 tag 清单含 `ali-k8s-test-*` 就打 tag

## 归宿

源头 = `sdk/apc/skills/releasing-test/SKILL.md`（2026-09-07 归入 apc，随仓库版本控制）；`.claude/skills/` 为 agent 运行时安装副本，改源头后同步复制。
