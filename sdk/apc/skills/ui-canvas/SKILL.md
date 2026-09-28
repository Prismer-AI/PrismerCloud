---
name: ui-canvas
description: Use when a product journey, production component path, UI/UX operation sequence, visual regression, or alignment review must be represented or audited in /ui-canvas with implementation-spec references, immutable versions, task-bound screenshots, and a persisted ReportCard.
license: MIT
allowed-tools:
  - Bash
metadata:
  category: design
---

# UI Canvas

用一个代码定义的展开画布完成 **spec ↔ 真实生产组件 ↔ 用户操作 ↔ 可寻址视觉证据** 对齐。Production checkpoint 必须在 Frame 内直接渲染真实 UI；不能安全渲染就保留同尺寸 `gap` contract。最终证据来自真实 `/ui-canvas` deep link，不来自 `/ui-kit` 仿制稿。

## 承重规则

1. 先读 implementation spec 的 `UI Canvas index` 和 Canvas registry，建立双向索引。
2. 禁止从 `src/app/ui-kit/sections/**` 取节点实现；`/ui-kit` 仅是历史参考。
3. Canvas callback 只能改变本地 fixture、选中节点和 edge 高亮，不得发业务请求。
4. `aligned` 版本不可原地修改；需求变化时新增版本并用 `previousVersion` 回指。
5. Production Frame 直接 import 生产组件；不能复用就写 `gap`，不复制 JSX 冒充闭合。
6. 测试和截图只证明 Canvas route/registry/render；不能证明 service、DB、daemon 或业务副作用。
7. 截图 asset 与 ReportCard 证明“证据已产出”，不能自动判定“视觉正确”。

## Workflow

### 1. 建立双向索引

从 spec 找出 set、journey、checkpoint 与 user/system oracle。每个 `CanvasSet`、version、journey、node 都持有真实 `SpecRef`；spec 反向列出 Overview、journey deep link 与 registry source。

### 2. 盘生产 source

```bash
rg -n "export (function|const|class)" src/app src/components
rg -n "ui-kit/sections|fetch\\(|imFetch\\(|/api/" src/app/ui-canvas
```

| 判定 | 条件 | 动作 |
| --- | --- | --- |
| `production` | props 可确定性渲染，callback 可留在本地 | 在 `component-registry.tsx` 直接 import |
| `gap` | 没有生产组件，或 wrapper 挂载即请求/轮询 | 写清 `reason`、`driftRef`、双 oracle |

生产 wrapper 只因数据编排不能复用时，可抽纯 `*View` 让生产 wrapper 与 Canvas 共用；不得借机修改 endpoint、model、daemon 或 SDK。

### 3. 写不可变版本

- draft 可编辑；`aligned` 后冻结。
- 需求变化新增版本文件，不覆盖历史文件。
- checkpoint 总数、唯一性、edge 完整性和 production source 由 registry test 锁定。
- Overview 从 journey registry 派生，不复制 checkpoint。

### 4. 展开 Frame 与操作边

- Production checkpoint 使用约 `960×680` 的 Frame，body 直接挂 renderer。
- Gap 使用同尺寸 contract，显示 reason、driftRef、双 oracle 和 SpecRef。
- 默认相机聚焦 deep-link Frame；整条路径缩略图只能通过显式 `Fit journey`。
- Inspector 使用浮层，不永久挤压真实组件。
- Edge label 写用户动作或条件；用 `action / condition / error / recovery / handoff` 区分语义。
- 生产 callback 选择对应 outgoing edge；没有真实 target 时只记录 local action。

### 5. 验证结构与真实渲染

```bash
npx vitest run src/app/ui-canvas/__tests__
npx tsc --noEmit
PRISMER_BASE_URL=http://127.0.0.1:3000 \
  npx playwright test e2e-playwright/specs/ui-canvas.spec.ts --project=chromium
rg -n "ui-kit/sections|fetch\\(|imFetch\\(|/api/" src/app/ui-canvas
```

