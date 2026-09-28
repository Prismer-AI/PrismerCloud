---
name: release-tag
description: Cut a release tag behind a real tier gate and cloud approval readback. The approval, task, approved commit, and resulting tag are bound; self-approval and HEAD drift fail closed. Prod prefixes remain refused.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: release
---

# release-tag

发版打 tag（`apc/01` §2 release-tag，收口步 6）。它把**测试→上线的焊点**焊死：**没有 tier 全绿 / baseline 无新红的结构化证据，审批请求根本不创建、tag 绝不 push**。tier 门跑真 `run.ts` 读真退出码；tag 名按 `<channel>-<target>-YYYYMMDD-vX.Y.Z` 算；审批通过后 `git tag && push` 到**本地 bare mirror 替身**（真 GitLab push + pipeline 轮询 = M5）。

**什么时候用**：`release-preflight` 绿 + `release-db-config-sync` 无阻塞之后，要把一个 test 版本推上 CI。

## 承重纪律（发版 skill 的命根子，先记死）

- **prod 前缀 tag 必拒**（不变量 2 · 两人闸）。四个映射 `APP_ENV=prod` 的前缀——`k8s-prod-*` / `desktop-prod-*` / `prod-*` / `ali-k8s-prod-*`——**先于一切 git / tier 动作硬拒**，本 verb 不做任何 git 动作。**别试 prod**：真 prod 红线由 GitLab protected tags（P-1，运维配置）落地，本 skill 只护到"不替你打 prod tag"。要发 prod = 人走 M5 路径。
- **`--tier` 必须显式传，没有默认值**。`TD`（桌面冒烟）在 `apps/desktop/e2e/smoke/` 无 spec 时会自动 `skipped-with-note`（`passed:0/failed:0`），单独拿它当发版门是一道**不可能红**的空门——之前 SKILL 范例全不带 `--tier` 让 agent 照抄默认值正是这么踩的坑（`apc/12` §0.12）。**选一个会真执行断言的层**，例如 `--tier=T0,T1`；prod 前缀路径（下方触发）例外——它先于 tier 门拒绝，不需要 `--tier`。
- **tier 绿是 push 的硬前置，"绿"必须是真跑过用例**。tier 红 / `env_blocked` / **空跑**（该轮所有 tier 的 `passed+failed` 合计为 0，即一个用例都没真执行）⇒ `blocked`，审批请求不创建、tag 不 push。**不许**放松 tier、挑能绿的层、或拿一个恰好全 skip 的层骗过门。
- **审批门不可跳**。tier 绿但未审批 = `staged`（dry-run：出 tag + tier 证据，不 push）。批准路径必须同时传 `--task <taskId> --approved <approvalId>`；CLI 从 cloud 读回批件和 task，校验 `approved` / `release_tag` / task 绑定 / 非自批，且两者 metadata 的 commit SHA 必须一致。随机 token 不再能放行。
- **tag 打获批 commit，不打 HEAD**。并行工作使 HEAD 漂移也不得把未审内容带入 tag；获批 SHA 不在 repo 则 fail-closed。

## Anti-pattern（直接判红）

- ❌ **给 `--target prod` 或手拼 prod 前缀 tag** 想让 skill 打 prod。命中即 blocked，别绕。
- ❌ **tier `blocked` 时先打 tag 再补测试**。焊点就是不让这发生。
- ❌ **拿到 `staged` 就以为发版完成**。staged 是"等审批"，tag 还没 push。
- ❌ **用 `git tag` + 裸 `git push origin`** 手工绕过本 verb，跳过 tier 门和审批门。

## 工具契约（签名以此为准）

> `apc` **不在 PATH**——在仓库根用 `npx tsx sdk/apc/bin/apc.ts <sub>`。

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `npx tsx sdk/apc/bin/apc.ts release tag [--channel k8s\|desktop] [--target test\|prod] [--version X.Y.Z] --tier=<tiers> [--task <taskId> --approved <approvalId>] [--json]` | prod 人闸 → tier 门 → cloud 批件/task/commit 他证 → 把获批 SHA push 到本地 bare mirror | `0` green（pushed）· `3` staged（tier 绿待审批）· `1` blocked（tier 红 / 他证失败 / prod 拒 / push 失败）· `2` 用法错 |

`--tier` **没有默认值**（`--target prod` 路径除外——它先于 tier 门拒绝）；不传直接 usage 错 exit 2。选一个会真执行断言的层，例如 `--tier=T0,T1`——**别用 `--tier=TD`** 当唯一层：无桌面冒烟 spec 时它是空门。

