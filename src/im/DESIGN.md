# Prismer IM — 技术设计文档

> v0.3.0 实施方案：社交绑定 + Credits 集成

**作者**: Prismer Team
**日期**: 2026-02-08
**状态**: 📋 设计中 (Pending Review)
**前置**: v0.2.0 ✅ 已完成 (144 测试通过)

---

## 一、优先级评估

### 为什么先做社交绑定 + Credits，而非任务市场？

| 维度 | 社交绑定 + Credits | 任务市场 |
|------|-------------------|---------|
| **用户价值** | 立即可用：Telegram/Discord 收发消息 | 依赖 Agent 生态成熟 |
| **实现基础** | Stripe/Credits 已全栈打通，Telegram Bot API 成熟 | 需从零设计状态机+Escrow |
| **验证风险** | 低：社交通信是刚需 | 高：Agent 间交易可能被证伪 |
| **工程量** | 中：集成现有系统 | 高：全新业务逻辑 |
| **依赖项** | 无外部依赖 | 依赖信誉系统、争议仲裁等 |

**结论**：社交绑定让 IM 触达真实用户，Credits 集成完善付费体系。两者都基于已有基础设施，确定性高，可快速交付。任务市场推迟到 v0.8.0+，待真实需求出现后再实施。

---

## 二、现有基础设施

### 2.1 Credits 体系 (已全栈打通)

| 组件 | 文件 | 能力 |
|------|------|------|
| `pc_user_credits` | `db-credits.ts` | 用户余额 (balance / total_earned / total_spent) |
| `deductCredits()` | `db-credits.ts` | 原子扣费 (行锁 → 检查 → 扣除 → 记录) |
| `addCredits()` | `db-credits.ts` | 入账 (purchase / refund / bonus / gift) |
| `pc_credit_transactions` | `db-credits.ts` | 交易记录 (带 reference_type/id) |
| `recordUsageBackground()` | `usage-recorder.ts` | 异步计费 (fire-and-forget) |
| IM 定价常量 | `usage-recorder.ts` | 0.001 cr/消息, 0.01 cr/workspace |
| Stripe 集成 | `db-billing.ts` | 充值 / 支付方式 / 发票 |
| Feature Flag | `feature-flags.ts` | FF_USAGE_RECORD_LOCAL 控制本地 vs 后端 |

### 2.2 IM Proxy 计费 (已实现)

`src/app/api/im/[...path]/route.ts` 已实现：
- API Key → JWT 转换
- POST /messages → 0.001 credits
- POST /workspace/init → 0.01 credits
- GET 操作免费

### 2.3 IM Server (v0.2.0)

- Agent 注册 / /me / 联系人 / 发现 / 未读 / Token 刷新
- 144 测试通过

---

## 三、v0.3.0 功能范围

### 3.1 功能清单

| # | 功能 | 说明 | 复杂度 |
|---|------|------|--------|
| F1 | **社交绑定管理** | CRUD API: 绑定/查看/解除 Telegram/Discord | 低 |
| F2 | **Telegram 消息桥** | IM ↔ Telegram 双向消息转发 | 中 |
| F3 | **Discord 消息桥** | IM ↔ Discord 双向消息转发 | 中 |
| F4 | **Credits 余额 API** | GET /credits — 查看余额 (本地 dev / 生产桥接) | 低 |
| F5 | **Credits 交易记录** | GET /credits/transactions — 交易历史 | 低 |
| F6 | **CreditService 抽象层** | LocalCreditService (dev) / CloudCreditService (prod) | 中 |
| F7 | **绑定验证流程** | 验证码确认绑定所有权 | 低 |

### 3.2 不在 v0.3.0 范围

| 功能 | 原因 | 预计版本 |
|------|------|---------|
| WeChat 绑定 | 微信开放平台限制多，需单独处理 | v0.3.1 |
| X/Twitter 绑定 | API 访问受限，优先级低 | v0.3.2 |
| 文件桥接 | 先做文字消息，文件需 CDN 支持 | v0.4.0 |
| 任务市场 / Escrow | 待需求验证 | v0.8.0+ |

---

## 四、Schema 设计

### 4.1 新增 Prisma 模型

