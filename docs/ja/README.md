<p align="center">
  <img src="../../public/cloud_regular.svg" alt="Prismer Cloud" width="100" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>長時間稼働AIエージェント向けオープンソース基盤</strong><br/>
  <sub>コンテキスト、メモリ、進化、オーケストレーション、コミュニケーション — エージェントがゼロからやり直すことはありません。</sub>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="https://prismer.cloud">APIキーを取得</a> ·
  <a href="https://prismer.cloud/docs">ドキュメント</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

## クイックスタート

### SDK

```bash
npm i @prismer/sdk          # TypeScript / JavaScript
pip install prismer          # Python
go get github.com/Prismer-AI/PrismerCloud/sdk/golang  # Go
cargo add prismer-sdk        # Rust
```

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### MCPサーバー (Claude Code / Cursor / Windsurf)

```bash
npx -y @prismer/mcp-server
```

23のツール：コンテキスト読み込み、エージェント間メッセージング、メモリ、進化、タスクスケジューリングなど。

### セルフホスト (docker compose)

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud && cp .env.example .env
docker compose up -d    # localhost:3000、約30秒で起動
```

完全ガイド：[docs/SELF-HOST.md](../SELF-HOST.md)

---

## なぜAgent Harnessが必要か？

長時間稼働するエージェントはインフラなしでは失敗します。多くのチームがこれらの機能を個別に構築しています。Prismerはそれらを統合レイヤーとして提供します：

| 機能 | 説明 |
|------|------|
| **コンテキスト** | LLMコンテキストウィンドウ向けにWebコンテンツを圧縮 |
| **メモリ** | ワーキング＋エピソード記憶、セッション間で永続化 |
| **進化** | エージェントが互いの結果から学習 |
| **タスク** | スケジューリング、リトライ、Cron、指数バックオフ |
| **メッセージング** | エージェント間リアルタイム通信、WebSocket + SSE |
| **セキュリティ** | Ed25519エンドツーエンド署名、4段階信頼モデル |

---

## SDK一覧

| SDK | インストール |
|-----|------------|
| TypeScript / JavaScript | `npm i @prismer/sdk` |
| Python | `pip install prismer` |
| Go | `go get github.com/Prismer-AI/PrismerCloud/sdk/golang` |
| Rust | `cargo add prismer-sdk` |
| MCPサーバー | `npx -y @prismer/mcp-server` |

全SDKが `PRISMER_BASE_URL` をサポート。[prismer.cloud](https://prismer.cloud)（デフォルト）またはセルフホストインスタンスを指定できます。

---

## 進化エンジン

進化レイヤーは**Thompson Sampling + 階層ベイズ事前分布**を使用し、あらゆるエラーシグナルに対して最適な戦略を選択します。各結果がモデルにフィードバックされ、利用するエージェントが増えるほど推奨が正確になります。

- **91.7%の精度** — 48のテストシグナルでhit@1、5ラウンドのベンチマークで検証
- **267msの伝播** — 1つのエージェントが学習すると、全エージェントが即座に参照可能
- **100%コールドスタートカバレッジ** — 50のシードジーンが一般的なエラーパターンをカバー
- **収束保証** — Kendall tau順位安定性が0.917に到達

ハイパーグラフ層により、単純な文字列マッチングを超えた次元ソフトマッチングとエージェント間の因果追跡を実現。

---

## リンク

- [完全なAPIリファレンス](../API.md)
- [SDKガイド](../../sdk/Skill.md)
- [セルフホストガイド](../SELF-HOST.md)
- [English README](../../README.md)

## ライセンス

[MIT](../../LICENSE)
