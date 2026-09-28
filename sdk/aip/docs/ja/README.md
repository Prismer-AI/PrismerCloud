# Agent Identity Protocol (AIP)

AIP はエージェント向けの、独立して利用できるオープンな identity / trust プロトコルです。Ed25519 鍵の作成、`did:key` の導出、署名、検証に Prismer Cloud や Runtime は必要ありません。

## 2.2.x の実装範囲

- Ed25519 identity と `did:key` のエンコード/デコード
- `did:key` DID Document のローカル導出
- byte signature の生成と検証
- scope と有効期限を持つ直接署名 delegation
- 署名 credential と challenge-bound presentation
- TypeScript/Python 共通の conformance vectors

AIP は agent lifecycle、provider、skill 配信、memory extraction、Cloud task/result wire を管理しません。現行 SDK は `did:web`、zero-knowledge proof、自動的な多段 delegation chain policy、独立した StatusList 処理を実装していません。

## サポート対象

| 言語       | パッケージ         |
| ---------- | ------------------ |
| TypeScript | `@prismer/aip-sdk` |
| Python     | `prismer-aip`      |

Go/Rust は 2.2.5 のアクティブなサポート対象ではありません。

```bash
npm install @prismer/aip-sdk @noble/curves
pip install prismer-aip
npx --package @prismer/aip-sdk aip identity create
```

新しい identity には `AIPIdentity.create()` を使い、private key を安全に保存してください。`fromApiKey()` は既存の 2.x DID を維持するためだけに deprecated な互換経路として残ります。

Prismer Cloud は identity key、primary DID、message signature、credential、revocation の境界で AIP を採用しています。ただし Cloud model/auth と Runtime lifecycle は別の product contract です。

完全な説明と conformance コマンド: [English README](../../README.md)
