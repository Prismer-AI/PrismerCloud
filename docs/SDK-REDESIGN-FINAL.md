# Prismer SDK 全局重设计方案

> **Date:** 2026-03-20
> **Status:** 最终设计文档（待评审 → 实施）
> **前置:** EVOLUTION-SDK-CRITIQUE.md（进化模块专项分析）
> **范围:** 所有 SDK 模块（Context / Parse / IM / Evolution）× 所有语言（TS / Python / Go / Rust）

---

## 0. 现状一句话

**IM 模块有成熟的 local-first 架构（OfflineManager + StorageAdapter + E2E Encryption），但其他三个模块（Context、Parse、Evolution）全部是无状态 HTTP 薄层。**

这意味着同一个 SDK 里存在两个时代的设计思想：IM 是 2026 年的 local-first 设计，其余是 2024 年的"调 API 就完了"设计。

---

## 1. 逐模块诊断

### 1.1 IM — 已有成熟架构（基准线）

```
SDK 侧已有:
  OfflineManager     — outbox 队列 + 增量同步 + SSE 推送
  StorageAdapter     — Memory / IndexedDB / (SQLite)
  E2EEncryption      — AES-256-GCM + ECDH P-256 + PBKDF2
  RealtimeClient     — WebSocket + SSE，自动重连
  Webhook            — HMAC-SHA256 签名验证
```

**IM 是标杆。** 问题不是 IM 做多了，是其他模块做少了。

### 1.2 Context API — 纯 HTTP 薄层

```typescript
// 今天的 Context SDK:
client.load('https://example.com')   → POST /api/context/load   → 等200ms-2s → 返回 HQCC
client.save({ content, uri })        → POST /api/context/save   → 等100ms → 返回

// 没有本地缓存。每次 load 同一个 URL 都是完整的网络往返。
// 服务端有 context_cache 表做缓存，但 SDK 不知道。
```

**浪费在哪里：** Agent 反复 load 同一个 URL（例如项目文档），每次都走网络。服务端 cache 命中后只传输结果，但网络延迟本身就是浪费。

**应该怎样：** SDK 维护一个本地 LRU 缓存（content_uri → HQCC），cache-aside 模式。命中则零延迟返回；未命中则请求服务端，写入本地缓存。TTL 可配置（默认 1h）。

### 1.3 Parse API — 服务端做了不该做的事

```
当前流程（fast mode）:
  Agent SDK → POST /api/parse { url, mode: 'fast' }
    → Next.js route handler
      → HTTP call to parser.prismer.dev
        → Python 服务: PyMuPDF 打开 PDF，提取文本/markdown
          ← 返回结果
      ← 返回结果
    ← 返回结果
  Agent SDK ← 拿到 markdown
```

**四跳网络来做一个 CPU 运算。** PyMuPDF 的 fast mode 不需要 GPU、不需要 LLM、不需要云端资源。它在本地跑完全一样——而且更快（省去三跳网络延迟）。

```
应该的流程（fast mode）:
  Agent SDK → 本地 pdf.js 或 PyMuPDF 提取文本
  完成。零网络。

  HiRes mode → 仍然走服务端（需要 GPU + DeepSeek-OCR）
```

| Parse 模式 | 需要什么                                            | 应该在哪里            |
| ---------- | --------------------------------------------------- | --------------------- |
| **fast**   | PyMuPDF / pdf.js（CPU）                             | **SDK 本地**          |
| **hires**  | DeepSeek-OCR（GPU）                                 | 服务端                |
| **auto**   | 先 fast 本地尝试，页数多/扫描件则 fallback 到 hires | SDK 决策 + 可选服务端 |

### 1.4 Evolution — 完全缺失 local-first（详见 EVOLUTION-SDK-CRITIQUE.md）

```
当前:
  selectGene()     → 同步 HTTP（应该本地计算）
  recordOutcome()  → 同步 HTTP（应该本地队列 + 异步 flush）
  extractSignals() → 不存在于 SDK（应该 SDK 侧提取 + 可选 LLM 增强）
```

---

## 2. 统一设计原则

从 IM 模块的成功中提取的原则，推广到全 SDK：

### 原则 1: 本地优先，网络增强

```
                       能本地做的          必须网络的
                       ────────────       ──────────
Context:               LRU 缓存命中       首次 load（Exa 搜索 + LLM 压缩）
Parse:                 fast mode (PDF)    hires mode (GPU OCR)
IM:                    消息排队/读取       同步确认
Evolution:             gene 选择/outcome   全局先验聚合/蒸馏
```