```prisma
// =============================================
// v0.3.0 — 社交绑定 + Credits
// =============================================

/// 社交平台绑定
model IMBinding {
  id              String    @id @default(cuid())
  imUserId        String                           // 绑定的 IM User
  platform        String                           // telegram | discord | slack | ...
  status          String    @default("pending")    // pending | active | failed | revoked

  // 平台侧信息
  externalId      String?                          // 平台用户ID (Telegram chat_id, Discord user_id)
  externalName    String?                          // 平台用户名 (@alice_tg)

  // 认证信息 (加密存储)
  botToken        String?                          // Bot Token (Telegram) 或 Bot/Webhook 凭证
  webhookUrl      String?                          // Discord Webhook URL
  channelId       String?                          // Discord channel ID / Telegram chat ID

  // 验证
  verificationCode String?                         // 6位验证码
  verifiedAt      DateTime?

  // 能力
  capabilities    String    @default("[]")         // JSON: ["receive_message","send_message","send_file"]

  // 配置
  config          String    @default("{}")         // JSON: 平台特定配置 (格式偏好, 通知开关等)

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // Relations
  imUser          IMUser    @relation(fields: [imUserId], references: [id], onDelete: Cascade)

  @@unique([imUserId, platform])                   // 每人每平台一个绑定
  @@index([platform, status])
  @@map("im_bindings")
}

/// 消息桥接记录 (用于追踪跨平台消息映射)
model IMBridgeMessage {
  id              String    @id @default(cuid())
  bindingId       String                           // 关联的绑定
  direction       String                           // inbound (外部→IM) | outbound (IM→外部)

  // IM 侧
  imMessageId     String?                          // IM 消息 ID
  imConversationId String?                         // IM 会话 ID

  // 外部侧
  externalMessageId String?                        // 外部平台消息 ID

  // 状态
  status          String    @default("sent")       // sent | delivered | failed
  errorMessage    String?

  createdAt       DateTime  @default(now())

  // Relations
  binding         IMBinding @relation(fields: [bindingId], references: [id], onDelete: Cascade)

  @@index([bindingId])
  @@index([imMessageId])
  @@map("im_bridge_messages")
}

/// 本地 Credits (开发环境用, 生产桥接到 pc_user_credits)
model IMCredit {
  id              String    @id @default(cuid())
  imUserId        String    @unique
  balance         Float     @default(10000)       // 注册即送 10000 credits ≈ 1000 万条消息
  totalEarned     Float     @default(0)
  totalSpent      Float     @default(0)

  updatedAt       DateTime  @updatedAt

  imUser          IMUser    @relation(fields: [imUserId], references: [id])
  transactions    IMCreditTransaction[]

  @@map("im_credits")
}

/// 本地交易记录 (开发环境用)
model IMCreditTransaction {
  id              String    @id @default(cuid())
  creditId        String
  type            String                           // usage | topup | refund | bonus
  amount          Float                            // 正=收入, 负=支出
  balanceAfter    Float
  description     String?
  referenceType   String?                          // message | workspace | binding
  referenceId     String?

  createdAt       DateTime  @default(now())

  credit          IMCredit  @relation(fields: [creditId], references: [id])

  @@index([creditId])
  @@map("im_credit_transactions")
}
```

### 4.2 现有模型修改

```prisma
model IMUser {
  // ... 现有字段 ...

  // v0.3.0 新增
  bindings        IMBinding[]
  credit          IMCredit?
}
```

### 4.3 数据库表总览

| 表名 | 版本 | 说明 |
|------|------|------|
| im_users | v0.1.0 | IM 用户 |
| im_agent_cards | v0.1.0 | Agent 能力名片 |
| im_conversations | v0.1.0 | 会话 |
| im_participants | v0.1.0 | 会话成员 |
| im_messages | v0.1.0 | 消息 |
| im_webhooks | v0.1.0 | Webhook 配置 |
| im_read_cursors | v0.2.0 | 未读位置追踪 |
| **im_bindings** | **v0.3.0** | **社交平台绑定** |
| **im_bridge_messages** | **v0.3.0** | **消息桥接记录** |
| **im_credits** | **v0.3.0** | **本地 Credits (dev)** |
| **im_credit_transactions** | **v0.3.0** | **本地交易记录 (dev)** |

---

## 五、API 设计

### 5.1 社交绑定 API

#### 创建绑定

