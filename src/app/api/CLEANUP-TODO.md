# API 代码清理目标

> 创建时间: 2026-01-25
> 状态: 待清理

## 背景

当前 Playground 的处理流程存在新旧两套代码：

```
submitTask (src/lib/api.ts)
├── 主路径: /api/context/load (新 API，服务端)
└── Fallback: _processUrl / _processQuery (旧代码，客户端)
```

新的 `/api/context/load` API 已经覆盖了旧代码的所有功能，旧代码仅作为 fallback 保留。

---

## 1. 新旧代码对齐状态

| 功能 | 旧代码 (`api.ts`) | 新代码 (`/api/context/load`) | 状态 |
|------|------------------|------------------------------|------|
| Query 内容过滤 | ✅ `MIN_CONTENT_LENGTH = 1000` | ✅ 已补上 | ✅ 已对齐 |
| URL 内容过滤 | ✅ `< 500 字符` 过滤 | ✅ 已补上 | ✅ 已对齐 |
| 缓存查询 | 并发请求 hqcc + intr | 单请求 format 参数 | ✅ OK |
| 使用量记录 | ❌ 无 | ✅ recordUsageBackground | ✅ 新增功能 |
| 结果排序 | ❌ 无 | ✅ Ranking 模块 | ✅ 新增功能 |

---

## 2. 可清理的旧代码

### 文件: `src/lib/api.ts`

以下函数可以在确认新 API 稳定后删除（约 400 行）：

| 函数 | 行号 | 说明 | 依赖 |
|-----|------|------|------|
| `_processUrl` | 385-443 | 旧 URL 处理流程 | `_tryWithdrawFromContext`, `_compressContent`, `_depositToContext`, `_buildCachedResult`, `_buildNoResultsResponse`, `_buildSingleSourceResult` |
| `_processQuery` | 452-533 | 旧 Query 处理流程 | `_checkMultipleCache`, `_compressContent`, `_depositToContext`, `_buildNoResultsResponse`, `_buildMultiSourceResult` |
| `_tryWithdrawFromContext` | 539-589 | 旧缓存检查（单 URL） | - |
| `_checkMultipleCache` | 592-659 | 旧批量缓存检查 | - |
| `_compressContent` | 662-705 | 旧压缩逻辑 | - |
| `_depositToContext` | 708-748 | 旧存储逻辑 | - |
| `_buildCachedResult` | 751-780 | 旧缓存结果构建 | - |
| `_buildNoResultsResponse` | 783-805 | 旧空结果构建 | - |
| `_buildSingleSourceResult` | 808-840 | 旧单源结果构建 | - |
| `_buildMultiSourceResult` | 843-920 | 旧多源结果构建 | - |

### 清理后需要修改

删除上述函数后，需要同步修改 `submitTask` 中的 fallback 逻辑：

```typescript
// 当前代码 (src/lib/api.ts:354-363)
} catch (error) {
  console.error('[submitTask] Error:', error);
  // Fallback 到旧的处理方式（兼容性）
  console.log('[submitTask] Falling back to legacy processing...');
  if (inputIsUrl) {
    return await this._processUrl(trimmedInput, strategy, startTime, onStream);
  } else {
    return await this._processQuery(trimmedInput, strategy, startTime, onStream);
  }
}

// 清理后应改为
} catch (error) {
  console.error('[submitTask] Error:', error);
  throw new Error('Failed to process request');
}
```

---

## 3. 相关类型定义

以下类型在清理旧代码后可能变为未使用，需要检查：

```typescript
// src/lib/api.ts 顶部
interface CacheResult {
  url: string;
  cached: boolean;
  hqcc?: string;
  raw?: string;
  meta?: Record<string, unknown>;
}

interface ExaContentsResponse {
  results: ExaContentResult[];
}

interface ExaContentResult {
  url: string;
  title?: string;
  text: string;
  imageLinks?: string[];
}
```

---

## 4. 清理步骤

### Phase 1: 验证新 API 稳定性（当前阶段）
- [x] 确保新旧逻辑对齐
- [ ] 在测试环境运行一段时间
- [ ] 收集错误日志，确认 fallback 未被触发

### Phase 2: 删除 Fallback
- [ ] 修改 `submitTask` 移除 fallback 逻辑
- [ ] 删除旧的处理函数
- [ ] 清理未使用的类型定义

### Phase 3: 代码优化
- [ ] 简化 `api.ts`，保留必要的 API 调用
- [ ] 考虑将部分逻辑移至服务端

---

## 5. 注意事项

1. **不要急于清理**：保留 fallback 可以在新 API 出问题时自动降级
2. **监控 fallback 触发**：如果 fallback 经常被触发，说明新 API 有问题
3. **渐进式清理**：可以先删除 fallback，观察一段时间后再删除旧函数

---

## 6. 相关文件

- 新 API: `src/app/api/context/load/route.ts`
- 旧代码: `src/lib/api.ts`
- 使用量记录: `src/lib/usage-recorder.ts`
- 排序模块: `src/lib/ranking.ts`
- Feature Flags: `src/lib/feature-flags.ts`