`--json` 字段（**名以此为准**）：

- 顶层：`{ verb:'tag', decision, tag, target, channel, tier, approved, approvalId, taskId, commitSha, pushed, mirror, blockers:[], notes:[] }`
- `tag`：算出的 tag 名（如 `k8s-test-20260724-v2.0.7`）；`--version` 缺省读 `/VERSION`
- `tier`：`{ tier, exitCode, envBlocked, regressions, emptyRun }`（prod 拒时 `exitCode:-1`，因为压根没跑到 tier；`emptyRun:true` = 该轮所有 tier 的 `passed+failed` 合计为 0，一个用例都没真跑，即便 `exitCode` 是 0 也判 `blocked`）
- `mirror`：push 目标（默认 `.dev-stack/apc-bare-origin.git` bare 替身）

## Workflow

### 1. dry-run：算 tag + 过 tier 门（不带 `--approved`）

```bash
npx tsx sdk/apc/bin/apc.ts release tag --channel k8s --target test --tier=T0,T1 --json > /tmp/tag-dry.json; T=$?
echo "tag(dry) exit=$T"
```

- `decision:staged`（exit 3）+ tier 绿 → 拿到 `tag` 名，进审批。
- `decision:blocked`（exit 1）→ 读 `tier`/`blockers`；tier 红 / 空跑（`tier.emptyRun:true`）就停手回 bugfix，别往下走。
- 忘了 `--tier` → exit 2 用法错，不是"用了默认 TD"——没有默认值。

### 2. 审批后 push（cloud 批件 + task 绑定）

```bash
# approval 必须是 cloud 中已被另一个人批准的 release_tag 记录，并且与 task 携带同一 commit SHA
npx tsx sdk/apc/bin/apc.ts release tag --channel k8s --target test --tier=T0,T1 \
  --task "$PRISMER_TASK_ID" --approved "$APPROVAL_ID" --json > /tmp/tag.json; T=$?
echo "tag(push) exit=$T"
```

- `decision:green`（exit 0）+ `approved:true` + `pushed:true` → tag 已落 bare mirror；必须用 `git rev-parse refs/tags/<tag>^{commit}` 核验结果等于产物的 `commitSha`。

### 3. prod 一律拒（验证人闸，不是要发 prod）

```bash
npx tsx sdk/apc/bin/apc.ts release tag --channel k8s --target prod --json; echo "prod exit=$?"
# 预期：decision=blocked, exit 1, blockers 含 "prod 人闸"，无任何 git 动作
# 注意：这条命令没带 --tier ——prod 人闸先于 tier 门开火，压根不需要它
```

## Failure / 边界

- push 失败（bare mirror 不存在 / git 错误）→ `blocked` + `blockers` 含真 git stderr。bare 替身由 `apc env up --safe` 拉起。
- 本机替身：push 只到 **本地 bare mirror**，**不推 GitLab**；cloud approval/task/commit 他证已是真路径。真 GitLab push + pipeline 轮询仍是 M5（诚实 ⬜）。

## 输出契约（机器判据按这个复算，别自由发挥格式）

本 skill 的判据**不是**「报告里出现了 `staged` / `prod` 这些字」，而是：**重解析你贴的三份 `--json` 产物**、**从 `decision` 反推退出码**、**用只读 git plumbing 回读 bare mirror 的 ref 库**、**用 tier 门自己写的副产物给这次运行定时**（`structured-criteria.ts` 的 `json-claim` + `git-claim-readback`）。

先在**隔离沙箱**里搭演示（**绝不在共享工作树打 tag/push**）：

```bash
mkdir -p .e2e-tmp/apc-release-tag && git init -q --bare .e2e-tmp/apc-release-tag/mirror.git
mkdir -p .e2e-tmp/apc-release-tag/work && cd .e2e-tmp/apc-release-tag/work
git init -q -b main && echo demo > f.txt && git add f.txt && git commit -qm init
git remote add mirror "$REPO/.e2e-tmp/apc-release-tag/mirror.git"
```

> `--repo` / `--mirror` **必须传绝对路径**——verb 内部会把相对 `--repo` 再解析一次（`git -C <rel>` 又在 `cwd=<rel>` 下跑），相对路径必失败。

报告必须带下面这组行 + **三份原样 JSON**：