### 原则 2: 写入不丢，读取可旧

- **写入（outcome, message, save）：** 本地 WAL → 异步 flush。网络断了数据不丢。
- **读取（gene 库, context 缓存, 联系人列表）：** 本地快照 + TTL。可能旧几秒/几分钟，但永远可用。

### 原则 3: 加密覆盖本地存储

IM 的 E2E 加密已经证明：**客户端持有密钥，服务端只见密文**。同样的模式应该覆盖：

- 本地 gene 缓存（防止中间人读取 agent 的策略库）
- 本地 context 缓存（用户的知识可能是敏感的）
- 本地 outcome WAL（执行记录可能包含业务数据）

不需要新的加密方案——复用 E2EEncryption 的 AES-256-GCM，用 agent 的 master key 加密本地存储。

### 原则 4: 算法在本地，聚合在云端

| 操作                           | 计算性质                    | 应该在哪里             |
| ------------------------------ | --------------------------- | ---------------------- |
| Thompson Sampling（Beta 采样） | 纯 CPU 随机数               | SDK 本地               |
| tagCoverageScore（标签匹配）   | 纯 CPU 集合运算             | SDK 本地               |
| Pooled Prior（全局聚合）       | 需要所有 Agent 数据         | 云端                   |
| Gene 蒸馏（LLM 合成）          | 需要 GPU + 跨 Agent capsule | 云端                   |
| PDF 文本提取（PyMuPDF）        | CPU only                    | SDK 本地               |
| PDF OCR（DeepSeek）            | GPU                         | 云端                   |
| LLM 压缩（OpenAI）             | GPU                         | 云端                   |
| Signal 提取（规则）            | CPU only                    | SDK 本地               |
| Signal 提取（LLM 增强）        | Agent 自己的 LLM            | SDK 本地（Agent 注入） |

---

## 3. SDK 统一架构

### 3.1 分层设计

```
┌──────────────────────────────────────────────────────────────────┐
│                    PrismerClient (统一入口)                       │
│                                                                  │
│  client.context.load()    client.parse()    client.im.send()    │
│  client.evolution.select()                                       │
└──────────────┬───────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────┐
│              Local Runtime Layer (新增)                           │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐│
│  │ CacheManager │  │ OutboxManager│  │ LocalComputeEngine      ││
│  │              │  │              │  │                          ││
│  │ Context LRU  │  │ IM writes    │  │ betaSample()            ││
│  │ Gene snapshot│  │ Evo outcomes │  │ tagCoverageScore()      ││
│  │ Edge snapshot│  │ Context save │  │ extractSignals(rules)   ││
│  │ Parse cache  │  │              │  │ parsePdfFast(local)     ││
│  └──────┬──────┘  └──────┬───────┘  └───────────┬─────────────┘│
│         │                │                       │               │
│  ┌──────▼────────────────▼───────────────────────▼─────────────┐│
│  │                  StorageAdapter                              ││
│  │  Memory | IndexedDB | SQLite | Custom                       ││
│  │  + AES-256-GCM 加密层 (复用 E2EEncryption)                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  SyncEngine (新增)                           ││
│  │                                                              ││
│  │  定期 push: outcomes, context saves                          ││
│  │  定期 pull: gene 更新, edge 增量, global prior               ││
│  │  cursor-based 增量同步                                       ││
│  │  SSE 或 polling 可选                                         ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
               │
               │ 网络请求（仅在需要时）
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Prismer Cloud                                  │
│                                                                  │
│  Context: Exa 搜索 + LLM 压缩 + 全局 cache                     │
│  Parse: HiRes GPU OCR (DeepSeek)                                 │
│  IM: 消息路由 + 在线状态 + WebSocket                             │
│  Evolution: Pooled Prior 聚合 + Gene 蒸馏 + A/B 实验            │
│  Sync API: push/pull + cursor + delta 响应                       │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 StorageAdapter 扩展

现有 StorageAdapter 只存 IM 数据（Message, Conversation, Contact, Outbox）。扩展为通用 KV + 结构化存储：

```typescript
interface StorageAdapter {
  // ── 现有 IM 接口（不变） ──
  putMessages(messages: StoredMessage[]): Promise<void>;
  getMessages(conversationId: string, ...): Promise<StoredMessage[]>;
  // ... 省略 ...

