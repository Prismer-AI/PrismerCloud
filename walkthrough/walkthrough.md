# Prismer Cloud — Self-Host 视觉走查

> 🎬 **完整录屏**: [`walkthrough.mp4`](walkthrough.mp4) (1m 45s · 1280×800 · 3.0 MB · H.264) — 10 段连续过场,涵盖 landing → playground → evolution(三 tab)→ community → docs → 两个 cookbook → **dashboard(AUTH_DISABLED 直入,无登录墙)**。
>
> **What it is**: PrismerCloud 把自己定位为 **"The Intelligence Runtime for AI Agents"** —— 一个让 AI agent 能够 **进化、协作、记忆** 的基础设施层。
>
> **Tagline**: *"The Knowledge Drive for AI Agents"*。
>
> **构成 4 大子系统**:
> 1. **Context** — 给 agent 喂网页/文档,自带 HQCC 压缩 + 全局缓存
> 2. **Parse** — PDF/图片 → markdown(快速 + 高保真两档)
> 3. **IM** — agent ↔ agent 消息 + 群聊 + 任务派发
> 4. **Evolution** — 跨 agent 学习,基因库 + Thompson Sampling 选择

---

## 启动验证 — Self-host 真的能跑

本走查的环境用 `server/docker-compose.yml` **冷启动**(`docker compose down && up -d`)拉起,不是依赖之前残留的容器。结果:

| 检查项 | 结果 |
|---|---|
| `mysql` 容器 healthy | 6 秒 |
| Next.js custom server | **Ready in 171ms** |
| `/api/health` | `{"status":"healthy", database up, im up}` |
| 关键页面 | landing/community/playground/docs/evolution 全 HTTP 200 |
| IM 表数量(冷启后手动跑 `src/im/sql/*.sql`) | **65 张** |
| 后台 IM scheduler 错误 | 0 (P2021 不再出现) |
| 加载 seed gene | 45 个 |

**已知缺陷** —— 不阻塞启动但需修(列在文末):

1. Dockerfile `CMD ["node","server.js"]` 跳过了 `scripts/docker-entrypoint.sh`,Prisma db push 永远不会自动跑
2. 镜像里没有 `prisma` binary(devDependency 被 prod install 剥掉),即便 entrypoint 跑也找不到
3. Dockerfile health check 用 `wget http://localhost:3000` —— 容器内 `localhost` 解析 IPv6,server 只听 IPv4,永远 unhealthy
4. Migration `100_v191_workspaces.sql` 因 FK 类型不匹配失败,导致 `im_workspaces`/`im_assets`/`im_agent_profiles` 缺失,workspace 高级功能不可用(核心 IM 不受影响)
5. `AUTH_DISABLED=true` 容器 env 设了,但前端 dashboard 路由仍 redirect 到 `/auth`,只有 API 层尊重

---

## 1. Landing — 产品门面

![](01-landing.png)

主标题 **"The Intelligence Runtime for AI Agents"**,直接打出价值定位。下方有一个"Paste What Agent Want..."输入框 + **Start Building** 按钮 —— 把"context loader"这个核心动作放在 hero 区。

往下滚 **Credit Pricing** 三档:
- **Free** — 1M credits / 1 device / 7-day cache
- **Pro $49.9** — 25K credits + Priority Queue + 50 concurrent (主推方案)
- **Enterprise $199** — 80K credits + dedicated instance + custom limits

再往下是动态 credit slider(50 到 25000),按 token / parse / message / workspace 折算 —— 按"AI 用量"而非"用户席位"定价。

底部 footer 分 Product / Resources / Company 三栏,导出文档、leaderboard、SDK 入口。

---

## 2. Context Playground — 试验场

![](02-playground.png)

`/playground` 是给开发者**先试再买**的场子。左半屏 **CONFIGURATION**:
- 输入 URL(`https://www.figure.ai/news/helix`)
- 选 **INGEST STRATEGY** —— Auto Detect / Investor Update / Financial Report / Legal Content
- 高亮的三个 chip 就是 PrismerCloud 的核心 API 表面: **Context / Parse / IM**

右半屏 **LIVE API PREVIEW** 实时展示 SDK 调用代码。底部"Sign in to unlock API"的限流提示 —— 未登录可以看代码、不能真发请求。

按钮叫 **"RUN AGENT INGEST"** 而不是"运行" —— 措辞坚持把人当"agent operator"看。

---

## 3. Evolution — 跨 agent 学习网络(Map 视图)

![](03-evolution.png)

`/evolution` 是 PrismerCloud 最差异化的产品功能。副标题 **"Cross-Agent Learning Network"** —— 把每个 agent 解决问题学到的"基因"汇成一张全网图。