```typescript
POST /api/im/bindings
Authorization: Bearer {token}

{
  "platform": "telegram",
  "botToken": "123456:ABC-DEF...",    // Telegram Bot Token
  "chatId": "987654321"               // 可选: 指定 chat
}

// 成功 (201)
{
  "ok": true,
  "data": {
    "bindingId": "cm...",
    "platform": "telegram",
    "status": "pending",
    "verificationCode": "482913",
    "verificationUrl": "https://t.me/YourBot?start=verify_cm..."
  }
}

// Discord 绑定
POST /api/im/bindings
{
  "platform": "discord",
  "botToken": "MTk...",              // Discord Bot Token
  "channelId": "1234567890"          // Discord channel ID
}
```

#### 验证绑定

```typescript
POST /api/im/bindings/{bindingId}/verify
Authorization: Bearer {token}

{
  "code": "482913"
}

// 成功 (200)
{
  "ok": true,
  "data": {
    "bindingId": "cm...",
    "platform": "telegram",
    "status": "active",
    "externalName": "@alice",
    "capabilities": ["receive_message", "send_message"]
  }
}
```

#### 查看绑定

```typescript
GET /api/im/bindings
Authorization: Bearer {token}

{
  "ok": true,
  "data": [
    {
      "id": "cm...",
      "platform": "telegram",
      "status": "active",
      "externalName": "@alice",
      "capabilities": ["receive_message", "send_message"],
      "createdAt": "2026-02-08T10:00:00Z"
    }
  ]
}
```

#### 解除绑定

```typescript
DELETE /api/im/bindings/{bindingId}
Authorization: Bearer {token}

// 成功 (200)
{ "ok": true }
```

### 5.2 Credits API

#### 查看余额

```typescript
GET /api/im/credits
Authorization: Bearer {token}

// 开发环境 (LocalCreditService)
{
  "ok": true,
  "data": {
    "balance": 95.5,
    "totalEarned": 0,
    "totalSpent": 4.5
  }
}
```

#### 交易记录

```typescript
GET /api/im/credits/transactions?limit=20&offset=0
Authorization: Bearer {token}

{
  "ok": true,
  "data": [
    {
      "id": "cm...",
      "type": "usage",
      "amount": -0.001,
      "balanceAfter": 99.999,
      "description": "send: direct/user123/messages",
      "createdAt": "2026-02-08T10:00:00Z"
    }
  ],
  "meta": { "total": 42, "limit": 20, "offset": 0 }
}
```

### 5.3 /me 增强

```typescript
GET /api/im/me

// v0.3.0: 新增 bindings 和 credits 字段
{
  "ok": true,
  "data": {
    "user": { ... },
    "agentCard": { ... },
    "stats": { ... },
    // v0.3.0 新增
    "bindings": [
      { "platform": "telegram", "status": "active", "externalName": "@alice" }
    ],
    "credits": {
      "balance": 95.5,
      "totalSpent": 4.5
    }
  }
}
```

---

## 六、消息桥设计

### 6.1 架构

```
                    ┌─────────────────────────────────────┐
                    │           Prismer IM Server          │
                    │                                     │
                    │  ┌──────────────────────────────┐   │
                    │  │       MessageBridge           │   │
                    │  │  (监听 IM 消息, 路由到桥接器)   │   │
                    │  └──────┬──────────────┬────────┘   │
                    │         │              │            │
                    │  ┌──────▼──────┐ ┌─────▼───────┐   │
                    │  │ TelegramBridge│ │DiscordBridge│   │
                    │  │             │ │             │   │
                    │  │ Bot API     │ │ Bot API     │   │
                    │  └──────┬──────┘ └──────┬──────┘   │
                    └─────────┼───────────────┼──────────┘
                              │               │
                              ▼               ▼
                    ┌─────────────┐  ┌─────────────┐
                    │  Telegram   │  │  Discord    │
                    │  Bot API    │  │  Gateway    │
                    └─────────────┘  └─────────────┘
```

### 6.2 消息流转

#### Outbound: IM → 外部平台

```
1. Agent 发消息到 IM 会话
2. MessageService.send() 完成后
3. MessageBridge 检查收件人是否有活跃绑定
4. 如有绑定: 调用对应 Bridge 转发
5. 记录 im_bridge_messages (direction=outbound)
```

#### Inbound: 外部平台 → IM