```
RUN-AT: <审批那次运行的 ISO-8601 墙钟时间>
STAGED-TAG: <dry-run 产物的 tag>
STAGED-PUSHED: false
STAGED-EXIT: 3
TAG-NAME: <审批产物的 tag>
TIER-EXIT: 0
TAG-EXIT: 0
PROD-TAG: <verb 算出并拒掉的 k8s-prod-… tag>
PROD-DECISION: blocked
GIT-REPO: .e2e-tmp/apc-release-tag/work
GIT-TAG: <tag> | remote: mirror | sha: <该 tag 在 mirror 上解析出的 commit sha>
GIT-REFUSED-TAG: <k8s-prod-… tag> | remote: mirror
```

紧跟着把三次 `--json` 的 stdout **一字不改**贴进三个 fenced json 块（dry-run → 审批 → prod）。

判据会判红的情况（任一）：

- 没有可解析的 fenced JSON（只有散文「tag 打好了」）；
- `STAGED-EXIT` / `TAG-EXIT` 不是从 `decision` 推出来的那个（green→0 · staged→3 · blocked→1）——**退出码是 decision 的函数，不是措辞**；
- 审批产物 `decision:green` 却 `tier.exitCode != 0` / `tier.regressions` 非空 / `blockers` 非空——**tier 绿是 push 的硬前置**；
- dry-run 产物 `approved:false` 却 `pushed:true`——**审批门被跳**；
- prod 产物不是 `blocked` + `pushed:false` + `tier.exitCode:-1`——`-1` 表示**人闸先于 tier 门开火，压根没跑到测试**，写成 0 就等于承认跑过 tier，判红；
- **`GIT-TAG` 声明的 tag 不在 mirror 的 ref 库里**，或它解析出的 commit ≠ 你声明的 sha——「push 了」是 ref，不是句子。**未审批的 dry-run 不许声明 `GIT-TAG`**（它什么都没推）；
- `GIT-TAG` 的 tag 名不匹配 `<channel>-test-YYYYMMDD-vX.Y.Z`，或它本身命中 prod 前缀；
- **`GIT-REFUSED-TAG` 竟然在 mirror 上**——那不是拒绝，是推上去了；
- `GIT-REPO` 不在 `.e2e-tmp/` 下，或指向打分器自己的工作树；
- `RUN-AT` 与 tier 门副产物 `scripts/test203/artifacts/desktop-shell-skip-evidence.txt` 的 mtime **差超过 20 分钟**——tier 门没真跑，磁盘上就没有这一刻的痕迹。

**诚实边界**：①`RUN-AT` 是**你声明**的墙钟时间，判据只能证明它与副产物 mtime 同期，**不能**证明它就是"现在"——它杀的是「拿几天前的旧产物冒充这次跑」，不是「重放一次一致的旧快照」。②tier 副产物路径是**按本 sample task 钉的 TD 层**，换 tier 必须同步换 args。③判据不证明 mirror 上那个 commit 的内容对，只证明 tag 真在、真指向你声明的 sha。

## 产出（副作用 oracle，报告里必须给）

1. **decision + 真退出码**：`green`/`staged`/`blocked` ⇄ `0`/`3`/`1`。
2. **算出的 tag 名**：`<channel>-<target>-YYYYMMDD-vX.Y.Z` 全字打印。
3. **tier 门证据**：`tier.exitCode` + regressions（tier 红时列出）——证明"没绿不 push"。
4. **push 副作用**：green 时 `pushed:true` + mirror 路径（`git ls-remote` 可核验真 tag ref）。
5. **prod 拒证据**：`--target prod` → `blocked` + exit 1 + "prod 人闸" blocker + **零 git 动作**（不是聊天里说"prod 不能发"）。

**不许**：把 `staged` 当发版完成；试图打 prod tag；绕过 verb 手工 tag/push；tier 红仍 push。

## Checklist

- [ ] 先 dry-run 拿到 tag 名 + tier 绿证据，再带 `--approved` push
- [ ] green 时确认 `pushed:true` + 记录 mirror；用 `git ls-remote` 复核 tag ref
- [ ] 演示 prod 前缀被拒（blocked/exit 1/零 git 动作），没试图绕
- [ ] tier 红 / env_blocked 时停手，没有放松 tier 或先 tag 后测

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：tag 收口（green/staged/blocked）后，把这次打 tag 的结论**直写成一张 PKF 记忆页**（pageType=`decision`，ReleaseCard 语义 apc/09 §1）——同一页既是回审批人侧的富报告，也是可召回的发版记录。经验教训另走 memory skill 的 CONSTRUCT→PLACE→WRITE，两条边并存（doc07 §B1）。这条直写是投影，不改 prod 人闸 / tier 门 / 审批门任何一步。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack release-tag --task "$PRISMER_TASK_ID"
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
