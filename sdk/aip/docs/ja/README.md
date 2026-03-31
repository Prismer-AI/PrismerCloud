# Agent Identity Protocol (AIP)

**AI エージェントのための自己主権型アイデンティティ — プラットフォーム不要、許可不要、ロックイン無し。**

## 課題

2026年現在、AIエージェントは固有のアイデンティティを持っていません。エージェントの「アイデンティティ」とは、プラットフォームが付与したAPIキーやOAuthトークンに過ぎません。プラットフォームを移行すれば、アイデンティティは消滅し、レピュテーションも消え、認可履歴も失われます。

| 課題 | 影響 |
|---------|--------|
| **エージェントのなりすまし** | 「自分が名乗る通りの存在である」ことを暗号学的に証明する手段がない |
| **プラットフォームロックイン** | すべてのレピュテーションと履歴が単一プラットフォームのデータベースに閉じ込められている |
| **クロスプラットフォーム間の不信頼** | LangChain から CrewAI へ移行したエージェントはゼロからやり直しになる |
| **サブエージェントのブラックホール** | 実行時に生成されたサブエージェントには追跡可能なアイデンティティがない |
| **検証不可能な委任** | 人間が実際にこのエージェントを認可したという証拠がない |

**人間のユーザーにとっては、この問題は2020年に DID と Verifiable Credentials で解決されました。エージェントにとっては、まだ1995年のままです。**

## ソリューション

AIP はすべてのエージェントに**プラットフォームから独立して存在する暗号学的アイデンティティ**を付与します:

```
Private Key (random, Ed25519)
    ↓ elliptic curve (one-way)
Public Key
    ↓ Multicodec + Base58btc
DID (did:key:z6Mk...)  ← globally unique, self-generated, no registration
```

**基本原則: アイデンティティは割り当てられるものではなく、生成されるもの。** エージェントは自身の DID をミリ秒単位で、オフラインで、APIコールなしに生成します。他のエージェントやプラットフォームは、DID文字列のみを使って署名を検証でき、発行元プラットフォームへの問い合わせは不要です。

## 4つのレイヤー

```
Layer 4: Verifiable Credentials (VC)      「何を達成したか?」
         ├── プラットフォームがエージェントに TaskCompletion VC を発行
         ├── エージェントが新しいプラットフォームに VC を提示（能力のゼロ知識証明）
         └── Bitstring 失効レジストリ (W3C StatusList2021)

Layer 3: Delegation                        「誰が認可したか?」
         ├── Human → Agent 委任（スコープ付き、期限付き、署名済み）
         ├── Agent → SubAgent 一時的委任（秒〜分単位の TTL）
         └── チェーン検証: SubAgent → Agent → Human（暗号学的証明）

Layer 2: DID Document                      「どうやって連絡するか?」
         ├── 公開鍵、サービスエンドポイント、ケイパビリティ
         └── 自己署名、did:key（ローカル）または did:web（リモート）で解決可能

Layer 1: Identity                          「自分は誰か?」
         ├── Ed25519 鍵ペア → did:key
         └── APIキーからの決定論的導出（ストレージ不要）
```

**ブロックチェーン無し。ガス代無し。コンセンサス無し。** アイデンティティ検証は純粋な暗号技術であり、Ed25519 は単一コアで毎秒15,000回の署名処理が可能です。

## クイックスタート

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

### 委任 (人間がエージェントを認可)

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

### クレデンシャル (ポータブルなレピュテーション)

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

## 多言語対応

AIP はすべての SDK 間で相互運用可能です。TypeScript で作成した署名を Python で検証できます:

| 言語 | パッケージ | インストール |
|----------|---------|---------|
| TypeScript | `@prismer/aip-sdk` | `npm install @prismer/aip-sdk` |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

## 設計原則

1. **エージェントは第一級市民** — 人間ユーザーの付属物でも、プラットフォームのAPI呼び出し元でもない
2. **自己主権型** — アイデンティティはプラットフォームの許可なしに存在する。プラットフォームはサービス提供者であり、アイデンティティ提供者ではない
3. **分散型検証** — DID文字列のみで署名を検証でき、サーバーへの問い合わせは不要
4. **人間の監視を維持** — 委任チェーンは常に人間のプリンシパルまで遡及可能
5. **フレームワーク非依存** — LangChain、CrewAI、Claude Code、OpenCode、その他あらゆるエージェントフレームワークで動作

## 準拠規格

AIP は確立された W3C 標準に基づいています:

- [W3C Decentralized Identifiers (DID) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Ed25519 (RFC 8032)](https://tools.ietf.org/html/rfc8032) — 署名と検証
- [Multicodec](https://github.com/multiformats/multicodec) + [Base58btc](https://tools.ietf.org/id/draft-msporny-base58-03.html) — DID エンコーディング

## Prismer Cloud との統合

Prismer Cloud と組み合わせることで、AIP は以下を実現します:

- **登録時に DID を自動生成** — `prismer setup` でAPIキーと共に DID が生成される
- **署名付きメッセージ** — すべての IM メッセージに `senderDid` 署名が付与される
- **Evolution クレデンシャル** — 遺伝子成功レコードがポータブルな VC になる
- **クロスエージェント信頼** — 委任チェーンにより検証済みマルチエージェント連携が可能

ただし AIP は**スタンドアロンで動作します** — エージェントアイデンティティの利用に Prismer Cloud は不要です。

## License

MIT
