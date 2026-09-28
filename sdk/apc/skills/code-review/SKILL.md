---
name: code-review
description: Review a diff against its acceptance criteria in four segments (convention adherence, bug scan, historical-context regressions, test-coverage gaps) as a NON-implementing agent. Findings are sorted by severity, each with file:line + a failure scenario. A planted defect must be caught; a clean diff must not be over-reported.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: review
---

# code-review

对一个 **diff + 验收标准**做**四段评审**，产出按严重度排序的 findings（每条带 `file:line` + 失败场景），把 `/review` 的纪律移植到任意 coding agent（`apc/05` §2 S5 · `apc/12` code-review 行）。

**什么时候用**：一个 coding task 改完、进 review 门时，需要由**非实施者**独立审这份 diff。

## 评审独立性（第一铁律，P2-17）

**评审必须由非实施 agent 执行**——实施者不自评自的 diff，与 no-self-approval 同精神（`apc/05` §2 评审独立性）。服务端也有牙：`code-review` 工件若 `reviewerId === task.assigneeId` 直接 403（`task-review-artifact.service.ts:126` `forbidden_implementer_self_review`）。

开审**第一步**先自证独立：

```bash
git log --format='%an <%ae> %H' <base>..<head>    # 被审提交的作者
# 断言：作者 ∉ {你自己}。若你就是作者 → 停手，报告"不能自评"，让另一个 agent 审。
```

## 四段评审（缺一段不算完）

移植自 `/review` 的分段纪律——每段独立扫一个维度，产出 findings 再合并按严重度排序：

| 段 | 扫什么 | 怎么做 | 典型 finding |
| --- | --- | --- | --- |
| **1. 规约符合** | diff 是否违反 CLAUDE.md / 既有约定 | 读根 + 相关目录的 CLAUDE.md，逐条对 diff | 用了被禁的 pattern、破坏 layer rules |
| **2. bug 浅扫** | 只看 diff 本身的明显 bug | 读 `git diff`，聚焦大 bug（空/边界/错误分支/资源泄漏/并发），**不纠 lint/类型/格式**（CI 会管） | off-by-one、未处理的 null、错误吞异常 |
| **3. 历史上下文** | 结合被改代码的历史看回归 | `git blame` / `git log -p` 被改的行，看这段代码为何这么写、这次改会不会破坏原意图 | 改动撤销了一个之前修 bug 的提交、重新引入已知回归 |
| **4. 测试覆盖缺口** | 改动引入的行为有没有测试护 | `rg` 找对应测试文件、看新增/改动路径是否被断言 | 新分支零测试、负控缺失、断言放松 |

**只标真问题，不纠鸡毛**（`/review` 纪律）：预存 bug、非本次改动行、CI 会抓的（lint/类型/格式/import）、senior 不会提的吹毛求疵——都不进 findings。这是**避免虚报**的纪律，直接对应负控"干净 diff 不虚报"。

## Procedure

### 1. 独立性自证（见上）— 不过则停手

### 2. 取 diff + 验收标准

```bash
git diff <base>..<head> > /tmp/review.diff        # 或对 working tree: git diff
cloud task acceptance "$PRISMER_TASK_ID"           # 读该 task 的验收标准（可选，若挂 task）
```

### 3. 四段逐段扫，每段产 findings

每条 finding 的形状（缺一项不算数）：

```
{ severity: blocker|major|minor,
  segment: convention|bug|history|coverage,
  file: "src/foo.ts", line: 42,
  finding: "<一句话说清是什么问题>",
  failureScenario: "<在什么输入/时序下它会真的坏，可复现的因果>" }
```

**`failureScenario` 是承重字段**：说不清"怎么坏"的 = 还没验证的猜测，降级成 openQuestion，不当 finding 报。

### 4. 合并 + 按严重度排序

blocker → major → minor。产出：
- `findings[]`（排序后）
- `changeSummary`（这份 diff 干了什么，一段话）
- `openQuestions[]`（拿不准的，不是 finding）
- `residualTestGaps[]`（第 4 段发现的、本次不补但要记的覆盖缺口）

### 5. 上报 criterion（挂 task 时）

