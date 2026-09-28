---
name: release-db-config-sync
description: Compute the remote DB migration + Nacos config diff before a test release — apc release db-config-sync really spawns sync-test-migrations.ts --dry-run (never a stub) and diffs Nacos key dumps, stopping at the write boundary. green(0) no diff · staged(3) pending migrations/missing keys await approval · blocked(1) real script failed. Diff only, never writes the remote.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: release
---

# release-db-config-sync

发版前算清**远端 DB 迁移**与 **Nacos 配置**的差异（`apc/01` §2 db-config-sync，收口步 3/4）。这是治 **R3**（"DB sync 走桩、`writes:0` 换马甲冒充已同步"）的真机制：它**真 spawn** `scripts/ops/sync-test-migrations.ts --dry-run`——真解析凭证、真连库、真算迁移计划——退出码由真脚本决定，**绝不注入桩**。Nacos 侧对两份 key dump 算真差集。**dry-run 永不写库、不写真 Nacos**——止于写入边界，真 apply 走审批后的远端路径。

**什么时候用**：`release-preflight` 绿之后、`release-tag` 之前，确认远端 test 环境的迁移账本和配置 key 都对齐了才发版。

## 承重纪律（先记死）

- **事故红线（memory / `apc/01` 开头）**：prod 曾因 Navicat 结构 diff 绕过迁移账本灌库出事故（丢回填 / 半应用）。**一切 DB sync 必须走账本，diff 工具只做审计不做写入。** 本 skill 就是账本路径的收口——**绝不教你拿 Navicat / 裸 SQL 去改远端**。
- **本 skill 只 dry-run**：算差异、出计划、停在写入边界。真 apply（把 pending 迁移打进 test RDS、把缺失 key 补进 Nacos）是**审批后**的远端动作（本机替身口径下 = M5），不由本 skill 执行。
- **别把桩当验过**：本机替身下 Nacos fetch 未接线时，key-diff 会**诚实标 `skipped`**（真路径 = M5）。看到 `skipped` 就照实报 ⬜，别写成"配置已核对无差异"。

## Anti-pattern（直接判红）

- ❌ **迁移 dry-run 报 `blocked`（真脚本失败 / 缺凭证）时，改用别的路径灌库**绕过去。真脚本 exit 非 0 = 连不上 / 缺 `REMOTE_MYSQL_*`，是要修的前置，不是要绕的门。
- ❌ **有 pending 迁移（`staged`）就当没事发版**。`staged`（exit 3）意味着远端账本落后，未审批 apply 前不该 tag。
- ❌ **key-diff `skipped` 说成"已核对"**。没给 dump 文件就是没比，别冒充。

## 工具契约（签名以此为准）

> `apc` **不在 PATH**——在仓库根用 `npx tsx sdk/apc/bin/apc.ts <sub>`。

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `npx tsx sdk/apc/bin/apc.ts release db-config-sync [--ref <dump>] [--cur <dump>] [--json]` | 真跑 `sync-test-migrations.ts --dry-run`（本机替身指向本地 replica，永不写远端）+ 对两份 Nacos dump 算 key 差集 | `0` green（无差异）· `3` staged（有 pending / 缺 key）· `1` blocked（真脚本失败 / 缺凭证） |

`--json` 字段（**名以此为准**）：

- 顶层：`{ verb:'db-config-sync', decision, migration, keyDiff, blockers:[], staged:[] }`
- `migration`：`{ exitCode, pending:[<sql文件名>], stderr }`（`exitCode` 是真脚本退出码；`pending` 是真脚本 fs 枚举 ⇄ `_migrations` 账本比对得出的待同步迁移）
- `keyDiff`：`{ status:'skipped', reason }` **或** `{ status:'computed', missing:[], extra:[], common }`（`missing` = 目标环境缺的 key，需补齐；`extra` 不阻塞，仅报告）

## Workflow

### 1. 跑迁移 dry-run + key-diff

```bash
# 只算迁移（不给 dump 时 key-diff 诚实 skipped）：
npx tsx sdk/apc/bin/apc.ts release db-config-sync --json > /tmp/dbsync.json; D=$?
echo "db-config-sync exit=$D"
```

要一并算 Nacos key-diff，先用 `dump-nacos-namespace.ts` 产出两份 dump（基准 / 目标现状），再传 `--ref`/`--cur`：

```bash
npx tsx sdk/apc/bin/apc.ts release db-config-sync --ref /tmp/nacos-ref.env --cur /tmp/nacos-cur.env --json
```

