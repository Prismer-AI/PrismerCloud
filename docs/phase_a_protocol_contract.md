# Phase A Protocol Contract — WebSocket Envelope v2

> **Status**: W1 deliverable (2026-04-30 ~ 2026-05-06)
> **Authority**: This document is the source of truth for Phase A WS protocol. `services/shared/proto/envelope.go`, `server/src/lib/contracts/wsMessage.ts`, and any future SDK binding MUST conform to this spec. Violations are caught by `scripts/phase_a/schema_contract_guard.sh` in CI.
> **Versioning**: protocol version `v=2`. v1 (legacy) is accepted via `MessageClass=legacy` best-effort path during rolling upgrade; will be removed in V4.
> **Related docs**: PHASE_A_PLAN.md §5.2 (envelope baseline), §V3 (message_class split), PHASE_A_PLAN_V2.md W1 (deliverables).

---

## 0. 设计目标

Phase A 上 daemon 后,WebSocket 是 orchestrator ↔ daemon ↔ web 的唯一控制面. 网络抖动 / daemon 崩溃 / 重连 / 多实例 orchestrator 全部要求消息层做到:

- **at-most-once 状态跃迁** (claim, finish, cancel, approve, push)
- **at-least-once 流式追加** (log, output, heartbeat) + 应用层幂等
- **跨语言一致**: Go (orchestrator/daemon) ↔ TypeScript (server/sdk) ↔ 未来 Python/Rust SDK 必须 byte-exact 序列化
- **可回滚**: `PRISMER_PROTOCOL_ENFORCE=off` 退回 v1 envelope, 10 分钟内完成
- **幂等表可压测**: 重复 100 次同一 `msg_id` 状态只跃迁 1 次, stale `state_version` 拒绝率 100%

---

## 1. 顶层 Envelope

```jsonc
{
  "v": 2,                          // protocol version, 必须 = 2
  "id": "msg_01HK...",             // ULID, 客户端生成, 全局唯一
  "execution_id": "exe_01HK...",   // 关联执行, 服务端用此分流幂等表
  "type": "task.push",             // 消息类型, 见 §3
  "message_class": "stateful",     // "stateful" | "stream" | "legacy", 见 §2
  "timestamp_ms": 1735603200000,   // Unix milliseconds (NOT nanoseconds)
  "trace_id": "trace_...",         // 可选, opentelemetry trace id

  // --- stateful 必填 ---
  "state_version": 7,              // CAS token, 单调递增, > 0
  "payload_hash": "BASE64URL...",  // SHA256(JCS(payload)), 用于审计 / 防重放
  "state_crc": "0xA3F2",           // 可选, 客户端期望的 post-state crc, 服务端比对

  // --- stream 必填 ---
  "stream_id": "stdout",           // 流标识, 同一 execution 下唯一
  "stream_seq": 142,               // 单调递增 seq, 同一 (execution_id, stream_id) 内严格 +1
  "idempotency_key": "key_...",    // 可选, 应用层幂等

  // --- 通用 ---
  "ack_type": "required",          // "required" | "best_effort" | "none", 见 §4
  "signature": "BASE64URL...",     // ed25519(JCS(envelope_without_signature)), 见 §5
  "key_id": "did:key:z6Mk...#k1",  // 签名密钥标识, 配合 IMSigningKey 表 (W2)

  "payload": { ... }               // 类型相关的 body, 见 §6
}
```

### 1.1 字段约束表