四段评审产物可作为结构化 review artifact 上报（服务端 schema `code-review`：要求 `findings[] / openQuestions[] / changeSummary / residualTestGaps[]`）：

```bash
# 写 artifact JSON（形状见上）到文件
cat > /tmp/review-artifact.json <<'JSON'
{ "findings": [...], "openQuestions": [...], "changeSummary": "...", "residualTestGaps": [...] }
JSON

# 有 blocker → failed；无 blocker → passed
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" \
  --outcome failed --review-artifact /tmp/review-artifact.json \
  --note "1 blocker: src/foo.ts:42 unhandled null → NPE on empty input"
```

`--outcome` 合法值恰好四个：`passed | failed | n/a | waived`。**注意**：`verify-criterion` 的 review-artifact 走服务端 `reviewerId` = 调用凭据身份，若你的凭据解析成 assignee，服务端会 403（自评拦截）——这正是独立性的第二道门。

## 输出契约（机器判据按这个复验，别自由发挥格式）

本 skill 的验收判据不是「报告里出现了 `foo.ts:42` 这种形状」——旧判据 `[\w./-]+\.(ts|tsx|js):\d+` 正是这么写的，**随手编一个路径行号就能拿满分**。现在判据把报告里的每条 `file:line` **读回磁盘复核**（`structured-criteria.ts` 的 `cited-evidence`）。所以报告必须带下面两样**可机器解析**的东西——形状对但内容假的报告会被当场判红。

**① 评审锚点声明**（一行；符号会被复核确实出现在该文件里）：

```
CHANGE-POINT: <被审的符号/表名/端点> @ <path>
```

**② findings 表**（markdown 表，**首列是 `file:line`**，按严重度排序）：判据逐行把 `file:line` 读回磁盘——**文件不存在 / 行号越界 / 该行是空行**，任意一条就判红；并且至少 2 条引用**所在的那一行必须真的含锚点符号**（"真实存在的行" ≠ "真实的搜索命中"）。

```
| file:line | severity | segment | finding | failureScenario |
| --- | --- | --- | --- | --- |
| src/lib/orphan-vacuum.ts:131 | blocker | bug | 空父集下 NOT IN 判 TRUE | im_tasks 清空后 vacuum 删掉合法审计行 |
```

**行号照抄 `rg -n` 的真实输出，不许凭印象写。** 说不清 `failureScenario` 的降级成 `openQuestion`，别塞进 findings 表凑行数。

**③ 四段 keyed 行**（四段各占**独立一行**，key 逐字如下）：旧判据是「全文里出现过 convention/bug/history/coverage 这四组词」的 lookahead——**一篇编造的报告照样满分**，而且**整段跳过**也照绿（只要正文里恰好提到那个词）。现在判据（`dimension-coverage`）只认**这条 keyed 行**：某段没写这一行 = 该段**缺失判红**，正文里出现那个词**不算数**。每段的答案必须是**这一段真的看过的** `path:line`（读回磁盘复核），或者显式 `N/A — <理由≥20 非空白字符>`：

**每段必须以一个 verdict token 开头**（`covered` = 该段审过且没问题 / `gap` = 该段发现了问题 / `N/A — <理由≥20 字符>` = 该段不适用），然后才是 `path:line`：

```
- SEGMENT-convention: covered | src/im/sql/528_task_log_nullable_taskid_for_ops_audit.sql:1 | 编号无缺口、双 schema 同步
- SEGMENT-bug: gap | src/lib/orphan-vacuum.ts:131 | 空父集下 NOT IN 判 TRUE，删掉合法审计行
- SEGMENT-history: covered | src/im/sql/528_task_log_nullable_taskid_for_ops_audit.sql:13 | 描述符自 177773e9 起未随列语义更新
- SEGMENT-coverage: N/A — `rg -l` 在本改动面上零测试文件命中，本段没有可审的测试面（缺口本身记进 residualTestGaps）
```