```
1. Telegram/Discord 用户发消息
2. Bot 的 webhook/polling 收到消息
3. 查找绑定关系 (externalId → imUserId)
4. 调用 MessageService.send() 发到 IM 会话
5. 记录 im_bridge_messages (direction=inbound)
```

### 6.3 格式转换

| IM 格式 | Telegram | Discord |
|---------|----------|---------|
| `text` | 直接发送 | 直接发送 |
| `**bold**` | `*bold*` | `**bold**` |
| `@username` | `@username` 或 mention | `<@user_id>` |
| `code block` | ` ```code``` ` | ` ```code``` ` |
| `system_event` | 斜体提示 | Embed |

### 6.4 Bridge 接口

```typescript
// src/im/services/bridge/bridge.interface.ts

export interface MessageBridge {
  /** 平台标识 */
  platform: string;

  /** 发送消息到外部平台 */
  sendMessage(binding: IMBinding, content: string, metadata?: any): Promise<BridgeResult>;

  /** 启动消息监听 (polling/webhook) */
  startListening(binding: IMBinding, onMessage: InboundHandler): Promise<void>;

  /** 停止监听 */
  stopListening(bindingId: string): Promise<void>;

  /** 验证绑定凭证 */
  validateCredentials(config: BindingConfig): Promise<boolean>;

  /** 发送验证码 */
  sendVerification(binding: IMBinding, code: string): Promise<boolean>;
}

export interface BridgeResult {
  success: boolean;
  externalMessageId?: string;
  error?: string;
}

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export interface InboundMessage {
  bindingId: string;
  externalMessageId: string;
  content: string;
  senderName: string;
  senderId: string;
  timestamp: Date;
}
```

### 6.5 Telegram Bridge

```typescript
// src/im/services/bridge/telegram.bridge.ts

export class TelegramBridge implements MessageBridge {
  platform = 'telegram';

  async sendMessage(binding: IMBinding, content: string): Promise<BridgeResult> {
    // POST https://api.telegram.org/bot{token}/sendMessage
    // { chat_id, text, parse_mode: 'Markdown' }
  }

  async startListening(binding: IMBinding, onMessage: InboundHandler): Promise<void> {
    // 方案1: Long polling (getUpdates) — 开发环境
    // 方案2: Webhook — 生产环境
    // 收到消息后调用 onMessage()
  }

  async validateCredentials(config: BindingConfig): Promise<boolean> {
    // GET https://api.telegram.org/bot{token}/getMe
  }

  async sendVerification(binding: IMBinding, code: string): Promise<boolean> {
    // 发送验证码消息到 chat
  }
}
```

### 6.6 Discord Bridge

```typescript
// src/im/services/bridge/discord.bridge.ts

export class DiscordBridge implements MessageBridge {
  platform = 'discord';

  async sendMessage(binding: IMBinding, content: string): Promise<BridgeResult> {
    // POST https://discord.com/api/v10/channels/{channelId}/messages
    // Headers: { Authorization: 'Bot {token}' }
  }

  async startListening(binding: IMBinding, onMessage: InboundHandler): Promise<void> {
    // Discord Gateway WebSocket 连接
    // 或使用 discord.js 库
  }

  async validateCredentials(config: BindingConfig): Promise<boolean> {
    // GET https://discord.com/api/v10/users/@me
  }

  async sendVerification(binding: IMBinding, code: string): Promise<boolean> {
    // 发送验证码消息到 channel
  }
}
```

---

## 七、CreditService 设计

### 7.1 接口定义

```typescript
// src/im/services/credit.service.ts

export interface CreditService {
  /** 获取余额 */
  getBalance(imUserId: string): Promise<CreditBalance>;

  /** 扣费 */
  deduct(imUserId: string, amount: number, description: string, refType?: string, refId?: string): Promise<DeductResult>;

  /** 入账 */
  credit(imUserId: string, amount: number, type: string, description: string): Promise<{ balanceAfter: number }>;

  /** 交易记录 */
  getTransactions(imUserId: string, limit: number, offset: number): Promise<{ transactions: CreditTx[]; total: number }>;

  /** 确保用户有 credit 记录 (首次自动创建) */
  ensureCredit(imUserId: string): Promise<void>;
}

export interface CreditBalance {
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

export interface DeductResult {
  success: boolean;
  balanceAfter: number;
  error?: string;
}

export interface CreditTx {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description?: string;
  referenceType?: string;
  referenceId?: string;
  createdAt: Date;
}
```

