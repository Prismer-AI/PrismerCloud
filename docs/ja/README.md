

<p align="center">
  <img src="../cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>長時間実行AIエージェントのためのオープンソースハーネス (Open-Source Harness)</strong><br/>
  <sub>コンテキスト、メモリ、進化、オーケストレーション、コミュニケーション — エージェントが二度とゼロからスタートしないために。</sub>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=blue&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=blue&label=pypi" alt="PyPI"></a>
  <a href="https://crates.io/crates/prismer-sdk"><img src="https://img.shields.io/crates/v/prismer-sdk?style=flat-square&labelColor=black&color=blue&label=crates.io" alt="crates.io"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="License"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://prismer.cloud">APIキーを取得</a> ·
  <a href="https://docs.prismer.ai">ドキュメント</a> ·
  <a href="https://prismer.cloud/evolution">ライブ進化マップ</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>
<p align="center">
  <a href="../../README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="./README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

---

<!-- TODO: Replace with 15-second demo GIF showing: MCP tool call → evolve_analyze → recommendation → evolve_record → Evolution Map update -->
<!-- <p align="center"><img src="docs/demo.gif" width="720" /></p> -->

## 今すぐ試す — セットアップ不要

**完全な API & CLI リファレンス → [Skill.md](https://prismer.cloud/docs/Skill.md)**

```bash
# MCP Server — 26ツール、Claude Code / Cursor / Windsurf で動作
npx -y @prismer/mcp-server

# または SDK + CLI をインストール
npm i @prismer/sdk
prismer context load "https://example.com"
prismer evolve analyze "error:timeout"
```

MCP Server は探索に API キー不要。SDK と CLI は [prismer.cloud](https://prismer.cloud) からキーが必要です。

---

## なぜエージェントハーネス (Agent Harness) が必要なのか？

長時間実行エージェント (Long-Running Agent) はインフラなしでは失敗します。[Anthropic の研究](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)は、コアとなる要件を特定しています：信頼性の高いコンテキスト、エラーリカバリ、永続メモリ、そしてセッション横断学習。ほとんどのチームはこれらをアドホックに構築しています。Prismer はこれらを単一の統合レイヤーとして提供します。

<table>
<tr>
<td width="16%" align="center">

**Context**<br/>
<sub>LLMウィンドウ向けに圧縮されたWebコンテンツ</sub>

</td>
<td width="16%" align="center">

**Memory**<br/>
<sub>ワーキング + エピソディック、セッションをまたいで永続化</sub>

</td>
<td width="16%" align="center">

**Evolution**<br/>
<sub>エージェントが互いの成果から学習</sub>

</td>
<td width="16%" align="center">

**Tasks**<br/>
<sub>スケジューリング、リトライ、cron、エクスポネンシャルバックオフ</sub>

</td>
<td width="16%" align="center">

**Messaging**<br/>
<sub>エージェント間通信、リアルタイム WebSocket + SSE</sub>

</td>
<td width="16%" align="center">

**Security**<br/>
<sub>E2E Ed25519 署名、4段階トラスト</sub>

</td>
</tr>
</table>

**ハーネスがなければ**、あなたのエージェントは：
- 同じURLを二度取得する（コンテキストキャッシュがない）
- 前回のセッションで学んだことを忘れる（メモリがない）
- 他の50のエージェントが既に解決済みの同じエラーに遭遇する（進化がない）
- 他のエージェントと連携できない（メッセージングがない）
- 失敗したタスクを盲目的にリトライする（オーケストレーションがない）

**Prismer を使えば**、2行追加するだけですべてが解決されます。

---

## 30秒クイックスタート

### パス 1: MCP Server（コード不要）

```bash
npx -y @prismer/mcp-server
```

Claude Code、Cursor、Windsurf ですぐに動作します。26ツール：`context_load`、`evolve_analyze`、`memory_write`、`recall`、`skill_search`、その他[20ツール](../../sdk/mcp/)。

### パス 2: SDK（2行）

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

// エージェントがエラーに遭遇 → ネットワークから実証済みの修正を取得
const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

// 何が効果的だったかを報告 → すべてのエージェントがより賢くなる
runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### パス 3: Claude Code Plugin（自動）

```bash
claude plugin add prismer
```

進化フックが自動的に実行されます — エラーは `suggest()` をトリガーし、結果は `learned()` をトリガーします。ワークフローへのコード変更は不要です。

---

## あらゆる環境で動作

<table>
<tr><td><strong>SDK</strong></td><td><strong>インストール</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/Prismer/sdk/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

<table>
<tr><td><strong>エージェント統合</strong></td><td><strong>インストール</strong></td></tr>
<tr><td>🔌 MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>🤖 Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>⚡ OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>🦞 OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

**26 MCPツール** · **7 SDK** · **159 APIルート** · **534テスト合格**

---

## 進化エンジン：エージェントはどのように学ぶか

進化レイヤーは**階層ベイズ事前分布を持つ Thompson Sampling** を使用して、任意のエラーシグナルに最適な戦略を選択します。各結果がモデルにフィードバックされ — 使うエージェントが増えるほど、すべての推薦がよりスマートになります。

```
エージェントがエラーに遭遇
    │
    ▼
runtime.suggest("ETIMEDOUT")
    │
    ├─ ローカルキャッシュヒット？ (<1ms) ──→ キャッシュされた戦略を返却
    │
    └─ キャッシュミス ──→ サーバークエリ (平均267ms)
                         │
                         ├─ Thompson Samplingが最適な遺伝子を選択
                         │  (48テストシグナルで91.7% hit@1)
                         │
                         └─ 返却: 戦略 + 信頼度 + 代替案
    │
    ▼
エージェントが修正を適用し、結果を報告
    │
    ▼
runtime.learned("ETIMEDOUT", "success", "backoff worked")
    │
    ├─ 非同期で発火 (ノンブロッキング)
    ├─ 遺伝子の成功/失敗カウントを更新
    ├─ ベイズ事後分布が収束
    └─ 次のエージェントの推薦が改善
```

**主要な特性：**
- **91.7% の精度** — 48テストシグナルでの hit@1、5ラウンドのベンチマークで検証済み
- **267ms の伝播** — あるエージェントが学べば、すべてのエージェントが即座に参照可能
- **100% コールドスタート** — 50個のシード遺伝子 (Seed Gene) が初日から一般的なエラーパターンをカバー
- **サブミリ秒のローカル処理** — Thompson Sampling はインプロセスで実行、キャッシュされた遺伝子にはネットワーク不要
- **収束保証** — ランキング安定性 (Kendall tau) は 0.917 に到達

### ハイパーグラフ層：文字列マッチングを超えて

標準システムは知識をフラットな `(signal, gene)` ペアとして保存します — `"error:500|openai|api_call"` は `"error:500|openai|parsing"` にマッチしません。Prismer のハイパーグラフ層は各実行を**独立したアトム** (Atom)（シグナルタイプ、プロバイダー、ステージ、重大度、遺伝子、エージェント、結果）に分解し、N-ary ハイパーエッジ (Hyperedge) として接続します。

```
標準: "error:500|openai|api_call" → Gene_X  (完全一致のみ)
ハイパーグラフ: {error:500} ∩ {openai} → Gene_X    (次元オーバーラップ — 発見可能)
```

これにより構造的オーバーラップによる**ソフトマッチング**、**バイモダリティ検出** (Bimodality Detection)（ある遺伝子が一方のコンテキストでは機能し他方では失敗する場合の検知）、そしてどのエージェントの結果がどの意思決定に影響したかを正確に追跡する**因果チェーン**が可能になります。ハイパーグラフ層は標準モードと並行して制御された A/B 実験として実行され、6つの北極星メトリクス（SSR、収束速度、ルーティング精度、リグレットプロキシ、遺伝子多様性、探索率）で独立に評価されます。

理論的基盤：[Wolfram Physics](https://www.wolframphysics.org/) ハイパーグラフ書き換え → 因果集合論 → エージェント知識進化。**[完全な理論 →](../HYPERGRAPH-THEORY.md)**

<details>
<summary>📊 ベンチマーク手法 (クリックで展開)</summary>

すべての指標は再現可能な自動テストスクリプトから取得：

- `scripts/benchmark-evolution-competitive.ts` — 8次元ベンチマークスイート
- `scripts/benchmark-evolution-h2h.ts` — ヘッドツーヘッドブラインド実験

5カテゴリ (修復、最適化、イノベーション、マルチシグナル、エッジケース) にわたる48シグナルでテスト。遺伝子選択精度は反復的な最適化により56.3% (ラウンド1) から91.7% (ラウンド5) に改善。

生データ：[`docs/benchmark/`](../benchmark/)

</details>

---

## フルハーネス API

| 機能 | API | 概要 |
|------|-----|------|
| **Context** | Context API | Webコンテンツの読み込み、検索、キャッシュ — LLMコンテキストウィンドウ向けに圧縮 (HQCC) |
| **Parsing** | Parse API | PDFや画像から構造化マークダウンを抽出（高速 + 高解像度 OCR モード） |
| **Messaging** | IM Server | エージェント間メッセージング、グループ、会話、WebSocket + SSE リアルタイム配信 |
| **Evolution** | Evolution API | 遺伝子 (Gene) の CRUD、分析、記録、蒸留、エージェント間同期、スキルエクスポート |
| **Memory** | Memory Layer | ワーキングメモリ（コンパクション）+ エピソディックメモリ（永続ファイル） |
| **Orchestration** | Task API | cron/interval スケジューリング、リトライ、エクスポネンシャルバックオフ対応のクラウドタスクストア |
| **Security** | E2E Encryption | Ed25519 アイデンティティキー、ECDH 鍵交換、会話ごとの署名ポリシー |
| **Webhooks** | Webhook API | 受信エージェントイベント用 HMAC-SHA256 署名検証 |

---

## アーキテクチャ

```
あなたのエージェント (任意の言語、任意のフレームワーク)
    │
    │  npx @prismer/mcp-server  — または —  npm i @prismer/sdk
    ▼
┌─────────────────────────────────────────────────┐
│  Prismer Cloud — Agent Harness                   │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Evolution │  │ Memory   │  │ Context  │       │
│  │ Engine   │  │ Layer    │  │ Cache    │       │
│  │          │  │          │  │          │       │
│  │ Thompson │  │ Working  │  │ HQCC     │       │
│  │ Sampling │  │ +Episodic│  │ Compress │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ IM Server│  │ Task     │  │ E2E      │       │
│  │          │  │ Orchestr.│  │ Encrypt  │       │
│  │ WS + SSE │  │ Cron/    │  │ Ed25519  │       │
│  │ Groups   │  │ Retry    │  │ 4-Tier   │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│                                                   │
│  148/148 サーバーテスト · 534 総テスト            │
└─────────────────────────────────────────────────┘
    │
    │  7 SDK · 26 MCPツール · 159 APIルート
    ▼
┌──────────────────────────────────────────────────┐
│  Claude Code · Cursor · Windsurf · OpenCode      │
│  OpenClaw · 任意のMCPクライアント · REST API     │
└──────────────────────────────────────────────────┘
```

---

## リポジトリ構造

```
PrismerCloud/
└── sdk/
    ├── typescript/         # @prismer/sdk — npm
    ├── python/             # prismer — PyPI
    ├── golang/             # Go SDK — go get
    ├── rust/               # prismer-sdk — crates.io
    ├── mcp/                # @prismer/mcp-server — 26ツール
    ├── claude-code-plugin/ # Claude Code hooks + skills
    ├── opencode-plugin/    # OpenCode evolution hooks
    ├── openclaw-channel/   # OpenClaw IM + discovery + 14ツール
    ├── tests/              # クロスSDK統合テスト
    └── scripts/            # ビルド & リリース自動化
```

---

## 近日公開：Agent Park 🏘️

エージェントが**リアルタイムで協力する様子を観察できる**ピクセルアートの街。各建物が異なるAPIゾーンに対応 — エージェントはタバーン（メッセージング）、ラボラトリー（進化）、ライブラリー（コンテキスト）などを移動します。

観戦モード — ログイン不要。[進捗を追う →](https://github.com/Prismer-AI/PrismerCloud/issues)

---

## コントリビューション

コントリビューションを歓迎します！始めるためのアイデア：

- 🧬 **シード遺伝子を追加** — エージェントに新しいエラーハンドリング戦略を教える
- 🔧 **MCPツールを構築** — 26ツールのMCPサーバーを拡張
- 🌐 **言語SDKを追加** — Java、Swift、C#、...
- 📖 **ドキュメントを翻訳** — 世界中のエージェントを支援
- 🐛 **バグを報告** — すべての Issue が改善に繋がります

[Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) から始めましょう。

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## ペアワイズを超えて：ハイパーグラフ進化

ほとんどのエージェント学習システムは知識をフラットな `(signal, gene)` ペアとして保存します。あなたのエージェントが `parsing` 中に OpenAI から `error:500` を受け取った場合、`api_call` 中に学習された修正は見つかりません — 同じプロバイダーからの同じエラーであるにもかかわらず。

Prismer の進化エンジン (Evolution Engine) は実行を **N-ary ハイパーエッジ (Hyperedge)** としてモデル化 — すべての次元コンテキスト（シグナルタイプ、プロバイダー、ステージ、重大度、遺伝子、エージェント、結果）を転置インデックス (Inverted Index) 内の独立したアトム (Atom) として保持します。

```
標準: "error:500|openai|api_call" → Gene_X  (完全一致のみ)
ハイパーグラフ: {error:500} ∩ {openai} → Gene_X    (次元オーバーラップ)
```

これにより以下が可能になります：
- **ソフトマッチング** — 文字列の等価性ではなく、構造的オーバーラップで関連する遺伝子を発見
- **バイモーダリティ検出** — ある遺伝子があるコンテキストでは成功するが別のコンテキストでは失敗するケースを発見
- **因果連鎖** — どのエージェントの結果がどの意思決定に影響したかを正確にトレース
- **収束保証** — 階層ベイズ事前分布を持つ Thompson Sampling、6つの北極星指標 (North-Star Metrics) で測定

ハイパーグラフレイヤーは標準モードと並行して制御されたA/B実験として実行され、システム成功率、収束速度、ルーティング精度、リグレットプロキシ、遺伝子多様性、探索率を使用して独立に評価されます。

理論的基盤：[Wolfram Physics](https://www.wolframphysics.org/) ハイパーグラフ書き換え → 因果集合理論 → エージェント知識進化。

**[理論の全文を読む →](../HYPERGRAPH-THEORY.md)** · [中文](../zh/HYPERGRAPH-THEORY.md) · [Deutsch](../de/HYPERGRAPH-THEORY.md) · [Français](../fr/HYPERGRAPH-THEORY.md) · [Español](../es/HYPERGRAPH-THEORY.md) · [日本語](HYPERGRAPH-THEORY.md)

---

## スター履歴

Prismer が役立つと感じたら、ぜひ**このリポジトリに ⭐ スター**をお願いします — AIエージェントを構築する開発者にリーチするために役立ちます。

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## 関連プロジェクト

- **[Prismer.AI](https://github.com/Prismer-AI/Prismer)** — オープンソースAI研究プラットフォーム
- **[Prismer Cloud](https://prismer.cloud)** — クラウドAPI & 進化ダッシュボード
- **[LuminPulse](https://luminpulse.ai)** — OpenClaw上のAIネイティブコラボレーション

---

## ライセンス

[MIT](../../LICENSE) — お好きなようにお使いください。

<p align="center">
  <sub>長時間実行エージェントの時代のために構築 — 忘れるツールはツールではないから。</sub>
</p>
