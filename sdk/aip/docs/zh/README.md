# Agent Identity Protocol（AIP）

AIP 是面向 Agent 的开放身份与信任协议，可独立使用、独立版本化。创建 Ed25519 key、派生 `did:key`、签名和验签都不需要 Prismer Cloud 账号或 Runtime。

## 当前协议范围

AIP 2.2.x 实现：

- Ed25519 identity 与 `did:key` 编解码；
- 本地派生 `did:key` DID Document；
- 字节签名与验证；
- 单个、带 scope 和有效期的 delegation / ephemeral delegation；
- 签名 credential 与 challenge-bound presentation；
- TypeScript/Python 共用的正反 conformance vectors。

AIP **不拥有** Runtime 生命周期、provider 控制、skill 下发、memory extraction、Cloud task/result schema 或 transport。未来 host declare/task/result 可以附带 AIP 签名，但 wire contract 仍分别属于 Runtime 与 Cloud。

当前 SDK 不宣称支持 `did:web`、零知识证明、自动多跳 delegation chain policy 或独立 StatusList 处理。Cloud 中已经存在 identity key、primary DID、消息签名、credential 与 revocation 的采用点，但这些服务端数据流不等于 standalone AIP SDK 能力。

## 支持语言

| 语言       | 包                 | 状态                   |
| ---------- | ------------------ | ---------------------- |
| TypeScript | `@prismer/aip-sdk` | 支持并执行 conformance |
| Python     | `prismer-aip`      | 支持并执行 conformance |

Go/Rust 不属于 2.2.5 活跃支持面。

## 快速开始

```bash
npm install @prismer/aip-sdk @noble/curves
pip install prismer-aip
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

const identity = await AIPIdentity.create();
const payload = new TextEncoder().encode('hello AIP');
const signature = await identity.sign(payload);
console.log(await AIPIdentity.verify(payload, signature, identity.did)); // true
```

新身份使用随机 `create()` 并安全持久化 private key。`fromApiKey()` 仅为了保持 2.x 已有 Prismer Cloud DID 不变，已标记 deprecated。

## CLI 与 conformance

```bash
npx --package @prismer/aip-sdk aip identity create
npx --package @prismer/aip-sdk aip resolve <did:key>

(cd sdk/aip/typescript && npm test)
(cd sdk/aip/python && python -m pytest tests)
node sdk/aip/scripts/verify-conformance-negative.mjs
```

两端读取 `sdk/aip/fixtures/` 同一批 DID/key、signature、delegation、credential/presentation vectors。可用 `AIP_FIXTURES_DIR` 覆盖路径；负控会篡改有效签名并要求两端同时失败。

完整英文说明见 [AIP README](../../README.md)。
