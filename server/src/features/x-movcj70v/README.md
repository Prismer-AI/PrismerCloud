# X-movcj70v 功能

## 概述

X-movcj70v 是 MVP M3/M4 smoke 测试功能，用于验证混合守护进程工作项分派流程。

## 任务信息

| 属性            | 值                                            |
| --------------- | --------------------------------------------- |
| Work Item ID    | `cmovcjy0w01a9xzly24tnklix`                   |
| Workspace ID    | `cmorrr0r20001xzwel233lwg9`                   |
| Conversation ID | `cmovcjlg3019wxzly63mp7rr7`                   |
| Engineer        | `c7ogssr6aqv` (M3 Engineer movcj70v)          |
| Target Daemon   | `daemon-f82bbcda-24df-48e4-8e8b-2234b55a8fa8` |
| Tag             | `movcj70v`                                    |
| Version         | `1.0.0`                                       |

## 功能说明

此功能验证以下 M3/M4 工作流：

1. **CEO 自动任务分派**: 当自动分派在 15000ms 内未触发时，触发 owner-direct fallback
2. **混合守护进程分派**: 验证 work_item 可以在不同 daemon 之间正确分派
3. **M3/M4 执行路径**: 支持 fallback (M3) 和 active (M4) 两种执行模式

## 核心 API

```typescript
import { executeMovcj70v, verifyMovcj70v } from './index';

// 执行 smoke 测试
const result = executeMovcj70v({
  id: 'cmovcjy0w01a9xzly24tnklix',
  targetDaemonId: 'daemon-f82bbcda-24df-48e4-8e8b-2234b55a8fa8',
  mode: 'm4-active',
  executedAt: new Date(),
});

// 验证结果
const isValid = verifyMovcj70v(result);
// result.token === 'M4OK-movcj70v'
```

## 测试

```bash
# 运行测试
npx vitest run src/features/x-movcj70v/index.test.ts
npx vitest run src/lib/__tests__/features/x-movcj70v.test.ts
```

## 验证标记

成功执行后，结果包含验证标记: **M4OK-movcj70v**

## 状态

- [x] 需求分析
- [x] 设计方案
- [x] 代码实现
- [x] 测试验证
- [ ] 代码审查