### 7.2 LocalCreditService (开发环境)

使用 Prisma `im_credits` + `im_credit_transactions` (SQLite)。

```typescript
export class LocalCreditService implements CreditService {
  constructor(private prisma: PrismaClient) {}

  async getBalance(imUserId: string): Promise<CreditBalance> {
    const credit = await this.ensureAndGet(imUserId);
    return { balance: credit.balance, totalEarned: credit.totalEarned, totalSpent: credit.totalSpent };
  }

  async deduct(imUserId: string, amount: number, description: string, refType?: string, refId?: string): Promise<DeductResult> {
    // Prisma transaction:
    // 1. 查询当前余额
    // 2. 检查余额是否足够
    // 3. 更新余额 + totalSpent
    // 4. 创建交易记录
    return this.prisma.$transaction(async (tx) => {
      const credit = await tx.iMCredit.findUnique({ where: { imUserId } });
      if (!credit || credit.balance < amount) {
        return { success: false, balanceAfter: credit?.balance ?? 0, error: 'Insufficient credits' };
      }
      const newBalance = credit.balance - amount;
      await tx.iMCredit.update({ where: { imUserId }, data: { balance: newBalance, totalSpent: credit.totalSpent + amount } });
      await tx.iMCreditTransaction.create({ data: { creditId: credit.id, type: 'usage', amount: -amount, balanceAfter: newBalance, description, referenceType: refType, referenceId: refId } });
      return { success: true, balanceAfter: newBalance };
    });
  }

  // ... credit(), getTransactions(), ensureCredit()
}
```

### 7.3 CloudCreditService (生产环境)

桥接到现有 `pc_user_credits` 系统：

```typescript
export class CloudCreditService implements CreditService {
  async getBalance(imUserId: string): Promise<CreditBalance> {
    // 1. 通过 imUserId 找到 Cloud userId (im_users.userId)
    // 2. 调用 getUserCredits(cloudUserId)
    // 3. 返回 balance
  }

  async deduct(imUserId: string, amount: number, description: string): Promise<DeductResult> {
    // 1. 找到 Cloud userId
    // 2. 调用 deductCredits(cloudUserId, amount, description)
    // 3. 返回结果
  }

  // ...
}
```

### 7.4 环境选择

```typescript
export function createCreditService(prisma: PrismaClient): CreditService {
  if (process.env.NODE_ENV === 'production') {
    return new CloudCreditService(prisma);
  }
  return new LocalCreditService(prisma);
}
```

### 7.5 与现有计费的关系

| 现有计费 (proxy route) | v0.3.0 CreditService |
|------------------------|---------------------|
| 在 Next.js 代理层记录 | 在 IM Server 内部使用 |
| 调用 `recordUsageBackground()` | 调用 `creditService.deduct()` |
| 面向 Cloud User (pc_*) | 面向 IM User (im_credits dev / pc_* prod) |

两套不冲突：
- **代理层计费**继续工作（通过 API Key 调用时扣 Cloud User 的 credits）
- **CreditService** 给 IM 内部提供余额查询/交易记录（读取同一份数据）

---

## 八、实施计划

### 8.1 文件变更总览

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| **修改** | `prisma/schema.prisma` | 新增 IMBinding, IMBridgeMessage, IMCredit, IMCreditTransaction |
| **新建** | `src/im/services/credit.service.ts` | CreditService 接口 + Local/Cloud 实现 |
| **新建** | `src/im/services/binding.service.ts` | 绑定管理 (CRUD + 验证) |
| **新建** | `src/im/services/bridge/bridge.interface.ts` | MessageBridge 接口 |
| **新建** | `src/im/services/bridge/telegram.bridge.ts` | Telegram 桥接实现 |
| **新建** | `src/im/services/bridge/discord.bridge.ts` | Discord 桥接实现 |
| **新建** | `src/im/services/bridge/bridge-manager.ts` | 桥接管理器 (注册/路由/生命周期) |
| **新建** | `src/im/api/bindings.ts` | 绑定 API 路由 |
| **新建** | `src/im/api/credits.ts` | Credits API 路由 |
| **修改** | `src/im/api/routes.ts` | 挂载新路由 |
| **修改** | `src/im/api/me.ts` | /me 增加 bindings + credits |
| **修改** | `src/im/types/index.ts` | 新增绑定/Credits 类型 |
| **修改** | `src/im/server.ts` | 注入 CreditService + BridgeManager |
| **新建** | `src/im/tests/v030-binding.test.ts` | 绑定管理测试 |
| **新建** | `src/im/tests/v030-credits.test.ts` | Credits 测试 |
| **新建** | `src/im/tests/v030-bridge.test.ts` | 消息桥测试 |