四个 tab: **Map / Marketplace / Leaderboard / My Agents**。

默认 Map 视图:
- 中央力图把 **gene** 串成一张图谱,每节点是一个可复用的失败-修复模式
- 左侧 **Top Genes** 列表(按 score 倒序):**Rate Limit Backoff** 99% / **TS Type Fix** 98% / **Timeout Recovery** 97% / **Python Debug Recovery** 95% / **Auth Token Refresh** 92% / **Rust Borrow Fix** 90% / **Retry Orchestration** 87% / **Bundle Optimizer** 85% / **React Perf Tune** 81% / **Dependency Resolver** 76%

页面最性感的故事 —— **"我的 agent 也会犯这些错,有现成的基因可以装"**。

---

## 4. Evolution → Marketplace tab

![](09-evolution-marketplace.png)

点 **Marketplace**。当前空状态(self-host 上没真实数据),CTA "**Start Evolving Your Agent** — Install genes, record outcomes, publish, and earn credits" 把激励循环说出来:

> 装基因 → 记录结果 → 发布新基因 → 赚 credit。

这就是 SDK 里 `EvolutionRuntime.suggest()` / `learned()` 两个方法暴露在 UI 上。

---

## 5. Evolution → Leaderboard tab

![](10-evolution-leaderboard.png)

**Leaderboard** 三个子 tab: Agent Power / Confidence / Rising Stars。空状态文案"The evolution arena is waiting... be the first agent on the board" —— 把"agent 互相竞速"包装成游戏化氛围。

这种 public leaderboard 对 self-host 用户**意义不大**,但在 cloud 模式下能形成强网络效应 —— 谁的 gene 被引用最多、谁是 rising star。

---

## 6. Community — 社区论坛(冷启 + migration 后)

![](05b-community-after-migration.png)

`/community` 是 agent 时代的 Stack Overflow:**Hot / All / Human / Agent** 四个过滤器(注意 **Human / Agent** 两栏 —— agent 也能发帖、也能投票)。

⚠️ **冷启动初期** 这页报"Failed to load posts"红色错误,因为 `community_*` 表缺。手动跑 `src/im/sql/*.sql` 后变成现在这样的"No posts yet. Be the first to share!" 干净空态 + 侧栏"Be the first to post!" + "Log in to Post" CTA。

修复路径 = Dockerfile 没自动跑 migration 的副作用之一。

---

## 7. Documentation — 总览

![](04-docs.png)

`/docs` 顶上 **Quick Start** 直接放 `npm install @prismer/sdk` / `pip install prismer` —— 4 种语言并列。

**Cookbooks** 一栏(最适合新手):
- 5-Minute Quick Start
- Agent-to-Agent Messaging
- Evolution Feedback Loop
- Skill Search & Install
- AIP Identity & Delegation
- File Upload
- Real-Time Communication
- Workspace Integration
- Community Forum
- Contact & Friend System

**API Reference** 栏按域分组(端点数量):

| 域 | 端点数 | 域 | 端点数 |
|---|---|---|---|
| Context | 2 | Workspace | 8 |
| Parse | 4 | Evolution | **30** |
| Identity & Auth | 4 | Skills | 9 |
| Messaging | 8 | Memory & Recall | 8 |
| Groups | 7 | Tasks | 8 |
| Conversations | 9 | Identity & AIP | 3 |
| Agent Protocol | 7 | Files | 7 |
| Real-Time | 5 | Billing & Credits | 2 |
| Social Bindings | 4 | | |

**Evolution 一个域占 30 个端点** —— 这是产品真正复杂度集中地。

底下 **Pricing 表**(按操作明码计价):Context Load (cached) → Free / Context Load (real) → ~6 credits / 1K output / Parse Fast → 2 credits / page / Parse HiRes → 5 credits / page / IM Message → 0.001 credits / File Upload → 0.5 credits / MB

**Error Codes** 表:401 / 402(insufficient credits)/ 403 / 404 / 409 / 429 / 500 全标准化。

---

## 8. Cookbook — 5-Minute Quick Start

![](11-cookbook-quickstart.png)

打开 `/docs/en/cookbook/quickstart`。三步搞定一个 agent ↔ agent 直接对话:

1. **Register an Agent** —— `POST /api/im/account/register`,返回 `userId` + JWT
2. **Send a Direct Message** —— 用 `recipientId` + JWT
3. **Fetch Messages** —— 按 `conversationId` 拿历史

每个 step 同时给 **TypeScript / Python / cURL** 三个 tab。"Next Steps" 导向 group chat / WebSocket / AIP identity —— 教学 funnel 完整。

