---
name: release-rollback
description: Roll a release back for real when post-deploy regression goes red — apc release rollback flips the current version to pulled and the last good version back to current in the release ledger, and (with --mirror) repoints the bare mirror ref. Behind an approval gate; with no previous good version it BLOCKS instead of spinning green. green(0) applied · staged(3) plan awaiting approval · blocked(1) nothing to roll back to.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: release
---

# release-rollback

上线后回归红时的**真回滚**（`apc/01` §2 release-rollback，收口步 10）。它落两个真副作用：

1. **release 账本回退**：把当前 `current` 版本翻 `pulled`、上一好版本翻回 `current`（真写 JSON ledger，可读回核验）。
2. **版本指针回退**（给了 `--mirror`）：把 bare mirror 的 `refs/heads/release-current` 重指到上一好 tag 的 commit（真 git 副作用，`git ls-remote` 可核验）。

**什么时候用**：`release-verify`（部署后回归）红了，需要把 fleet 退回上一个好版本。回滚后应建 bug task 回 bugfix 入口。

## 承重纪律（发版 skill 的命根子，先记死）

- **审批门不可跳**。未审批 = `staged`（出回滚计划 dry-run，不执行）。本机替身以 `--approved <token>` 非空为门（真 approvalId 服务端校验 = M5）。审批人看到的是**回滚计划**（from→to 版本 + 影响面），不是"agent 说要回滚了"。
- **无上一好版本 → `blocked`，绝不空转返绿**。账本只有一条、或更早的都已 `pulled` ⇒ 无从回滚 ⇒ blocked（exit 1）。这是本 verb 的**负控注入点**：一个"回滚"skill 若在没东西可回滚时也返绿，就是开卷考试。
- **prod 不做**。本 skill 是 test 环境的回滚；prod 回滚走人 + M5 路径。

## Anti-pattern（直接判红）

- ❌ **无上一好版本时硬造一个"回滚成功"**。planRollback `ok:false` 就是 blocked，别放松。
- ❌ **拿到 `staged`（计划）就以为已回滚**。staged 是"等审批"，账本还没改。
- ❌ **手工改 ledger JSON / `git update-ref`** 绕过 verb 的审批门和 plan 计算。

## 工具契约（签名以此为准）

> `apc` **不在 PATH**——在仓库根用 `npx tsx sdk/apc/bin/apc.ts <sub>`。

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `npx tsx sdk/apc/bin/apc.ts release rollback [--ledger <path>] [--mirror <bare>] [--approved <token>] [--json]` | 算回滚计划 → 审批门 → 写账本回退（+ 可选 mirror ref 重指） | `0` green（applied）· `3` staged（计划待审批）· `1` blocked（无上一好版本） |

`--json` 字段（**名以此为准**）：

- 顶层：`{ verb:'rollback', decision, ledgerPath, plan, approved, applied, mirrorRepointed, blockers:[], notes:[] }`
- `plan`：`{ ok:true, from:{version,tag,status}, to:{version,tag,status}, next:[...] }` **或** `{ ok:false, reason }`
- ledger 条目形状：`{ version, tag, status:'current'|'pulled'|'superseded', ts }`（`current` 唯一）

## Workflow

### 1. 备好 release 账本（本机替身）

账本记录发过的版本序列，当前版本 `status:'current'`。本机替身用一份 JSON（真 release-status 行的替身）：

```bash
cat > /tmp/apc-rollback-ledger.json <<'JSON'
[
  { "version": "2.0.5", "tag": "k8s-test-20260720-v2.0.5", "status": "superseded", "ts": "2026-07-20T00:00:00Z" },
  { "version": "2.0.6", "tag": "k8s-test-20260722-v2.0.6", "status": "superseded", "ts": "2026-07-22T00:00:00Z" },
  { "version": "2.0.7", "tag": "k8s-test-20260724-v2.0.7", "status": "current",    "ts": "2026-07-24T00:00:00Z" }
]
JSON
```

### 2. dry-run：出回滚计划（不带 `--approved`）

