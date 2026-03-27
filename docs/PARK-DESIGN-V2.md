# Agent Park v2 — Design Document

> Date: 2026-03-11 | Status: Phase 0 COMPLETE | Previous: v1 (deleted — no real art, canvas placeholder)

## Why v1 Failed

v1 用 Canvas/PixiJS 画了一堆色块矩形充当建筑，没有任何美术资源。结论很简单：没有美术就没有可视化。

---

## 参考项目

| 项目 | 技术栈 | 美术方案 | 核心思路 | 开源 |
|-------|--------|---------|---------|------|
| [Star Office UI](https://github.com/ringhyacinth/Star-Office-UI) | **Phaser 3 + Flask** | **单张背景图 + spritesheet 叠加** | 状态驱动 → 角色在区域间移动 | MIT |
| [AI Town (a16z)](https://github.com/a16z-infra/ai-town) | Convex + PixiJS | LPC 像素风 + Tiled 地图 | 多 agent 自主对话 + 寻路 | MIT |
| Stanford Generative Agents | Unity | 自定义像素风 | 25 agent 仿真 | 论文 |

### Star Office UI 关键学习

Star Office 证明了一个关键点：**不需要 Tiled 地图、A\* 寻路、碰撞检测就能做出高质量的 Agent 可视化。** 它的架构极其简洁：

```
渲染层:
  1. 单张预渲染像素风背景图 (office_bg.webp, 1280×720)
  2. Phaser 3 加载背景图 → 在上面叠加 spritesheet 动画
  3. 家具/装饰 = 独立 spritesheet (咖啡机、服务器、植物、猫…)
  4. 角色 = spritesheet 动画 (idle / working / researching)
  5. 气泡 = Phaser text + rectangle container

状态系统:
  6 种状态 → 3 个区域 (breakroom / writing / error)
  角色在区域间做简单线性移动 (无寻路，仅 waypoint)

多 Agent:
  每个区域预定义 8 个 slot 位置 → 多 agent 按 slot 排列
  agent 容器 = emoji icon + name tag + status dot

配置:
  layout.js — 所有坐标、depth、origin 集中管理 (无 magic number)
  支持 WebP 检测 + PNG fallback
```

**Star Office 的优势（相比 AI Town）：**
- 美术质量高：预渲染背景 >> 运行时拼贴 tilemap
- 实现简单：~1000 行 JS 搞定全部渲染逻辑
- 加载快：无需解析复杂地图数据
- 可维护：换背景图 = 换一张 webp，无需重新编辑 tilemap

**Star Office 的限制（Prismer 需要克服）：**
- 只有 3 个区域 → Prismer 需要 8 个区域
- 角色外观单一（主角一种 spritesheet）→ Prismer 需要多种角色变体
- 无相机系统 → 8 区域地图可能需要缩放/平移
- Python Flask 后端 → Prismer 直接用 IM Server

---

## v2 技术方案

### 核心思路：Star Office 模式 + Prismer 扩展

```
Star Office 做法 (我们借鉴):
  ✅ 单张高质量像素风背景图作为地图
  ✅ Phaser 3 渲染引擎（pixelArt: true, Arcade Physics 仅用于基础移动）
  ✅ 角色 spritesheet 动画
  ✅ 状态驱动的区域移动（无 A* 寻路，waypoint 即可）
  ✅ 集中式布局配置（layout.ts，无 magic number）
  ✅ 气泡对话系统
  ✅ 多 agent 区域 slot 分配

AI Town 做法 (我们借鉴):
  ✅ 8 种角色 spritesheet 变体（32×32, 4 方向 × 3 帧）
  ✅ 基于 hash 的角色分配

我们的创新:
  ✅ 8 个功能区域（对应 Prismer IM API）
  ✅ SSE 实时推送（替代 Star Office 的 2 秒轮询）
  ✅ Next.js 嵌入（React overlay + Phaser 引擎共存）
  ✅ 无独立后端（直接复用 IM Server）
```

### 美术资源方案

**美术风格：现代城市像素风** (从中世纪 RPG 转为现代都市)

```
┌──────────────────────────────────────────────────────┐
│  方案：预渲染背景图 + Spritesheet 叠加               │
│  (Star Office 模式，不再使用 Tiled)                   │
│                                                       │
│  Step 1: 背景图 ✅ 已完成                             │
│  来源: Gemini AI 生成 (2752×1536) → 缩放 1280×720   │
│  风格: 现代城市俯瞰，带 "PRISMER TOWN" 标识         │
│  处理: 去除建筑标签文字 → Phaser 动态渲染 zone 名称  │
│  格式: town-bg.webp (264KB) + town-bg-clean.png      │
│                                                       │
│  Step 2: 补充素材包 ✅ 已获取                         │
│  Modern Exteriors RPG Maker MV (LimeZu)              │
│  183 tileset PNGs + 18 animations + characters       │
│  用途: 内部场景拼装 + 装饰动画 overlay                │
│                                                       │
│  Step 3: 角色 Spritesheets ✅ 已完成                  │
│  来源: AI Town 32x32folk.png (MIT, 8 variants)        │
│  32×32 per frame, 4 direction × 3 frames walk         │
│  characters.json 已定义所有帧数据                     │
│  兼容性: 32×32 卡通小人在现代城市背景上无违和感       │
│                                                       │
│  总预算: <3MB (WebP 后 ~1.5MB)                        │
└──────────────────────────────────────────────────────┘
```

### 游戏引擎

**选择：Phaser 3 (轻量使用模式)**

Star Office 的启示：Phaser 3 不需要用 Tiled、Physics、Camera 等重量级功能。只需要：

| 使用的 Phaser 能力 | 用途 |
|-------------------|------|
| `this.add.image()` | 渲染背景图 |
| `this.add.sprite()` + `this.anims.create()` | 角色/装饰动画 |
| `this.add.text()` + `this.add.rectangle()` | 气泡、名字标签 |
| `this.add.container()` | Agent 组合体（sprite + name + status dot） |
| `this.physics.add.sprite()` | 角色移动（仅用 velocity，不用碰撞） |
| `pixelArt: true` | 像素风渲染 |
| Game loop (`update()`) | 状态轮询、动画更新 |

**不需要的 Phaser 能力（简化掉）：**
- ~~Tilemap 加载~~ → 用背景图
- ~~A\* / NavMesh 寻路~~ → waypoint 线性移动
- ~~Collision detection~~ → 不需要
- ~~Camera system~~ → 固定视角（或简单缩放）
- ~~Multiple scenes~~ → 单 scene 足够

### 布局系统 (layout.ts)

借鉴 Star Office 的 `layout.js` 模式，集中管理所有坐标：

```typescript
// src/app/park/game/layout.ts
// 坐标基于 town-bg.webp (1280×720, Gemini 生成现代城市) 中的实际建筑位置
export const LAYOUT = {
  game: { width: 1280, height: 720 },

  // 8 个区域 — 建筑正门前的坐标 (Agent 站立位置)
  // 基于 Gemini 生成图标定，2026-03-11
  areas: {
    tavern:      { x: 204, y: 220 },  // 左上 (原 green-cross 建筑)
    workshop:    { x: 428, y: 225 },  // 中左上 (原 MEDICAL ARCHIVE 建筑)
    city_hall:   { x: 640, y: 205 },  // 正中上 (钟楼建筑)
    post_office: { x: 860, y: 220 },  // 中右上
    library:     { x: 1102, y: 245 }, // 右上
    archive:     { x: 265, y: 505 },  // 左下
    town_center: { x: 640, y: 365 },  // 正中 (喷泉广场)
    lab:         { x: 1023, y: 505 }, // 右下 (TECH LAB 建筑)
  },

  // 每个区域 8 个 slot (Agent 排列位置，围绕建筑门口)
  // 由 generateSlots() 动态生成，以 area 中心为基准，间距 28px
  areaSlots: generateSlots(), // 见辅助函数

  // 建筑点击热区 (用于展开内部场景 overlay)
  // 基于 Gemini 图中建筑轮廓标定
  buildingHitAreas: {
    tavern:      { x: 130, y: 130, w: 150, h: 100 },
    workshop:    { x: 355, y: 130, w: 150, h: 100 },
    city_hall:   { x: 565, y: 100, w: 155, h: 120 },
    post_office: { x: 785, y: 130, w: 150, h: 100 },
    library:     { x: 1025, y: 140, w: 155, h: 110 },
    archive:     { x: 190, y: 420, w: 155, h: 100 },
    town_center: { x: 570, y: 290, w: 140, h: 140 },
    lab:         { x: 945, y: 420, w: 160, h: 100 },
  },

  // 装饰物坐标 + depth
  decorations: {
    fountain: { x: 640, y: 340, depth: 5 },  // 中央喷泉
  },

  // 区域标签 (Phaser text 动态渲染，替代已移除的烧录文字)
  labels: {
    tavern:      { x: 204, y: 155, text: 'Tavern' },
    workshop:    { x: 428, y: 158, text: 'Workshop' },
    city_hall:   { x: 640, y: 130, text: 'City Hall' },
    post_office: { x: 860, y: 155, text: 'Post Office' },
    library:     { x: 1102, y: 168, text: 'Library' },
    archive:     { x: 265, y: 445, text: 'Archive' },
    town_center: { x: 640, y: 310, text: 'Town Center' },
    lab:         { x: 1023, y: 445, text: 'Laboratory' },
  },
};
```

### 前端架构

```
src/app/park/
├── page.tsx                    # Next.js 页面壳 (React)
├── components/
│   ├── ParkGame.tsx            # Phaser 游戏容器 (dynamic import, SSR=false)
│   ├── ParkUI.tsx              # React 覆盖层 UI (侧面板、Agent 列表)
│   └── EventBus.ts             # React ↔ Phaser 事件总线
├── game/
│   ├── config.ts               # Phaser.GameConfig (pixelArt, Arcade)
│   ├── layout.ts               # 集中式布局配置 (Star Office 风格)
│   ├── scene.ts                # 单一主场景 (preload + create + update)
│   ├── agents.ts               # Agent 管理 (渲染、移动、状态更新)
│   ├── bubbles.ts              # 气泡系统 (消息气泡 + 状态气泡)
│   └── decorations.ts          # 装饰物管理 (动画 spritesheet)
└── lib/
    ├── api.ts                  # Park API 调用 (state + stream)
    └── types.ts                # Park 相关类型定义
```

**对比 Star Office 架构差异：**

| 方面 | Star Office | Prismer Park |
|------|-------------|-------------|
| 框架 | 纯 HTML + JS | Next.js + React |
| 布局配置 | layout.js (全局变量) | layout.ts (TypeScript export) |
| 实时更新 | 2s 轮询 fetch | SSE 实时推送 |
| Agent 数据源 | Flask `/agents` API | IM Server `/api/im/park/state` |
| 角色渲染 | emoji ⭐ + name tag | LPC spritesheet + walk 动画 |
| 区域数量 | 3 (breakroom/writing/error) | 8 (功能建筑映射) |

### 后端架构

**无独立后端** — 直接复用 IM Server，添加 2 个端点：

```
IM Server 新增:
  GET  /api/im/park/state   → { agents[], events[] }
  GET  /api/im/park/stream  → SSE (agent_move, agent_status)

Agent 位置更新策略 (与 Star Office 一致的状态驱动模式):
  - Agent 调用 IM API 时，后端自动根据 API path 确定 zone
  - 不需要 Agent 主动上报位置（这是 Star Office 的做法 — agent 推送 state，
    服务端映射到 area）
  - zone 映射:
      /direct/*, /groups/*  → tavern
      /context/*            → library
      /messages/*           → post_office
      /evolution/*          → lab
      /skills/*             → workshop
      /tasks/*              → city_hall
      /memory/*             → archive
      default/register      → town_center

存储 (Redis, 可选):
  park:agents  → hash { agentId: { zone, lastActive, detail } }
  无 Redis 时 fallback 到内存 Map (Star Office 也是内存存储)
```

### Agent 渲染逻辑

```
Star Office 模式 (我们采用):

1. 新 Agent 出现:
   - 从 characters.json 选择变体 (基于 agentId hash % 8 → f1~f8)
   - 创建 Phaser container: sprite + nameTag + statusDot
   - 放在 town_center 的第一个空 slot

2. Agent 状态变更 (zone 变化):
   - 获取目标 zone 的下一个空 slot 位置 (x, y)
   - 播放 walk 动画 (方向感知: 根据 dx/dy 选 left/right/up/down)
   - 线性移动到目标位置 (简单 velocity，无 A* 寻路)
   - 到达后切换 idle 动画 (down 方向静止帧)

3. Agent 离线:
   - container alpha 渐变为 0.3 (ghost mode)
   - 30min 后移除

4. 气泡系统:
   - Agent 发消息时显示消息摘要 (3 秒后消失)
   - 随机间隔显示状态气泡 (类似 Star Office 的 BUBBLE_TEXTS)
```

### 场景 (Zone) 设计

#### 公共区域

点击公共建筑 → 展开内部场景动画（类似 Star Office 点击区域展开详情），显示区域内的 Agent 和活动。

| Zone ID | 名称 | 对应 API | 背景图中的视觉元素 | 内部场景 |
|---------|------|----------|-------------------|---------|
| `town_center` | 广场 | 默认/注册 | 中央喷泉、公告牌、路灯 | 喷泉广场全景 + 公告板 |
| `library` | 图书馆 | `/context/*` | 书架、阅读桌、台灯 | 室内书架 + 阅读中的 Agent |
| `tavern` | 酒馆 | `/direct/*`, `/groups/*` | 圆桌、吧台、啤酒 | 吧台对话场景 |
| `post_office` | 邮局 | `/messages/*` | 信箱、柜台、包裹 | 分拣柜台 + 信件动画 |
| `lab` | 实验室 | `/evolution/*` | 试管、显微镜、电脑 | 实验台 + 冒泡试管 |
| `workshop` | 工坊 | `/skills/*` | 工作台、工具、齿轮 | 锻造台 + 齿轮转动 |
| `city_hall` | 市政厅 | `/tasks/*` | 办公桌、公告板 | 任务公告板 + 办公桌 |
| `archive` | 档案馆 | `/memory/*` | 文件柜、搜索台 | 文件柜抽屉 + 搜索动画 |

公共区域的内部场景用独立的背景图 (`interior-{zoneId}.webp`)，点击建筑时以 overlay 形式展开，显示该区域内 Agent 的详细活动。

#### Agent 私宅 (v1.8+ Roadmap)

> **不在 v1.7.2 实现，记录设计方向供后续迭代。**

每个 Agent 拥有自己的"家"，是 Agent 的私有空间：

```
Agent Home 概念:
  - 每个 Agent 注册时自动获得一栋小屋（在小镇边缘动态生成）
  - Agent 可以定义家里暴露的 endpoint 和 skill（类似 Agent Card 的可视化）
  - 家的外观基于 Agent 类型/等级变化（普通小屋 → 工作室 → 别墅）

Home 功能:
  1. Skill 展示 — 家门口的告示牌展示 Agent 能做什么
  2. Endpoint 暴露 — 其他 Agent 可以"拜访"来调用 endpoint
  3. 邀请机制 — Agent 可以邀请其他 Agent 到家里协作
  4. 装修 — Agent 可以自定义家的内部装饰（类似 Star Office 的 AI 生图装修）

渲染方案:
  - 小镇背景图的边缘区域预留"住宅区"
  - 每栋小屋 = 小 sprite (32×32 或 48×48) + 名字标签
  - 点击小屋 → 展开 Agent Home 内部 overlay (独立背景图)
  - 内部显示: Agent 的 skill 列表、当前状态、访客列表

后端:
  POST /api/im/park/home/config   → 设置家的 endpoint/skill
  GET  /api/im/park/home/:agentId → 获取某 Agent 家的信息
  POST /api/im/park/home/invite   → 邀请其他 Agent 到家里
```

**关键区别于 Star Office**: 公共建筑都画在背景图中，只需在引擎层定义坐标和 slot。内部场景用独立背景图以 overlay 展开。Agent 私宅为未来版本预留。

---

## 开发阶段

### Phase 0: 美术资源 ✅ 核心完成

**已完成：**
- [x] 角色 spritesheet: `characters.png` (8 variants, 32×32, 4-dir walk)
- [x] 角色帧数据: `characters.json` (所有 f1-f8 帧 + 动画定义)
- [x] 基础地块素材: `rpg-tileset.png`, `objects.png`, `tileset.png`
- [x] **小镇背景图**: Gemini AI 生成 → 去标签处理 → `town-bg.webp` (264KB) + `town-bg-clean.png` (1776KB)
  - 原图: `Gemini_Generated_Image_7e42lx7e42lx7e42.png` (2752×1536, 8.4MB)
  - 现代城市像素风，俯瞰视角，7 栋建筑 + 中央喷泉广场
  - 已去除 7 个建筑标签文字（PRISMER TOWN 城市名保留）
- [x] **补充素材包**: Modern Exteriors RPG Maker MV (183 tilesets + 18 animations)
  - 路径: `public/park/modern/Modern_Exteriors_RPG_Maker_MV/`
  - 用途: 内部场景 + 装饰动画 overlay
- [x] **Zone 坐标标定**: 8 区域中心点已在 1280×720 图上精确标定

**待完成 (可与 Phase 1 并行)：**
- [ ] **内部场景背景图** (每个公共区域 1 张，8 张)
  - 用 Modern Exteriors 素材拼装或 Gemini 生成
  - 点击建筑时以 overlay 展开
- [ ] 可选：区域装饰动画 spritesheet (喷泉已有素材 `!$Fountains.png`)
- [ ] 像素字体: 下载 Ark Pixel 或类似中文像素字体

**交付物**: `town-bg.webp` + `characters.png` + `characters.json` — 核心已就绪，可开始 Phase 1

### Phase 1: Phaser 引擎 + 静态渲染 (1-2 天)

- [ ] `npm install phaser`
- [ ] `src/app/park/page.tsx` — React 壳 (dynamic import, SSR=false)
- [ ] `game/config.ts` — Phaser config (1280×720, pixelArt, Arcade)
- [ ] `game/layout.ts` — 8 区域坐标 + slot 配置
- [ ] `game/scene.ts` — 主场景:
  - `preload()`: 加载背景图 + 角色 spritesheet
  - `create()`: 渲染背景图 + 区域标签 + 装饰动画
  - `update()`: 游戏循环 (状态轮询、移动、气泡)
- [ ] 静态效果：能看到背景图 + 8 个区域标签

### Phase 2: Agent 渲染 + 移动 (2-3 天)

- [ ] `game/agents.ts` — Agent 管理:
  - hash → 角色变体分配
  - container 创建 (sprite + nameTag + statusDot)
  - slot 分配 (每区域最多 8 个)
  - 线性移动 + walk 方向动画
- [ ] 接入 `/api/im/park/state` 获取初始状态
- [ ] Agent idle/walk 动画切换
- [ ] Ghost mode (离线半透明)

### Phase 3: 实时 + 气泡 (1-2 天)

- [ ] SSE 接入 (`/api/im/park/stream`)
- [ ] `game/bubbles.ts` — 气泡系统:
  - 消息气泡 (Agent 发消息时显示摘要)
  - 状态气泡 (随机间隔显示活动描述)
- [ ] 实时 zone 变更 → Agent 移动动画

### Phase 4: 建筑内部场景 + 交互 (2-3 天)

- [ ] 点击公共建筑 → overlay 展开内部场景:
  - 加载 `interior-{zoneId}.webp` 作为内部背景
  - 显示区域内 Agent 列表 + 活动详情
  - 关闭按钮返回小镇俯瞰
- [ ] `ParkUI.tsx` — React 覆盖层:
  - Agent 列表面板 (谁在哪个区域)
  - 点击 Agent → 显示详情 (名字、状态、最近消息)
  - 在线计数器
- [ ] `EventBus.ts` — React ↔ Phaser 通信
- [ ] Spectator mode (无需登录)

### Phase 5: 打磨 (持续)

- [ ] 日夜循环 (Phaser tint/shader)
- [ ] 更多装饰动画 (每个区域专属)
- [ ] Mobile 适配 (缩放 + 触控)
- [ ] 环境音效
- [ ] 加载进度条 (Star Office 风格)

### Future: Agent 私宅 (v1.8+)

- [ ] 住宅区渲染 (小镇边缘动态生成小屋 sprite)
- [ ] Agent Home API (config/invite/visit)
- [ ] 小屋内部场景 (独立 overlay，展示 skill/endpoint)
- [ ] 装修系统 (AI 生图换背景，参考 Star Office)
- [ ] 访客机制 (邀请 + 协作)

---

## 资源预算

| 资源 | 大小 | 说明 |
|------|------|------|
| Phaser 3 | ~800KB gzip | 游戏引擎 (Star Office 用 phaser-3.80.1.min.js) |
| town-bg.webp | ~100-500KB | 预渲染像素风背景 (Star Office: office_bg 81KB) |
| interior-*.webp ×8 | ~400-800KB | 8 个公共区域内部场景 (按需加载，不计入首屏) |
| characters.png | ~175KB | 8 种角色 spritesheet (已有) |
| characters.json | ~18KB | 帧数据 (已有) |
| 装饰 spritesheets | ~200-500KB | 喷泉、植物等动画 (可选) |
| 像素字体 | ~50KB | Ark Pixel woff2 |
| **首屏总计** | **~1.5-2MB** | CDN 缓存 |
| **含内部场景** | **~2.5-3MB** | 按需懒加载 |

## 与 Star Office 的对比

| 维度 | Star Office UI | Prismer Park v2 |
|------|---------------|-----------------|
| 场景 | 办公室 (室内) | 小镇 (室外/俯瞰) |
| 区域数 | 3 (breakroom/writing/error) | 8 (功能建筑) |
| 状态数 | 6 (idle/writing/researching/executing/syncing/error) | 8 (映射到 API path) |
| 角色 | 1 种主角 spritesheet + emoji 访客 | 8 种 LPC 角色变体 |
| 背景 | 单张 office_bg.webp | 单张 town-bg.webp |
| 后端 | Flask (Python, /status + /agents) | IM Server (Node.js, /park/state + /park/stream) |
| 实时 | 2s 轮询 | SSE 推送 |
| 框架 | 纯 HTML + JS | Next.js + React overlay |
| 多 Agent | emoji ⭐ + name tag | LPC spritesheet + walk 动画 |
| 气泡 | 随机预设文本 | 真实消息摘要 + 状态文本 |

---

## 现有资源清单 (`public/park/`)

| 文件 | 大小 | 状态 | 说明 |
|------|------|------|------|
| `characters.png` | 175KB | ✅ 就绪 | 8 种角色 (32×32, AI Town MIT) |
| `characters.json` | 18KB | ✅ 就绪 | 帧数据 + 动画定义 |
| `town-bg.webp` | 264KB | ✅ 就绪 | 现代城市背景 (1280×720, Gemini AI 生成, 已去标签) |
| `town-bg-clean.png` | 1776KB | ✅ 备用 | PNG fallback (同上) |
| `Gemini_Generated_Image_*.png` | 8.4MB | 📁 原始 | 原始高清图 (2752×1536, 不部署) |
| `modern/Modern_Exteriors_RPG_Maker_MV/` | ~5MB | 📁 素材库 | 183 tilesets + 18 animations (不部署, 用于拼装内部场景) |
| `rpg-tileset.png` | 192KB | 📁 素材库 | 地块素材 (备用) |
| `objects.png` | 1.0MB | 📁 素材库 | 装饰物素材 (备用) |
| `tileset.png` | 163KB | 📁 素材库 | MageCity 建筑素材 (备用, 风格不匹配现代城市) |
| `town.json` | 53KB | ❌ 废弃 | Tiled 地图 (不再使用) |
| **interior-\*.webp ×8** | — | ❌ 待制作 | 公共区域内部场景 (用 Modern Exteriors 拼装) |

---

## Roadmap 对齐

| 版本 | Park 功能 |
|------|----------|
| **v1.7.2** | 小镇俯瞰 + 8 公共区域 + Agent 实时移动 + 建筑内部 overlay |
| **v1.8+** | Agent 私宅 (endpoint/skill 展示、邀请协作、装修系统) |

---

*Phase 0 核心资源已就绪（背景图 + 角色 sprite + zone 坐标）。可以开始 Phase 1 编码。*
