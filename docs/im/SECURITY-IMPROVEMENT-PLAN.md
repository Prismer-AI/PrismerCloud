# 安全改进计划 — v1.7.2 全量交付

**Version:** 2.0
**Date:** 2026-03-23
**Status:** 📋 待审阅
**目标版本：** v1.7.2（Phase 1-3 全部在本版本完成）
**前置审计：** 基于 v1.7.2 代码库全面审计（evolution.service.ts 135 处 prisma 调用、87 处无 scope 查询）

---

## 一、影响面分析（不变）

### 1.1 Scope 隔离：87 个无过滤查询

| 表                    | 总查询数 | 有 scope 过滤 | 无 scope 过滤 | 风险 |
| --------------------- | -------- | ------------- | ------------- | ---- |
| im_evolution_edges    | 21       | 0             | 21 (100%)     | 🔴   |
| im_evolution_capsules | 35+      | 0             | 35+ (100%)    | 🔴   |
| im_genes              | 27+      | 0             | 27+ (100%)    | 🔴   |
| im_unmatched_signals  | 4        | 0             | 4 (100%)      | 🟡   |
| **合计**              | **87+**  | **0**         | **87+**       |      |

**对照组：** Memory 服务已正确实现 scope 过滤（4/5 查询有 scope），是正面参考。

### 1.2 消息加密：签名有、加密半成品

| 层                     | 实现                    | 服务端行为                 |
| ---------------------- | ----------------------- | -------------------------- |
| 身份密钥 (Ed25519)     | ✅ 完整                 | 公钥注册+轮换+撤销+审计链  |
| 消息签名 (Ed25519)     | ✅ 完整                 | 签名验证+防重放+hash chain |
| 消息加密 (AES-256-GCM) | ⚠️ SDK 有，服务端仅标记 | 不验证密文格式，不存密钥   |

### 1.3 访问控制：2 层未激活

| 机制                     | 代码状态                       | 接入状态      |
| ------------------------ | ------------------------------ | ------------- |
| Rate Limiting (5 级阈值) | ✅ 完整 (service + middleware) | ❌ 未接入路由 |
| Trust Tiers (0-4)        | ✅ 字段+Rate Limit 读取        | ❌ 无管理 API |
| Conversation Policy      | ⚠️ 表+服务有                   | ❌ API 占位   |
| Evolution ACL            | ❌ 表有，零代码                | ❌ 未实施     |

---

## 二、v1.7.2 交付计划

### 设计原则

1. **Phase 1 最快交付** — 已有代码只需接线，1 天内完成
2. **Phase 2 精简裁剪** — 只做服务端能控制的部分，SDK auto-encrypt 推迟
3. **Phase 3 分层策略** — 不逐改 87 个查询，用 scope helper + 分类处理

### Phase 1: 激活已有安全机制（~1.5 天）

**全部是接线工作，零新代码设计。**

#### P1.1 Rate Limiting 接入路由（0.5 天）

已有代码：

- `src/im/services/rate-limiter.service.ts` — 完整实现（内存滑动窗口 + DB 持久化）
- `src/im/middleware/rate-limit.ts` — 完整中间件（headers + 429 + 违规记录）

待做：在 `routes.ts` 的 `createApiRouter()` 中挂载到关键路由：

```typescript
// 只需在 routes.ts 加 ~15 行
const rl = (action: string) => createRateLimitMiddleware(rateLimiter, action);

// 高频写入路由
messagesRouter.post('*', rl('message.send')); // 消息发送
registerRouter.post('*', rl('agent.register')); // Agent 注册
filesRouter.post('*', rl('file.upload')); // 文件上传

// Evolution 防刷
evolutionRouter.post('/analyze', rl('tool_call')); // Gene 分析
evolutionRouter.post('/record', rl('tool_call')); // Outcome 记录
evolutionRouter.post('/report', rl('tool_call')); // 异步报告

// Task 防刷
tasksRouter.post('/', rl('conversation.create')); // 创建任务
```

**Tier 阈值（已实现）：**

| 操作           | Tier 0 (新) | Tier 1 (用户) | Tier 2 (强) | Tier 3 (组织) | Tier 4 (平台) |
| -------------- | ----------- | ------------- | ----------- | ------------- | ------------- |
| message.send   | 10/min      | 60/min        | 300/min     | 1000/min      | ∞             |
| tool_call      | 2/min       | 10/min        | 50/min      | 200/min       | ∞             |
| agent.register | 1/min       | 5/min         | 10/min      | 20/min        | ∞             |
| file.upload    | 2/min       | 10/min        | 30/min      | 100/min       | ∞             |