Playwright 只能打本地 `127.0.0.1:3000`。截图前先断言目标可见，不得用 `.first()` 掩盖稳定态重复节点。

### 6. 发布 task-bound 视觉证据

先从代码 registry 读取合法 set/version/journey：

```bash
npx tsx scripts/ui-canvas-evidence.ts --list
```

再对需要验收的真实 Frame deep link 产 light/dark 截图、task asset 和一张 ReportCard：

```bash
npx tsx scripts/ui-canvas-evidence.ts \
  --set <set> --version <version> --journey <journey> --node <node> \
  --themes light,dark \
  --workspace "$APC_WORKSPACE_ID" --task "$PRISMER_TASK_ID"
```

Runner 的顺序是：registry target 校验 → 可选 baseline asset 回读 → Playwright 打真实 `/ui-canvas` deep link → PNG 像素闸 → 上传 task-bound assets → 写 `visibility=task:<id>` 的 ReportCard。非法 set/version/journey/node 在任何副作用前失败。默认 ReportCard path 同时包含 task 与本次 evidence id，因此同一节点重复运行不会撞已有 page；显式 `--path` 时调用方必须提供未占用路径。

需要旧图/新图并排时只传一个 `--baseline-light` **或** `--baseline-dark`；一张 ReportCard 只承载所选 theme 的一组 old/new。它只是 reference，不是 diff；结构化输出的 `comparison` 恒为 `"none"`。禁止编造偏差百分比、changed pixels 或视觉 PASS。

凭据只从已设置的 `APC_API_KEY` / `PRISMER_API_KEY` 环境读取，禁止把 token 放进命令参数或报告。

没有 task/workspace/live local cloud 时可以完成代码审计，但证据步骤必须写 `not-run + 原因`，不能声称已产 asset 或 ReportCard。

## 输出契约

```text
CANVAS: <set>@<version> | route: </ui-canvas?...>
PRODUCTION: <count> | source: <repo-relative-path:line>
GAPS: <count> | refs: <drift refs>
REGISTRY-TEST: <command> | exit: <code>
PLAYWRIGHT: <local command> | exit: <code> | passed: <count>
EVIDENCE: route=<exact deep link> | themes=light,dark | comparison=none
ASSETS: light=<assetId>(bytes=<n>) | dark=<assetId>(bytes=<n>)
REPORTCARD: pageId=<id> | uri=<prismer uri> | visibility=task:<taskId>
HARNESS: <command> | exit: <code>
BOUNDARY: canvas interaction and evidence are not service verification
```

只汇报真跑结果。任何 `not-run` 都必须带原因；没有 pageId 就没有持久化 ReportCard。

## Red flags

- 在 `/ui-kit` 画一个相似稿再当 production
- 用摘要卡代表真实 UI，或把真实组件藏进 detached Focus
- 默认 Fit 整条路径，导致 Frame 变成不可读缩略图
- 复制生产 JSX 到 Canvas
- 用 mock 隐藏缺失 checkpoint
- 为截图在 Canvas 调业务 API
- 原地修改 `aligned` 版本
- 用 asset/ReportCard 的存在声称视觉已经通过
- 把 Canvas local callback 说成系统副作用已验证

出现任一项就停止，把节点改回 `gap`、建立共享生产 `*View`，或如实降低证据结论。

<!-- APC-ACK:v1 -->

## 调用回执

执行本 Skill 的第一步：

```bash
cloud skill ack ui-canvas --task "$PRISMER_TASK_ID"
```

| exit | 含义 | 动作 |
| --- | --- | --- |
| `0` | 回执已落库 | 继续 |
| `3` | 无 task 上下文 | 继续，但不得声称已 ack 或已发布 task evidence |
| `4` | 不是 task assignee | 停止并上报 |
| `1` | 网络或服务端失败 | 重试一次，仍失败则标注回执缺失 |

回执只证明 Skill 被调度，不证明执行正确。

<!-- /APC-ACK:v1 -->
