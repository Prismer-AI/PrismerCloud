---
name: ui-align
description: Visual-alignment workflow for a new UI need or a UI改进. Index-first (consult the ui-kit registry to avoid re-building an existing primitive), then implement, then run the screenshot harness to capture the component in light/dark against the live /ui-kit, then produce a ReportCard (screenshot assets side by side + a written conclusion) the requester reviews VISUALLY without reading code. The harness computes NO image diff — it verifies side effects (screenshots really have pixels, assets uploaded, ReportCard persisted); both "the visual looks good" and any deviation number are human judgments the machine never produces.
license: MIT
scope: common
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: design
---

# ui-align

把「新 UI 需求 / UI 改进对比」跑成 **索引 → 实现 → 截图 → 报告** 的闭环（docs/apc/07 Part A §A4）。
产出是一张 **ReportCard**：把同一组件的 **light / dark 两态截图** + 对比结论落成一张可寻址的富报告页，
需求方**从视觉验收，不读代码**。

**什么时候用**：一个 UI 组件要新增 / 改样式 / 做前后对比时。**第一步永远是查索引**——ui-kit 已经把
现有原语拆成 `registry.ts` 索引，先看有没有现成的，别重复造第 N 个 Dialog / Button / Card。

## Why（这条 skill 存在的理由）

- **避免重复造**：ui-kit 是全状态画廊 + 机器可读索引（`src/app/ui-kit/registry.ts` 的 `ENTRIES`）。
  新需求先对索引，命中就复用，不命中才新增一片。索引是唯一真源——**不 grep 源码猜有没有**。
- **视觉验收可寻址**：截图落 task-bound asset，ReportCard 用 `prismer://asset/<id>` 引它 + 结论段。
  需求方点开卡就看到 before/after，不必读 diff。
- **两态都截**：light / dark 是同一个主题机制的两个投影（`.dark` on `<html>`）。只截一态会漏掉暗色下
  的对比度 / 边框 / 玻璃态塌缩——两态并排是对齐评审最有用的形态。

## Anti-pattern（这条 skill 要防的）

- **不查索引就动手**：直接新写一个组件，结果 ui-kit 里早有同款 → 又一个分叉。**先 `--list`。**
- **只截一态**：只发 light 截图，dark 下的问题溜过评审。
- **把"视觉通过"当机器结论**：本 skill 的 oracle 断的是**副作用**（截图产出了、ReportCard 落库了、
  对比表结构对），**不是**"好不好看"。**别在报告里声称"视觉已验证正确"**——那是人的判断（同
  design-review 固有局限）。
- **贴原始 JSON 冒充报告**：harness 的 stdout 是结构化 JSON，读它、汇报关键字段（scope / themes /
  reportCard pageId / shots assetId / exit 码），不是把整坨 JSON 甩回去。

## Workflow（真命令，`apc` 不在 PATH → 一律 `npx tsx`）

从仓库根跑。harness 的 stdout 是纯 JSON。

### 1. 索引优先——查有没有现成的 scope

```bash
npx tsx sdk/apc/harness/ui-screenshot.ts --list     # 合法 scope 清单
npx tsx sdk/apc/harness/ui-screenshot.ts --help     # 全部旗标 + 退出码语义
```

打印 registry 里所有合法 scope（`{ ok:true, scopes:[...] }`）。**命中就复用那个 scope；不命中**
说明是新需求 → 在 `src/app/ui-kit/registry.ts` 的 `ENTRIES` 加一行（`status:'draft'` + 挂 task/doc）
并在 `sections/<scope>.tsx` 加稿件（07 §A4 步骤 1-2；本 skill 不替你写实现，只教流程 + 产报告）。

### 2. 跑截图 harness——两态截图 + 上云 + 产 ReportCard

```bash
npx tsx sdk/apc/harness/ui-screenshot.ts \
  --scope <scope> --themes light,dark \
  --workspace "$APC_WORKSPACE_ID" --task "$PRISMER_TASK_ID"
```

harness 会：读 registry 校验 scope（非法 scope → 结构化错误、**不产废卡**）→ 用 Playwright 打
`http://127.0.0.1:3000/ui-kit?scope=<scope>` 对 light/dark 各截一张 → **过像素闸**（单张 0 字节 /
< 1 KiB / 不是 PNG / 两态字节完全相同 ⇒ 直接判红，**在上传之前**，不产废 asset 不产废卡）→ 上云成
task-bound asset → **复用 `report-card.ts` 产一张 ReportCard**（截图 + 结论 + TierResult 表）。

卡里两张图的槽位：**before = `--themes` 的第一个态（light），after = 第二个态（dark）**，与卡正文
结论段的措辞逐字一致。

**并排引用一张已有的基线图**（改进现有组件时）：

```bash
npx tsx sdk/apc/harness/ui-screenshot.ts --scope <scope> --themes light,dark \
  --workspace "$APC_WORKSPACE_ID" --task "$PRISMER_TASK_ID" \
  --baseline-light <旧light assetId> --baseline-dark <旧dark assetId>
```