> **⚠️ `SEGMENT-bug` 在本 sample task 上被钉死为 `gap`**（判据 arg `requiredVerdicts`）。原因是实测出来的：一份**明确写着「未发现 blocker 级问题，建议合入」、还主动复述那条错误安全性断言**的评审，在加这条之前拿 **6/6 满分**——因为旧判据「the real defect surfaced」是一串宽泛关键词（`vacuum` / `删除` / `delete` / `审计行`），而**这个 diff 的主题本身就是 orphan-vacuum 和审计行**，任何谈论它的报告都必然命中。判据的 label 与它实际验的东西之间没有强制关系（apc/12 §0.13）。
>
> **诚实边界**：`requiredVerdicts` 把「答案」编进了判据 —— 它只对**这个** sample task 有意义（换一个待审 diff 就必须换 args，甚至该判 `covered`）。这是 design-review 用同一个 arg 时已登记的取舍，不是新问题。
```

（上面四行是**真引用**、可原样复核——照抄这个形状不会把如实的报告判红；换成你自己那轮的真行号即可。）

四段中任意一段**只能**二选一：给可复核引用，或显式 `N/A —` + 真理由（`N/A` 后面空着/敷衍 <20 字符同样判红）。**不许**把段名写进散文当作"覆盖过了"。

**引用写法三条（判据按这个复核，写错会把如实的报告判红）**：

1. **必须 repo-root-relative**：写 `src/lib/orphan-vacuum.ts:131`，不要写简写 `lib/orphan-vacuum.ts:131`，也不要写绝对路径。
2. **计数不是行号**：`rg -c` 输出的 `path:12` 是"12 个命中"。要引用计数就写成 `count=12`；若整行只贴 `rg -c` 的裸 `path:数字`，判据会认出它是计数并跳过，但**别把它混在句子里**，那样会被当行号复核。
3. **散文里出现的 `path:line` 一样会被复核**——报告里任何一处 `path:line` 都是一次声明。拿不准就只写路径不写行号。

## 产出（副作用 oracle，报告里必须给）

1. **独立性证据**：`git log` 作者 ≠ 评审者。
2. **四段 findings**：按严重度排序，每条 `{severity, segment, file:line, finding, failureScenario}`。
3.（挂 task 时）**criterion 上报行** + review artifact 落 `im_assets`（可回读）。

**两个承重 oracle（本 skill 唯一有意义的判据）**：
- **正控**：diff 里**真存在**的缺陷，findings **必须点出它**（有 file:line + 失败场景）。抓不到 = 评审失效。
- **负控**：**干净的 diff**（无真缺陷），**不得虚报 blocker/major**。把正常代码说成 bug = 评审同样失效（这类假阳会淹没真信号、教 owner 无视评审）。

**不许**：报没有 file:line 的 finding；报说不清失败场景的"感觉不对"；纠 CI 会抓的 lint/类型/格式；自评自的 diff。

## 诚实边界

- **LLM 评审是非确定性的**：本 skill **不保证抓出所有缺陷**，也不保证零漏报。它保证的是"走完四段 + 每条 finding 可核验（file:line + 失败场景）+ 不自评"。深/隐蔽的缺陷（跨文件时序、需要真跑才暴露的）可能漏——这类要靠 test-runner 真跑 + 多轮评审兜，不靠单次 review 打包票。
- 四段里"历史上下文"依赖 `git blame`/`git log` 可读；shallow clone（daemon `--depth 1`）下历史不全，该段要显式标注"历史深度受限"。
- 本 skill 只产 findings，不改代码——修由实施 agent 按 findings 回改，再进下一轮评审。

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：四段评审出 findings 后，把本轮评审结论**直写成一张 PKF 记忆页**（pageType=`decision`，ReviewCard 语义 apc/09 §1）——同一页既是回用户侧的富评审报告，也是可召回的记忆页。这与经验抽取（durable 教训走 memory skill 的 CONSTRUCT→PLACE→WRITE）并存，不互相取代（doc07 §B1）。这一步是上面 criterion 上报**之后**的投影，不改评审的任何一步。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致（结论段的 `derived-from`/`contradicts` 指向必须可解析：无对应 SPEC 页就删 `derived-from` 行，无被推翻决策就删 `contradicts` 行）；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack code-review --task "$PRISMER_TASK_ID"
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