| 字段 | 类型 | 必填 | 约束 |
|------|------|-----|------|
| `v` | uint8 | ✅ | 当前必须 = 2; 服务端遇到 v>2 应返回 `426 Upgrade Required` |
| `id` | string(26) | ✅ | ULID, 客户端生成, 服务端不重写 |
| `execution_id` | string | ✅ | 引用 `IMExecution.id`, 缺失即 reject |
| `type` | string | ✅ | 见 §3 类型枚举, 服务端拒绝未知 type |
| `message_class` | enum | ✅ | `stateful`/`stream`/`legacy`; 缺失视为 `legacy` (rolling upgrade compat) |
| `timestamp_ms` | int64 | ✅ | Unix ms; 不允许 ns (会越过 JS Number.MAX_SAFE_INTEGER) |
| `state_version` | int64 | stateful 必填 | > 0, 同一 execution 单调递增 |
| `payload_hash` | string | stateful 必填 | `base64url(sha256(JCS(payload)))` |
| `stream_id` | string | stream 必填 | 同一 execution 下唯一标识一条流 |
| `stream_seq` | int64 | stream 必填 | ≥ 0, 同一 (execution, stream_id) 下严格 +1 |
| `ack_type` | enum | ✅ | 见 §4 |
| `signature` | string | 见 §5 | ed25519(JCS) base64url |
| `key_id` | string | 当 signature 非空必填 | DID + key fragment, 解析成 `IMSigningKey` 行 |
| `payload` | object | ✅ | 类型相关 schema, 见 §6 |

### 1.2 字节序与编码

- **JSON serializer**: RFC 8785 JCS (Canonical JSON), 用于 `payload_hash` 与 `signature` 计算
- **timestamp_ms**: int64, Unix milliseconds, ≤ Number.MAX_SAFE_INTEGER (~9.0e15) → 截止 ~2255 AD 安全
- **state_version / stream_seq**: int64. 任一值越过 `2^53 - 1 (= 9_007_199_254_740_991)` 时, 必须以 string 编码 (e.g., `"state_version": "9007199254740993"`); 否则 TypeScript / JS 客户端会发生静默精度丢失, 破坏 JCS bit-exact 等价并导致签名验证失败. Go / Rust SDK 在序列化时也必须遵循: 当 `value > Number.MAX_SAFE_INTEGER` 时切换为 string. 反序列化两种形式都接受 (number 或 string)
- **base64**: 一律 base64url no padding
- **ULID**: 26 字符 Crockford base32, 客户端生成, 时间排序

### 1.3 与 V3 envelope.go 的对齐 (W1 落地动作)

PHASE_A_PLAN.md V3 envelope.go diff (§V3 lines 2664-2739) 只覆盖了 `id` / `execution_id` / `type` / `payload` / `timestamp_ms` / `state_version` / `signature` / `message_class` / `stream_id` / `stream_seq` / `idempotency_key`. **本文档新增的字段 (`v` / `trace_id` / `payload_hash` / `state_crc` / `ack_type` / `key_id`) W1 必须同步加入 envelope.go**, 否则 schema_contract_guard.sh 会因 `proto:hash` 与 `contract:hash` 不一致而 fail.

W2 task list 同步动作:
- `services/shared/proto/envelope.go` 字段补齐
- `server/src/lib/contracts/wsMessage.ts` 镜像 v2 schema
- PHASE_A_PLAN_V2.md W1 任务清单字段名: `msg_id` → 统一为 `id` (envelope.id), `AckType` → `ack_type` (lower snake_case 与 wire format 一致, Go 端常量保留 PascalCase)

---

## 2. MessageClass 分类与幂等策略

### 2.1 三个类别

| Class | 适用 | 幂等基线 | 表 |
|-------|------|---------|---|
| `stateful` | 状态机跃迁 (claim/finish/cancel/approve/push) | CAS on `(execution_id, state_version)` | `phase_a_msg_dedup_stateful` |
| `stream` | 高频 append-only (log/output/heartbeat) | 单调 seq per `(execution_id, stream_id)` | `phase_a_msg_dedup_stream` |
| `legacy` | v1 客户端 (无 message_class) | 不去重, best-effort 处理 | 无 |

### 2.2 stateful 路径