此时 before 槽 = 你传进来的旧图，after 槽 = 本次新截的图，`mode` 变成 `baseline-reference`。

> ⚠️ **这不是"比对"**。本 harness **不计算任何像素/结构差异**——它只是把两张图并排放进同一张卡，
> 差异由**人看图**判定（输出 JSON 里的 `"comparison": "none"` 就是在结构化地说这件事）。
> **报告里不许出现任何偏差百分比 / diff 数值 / "像素级通过"**：harness 没算过，写出来就是编造。
> 像素级阈值 diff（`toHaveScreenshot`）属 Playwright spec 层，本 skill 不含。
>
> 传进来的 baseline id 会在起 chromium **之前**回读校验（真存在 · 同 workspace · 是图片）。
> 解析不开 ⇒ `ui-screenshot-baseline-unresolvable`、exit 1、不截图不上传不产卡（以前这里只是往卡里
> 填一个字符串，传个根本不存在的 id 也 exit 0，卡里就多一条永远打不开的悬空引用）。

### 3. 读结构化输出 → 汇报

harness stdout（成功）：

```json
{ "ok": true, "scope": "basics", "themes": ["light","dark"], "mode": "new-baseline",
  "comparison": "none",
  "shots": [ {"theme":"light","assetId":"cmr...","bytes":204601},
             {"theme":"dark","assetId":"cmr...","bytes":202065} ],
  "reportCard": { "pageId":"cmr...", "uri":"prismer://workspace/.../memory/cards/ui-align-<scope>", "version":1 } }
```

（`baseline-reference` 模式下每个带基线的 shot 还会多一个 `baselineRefAssetId`。）

汇报：**scope、截了哪两态、每态 assetId 与 bytes、ReportCard 的 pageId/uri、退出码**。需求方经
ReportCard 视觉验收。`comparison` 恒为 `"none"` —— 照抄，别把它写成任何形式的"差异结论"。

## Decision table

| 情况 | 怎么做 |
| --- | --- |
| 需求匹配 `--list` 里的某个 scope | 复用该 scope，直接跑步骤 2 |
| 新 UI 需求，索引里没有 | 先加 registry 行 + section 稿件（07 §A4），再跑步骤 2 |
| 改进现有组件、要把旧图并排放进卡 | 传 `--baseline-light/--baseline-dark`（并排引用，**不算差异**） |
| harness 报 `ui-screenshot-unknown-scope` | scope 拼错或没进索引——对 `--list` 核对，别硬跑 |
| harness 报 `ui-screenshot-degenerate-shot` | 截图退化（0 字节 / 过小 / 非 PNG / 两态同字节）——这是**真失败**：cloud 页面没渲染出来、或主题没切成。查 `$APC_CLOUD_BASE_URL` 那个 `/ui-kit?scope=` 页面本身，别重试骗绿 |
| harness 报 `ui-screenshot-baseline-unresolvable` | `--baseline-*` 给的 asset 不存在/已删/不同 workspace/不是图片——核对 id，别把它当成"基线库还没建" |
| harness 报 `ui-screenshot-upload-*` / `write-*` | cloud 不可达或 token 无效——查 `$APC_CLOUD_BASE_URL` / `$APC_API_KEY`，别谎报已产卡 |

## Failure（怎么算失败，别骗绿）

- harness 退出码 **非 0** = 失败。unknown-scope（exit 2）说明 scope 不在索引——这是**发现**（拼错/漏建索引），
  如实报，别把 scope 名改成能过的。
- 拿不到 `reportCard.pageId` = ReportCard 没落库 = 没产出，**不许声称已产报告**。
- **exit 0 但零输出 = 没跑**。harness 成功时 stdout 一定是一坨 JSON；失败时 stderr 一定是一坨 JSON。
  两边都空 = 它压根没执行，**不许当成功**（历史上入口守卫在含软链的调用路径下就是这样 fail-open 的）。
- **视觉不对齐不是本 skill 的失败**——那是评审发现，写进结论让人判。本 skill 失败 = 截图/报告的**副作用**没产出。
- **不许报任何 diff 数值**（偏差百分比 / 变化像素数 / "像素级 PASS"）。harness 没有比对这个计算，
  写出来的每一个这类数字都是编造 —— 这是本 skill 最容易犯的那种"引用真、结论假"。

## 输出契约（索引那一段是机器复验的，别自由发挥格式）

「索引优先」是本 skill 的头号反 pattern（不查索引就动手），但旧判据只找 `(--?list|registry|scopes?|索引|清单)` ——**报告里写一句「已查清单」就绿**，零检索也过。现在这一段找的是**两条固定 key 的行**，并把行上的引用**读回磁盘复核**（`structured-criteria.ts` 的 `dimension-coverage`）：

```
- [1] index-first: scope=basics 在索引里命中（--list）→ 复用，不新造原语 | src/app/ui-kit/registry.ts:69
- [2] scope-source: 渲染 ?scope=basics 的稿件源 | src/app/ui-kit/sections/basics.tsx:1
```

