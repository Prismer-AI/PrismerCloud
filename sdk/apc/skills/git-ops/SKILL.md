---
name: git-ops
description: Close out a local coding task on the bound daemon — stage, commit, branch, merge, push via cloud git — and when a merge conflicts, STOP and escalate with the file list instead of auto-resolving. Push reaches only the bare replica; prod-triggering tags are refused.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: vcs
---

# git-ops

收口一个本地 coding task 的 git 动作——在 workdir 上 `commit` / `branch` / `merge` / `push`，并把 branch+sha 落回 task metadata（`apc/05` §1 A2 · S8）。核心纪律：**merge 冲突绝不自动解决**——停手、列出冲突文件、escalate 给人，workdir 保持现场不回滚（`apc/00` §3 不变量 6）。

**什么时候用**：一个 coding task 改完，需要把改动收口成 commit / 分支、merge 回主线、并把 provenance（branch/sha）记到 task 上。

## 承重约束（先记死）

- **`commit` 不自动 stage**：`cloud git commit` 只提交**已 staged** 的内容。你必须先自己 `git add <task-owned files>`，只 stage 本 task 拥有的文件，别把无关改动带进去。
- **单任务串行不变量**：同一 repo 同时只有一个 coding task 在飞。别假设并发安全。
- **prod tag 禁止**：四个 prod 触发前缀（`k8s-prod-*` / `desktop-prod-*` / `prod-*` / `ali-k8s-prod-*`）的 tag push 被 daemon 拒（真闸是 GitLab protected tags）。
- **push 只到 bare 替身**：remote 必须是 daemon allowlist 里的**纯名字**（默认 `origin`，本地指向 bare 替身）；URL / 带 `--` 的值一律被拒。无 `--force`。
- **provenance 写 metadata 要用 `--set-string`**：sha / branch 是字符串，用 `--set`（推断 JSON）会把全数字 sha 变成 number（40 位 sha 会被 `1.2e+39` 精度毁掉，7 位全数字 sha ≈3.7% 概率）。

## 工具契约（签名以此为准，先核后用）

`cloud git` 的 cwd **永远不由你传**——它从 `--workdir <id>` 指向的 `IMWorkdir` 行读，daemon 侧再 jail 一次。`--workspace` / `--daemon` 默认取 dispatch env（`PRISMER_WORKSPACE_ID` / `PRISMER_DAEMON_ID`）。

| 命令 | 作用 | 关键 flag |
| --- | --- | --- |
| `cloud git workdirs` | 列 workspace 里的 repo workdir（拿 `<workdirId>`） | `--workspace` `--json` |
| `cloud git commit <workdirId> -m <msg>` | 提交**已 staged** 的改动 | `-m/--message`（必填） |
| `cloud git branch <workdirId> --name <b>` | 建并切到新分支 | `--name`（必填） |
| `cloud git merge <workdirId> --source <ref>` | 把 `<ref>` merge 进当前分支（冲突→escalate，绝不自动解决） | `--source`（必填） |
| `cloud git push <workdirId> --branch <b> \| --tag <t>` | push HEAD 到分支，或 push tag（prod tag 被拒） | `--branch` 或 `--tag`（二选一）· `--remote`（allowlist 纯名字，默认 origin） |
| `cloud task meta set <task-id> --set-string k=v` | 把 provenance 写进 task metadata | `--set-string`（值恒字符串） |

- **退出码**：成功 `0`；失败非零。`--json` 下 stdout 是结构化 `{ok, op, sha?, ref?, cwd, ...}`（成功）或 `{ok:false, op, code, message, files}`（失败）。
- **`code:'conflict'`** 是冲突信号，`files[]` 是未合并文件清单——这是承重的 escalation payload。
- **权限**：`cloud task meta set` 走 metadata gate = **creator / orchestrator / admin / owner**，**assignee 不在内**。写 provenance 这一步**必须以主 agent（orchestrator/creator）身份跑**——coding agent 自写会被 403。