  // ── 新增：通用 KV 缓存 ──
  getCache(namespace: string, key: string): Promise<CachedItem | null>;
  setCache(namespace: string, key: string, value: unknown, ttlMs?: number): Promise<void>;
  invalidateCache(namespace: string, key?: string): Promise<void>;

  // ── 新增：Evolution 本地存储 ──
  getGeneSnapshot(): Promise<GeneSnapshot | null>;
  setGeneSnapshot(snapshot: GeneSnapshot): Promise<void>;
  getEdgeSnapshot(): Promise<EdgeSnapshot | null>;
  setEdgeSnapshot(snapshot: EdgeSnapshot): Promise<void>;
  appendOutcome(outcome: PendingOutcome): Promise<void>;
  flushOutcomes(): Promise<PendingOutcome[]>;  // 取出并清空

  // ── 新增：Sync cursor ──
  getSyncCursor(scope: string): Promise<number>;
  setSyncCursor(scope: string, cursor: number): Promise<void>;
}

interface CachedItem {
  value: unknown;
  storedAt: number;
  ttlMs: number;
  encrypted?: boolean;  // 如果启用了加密
}

interface GeneSnapshot {
  genes: Gene[];
  globalPrior: Map<string, { alpha: number; beta: number }>;
  lastSyncAt: number;
  cursor: number;
}

interface EdgeSnapshot {
  edges: Map<string, { success: number; failure: number; lastUsedAt: number }>;
  lastSyncAt: number;
}
```

### 3.3 加密本地存储

```typescript
// 复用现有 E2EEncryption，加密所有本地缓存
class EncryptedStorageAdapter implements StorageAdapter {
  constructor(
    private inner: StorageAdapter, // 实际存储 (IndexedDB, SQLite, ...)
    private encryption: E2EEncryption, // 现有加密模块
    private masterKey: ArrayBuffer, // Agent 的 master key
  ) {}

  async setCache(ns: string, key: string, value: unknown, ttlMs?: number): Promise<void> {
    const plaintext = JSON.stringify(value);
    const ciphertext = await this.encryption.encryptRaw(this.masterKey, plaintext);
    await this.inner.setCache(ns, key, ciphertext, ttlMs);
  }

  async getCache(ns: string, key: string): Promise<CachedItem | null> {
    const item = await this.inner.getCache(ns, key);
    if (!item) return null;
    if (Date.now() - item.storedAt > item.ttlMs) {
      await this.inner.invalidateCache(ns, key);
      return null;
    }
    const plaintext = await this.encryption.decryptRaw(this.masterKey, item.value as string);
    return { ...item, value: JSON.parse(plaintext) };
  }
}
```

---

## 4. 各模块改造方案

### 4.1 Context API — 加缓存层

```typescript
// ── 现有（不变） ──
client.context.load(input); // 首次加载：仍然调服务端

// ── 新增行为 ──
// 1. 自动缓存：load 成功后，结果写入本地 cache（key = content_uri 或 URL hash）
// 2. 再次 load 同 URL：先查本地 cache（TTL 内命中 → 零延迟返回）
// 3. 手动 invalidate：client.context.invalidate(url)
// 4. 预热：client.context.prefetch([url1, url2, ...])  异步加载不等结果

class ContextClient {
  async load(input: string, options?: LoadOptions): Promise<LoadResult> {
    // 1. 查本地缓存
    const cacheKey = this.computeCacheKey(input);
    const cached = await this.storage?.getCache('context', cacheKey);
    if (cached && !options?.skipCache) {
      return cached.value as LoadResult; // 零延迟
    }

    // 2. 请求服务端
    const result = await this._request('POST', '/api/context/load', { input, ...options });

    // 3. 写入本地缓存
    if (result.success && this.storage) {
      await this.storage.setCache('context', cacheKey, result, options?.cacheTtlMs ?? 3600_000);
    }

    return result;
  }
}
```

**工作量：** 1 天（TS SDK），各语言同步 2 天。

### 4.2 Parse API — fast mode 本地化

```typescript
class ParseClient {
  async parse(options: ParseOptions): Promise<ParseResult> {
    const mode = options.mode ?? 'auto';

    // Fast mode: 本地执行
    if (mode === 'fast' || (mode === 'auto' && this.canParseLocally(options))) {
      return this.parseLocal(options);
    }

    // HiRes mode: 服务端（GPU）
    return this._request('POST', '/api/parse', options);
  }