### 2. 按 decision 分流

| decision | exit | 含义 | 你要做的 |
| --- | --- | --- | --- |
| `green` | `0` | 无 pending 迁移 + key 无缺失 | 放行 |
| `staged` | `3` | 有 pending 迁移 / 目标环境缺 key | 列出 `migration.pending` + `keyDiff.missing`；**审批后**走远端 apply（`sync-test-migrations.ts` 去 `--dry-run` / Nacos 补 key），不得抢跑 |
| `blocked` | `1` | 真脚本 exit 非 0（连库失败 / 缺 `REMOTE_MYSQL_*`） | 读 `migration.stderr`，修凭证/连通性——这是前置，别绕开账本自己灌库 |

## Failure / 边界

- 缺 `REMOTE_MYSQL_*` → 真脚本 `throw` → 本 verb `blocked`。这是**真行为非桩**（正是"调真脚本"的证据），如实报，修凭证后重跑。
- 本机 MySQL 挂（colima 损坏）时对不可达 replica 跑，真脚本会 fs 枚举全量 pending——**真脚本真行为**，但"真实差异（部分已 applied）"需活 replica，属 M5 边界。
- key-diff 未给 dump → `skipped`（真 Nacos fetch = M5）。**诚实标 ⬜，不冒充已验。**

## 输出契约（机器判据按这个复算，别自由发挥格式）

本 skill 的判据**不是**「报告里出现了 `pending` / `nacos` 这些字」，而是：**重解析你贴的两份 `--json` 产物**、**从 `decision` 反推退出码**、并把 `migration.pending[]` 里的**每一个文件名逐个 stat 回 `src/im/sql/`**（`structured-criteria.ts` 的 `json-claim`）。

本 sample task 钉的是**两次真跑**：一次接通本地 replica（站位远端 test RDS），一次**抽掉 `REMOTE_MYSQL_*` 的负控**——负控是这条用例自带的、必须变红的注入点。

```bash
# 1) 连通跑（本地 replica 站位远端 test RDS）
REMOTE_MYSQL_HOST=127.0.0.1 REMOTE_MYSQL_PORT=3307 REMOTE_MYSQL_USER=… REMOTE_MYSQL_PASSWORD=… \
REMOTE_MYSQL_DATABASE=prismer_cloud npx tsx sdk/apc/bin/apc.ts release db-config-sync --json
# 2) 负控：不带 REMOTE_MYSQL_*，真脚本 throw
npx tsx sdk/apc/bin/apc.ts release db-config-sync --json
```

报告必须带这组行 + **两份原样 JSON**：

```
MIGRATION-EXIT: 0
KEYDIFF: <keyDiff.status —— skipped | computed>
RUN-EXIT: <decision green→0 | staged→3 | blocked→1>
NEG-MIGRATION-EXIT: 1
NEG-DECISION: blocked
NEG-RUN-EXIT: 1
```

判据会判红的情况（任一）：

- 没有可解析的 fenced JSON；
- `MIGRATION-EXIT` / `KEYDIFF` 与产物字段不一致——**把 skipped 的 key-diff 说成"已核对"正是这条抓的**；
- `RUN-EXIT` 不是从 `decision` 推出来的那个；
- **`migration.pending[]` 里任何一个文件名在 `src/im/sql/` 下不存在**——这份清单是真脚本枚举 `src/im/sql/*.sql` ⇄ 目标库 `_migrations` 账本算出来的，没真跑就得**编**两百多个文件名，编一个就红；
- **把 `pending[]` 截断成「…还有 200 条」**——判据读的是数组，截断即缺项；
- 负控产物不是 `migration.exitCode != 0` + `decision:blocked` + `blockers` 非空 + `pending` **空**——一个能扛过自己凭证故障的迁移计划是编的；
- `decision:green` 却 `pending` 非空 / `decision:staged` 却 `staged[]` 空。

**诚实边界**：①判据**证明不了** `pending[]` 的语义正确（哪些真该 apply），只证明每个名字是磁盘上真存在的迁移文件 + 计数自洽。②「未写远端 DB / 真 Nacos」这一条**没有结构化事实可断**（dry-run 的本质就是没有副作用），因此仍保留为**关键词判据**——它是本 skill 唯一还靠措辞的判据，写清楚这点比假装它有牙重要。③接不通 replica 时本 sample task 无法演示，此时判据红是**如实结论**（不是 SUT 红，是本机环境没给到前置）。

