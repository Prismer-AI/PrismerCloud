---
name: bug-reproduce
description: Turn a known bug into a tight, red-capable reproducer, then prove the reproducer locks that bug with a reversal negative control (reintroduce the bug → reproducer must go red again). Use at the start of a bugfix, before theorizing about the cause.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: diagnosis
---

# bug-reproduce

把一个**已知 bug** 变成**紧、可变红**的复现器（失败测试 / 脚本），然后用**反转负控**证明这个复现器真的锁住了那个 bug——**不是恰好绿着**（`apc/05` §2 S1 · `apc/12` bug-reproduce 行；纪律移植自 built-in `diagnosing-bugs` 的 Phase 1 复现 loop）。

**什么时候用**：一个 bugfix task 开工的**第一步**——在读代码建假设之前。`diagnosing-bugs` 的铁律：没有一个能对**这个** bug 变红的信号，再多盯代码也没用。本 skill 只补 `diagnosing-bugs` 缺的那一环：**负控——把 fix 撤掉/把 bug 注入回去，复现器必须变红**。

铁律：一个复现器只有走完 **RED → GREEN → 反转 RED** 才算数。**只到 GREEN 不算**——一个无论 bug 在不在都绿的"复现器"是开卷考试，不是复现（`apc/12` §0 负控纪律）。

## 复现器四判据（照 diagnosing-bugs Phase 1 完成标准）

一个复现器必须是：

| 判据 | 含义 |
| --- | --- |
| **red-capable** | 它驱动**真正的 bug 代码路径**、断言**用户描述的确切症状**——能对这个 bug 变红，修好后变绿。不是"没崩就算过"。 |
| **deterministic** | 同一输入每次同一结论（非确定 bug：钉时间/种 RNG/隔离 FS，把复现率拉到可调试）。 |
| **fast** | 秒级不是分钟级。 |
| **agent-runnable** | 你能无人值守跑；一条命令（脚本/测试/curl）能贴出调用 + 输出。 |

## Procedure

### 1. 钉环境 + 建复现器（RED）

在一个干净的、确定性的 workspace 里写出**最小失败测试/脚本**，然后跑它，**看它变红**：

```bash
d=.e2e-tmp/apc/bug-reproduce && rm -rf "$d" && mkdir -p "$d"    # repo-relative，已在 .gitignore
# …在 "$d" 里写 subject + repro…
node "$d"/repro.mjs; echo "exit=$?"     # 或 apc test --tier=<T> --json / pytest / go test …
```

**隔离场景的临时目录用 repo-relative 的 `.e2e-tmp/…`，不要用 `mktemp -d`**：复现器**本身就是证据**，判据在你跑完之后把你引用的 `path:line` **读回磁盘**——`/tmp` 从仓库根不可解析、收尾 `rm -rf` 更是把唯一产物销毁（test204「证据销毁反 pattern」的同一个坑）。本地真仓库里的 bug 则直接在真路径上做。

- 复现器必须断言**用户描述的症状本身**（`clamp(-5,0,10)` 应得 0 而非 -5），不是"没抛异常"。
- 记下**确切症状**：断言消息、错误、非零退出码。这就是 RED。
- 真仓库里的 bug：复现命令可以是选层的 `apc test --tier=<T> --json`（读 `exitCode`：`0` 绿 · `1` SUT 红 · `78` env_blocked）。**env_blocked 不是复现——是环境红，先 `apc env doctor`**。

### 2. 最小 fix（GREEN）

打**最小**修复（只改让复现器变绿所需的那一点），重跑复现器，**看它变绿**（`exit=0`）。**不顺手清理别的**——本步只证明"这个 fix 让这个复现器绿"。

### 3. 反转负控（承重——RED again）

**这是本 skill 的命根子。** 把 fix 撤掉——把 bug 注入回去，**重跑同一条复现器命令**：

```bash
# 首选：直接编辑源文件，把 buggy 的那一行 body 原样写回去
node "$d"/repro.mjs; echo "exit=$?"     # 必须再次 RED（非零退出 / AssertionError）
```

**反转手法只有一个首选：直接编辑源文件把 bug 写回去。**

> ⚠️ **`git stash` / `git checkout` 在共享工作树里是有害指令，默认不许用。** 本仓库常态是**多个并发 session 共用一个 working tree**、几百个未提交改动同时在飞——`git stash` 会把**别人正在做的改动**一起卷走，`git checkout <file>` 会**丢掉**别人对同一文件的未提交编辑。这类操作不可逆地毁坏他人工作，代价远大于它省下的那一次手工编辑。
>
> 只有在你**独占**这个 working tree（自己的 worktree / 一次性容器）**且已确认 `git status` 干净**时，`git stash` 才是等价手法；否则一律手工反转。反转的**语义**（把 bug 放回去）才是承重的，用什么手法不是。

- **复现器必须再次变红。** 这证明它**红在这个 bug 上**，不是恒绿的摆设。
- **若撤掉 fix 后复现器仍然绿 → 复现器是假的，任务失败**（`apc/12` bug-reproduce 负控）。不许放松断言让它"看起来锁住了"。

### 4. 恢复 + 收尾（**不要删证据**）

把 fix 放回去，确认最后一次 **GREEN**（`exit=0`）。**复现器留在盘上别删**——判据是在你跑完之后才读盘复核你引用的行的，`rm -rf` 掉复现器 = 自毁唯一产物。

### 5. 写 BugfixCard（`repro` 阶段）

复现 + 反转都拿到证据后，把这一阶段落成一张 **BugfixCard**——`repro` 是 BugfixCard 的**首阶段**，段锚是 `<h2 id="stage-repro">`（`src/lib/apc-cards/card-profile.ts` 的 `BUGFIX_STAGES[0].name = 'repro'`）。