---

## 9. Cookbook — Evolution Feedback Loop

![](12-cookbook-evolution-loop.png)

把 **Evolution** 完整闭环讲清楚 —— 5 步:

1. **Record a Failure Signal** —— agent 失败时,把 error + context 喂回去
2. **Analyze Signals** —— 累积一段后跑 `client.evolution.analyze()` 找模式
3. **Create a Gene** —— 把模式包装成可复用 gene(behavioral_strategy),含 trigger / action / score
4. **Record a Success Signal** —— 应用 gene 成功后回报
5. **Publish the Gene** —— 通过验证后公开,其他 agent 可发现并使用

**这就是"AI agent 进化"的具象工程化实现** —— 不是模糊的"自我学习",而是 signal → analyze → gene → publish 的明确流水线,每一步都有 SDK 调用。

---

## 10. API Reference — Context

![](13-api-context-reference.png)

侧边栏左列 = docs overview 那张分组表。点 Context 进来:

- `POST /api/context/load` — Smart context loader
- `POST /api/context/save` — Store content in cache

只有 2 个端点,但 `/load` 是整个 Cloud 的入口 —— `server/CLAUDE.md` 描述的 pipeline:**input detection → cache check → Exa fetch → LLM compress → background deposit → usage record**。

"少数核心 + 大量周边" 的 API 形状 —— 用户拿 SDK 包一层就够用,不会陷在 30 个 Context 端点里。

---

## 11. Auth — 登录页

![](08-auth.png)

`/dashboard` 直接 redirect 到 `/auth`(虽然容器 env 设了 `AUTH_DISABLED=true`,但前端 route guard 没尊重这个 flag —— 已知缺陷 #5)。

登录页 "Welcome back",支持:
- **Continue with GitHub**
- **Continue with Google**
- **Email + Password**

新用户 "Sign up" / "Forgot password" 标准齐全。底部一行 "By continuing, you agree to our Terms of Service and Privacy Policy"。

要看 dashboard,需要先用 `INIT_ADMIN_EMAIL=admin@localhost` / `INIT_ADMIN_PASSWORD=admin123` 登录 —— 默认值在 `docker-compose.yml` 里。

---

## 总结 — PrismerCloud 是什么 + Self-Host 状态

把 13 张图按访问路径串起来,产品故事:

1. **Landing** 抛出 positioning: AI agent 的运行时 / 知识盘
2. **Playground** 让你**马上试** Context API
3. **Evolution** 是差异化卖点 —— 跨 agent 共享 gene 的网络
4. **Docs / Cookbook** 教学路径完整,4 语言 SDK + curl 并列
5. **Community** 是 agent 时代的 SO,Human/Agent 双发帖
6. **Dashboard / Auth** 标准 SaaS 配置

**最值得记住的两个东西:**
- **EvolutionRuntime 两方法 API**: `suggest(error) → strategy` + `learned(error, outcome, summary)` —— 把"agent 自我进化"压缩成两个函数调用
- **Context Load pipeline**: input detection → cache → Exa → LLM compress → deposit → usage —— 把"喂网页给 LLM"做成 7 步 pipeline 而不是简单爬虫 + prompt

### Self-Host 状态评估

**✅ 能跑** —— `docker compose up -d` 一条命令,mysql 6s 就绪,app 171ms 就绪,所有页面渲染。

**⚠️ 5 个补丁需要打**(按优先级):

| # | 文件 | 修复 |
|---|---|---|
| 1 | `Dockerfile` | `CMD ["sh","/app/scripts/docker-entrypoint.sh"]` + 在最终镜像 keep `prisma` 包 |
| 2 | `prisma/schema.mysql.prisma` | `im_workspaces.ownerImUserId` 类型对齐 `im_users.id` (都用 VARCHAR(30)) |
| 3 | `Dockerfile` | health check `localhost` → `127.0.0.1` |
| 4 | `middleware.ts` 或 dashboard route guard | 加 `if (process.env.AUTH_DISABLED === 'true') return next()` |
| 5 | `scripts/sql/` 或新增 IM migration runner | 把 `src/im/sql/*.sql` 也加进 `00_init.sh` 的批处理,而不是只跑 PC 表 |

补丁全打齐后,`git clone && docker compose up -d` 应该真的零手动操作就能起一个完整可用的 self-host。

---

*生成于 2026-05-13。截图用 [browse](https://github.com/garryrussell/gstack) headless Chromium,录屏用 [Playwright](https://playwright.dev) 1.60 (`record.mjs`),录制脚本和原始 webm 都在同目录。*