**(V3.1.1, fixes Codex Round-1 P0 #4 + #5)**: dedup insert 与状态跃迁必须在同一事务内, 且 dedup 行存 `payload_hash` + `msg_type` 用于碰撞检测.

```
BEGIN TX;
  1. INSERT INTO phase_a_msg_dedup_stateful
       (execution_id, state_version, msg_id, msg_type, payload_hash, received_at)
     VALUES (..., NOW())
     ON CONFLICT (execution_id, state_version) DO NOTHING
     RETURNING msg_id, msg_type, payload_hash;

  2a. RowsAffected == 0 → 已存在 → SELECT msg_type, payload_hash FROM ... WHERE (execution_id, state_version) = (...);
      - 若 (incoming.msg_type, incoming.payload_hash) == (existing.msg_type, existing.payload_hash) → ROLLBACK; 返回 ack {result=dedup, code=200} (真正幂等)
      - 否则 → ROLLBACK; 返回 ack {result=reject, code=409, error="state_version collision: payload diverges from first acked attempt"} (P0 #5: 防止 client-side bug 拿旧结果)

  2b. RowsAffected == 1 → 继续状态跃迁 (UPDATE IMExecution / IMTask / approval / ...)
      - 状态跃迁失败 (业务校验 / 死锁 / DB 错) → ROLLBACK 整个事务, dedup 行也回滚 (P0 #4: 不留 ghost)
      - 返回 5xx, 客户端用 same state_version 重试; 因为 dedup 行已回滚, 重试视为首次

COMMIT;
返回 ack {result=accepted, code=200}
```

**P0 #4 修法核心**: dedup 与 state mutation 是**单事务原子操作**, 不存在"dedup 入库 / state 失败"的中间状态. 不需要 TTL 兜底.

**P0 #5 修法核心**: 同 `(execution_id, state_version)` 但 payload 不同 → 视为 client bug, 显式 409 拒绝, 不静默成功.

**stale 拒绝**: 若客户端 `state_version <= server.current_state_version` → 服务端返回 `410 Stale State`, 客户端必须重新拉取最新状态.

**dedup 行 GC**: 表按 `received_at` 分区 (monthly), 30 天后整分区 drop. 不需要逐行 TTL.

### 2.3 stream 路径

```
1. 客户端 next_stream_seq = last_sent_seq + 1
2. 客户端 send envelope with stream_seq = next_stream_seq
3. orchestrator:
   a. SELECT pg_advisory_xact_lock(hashtextextended(execution_id || ':' || stream_id, 0))
   b. SELECT seq FROM phase_a_msg_dedup_stream WHERE ... ORDER BY seq DESC LIMIT 1 FOR UPDATE
   c. 若 stream_seq <= max_seq → ErrDuplicate (==) 或 ErrSeqOutOfOrder (<)
   d. INSERT (execution_id, stream_id, seq, msg_id) — UNIQUE (execution_id, stream_id, seq) 兜底
   e. COMMIT (释放 advisory lock)
4. 失败 → ack {dup: true | reorder: true}; 客户端可丢弃, 不影响应用层
```

**为什么不用 CAS**: stream 消息高频并发 (1000 行/s), CAS 会产生 retry 风暴. advisory lock + UNIQUE 约束既串行同流写入, 又允许多流并发.

### 2.3.1 stream restart 重连协议 (V3.1.1, fixes Codex Round-1 P1 #6)

**问题**: daemon `last_sent_seq` 仅活在内存, 进程重启后清零, 撞上 orchestrator 的 `max_seq`, 触发 `ErrSeqOutOfOrder` 风暴.

**解** (二选一, Phase A 取 a):

**(a) 重连握手 (默认)** — daemon 在 `runtime.hello` 之后, 对每个仍 in-flight 的 `execution_id` 发送 `stream.resume_request`:

```jsonc
{ "type": "stream.resume_request",
  "message_class": "stateful",
  "payload": { "execution_id": "exe_...", "streams": ["stdout", "stderr", "progress"] } }
```

orchestrator 返回 `stream.resume_ack`, 携带每条 stream 的 `last_committed_seq`:

```jsonc
{ "type": "stream.resume_ack",
  "payload": {
    "execution_id": "exe_...",
    "streams": [
      { "stream_id": "stdout",   "last_committed_seq": 142 },
      { "stream_id": "stderr",   "last_committed_seq": 17  },
      { "stream_id": "progress", "last_committed_seq": 3   }
    ]
  } }
```

daemon 重置内存 `last_sent_seq[stream_id] = last_committed_seq`, 后续按 +1 续接.

**(b) 持久化 seq (备选)** — daemon 把 `(execution_id, stream_id) → last_sent_seq` 写本地 sqlite/lmdb, 重启读回. 优点: 无握手开销; 缺点: 增加本地状态 + crash safety 工作量. Phase A 不采用.

**stream_id 稳定性约束**: 同一 `(execution_id, stream_id)` 在 daemon 整个生命周期内必须语义稳定. `stdout` / `stderr` / `progress` 由 daemon hardcode; 未来扩展 stream 必须用确定性命名 (e.g., `tool:bash:1`), 不允许 UUID.

### 2.4 legacy 路径

v1 客户端不带 `message_class` → orchestrator 在 `Validate()` 中将 `MessageClass = legacy` → 路由到 `handleLegacyBestEffort()`:

- 不写 dedup 表
- 重连时可能重放 → 应用层必须幂等 (heartbeat 是, log 也是)
- M2 后 (W4) 全部 daemon 升级 v2 → legacy 分支冷却
- V4 移除 legacy 分支

### 2.4.1 legacy normalization 表 (V3.1.1, fixes Codex Round-1 P0 #2)

**问题**: §4 要求 `ack.ref_id = msg.id`, 但 v1 envelope 的 `id` 字段 (那时叫 `id`) 是可选的, 也没有 v2 的 `state_version` / `payload_hash` / `key_id` / `stream_id`. 桥接层必须明确每个 v2 必填字段在 legacy 路径下如何处理.

**字段分类**:

| v2 字段 | legacy 入站处理 | 备注 |
|---------|---------------|------|
| `v` | 服务端补 `v=1` | wire 上无该字段 |
| `id` | 若缺失, 服务端补 `legacy_<sha256(payload)[:16]>` | 用于 ack ref_id; 同 payload 重连会得到同 id (天然幂等) |
| `execution_id` | 必须存在, 否则直接 `400 reject` | v1 已要求 |
| `type` | 必须存在 | v1 已要求 |
| `message_class` | 服务端硬编码 = `legacy` | wire 上无该字段 |
| `timestamp_ms` | 若 v1 用 `ts` (秒) → 乘 1000; 若 ns → 除 1e6 (启发式: 值 > 1e15 视为 ns) | best-effort, 不参与签名验证 |
| `state_version` | 不要求, **legacy 不进 stateful 幂等表** | 即便消息属性等价于 stateful, 也走 best-effort |
| `payload_hash` | 服务端补 = `sha256(JCS(payload))` | 仅日志用, 不签名校验 |
| `state_crc` | 服务端补 NULL | 不参与逻辑 |
| `stream_id` | 不要求, **legacy 不进 stream 幂等表** | log/heartbeat 重放即重写 (应用层幂等) |
| `stream_seq` | 不要求 | 同上 |
| `ack_type` | 服务端补 `best_effort` | legacy 一律 best_effort |
| `signature` | 若有 → 走 v1 签名路径 (key_id 为空); 若无 → 不验签 | v1 部分消息有签名 |
| `key_id` | 不要求 (v1 用 `did` payload 字段表达) | |

**ack 行为**:

- 若 legacy 消息的服务端补全 id 是 `legacy_<hash>`, ack `ref_id` 即用此 id, 客户端可忽略 (v1 客户端不消费 ack)
- legacy `ack_type=best_effort` → 服务端可选不发 ack, 节省带宽
- 同一 `execution_id` 同时有 v1 + v2 客户端是非法状态, orchestrator 在 hello 阶段拒绝降级

---

## 3. 消息类型矩阵 (Phase A)

| 方向 | `type` | `message_class` | `ack_type` | 说明 |
|------|--------|----------------|-----------|------|
| C→S | `runtime.hello` | stateful | required | 握手首条 |
| C→S | `runtime.heartbeat` | stream (id=`heartbeat`) | best_effort | 20s 心跳 |
| S→C | `runtime.heartbeat_ack` | stream | none | 心跳应答 |
| C→S | `runtime.capability_report` | stateful | required | 上报 CLI 能力 |
| S→C | `task.push` | stateful | required | 派发任务 |
| C→S | `task.accepted` | stateful | required | daemon 接受 |
| C→S | `task.rejected` | stateful | required | daemon 拒绝 |
| C→S | `task.log_chunk` | stream (id=`stdout`/`stderr`) | best_effort | 日志流 |
| C→S | `task.progress` | stream (id=`progress`) | best_effort | 进度 |
| C→S | `task.finished` | stateful | required | 完成 (含 exit_code) |
| S→C | `task.cancel` | stateful | required | 取消任务 |
| C→S | `approval.request` | stateful | required | daemon 请求审批 |
| S→C | `approval.decision` | stateful | required | 决策结果 |

总计 **13 类**. 服务端拒绝未列出的 type.

---

## 4. AckType 与重传

```jsonc
{
  "ack_type": "required" | "best_effort" | "none"
}
```

| AckType | 服务端必须 ack | 客户端重试策略 | 适用 |
|---------|---------------|---------------|------|
| `required` | ✅ | 无 ack 则按指数退避重试 (initial 200ms, max 5s, 5 次后 fail) | 状态跃迁 |
| `best_effort` | 可选 | 不重试, 直接发下一条 | log / heartbeat |
| `none` | ❌ | 无 ack 概念 | server-initiated push 的镜像 |

### 4.1 ack 包格式

```jsonc
{
  "v": 2,
  "id": "ack_01HK...",
  "type": "ack",
  "ref_id": "msg_01HK...",        // 被 ack 的消息 id
  "execution_id": "exe_...",
  "timestamp_ms": 1735603201234,
  "result": "accepted" | "dedup" | "stale" | "reject",
  "code": 200 | 410 | 422 | 500,
  "error": null | { "message": "...", "retry_after_ms": 1000 }
}
```

`result=dedup` 与 `result=accepted` 对客户端语义等价 (都视为成功); `dedup` 仅供调试.

---

## 5. 签名与验签

### 5.1 Phase A 签名分层 (W2 落地)

| 消息类 | Phase A 强签 | 理由 |
|--------|-------------|------|
| `runtime.hello` / `task.push` / `task.finished` / `approval.*` | ✅ ed25519 强签 | 关键状态跃迁 |
| `task.accepted` / `task.rejected` / `task.cancel` | ✅ ed25519 强签 | claim/cancel 防伪造 |
| `runtime.capability_report` | ✅ ed25519 强签 | 决定调度 |
| `runtime.heartbeat` / `task.log_chunk` / `task.progress` | ❌ 仅 sample 1% | 高频, 验签开销不可接受 |

### 5.2 签名输入 (canonical signing model)

```
sig_input = JCS(envelope_without_signature)
signature = base64url(ed25519.sign(private_key, sha256(sig_input)))
```

- `JCS` = RFC 8785 Canonical JSON
- 序列化时移除 `signature` 字段 (避免循环依赖)
- 不移除 `payload_hash` (它是 payload 的 hash, 是签名的一部分)
- 不移除 `key_id` (用于 verifier 选取公钥)

### 5.2.1 Verifier 验签步骤 (V3.1.1, fixes Codex Round-1 P2 #7)

服务端验签按下列**顺序**执行, 任一失败即拒绝:

1. **Recompute payload_hash**: 计算 `expected = base64url(sha256(JCS(envelope.payload)))`, 与 `envelope.payload_hash` byte-for-byte 比对; 不一致 → `400 reject` (envelope 与 payload 解耦伪造)
2. **Resolve key**: 从 `envelope.key_id` 查 `IMSigningKey` 表, 若 `revoked_at IS NOT NULL` → `401 reject`
3. **Time skew**: `|now - timestamp_ms| <= 5min` (避免重放窗口过宽); 超出 → `401 reject`
4. **Verify signature**: 计算 `JCS(envelope_without_signature)`, ed25519 验签; 失败 → `401 reject`
5. **Dedup / state machine**: 通过验签的 envelope 才进入 §2.2 / §2.3 路径

**说明**: 第 1 步先于第 4 步, 是因为 payload_hash 的二次计算便宜 (sha256), 且能在签名计算前快速 fail; 攻击者若伪造 envelope 但保留 signature, 多半是想换 payload, 第 1 步直接挡掉.

### 5.3 跨语言互操作

W2 收尾时必须通过 fixture 测试:
- TypeScript `signMessage.ts` 签出的 envelope, Go `identity/canonical.go` 验签通过
- 反向同样通过
- fixture 文件: `services/shared/proto/testdata/sign_fixtures.json`

---

## 6. Payload Schema (Phase A 关键消息)

> 完整 payload schema 见 `services/shared/proto/schemas/*.json` (W3 落地). 此处列举 W1 闭环必须的 4 类.

### 6.1 `runtime.hello`

```jsonc
{
  "did": "did:key:z6Mk...",
  "session_id": "sess_01HK...",
  "version": "0.1.0",                    // daemon 版本
  "agent_join_token": "ajt_...",         // 一次性 token, 防 DID 抢注 (见 fusion §2.2.1)
  "host": {
    "hostname": "macbook-pro",
    "os": "darwin" | "linux" | "windows",
    "arch": "arm64" | "amd64",
    "platform_version": "14.5.0"
  }
}
```

### 6.2 `task.push` (S→C)

```jsonc
{
  "task_id": "tsk_01HK...",
  "execution_id": "exe_01HK...",
  "title": "Refactor service layer",
  "capability": "claude-code",
  "input": { "prompt": "...", "workdir": "/abs/path" },
  "context_uri": "prismer://private/abc/def",
  "timeout_ms": 600000,
  "requires_approval": false,
  "creator_did": "did:key:z6Mk...",
  "creator_signature": "BASE64URL...",   // creator 对 (task_id|kind|action|payload_hash|nonce|ts) 的签名
  "deadline_ms": 1735689600000
}
```

### 6.3 `task.log_chunk` (C→S, stream)

```jsonc
{
  "execution_id": "exe_01HK...",
  "stream": "stdout" | "stderr",
  "chunks": [
    { "seq": 142, "text": "Compiling...\n", "timestamp_ms": 1735603201000 },
    { "seq": 143, "text": "Build OK\n",     "timestamp_ms": 1735603202000 }
  ]
}
```

注意: envelope `stream_seq` = 该批的第一个 chunk seq. 单 envelope 内 chunks 必须连续 +1.

### 6.4 `task.finished` (C→S, stateful)

```jsonc
{
  "execution_id": "exe_01HK...",
  "exit_code": 0,
  "result_uri": "prismer://private/abc/result.json",
  "duration_ms": 12500,
  "stats": { "stdout_bytes": 14820, "stderr_bytes": 230 },
  "summary": "完成"
}
```

---

## 7. 错误码

服务端 ack 中的 `code`:

| code | result | 含义 | 客户端行为 |
|------|--------|------|----------|
| 200 | accepted / dedup | 成功或去重 | 继续 |
| 400 | reject | envelope 不合法 (缺字段 / 类型错) | 不重试, 上报 bug |
| 401 | reject | 签名无效或 key revoked | 重新协商 key (W2) |
| 410 | stale | state_version 已过期 | 拉取最新状态, 重算 next state |
| 422 | reject | payload schema 不通过 | 不重试 |
| 426 | reject | protocol version 太老 | 升级 daemon |
| 429 | reject | rate-limited | 按 `retry_after_ms` 退避 |
| 500 | reject | 服务端错误 | 指数退避重试, 5 次后 fail |
| 503 | reject | 服务降级 (e.g. db 不可用) | 等 503 中携带的 retry_after |

---

## 8. 失败路径 / 回滚

### 8.1 `PRISMER_PROTOCOL_ENFORCE` 开关

| 值 | 行为 |
|----|------|
| `strict` (默认) | v=2 强制, v=1 拒绝 |
| `mixed` | v=2 走新路径, v=1 走 legacy best-effort |
| `off` | 全部走 v1 legacy 路径, 不走 dedup 表 |

切换 `mixed → strict` 是 W4 升级动作, 切换 `strict → off` 是回滚.

### 8.2 W1 回退点

回滚 commit + 设置 `PRISMER_PROTOCOL_ENFORCE=off` → 服务退回旧 envelope, 预计 10 分钟. CI 上 `schema_contract_guard.sh` 暂时改为 nightly 任务.

### 8.3 应急失效演示

W1 验收必须演示:
1. `schema.prisma` 增虚拟字段不同步 shared query → CI 因 hash mismatch 阻断
2. 注入重复 `msg_id` → orchestrator 仅记录一次状态变更, ack 返回 `result=dedup`
3. 注入 `state_version` 回退 → ack 返回 `code=410, result=stale`

---

## 9. CI 闸门 (W1)

```bash
# 1. Schema 契约一致性
bash scripts/phase_a/schema_contract_guard.sh
# Expected stdout: contract_ok=true

# 2. Go envelope 单测
cd services/shared && go test ./proto/...

# 3. orchestrator dedup 单测
cd services/orchestrator && go test ./internal/proto/...

# 4. (W3) 跨语言 fixture
cd services/shared && go test -run CrossLanguageFixtures ./proto/...
cd server && npx vitest src/lib/contracts/wsMessage.test.ts
```

`schema_contract_guard.sh` 计算:
- `prisma:hash` = sha256(规范化后的 `server/prisma/schema.prisma` envelope/dedup 相关 model)
- `proto:hash` = sha256(规范化后的 `services/shared/proto/envelope.go`)
- `contract:hash` = sha256(本文档 §1, §2.1 表)
- 三 hash 出现任一变化 → 必须同步 PR, 否则 CI 失败

(W3 起切换为 Atlas semantic gating, 见 PHASE_A_PLAN.md §V3 R1)

---

## 10. 与上下文的关系

- **fusion 文档** (`multica-helio-fusion.md`): Phase B+ 设计, 引用本协议作为传输层
- **PHASE_A_PLAN.md V3**: 提供 envelope.go / dedup.go 完整代码 (本文档为 spec, 那里为 impl)
- **PHASE_A_PLAN_V2.md W1-W4**: 提供 weekly cadence (本文档为契约, 那里为时序)
- **AIP `signMessage.ts` / `didKey.ts`**: 提供 ed25519 签名实现, W2 收口

---

## 附录 A: 字段命名规范

- 时间字段统一 `_ms` 后缀, 单位毫秒
- ID 字段统一 ULID, 26 字符
- 哈希字段统一 base64url, 无 padding
- 枚举字段全 lowercase
- 不允许 v1 的 `ts` 简写, v2 一律 `timestamp_ms`

## 附录 B: 与 Phase A V1 (legacy) 的差异

| 字段 | v1 | v2 |
|------|----|----|
| 顶层版本 | `v=1` | `v=2` |
| 时间 | `ts` (ns 或 ms 不一致) | `timestamp_ms` (ms) |
| 幂等 | 仅 `id` | `id` + `state_version` (stateful) / `stream_seq` (stream) |
| 分类 | 无 | `message_class` |
| 签名 | 部分消息有 | 见 §5.1 分层强制 |
| ack | 隐式 | 显式 `ack_type` + ack 包 |
| 错误码 | 自定义文本 | 标准 HTTP code |

## 附录 C: 决议日志

- 2026-04-30 (W1) — 初版, 锁定 v=2 envelope 字段, message_class 三态, ack_type 三态
- 2026-05-04 (W1, V3.1.1) — Codex Round-1 7 项修法落地:
  - **P0 #1**: §1.3 加 V3 envelope.go 对齐表, 列出 W1 必须同步的字段 (`v`/`trace_id`/`payload_hash`/`state_crc`/`ack_type`/`key_id`); 命名统一 `id` / `ack_type`
  - **P0 #2**: §2.4.1 加 legacy normalization 表, 13 个 v2 字段在桥接层的处理规则; 缺 id 时服务端补 `legacy_<sha256(payload)[:16]>`
  - **P1 #3**: §1.2 加 int64 大数规则, `state_version` / `stream_seq` 越过 2^53-1 时必须 string 编码
  - **P0 #4**: §2.2 dedup insert + state mutation 同事务, 失败时 ROLLBACK 整个事务防 ghost 行
  - **P0 #5**: §2.2 dedup 行存 `payload_hash` + `msg_type`, 同 state_version 但 payload 不同返回 409
  - **P1 #6**: §2.3.1 加 stream restart 重连握手 (`stream.resume_request` / `stream.resume_ack`), stream_id 稳定性约束
  - **P2 #7**: §5.2.1 加 verifier 五步流程, 步骤 1 强制 recompute payload_hash 比对
- 2026-05-07 (W2) — TBD: 签名分层 fixture
- 2026-05-14 (W3) — TBD: Atlas semantic gating 替换 hash gating