#### P1.2 Trust Tier 管理 API（0.5 天）

```
PATCH /api/im/admin/users/:id/trust-tier
  Body: { "trustTier": 2 }
  Auth: admin only (白名单)
  Effect: 更新 IMUser.trustTier，立即生效于下次 Rate Limit 检查

GET /api/im/admin/users/:id/violations
  Auth: admin only
  Returns: 违规历史列表
```

#### P1.3 Conversation Policy API（0.5 天）

把 `policies.ts` 占位实现为完整 CRUD：

```
POST   /api/im/conversations/:id/policies    添加规则 (allow/deny)
GET    /api/im/conversations/:id/policies    列出规则
DELETE /api/im/conversations/:id/policies/:policyId   删除规则
```

已有 `ContextAccessService.checkConversationPolicy()` 实现，只缺 API 路由。

### Phase 2: 加密服务端强化（~2 天）

**只做服务端能控制的部分。SDK auto-encrypt 模式不在 v1.7.2 范围。**

#### P2.1 加密模式管理 API（0.5 天）

```
GET    /api/im/conversations/:id/security     查看安全设置
PATCH  /api/im/conversations/:id/security     更新安全设置
  Body: {
    "encryptionMode": "required",     // none | available | required
    "signingPolicy": "required"       // optional | recommended | required
  }
```

`im_conversation_security` 表已有，只缺暴露 API。

#### P2.2 密钥交换协助（1 天）

服务端只存公钥，不参与解密：

```
POST   /api/im/conversations/:id/keys        上传 ECDH 公钥
GET    /api/im/conversations/:id/keys        获取所有成员公钥
DELETE /api/im/conversations/:id/keys/:keyId  撤销公钥
```

Schema 变更（im_conversation_security 已有表，加字段）：

```prisma
model IMConversationSecurity {
  // ...现有字段...
  ephemeralKeys   String    @default("[]")   // JSON: [{ userId, publicKey, algorithm, createdAt }]
}
```

流程：

1. Agent A 创建加密对话 → 生成 ECDH P-256 密钥对 → 上传公钥到 `/keys`
2. Agent B 加入 → `GET /keys` 获取 A 的公钥 → 本地 ECDH 协商 → 上传自己的公钥
3. 服务端只存公钥，不参与解密
4. 群组场景：发送者为每个成员单独 ECDH → 附加加密后的 session key

#### P2.3 加密消息格式验证 + Context Ref 头检查（0.5 天）

```typescript
// message.service.ts 增强
if (input.metadata?.encrypted === true) {
  // 1. 验证 content 是合法 Base64（至少看起来是密文）
  if (!isValidBase64(input.content) || input.content.length < 32) {
    throw new Error('Encrypted message content must be valid Base64 ciphertext');
  }

  // 2. 加密消息的 contextRefs 必须在 metadata 头（明文）中声明
  // 服务端验证头中声明的 URI，而非无法解密的 content
  if (input.metadata?.contextRefs && Array.isArray(input.metadata.contextRefs)) {
    const access = await this.contextAccessService.validateAccess(input.senderId, input.metadata.contextRefs);
    if (!access.allowed) {
      throw new Error(`Context access denied: ${access.deniedRefs.join(', ')}`);
    }
  }
}
```

同时：Recall API 对 `encrypted=true` 的消息跳过内容搜索。Webhook payload 加 `encrypted: true` 标记。

### Phase 3: Scope 多租户隔离（~3 天）

#### 策略：不逐改 87 个查询

87 个查询逐一修改既耗时又易遗漏。采用分层策略：

```
Layer A: 写入拦截（所有 CREATE/UPSERT 自动注入 scope）     ← 确保新数据有 scope
Layer B: 关键读查询加 scope（API 直接暴露的 ~20 个查询）   ← 防止数据泄漏
Layer C: 内部聚合查询保持全局（Pooled Prior、Freeze 等）   ← 设计意图就是跨 Agent
```

#### P3.1 Scope 基础设施（0.5 天）

**Scope 解析中间件：**

```typescript
// src/im/middleware/scope.ts
// 从 Auth context 推导 scope，注入 Hono context

export function scopeMiddleware() {
  return async (c: Context, next: Next) => {
    const user = c.get('user');
    // 优先级：metadata.scope > API Key 绑定 > 默认
    const scope = user?.metadata?.scope || user?.scope || 'global';
    c.set('scope', scope);
    return next();
  };
}
```

**Scope helper 函数：**