  private async parseLocal(options: ParseOptions): Promise<ParseResult> {
    // TypeScript: 使用 pdf.js (pdfjs-dist)
    // Python: 使用 PyMuPDF (fitz)
    // Go: 使用 pdfcpu 或 go-fitz
    // Rust: 使用 lopdf 或 pdf-extract

    const pdfData = await this.fetchPdfBytes(options.url ?? options.file);
    const doc = await pdfjsLib.getDocument(pdfData).promise;

    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }

    return {
      success: true,
      document: {
        markdown: pages.join('\n\n---\n\n'),
        text: pages.join('\n\n'),
        pageCount: doc.numPages,
      },
    };
  }

  /** 判断是否可以本地解析 */
  private canParseLocally(options: ParseOptions): boolean {
    // 扫描件/图片 → 需要 OCR → 服务端
    // 文本 PDF → 本地 ok
    // 文件太大 (>50MB) → 服务端（避免 OOM）
    if (options.mode === 'hires') return false;
    if (options.fileSize && options.fileSize > 50_000_000) return false;
    return true;
  }
}
```

**各语言实现：**

| 语言       | 本地 PDF 库             | 成熟度 | 输出质量                      |
| ---------- | ----------------------- | ------ | ----------------------------- |
| TypeScript | `pdfjs-dist`（Mozilla） | 生产级 | 高（浏览器同款引擎）          |
| Python     | `PyMuPDF`（fitz）       | 生产级 | 高（和服务端 fast mode 一样） |
| Go         | `pdfcpu` 或 `unidoc`    | 生产级 | 中高                          |
| Rust       | `lopdf` + `pdf-extract` | 可用   | 中                            |

**工作量：** TS 2 天，Python 1 天（PyMuPDF 就是服务端在用的），Go/Rust 各 3 天。

### 4.3 Evolution — Local Evolution Runtime

详见 `EVOLUTION-SDK-CRITIQUE.md` §4，核心改动：

```typescript
interface EvolutionRuntime {
  // 同步本地（不依赖网络）
  selectGene(signals: SignalTag[]): SelectionResult; // 本地 Beta 采样
  extractSignals(context: ExecutionContext): SignalTag[]; // 本地规则 + 可选 LLM

  // 异步后台（网络可选）
  recordOutcome(input: OutcomeInput): void; // 本地 WAL，后台 flush
  sync(): Promise<SyncResult>; // 手动触发同步

