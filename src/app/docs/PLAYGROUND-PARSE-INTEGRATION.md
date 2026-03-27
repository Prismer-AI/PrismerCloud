# Playground Parse 能力集成设计

**版本**: 1.0.0  
**创建日期**: 2026-01-25  
**状态**: 设计中

---

## 目录

1. [概述](#1-概述)
2. [当前 Playground 架构](#2-当前-playground-架构)
3. [Parse 能力集成方案](#3-parse-能力集成方案)
4. [UI/UX 设计](#4-uiux-设计)
5. [技术实现](#5-技术实现)
6. [Parse → Context Save 流程](#6-parse--context-save-流程)
7. [行动计划](#7-行动计划)

---

## 1. 概述

### 1.1 目标

为 Playground 添加 Parse 能力，支持用户直接上传或指定 PDF/图片 URL 进行解析，并将解析结果作为 Context 存储到全局缓存。

### 1.2 核心功能

- **文件上传**: 拖拽或选择本地 PDF/图片文件
- **URL 输入**: 输入 PDF/图片 URL 进行解析
- **模式选择**: Fast (快速) / HiRes (高精度) 模式
- **结果展示**: 显示解析的 Markdown 和原始文本
- **一键存储**: 将解析结果存入 Context 缓存

---

## 2. 当前 Playground 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Playground 页面                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  输入区域                                                                │
│  ─────────                                                              │
│  - 文本输入框 (URL 或 Query)                                             │
│  - Strategy 选择器 (Auto, Technical, Finance, Academic, Legal)          │
│  - Submit 按钮                                                          │
│                                                                         │
│  输出区域                                                                │
│  ─────────                                                              │
│  - Raw Tab: 原始内容                                                     │
│  - HQCC Tab: 压缩后的高质量上下文                                        │
│  - Sources Tab: 多来源切换 (Query 模式)                                  │
│                                                                         │
│  处理流程                                                                │
│  ─────────                                                              │
│  1. URL → /api/context/load → 缓存检查 → 压缩 → 存储                     │
│  2. Query → /api/search → /api/compress → 存储                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Parse 能力集成方案

### 3.1 输入模式扩展

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         输入模式                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [URL/Query]  [Parse Document]                    ← 模式切换 Tab         │
│                                                                         │
│  URL/Query 模式 (现有)                                                   │
│  ────────────────────                                                   │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  Enter URL or search query...                                     │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  Parse Document 模式 (新增)                                             │
│  ────────────────────────                                               │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │                                                             │ │ │
│  │  │     📄 Drop PDF or image here, or click to browse          │ │ │
│  │  │                                                             │ │ │
│  │  └─────────────────────────────────────────────────────────────┘ │ │
│  │                          OR                                       │ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │  https://example.com/document.pdf                           │ │ │
│  │  └─────────────────────────────────────────────────────────────┘ │ │
│  │                                                                   │ │
│  │  Mode: [Fast ▾]  [ ] Save to Context                            │ │
│  │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 输出展示扩展

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         输出区域                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [Raw] [HQCC] [Sources] [Parse Result]           ← Tab 扩展             │
│                                                                         │
│  Parse Result Tab (新增)                                                │
│  ─────────────────────                                                  │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                                                                   │ │
│  │  📊 Pages: 16  |  🎯 Mode: fast  |  ⏱️ 2.1s  |  💰 0.16 credits   │ │
│  │                                                                   │ │
│  │  ────────────────────────────────────────────────────────────────│ │
│  │                                                                   │ │
│  │  # Document Title                                                 │ │
│  │                                                                   │ │
│  │  ## Section 1                                                     │ │
│  │  Lorem ipsum dolor sit amet...                                    │ │
│  │                                                                   │ │
│  │  ## Section 2                                                     │ │
│  │  ...                                                              │ │
│  │                                                                   │ │
│  │  ────────────────────────────────────────────────────────────────│ │
│  │                                                                   │ │
│  │  [Copy Markdown] [Save to Context] [Compress to HQCC]            │ │
│  │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. UI/UX 设计

### 4.1 模式切换

```tsx
// 顶部 Tab 切换
<div className="flex gap-2 mb-4">
  <button 
    className={mode === 'load' ? 'active' : ''}
    onClick={() => setMode('load')}
  >
    URL/Query
  </button>
  <button 
    className={mode === 'parse' ? 'active' : ''}
    onClick={() => setMode('parse')}
  >
    Parse Document
  </button>
</div>
```

### 4.2 文件上传组件

```tsx
// 拖拽上传区域
<div 
  className="border-2 border-dashed rounded-xl p-8 text-center"
  onDrop={handleDrop}
  onDragOver={handleDragOver}
>
  <FileUp className="w-12 h-12 mx-auto mb-4 text-zinc-400" />
  <p>Drop PDF or image here</p>
  <p className="text-sm text-zinc-500">or click to browse</p>
  <input 
    type="file" 
    accept=".pdf,.png,.jpg,.jpeg,.webp"
    onChange={handleFileSelect}
    className="hidden"
  />
</div>
```

### 4.3 处理进度展示 (HiRes 异步模式)

```tsx
// 异步任务进度
{isAsync && (
  <div className="flex items-center gap-4">
    <div className="flex-1 bg-zinc-800 rounded-full h-2">
      <div 
        className="bg-violet-500 h-2 rounded-full transition-all"
        style={{ width: `${progress.percent}%` }}
      />
    </div>
    <span className="text-sm text-zinc-400">
      {progress.completedPages}/{progress.totalPages} pages
    </span>
  </div>
)}
```

---

## 5. 技术实现

### 5.1 状态管理

```typescript
// Playground 状态扩展
interface PlaygroundState {
  // 现有状态
  mode: 'load' | 'parse';  // 新增
  
  // Parse 相关状态
  parseFile: File | null;
  parseUrl: string;
  parseMode: 'auto' | 'fast' | 'hires';
  parseResult: ParseResult | null;
  parseTaskId: string | null;
  parseProgress: ParseProgress | null;
  autoSaveToContext: boolean;
}
```

### 5.2 API 调用

```typescript
// Parse 提交
async function submitParse() {
  if (parseFile) {
    // 文件上传模式
    const formData = new FormData();
    formData.append('file', parseFile);
    formData.append('mode', parseMode);
    
    const response = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });
  } else if (parseUrl) {
    // URL 模式
    const response = await fetch('/api/parse', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: parseUrl, mode: parseMode })
    });
  }
}
```

### 5.3 异步任务轮询

```typescript
// HiRes 模式需要轮询状态
async function pollParseStatus(taskId: string) {
  const poll = async () => {
    const response = await fetch(`/api/parse/status/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await response.json();
    
    setParseProgress(data.progress);
    
    if (data.status === 'completed') {
      // 获取结果
      const result = await fetch(`/api/parse/result/${taskId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      setParseResult(await result.json());
    } else if (data.status === 'failed') {
      // 处理错误
    } else {
      // 继续轮询
      setTimeout(poll, 2000);
    }
  };
  
  poll();
}
```

---

## 6. Parse → Context Save 流程

### 6.1 数据映射

Parse 结果可以转换为 Context 格式存储：

```typescript
// Parse Result → Context Save 映射
interface ParseToContextMapping {
  // Parse 输出
  parseResult: {
    document: {
      markdown: string;      // → hqcc_content (压缩后)
      text?: string;         // → intr_content (原始)
      pageCount: number;
      metadata: object;
      images: Image[];
    }
  };
  
  // Context Save 输入
  contextSave: {
    url: string;             // 原始 PDF URL 或生成的唯一标识
    hqcc: string;            // 压缩后的 markdown
    raw: string;             // 原始 markdown
    meta: {
      source: 'parse',
      mode: 'fast' | 'hires',
      pageCount: number,
      detections?: object[], // OCR detection 信息
      images?: Image[]
    }
  };
}
```

### 6.2 流程图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Parse → Context Save 流程                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Step 1: Parse                                                          │
│  ─────────────                                                          │
│  POST /api/parse { url: "...pdf", mode: "fast" }                       │
│                    ↓                                                    │
│  返回: { markdown: "# Title\n...", pageCount: 16, ... }                │
│                                                                         │
│  Step 2: Compress (可选)                                                │
│  ─────────────────────                                                  │
│  如果 markdown 太长，调用 /api/compress 进行二次压缩                      │
│  POST /api/compress { content: markdown, strategy: "document" }         │
│                    ↓                                                    │
│  返回: { hqcc: "# Summary\n...", model: "gpt-4o" }                      │
│                                                                         │
│  Step 3: Save to Context                                                │
│  ───────────────────────                                                │
│  POST /api/context/save {                                               │
│    url: "https://example.com/doc.pdf",                                  │
│    hqcc: compressed_content,                                            │
│    raw: original_markdown,                                              │
│    meta: { source: "parse", mode: "fast", pageCount: 16 }              │
│  }                                                                      │
│                    ↓                                                    │
│  返回: { success: true, status: "created" }                            │
│                                                                         │
│  Step 4: 后续使用                                                        │
│  ──────────────                                                         │
│  GET /api/context/load { input: "https://example.com/doc.pdf" }        │
│                    ↓                                                    │
│  返回: 缓存命中，直接返回 hqcc                                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.3 URL 生成策略

对于上传的文件，需要生成唯一的 URL 标识：

```typescript
// 方案 1: 基于文件 hash
const fileHash = await crypto.subtle.digest('SHA-256', fileBuffer);
const url = `prismer://parse/${hashToHex(fileHash)}`;

// 方案 2: 基于 task_id
const url = `prismer://parse/${taskId}`;

// 方案 3: 上传到 CDN 后使用真实 URL
const cdnUrl = await uploadToS3(file);
const url = cdnUrl;
```

---

## 7. 行动计划

### Phase 1: UI 改造 (2-3 天)

| # | 任务 | 优先级 |
|---|------|--------|
| 1.1 | 添加模式切换 Tab (URL/Query vs Parse) | P0 |
| 1.2 | 实现文件拖拽上传组件 | P0 |
| 1.3 | 添加 Parse URL 输入框 | P0 |
| 1.4 | 实现 Mode 选择器 (Fast/HiRes) | P1 |
| 1.5 | 添加 Parse Result Tab | P0 |

### Phase 2: 功能实现 (2-3 天)

| # | 任务 | 优先级 |
|---|------|--------|
| 2.1 | 实现文件上传 Parse 调用 | P0 |
| 2.2 | 实现 URL Parse 调用 | P0 |
| 2.3 | 实现 HiRes 异步轮询 | P1 |
| 2.4 | 实现进度展示 | P1 |
| 2.5 | 实现结果展示 | P0 |

### Phase 3: Context 集成 (2-3 天)

| # | 任务 | 优先级 |
|---|------|--------|
| 3.1 | 实现 "Save to Context" 按钮 | P0 |
| 3.2 | 实现 Parse → Compress 流程 | P1 |
| 3.3 | 实现 URL 生成策略 | P1 |
| 3.4 | 实现 "Compress to HQCC" 按钮 | P1 |

### Phase 4: 测试与优化 (1-2 天)

| # | 任务 | 优先级 |
|---|------|--------|
| 4.1 | 端到端测试 | P0 |
| 4.2 | 错误处理优化 | P1 |
| 4.3 | 性能优化 (大文件) | P2 |
| 4.4 | 更新文档 | P1 |

---

## 附录 A: 费用说明

| 操作 | 费用 |
|------|------|
| Parse Fast | 0.01 credits/页 |
| Parse HiRes | 0.1 credits/页 + 0.05 credits/图 |
| Compress | 0.1 credits/1000 tokens |
| Save | 免费 |
| Load (缓存命中) | 免费 |

---

## 附录 B: 相关文档

- [PARSE-API-DESIGN.md](./PARSE-API-DESIGN.md) - Parse API 设计
- [FRONTEND-FIRST-IMPLEMENTATION.md](./FRONTEND-FIRST-IMPLEMENTATION.md) - 前端先行策略
- [CLOUD-SERVICES-API.md](./CLOUD-SERVICES-API.md) - 对外 API 文档