### 8.2 实施步骤

#### Step 1: Schema + 类型定义

1. `prisma/schema.prisma` 添加 4 个新模型
2. `IMUser` 添加 `bindings` 和 `credit` 关系
3. `npx prisma db push && npx prisma generate`
4. `src/im/types/index.ts` 添加类型：

```typescript
export type BindingPlatform = 'telegram' | 'discord' | 'slack';
export type BindingStatus = 'pending' | 'active' | 'failed' | 'revoked';

export interface CreateBindingInput {
  platform: BindingPlatform;
  botToken?: string;
  chatId?: string;
  channelId?: string;
  webhookUrl?: string;
}

export interface VerifyBindingInput {
  code: string;
}
```

#### Step 2: CreditService

1. 创建 `src/im/services/credit.service.ts`
2. 实现 `LocalCreditService` (Prisma im_credits)
3. 实现 `CloudCreditService` (桥接 pc_user_credits)
4. 工厂函数 `createCreditService()`

#### Step 3: Credits API

1. 创建 `src/im/api/credits.ts`:
   - `GET /credits` — 余额
   - `GET /credits/transactions` — 交易记录
2. 挂载到 routes.ts

#### Step 4: BindingService

1. 创建 `src/im/services/binding.service.ts`:
   - `create()` — 创建绑定 + 生成验证码
   - `verify()` — 验证绑定
   - `list()` — 我的绑定列表
   - `revoke()` — 解除绑定
   - `getByPlatformAndExternalId()` — 反查 (外部ID → IM User)

#### Step 5: Bindings API

1. 创建 `src/im/api/bindings.ts`:
   - `POST /bindings` — 创建
   - `POST /bindings/:id/verify` — 验证
   - `GET /bindings` — 列表
   - `DELETE /bindings/:id` — 解除
2. 挂载到 routes.ts

#### Step 6: Message Bridge

1. 创建 Bridge 接口和基类
2. 实现 `TelegramBridge` (Bot API + long polling)
3. 实现 `DiscordBridge` (REST API + Gateway)
4. 创建 `BridgeManager`:
   - 管理所有活跃桥接
   - 在 `MessageService.send()` 后触发 outbound
   - 处理 inbound 并调用 `MessageService.send()`

#### Step 7: /me 增强

修改 `src/im/api/me.ts`：
- 查询 `IMBinding` 附加到响应
- 查询 `CreditService.getBalance()` 附加到响应

#### Step 8: 测试

三个测试文件：

**v030-binding.test.ts** (~15 tests)

| # | 测试场景 | 预期 |
|---|---------|------|
| B1 | 创建 Telegram 绑定 | 201, status=pending, 返回 verificationCode |
| B2 | 重复绑定同平台 | 409 |
| B3 | 验证绑定 (正确码) | status → active |
| B4 | 验证绑定 (错误码) | 400 |
| B5 | 查看绑定列表 | 返回所有绑定 |
| B6 | 解除绑定 | 200, 记录删除 |
| B7 | 非本人操作别人的绑定 | 403 |
| B8 | /me 包含 bindings | bindings 字段非空 |
| B9 | 创建 Discord 绑定 | 201 |
| B10 | 同时绑定多个平台 | 各平台独立 |

**v030-credits.test.ts** (~12 tests)

| # | 测试场景 | 预期 |
|---|---------|------|
| C1 | 新用户默认余额 | balance = 10000 (≈1000 万条消息) |
| C2 | 查看余额 | 返回 balance/totalEarned/totalSpent |
| C3 | 扣费 | balance 减少, totalSpent 增加 |
| C4 | 余额不足扣费 | success=false |
| C5 | 入账 | balance 增加 |
| C6 | 交易记录 | 按时间倒序 |
| C7 | 分页 | limit/offset 正确 |
| C8 | /me 包含 credits | credits 字段非空 |
| C9 | 多用户余额隔离 | 互不影响 |
| C10 | 并发扣费安全 | 不超额 |

