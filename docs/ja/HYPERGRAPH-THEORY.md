<p align="center">
  <a href="../HYPERGRAPH-THEORY.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/HYPERGRAPH-THEORY.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/HYPERGRAPH-THEORY.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/HYPERGRAPH-THEORY.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/HYPERGRAPH-THEORY.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="./HYPERGRAPH-THEORY.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

# ハイパーグラフ (Hypergraph) 進化理論

> Prismer がエージェントの学習をN項知識構造としてモデル化する方法
> ウルフラム物理学 (Wolfram Physics) と因果集合論に着想を得ています。

---

## ペアワイズエッジ (Pairwise Edge) の問題

従来のエージェント学習システムは、知識を **2項エッジ (2-ary edge)** としてモデル化します: 成功/失敗カウントを持つ `(signal, gene)` ペアです。

```
Standard model:
  edge("error:500|openai|api_call", "Gene_X") → { success: 12, failure: 3 }
```

これは機能します --- 機能しなくなるまでは。シグナルキーは複数の次元を一つに焼き込んだ **縮約文字列 (collapsed string)** です。以下を考えてみてください:

```
Real event:
  Agent A encounters error:500 from OpenAI during api_call stage,
  applies Gene_X (500 Error Triage), outcome: success.

Stored as:
  signal_key = "error:500|openai|api_call"
  gene_id    = "Gene_X"
```

ここでエージェントBが `parsing` ステージで OpenAI から `error:500` に遭遇したとします。標準モデルはまったく異なるシグナルキー --- `"error:500|openai|parsing"` --- を認識し、マッチ数ゼロを返します。しかし `Gene_X` はここでもおそらく有効です。なぜなら重要なのは `error:500 + openai` の組み合わせであり、ステージではないからです。

**2項モデルは、次元間の関係を文字列に縮約することで破壊してしまいます。**

---

## ハイパーグラフ: 完全なコンテキストの保持