## 产出（副作用 oracle，报告里必须给）

1. **decision + 真退出码**：`green`/`staged`/`blocked` ⇄ `0`/`3`/`1`（读回核对）。
2. **迁移计划**：`migration.exitCode` + `pending[]`（列真 sql 文件名，非"若干条"）。
3. **key-diff**：`computed` 时给 `missing`/`extra` 计数；`skipped` 时**原样报 skipped + reason**。
4. **是否停在 dry-run 边界**：明确本 skill **没有**写远端库 / 没有写真 Nacos。

**不许**：把桩 / `skipped` 当已验；有 pending 迁移还发版；绕过账本用裸 SQL / Navicat 灌远端。

## Checklist

- [ ] 跑了 `apc release db-config-sync --json`，记录 `decision` + 真退出码
- [ ] 列出了 `migration.pending` 的真文件名（有则 staged，审批后才 apply）
- [ ] key-diff 是 computed 就给 missing/extra 计数，是 skipped 就照实标 ⬜
- [ ] 明确本步只 dry-run，没写远端；blocked 时报了真 stderr 而非绕过

## 审批门（doc03 §1）

本 skill 收口 doc03 §1 审批点 **「远端 DB/配置写」**（触发：db-config-sync 应用前）。dry-run 停在写入边界，**真 apply 前必须建人审批并停手**：

1. **出示 dry-run 证据**（审批人看到的，非 agent 自述）：迁移 dry-run 计划（`migration.pending[]` 真 sql 文件名）+ Nacos key-diff 报告（`keyDiff.missing/extra`；`skipped` 就照实标 ⬜）。
2. **建真 cloud 审批**（真路径 = `human-approval` built-in skill 的 CLI）——把上面证据装进请求：

   ```bash
   cloud approval request-human --task-id "$PRISMER_TASK_ID" \
     --action "apply 远端迁移 + 补 Nacos key（test）" \
     --context "pending 迁移: <migration.pending>；key-diff missing: <keyDiff.missing>（dry-run 计划见回执）" \
     --risk "写 test RDS 账本 + Nacos；红线：绕账本灌库曾致 prod 半应用事故（apc/01 开头）"
   ```

   返回 `approvalId`；**建完即停手本轮**（human-approval 铁律：平台在人裁决后重派，别同轮往下执行）。
3. **block**：未 approve 前 `staged`（exit 3），dry-run 边界不写远端。
4. **post-approval = M5 real-remote**：真 apply（`sync-test-migrations.ts` 去 `--dry-run` 打进 test RDS / Nacos 补 key）+ 服务端校验 `approvalId` 已 approved，属 **M5 real-remote**，本机替身不执行、不冒充已 apply。

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：db-config-sync 出 decision 后，把这次远端迁移/配置差异的结论**直写成一张 PKF 记忆页**（pageType=`decision`，ReleaseCard 语义 apc/09 §1）——同一页既是回审批人侧的富报告，也是可召回的发版记录。Navicat 绕账本这类事故教训另走 memory skill 的 CONSTRUCT→PLACE→WRITE，两条边并存（doc07 §B1）。这条直写是 dry-run 边界之外的一次投影，不写远端。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致（key-diff `skipped` 就在页里照实标 ⬜、别写成"已核对无差异"）；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack release-db-config-sync --task "$PRISMER_TASK_ID"
```

**按退出码分流**（这条命令的退出码是承重信息，禁止用 `||` 兜底、`; true`、
`set +e` 或重定向把它抹掉）：

| exit | 含义 | 你要做的 |
| --- | --- | --- |
| `0` | 回执已落库（`im_task_logs.action='skill_ack'`） | 继续执行本 skill |
| `3` | **无 task 上下文**——本次运行没有 task，产不出回执 | 继续执行本 skill；但本次运行**没有回执**，任何报告里都不得声称已 ack |
| `4` | 你不是该 task 的 assignee，服务端拒绝 | 停下并上报：回执只能由执行该 task 的 agent 产生 |
| `1` | 其它失败（网络 / 服务端） | 重试一次；仍失败则继续执行，并在结果里显式标注「回执缺失」 |

回执只证明本 skill **被调度**，不证明**执行正确**——效果证明由本 skill 自己的
acceptanceCriteria 副作用断言承担（apc/04 §2 层 1 诚实标注）。

<!-- /APC-ACK:v1 -->