> ⚠️ **段名是 `repro`，不是 `reproduce`。** `docs/apc/12` 那行写的 `stage-reproduce` 在实现里**不存在**，写成它会被 `card-stage-invalid` / `card-stage-section-missing` 挡下。以代码为准。

- `card` frontmatter：`{ kind: 'bugfix', stage: 'repro', taskId: <真 task id>, schemaRev: 1 }`——`taskId` 必填，**无 task 上下文时不要伪造绑定**：如实报告"本轮没有 task，卡未写"，别硬造一张。
- `repro` 阶段的证据要求是 `asset`：段内要有 `prismer://…/asset/<id>` 链接，挂**复现器本体 + RED 输出 + 反转 RED 输出**三份证据（先 `cloud asset upload` 拿 id）。
- 段序检查只对**已过阶段**要求证据，当前阶段进行中不强求；但首阶段段锚 `stage-repro` 必须在场。

## 输出契约（机器判据按这个复验，别自由发挥格式）

旧判据全是关键词匹配（"报告里出现过 `node`/`assert`/`exit=1`/`revert` 这些词"）——**一篇一条命令都没跑过的报告照样满分**。现在多一条判据（`cited-evidence`）把复现器**读回磁盘**复核：复现器不存在、引用的行不存在、或者引用的行根本不含被测符号，当场判红。

**① 复现器锚点声明**（一行；符号会被复核确实出现在该文件里）：

```
CHANGE-POINT: <被测符号> @ <复现器/被测文件的 repo-relative 路径>
```

**② RED→GREEN→反转 RED 相位表**（markdown 表，**首列是 `path:line`**）：每相位一行，首列是该相位**转在哪一行**上。判据要求 **≥3 行**带可复核引用，且 **≥2 条引用所在的那一行真的含被测符号**。

```
| path:line | phase | command | exit | observed |
| --- | --- | --- | --- | --- |
| .e2e-tmp/apc/bug-reproduce/repro.mjs:3 | 1 RED (buggy) | node .e2e-tmp/apc/bug-reproduce/repro.mjs | 1 | AssertionError: clamp must respect lower bound |
| .e2e-tmp/apc/bug-reproduce/clamp.mjs:1 | 2 GREEN (fixed) | node .e2e-tmp/apc/bug-reproduce/repro.mjs | 0 | REPRO OK |
| .e2e-tmp/apc/bug-reproduce/repro.mjs:3 | 3 REVERSAL RED | node .e2e-tmp/apc/bug-reproduce/repro.mjs | 1 | AssertionError: clamp must respect lower bound |
```

**行号照抄 `cat -n` / `rg -n` 的真实输出**，不许凭印象写。引用必须 **repo-root-relative**（绝对路径与 `/tmp/...` 一律判红——这也是上面要求复现器落 `.e2e-tmp/` 且不删的原因）。产物存**可引用的扩展名**：引用解析器只认固定后缀集（`ts/tsx/js/jsx/mjs/cjs/prisma/sql/md/json/sh/py/yml/yaml`），存成 `.txt`/`.log` 的引用不会被解析。

## 产出（副作用 oracle，报告里必须给）

1. **复现器命令**：你**真跑过**的那一条（`node repro.mjs` / `apc test --tier=…` / pytest…），可贴调用。
2. **初始 RED**：buggy 代码下复现器失败（AssertionError + 非零退出码）。
3. **fix 后 GREEN**：`exit=0`。
4. **反转 RED**（承重）：把 bug 注入回去后复现器**再次变红**（非零退出码）——这是"锁住了"的唯一证明。
5. **复现器本体留在盘上**（repo-relative 路径），锚点声明 + 相位表的每条引用都能读回。
6.（有 task 上下文时）**BugfixCard `stage-repro` 段**：三份证据 asset link 挂上，卡可回读。

**不许**：只报到 GREEN 就收工（没有反转 = 没证明锁住）；放松断言让恒绿脚本冒充复现器；把 `env_blocked`（exit 78）当作 bug 复现上报；凭推理宣称"应该能复现"而没真跑；**跑完 `rm -rf` 掉复现器**（证据必须留到判据读盘之后）；**在共享工作树里用 `git stash`/`git checkout` 做反转**（会卷走别人的未提交改动）。

## 诚实边界

- **本 skill 不保证任何 bug 都能建出紧复现器**：跨进程时序、真机才暴露、非确定性极低复现率的 bug，可能只能拉高复现率而非稳定复现（`diagnosing-bugs` Phase 1）。建不出就**显式停手说清楚**、列出试过什么、要人给可复现环境/捕获产物——**不许**无复现器就跳去建假设。
- **反转负控证明的是"复现器红在这个 bug 上"，不是"这个 fix 是最终正解"**——正解由后续 fix + 评审 + test-runner 兜。
- **共享工作树是常态**：本仓库经常多个 session 同时在同一个 working tree 上飞着几百个未提交改动。因此反转 fix **默认手工编辑源文件**；`git stash`/`git checkout` 只在你确认独占该工作树、且 `git status` 干净时才等价可用。这不是洁癖——stash 卷走别人的改动是不可逆的破坏。
- **BugfixCard 的段名以实现为准（`repro`）**：`docs/apc/12` 里写的 `stage-reproduce` 是文档漂移，代码 `src/lib/apc-cards/card-profile.ts` 的 BugfixCard 首阶段叫 `repro`。无 `PRISMER_TASK_ID` 时 `card.taskId` 无法合法填写——**如实报告"卡未写"**，不要伪造一个绑定去凑一张卡。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack bug-reproduce --task "$PRISMER_TASK_ID"
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