  // 生命周期
  initialize(): Promise<void>; // 首次拉取 gene 快照
  close(): Promise<void>; // flush 待上传数据
}
```

**和 IM OfflineManager 的关系：** 复用 StorageAdapter 和 SyncEngine 基础设施，但 outcome 的队列和 IM 的 outbox 是独立的 scope（不混用同步 cursor）。

**工作量：** TS 5 天，Python/Go 各 3 天，Rust 5 天。

### 4.4 IM — 补齐 Evolution 端点进 OfflineManager

当前 `WRITE_PATTERNS` 只匹配 IM 消息操作。Evolution 写操作不在其中，导致离线时 evolution 调用直接失败。

```typescript
// 补入 offline.ts 的 WRITE_PATTERNS:
const WRITE_PATTERNS = [
  // 现有 IM
  { method: 'POST', pattern: /\/api\/im\/(messages|direct|groups)\//, opType: 'message.send' },
  { method: 'PATCH', pattern: /\/api\/im\/messages\//, opType: 'message.edit' },
  { method: 'DELETE', pattern: /\/api\/im\/messages\//, opType: 'message.delete' },
  { method: 'POST', pattern: /\/api\/im\/conversations\/[^/]+\/read/, opType: 'conversation.read' },

  // 新增：Evolution 写操作
  { method: 'POST', pattern: /\/api\/im\/evolution\/record/, opType: 'evolution.record' },
  { method: 'POST', pattern: /\/api\/im\/evolution\/genes$/, opType: 'evolution.create' },
  { method: 'DELETE', pattern: /\/api\/im\/evolution\/genes\//, opType: 'evolution.delete' },
  { method: 'POST', pattern: /\/api\/im\/evolution\/genes\/.*\/publish/, opType: 'evolution.publish' },
];
```

**工作量：** 0.5 天。

---

## 5. SDK 类型对齐 v0.3.0

当前 SDK 类型停在 v0.2.x，服务端已是 v0.3.0。立即修复：

```typescript
// ── types.ts 修复 ──

// 1. GeneCategory 缺 'diagnostic'
export type GeneCategory = 'repair' | 'optimize' | 'innovate' | 'diagnostic';

// 2. GeneVisibility 缺 'canary' | 'quarantined'
export type GeneVisibility = 'private' | 'canary' | 'published' | 'quarantined' | 'seed';

// 3. IMAnalyzeOptions 缺 SignalTag 支持
export interface IMAnalyzeOptions {
  signals?: string[] | SignalTag[];  // v0.3.0: 支持 SignalTag[]
  provider?: string;    // v0.3.0
  stage?: string;       // v0.3.0
  severity?: string;    // v0.3.0
  // ... 其余不变
}

// 4. IMAnalyzeResult 缺 'create_suggested' 和 coverageScore
export interface IMAnalyzeResult {
  action: 'apply_gene' | 'explore' | 'none' | 'create_suggested';
  coverageScore?: number;  // v0.3.0
  signals: SignalTag[];    // v0.3.0 (was string[])
  suggestion?: { category: GeneCategory; signals_match: SignalTag[]; ... };
  // ... 其余不变
}

// 5. IMRecordOutcomeOptions 缺 SignalTag 支持
export interface IMRecordOutcomeOptions {
  signals: string[] | SignalTag[];  // v0.3.0
  // ... 其余不变
}

// 6. 新增 SignalTag 类型
export interface SignalTag {
  type: string;
  provider?: string;
  stage?: string;
  severity?: string;
  [key: string]: string | undefined;
}
```

**工作量：** 2 小时（TS），各语言同步 1 天。

---

## 6. 同步协议（Sync API）

### 6.1 服务端新增端点

```
POST /api/im/evolution/sync
  Request:
    {
      outcomes: PendingOutcome[],      // 待上报的 outcome（批量）
      pullCursor: number,              // 上次拉取的游标
      pullScope: 'genes' | 'edges' | 'prior' | 'all',
    }
  Response:
    {
      // Push 确认
      accepted: number,                // 成功接收的 outcome 数
      rejected: Array<{ id: string, reason: string }>,

      // Pull 增量
      updatedGenes: Gene[],
      deletedGeneIds: string[],
      edgeDelta: Array<{ geneId: string, signalType: string, deltaAlpha: number, deltaBeta: number }>,
      globalPrior: Array<{ geneId: string, alpha: number, beta: number }>,
      promotions: string[],            // canary → published
      quarantines: string[],           // → quarantined
      newCursor: number,
    }
```

### 6.2 SDK 同步引擎

```typescript
class SyncEngine {
  private interval: number = 30_000;  // 默认 30s
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    // 立即执行一次全量拉取
    await this.fullSync();
    // 然后定时增量同步
    this.timer = setInterval(() => this.incrementalSync(), this.interval);
  }

  private async fullSync(): Promise<void> {
    const resp = await this.request('POST', '/evolution/sync', {
      outcomes: await this.storage.flushOutcomes(),
      pullCursor: 0,
      pullScope: 'all',
    });
    await this.applyDelta(resp);
  }

  private async incrementalSync(): Promise<void> {
    const cursor = await this.storage.getSyncCursor('evolution');
    const outcomes = await this.storage.flushOutcomes();
    if (outcomes.length === 0 && /* 距上次 pull 不到 interval */) return;

    const resp = await this.request('POST', '/evolution/sync', {
      outcomes,
      pullCursor: cursor,
      pullScope: 'edges',  // 只拉 edge 增量（gene 变化少，按需全拉）
    });
    await this.applyDelta(resp);
  }

  private async applyDelta(resp: SyncResponse): Promise<void> {
    // 更新本地 gene 快照
    if (resp.updatedGenes.length > 0) { ... }
    // 合并 edge 增量（α/β 是可交换累加量，直接加）
    if (resp.edgeDelta.length > 0) { ... }
    // 更新游标
    await this.storage.setSyncCursor('evolution', resp.newCursor);
  }
}
```

---

## 7. 各语言 SDK 能力矩阵（目标态）

| 能力                | TypeScript |   Python    |     Go      |   Rust   |
| ------------------- | :--------: | :---------: | :---------: | :------: |
| Context LRU 缓存    |     ✅     |     ✅      |     ✅      |    ✅    |
| Parse fast 本地     |  ✅ pdfjs  | ✅ PyMuPDF  |  ✅ pdfcpu  | ✅ lopdf |
| Parse hires 服务端  |     ✅     |     ✅      |     ✅      |    ✅    |
| IM OfflineManager   | ✅ (现有)  |  ✅ (现有)  |  ✅ (现有)  |  ⬜→✅   |
| IM E2E Encryption   | ✅ (现有)  |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |
| Evolution 本地选择  |   ⬜→✅    |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |
| Evolution 本地队列  |   ⬜→✅    |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |
| Signal Enrichment   |   ⬜→✅    |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |
| SyncEngine          |   ⬜→✅    |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |
| 加密本地存储        |   ⬜→✅    |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |
| StorageAdapter 扩展 |  ✅→扩展   | Mem→+SQLite | Mem→+BoltDB | ⬜→+sled |
| 类型对齐 v0.3.0     |   ⬜→✅    |    ⬜→✅    |    ⬜→✅    |  ⬜→✅   |

---

## 8. 实施路径

### Phase 0: 立即修（1-2 天）

| #   | 改动                              | 工作量 |
| --- | --------------------------------- | ------ |
| 0.1 | SDK 类型对齐 v0.3.0（所有语言）   | 1d     |
| 0.2 | Evolution 端点加入 WRITE_PATTERNS | 0.5d   |

### Phase 1: 异步写入（3-5 天）

| #   | 改动                                          | 工作量 |
| --- | --------------------------------------------- | ------ |
| 1.1 | `recordOutcome()` 本地 WAL + 异步 flush（TS） | 2d     |
| 1.2 | Context 本地 LRU 缓存（TS）                   | 1d     |
| 1.3 | Python/Go 同步 1.1 和 1.2                     | 2d     |

### Phase 2: 本地计算（5-8 天）

| #   | 改动                                             | 工作量 |
| --- | ------------------------------------------------ | ------ |
| 2.1 | Parse fast mode 本地化（TS: pdfjs, Py: PyMuPDF） | 3d     |
| 2.2 | `selectGene()` 本地计算 + gene/edge 快照         | 3d     |
| 2.3 | Signal Enrichment Layer（rules 模式）            | 1d     |
| 2.4 | 服务端 Sync API 端点                             | 2d     |

### Phase 3: 完整 local-first（5-8 天）

| #   | 改动                                    | 工作量 |
| --- | --------------------------------------- | ------ |
| 3.1 | SyncEngine（增量 push/pull）            | 3d     |
| 3.2 | 加密本地存储（复用 E2E）                | 2d     |
| 3.3 | Signal Enrichment LLM 注入模式          | 2d     |
| 3.4 | Rust SDK 补齐 OfflineManager + Realtime | 3d     |

### Phase 4: 打磨（持续）

| #   | 改动                                         | 工作量 |
| --- | -------------------------------------------- | ------ |
| 4.1 | Go/Rust 持久化 StorageAdapter（BoltDB/sled） | 3d     |
| 4.2 | Python/Go E2E Encryption                     | 3d     |
| 4.3 | Parse auto mode 智能路由（本地 vs 服务端）   | 2d     |

---

## 9. 不做的事

- **不在 SDK 做 LLM 压缩。** Context load 的 HQCC 压缩需要 OpenAI/Claude API，这是云端能力
- **不在 SDK 做 Pooled Prior 聚合。** 需要所有 Agent 的数据
- **不在 SDK 做 Gene 蒸馏。** 需要跨 Agent capsule + 服务端 LLM
- **不在 SDK 做 HiRes OCR。** 需要 GPU
- **不在 SDK 做消息路由。** IM 消息投递需要服务端知道目标用户的连接
- **不重新发明 CRDT。** α/β 是天然可交换的累加量，merge = 相加就够了

---

## 10. 度量标准

改造完成后，用这些指标衡量收益：

| 指标                                  | 改造前               | 目标                                 |
| ------------------------------------- | -------------------- | ------------------------------------ |
| `selectGene()` P99 延迟               | 200-500ms（网络）    | <2ms（本地）                         |
| `recordOutcome()` 对 Agent 的阻塞时间 | 100-300ms            | 0ms（fire-and-forget）               |
| `parse(fast)` P99 延迟                | 500ms-2s（三跳网络） | <100ms（本地 CPU）                   |
| `context.load()` 缓存命中延迟         | 200ms（网络）        | <1ms（本地）                         |
| 网络断开时可用功能                    | 0%（全部瘫痪）       | 80%+（除首次 load/hires 外全部可用） |
| Outcome 数据丢失率（网络故障时）      | 100%                 | 0%（WAL 持久化）                     |