[ハイパーグラフ](https://en.wikipedia.org/wiki/Hypergraph)は、エッジが **任意の数のノード** (2つだけではなく) を接続できるようにすることでグラフを一般化したものです。Prismer の進化エンジンでは、ハイパーグラフを使用してエージェントの実行イベントをN項関係としてモデル化します。

### コアコンポーネント

#### アトム (Atom) --- 正規化された次元

実行イベントの各次元は、独立した **アトム** として格納されます:

| 種別 | 例 | 捕捉する内容 |
|------|----------|-----------------|
| `signal_type` | `error:500`, `error:timeout`, `perf:high_latency` | エラーまたはパフォーマンスシグナル |
| `provider` | `openai`, `exa`, `anthropic` | 関連する外部サービス |
| `stage` | `api_call`, `network_request`, `parsing` | 実行フェーズ |
| `severity` | `transient`, `critical`, `degraded` | エラーの重大度 |
| `gene` | `seed_timeout_retry_v1`, `500_Error_Triage` | 適用された戦略 |
| `agent` | `agent_alice`, `agent_bob` | 実行エージェント |
| `outcome` | `success`, `failed` | 結果 |

アトムは **(kind, value) で一意** です --- 同じアトムノードは、それを共有するすべてのハイパーエッジで再利用されます。

#### ハイパーエッジ (Hyperedge) --- N項実行イベント

単一のハイパーエッジは、1回のカプセル (Capsule) 実行の **完全なコンテキスト** を捕捉します:

```
Hyperedge #cap_001 connects 7 atoms:
  ┌─ signal_type: "error:500"
  ├─ provider: "openai"
  ├─ stage: "api_call"
  ├─ severity: "transient"
  ├─ gene: "500_Error_Triage"
  ├─ agent: "agent_alice"
  └─ outcome: "success"
```

これは7つの別々のエッジではなく、**単一の7項関係** です。この区別はクエリにおいて重要です。

#### コーザルリンク (Causal Link) --- 学習チェーン

エージェントBがエージェントAの結果による事後分布の更新に基づいてジーンを選択した場合、明示的な **因果リンク (Causal Link)** を記録します:

```
Capsule_A (alice, Gene_X, success)
    │
    │  learning link (strength: 1.0)
    │  "A's success updated Gene_X's Beta posterior,
    │   which influenced B's Thompson Sampling draw"
    ▼
Capsule_B (bob, Gene_X, success)
```

因果リンクは **標準モデルでは不可視** です --- エージェントがなぜ特定のジーンを選択したかを追跡できません。ハイパーグラフを使えば、影響の完全なチェーンを再構築できます。

---

## クエリ: アトムに対する集合積演算

ハイパーグラフの主要な利点は、クエリ時の **次元分解 (Dimensional Decomposition)** です。

### 標準モード (文字列マッチ)

```
Query: "error:500|openai|parsing"
Result: No match (exact string differs from "error:500|openai|api_call")
```

### ハイパーグラフモード (アトム交差)

```
Query atoms: {signal_type: "error:500", provider: "openai", stage: "parsing"}

Step 1: Find all hyperedges containing atom "error:500" → {cap_001, cap_007, cap_012}
Step 2: Find all hyperedges containing atom "openai"    → {cap_001, cap_003, cap_007}
Step 3: Intersection: {cap_001, cap_007}
Step 4: Extract gene atoms from matched hyperedges → {"500_Error_Triage", "API_Retry_Backoff"}
Step 5: These are candidates for Thompson Sampling selection
```

クエリは `stage` が異なるにもかかわらず `cap_001` にマッチしました --- 3つのクエリアトムのうち2つを共有しているからです。これは完全一致の文字列比較ではなく、構造的重複による **ソフトマッチング (Soft Matching)** です。

### パフォーマンス

転置インデックス (Inverted Index) (`atom → hyperedges`) により効率的に処理されます:

| ジーン数 | 標準モード | ハイパーグラフモード |
|-----------|--------------|-----------------|
| 50 (現在) | O(G × T) フルスキャン | O(postings) 転置インデックス |
| 1,000 | LIMIT + ORDER BY が必要 | 同じ転置インデックス |
| 10,000 | マテリアライズドビューが必要 | アトムのカーディナリティは有界のまま |

アトムのカーディナリティは対数的に増加します (ユニークなエラータイプ、プロバイダー、ステージの数には限りがあるため)。一方、ジーン数は線形に増加します。ハイパーグラフの方がスケーラビリティに優れています。

---

## バイモダリティ検出 (Bimodality Detection)

ハイパーグラフは、標準モデルでは不可能な検出メカニズムを実現します: **バイモダリティインデックス (Bimodality Index)** です。

### 隠れたコンテキストの問題

```
Gene_X overall success rate: 50%  (looks mediocre)

Actually:
  When provider=openai:  90% success  (Gene_X is excellent here)
  When provider=anthropic: 10% success (Gene_X is terrible here)
```

2項モデルは50%を見てそのまま進みます。ハイパーグラフは、結果が `provider` アトムによってクラスタリングされていることを検出し、**バイモーダル (Bimodal)** としてフラグを立てます。

### アルゴリズム: 過分散検出 (Overdispersion Detection)

```
1. Compute global success rate p from recent outcomes
2. Split outcomes into time windows of size W
3. Compute success rate per window → [r₁, r₂, ..., rₖ]
4. Compute cross-window variance: Var(rᵢ)
5. Compute expected variance if i.i.d.: p(1-p)/W
6. Overdispersion ratio = Var(rᵢ) / expected_var
7. Bimodality index = clamp((ratio - 1) / 9, 0, 1)
```

| インデックス | 解釈 | アクション |
|-------|---------------|--------|
| 0.0 | 均質な結果 | 標準のトンプソンサンプリングで問題なし |
| 0.3 | 軽度の不均一性 | 監視、コンテキスト分割が有効な可能性 |
| 0.7 | 強いバイモダリティ | シグナルに次元分解が必要な可能性が高い |
| 1.0 | 極端なバイモダリティ | ハイパーグラフのアトムレベル分析を推奨 |

バイモダリティが検出されると、システムはシグナルをアトムレベルのサブシグナルに分解し、コンテキストごとにジーンを選択できます --- これはハイパーグラフモードでのみ存在する機能です。

---

## 北極星指標 (North Star Metrics)

6つの定量的指標が進化エンジンのパフォーマンスを評価します。標準モードとハイパーグラフモードでそれぞれ独立して計算されます:

| 指標 | 記号 | 計算式 | 測定対象 |
|--------|--------|---------|----------|
| **システム成功率** | SSR | `success / total capsules` | 全体的な有効性 |
| **収束速度** | CS | 新規エージェントがSSR >= 0.7に達するまでのカプセル数 | コールドスタート効率 |
| **ルーティング精度** | RP | `capsules with coverage ≥ 1 / total` | シグナル-ジーンマッチングの品質 |
| **リグレット代理指標** | RegP | `1 - (SSR_actual / SSR_oracle)` | 準最適選択の機会コスト |
| **ジーン多様性** | GD | `1 - HHI(gene usage shares)` | モノカルチャーの回避 |
| **探索率** | ER | `edges with < 10 executions / total edges` | 探索と活用のバランス |

### A/B 比較

両モードは並行して指標を蓄積します。両方が200カプセル以上に達した場合:

```
If hypergraph.SSR - standard.SSR > 0.05  →  hypergraph is better
If delta < -0.05                          →  standard is better
Otherwise                                 →  no significant difference
```

0.05の閾値は保守的です --- モード切り替え前に強い根拠を求めています。

---

## ウルフラム物理学 (Wolfram Physics) との関連

ハイパーグラフモデルは[ウルフラム物理学](https://www.wolframphysics.org/)に着想を得ています。ウルフラム物理学は、宇宙がリライトルール (Rewrite Rule) によって進化するハイパーグラフであると提案しています。対応関係は以下の通りです:

| ウルフラムの概念 | 進化エンジンにおける対応物 |
|----------------|----------------------|
| **アトム** (離散トークン) | シグナルの次元、ジーン、エージェント --- 進化の語彙 |
| **ハイパーエッジ** (N項関係) | カプセル実行 --- 完全なコンテキストが保持される |
| **リライトルール** (状態遷移) | ジーン戦略の実行 --- エラー状態を解決済み状態に変換 |
| **因果グラフ** (到達可能性) | 学習チェーン --- どのカプセルがどの意思決定に影響したか |
| **マルチウェイシステム** (並行ブランチ) | 異なるエージェントが同時に異なる戦略を試行 |
| **ブランキアル空間** (ブランチ間距離) | エージェント戦略の類似性 --- 2つのエージェントのアプローチがどれほど近いか |

### これが実現する可能性 (将来)

- **因果帰属**: 「このジーンの成功率が向上したのは、エージェントAの3回の成功カプセルが2つの因果リンクを通じて伝播し、エージェントBの選択に影響を与えたためです」
- **戦略類似性**: ブランキアル空間におけるエージェント間の距離を測定し、自然なクラスターを発見
- **構造的ジーン類似性**: 同じアトムパターンと共起する2つのジーンは互換性がある可能性が高い
- **MAP-Elites 多様性**: ジーンプールがトラフィックの多い領域だけでなく、アトム空間全体をカバーすることを保証

---

## データモデル

```
┌──────────┐       ┌───────────────────┐       ┌──────────┐
│  IMAtom  │◄──────│  IMHyperedgeAtom  │──────►│IMHyperedge│
│          │       │  (inverted index) │       │          │
│  id      │       │                   │       │  id      │
│  kind    │       │  atomId           │       │  type    │
│  value   │       │  hyperedgeId      │       │  created │
│          │       │  role             │       │          │
└──────────┘       └───────────────────┘       └──────┬───┘
                                                      │
                                               ┌──────┴───────┐
                                               │IMCausalLink   │
                                               │               │
                                               │  causeId  ────┤ (hyperedge)
                                               │  effectId ────┤ (hyperedge)
                                               │  linkType     │
                                               │  strength     │
                                               └───────────────┘
```

### テーブルサイズ (予想)

| テーブル | 増加パターン | 10Kカプセル時 |
|-------|---------------|-----------------|
| `im_atoms` | 対数的 (有界の語彙) | 約500行 |
| `im_hyperedges` | 線形 (カプセルあたり1行) | 10,000行 |
| `im_hyperedge_atoms` | 線形 × ファンアウト (エッジあたり約7) | 70,000行 |
| `im_causal_links` | 準線形 (すべてのカプセルがリンクされるわけではない) | 約3,000行 |

転置インデックスは最大のテーブルですが、数百万カプセルまでは単一マシンの MySQL 容量内に十分収まります。

---

## 実装ステータス

| フェーズ | スコープ | ステータス |
|-------|-------|--------|
| **フェーズ 0** | 北極星指標 + mode カラム + データ分離 | 完了 |
| **フェーズ 1** | アトム/ハイパーエッジ/因果リンクの書き込み + 転置インデックスクエリ + バイモダリティ | 完了 (フィーチャーゲート付き) |
| **フェーズ 2** | 200カプセル/モード以上でのA/B評価 + モード拡張判定 | データ待ち |
| **フェーズ 3** | ブランキアル距離 + 因果減衰 + MAP-Elites + ジーン類似性 | 計画中 |

ハイパーグラフ層は **追加的 (Additive)** です --- 既存のエッジ/カプセルロジックを変更することなく新しいテーブルに書き込みます。両モードは並行して動作し、共有テーブルの `mode` カラムによって分離されます。

---

## 参考文献

- [Wolfram Physics Project](https://www.wolframphysics.org/) --- 理論的基盤
- [Thompson Sampling for Bernoulli Bandits](https://arxiv.org/abs/1707.02038) --- 選択アルゴリズム
- [Hierarchical Bayesian Models](https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling) --- コールドスタートのためのプールド事前分布
- [Herfindahl-Hirschman Index](https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index) --- ジーン多様性の測定
- [MAP-Elites](https://arxiv.org/abs/1504.04909) --- 品質-多様性最適化 (フェーズ 3)

---

<p align="center">
  <sub>Part of the <a href="https://github.com/Prismer-AI/PrismerCloud">Prismer Cloud</a> Evolution Engine</sub>
</p>
