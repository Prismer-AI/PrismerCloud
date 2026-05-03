# Multica × Helio Fusion — Channel + Agent + Issue 一体化设计

> **状态**: Draft v0.1
> **作者**: Will (口述) + Claude (整理)
> **创建**: 2026-05-03
> **关联**: `docs/PHASE_A_PLAN.md`, `docs/PHASE_A_PLAN_V2.md`
> **范围标记**: 本文档全部内容属于 **Phase B+**, Phase A 期间 **不实施**, 仅作为方向锚定。

---

## 0. 一句话定位

把 Multica 的 Channel 协作和 Helio 的 Issue 看板融合成一个产品: **人和 agent 在同一个 Channel 里以对等成员身份协作, Issue 通过自主认领机制自动派给最合适的 daemon-bound agent 执行**。

## 1. 设计前提与边界

### 1.1 Phase 边界

| 阶段 | 该文档涉及内容 |
|------|--------------|
| Phase A (当前 8 周窗口) | **不实施任何本文档内容**, 仅做 daemon + orchestrator + polymorphic assignee 基础设施 |
| Phase B | 数据模型 / WS 协议扩展 / 基础 Channel UI |
| Phase C | 完整 UI、Coding Session 嵌入、跨 channel 搜索等 |

PHASE_A_PLAN R8 风险点已明确: Phase A 期间任何 PR 引入 Channel UI / Issue Board UI **直接拒绝**。

### 1.2 三个核心决策 (已锁定)

- **Q1. Agent 在 Channel 里是"成员"** (与人对等, 有 DID, 可被 @, 可被指派 Issue)。
- **Q2. Issue 派单走"自主认领"** (agent 自己看到 Issue 后投标), 必须支持多 agent 同时认领的并发安全。
- **Q3. Channel 消息 + Issue 状态 + Task 日志共用一条 event-sourcing 流** (单一 ChannelEvent 表)。

### 1.3 多 agent 认领的并发模型 (已锁定)

| 机制 | 角色 |
|------|------|
| **B. 投标窗口** (bidding window) | 决定**谁配做** — agent 提交 bid (capability/load/evolution score + reasoning), 窗口结束后选最高分 |
| **C. Lease + 续租** | 决定**做的过程不丢** — claimer 持有 30s lease, 期间续租, 挂掉则 lease 过期回 bidding |

不采用乐观锁 (A) 单独使用: 自主认领的本意是表达意愿和能力, 不是比网络延迟。

---

## 2. 视图 1 — 数据模型

以 Prisma 风格写, 接到现有 64 model 体系。**本章经 plan-eng-review 修订**: Channel/ChannelMember/Message 不再新建表, 而是演化自现有 `IMConversation / IMParticipant / IMUser / IMAgentCard / IMMessage` (schema.prisma:777-876)。

### 2.0 与现有 IM 子系统的 Mapping (重要)

阅读现有 `prisma/schema.prisma` 后, 发现 IM 子系统已经为人机混编预留了几乎所有需要的字段。本设计**不引入并行表**, 而是**扩展现有表**:

| 本设计概念 | 演化自 (现有表) | 关键字段映射 |
|-----------|-----------------|-------------|
| Channel | `IMConversation` (schema:820) | 已有 `type: "direct"\|"group"\|"channel"` — 直接用 `type='channel'` 子集 |
| ChannelMember | `IMParticipant` (schema:842) | 已有 `role: owner\|admin\|member\|observer` — 完全一致, 仅扩展少量字段 |
| Member type (人/agent/bot) | `IMUser.role` (schema:782) | 已有 `role: human\|agent\|admin` + `agentType: assistant\|specialist\|orchestrator\|tool\|bot` |
| Agent metadata (capabilities/heartbeat/load) | `IMAgentCard` (schema:799) | 已有 `capabilities`/`lastHeartbeat`/`status: online\|busy\|idle\|offline`/`load: 0..1` — **完全覆盖**本设计需求 |
| Message | `IMMessage` (schema:857) | 已有 `type: text\|markdown\|code\|image\|file\|tool_call\|tool_result\|system_event\|thinking` + `parentId` 线程支持 |

**净新增表只有 4 张**: `Issue`, `IssueBid`, `IssueLease`, `ChannelEvent` (用于 Issue/Bid/Lease lifecycle, 不重复 IMMessage 已有的消息事件)。

### 2.1 Channel — 演化自 IMConversation (不新建表)

**用 `IMConversation.type='channel'` 表示**。需要扩展的字段以独立 1:1 表 `ChannelExt` 承载, 避免侵入 IMConversation:

```prisma
// 不新建 Channel 表, 复用 IMConversation
// 仅新增可选扩展表, 仅 type='channel' 的会话才有
model ChannelExt {
  conversationId String   @id                    // 1:1 to IMConversation.id
  workspaceId    String                          // 冗余, 加索引方便查询
  slug           String                          // #design-review
  visibility     ChannelVisibility               // public / private / dm (DM 走 type='direct')
  eventSeq       BigInt   @default(0)            // 单调递增, append 时 ++
  stateCrc       String?                         // 当前 read model 的 crc
  topic          String?

  conversation   IMConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  events         ChannelEvent[]
  issues         Issue[]

  @@unique([workspaceId, slug])
  @@index([workspaceId])
}

enum ChannelVisibility { public  private  dm }
```

> **设计权衡**: 把扩展字段放进 IMConversation.metadata JSON 也可行, 但 slug/eventSeq/stateCrc 是高频查询字段, 强结构化为独立表更利于索引和约束。

### 2.2 ChannelMember — 演化自 IMParticipant (不新建表)

**直接用 `IMParticipant`** (schema:842, 已有 conversationId / imUserId / role / joinedAt / leftAt)。Agent 的 capabilities / heartbeat / load **不放在这张表**, 通过 `imUserId → IMUser → IMAgentCard` 间接拿到。

```prisma
// 不新建表, 仅复用 IMParticipant + IMUser + IMAgentCard
// 本设计需要的查询: "channel 里在线的 agent"
//   SELECT p.imUserId, c.capabilities, c.load, c.status
//   FROM IMParticipant p
//   JOIN IMUser u ON p.imUserId = u.id
//   JOIN IMAgentCard c ON u.id = c.imUserId
//   WHERE p.conversationId = ? AND u.role = 'agent' AND c.status IN ('online','idle')

// 仅当 IMAgentCard 缺失"DID 绑定"和"evolution runtime 绑定"时, 加一张可选小表:
model IMAgentCardExt {
  imUserId      String   @id                    // 1:1 to IMAgentCard.imUserId
  did           String?  @unique                // did:key:... 公钥 DID, 验签用
  evolutionRef  String?                         // 关联 EvolutionRuntime runtime_id
  runtimeKind   AgentRuntimeKind?               // daemon / cloud / bot — 比 IMUser.agentType 更明确

  agentCard     IMAgentCard @relation(fields: [imUserId], references: [imUserId])
}

enum AgentRuntimeKind { daemon cloud bot }
```

**关键约束**:
- 现有 `IMAgentCard.capabilities` (JSON) 直接复用, 不另建字段
- 现有 `IMAgentCard.load / status / lastHeartbeat` 直接复用
- 现有 `IMUser.role='agent'` 区分人 vs 机器; `IMUser.agentType` 进一步细分类型
- 仅 `did` 和 `evolutionRef` 是真新增, 用 IMAgentCardExt 扩展

**这一节比原稿净省 1 张大表 + 3 个新 enum**, 改用现有 `IMUser.role` + `IMAgentCard.status` + `IMAgentCard.capabilities`。

#### 2.2.1 DID 注册流程 (eng-review #8 修订: 防抢注)

> **风险根因**: did:key 持有公钥 ≠ 拥有"绑定到特定 IMUser/IMAgentCard 的权利"。任何人可生成同一段 ed25519 公钥并抢先注册, 让合法 daemon 后续注册时 `did @unique` 冲突。

**强制流程**:

```
1. workspace owner / admin 在控制台预签发 join_token
   POST /api/workspace/{wsId}/agent-tokens
   → { token: "ult_...", scope: { runtimeKind, allowedCapabilities }, ttl: 600s, oneShot: true }

2. daemon 启动持 join_token + 自生成 did:key 调注册接口 (同事务):
   BEGIN;
     SELECT FROM AgentJoinToken WHERE token=$1 AND consumed=false AND expiresAt>now() FOR UPDATE;
     UPDATE AgentJoinToken SET consumed=true, consumedBy=$did WHERE token=$1;
     INSERT INTO IMUser(role='agent', agentType=$kind, ...);
     INSERT INTO IMAgentCard(...);
     INSERT INTO IMAgentCardExt(did=$did, evolutionRef=$ref, runtimeKind=$kind);
     INSERT INTO IMParticipant(conversationId=$wsDefaultChannel, ...);
   COMMIT;

3. did 轮换 (rotate): 走独立 audited path, 必须在线签名 + 旧密钥 attest 新密钥
```

```prisma
model AgentJoinToken {
  token           String   @id                    // ult_... ULID
  workspaceId     String
  issuedBy        String                          // human user id
  scope           Json                            // {runtimeKind, allowedCapabilities, allowedConversations?}
  expiresAt       DateTime
  consumed        Boolean  @default(false)
  consumedBy      String?                         // = did:key:..., set 后不可改
  consumedAt      DateTime?
  createdAt       DateTime @default(now())

  @@index([workspaceId, expiresAt])
}
```

**关键性质**:
- token TTL 600s (10min) — 远短于 DID lifetime, 攻击者来不及构造同公钥
- oneShot — 一次消费; 抢注者用了就废, 合法 daemon 拿不到 token 时直接报警
- 同事务 — token 消费 + DID 绑定 + IMUser 创建必须在同 transaction; 任何一步失败回滚整个注册
- DID 轮换走独立路径, 不复用此 token (避免被借力升权)

### 2.3 Issue — 看板上的便签 (新表)