```bash
npx tsx sdk/apc/bin/apc.ts release rollback --ledger /tmp/apc-rollback-ledger.json --json > /tmp/rb-dry.json; R=$?
echo "rollback(dry) exit=$R"
# 预期：decision=staged (exit 3)，plan.ok=true，plan.from=2.0.7 → plan.to=2.0.6
```

### 3. 审批后执行（带 `--approved`）—— 真写账本

```bash
npx tsx sdk/apc/bin/apc.ts release rollback --ledger /tmp/apc-rollback-ledger.json --approved "$APPROVAL_TOKEN" --json > /tmp/rb.json; R=$?
echo "rollback(apply) exit=$R"
# 预期：decision=green (exit 0)，applied=true；读回 ledger：2.0.7→pulled，2.0.6→current
```

给了 `--mirror <bare>` 还会把 `refs/heads/release-current` 重指到 `to.tag`（`git ls-remote` 可核）。

### 4. 负控：无上一好版本 → blocked

```bash
echo '[{"version":"2.0.7","tag":"k8s-test-20260724-v2.0.7","status":"current","ts":"2026-07-24T00:00:00Z"}]' > /tmp/rb-single.json
npx tsx sdk/apc/bin/apc.ts release rollback --ledger /tmp/rb-single.json --json; echo "single exit=$?"
# 预期：decision=blocked (exit 1)，plan.ok=false，reason="无上一好版本可回退"
```

## Failure / 边界

- 账本无 `current` / 无上一好版本 → `blocked`（真拒，非空转）。
- 本机替身：账本 = 本地 JSON（站位真 release-status 行）；mirror ref = bare 替身；审批 = `--approved` 非空。真 OTA `action:'rollback'`/`pulled` + 真 manifest 指针回退 + 服务端 approvalId = M5。
- 回滚后建 bug task 回 bugfix 入口——真 task 创建 = M5 / S10 observability（本 skill 只在 `notes` 提示）。

## 输出契约（机器判据按这个复算，别自由发挥格式）

本 skill 的判据**不是**「报告里出现了 `pulled` / `current` 这些字」，而是：**重解析你贴的三份 `--json` 产物**、**从 `decision` 反推退出码**、并把 apply 产物的 `plan.next` 与**磁盘上那份账本文件逐字段深比**（`json-claim` 的 `fileEquals` + `freshArtifacts`）。

**路径是钉死的**（判据要回读它）：

```bash
mkdir -p .e2e-tmp/apc-release-rollback
# 三条账本：2.0.5/2.0.6 superseded、2.0.7 current
$EDITOR .e2e-tmp/apc-release-rollback/ledger.json
# 负控用另一份，单条 current
$EDITOR .e2e-tmp/apc-release-rollback/ledger-single.json
```

报告必须带这组行 + **三份原样 JSON**（dry-run → apply → 负控）：

```
RUN-AT: <apply 那次运行的 ISO-8601 墙钟时间>
PLAN-FROM: 2.0.7
PLAN-TO: 2.0.6
STAGED-APPLIED: false
STAGED-EXIT: 3
APPLIED: true
ROLLED-TO: 2.0.6
APPLY-EXIT: 0
NEG-DECISION: blocked
NEG-PLAN-OK: false
NEG-EXIT: 1
```

判据会判红的情况（任一）：

- 没有可解析的 fenced JSON；
- 任一 `*-EXIT` 不是从对应 `decision` 推出来的（green→0 · staged→3 · blocked→1）；
- dry-run 产物 `approved:false` 却 `applied:true`——**审批门被跳**；
- **apply 产物的 `plan.next` 与 `.e2e-tmp/apc-release-rollback/ledger.json` 磁盘内容不深等**——`applied:true` 而账本没翻，就是宣称了一个没发生的副作用；
- `RUN-AT` 与那份账本文件的 mtime 差超过 20 分钟——**拿上一次 apply 的旧账本冒充这次**；
- 负控产物不是 `plan.ok:false` + `blocked` + `applied:false` + `mirrorRepointed:false` + 有 `plan.reason`——**没有上一好版本时必须红，不许空转返绿**。