- 行号用 `rg -n "scope: 'basics'" src/app/ui-kit/registry.ts` 取，**别猜**——文件不存在 / 行号越界 / 该行是空行都判红。
- 引用**必须 repo-root-relative**（`src/app/ui-kit/registry.ts:69`，不要简写、不要绝对路径）；`rg -c` 的 `path:12` 是命中计数不是行号，要写就写 `count=12`。
- **新需求（索引未命中）**：仍然作答这两行——`index-first` 引你新加的 `ENTRIES` 那一行，`scope-source` 引你新建的 `sections/<scope>.tsx`（07 §A4 步骤 1-2）。别写 `N/A`：本 skill 任何一次真跑都有索引落点。

**判据管不到的部分（诚实边界）**：截图 assetId / ReportCard pageId / harness 退出码是**运行时 id，不是文件引用**——现有 checker 只会把 `path:line` 读回磁盘，没有能复核这类 id 的 checker，所以那几条仍是文本判据（`assetId` / `report-card` / `exit 0` 的正则）。**别为了讨好判据把 id 伪装成 `path:line`**——照 harness JSON 原样贴。这一段的真验收仍靠 harness 的真副作用（截图上云 + 卡落库）。

## Output（副作用 oracle，报告里必须给）

1. **索引已查**：报告说明查了 `--list` 且命中/未命中哪个 scope。
2. **两态截图产出**：light + dark 各一张，每态有 assetId **和 bytes**（bytes 是"图里真有像素"的证据；
   两态的 assetId 必须**不同**，相同说明主题没切成）。
3. **ReportCard 落库**：有 `reportCard.pageId` + uri（`pageType='report-card'`，`visibility='task:<id>'`）。
4. **退出码 0**（或 unknown-scope 时 exit 2 + 如实报 scope 不在索引）。
5. **`comparison` 原样照抄**（恒 `"none"`）——它就是"本次没有任何比对结论"的证据。

**不许**：只截一态；声称"视觉通过/正确"（机器不断视觉）；报任何偏差数值；没 pageId 却说已产报告；
把整坨 JSON 甩回不提炼。

## 诚实边界

- **视觉"好不好看"是人的判断，非机器断言**（同 design-review 固有局限）。本 skill 保证的是"两态截图产出
  + ReportCard 落库 + 对比表结构对"，**不保证**"视觉正确"。别拿本 skill 的绿宣称视觉验收通过。
- **本 skill 不做任何图像比对。** `--baseline-*` 是**并排引用**（把一张已有的图放进卡的 before 槽），
  不是 diff 输入；harness 从不计算像素/结构差异，`comparison` 恒为 `"none"`。**任何偏差百分比、
  "像素级通过/不通过"都是编造**。像素级阈值 diff（`toHaveScreenshot`）属 Playwright spec 层，本 skill 不含。
  （harness 只保证 baseline id **解析得开**：存在 · 同 workspace · 是图片；解析不开就红。）
- **像素闸只挡退化，不挡丑**：0 字节 / < 1 KiB / 非 PNG / 两态字节完全相同 ⇒ 红。它证明"图里有像素、
  两态确实是两张图"，**不证明**"这张图是对的"。
- harness 需要活 cloud（`$APC_CLOUD_BASE_URL`，默认 `127.0.0.1:3000`）+ 有效 token（`$APC_API_KEY`）+
  真 chromium（Playwright）。缺任一 → harness 结构化报错，别谎报。

## PKF 直写（研发回环 · doc07 §B2 写入点②）

**产出时机**：上面步骤 2 产出的 **ReportCard 就是一张 PKF 记忆页**（doc07 §B2 写入点②：截图对比报告直写 PKF）。**直写已由 harness 完成**——`sdk/apc/harness/report-card.ts` 构造 PKF → `parsePkf`/`validatePkf` 校验 → 仅合法时经**既有写入 seam**（`POST /api/im/memory/resolve`，唯一能带 `visibility` 的写入面）落库并**回读校验**；你**不必**再手跑 `prismer memory write`，那会重复写。**不新造写入面**（B3：骑既有面）。页面形状（`pageType='report-card'`、`visibility='task:<id>'`、截图走 `prismer://asset/<id>`）见 `pkf-writing` skill 的 media 引用。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

值取 harness 的返回值（`GeneratedReportCard.uri`）；harness 写入失败（写入面不可达）时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，绝不许假装写了。

**回读**：harness 的 strict readback 已校验「落库页与产出字节一致」；你**只声称**「ReportCard 已落库 + INDEX 可达」，不得声称比这更多。**诚实边界**：harness 写入 body 只带 `uri/content/pageType/visibility`，**未**传 `parent_hub_path`，即 `apc/ui` hub 归属尚未接线——报告里别声称"已挂 apc/ui hub"（doc07 §B5：hub 归属走 memory skill 正常 PLACE 流程，不手工造 hub）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack ui-align --task "$PRISMER_TASK_ID"
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