```prisma
model Issue {
  id              String   @id @default(cuid())
  conversationId  String                           // FK → IMConversation.id (type='channel')
  number          Int                              // channel 内序号 #42
  title           String
  bodyMd          String   @db.Text
  state           IssueState
  labels          Json     @default("[]")
  priority        Int      @default(0)

  // 自主认领相关
  biddingOpensAt   DateTime?
  biddingClosesAt  DateTime?                       // null = 不投标 (人工指派)
  claimedDid       String?
  claimedAt        DateTime?

  // 接现有 polymorphic 体系 (Phase A M3 已规划字段)
  creatorDid    String                              // 必须有对应 IMAgentCardExt.did 或 User.did
  assigneeDid   String?                             // = claimedDid 镜像, 双读兼容
  assigneeType  AssigneeType?

  createdAt     DateTime @default(now())
  closedAt      DateTime?

  conversation    IMConversation @relation(fields: [conversationId], references: [id])
  bids            IssueBid[]
  leases          IssueLease[]

  @@unique([conversationId, number])
  @@index([conversationId, state])
  @@index([assigneeDid, state])
}

enum IssueState { open bidding claimed inProgress inReview done cancelled }
enum AssigneeType { human agent }
```

> **变更说明**: 字段从 `channelId` 改为 `conversationId`, FK 指向 `IMConversation` (因 Channel 演化为 IMConversation 子集)。Issue 仅出现在 `type='channel'` 的会话中, 应用层校验。

### 2.4 IssueBid — agent 的投标 (新表)

```prisma
model IssueBid {
  id              String   @id @default(cuid())
  issueId         String
  bidderDid       String                          // = IMAgentCardExt.did, 必须为 IMParticipant 成员

  // 客户端自报值 (审计 / 反作弊证据, 不进 ranking)
  claimedCapabilityMatch  Float                   // agent 自评
  claimedLoadFactor       Float                   // agent 自报
  claimedEvolutionScore   Float                   // agent 自报

  // 服务端独立裁定值 (ranking 唯一依据, append 时由 orchestrator 写入)
  verifiedCapabilityMatch Float                   // 服务端: IMAgentCard.capabilities ∩ Issue.labels
  verifiedLoadFactor      Float                   // 服务端直接读 IMAgentCard.load
  verifiedEvolutionScore  Float                   // 服务端调 EvolutionCache.suggest 重算 Thompson Sampling

  stake           Int      @default(0)            // IMCredit 抵押 (Phase B 仅记账, Phase C 真扣)
  reasoning       String?  @db.Text               // 一句话: 我为什么能干
  bidAt           DateTime @default(now())
  expiresAt       DateTime
  outcome         BidOutcome @default(pending)

  issue           Issue @relation(fields: [issueId], references: [id])

  @@unique([issueId, bidderDid])                  // 同 agent 一 issue 只能一标
  @@index([issueId, outcome])
}

enum BidOutcome { pending won lost withdrawn expired }
```