> ⚠️ **别重复 apply**：第 3 步之后再跑一次 apply 会把账本二次翻转，你贴的产物就不再等于磁盘上的账本，判据会红——这不是判据的毛病，是「报告描述的那次写入已经被后一次覆盖」的如实结论。负控**必须**用另一份 `ledger-single.json`。

**诚实边界**：判据能证明「账本现在正是产物声称写成的样子、且写入时间与你声明的运行同期」，**不能**证明这次写入是 verb 干的而不是你手工 `cat >` 出来的——没有哪个本地产物是不可伪造的。它杀的是廉价伪造（编计划、叙述已 apply、拿旧账本顶包）。真 release 状态行（服务端账本）落地 = M5。

## 产出（副作用 oracle，报告里必须给）

1. **decision + 真退出码**：`green`/`staged`/`blocked` ⇄ `0`/`3`/`1`。
2. **回滚计划**：`plan.from.version → plan.to.version`（ok:true 时），或 `plan.reason`（ok:false）。
3. **账本真副作用**（green 时）：读回 ledger 确认 `current`→`pulled`、上一好版本→`current`；不是聊天里说"已回滚"。
4. **负控证据**：单条账本 → `blocked` + `plan.ok:false` + reason，**证明没东西可回滚时它会红**。
5. **mirror 重指**（给了 `--mirror`）：`mirrorRepointed:true` + `git ls-remote` 核验 `release-current` 指向 `to.tag`。

**不许**：无上一好版本时硬返绿；把 staged 计划当已回滚；手改 ledger/ref 绕审批。

## Checklist

- [ ] dry-run 拿到 plan（from→to）+ staged，再带 `--approved` 执行
- [ ] green 后读回 ledger 确认 current→pulled、上一好版本→current
- [ ] 跑了单条账本负控，确认 blocked + plan.ok:false（回滚 skill 的命根子）
- [ ] 给了 `--mirror` 时用 `git ls-remote` 核验 release-current 重指

## 审批门（doc03 §1）

本 skill 收口 doc03 §1 审批点 **「回滚」**（release-rollback 执行前）。dry-run 出计划，**真回滚前必须建人审批并停手**：

1. **出示 dry-run 证据**（审批人看到的）：回滚目标版本（`plan.from.version → plan.to.version`）+ 影响面（`plan.next[]`，01 §2）。无上一好版本 → `blocked`（`plan.ok:false`），无审批可建。
2. **建真 cloud 审批**（真路径 = `human-approval` built-in skill 的 CLI）——把上面证据装进请求：

   ```bash
   cloud approval request-human --task-id "$PRISMER_TASK_ID" \
     --action "回滚 <plan.from.version> → <plan.to.version>（test）" \
     --context "部署后回归红；回滚计划 from→to + 影响面见 dry-run 回执" \
     --risk "OTA 账本翻 pulled/current + manifest 指针回退；回滚后建 bug task 回 bugfix 入口"
   ```

   返回 `approvalId`；**建完即停手本轮**（human-approval 铁律：平台在人裁决后重派）。
3. **block**：未 approve 前 `staged`（exit 3），账本不改；无上一好版本 → `blocked`（负控注入点，绝不空转返绿）。
4. **post-approval = M5 real-remote**：真 OTA `action:'rollback'`/`pulled` + 真 manifest 指针回退 + 服务端校验 `approvalId`，属 **M5 real-remote**，本机替身（本地 JSON ledger + bare mirror）不触真远端、不冒充已回滚。

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：回滚收口（green/staged/blocked）后，把这次回滚的结论**直写成一张 PKF 记忆页**（pageType=`decision`，ReleaseCard 语义 apc/09 §1）——同一页既是回审批人侧的富报告，也是可召回的事故/发版记录。回滚后的事故根因复盘另走 memory skill 的 CONSTRUCT→PLACE→WRITE，两条边并存（doc07 §B1）。这条直写是账本真副作用之外的一次投影。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致（回滚天然带 `contradicts`——指向被 `pulled` 版本当初的发版决策页；无上一好版本（blocked）时如实写 `plan.ok=false` 与 reason，**绝不**在页里粉饰成"已回滚"）；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack release-rollback --task "$PRISMER_TASK_ID"
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