```typescript
// src/im/utils/scope.ts
// 给查询 where 条件注入 scope 过滤

export function withScope(where: Record<string, any>, scope: string): Record<string, any> {
  if (scope === 'global') return where; // 全局不加过滤
  return { ...where, scope: { in: [scope, 'global'] } };
}

export function withScopeCreate(data: Record<string, any>, scope: string): Record<string, any> {
  return { ...data, scope };
}
```

#### P3.2 写入拦截 — Layer A（1 天）

**所有 CREATE 操作自动设置 scope。** 涉及的服务方法：

| 服务              | 方法                      | 表                | 改动                                                        |
| ----------------- | ------------------------- | ----------------- | ----------------------------------------------------------- |
| evolution.service | `recordOutcome()`         | capsules, edges   | `create({ ...data, scope })`                                |
| evolution.service | `createGene()/saveGene()` | genes             | `create({ ...data, scope })`                                |
| evolution.service | `trackUnmatchedSignal()`  | unmatched_signals | `upsert({...create: { scope }})`                            |
| task.service      | `createTask()`            | tasks             | `create({ ...data, scope })` — 需先给 IMTask 加 scope 字段  |
| event-bus.service | `create()`                | subscriptions     | `create({ ...data, scope })` — 需给 IMSubscription 加 scope |

**Schema 变更：**

```prisma
// im_tasks 加 scope
model IMTask {
  // ...现有字段...
  scope           String    @default("global")
  @@index([scope])
}

// im_subscriptions 加 scope
model IMSubscription {
  // ...现有字段...
  scope           String    @default("global")
  @@index([scope])
}
```

#### P3.3 关键读查询 — Layer B（1 天）

**只改 API 直接暴露的读查询**（用户能直接看到返回数据的）：

| API 路由                          | 服务方法                  | 加 scope 过滤          |
| --------------------------------- | ------------------------- | ---------------------- |
| `GET /evolution/genes`            | `listGenes()`             | ✅                     |
| `GET /evolution/map`              | `getMapData()`            | ✅                     |
| `GET /evolution/edges`            | `getEdges()`              | ✅                     |
| `GET /evolution/report`           | `getReport()`             | ✅                     |
| `GET /evolution/public/*`         | `getPublicStats/Hot/Feed` | ✅ scope='global' 专用 |
| `POST /evolution/analyze`         | `selectGene()` 候选加载   | ✅                     |
| `GET /evolution/public/unmatched` | `getUnmatchedSignals()`   | ✅                     |
| `GET /tasks`                      | `listTasks()`             | ✅                     |
| `GET /subscriptions`              | `findBySubscriber()`      | ✅                     |

**约 15-20 处改动**，使用 `withScope(where, scope)` helper，每处 1 行代码。

#### P3.4 内部聚合查询 — Layer C（不改）

以下查询 **故意保持全局**，因为它们的语义就是跨 Agent 聚合：

| 查询                                                   | 理由                        |
| ------------------------------------------------------ | --------------------------- |
| Pooled Prior 全局聚合 `groupBy({ by: ['geneId'] })`    | 跨 Agent 知识共享是核心功能 |
| Freeze Mode 全局计算 `count({ where: { createdAt } })` | 平台级安全机制              |
| Signal Clustering `findMany({ where: { outcome } })`   | 全局信号模式发现            |
| Capsule Quality 计算                                   | 质量评估不分租户            |
| Seed Gene 加载 `findMany({ visibility: 'seed' })`      | Seed Gene 平台公共          |

**但这些查询需要在多租户模式下加 scope 条件**。通过环境变量控制：

```typescript
// scope.ts
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';

export function withScope(where: any, scope: string): any {
  if (!MULTI_TENANT || scope === 'global') return where;
  return { ...where, scope: { in: [scope, 'global'] } };
}
```

当前 `MULTI_TENANT=false`（默认），Layer C 查询不受影响。未来开启时自动生效。

#### P3.5 Scope 迁移 + 测试（0.5 天）

```sql
-- 现有数据统一设为 'global'（已是默认值，确认无脏数据）
UPDATE im_evolution_edges SET scope = 'global' WHERE scope IS NULL OR scope = '';
UPDATE im_evolution_capsules SET scope = 'global' WHERE scope IS NULL OR scope = '';
UPDATE im_genes SET scope = 'global' WHERE scope IS NULL OR scope = '';
```

测试用例：

- 创建 scope='org:A' 的 Agent，验证其数据不泄漏给 scope='org:B' 的 Agent
- 验证 scope='global' 的 seed Gene 对所有 scope 可见
- 验证 Pooled Prior 在 `MULTI_TENANT=false` 时正常工作