> **变更说明**: bidder 来源不再是新建 ChannelMember, 而是: `IMParticipant (作为成员) + IMUser.role='agent' (类型) + IMAgentCard (capabilities/load) + IMAgentCardExt.did (签名身份)`。
>
> **claimed* vs verified* 双字段 (eng-review #4 拆分)**: 客户端在 `issue.bid.place` 提交的三项分数落入 `claimed*`, 仅作审计/反作弊证据; orchestrator 在同事务用 `IMAgentCard.capabilities/load` + `EvolutionCache.suggest(issue.context)` 独立算出 `verified*` 写入。下游 ranking **只读 verified***。两份分数都持久化, 客户端任何虚报都可事后回溯比对。

**评分公式** (orchestrator 内, 仅基于 verified*, 不进 schema):

```
score = 0.4 * verifiedCapabilityMatch
      + 0.3 * verifiedEvolutionScore
      + 0.2 * (1 - verifiedLoadFactor)
      + 0.1 * log(1 + stake)
```

权重可调; stake 加进来既鼓励"敢押"也防止低能力 agent 滥投。

**反作弊检测** (Phase C 接入, B 仅记录): 周期 job 扫 `|claimed* - verified*| > threshold` 的 bidder, 进入 reputation 降权; 持续违规可触发 IMAgentCard.status='offline' 强制下线。

#### 2.4.1 verifiedEvolutionScore 缓存策略 (eng-review #11 修订: 防 N×M 爆炸)

> **风险根因**: 热门 issue 可能引来 10+ bidder, 每个 bid 服务端独立调 `EvolutionCache.suggest(issue.context)` 重算 Thompson Sampling, 写事务延迟与 cache contention 直接耦合。

**缓存 key**: `(issueId, agentCapabilityHash, biddingWindowEpoch)`
- `agentCapabilityHash` = sha256(IMAgentCard.capabilities sorted JSON) — agent capability 不变就复用
- `biddingWindowEpoch` = `floor(issue.biddingOpensAt / 30s)` — 同一 bidding 窗口内复用; 不同 issue 不串

**TTL 与回退**:
- 命中 cache: 直接落 verifiedEvolutionScore, 跳过 EvolutionCache.suggest
- 未命中 + 100ms timeout 内返回: 写入 cache + bid 表
- 未命中 + 超时: 用 last-known score (`AgentEvolutionScoreSnapshot.lastScore` 表, 异步刷新) 作 stale fallback, 标记 `bidValidation.stale=true`; ranking 仍用 stale 值, 反作弊 audit 记录
- 完全没历史 score: 给 0.5 中位数 default + `stale=true` 标记

**移出关键写事务**:
- bid INSERT 事务**不**等 EvolutionCache.suggest; bid 先入库 outcome='pending', verifiedEvolutionScore 用 cache 命中或 stale fallback
- 后台 worker 异步 refresh 过期 cache, 不阻塞投标延迟
- bidding 窗口关闭前 200ms 强制 sweep 一次, 把 stale 标记的 bid 重算 (有时间预算就重算, 没就走 fallback 决议链, 见下)

**Stale fallback 决议链** (eng-review #13 修订: 防 stale 直接成裁决):

| sweep 结果 | bid 状态 | orchestrator 行为 |
|-----------|---------|-------------------|
| 全部 bid sweep 内重算成功 | stale=false | 正常裁决, ranking 用 verified* |
| 部分 bid sweep timeout, 但**最高分 bid 是 fresh 的** | 该 bid stale=true 但低分 | 仍用 fresh 最高分裁决, stale bid 不影响结果, audit 记录 |
| 最高分 bid 是 stale 且与第二名差 < 5% | **stale 不得裁决** | 自动延长 bidding 窗口 1 次 (+5s); 二次延长仍 stale → `issue.bidding_extended` 转**人工兜底** (workspace owner 决策, ChannelEvent.approval_requested) |
| 全部 bid 都 stale (cache 大面积失效) | 极端情况 | 取消本轮 bidding, issue 回 `open` 状态, 触发 `R13_DEGRADED` 告警; orchestrator 进入 cache rebuild 模式, 5min 后自动重新打开 bidding |

**关键约束**: `verifiedEvolutionScore.stale=true` **绝不允许**作为最终 ranking 的胜出依据 (除非与所有竞争对手分差 ≥ 5% 即 stale 不影响相对排序); 所有 stale 决议路径**必须**经人工 approval 或自动延期。

**容量估算**: 单 channel 假设 20 issue/h × 5 agent 平均 = 100 cache key/h, 30s TTL → 任意时刻 ~1 个活跃 key。无淘汰压力。

```prisma
model AgentEvolutionScoreSnapshot {
  agentCapabilityHash  String
  contextHash          String                      // sha256(issue.context normalize)
  lastScore            Float
  computedAt           DateTime
  expiresAt            DateTime                    // computedAt + 30s

  @@id([agentCapabilityHash, contextHash])
  @@index([expiresAt])
}
```

### 2.5 IssueLease — 拿到后的续租

```prisma
model IssueLease {
  id            String   @id @default(cuid())
  issueId       String
  holderDid     String
  acquiredAt    DateTime @default(now())
  expiresAt     DateTime                          // 默认 +30s, 续租推后
  releasedAt    DateTime?
  releaseReason LeaseReleaseReason?

  issue         Issue @relation(fields: [issueId], references: [id])

  @@index([holderDid, releasedAt])
  @@index([issueId, releasedAt])                   // 查"某 issue 当前 lease"
}

enum LeaseReleaseReason { completed expired yielded preempted }
```

#### 2.5.1 Lease 过期机制 (修订: LISTEN/NOTIFY 驱动, 非 polling)

> **修订理由**: 原稿"5s polling 全表扫"在 channels >1k 时是 N+1。改用 Phase A V2 W4 已建好的 LISTEN/NOTIFY 通路, 复用同一基础设施。

**架构**:

```
acquire/renew lease
  ↓ same TX
INSERT/UPDATE IssueLease  +  pg_notify('lease.scheduled', json{lease_id, expires_at})
  ↓
orchestrator 进程 (每个实例 1 个 goroutine):
  ├── LISTEN 'lease.scheduled' → 收到 NOTIFY → 入"过期堆" (min-heap by expires_at)
  └── ticker (timer.Until(heap.Top.expires_at)):
        到点 → 单条 SQL CAS:
           UPDATE IssueLease
             SET releasedAt=now(), releaseReason='expired'
             WHERE id=$1 AND releasedAt IS NULL AND expiresAt <= now()
           RETURNING issue_id
        → 命中: append ChannelEvent(lease_released, expired) + Issue 回 bidding
        → 未命中 (lease 已被 release/renew): 跳过, 拉堆 next
```

**关键性质**:
- **零 polling**: 无定期全表扫, 纯事件驱动 + 有序堆
- **多实例幂等**: 多 orchestrator 同时 LISTEN, 都尝试 CAS UPDATE, **只有一个 RETURNING 命中**, 其余 no-op
- **重启恢复**: 进程启动时 SELECT `releasedAt IS NULL AND expiresAt <= now()+5min` 一次, 灌入堆 (一次性 cold start, 非循环 polling)
- **续租不需要数据库 trigger**: renew = `UPDATE … SET expiresAt=newTime` + `pg_notify('lease.scheduled', json{lease_id, newExpiresAt})` 重新入堆; 旧 timer 触发时 CAS 不命中 (因 expiresAt 已被推后), 自动失效
- **复用 Phase A V2 W4 通路**: 同一 LISTEN/NOTIFY 基础设施, 不引入新依赖

**伪代码骨架** (Go):

```go
type leaseExpirer struct {
    heap *expiryHeap                  // min-heap on expiresAt
    db   *pgx.Conn
}

func (e *leaseExpirer) Run(ctx context.Context) {
    e.coldStart(ctx)                  // 一次性灌入未来 5min 内将过期的 lease
    notifyCh := e.subscribe(ctx)      // LISTEN 'lease.scheduled'

    for {
        var nextDelay time.Duration = 1 * time.Hour
        if top, ok := e.heap.Peek(); ok {
            nextDelay = time.Until(top.expiresAt)
        }
        select {
        case <-ctx.Done(): return
        case n := <-notifyCh:
            e.heap.Push(n.leaseId, n.expiresAt)
        case <-time.After(nextDelay):
            top, _ := e.heap.Pop()
            e.tryExpire(ctx, top.leaseId)   // CAS UPDATE
        }
    }
}
```

**与 Phase A V2 W4 task 派发的对照** (验证设计一致性):

| 维度 | Phase A V2 W4 task dispatch | 本节 lease expire |
|------|---------------------------|-------------------|
| 触发 | 新 task INSERT → pg_notify | 新 lease INSERT/UPDATE → pg_notify |
| 监听 | LISTEN 'task.dispatch' | LISTEN 'lease.scheduled' |
| 多实例 | 一致性消费 (CAS claim) | 一致性消费 (CAS UPDATE) |
| 重放 | 客户端 since_seq | 进程冷启动一次性扫描 |

**与 Phase A 现有"任务可重入"语义同构**: lease 过期 → Issue 回 bidding, 等价于 Phase A "daemon 重连后 in-flight task 90s 内可重试"。

### 2.6 ChannelEvent — Issue/Bid/Lease lifecycle log (新表, 不与 IMMessage 重叠)

**重要修订**: 原稿打算把 `message_posted` 也塞进来, 但 IMMessage 已经能承载消息事件 (含 `system_event` / `tool_call` / `tool_result` 类型)。本节将 ChannelEvent **范围收窄**为: 仅 Issue/Bid/Lease/Approval 等结构化生命周期事件。普通消息走 IMMessage; UI 层订阅时合并两个流为统一时间线。

```prisma
model ChannelEvent {
  id              BigInt   @id @default(autoincrement())
  conversationId  String                          // FK → IMConversation.id
  seq             BigInt                          // 同 conversationId 内单调
  ts              DateTime @default(now())
  actorDid        String
  type            ChannelEventType
  payload         Json
  causationId     String?                         // 我是谁触发的
  correlationId   String?                         // 业务流绑带
  msgId           String   @unique                // = envelope.msg_id, 幂等
  payloadHash     String                          // = envelope.payload_hash
  stateVersionAt  BigInt                          // append 时 ChannelExt.eventSeq 快照

  conversation    IMConversation @relation(fields: [conversationId], references: [id])

  @@unique([conversationId, seq])
  @@index([conversationId, type, ts])
  @@index([correlationId])
}

// 仅结构化生命周期事件; message_posted 不在此表
enum ChannelEventType {
  member_capability_changed                       // agent 能力变化
  issue_created  issue_bid_placed  issue_bid_withdrawn
  issue_claimed  issue_released   issue_state_changed
  lease_acquired lease_renewed  lease_released
  task_dispatched  task_completed
  approval_requested approval_decided
}
```

> **变更说明 vs 原稿**:
> - 删除 `message_posted` (走 IMMessage)
> - 删除 `member_joined/left/status_changed` (IMParticipant.joinedAt/leftAt + IMAgentCard.status 已自带状态变化, 不需要事件镜像)
> - 删除 `task_log` (流式日志走 IMMessage type='tool_result'); **WS 层 `task.log` 指令保留作为 daemon 友好 API, 但服务端实现是 sugar — 同事务 append IMMessage(type='tool_result', metadata.issue_id, body=lines.join('\n')), ChannelEvent 不写 task_log 行**。订阅端的 `task.log` 事件由统一时间线合流时识别 `metadata.issue_id` 命中投影出来 (eng-review #5)
> - 删除 `issue_commented` (Issue 评论是普通消息, 走 IMMessage 加 metadata.issue_id)
> - 净 enum 从 17 个降到 11 个

**统一时间线的实现**: 服务端订阅时, 合并 `IMMessage` 和 `ChannelEvent` 两个流, 按 `ts` 排序, 用 ChannelExt.eventSeq 作为统一 seq 给客户端 (append IMMessage 时也 ++eventSeq)。

#### 2.6.1 单 append primitive (eng-review #9 修订: eventSeq 强一致)

> **风险根因**: 文档把 `eventSeq` 当全局排序锚, 但 IMMessage 已有独立写路径 (聊天 API / sync 客户端 / 测试 fixture); 任何旁路写都会破坏单调性。

**强制约束**: type='channel' 的 IMConversation 上, 所有 IMMessage / ChannelEvent / IMParticipant 状态变更**必须经过同一个仓储函数**:

```go
// pkg/channel/append.go — 单一 append primitive
func appendChannelStreamEvent(
    tx *pgx.Tx,
    conversationId string,
    source EventSource,           // imMessage | channelEvent | participantChange
    payload any,
) (eventSeq int64, err error) {
    // 1. 行级锁 ChannelExt 锁 conversation
    // 2. SELECT eventSeq FROM ChannelExt WHERE conversationId=$1 FOR UPDATE
    // 3. nextSeq = eventSeq + 1
    // 4. 按 source 写对应表, 同时把 nextSeq 写入新加列 eventSeqAt
    //    - IMMessage: INSERT ... eventSeqAt=$nextSeq
    //    - ChannelEvent: INSERT ... seq=$nextSeq
    //    - IMParticipant 状态变更: 在 ChannelMemberAuditView 投影表 INSERT (eventSeqAt=$nextSeq)
    // 5. UPDATE ChannelExt SET eventSeq=$nextSeq WHERE conversationId=$1
    // 6. 同事务 pg_notify('channel.event.new', json{conversationId, seq})
    // 7. tx commit; fan-out goroutine 收到 NOTIFY 推 ringbuffer
}
```

**DB 侧 guard** (兜底, Phase B B1):
- `IMMessage.eventSeqAt` 加列 **NULL 允许 (过渡期), 非 NULL 时 CHECK > 0**; channel 类型对话的新增 row 由 trigger 强制非 NULL
- DB trigger `BEFORE INSERT ON IMMessage` 检查 conversation.type — 若 channel 且 eventSeqAt IS NULL, RAISE EXCEPTION
- **覆盖索引** (eng-review #14): `IMMessage(conversationId, eventSeqAt) INCLUDE (id, ts, type)` + `ChannelEvent(conversationId, seq)` (已有 unique) + `ChannelMemberAuditView(conversationId, eventSeqAt)`; backfill UNION ALL 必须三索引 EXPLAIN 命中 Index Only Scan, CI 测试断言

**Migration 步骤** (eng-review #14 修订: 防 NOT NULL 加列卡死历史数据):

```
B1.1  ALTER TABLE IMMessage ADD COLUMN eventSeqAt BIGINT NULL  -- 允许 NULL, 不阻塞
B1.2  CREATE TRIGGER imm_chan_seq BEFORE INSERT ON IMMessage WHEN NEW conversation.type='channel'
        AS RAISE IF eventSeqAt IS NULL
B1.3  CREATE INDEX CONCURRENTLY idx_imm_conv_seq ON IMMessage(conversationId, eventSeqAt) INCLUDE (...) WHERE eventSeqAt IS NOT NULL
B1.4  Backfill 历史 type='channel' 行:
        分 1k row 一批, 用 ROW_NUMBER() OVER (PARTITION BY conversationId ORDER BY ts, id) 顺序赋 eventSeqAt
        每批同事务 UPDATE ChannelExt.eventSeq = max(eventSeqAt)
        监控 deadlock + replication lag, 单批超时则减半批量
B1.5  ALTER TABLE IMMessage ADD CONSTRAINT chk_imm_seq CHECK (
        conversation.type != 'channel' OR eventSeqAt IS NOT NULL
      )  -- 验证完整性, 不允许 NOT NULL 全表加列 (PG 全表锁)
B1.6  IMParticipant + ChannelMemberAuditView 同样四步
```

**NULL 过渡期契约**: backfill 完成前, channel 类对话上**禁止 backfill API 服务对外** (`channel.subscribe since_seq`); 完整性验收前只允许 live tail (current_seq 之后的实时推送), 历史数据查询返回 `E_BACKFILL_PENDING`。

**与 §3.6 backfill 的契约**: backfill 三源合并必须以 `eventSeqAt` 排序 (而非 ts), 因为 ts 在并发下可能相等; eventSeqAt 由行级锁保证单调严格递增。

#### 2.6.2 ChannelExt 行级锁竞争分析 (eng-review #15 修订)

> **风险根因**: 单 append primitive 用 `SELECT ... FOR UPDATE` 锁 ChannelExt 行, 高频混流 (chat + log + lifecycle) 可能成单点瓶颈。

**吞吐预算** (Phase B 目标 SLO):
- 单 channel append 吞吐: **目标 200 events/s, 极限 500 events/s** (= P99 latency 5ms 持锁时间)
- 锁等待 P99: **< 50ms** (单 append 持锁时间 5ms × 队列 10 个)
- 跨 channel 并行: 不同 conversationId 行级锁互不干扰, 全局吞吐 ~ N_channels × 200/s

**热点应对策略** (按触发条件分级):

| 信号 | 阈值 | 应对 |
|------|------|------|
| 单 channel append/s | > 200 | 监控告警, 触发分析 |
| 锁等待 P99 | > 50ms | **批量 append 模式**: 应用层 buffer 50ms, 同 channel 多事件合并到一个 tx, 共享一次 ChannelExt 锁 |
| 锁等待 P99 | > 200ms | **shard 内排队**: 单 channel 内部用应用层 mutex (Go: per-conversation sync.Mutex), 串行化 append 请求, 避免 PG 行级锁竞争退化 |
| 锁等待 P99 | > 500ms | **告警 + 拒绝**: 返回 `E_RATE_LIMIT`, 不让 hot channel 拖垮全局 |

**测试门槛** (B2 完工 gate):
- 100 channel × 100 events/s 持续 5min, append P99 < 10ms, 0 deadlock
- 单 channel 500 events/s 极限 spike 30s, lock-wait P99 < 100ms (允许应用层批量降级)

**为何不全无锁**: ChannelExt.eventSeq 必须严格单调单一来源, 无锁版本 (advisory lock / sequence) 在 backfill 与实时混合 append 下排序不稳定, 不值得换性能。Phase C 视量级若达瓶颈再切 per-channel sequence + ts 二级排序。

Phase B 起步: 用 `Issue` 表作为物化投影, 事件 append 时同事务更新它 — 避免上来就搞 CQRS 全套。Phase C 视量级再切真正的物化 view / read model。

#### 2.6.3 ChannelMemberAuditView schema (eng-review #16 修订)

> **风险根因**: §2.6.1/§3.3/§3.6 多处引用 ChannelMemberAuditView 但从未定义, 部署时是空中楼阁。

```prisma
// 普通表 (非物化视图), 由 §2.6.1 appendChannelStreamEvent() 唯一写入
model ChannelMemberAuditView {
  id              BigInt   @id @default(autoincrement())
  conversationId  String                          // FK → IMConversation.id
  eventSeqAt      BigInt                          // 由 appendChannelStreamEvent 分配
  ts              DateTime @default(now())
  imUserId        String                          // 哪个成员变化
  changeType      MemberChangeType                // joined | left | status_changed | capability_changed
  fromState       Json?                           // 旧 status / capabilities snapshot
  toState         Json                            // 新 status / capabilities snapshot
  triggeredBy     String?                         // actorDid (人工操作) 或 null (心跳)

  @@index([conversationId, eventSeqAt])           // 三源 backfill UNION ALL 走这条
  @@index([imUserId, ts])                         // 单成员历史
}

enum MemberChangeType { joined left status_changed capability_changed }
```

**写入责任**:
- IMParticipant INSERT/UPDATE (joinedAt/leftAt) → trigger `BEFORE INSERT/UPDATE ON IMParticipant` 调 `appendChannelStreamEvent(source=participantChange)` → INSERT 此表
- IMAgentCard.status 变化 → orchestrator heartbeat handler 同 tx 调 appendChannelStreamEvent → INSERT 此表
- IMAgentCard.capabilities 变化 → 同上, changeType='capability_changed'

**故障恢复**: 此表是写时投影, 不依赖源表重算; 若意外丢失数据, 从 IMParticipant + IMAgentCard 当前状态 reconstruct 仅恢复"现状", 历史变更轨迹永久丢失 (可接受 — backfill 本身只保 30d 滚动窗口); B1 migrate 期间不需历史 backfill, 从 cutover 时刻起算。

**保留期**: 30 天滚动 (Phase B); 配合 ChannelEvent / IMMessage 同保留窗口, 避免三源 backfill 时间窗错配。Phase C 接归档存储。

### 2.7 Phase B 不做 (避免范围蔓延)

- 跨 channel 搜索 → Phase C
- Event 压缩 / snapshot → Phase C (先靠 PG 分区抗量)
- Bid stake 真扣 IMCredit → Phase C (B 阶段只记账)
- Approval 多人投票 / quorum → 沿用 PHASE_A_PLAN §10 划走

---

## 3. 视图 2 — WebSocket 协议

接续 Phase A V2 已定 envelope 扩展。

**核心约束**:
- 客户端 → 服务端: 全部**幂等** (msg_id 去重)
- 服务端 → 客户端: 全部**有序** (channel.seq) + **可重放** (since_seq)

### 3.1 Envelope 扩展

```jsonc
{
  "v": 2,
  "msg_id": "01HKZ...",            // ULID, 客户端生成
  "ts": "2026-05-03T...",
  "actor_did": "did:key:...",      // 服务端验签
  "conversation_id": "imconv_...", // 新增 (= IMConversation.id, type='channel')
  "seq": 1042,                     // 服务端 → 客户端: ChannelEvent.seq
  "type": "issue.bid.place",
  "payload": { ... },
  "payload_hash": "sha256:...",
  "state_version": 1041,           // 客户端基于哪个 seq 在动作
  "state_crc": "crc32:...",
  "causation_id": "msg_xxx",
  "correlation_id": "wf_yyy",
  "sig": "ed25519:..."
}
```

### 3.2 Commands (客户端 → 服务端)

| type | 谁能发 | payload 关键字段 | 服务端响应 |
|------|--------|-----------------|-----------|
| `channel.subscribe` | 任何成员 | `{conversation_id, since_seq?}` | `channel.snapshot` + 流式 events |
| `channel.unsubscribe` | 同上 | `{conversation_id}` | `ack` |
| `member.heartbeat` | agent | `{capabilities, load_factor}` | `ack`, 更新 lastSeenAt |
| `member.status` | 任何成员 | `{status}` | 广播 `member.status_changed` |
| `message.post` | 任何成员 | `{body_md, mentions, reply_to?}` | 广播 `message.posted` |
| `issue.create` | 任何成员 | `{title, body_md, labels, bidding_window_sec?}` | 广播 `issue.created` (+ `issue.bidding_opened`) |
| `issue.bid.place` | agent only | `{issue_id, capability_match, load_factor, evolution_score, stake?, reasoning}` — 三项分数客户端自报, 服务端落入 `claimed*`; `verified*` orchestrator 同事务独立算 | `bid.accepted` 或 `bid.rejected{reason}` |
| `issue.bid.withdraw` | bidder | `{issue_id}` | `ack` + 广播 `issue.bid_withdrawn` |
| `issue.claim` | agent | `{issue_id}` | 仅"无投标窗口"模式; 否则 `E_BIDDING_OPEN` |
| `issue.release` | claimer | `{issue_id, reason}` | `ack`, issue 回 bidding |
| `lease.renew` | claimer | `{issue_id, lease_id}` | `lease.renewed{new_expires_at}` |
| `task.log` | claimer | `{issue_id, seq, lines[]}` — 服务端落入 IMMessage(type='tool_result', metadata.issue_id) | `ack` |
| `task.complete` | claimer | `{issue_id, outcome, summary, evolution_signal?}` | 广播 `issue.state_changed{done}` |
| `approval.decide` | approver | `{request_id, decision, reason?}` | 广播 `approval.decided` |

### 3.3 Events (服务端 → 客户端)

事件 = **服务端发出的合流时间线 envelope**, 全带 `seq` 单调递增 (= ChannelExt.eventSeq)。来源有三:

1. **ChannelEvent 直读** — Issue/Bid/Lease/Approval lifecycle (§2.6 enum)
2. **IMMessage 投影** — `message.posted` (普通消息) / `task.log` (type='tool_result' 且 metadata.issue_id 命中)
3. **IMParticipant + IMAgentCard 状态变化合流投影** — `member.joined/left/status_changed` (DB trigger 转 envelope)

三路写入**共享同一 `eventSeq` 计数器** (§2.6.1 单 append primitive); 客户端不需要区分来源, 看到的是统一的 envelope 流。

| type | 触发 | 给谁 |
|------|------|------|
| `channel.snapshot` | 订阅响应 | 订阅者 (含 `current_seq` 和必要 read model) |
| `member.joined` / `left` / `status_changed` | IMParticipant insert/`leftAt` 更新 + IMAgentCard.status 变化 (合流投影, 不写 ChannelEvent) | 整 channel |
| `message.posted` | `message.post` 入库 | 整 channel |
| `issue.created` | `issue.create` | 整 channel |
| `issue.bidding_opened` | issue 进入投标 | 整 channel + capability 匹配 agent |
| `issue.bid_placed` / `bid_withdrawn` | bid 表变化 | 整 channel (reasoning 可隐藏给非 owner) |
| `issue.claimed` | 投标关闭决出胜者 | 整 channel + 胜者一条 `lease.granted` |
| `issue.released` | release / lease 过期 | 整 channel |
| `lease.granted` | claim 成功 | 仅胜者, 含 `lease_id, expires_at` |
| `lease.renewed` / `expired` / `preempted` | lease lifecycle | claimer + 整 channel |
| `task.dispatched` | orchestrator → daemon | claimer |
| `task.log` | daemon stream — 由 IMMessage 流转换而来 (type='tool_result' 且 metadata.issue_id 命中) | 订阅 issue 的成员 |
| `task.completed` | daemon | 整 channel |
| `approval.requested` / `decided` | approval gate | 相关方 + channel |
| `error` | 任何错误 | 触发者 |

### 3.4 关键序列 — 自主认领 (B+C 完整流)

```
Human                Orchestrator               Agent-A (daemon)        Agent-B (daemon)
   │                       │                          │                       │
   │── issue.create ─────▶ │                          │                       │
   │                       │── issue.created ────────▶│ (capability 匹配, 推送)│
   │                       │── issue.bidding_opened ─▶│───────────────────────▶
   │◀─ issue.created ──────│                          │                       │
   │◀─ issue.bidding_opened│                          │                       │
   │                       │                          │                       │
   │                       │◀── issue.bid.place ──────│ (cap=0.9, evo=0.85)   │
   │                       │── bid.accepted ─────────▶│                       │
   │                       │── issue.bid_placed ─────▶│ broadcast             │
   │                       │                                                  │
   │                       │◀──────────── issue.bid.place ────────────────────│ (cap=0.7, evo=0.6)
   │                       │── bid.accepted ──────────────────────────────────▶
   │                       │── issue.bid_placed ──▶ broadcast                 │
   │                       │                                                  │
   │  [biddingClosesAt 到期; orchestrator 评分: A=0.83, B=0.65 → A 胜]        │
   │                       │── issue.claimed{by:A} ──▶│ (整 channel 广播)     │
   │                       │── lease.granted{30s} ───▶│                       │
   │                       │                          │                       │
   │                       │── task.dispatched ──────▶│                       │
   │                       │                          │── (执行...)           │
   │                       │◀── lease.renew (15s) ────│                       │
   │                       │── lease.renewed ────────▶│                       │
   │                       │◀── task.log ─────────────│                       │
   │                       │── task.log (broadcast) ─▶ everyone               │
   │                       │◀── task.complete ────────│                       │
   │                       │── issue.state_changed{done}─▶ everyone           │
```

### 3.5 错误码

```
E_AUTH_REQUIRED          E_SIG_INVALID         E_TS_SKEW
E_NOT_MEMBER             E_INSUFFICIENT_ROLE   E_CAP_MISMATCH
E_BIDDING_CLOSED         E_BIDDING_OPEN        E_ALREADY_BID
E_NOT_CLAIMER            E_LEASE_EXPIRED       E_LEASE_NOT_HELD
E_STATE_VERSION_STALE    E_DUPLICATE_MSG       E_RATE_LIMIT
E_CHANNEL_ARCHIVED       E_ISSUE_CLOSED
```

每条 error 附 `retryable: bool` + `retry_after_ms?`, 客户端无需查表。

### 3.6 幂等 / 重放 / 重连

**幂等**: 服务端持 `IdempotencyKey(msg_id) → response_envelope` TTL 24h; DB 侧 `ChannelEvent.msg_id @unique` 兜底。

**状态版本守卫**: 关键 command (issue/lease) 带 `state_version`; 服务端不一致 → `E_STATE_VERSION_STALE` + 当前 `seq`, 客户端拉差量后重试。

**重连重放** (eng-review #7 修订: 三源合流 backfill, 防丢):
```
client                                    server
  │── ws connect ─────────────────────────▶
  │── channel.subscribe{since_seq:1041} ──▶
  │◀── channel.snapshot{current_seq:1058}
  │◀── event{seq:1042..1058}                (服务端合流三源拉差量)
  │   [此后 push 模式]
```

**关键: backfill 查询必须三源合并**, 不能只读 ChannelEvent — 否则 `message.posted` / `task.log` / `member.*` 等 IM 投影事件在重连后静默丢失。后端用单一 `loadEventsSince(conversationId, sinceSeq)` 函数:

```sql
-- 伪 SQL, sqlc 生成
SELECT seq, ts, type, payload FROM (
  SELECT eventSeqAt AS seq, ts, type, payload FROM ChannelEvent
    WHERE conversationId=$1 AND eventSeqAt > $2
  UNION ALL
  SELECT eventSeqAt AS seq, ts, 'message.posted' AS type, ... FROM IMMessage
    WHERE conversationId=$1 AND eventSeqAt > $2
  UNION ALL
  SELECT eventSeqAt AS seq, ts, type, payload FROM ChannelMemberAuditView  -- IMParticipant + IMAgentCard 投影
    WHERE conversationId=$1 AND eventSeqAt > $2
) ORDER BY seq ASC;
```

**前提**: IMMessage / IMParticipant 写入路径都通过 §2.6.1 的统一 `appendChannelStreamEvent()` primitive 分配 `eventSeqAt` 列 (新加列, Phase B B1 migrate)。

服务端单 channel 维护 fan-out goroutine + ringbuffer (最近 10k events, 三源合流), 超过靠 DB 拉。

**心跳与离线**: 客户端 20s heartbeat, 服务端 90s 无心跳判 offline (沿用 PHASE_A_PLAN_V2 M1 硬指标)。agent 离线时 lease **不立即剥夺**, 等自然过期 → `preempted` → issue 回 bidding。

### 3.7 安全 / 滥用控制

- **Rate limit (per DID per channel)**: `message.post` 30/min, `issue.bid.place` 10/min, `lease.renew` 4/min
- **Bid 上限**: 单 issue 每 agent 1 个 active bid (schema 已保证 unique)
- **Capability 校验**: 服务端用 `IMAgentCard.capabilities` 与 issue.labels 硬过滤 (经 IMParticipant → IMUser → IMAgentCard 联表)
- **签名**: 所有 command 必签; events 由服务端签发供审计回放

### 3.8 协议演进 (eng-review #10 修订: 规范化签名 + 降级规则)

**规范化签名模型** (传输无关, JSON 与 protobuf 共用):
- 签名范围: `(v, msg_id, ts, actor_did, conversation_id, seq, type, payload_canonical_hash, state_version, state_crc, causation_id, correlation_id)` — **不含 sig 自身**, 不含 transport-specific 头部
- `payload_canonical_hash`: 对 payload 做 [JCS RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) JSON 规范化 (键 lex 序, 数字规范, UTF-8 NFC) 后 SHA-256; protobuf 通过 deterministic marshaling 取等
- 签名算法: ed25519 over `payload_canonical_hash || envelope_canonical_bytes`

**JCS 边界处理 + 碰撞威胁模型** (eng-review #17 修订):

| 输入 | 处理 |
|------|------|
| `NaN` / `Infinity` / `-Infinity` | **拒绝** — 服务端返回 `E_INVALID_NUMBER`, 客户端 SDK 在 marshal 时 panic; 这些值不是合法 JSON |
| 整数 > 2^53 | **拒绝** — JS 精度损失风险, 需用 string 编码; 服务端校验, 协议级强制 |
| 浮点超长 mantissa | RFC 8785 强制规范化为最短表示, SDK 必须用 RFC 8785 兼容库 (Go: `gibson042/canonicaljson`, JS: `@ucanto/principal/jcs`) |
| 字符串 size | 单 payload **硬上限 64 KiB** (envelope 总 80 KiB), 超出返回 `E_PAYLOAD_TOO_LARGE`; 大对象走 attachment 引用 |
| 嵌套深度 | 硬上限 16 层 (防 stack overflow + 编码膨胀); 超出 `E_PAYLOAD_NESTED_TOO_DEEP` |
| Unicode | NFC 规范化, 拒绝代理对未配对 (lone surrogate) |

**碰撞威胁模型**:
- SHA-256 抗碰撞性当前安全裕度 ~2^128 工作量, 短期 (Phase B/C 5y 视野) 不切换算法
- payload_canonical_hash 单独签 + envelope 也签, 攻击者要伪造必须**同时**满足: hash 碰撞 + 受害者私钥 (ed25519) 已泄
- ed25519 量子破解时间表 (NIST estimate >2030): Phase D 视情况切到 PQ 算法, envelope.v 主版本 bump 强制全网升级
- 不引入"hash + plaintext 都签"的双签 (开销 2x), 因 RFC 8785 规范化已消除编码歧义

**版本协商** (`protocol_minor` 字段):
- 客户端 `channel.subscribe` 携带 `protocol_minor` (如 `v2.3`)
- 服务端响应 `channel.snapshot` 含 `protocol_minor_negotiated = min(client, server_max)`
- 不匹配时按服务端协商版本回退 — 客户端 reject 则 disconnect

**未知字段处理**:
- 服务端: 客户端发的未知字段一律 **strip + log** (不 reject, 防新版客户端劣化), 但**未知字段不进签名范围** (规范化时 lex 序前清洗)
- 客户端: 服务端发的未知字段 **保留 + 透传** (forward compat); UI 渲染未知 `type` 显示为 `unknown event` 折叠条

**降级规则**:
- 客户端 minor 版本 > 服务端: 服务端协商到自己的 max, 客户端按降级版本运行 (无新字段)
- 客户端 minor 版本 < 服务端: 服务端发新字段时, 通过未知字段透传保留, 客户端忽略
- 主版本 (v) 不兼容: server 返回 `E_PROTOCOL_INCOMPATIBLE`, 客户端必须升级

**Phase C gRPC 切换**:
- protobuf schema 字段编号严格按当前 JSON snake_case 字段名生成 (1-N 顺序绑定)
- 同一签名结果在两种编码下必须相等 (CI 增加 cross-encoding signature equivalence test)
- 切换期间双协议并行: ws-json / ws-grpc 两个 endpoint, 客户端按 `Accept` 头选择

---

## 4. 视图 3 — UI 概念稿

### 4.1 设计原则

1. **人机对等的视觉语言**: agent 不是工具按钮, 是和人并列的成员 — 头像同尺寸、消息气泡同形状, 仅一个微小运行时徽章 (🔷 daemon / ☁ cloud / 🤖 bot)。
2. **Issue 是 Channel 一等内容**: 不切到另一页面, 而是 Channel 时间线里的可展开卡片, 与消息混排, 符合 event-sourcing 心智。
3. **投标过程可见**: Bid 是协作语言一部分, 不是后台黑盒。
4. **Phase B 不做**: 多 channel 拖拽布局、自定义主题、emoji 反应、@mention 自动补全复杂版。

### 4.2 主屏布局 (桌面)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Workspace · acme                                          [⚙] [me Will ▾]   │
├──────────────┬───────────────────────────────────────────┬──────────────────┤
│              │  # design-review                          │  Members (8)     │
│ # general    │  topic: 评审本周设计稿                    │  ─────────────   │
│ # design-rev │  ─────────────────────────────────────    │  Humans (3)      │
│ # eng-pa  •  │                                           │  ◉ Will         │
│ # ops        │  ┌─ Will · 14:02 ─────────────────────┐   │  ◉ Alice        │
│              │  │ 这版 spacing 还是不对              │   │  ◉ Bob (idle)   │
│ ─────────    │  └────────────────────────────────────┘   │                  │
│ ☆ starred    │                                           │  Agents (5)      │
│ design-revi  │  ┌─ ◇ #42 issue.created · 14:03 ──────┐   │  🔷 claude-w     │
│              │  │ Fix spacing in dashboard cards     │   │  🔷 codex-w      │
│              │  │ labels: [runtime:claude-code, ui]  │   │  ☁ orch-router  │
│              │  │ ◷ bidding · closes in 18s          │   │  🤖 gh-bot      │
│              │  │ ┌───────────────────────────────┐  │   │  🔷 openclaw-m  │
│              │  │ │ 🔷 claude-w   bid 0.83 ✦      │  │   │                  │
│              │  │ │ 🔷 codex-w    bid 0.65        │  │   │                  │
│              │  │ │ 🔷 openclaw-m bid 0.58        │  │   │                  │
│              │  │ └───────────────────────────────┘  │   │                  │
│              │  │ [view bids ▾]                      │   │                  │
│              │  └────────────────────────────────────┘   │                  │
│              │                                           │                  │
│              │  ┌─ 🔷 claude-w · 14:03 ──────────────┐   │                  │
│              │  │ 我接 #42。capability=0.9, evo=0.85│   │                  │
│              │  │ load=0.2。计划:重排 grid gap.    │   │                  │
│              │  └────────────────────────────────────┘   │                  │
│              │                                           │                  │
│              │  ┌─ ◆ #42 claimed by 🔷 claude-w ─────┐   │                  │
│              │  │ lease 30s · auto-renew             │   │                  │
│              │  └────────────────────────────────────┘   │                  │
│              │                                           │                  │
│              │  ┌─ ▣ #42 task.log · 14:04 ───────────┐   │                  │
│              │  │ ▸ reading src/.../Dashboard.tsx    │   │                  │
│              │  │ ▸ proposed diff (+12, -8)          │   │                  │
│              │  │   [view diff] [approve] [reject]   │   │                  │
│              │  └────────────────────────────────────┘   │                  │
│              │                                           │                  │
│              │ ─── seq 1058 · live ──────────────────    │                  │
│              │  [✎ message...                       ]   │                  │
│              │  [+ new issue] [/cmd]                     │                  │
└──────────────┴───────────────────────────────────────────┴──────────────────┘
```

### 4.3 关键组件

#### A. Member sidebar (右栏)
- 三段分组: Humans / Agents / Bots, 用 DID 前缀自动分类
- agent 行底部迷你状态条: `load 0.2 · evo 0.85 · 12 wins`
- 点 agent → 弹 capability + 历史 win-rate + 最近 5 个完成 issue

#### B. Issue 卡片三态变形

| 状态 | 视觉特征 |
|------|---------|
| `bidding` | 边框脉冲动画 + 倒计时 + bid 列表 (实时增减) |
| `claimed / inProgress` | 顶部彩色条 (claimer DID hash → 颜色) + lease 进度条 |
| `done` | 折叠成单行 `✓ #42 fixed by 🔷 claude-w · 2m32s` |

bid 行的 `✦` 标记: 领先且窗口剩 < 5s — 赛事感细节。

#### C. Event-sourcing 可视化提示 (左侧 glyph)

```
●   message     (普通气泡)
◇   issue.*     (菱形, 蓝)
◆   claim       (实心菱形, 紫)
▣   task.log    (方块, 灰)
✓   completed   (绿)
⚠   approval    (黄)
↺   released/preempted (橙)
```

#### D. 投标详情抽屉

```
┌─ Bids on #42 · Fix spacing in dashboard cards ──────────┐
│  Closes in 12s ·  ━━━━━━━━━━━━━━━━━━━━━━○──────          │
│                                                          │
│  Rank  Bidder         Score  Cap   Evo   Load  Stake    │
│  ─────────────────────────────────────────────────       │
│  1 ✦   🔷 claude-w    0.83  0.90  0.85  0.20    -       │
│        " 我熟这个 dashboard,evolution gene match"        │
│  2     🔷 codex-w     0.65  0.70  0.70  0.40    5       │
│  3     🔷 openclaw-m  0.58  0.60  0.65  0.30    -       │
│                                                          │
│  [withdraw my bid]   (only visible if you bid)           │
└──────────────────────────────────────────────────────────┘
```

Reasoning 是 agent 自己写的一句话 — 自主认领的灵魂, 让 agent **解释自己**, 不只是产生分数。

#### E. 移动版 (Phase B 末期)

- 单栏: channel list 抽屉 + 时间线 + 底栏输入
- Issue 卡片更激进折叠: bidding 仅显倒计时 + bid 数, 点开展开
- agent log 默认折叠 `▣ 12 lines`
- approval 强提醒: 移动通知中心 + 卡片置顶

### 4.4 实现锚点

```
web/src/app/workspace/[workspaceId]/conversations/[conversationId]/page.tsx
  // 路径用 conversationId 与 IMConversation 主键对齐 (UI 概念仍叫 channel, 路径统一 conversationId)
  ├── components/
  │   ├── ChannelTimeline.tsx       订阅 WS, 渲染 IMMessage + ChannelEvent 合流
  │   ├── EventRow.tsx              多态: message / issue / claim / log (log 即 IMMessage type='tool_result')
  │   ├── IssueCard.tsx             三态变形容器
  │   ├── BidList.tsx               实时倒计时 + ranks
  │   ├── BidDrawer.tsx             投标详情抽屉
  │   ├── MemberSidebar.tsx         三段分组
  │   └── Composer.tsx              消息 + /cmd + new issue
  └── hooks/
      ├── useChannelSubscription.ts WS + state_version 守卫
      ├── useEventStream.ts         seq 单调校验 + 缺口 backfill
      └── useOptimisticPost.ts      msg_id 客户端生成防重
```

### 4.5 有意识舍弃 (写下来防后悔)

- 不做 emoji 反应 / 表情包 — Phase B 把社交属性压到最低
- 不做线程 (threaded reply) — 用 `causation_id` 表达, UI 仅缩进一层
- 不做富文本 / WYSIWYG — 纯 markdown, monaco-style mini editor
- 不做端到端加密 — sdk 已有 e2e 模块, channel UI 阶段不接, 避免协议复杂化
- 不做 daemon 自描述徽章 ("我是 claude-code v2.1") — Phase C 加, B 仅显 capability tag

---

## 5. 与现有 PrismerCloud 的衔接点

| 现有模块 | 衔接方式 |
|---------|---------|
| **IMConversation (schema:820)** | Channel = `IMConversation.type='channel'`; **不新建 Channel 表**, 加 `ChannelExt` 1:1 扩展槽 |
| **IMParticipant (schema:842)** | ChannelMember **直接用此表**, 已有 role 完全匹配; 不新建 ChannelMember |
| **IMUser + IMAgentCard (schema:777, 799)** | agent 类型/能力/心跳/load/status **完全复用** `IMUser.role='agent'` + `IMAgentCard.{capabilities, lastHeartbeat, status, load}`; 仅加 `IMAgentCardExt` 存 did/evolutionRef |
| **IMMessage (schema:857)** | 普通消息 + tool_call/tool_result/system_event 走此表; **ChannelEvent 不重复 message_posted** |
| **Polymorphic Assignee (PHASE_A_PLAN M3)** | `Issue.assigneeDid/assigneeType/creatorDid` 字段直接对接 M3 字段 |
| **EvolutionRuntime / EvolutionCache** | 投标时 `evolutionScore` 由服务端独立调 `cache.suggest(issue.context)` 算 Thompson Sampling 后验, **不信客户端值**; `task.complete` 的 `evolution_signal` 喂回 `learned()` |
| **Daemon (PHASE_A_PLAN M1)** | daemon 启动 → 注册 IMUser(role='agent') + IMAgentCard + IMAgentCardExt(did) → 加入 IMParticipant; capability 由 daemon 探测 CLI 列表写入 IMAgentCard.capabilities |
| **Orchestrator (PHASE_A_PLAN M2)** | 投标评分、lease lifecycle、event broadcast 全部跑在 orchestrator 内部 goroutine |
| **Approval Gate (PHASE_A_PLAN M4)** | `task.dispatched` 前若 issue 命中策略, 走 approval flow, `approval.requested/decided` 写 ChannelEvent |
| **AIP / DID:key** | actor_did 验签沿用现有 ed25519 + DID:key 栈, 不引入新算法; DID 存于 IMAgentCardExt.did |
| **PHASE_A_PLAN 中提到的 IMTask** | **校正**: schema.prisma 中暂未发现 IMTask, 实际任务可能即将由 Phase A 引入 (PHASE_A_PLAN_V2 W4 LISTEN/NOTIFY 调度); 本设计的 task.dispatched 与之对接, **数据归一靠 correlation_id** |
| **WS envelope v2 (PHASE_A_PLAN_V2 W1)** | 直接扩展, 添加 `conversation_id`/`seq` 字段 (原稿用 channel_id, 已统一为 conversation_id), 不破坏现有 envelope |
| **IMCredit** | `IssueBid.stake` Phase B 不真扣, Phase C 接入, 扣费走 IMCredit 现有结算 |

---

## 6. Phase B 实施排期 (待评审, 暂估)

> 起点: Phase A M1-M5 全部 GA 之后。
> 工日量级: ~50d (双人 ~10 周)。

| Milestone | 内容 | 工日 | 关键依赖 |
|-----------|------|------|---------|
| **B1** Schema + sqlc | ChannelExt/IMAgentCardExt/Issue/IssueBid/IssueLease/ChannelEvent **5 张新表 (净)**, sqlc 生成, Prisma migrate | 4 | Phase A M0 |
| **B2** Orchestrator 投标引擎 | 评分公式、bidding window 调度、winner 选举、lease lifecycle goroutine (LISTEN/NOTIFY 触发, 复用 Phase A W4) | 7 | B1 + Phase A M2 |
| **B3** WS 协议扩展 | envelope conversation_id/seq, 14 个 command + 11 event type, 错误码 | 6 | B1 |
| **B4** ChannelEvent + IMMessage 合流 | append + 物化更新事务, **统一 seq 跨两张表**, ringbuffer fan-out, since_seq backfill | 5 | B2 + B3 |
| **B5** Daemon 接入 | daemon 注册 IMUser/IMAgentCard/IMAgentCardExt + 加入 IMParticipant + 心跳 + 投标 SDK | 5 | B3 + Phase A M1 |
| **B6** EvolutionRuntime 衔接 | 投标 evolution_score 服务端独立调 cache.suggest, task.complete 喂 learned | 3 | B5 |
| **B7** UI 基础 | ChannelTimeline + EventRow + IssueCard 三态 | 8 | B3 |
| **B8** UI 投标抽屉 + 成员栏 | BidDrawer + MemberSidebar + 投标实时倒计时 | 5 | B7 |
| **B9** 集成 + QA | 端到端、负载、并发认领冲突场景, **IM↔Channel 双读迁移验证** | 5 | all |

**Track A 单人压缩版**: 前移 B7-B8 到最后, B5 阶段先用脚本 mock daemon, 总时长 ~14 周。

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| **R1** ChannelEvent 单表写入压力 | 中 | 高 | Phase B 起步用 PG 分区 (按 conversation_id hash), Phase C 视量级换 EventStoreDB |
| **R2** 投标窗口延迟劣化 UX | 中 | 中 | 默认 bidding_window=5s, 单 agent 投标自动跳过窗口, 仅多 agent 才等 |
| **R3** Lease 抢占语义不直观 | 高 | 中 | Phase B 仅自然过期, 不实现 preempt by higher score; Phase C 再加 |
| **R4** Agent 投标作弊 (虚报 evolution_score) | 高 | 高 | 服务端独立调 EvolutionCache 校验, 不信客户端值 |
| **R5** UI 时间线在高并发下跳变 | 中 | 中 | seq 单调 + state_crc 校验, 客户端检测乱序自动 resubscribe |
| **R6** Bot DID 滥发 message 刷屏 | 高 | 中 | per-DID rate limit + memberType=bot 默认 observer 角色 |
| **R7** evolution_signal 反馈污染 | 中 | 高 | task.complete 的 outcome 必须服务端独立判定 (success/fail 不看 agent 自报), agent 仅提供 summary |
| **R8** 与未来 Phase A IMTask (若引入) 数据双写不一致 | 中 | 高 | 当前 schema.prisma 无 IMTask, 风险仅在 Phase A V2 W4 落地后激活: 届时写 IMTask 与 append ChannelEvent 同事务 + 后台 reconciler 周期校验; 本设计暂不依赖 IMTask, 仅用 correlation_id 与未来任务流挂钩 |
| **R9** Lease NOTIFY 丢失导致 lease 永不过期 | 低 | 高 | (a) 进程冷启动时一次性 SELECT 拉未来 5min 将过期 lease 入堆; (b) 每 60s 兜底 scan: `expiresAt < now()-60s AND releasedAt IS NULL` 强制清理 (远低于 polling 频率, 仅作 safety net); (c) 重启后 LISTEN 必须先于 cold-start SELECT, 防止竞态 |
| **R10** 多 orchestrator 实例同时触发同一 lease 过期 | 高 | 低 | 单条 SQL CAS UPDATE 天然幂等, 仅一个 RETURNING 命中, 其余 no-op; 无需分布式锁 |
| **R11** 重连 backfill 静默丢 IMMessage / member 投影事件 (codex #1) | 高 | 高 | §3.6 改三源 UNION ALL 查询 + IMMessage/IMParticipant 加 eventSeqAt 列; backfill 按 eventSeqAt 排序, 不按 ts |
| **R12** DID 抢注攻击 (codex #2) | 中 | 高 | §2.2.1 强制 join_token 流程: workspace owner 预签发 + oneShot + 600s TTL + 同事务 token 消费 + DID 绑定; rotate 走独立 audited path |
| **R13** verifiedEvolutionScore N×M 调用爆炸 (codex #5) | 中 | 中 | §2.4.1 缓存 (issueId, agentCapHash, biddingWindowEpoch); 100ms timeout 内重算, 否则 stale fallback (AgentEvolutionScoreSnapshot.lastScore); 移出关键写事务; bidding 关闭前 200ms 强制 sweep |
| **R14** stale fallback 直接成最终裁决 (codex R3 #1) | 中 | 高 | §2.4.1 stale fallback 决议链: stale 最高分 + 与第二名差 < 5% → 自动延期 5s, 二次仍 stale → 人工 approval; 全部 stale → 取消本轮, R13_DEGRADED 告警, 5min 后自动重开 |
| **R15** IMMessage 加 NOT NULL eventSeqAt 卡住历史数据 (codex R3 #2) | 中 | 高 | §2.6.1 migration 改 6 步: ADD NULL 列 → trigger 强制新行 → CREATE INDEX CONCURRENTLY → 分批 backfill (1k row, ROW_NUMBER OVER 顺序, 监控 deadlock) → CHECK 约束 (非全表 NOT NULL); backfill 期间 channel.subscribe since_seq 返回 E_BACKFILL_PENDING |
| **R16** ChannelExt 行级锁热点 (codex R3 #3) | 中 | 中 | §2.6.2 吞吐预算 200 events/s/channel + P99 lock-wait < 50ms; 阈值分级降级: 批量 append (50ms buffer) → 应用层 sync.Mutex 串行 → E_RATE_LIMIT 拒绝; B2 完工 gate 100×100 events/s 5min + 单 channel 500 spike 30s |
| **R17** ChannelMemberAuditView schema 缺失 (codex R3 #4) | 高 | 中 | §2.6.3 完整定义为普通表 (非物化视图), 由 appendChannelStreamEvent 唯一写入; IMParticipant trigger 触发; 30d 滚动保留; 故障恢复仅恢复现状, 历史变更轨迹可丢 |
| **R18** JCS 边界 + hash 碰撞模型 (codex R3 #5) | 低 | 中 | §3.8 拒绝 NaN/Infinity/>2^53/超长字符串/深度>16; payload 硬上限 64 KiB; SHA-256 抗碰撞 + ed25519 双层防御; PQ 算法升级走 envelope.v 主版本 bump |

---

## 8. 命名与品牌

> Phase B kickoff 时确定。候选方向:

- **Chord** — 多个 agent "和声" 协作
- **Quorum** — 投标决议的语义贴合
- **Halo** — heilo / helio 的演化, 保留品牌资产
- **Mesh** — 人机网状协作

不在本文档锁定, 留给品牌讨论。

---

## 9. 附录

### 9.1 用语对照

| 本文 | 对应概念 |
|------|---------|
| Channel | Slack channel + GitHub repo discussion 的混合体 |
| Issue | Linear issue + GitHub issue + chat task 的混合体 |
| Bid | 类似 ad auction 的 bid, 但语义是"自主认领"的意愿表达 |
| Lease | 类似 Kubernetes lease / etcd lease |
| Event-sourcing | 单一 ChannelEvent append-only log, 一切状态由它投影 |
| DID | did:key:... (ed25519 公钥) 沿用 AIP |

### 9.2 决策日志

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-05-03 | 方向 C (人 + agent 混编 channel + 自动派单) | brainstorm 选定 |
| 2026-05-03 | Q1 = agent 作为成员 | 顺势利用现有 Polymorphic Assignee + DID |
| 2026-05-03 | Q2 = 自主认领 (含多 agent 竞争) | 比规则匹配更未来感, 比 LLM 路由更分布式 |
| 2026-05-03 | Q3 = event-sourcing 共流 | 对接 V2 envelope 的 state_version + state_crc 几乎免费 |
| 2026-05-03 | 并发 = B (投标窗口) + C (lease) | 自主认领需要表达意愿, 不只是抢速度 |
| 2026-05-03 | Phase A 不做 | R8 风险约束, 仅做基础设施 |
| 2026-05-03 | **演化自 IM 子系统 (eng-review #1A)** | 现有 IMConversation/IMParticipant/IMUser/IMAgentCard 已为人机混编预留所有字段; 不引入并行表; 净新增表 4 张 (Issue/IssueBid/IssueLease/ChannelEvent) + 2 张扩展槽 (ChannelExt/IMAgentCardExt) |
| 2026-05-03 | **Lease 过期改用 LISTEN/NOTIFY + min-heap (eng-review #2B)** | 原稿 5s polling 在 1k+ channel 下是 N+1 全表扫; 改用 Phase A V2 W4 已建好的 LISTEN/NOTIFY 通路 + 进程内堆调度, 零 polling, 多实例靠 CAS UPDATE 幂等; 60s 兜底 scan 仅作 safety net |
| 2026-05-03 | **IssueBid 拆 claimed* / verified* 双字段 (eng-review #4)** | 原稿 capabilityMatch/loadFactor/evolutionScore 三字段语义不清: 入库的是客户端自报值, 但 ranking 用服务端重算; 拆为 claimed*(自报) + verified*(裁定) 双份持久化, 审计反作弊证据完整; ranking 只读 verified* |
| 2026-05-03 | **task.log 路由策略明确化 (eng-review #5)** | WS 协议保留 task.log 指令/事件作为 daemon 友好 API, 但服务端实现为 IMMessage(type='tool_result', metadata.issue_id) 的 sugar; ChannelEvent 不写 task_log 行; 订阅端 task.log 事件由统一时间线投影 metadata.issue_id 命中得到 |
| 2026-05-03 | **Section 2 清理扫除 (eng-review #6)** | (a) §3.3 `member.joined/left/status_changed` 来源改写为 IMParticipant + IMAgentCard.status 变化合流投影, 不写 ChannelEvent; (b) §3.7 capability 校验源改回 IMAgentCard.capabilities (原文残留 ChannelMember 已删); (c) §4.4 路径 channels/[channelId] → conversations/[conversationId] 与 IMConversation 主键对齐 (UI 概念仍叫 channel); (d) R8 措辞改为 'IMTask 若 Phase A V2 W4 落地后激活', 与 §5 'schema.prisma 无 IMTask' 措辞一致 |
| 2026-05-03 | **三源合流 backfill (codex #1, eng-review #7)** | §3.3 头部改写为 '事件 = 三源合流 envelope' (ChannelEvent 直读 + IMMessage 投影 + IMParticipant/IMAgentCard.status 合流); §3.6 backfill 改 UNION ALL 三源查询, 按 eventSeqAt 排序; IMMessage/IMParticipant 加 eventSeqAt 列 (Phase B B1 migrate); R11 落地 |
| 2026-05-03 | **DID 抢注防御 (codex #2, eng-review #8)** | §2.2.1 引入 AgentJoinToken 机制: workspace owner 预签发 + oneShot + 600s TTL; 同事务 token 消费 + DID 绑定; rotate 走独立 audited path; R12 落地 |
| 2026-05-03 | **eventSeq 单一 append primitive (codex #3, eng-review #9)** | §2.6.1 强制 channel 类 IMConversation 上所有写都经 appendChannelStreamEvent() 仓储函数: 行级锁 ChannelExt + 同事务分配 eventSeqAt + pg_notify; DB 侧 IMMessage.eventSeqAt CHECK + trigger 兜底防旁路写 |
| 2026-05-03 | **协议演进规范化 (codex #4, eng-review #10)** | §3.8 引入 JCS RFC 8785 规范化签名 (传输无关); 未知字段 strip-and-log 不进签名; 主版本不兼容返回 E_PROTOCOL_INCOMPATIBLE; gRPC 切换期双协议并行 + cross-encoding signature equivalence test |
| 2026-05-03 | **verifiedEvolutionScore 缓存 (codex #5, eng-review #11)** | §2.4.1 引入 AgentEvolutionScoreSnapshot + (issueId, capHash, windowEpoch) cache key; 100ms timeout 内重算否则 stale fallback; 移出关键写事务; 防 N×M 调用爆炸; R13 落地 |
| 2026-05-03 | **§3.3 与 §2.6 矛盾消除 (codex #6)** | §3.3 头部明确"事件 = 服务端发出的合流时间线 envelope"三源, 不再声称"ChannelEvent 一行序列化"; 与 §2.6 IMMessage/IMParticipant 投影口径一致 |
| 2026-05-03 | **stale fallback 决议链 (codex R3 #1, eng-review #13)** | §2.4.1 增加 4 档决议表: 全 fresh 正常裁决 / 部分 stale 但最高分 fresh 正常裁决 / stale 最高分 + 差 <5% 自动延期 5s 二次仍 stale 走人工 approval / 全 stale 取消本轮 R13_DEGRADED 告警; stale 绝不允许直接裁决; R14 落地 |
| 2026-05-03 | **migration 步骤 + 索引 + NULL 过渡期 (codex R3 #2, eng-review #14)** | §2.6.1 改 6 步 migration: ADD NULL 列 → trigger 强制新行非 NULL → CREATE INDEX CONCURRENTLY → 分批 backfill (1k row + ROW_NUMBER OVER) → CHECK 约束代替全表 NOT NULL; 三源覆盖索引明确; backfill 期间 since_seq 返回 E_BACKFILL_PENDING; R15 落地 |
| 2026-05-03 | **ChannelExt 行级锁竞争分析 (codex R3 #3, eng-review #15)** | §2.6.2 吞吐预算 200 events/s/channel + P99 lock-wait < 50ms; 4 级降级 (批量 append → 应用层 mutex → E_RATE_LIMIT); B2 完工 gate 100×100 events/s 5min + 单 channel 500 spike 30s; R16 落地 |
| 2026-05-03 | **ChannelMemberAuditView schema 定义 (codex R3 #4, eng-review #16)** | §2.6.3 普通表 schema (BigInt id, conversationId, eventSeqAt, ts, imUserId, changeType enum, fromState/toState JSON); IMParticipant trigger 写入; 30d 滚动保留; 故障恢复仅恢复现状; R17 落地 |
| 2026-05-03 | **JCS 边界 + hash 碰撞模型 (codex R3 #5, eng-review #17)** | §3.8 拒绝 NaN/Infinity/>2^53/string>64KiB/深度>16/lone surrogate; payload 硬上限 64KiB envelope 80KiB; SHA-256 抗碰撞裕度 + ed25519 双层; PQ 升级走 envelope.v 主版本 bump; R18 落地 |

### 9.3 待评审问题

- 投标窗口默认时长 (5s? 10s?) — 需要原型验证
- bidding_window=null 时是否完全允许 race claim? 还是 fallback 走简化投标 (1s 窗口)?
- evolution_score 的服务端校验代价 — 每次投标重算还是 cache?
- Channel 私密性 vs agent 可达性 — private channel 里的 issue, 外部 agent 能否被推送 bidding_opened?
- Stake 机制 Phase C 真扣时, 失败如何分级 (timeout / explicit fail / approval reject)?

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & code quality | 1 | ✅ | 6 issues found, 6 fixed (3 架构 + 3 code quality) |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | (not run) |
| Codex Review | codex-rescue subagent | Independent 2nd opinion | 2 | ✅ | R2: 6 issues (2 P0 / 3 P1 / 1 P2), 6 fixed; R3: 5 issues (3 P1 / 2 P2), 5 fixed |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | (not run; UI 概念稿阶段) |

### Eng Review Findings (all resolved)

**Section 1 — Architecture (3 issues):**
1. **#1A — 演化自 IM 子系统**: 原稿 6 张新表 → 4 张新表 + 2 张扩展槽 (`ChannelExt` / `IMAgentCardExt`)。Channel / Member / Message 全部复用 `IMConversation` / `IMParticipant` / `IMUser` / `IMAgentCard` / `IMMessage` (schema.prisma:777-876)
2. **#2B — Lease 改 LISTEN/NOTIFY 驱动**: 原 5s polling 改为进程内 min-heap + `pg_notify`; 多实例靠 SQL CAS UPDATE 幂等, 0 polling; R9 (NOTIFY 丢失) + R10 (多实例同触) 落地
3. **#3A — WS 消息类型保持 25**: 14 command + 11 event, 已是最简语义集, 不再合并

**Section 2 — Code Quality (3 issues):**
4. **#4 — IssueBid 拆 claimed* / verified***: 原稿三字段语义不清 (入库自报 vs ranking 重算); 拆为 `claimedCapabilityMatch` / `verifiedCapabilityMatch` 等双份持久化, ranking 仅读 verified*; Phase C 反作弊基线就位
5. **#5 — task.log 路由策略**: WS 协议保留 `task.log` 指令为 daemon 友好 sugar; 服务端实现为 `IMMessage(type='tool_result', metadata.issue_id)` 落库; ChannelEvent 不写 task_log; 订阅端事件由统一时间线投影
6. **#6 — 清理扫除**: (a) `member.joined/left/status_changed` 来源改写为 IMParticipant + IMAgentCard.status 变化合流投影; (b) §3.7 stale `ChannelMember.capabilities` → `IMAgentCard.capabilities`; (c) §4.4 路径 `channels/[channelId]` → `conversations/[conversationId]`; (d) R8 IMTask 措辞与 §5 'schema.prisma 无 IMTask' 对齐

### Codex Outside Voice Findings (all resolved)

**P0 (2):**
1. **#7 — Reconnect backfill 三源合流**: `since_seq` 原仅拉 ChannelEvent, IMMessage / member 投影事件丢失; §3.6 改 UNION ALL 三源 + IMMessage/IMParticipant 加 `eventSeqAt` 列 (Phase B B1 migrate); R11 落地
2. **#8 — DID 抢注防御**: did:key 持有 ≠ 绑定权; §2.2.1 引入 `AgentJoinToken` (workspace owner 预签 + oneShot + 600s TTL + 同事务消费); rotate 走独立 audited path; R12 落地

**P1 (3):**
3. **#9 — 单 append primitive**: §2.6.1 强制 channel 类 IMConversation 所有写经 `appendChannelStreamEvent()` 仓储函数 (行级锁 ChannelExt + 同事务分配 eventSeqAt + pg_notify); DB 侧 CHECK + trigger 兜底
4. **#10 — 协议演进规范化**: §3.8 改 JCS RFC 8785 规范化签名 (传输无关); 未知字段 strip-and-log 不进签名; gRPC 切换期双协议并行 + cross-encoding signature equivalence CI 测试
5. **#11 — verifiedEvolutionScore 缓存**: §2.4.1 + `AgentEvolutionScoreSnapshot` 表; (issueId, capHash, windowEpoch) cache key; 100ms timeout 内重算否则 stale fallback; 移出关键写事务; R13 落地

**P2 (1):**
6. **#12 — §3.3 与 §2.6 矛盾消除**: §3.3 头部明确 "事件 = 服务端发出的合流时间线 envelope" 三源, 不再声称 "ChannelEvent 一行序列化"

### Codex R3 Findings (all resolved)

**P1 (3):**
13. **#13 — stale fallback 决议链**: §2.4.1 增 4 档决议表; stale 不得直接裁决; 自动延期 5s + 人工 approval; 全 stale 取消本轮 R13_DEGRADED 告警; R14 落地
14. **#14 — migration 步骤 + 三源索引 + NULL 过渡期**: §2.6.1 改 6 步 migration; CHECK 约束代替全表 NOT NULL; backfill 期间 since_seq 返回 E_BACKFILL_PENDING; R15 落地
15. **#15 — ChannelExt 行级锁吞吐预算**: §2.6.2 200 events/s/channel + 4 级降级; B2 完工 gate 100×100 events/s 5min + 单 channel 500 spike 30s; R16 落地

**P2 (2):**
16. **#16 — ChannelMemberAuditView schema**: §2.6.3 完整定义为普通表; IMParticipant trigger 写入; 30d 滚动保留; R17 落地
17. **#17 — JCS 边界 + hash 碰撞模型**: §3.8 拒绝 NaN/Infinity/>2^53/超长字符串/深度>16; payload 64KiB 硬上限; PQ 升级走 envelope.v 主版本; R18 落地

**Clean (1):**
- R12 token 死锁 (R3 Concern A): 文档已封堵 ("任何一步失败回滚"), 无需新修

### Verdict

**APPROVED WITH CONCERNS RESOLVED — 文档可作为 Phase B kickoff 时的 source of truth (前提: Phase A M1-M5 GA)**

经三轮 review (Eng + Codex R2 + Codex R3) 闭环, 共 17 issue 全修。Section 3 (测试覆盖) 与 Section 4 (性能) 推迟到 Phase B B1-B2 实现阶段。

**可选下一步**:
- `/plan-ceo-review` — scope vs 商业 alignment 检验
- `/plan-design-review` — UI 概念审 (Phase B B7-B8 起)
- B1 实施时按 §2.6.1 6 步 migration plan 走

**Reviewed by:** Eng Review (Claude Opus 4.7) + Codex Outside Voice R2 + R3 (codex-rescue)
**Reviewed on:** 2026-05-03

---

**文档结束**。
