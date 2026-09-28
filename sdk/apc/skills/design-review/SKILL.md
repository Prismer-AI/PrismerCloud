---
name: design-review
description: Five-dimension design audit (frontend UI/UX · server data-model & flow · endpoint spec · daemon-runtime/SDK & local-cache-first · built-in skill/agent-role), executed by a NON-implementing agent. Every dimension gets a verdict; N/A only with a stated reason. A dimension the design silently skipped must be surfaced as a gap; covered dimensions must not be over-reported.
license: MIT
scope: common
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: review
---

# design-review

对一个**改动方案 / diff**做 **CLAUDE.md 强制的五维变更审计**，产出每一维的判定（covered / gap / N-A-带理由），由**非实施 agent** 执行（`apc/05` §2 S6 · `apc/12` design-review 行；与 S5 code-review 同精神——实施者不自审自的设计）。

**什么时候用**：一个 design doc / migration / ADD COLUMN / 新 endpoint / UI 重做进评审门时，需要独立核对它有没有把五维都想全。这是设计期的漏，比 phase 末期补漏便宜 10×（CLAUDE.md 五维审计）。

## 评审独立性（第一铁律，P2-17）

**评审由非实施 agent 执行**——设计者不自审自的方案，与 no-self-approval 同精神。若你就是这份设计的作者 → 停手，让另一个 agent 审。

## 五维（缺一维 = 未闭合；N/A 也要显式写理由）

照 CLAUDE.md「Five-Dimension Change Audit」逐维答。**任一维标"未考虑"/"待后续评估"不能进实施**；**N/A 也要显式写原因**。

| # | 维度 | 必答问题（摘 CLAUDE.md） | 证据手段 |
| --- | --- | --- | --- |
| 1 | **前端 UI/UX 渲染交互** | 用户在哪儿感知？哪些组件/hook/路径改？破坏交互肌肉记忆吗？刷新/跨设备？错误态如何 surface？ | `rg` 组件/路由 |
| 2 | **服务端 data-model & 数据流** | 哪些 Prisma model / SQL table 改？migration 编号？读/写/缓存路径？同事务保证？跨实例 fan-out？ | `rg` schema；`ls src/im/sql \| sort \| tail` 看下一个编号；**双 Prisma**（SQLite + MySQL）都改了吗 |
| 3 | **Endpoint spec** | 新增/改/弃用哪些 HTTP/WS/SSE？req/resp schema？认证级别？错误码？兼容策略？SDK 类型同步？ | `rg` 路由/handler |
| 4 | **Daemon runtime / SDK & local-cache-first** | daemon SDK 要适配吗？本地 SQLite/FS/asset-cache 变化？离线 fallback？daemon↔cloud 版本协商？多语言 SDK 同步？ | `rg` runtime/；想 local-first：**cloud-only 的东西 daemon 学得到吗** |
| 5 | **Built-in skill / agent-role** | 影响 SKILL.md / AGENTS.md / SOUL.md / operatingPrinciples 吗？要新 built-in skill？role template backfill？agent 端 prompt 更新？ | `rg` built-in-skills/ · role template |

## Procedure

### 1. 独立性自证（若挂 task）— 你不是设计作者

### 2. 逐维审，每维产一条判定

对每一维给一行判定，形状：

```
{ dimension: 1..5,
  verdict: covered | gap | n/a,
  reason: "<covered: 方案怎么覆盖的 + 残留问题 / gap: 漏了什么、会怎么坏 / n/a: 为什么这维不适用>" }
```

- **`gap` 是承重判据**：方案**没提**的维度，标 `gap` 并说清"这个洞会怎么坏"（如：cloud-only 的 cap，daemon 本地 LLM 路径学不到 → 离线不 enforce）。**别因为方案没写就默默跳过当它 covered**——静默跳过正是五维审计要抓的头号反 pattern（单维过度聚焦）。
- **`n/a` 必须带理由**：一维确实不适用（纯计费门不碰 agent 能力 → 第 5 维 N/A），显式写理由。**不许留空、不许"待评估"。**
- **`covered` 不虚报**：方案**真覆盖**的维度，标 covered、只列真实残留问题（错误码待补、跨设备回显待确认）。**不要**把正常设计说成 blocker——假阳会淹没真信号（照 S5 code-review "干净 diff 不虚报"）。