## Procedure

### 1. 定位 workdir

```bash
cloud git workdirs --workspace "$PRISMER_WORKSPACE_ID" --json
```

从返回里挑本 task 对应的 repo workdir id（下称 `$WD`）。

### 2. Stage 本 task 拥有的文件（自己做，commit 不代劳）

```bash
# 在 workdir 的 repo cwd 里，只 stage 本 task 改的文件
git add path/to/file-a path/to/file-b
git status --short   # 确认只 stage 了 task-owned 文件
```

### 3. Commit

```bash
cloud git commit "$WD" -m "feat(x): 一句话说清这次改动" --json
```

从 stdout 的 `sha` 字段取真 commit sha（下称 `$SHA`）。

### 4. Branch（可选，按 task 需要建 scoped 分支）

```bash
cloud git branch "$WD" --name "feat/task-$PRISMER_TASK_ID" --json
```

### 5. Merge 回主线 —— 冲突是停手信号，不是重试信号

```bash
cloud git merge "$WD" --source feat/task-xxx --json > /tmp/merge.json; M=$?
```

- `M == 0`：merge 成功，取新 HEAD sha。
- `M != 0` 且 `code == "conflict"`：**停手**。读 `files[]`——那是未合并文件清单。**不要** `git merge --abort`、不要 `git reset`、不要 `-X ours/theirs`、不要任何自动解决。把冲突文件清单原样交给人 escalate：

```
Merge conflict — NOT auto-resolved. Escalate to a human.
Conflicted files (<n>):
  <file-1>
  <file-2>
```

workdir 保持 daemon 留下的现场（`.git/MERGE_HEAD` 在、工作区有 `<<<<<<<` 标记），人可以直接进去看。冲突判据是 git 的**副作用**（未合并索引 / 进行中的 merge），不是错误文本——所以拼写错误的 ref 不会被误报成冲突。

### 6. Push（到 bare 替身；prod tag 会被拒）

```bash
# 分支：
cloud git push "$WD" --branch feat/task-xxx --json
# tag（非 prod）：
cloud git push "$WD" --tag k8s-test-20260724-v2.0.7 --json
```

- prod 触发前缀的 tag（`k8s-prod-*` 等）→ 返回 `code:'prod_tag'` 非零退出。这是对的，别绕。
- remote 只能是 allowlist 里的纯名字；默认 `origin`（本地 = bare 替身）。

### 7. 写 provenance 回 task（以主 agent 身份，用 `--set-string`）

```bash
cloud task meta set "$PRISMER_TASK_ID" \
  --set-string git.branch=feat/task-xxx \
  --set-string git.sha="$SHA"
```

**必须 `--set-string`**：`--set git.sha=1234567` 会把全数字 sha 变成 number。

## 输出契约（机器判据按这个回读，别自由发挥格式）

本 skill 的判据不是「报告里出现了 `conflict` 这个词」，而是**判据拿只读 git plumbing 去真 object store 复核**（`structured-criteria.ts` 的 `git-claim-readback`），provenance 则回读真 task 行（`declared-id-readback`）。所以报告必须带这些**可机器解析的行**：

```
GIT-REPO: .e2e-tmp/<name>/work
GIT-COMMIT: <full sha> | files: a.txt, b.txt
GIT-BRANCH: <branch> | head: <full sha>
GIT-PUSHED: <branch> | remote: origin
GIT-REFUSED-TAG: k8s-prod-<date>-v<x.y.z> | remote: origin
GIT-CONFLICT-REPO: .e2e-tmp/<name>/conflict
GIT-CONFLICT-FILES: c.txt
TASK: <task id>
META: git.sha = <full sha> | type: string
META: git.branch = <branch> | type: string
```

判据会判红的情况（任一）：

