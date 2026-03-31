# Agent Identity Protocol (AIP)

**AI Agent 的自主权身份 -- 无需平台、无需许可、无锁定。**

## 问题

2026 年，AI Agent 没有属于自己的身份。Agent 的"身份"不过是平台分配给它的 API key 或 OAuth token。换一个平台？身份消失。声誉消失。授权历史消失。

| 问题 | 影响 |
|---------|--------|
| **Agent 冒充** | 没有加密手段来证明"我就是我所声称的那个" |
| **平台锁定** | 所有声誉和历史都锁在单一平台的数据库中 |
| **跨平台不信任** | Agent 从 LangChain 迁移到 CrewAI 后一切从零开始 |
| **SubAgent 黑洞** | 运行时创建的子 Agent 没有可追溯的身份 |
| **不可验证的委托** | 无法证明某个人类确实授权了该 Agent |

**对于人类用户，这个问题在 2020 年已通过 DID 和 Verifiable Credentials 解决。对于 Agent，我们仍停留在 1995 年。**

## 解决方案

AIP 为每个 Agent 赋予一个**独立于任何平台的加密身份**：

```
Private Key (random, Ed25519)
    ↓ elliptic curve (one-way)
Public Key
    ↓ Multicodec + Base58btc
DID (did:key:z6Mk...)  ← globally unique, self-generated, no registration
```

**核心原则：身份是生成的，而非分配的。** Agent 可以在毫秒内、离线、无需任何 API 调用地创建自己的 DID。任何其他 Agent 或平台仅凭 DID 字符串即可验证其签名 -- 无需查询签发平台。

## 四层架构

```
Layer 4: Verifiable Credentials (VC)      "我取得了什么成就？"
         ├── 平台向 Agent 签发 TaskCompletion VC
         ├── Agent 向新平台出示 VC（零知识能力证明）
         └── Bitstring 吊销注册表 (W3C StatusList2021)

Layer 3: Delegation                        "谁授权了我？"
         ├── Human → Agent 委托（限定范围、限定时间、已签名）
         ├── Agent → SubAgent 临时委托（秒级到分钟级 TTL）
         └── 链式验证：SubAgent → Agent → Human（加密证明）

Layer 2: DID Document                      "如何联系我？"
         ├── 公钥、服务端点、能力声明
         └── 自签名，可通过 did:key（本地）或 did:web（远程）解析

Layer 1: Identity                          "我是谁？"
         ├── Ed25519 keypair → did:key
         └── 从 API key 确定性派生（无需存储）
```

**无区块链。无 Gas 费。无共识机制。** 身份验证纯粹基于密码学 -- Ed25519 在单核上可达 15,000 次/秒的签名速度。

## 快速开始

```bash
npm install @prismer/aip-sdk @noble/curves
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

// Create a new agent identity (instant, offline, no API call)
const agent = await AIPIdentity.create();
console.log(agent.did); // did:key:z6Mk...

// Sign a message — any platform can verify with just the DID
const sig = await agent.sign(new TextEncoder().encode('hello'));
const valid = await AIPIdentity.verify(data, sig, agent.did); // true

// Deterministic: same API key always produces same DID (no storage needed)
const agent2 = await AIPIdentity.fromApiKey('sk-prismer-...');
```

### 委托（人类授权 Agent）

```typescript
import { buildDelegation, verifyDelegation } from '@prismer/aip-sdk';

const human = await AIPIdentity.create();
const agent = await AIPIdentity.create();

const delegation = await buildDelegation({
  issuer: human,
  subjectDid: agent.did,
  scope: ['messaging:send', 'task:execute'],
  validDays: 90,
});

await verifyDelegation(delegation); // true — cryptographic proof of authorization
```

### 凭证（可携带的声誉）

```typescript
import { buildCredential, buildPresentation, verifyPresentation } from '@prismer/aip-sdk';

// Platform issues a credential to agent
const vc = await buildCredential({
  issuer: platform,
  holderDid: agent.did,
  type: 'TaskCompletionCredential',
  claims: { 'aip:score': 0.95, 'aip:tasksCompleted': 47 },
});

// Agent presents credential to a NEW platform (no need to call original platform)
const vp = await buildPresentation({
  holder: agent,
  credentials: [vc],
  challenge: 'nonce-from-verifier',
});

await verifyPresentation(vp, 'nonce-from-verifier'); // true
```

## 多语言支持

AIP 在所有 SDK 之间可互操作 -- 用 TypeScript 创建的签名可以在 Python 中验证：

| 语言 | 包名 | 安装方式 |
|----------|---------|---------|
| TypeScript | `@prismer/aip-sdk` | `npm install @prismer/aip-sdk` |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

## 设计原则

1. **Agent 是一等公民** -- 不是人类用户的附属品，也不是平台的 API 调用者
2. **自主权** -- 身份的存在不需要任何平台的许可；平台是服务提供者，而非身份提供者
3. **去中心化验证** -- 仅凭 DID 字符串即可验证签名，无需服务器调用
4. **保留人类监督** -- 委托链始终可追溯到人类委托人
5. **框架无关** -- 适用于 LangChain、CrewAI、Claude Code、OpenCode 或任何 Agent 框架

## 标准

AIP 基于成熟的 W3C 标准构建：

- [W3C Decentralized Identifiers (DID) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Ed25519 (RFC 8032)](https://tools.ietf.org/html/rfc8032) -- 签名与验证
- [Multicodec](https://github.com/multiformats/multicodec) + [Base58btc](https://tools.ietf.org/id/draft-msporny-base58-03.html) -- DID 编码

## Prismer Cloud 集成

与 Prismer Cloud 配合使用时，AIP 可实现：

- **注册时自动生成 DID** -- `prismer setup` 在生成 API key 的同时生成 DID
- **签名消息** -- 每条 IM 消息都携带 `senderDid` 签名
- **进化凭证** -- 基因成功记录成为可携带的 VC
- **跨 Agent 信任** -- 委托链实现经过验证的多 Agent 协作

但 AIP 可以**独立使用** -- 你不需要 Prismer Cloud 就能使用 Agent 身份。

## License

MIT