### 3. 汇总 + 点出被静默跳过的维度

产出：
- **五维判定表**（每维 covered/gap/n-a + reason）。
- **承重发现**：被方案**静默跳过**的维度（那个 enforcement/兼容/数据主权的洞）。
- **openQuestions[]**：拿不准的（不是 gap）。

## 输出契约（机器判据按这个复验，别自由发挥格式）

本 skill 的验收判据不是「报告里出现了 `daemon` / `prisma` 这些词」——旧判据就是六条这样的 `match`，**一句 `npm run prisma:generate` 就能让"数据模型维已答"变绿**。现在判据找的是**每一维自己那一行**，并把该行的引用**读回磁盘复核**（`structured-criteria.ts` 的 `dimension-coverage`）。

**五维逐行作答**（每维**独占一行 + 固定 key**，行首先给 verdict，再给理由，最后给证据）：

```
- [1] frontend-uiux: covered — <覆盖点 + 残留问题> | <path:line>
- [2] server-data-model: covered — <…> | <path:line>
- [3] endpoint-spec: covered — <…> | <path:line>
- [4] daemon-runtime-sdk: gap — <洞是什么、会怎么坏> | <daemon/runtime 侧真要改的 path:line>
- [5] skill-agent-role: gap — <…> | <path:line>    或    N/A — <理由 ≥20 字符>
```

判据强制三条：

1. 每维的行**必须以 verdict 开头**：`covered` / `gap` / `N/A`（中文 `已覆盖` / `缺口` / `不适用` 同义）。
2. `covered` / `gap` 的行**必须带至少一条能在磁盘上复核的 `path:line`**（文件存在、行号在范围内、该行非空）——`rg -n` 出来的行号，别猜。这就是"对码"：说方案漏了 daemon 层，就得指出 daemon 层**真正**要改的那一行。
3. `N/A` 的行**必须带理由**（去空白后 ≥20 字符）；只写 `N/A` 判红。

引用写法：**必须 repo-root-relative**（`src/im/api/routes.ts:314`，不要简写成 `im/api/routes.ts:314`，也不要绝对路径）；`rg -c` 出的 `path:12` 是**命中计数不是行号**，要写就写 `count=12`。

**承重维度的 verdict 是被钉死的**：sample task 里 `daemon-runtime-sdk` 必须是 `gap`。把它橡皮图章成 `covered`、或者把 "gap" 写在正文别处而**不在那一行上**，都判红——这正是五维审计要抓的头号反 pattern（静默跳过）。

## 产出（副作用 oracle，报告里必须给）

1. **五维全答**：五个维度逐一有判定，**无一维留空**（N/A 也带理由）。
2. **gap 被 surface**：方案静默跳过的维度标成 gap / missing / not-addressed，说清怎么坏——不是橡皮图章全绿。
3. **covered 不虚报**：真覆盖的维度不编造 blocker。

**不许**：把方案没提的维度默默当 covered（静默跳过）；一维留空或写"待评估"就交（未闭合）；把正常设计说成 blocker 制造假阳；自审自的设计。

## 诚实边界

- **LLM 设计评审是非确定性的**：本 skill **不保证**抓出所有设计缺陷，也不保证零漏报/零虚报。它保证的是"五维逐维走一遍 + 每维判定可核验（covered/gap/n-a 带理由）+ gap 说清怎么坏 + 不自审"。深层的跨维耦合缺陷可能漏——靠多轮评审 + 真实施后 test-runner 兜，不靠单次审打包票。
- 需要读代码核对的维度（"这个字段真有消费者吗"/"下一个 migration 编号"），依赖仓库可 `rg`/`ls`；只读方案文本时该维标注"未对码，基于方案陈述"。
- 本 skill 只产判定，不改设计——修由设计者按判定回改，再进下一轮审。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack design-review --task "$PRISMER_TASK_ID"
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