- `GIT-REPO` **不在 `.e2e-tmp/` 沙箱里**，或它解析到**打分器自己的仓库根**——共享工作树永远不许当演示仓库（判据硬拒，不看措辞）；
- `GIT-COMMIT` 的 sha **不是该仓库里的 commit 对象**；
- 该 commit 的**文件集与 `files:` 声明不等**，或包含 task 不拥有的文件——`cloud git commit` 从不自动 stage，**混进来的文件就是你 stage 的**；
- `GIT-BRANCH` 不存在、tip 与 `head:` 不符、或**不含**那个 commit；
- `GIT-PUSHED` 的 remote **不是本地 bare 替身**（网络 remote 一律红），或替身上**没有**那个分支 / sha 不一致；
- `GIT-REFUSED-TAG` **真的躺在替身上**（那就不是被拒，是被推上去了），或那个 tag 根本**不匹配 prod 触发前缀**（拒一个无害 tag 证明不了任何事）；
- 冲突仓里**没有 `MERGE_HEAD`**——`merge --abort` / `reset` / `-X ours` 恰好删掉的就是这份证据，所以「我停手并 escalate 了」不再是可自述的；
- `GIT-CONFLICT-FILES` 与 `git diff --name-only --diff-filter=U` **不等**（漏报冲突文件也红）；
- `META:` 的值与服务端存的不一致，或**存储类型不是 `string``**（`--set` 数字化在这里被逮住）。

**这些命令全是只读的**（`cat-file` / `show --name-only` / `rev-parse` / `ls-remote` / `diff --diff-filter=U` / `tag -l`）——判据本身绝不写任何仓库。

`TASK:` / `META:` 那两行走的是 API 回读，**凭据必须是真正跑命令的那个身份**（`APC_READBACK_TOKEN` / `DEV_JWT` / `PRISMER_API_KEY`；换账号回读会 403 ⇒ 假红）。凭据缺失或 API 不可达一律判红——「验不了」不算过。

## 产出（副作用 oracle，报告里必须给）

1. **真 commit sha / 真 branch ref**：取自 `cloud git commit/branch/merge` 的 `sha`/`ref` 字段（`--json`），可在 workdir 里 `git rev-parse` / `git branch` 复核。
2. **冲突态**：`code:'conflict'` + `files[]` 非空 + workdir 现场保留（`.git/MERGE_HEAD` 在、工作区含冲突标记、HEAD 未移动）——**不是**聊天里说"有冲突"。
3. **prod tag 被拒**：`cloud git push --tag <prod-prefix>` 非零退出 + `code:'prod_tag'`。
4. **provenance 落库**：`cloud task meta set --set-string` 后 task `metadata.git.sha` 是**字符串**（读回确认，全数字 sha 也不被数字化）。

**不许**：merge 冲突后自动 `abort`/`reset`/`-X`；断言聊天文本而非 git 副作用；用 `--set` 写 sha；push 到非 allowlist remote 或用 `--force`；以 assignee 身份写 metadata（会 403）。

## 诚实边界

- **判据核的是 git 的副作用，不是走了哪条通道**：commit 是 `cloud git commit` 还是（无 workdir-bound daemon 时）scratch repo 里的 `git commit` 产生的，object store 里长得一样。所以判据**不能**证明「走了 `cloud git`」，只能证明「这些 git 事实真存在」。同理 `GIT-REFUSED-TAG` 证明的是**拒绝的效果**（tag 不在替身上），不是 daemon 侧那道闸真被触发。
- 「push 不带 `--force`」**判据核不到**（remote 上看不出上一次 tip），仍是文本判据——不得声称已闭合。
- `cloud git` 需要 workdir 绑定的 daemon 在线。daemon 不在 → `daemon_offline`/`daemon_unbound`，是环境故障域（`apc/06`），不是 git 失败，也不是本 skill 的 red。
- `commit` 不 stage、jail 是词法+realpath（照抄 `resolveWorkdirCwd` 同款限制）——这些是平台约束，本 skill 不绕。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack git-ops --task "$PRISMER_TASK_ID"
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