---

## 三、工作量总结

| Phase    | 子任务                           | 天数       | 依赖        |
| -------- | -------------------------------- | ---------- | ----------- |
| **P1.1** | Rate Limiting 接入路由           | 0.5        | 无          |
| **P1.2** | Trust Tier 管理 API              | 0.5        | 无          |
| **P1.3** | Conversation Policy CRUD         | 0.5        | 无          |
| **P2.1** | 加密模式管理 API                 | 0.5        | 无          |
| **P2.2** | 密钥交换协助 API                 | 1.0        | P2.1        |
| **P2.3** | 密文验证 + Context Ref 头检查    | 0.5        | 无          |
| **P3.1** | Scope 基础设施 (中间件 + helper) | 0.5        | 无          |
| **P3.2** | 写入拦截 (CREATE 注入 scope)     | 1.0        | P3.1        |
| **P3.3** | 关键读查询加 scope (~20处)       | 1.0        | P3.1        |
| **P3.5** | 迁移脚本 + 测试                  | 0.5        | P3.2 + P3.3 |
| **合计** |                                  | **6.5 天** |             |

**并行优化：** P1 和 P2 无依赖可并行，P3 依赖 P3.1 完成后 P3.2/P3.3 可并行。

```
Day 1:  P1.1 (Rate Limit 接入) + P1.2 (Trust Tier API)
Day 2:  P1.3 (Policy CRUD) + P2.1 (加密模式 API)
Day 3:  P2.2 (密钥交换)
Day 4:  P2.3 (密文验证) + P3.1 (Scope 基础设施)
Day 5:  P3.2 (写入拦截) + P3.3 (读查询 scope)
Day 6:  P3.5 (迁移 + 测试) + 全量回归测试
```

**最快 5 天，安全 6 天。**

---

## 四、不做什么

| 排除项                   | 理由                                    |
| ------------------------ | --------------------------------------- |
| SDK auto-encrypt 模式    | SDK 侧改动，不阻塞服务端安全            |
| 服务端解密消息           | 违反 E2E 原则                           |
| 强制所有消息加密         | 大部分 Agent 通信不含敏感数据           |
| 加密消息全文搜索         | 需要同态加密，学术前沿                  |
| 联邦学习/差分隐私        | 工程复杂度远超当前阶段                  |
| Evolution ACL 细粒度共享 | im_evolution_acl 表保留，首次需要时实施 |
| Layer C 聚合查询加 scope | 用 `MULTI_TENANT` 开关控制，当前关闭    |

---

## 五、审计发现的额外风险点

| 风险                             | 来源                    | 处理                                        |
| -------------------------------- | ----------------------- | ------------------------------------------- |
| 加密消息跳过 Context Access 检查 | message.service.ts L107 | **P2.3 修复**：验证 metadata.contextRefs 头 |
| Webhook 透传加密内容无标记       | webhook.service.ts      | **P2.3 修复**：payload 加 `encrypted: true` |
| IMEvolutionAchievement 表零引用  | schema 有，代码无       | 保留，首次使用时补代码                      |
| IMEvolutionACL 表零引用          | schema 有，代码无       | 保留，不在 v1.7.2 实施                      |
| Memory 搜索不含 scope 过滤       | memory.service.ts L213  | **P3.3 一起修**（1 行代码）                 |

---

## 六、验收标准

Phase 1 验收：

- [ ] Rate Limit 429 响应 + X-RateLimit-\* headers 在所有挂载路由可见
- [ ] Tier 0 新用户 10 msg/min 限制生效
- [ ] 3 次违规后 Trust Tier 自动降级
- [ ] Trust Tier 管理 API 可用 (admin only)
- [ ] Conversation Policy CRUD 可用

Phase 2 验收：

- [ ] 加密对话设置 API 可用 (encryptionMode/signingPolicy)
- [ ] ECDH 公钥上传/获取 API 可用
- [ ] encrypted=true 但非 Base64 的消息被拒绝
- [ ] 加密消息的 metadata.contextRefs 被服务端验证
- [ ] Webhook payload 包含 encrypted 标记

Phase 3 验收：

- [ ] 所有 CREATE 操作写入 scope 字段
- [ ] API 暴露的读查询按 scope 过滤
- [ ] scope='org:A' 的 Agent 看不到 scope='org:B' 的 Gene/Edge/Task
- [ ] scope='global' 的 seed Gene 对所有 scope 可见
- [ ] MULTI_TENANT=false 时全部行为与改前一致（零回归）

---

_Last updated: 2026-03-23_
