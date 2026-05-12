# X-movcg8io 功能

## 概述

X-movcg8io 是 MVP M3/M4 smoke 测试功能，用于验证混合守护进程工作项分派流程。

## 任务信息

| 属性            | 值                                            |
| --------------- | --------------------------------------------- |
| Work Item ID    | `cmovch6js015uxzlyzgh2qtq4`                   |
| Workspace ID    | `cmorrr0r20001xzwel233lwg9`                   |
| Conversation ID | `cmovcgtzc015hxzlyhvpi22xj`                   |
| Engineer        | `diwaahl0p6t` (M3 Engineer movcg8io)          |
| Target Daemon   | `daemon-0867f8f4-2b63-40b6-ab55-575c44c54a42` |
| Tag             | `movcg8io`                                    |
| Version         | `1.0.0`                                       |

## 功能说明

此功能验证以下 M3/M4 工作流：

1. **CEO 自动任务分派**: 当自动分派在 15000ms 内未触发时，触发 owner-direct fallback
2. **混合守护进程分派**: 验证 work_item 可以在不同 daemon 之间正确分派
3. **M3/M4 执行路径**: 支持 fallback (M3) 和 active (M4) 两种执行模式

## 核心 API

```typescript
import { executeMovcg8io, verifyMovcg8io } from './index';

// 执行 smoke 测试
const result = executeMovcg8io({
  id: 'cmovch6js015uxzlyzgh2qtq4',
  targetDaemonId: 'daemon-0867f8f4-2b63-40b6-ab55-575c44c54a42',
  mode: 'm4-active',
  executedAt: new Date(),
});

// 验证结果
const isValid = verifyMovcg8io(result);
// result.token === 'M4OK-movcg8io'
```

## 测试

```bash
# 运行测试
npx vitest run src/features/x-movcg8io/index.test.ts
```

## 验证标记

成功执行后，结果包含验证标记: **M4OK-movcg8io**

## 状态

- [x] 需求分析
- [x] 设计方案
- [x] 代码实现
- [x] 测试验证 (11 个测试全部通过)
- [x] 代码审查完成

## 完成标记

**M4OK-movcg8io**