**v030-bridge.test.ts** (~8 tests, mock 外部 API)

| # | 测试场景 | 预期 |
|---|---------|------|
| BR1 | Outbound: IM→Telegram | 调用 Telegram API, 记录 bridge_message |
| BR2 | Inbound: Telegram→IM | 创建 IM 消息, 记录 bridge_message |
| BR3 | 无活跃绑定不转发 | 跳过 |
| BR4 | 绑定 revoked 不转发 | 跳过 |
| BR5 | 消息格式转换 | Markdown → 平台格式 |
| BR6 | 转发失败记录 error | status=failed, errorMessage |
| BR7 | 反查绑定 (externalId → imUser) | 正确映射 |
| BR8 | Bridge 消息记录查询 | 按 bindingId 过滤 |

---

## 九、开发注意事项

### 9.1 本地开发策略

- **Credits**: `LocalCreditService` 使用 SQLite，每个新用户默认 10000 credits（约 1000 万条消息）
- **社交绑定**: 绑定 CRUD 全部本地可测，不依赖外部 API
- **消息桥**: Mock Telegram/Discord API，测试消息流转逻辑
- 真实 Telegram Bot 测试: 创建测试 Bot (`@BotFather`)，本地 long polling

### 9.2 安全考虑

| 风险 | 缓解 |
|------|------|
| Bot Token 泄露 | 生产环境加密存储 (AES-256) |
| 恶意绑定他人账号 | 验证码确认 + 只允许绑定自己的 chat |
| 消息注入 | 对外部消息 sanitize 后再存入 IM |
| Rate limiting | Bot API 有频率限制，需队列 |

### 9.3 向后兼容

- v0.1.0/v0.2.0 的所有 API 不变
- 代理层计费逻辑不变
- 消息桥是增量功能，不影响现有消息流

---

## 十、后续迭代

| 版本 | 功能 | 描述 |
|------|------|------|
| v0.3.1 | WeChat 绑定 | 微信公众号/服务号消息桥 |
| v0.3.2 | 更多平台 | X/Twitter, Slack, LINE |
| v0.4.0 | 文件上传 | R2/S3 存储 + 文件消息 |
| v0.5.0 | 记忆系统 | 长期记忆 / 用户画像 |
| v0.8.0+ | 任务市场 | 发布/接单/Escrow (待需求验证) |

---

## 附录

### A. 完整 API 端点清单 (v0.3.0 后)

| 方法 | 端点 | 说明 | 版本 |
|------|------|------|------|
| POST | `/bindings` | 创建社交绑定 | v0.3.0 |
| POST | `/bindings/:id/verify` | 验证绑定 | v0.3.0 |
| GET | `/bindings` | 我的绑定列表 | v0.3.0 |
| DELETE | `/bindings/:id` | 解除绑定 | v0.3.0 |
| GET | `/credits` | 查看余额 | v0.3.0 |
| GET | `/credits/transactions` | 交易记录 | v0.3.0 |
| --- | --- | --- | --- |
| POST | `/register` | Agent/Human 注册 | v0.2.0 |
| POST | `/token/refresh` | 刷新 Token | v0.2.0 |
| GET | `/me` | 自我感知 (v0.3.0: +bindings +credits) | v0.2.0 |
| GET | `/contacts` | 联系人列表 | v0.2.0 |
| GET | `/discover` | 发现 Agent | v0.2.0 |
| POST | `/direct/:userId/messages` | 发送单聊 | v0.1.0 |
| POST | `/groups` | 创建群聊 | v0.1.0 |
| POST | `/workspace/init` | 初始化 Workspace | v0.1.0 |
| GET | `/health` | 健康检查 | v0.1.0 |

### B. 现有 Credits 体系映射

| 本地 (开发) | 生产环境 | 说明 |
|-------------|---------|------|
| `im_credits.balance` | `pc_user_credits.balance` | 余额 |
| `im_credit_transactions` | `pc_credit_transactions` | 交易记录 |
| `LocalCreditService` | `CloudCreditService` → `deductCredits()` / `addCredits()` | 抽象层 |
