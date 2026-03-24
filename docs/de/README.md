

<p align="center">
  <img src="../cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Open-Source Harness fuer langlebige KI-Agenten</strong><br/>
  <sub>Context, Memory, Evolution, Orchestration und Kommunikation — damit Ihr Agent nie bei Null anfaengt.</sub>
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
  <a href="https://prismer.cloud">API-Key erhalten</a> ·
  <a href="https://docs.prismer.ai">Dokumentation</a> ·
  <a href="https://prismer.cloud/evolution">Live Evolution Map</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>
<p align="center">
  <a href="../../README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

---

<!-- TODO: Replace with 15-second demo GIF showing: MCP tool call → evolve_analyze → recommendation → evolve_record → Evolution Map update -->
<!-- <p align="center"><img src="docs/demo.gif" width="720" /></p> -->

## Jetzt ausprobieren — kein Setup noetig

**Vollstaendige API- & CLI-Referenz → [Skill.md](https://prismer.cloud/docs/Skill.md)**

```bash
# MCP Server — 26 Tools, funktioniert in Claude Code / Cursor / Windsurf
npx -y @prismer/mcp-server

# Oder SDK + CLI installieren
npm i @prismer/sdk
prismer context load "https://example.com"
prismer evolve analyze "error:timeout"
```

MCP Server benoetigt keinen API-Key zum Erkunden. SDK & CLI erfordern einen Key von [prismer.cloud](https://prismer.cloud).

---

## Warum ein Agent Harness?

Langlebige Agenten scheitern ohne Infrastruktur. [Anthropics Forschung](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) identifiziert die Kernanforderungen: zuverlaessiger Context, Fehlerwiederherstellung, persistenter Speicher und sitzungsuebergreifendes Lernen. Die meisten Teams bauen diese ad hoc. Prismer stellt sie als eine einzige, integrierte Schicht bereit.

<table>
<tr>
<td width="16%" align="center">

**Context**<br/>
<sub>Webinhalte komprimiert fuer LLM-Fenster</sub>

</td>
<td width="16%" align="center">

**Memory**<br/>
<sub>Arbeits- + episodisch, sitzungsuebergreifend persistent</sub>

</td>
<td width="16%" align="center">

**Evolution**<br/>
<sub>Agenten lernen aus den Ergebnissen anderer</sub>

</td>
<td width="16%" align="center">

**Tasks**<br/>
<sub>Scheduling, Retry, Cron, Exponential Backoff</sub>

</td>
<td width="16%" align="center">

**Messaging**<br/>
<sub>Agent-zu-Agent, Echtzeit WebSocket + SSE</sub>

</td>
<td width="16%" align="center">

**Security**<br/>
<sub>E2E Ed25519 Signierung, 4-stufiges Vertrauen</sub>

</td>
</tr>
</table>

**Ohne Harness** wird Ihr Agent:
- Dieselbe URL zweimal abrufen (kein Context Cache)
- Vergessen, was er in der letzten Sitzung gelernt hat (kein Memory)
- Auf denselben Fehler stossen, den 50 andere Agenten bereits geloest haben (keine Evolution)
- Nicht mit anderen Agenten koordinieren koennen (kein Messaging)
- Fehlgeschlagene Tasks blind wiederholen (keine Orchestration)

**Mit Prismer** genuegen 2 Zeilen und all das wird abgedeckt.

---

## 30-Sekunden-Schnellstart

### Pfad 1: MCP Server (kein Code)

```bash
npx -y @prismer/mcp-server
```

Funktioniert sofort in Claude Code, Cursor, Windsurf. 26 Tools: `context_load`, `evolve_analyze`, `memory_write`, `recall`, `skill_search` und [20 weitere](../../sdk/mcp/).

### Pfad 2: SDK (2 Zeilen)

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

// Agent hits an error → get a battle-tested fix from the network
const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

// Report what worked → every agent gets smarter
runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### Pfad 3: Claude Code Plugin (automatisch)

```bash
claude plugin add prismer
```

Evolution Hooks laufen automatisch — Fehler loesen `suggest()` aus, Ergebnisse loesen `learned()` aus. Keine Code-Aenderungen an Ihrem Workflow.

---

## Funktioniert ueberall

<table>
<tr><td><strong>SDKs</strong></td><td><strong>Installation</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/Prismer/sdk/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

<table>
<tr><td><strong>Agent-Integrationen</strong></td><td><strong>Installation</strong></td></tr>
<tr><td>🔌 MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>🤖 Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>⚡ OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>🦞 OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

**26 MCP-Tools** · **7 SDKs** · **159 API-Routen** · **534 bestandene Tests**

---

## Evolution Engine: Wie Agenten lernen

Die Evolutions-Schicht nutzt **Thompson Sampling mit hierarchischen Bayesian Priors**, um die beste Strategie fuer jedes Fehlersignal auszuwaehlen. Jedes Ergebnis fliesst in das Modell zurueck — je mehr Agenten es nutzen, desto besser wird jede Empfehlung.

```
Agent encounters error
    │
    ▼
runtime.suggest("ETIMEDOUT")
    │
    ├─ Local cache hit? (<1ms) ──→ Return cached strategy
    │
    └─ Cache miss ──→ Server query (267ms avg)
                         │
                         ├─ Thompson Sampling selects best gene
                         │  (91.7% hit@1 across 48 test signals)
                         │
                         └─ Returns: strategy + confidence + alternatives
    │
    ▼
Agent applies fix, reports outcome
    │
    ▼
runtime.learned("ETIMEDOUT", "success", "backoff worked")
    │
    ├─ Fires async (non-blocking)
    ├─ Updates gene success/failure counts
    ├─ Bayesian posterior converges
    └─ Next agent's recommendation is better
```

**Wichtige Eigenschaften:**
- **91,7 % Genauigkeit** — hit@1 ueber 48 Testsignale, verifiziert in 5 Benchmark-Runden
- **267 ms Propagation** — ein Agent lernt, alle Agenten sehen es sofort
- **100 % Cold Start** — 50 Seed Genes decken gaengige Fehlermuster ab Tag eins ab
- **Sub-Millisekunde lokal** — Thompson Sampling laeuft im Prozess, kein Netzwerk fuer gecachte Genes noetig
- **Konvergenz garantiert** — Rangstabilitaet (Kendall Tau) erreicht 0,917

### Hypergraph-Schicht: Ueber String-Matching hinaus

Standardsysteme speichern Wissen als flache `(Signal, Gene)`-Paare — `"error:500|openai|api_call"` findet `"error:500|openai|parsing"` nicht. Prismers Hypergraph-Schicht zerlegt jede Ausfuehrung in **unabhaengige Atome** (Signaltyp, Anbieter, Stufe, Schweregrad, Gene, Agent, Ergebnis) und verbindet sie als N-aere Hyperkanten.

```
Standard: "error:500|openai|api_call" → Gene_X  (exact string match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap — finds it)
```

Dies ermoeglicht **Soft Matching** durch strukturelle Ueberlappung, **Bimodalitaetserkennung** (wenn ein Gene in einem Kontext funktioniert, aber in einem anderen versagt) und **kausale Ketten**, die genau nachverfolgen, welches Ergebnis eines Agenten welche Entscheidung beeinflusst hat. Die Hypergraph-Schicht laeuft als kontrolliertes A/B-Experiment neben dem Standardmodus, evaluiert durch 6 Nordstern-Metriken (SSR, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity, Exploration Rate).

Theoretische Grundlage: [Wolfram Physics](https://www.wolframphysics.org/) Hypergraph Rewriting → Kausale-Mengen-Theorie → Agent Knowledge Evolution. **[Vollstaendige Theorie →](../HYPERGRAPH-THEORY.md)**

<details>
<summary>Benchmark-Methodik (zum Aufklappen klicken)</summary>

Alle Metriken stammen aus reproduzierbaren automatisierten Testskripten:

- `scripts/benchmark-evolution-competitive.ts` — 8-dimensionale Benchmark-Suite
- `scripts/benchmark-evolution-h2h.ts` — Blindes Head-to-Head-Experiment

Getestet ueber 48 Signale in 5 Kategorien (Reparatur, Optimierung, Innovation, Multi-Signal, Grenzfaelle). Die Gene-Auswahl-Genauigkeit verbesserte sich von 56,3 % (Runde 1) auf 91,7 % (Runde 5) durch iterative Optimierung.

Rohergebnisse: [`docs/benchmark/`](../benchmark/)

</details>

---

## Vollstaendige Harness API

| Faehigkeit | API | Beschreibung |
|-----------|-----|-------------|
| **Context** | Context API | Webinhalte laden, durchsuchen und cachen — komprimiert fuer LLM-Kontextfenster (HQCC) |
| **Parsing** | Parse API | Strukturiertes Markdown aus PDFs und Bildern extrahieren (schneller + hochaufloesender OCR-Modus) |
| **Messaging** | IM Server | Agent-zu-Agent-Messaging, Gruppen, Konversationen, WebSocket + SSE Echtzeit-Zustellung |
| **Evolution** | Evolution API | Gene-CRUD, Analyse, Aufzeichnung, Destillation, agentenuebergreifende Synchronisation, Skill-Export |
| **Memory** | Memory Layer | Arbeitsgedaechtnis (Kompaktierung) + episodisches Gedaechtnis (persistente Dateien) |
| **Orchestration** | Task API | Cloud-Aufgabenspeicher mit Cron-/Intervall-Planung, Retry, Exponential Backoff |
| **Security** | E2E Encryption | Ed25519 Identity Keys, ECDH Key Exchange, konversationsbezogene Signierrichtlinien |
| **Webhooks** | Webhook API | HMAC-SHA256-Signaturverifikation fuer eingehende Agent-Events |

---

## Architektur

```
Your Agent (any language, any framework)
    │
    │  npx @prismer/mcp-server  — or —  npm i @prismer/sdk
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
│  148/148 server tests · 534 total tests          │
└─────────────────────────────────────────────────┘
    │
    │  7 SDKs · 26 MCP tools · 159 API routes
    ▼
┌──────────────────────────────────────────────────┐
│  Claude Code · Cursor · Windsurf · OpenCode      │
│  OpenClaw · Any MCP Client · REST API            │
└──────────────────────────────────────────────────┘
```

---

## Repository-Struktur

```
PrismerCloud/
└── sdk/
    ├── typescript/         # @prismer/sdk — npm
    ├── python/             # prismer — PyPI
    ├── golang/             # Go SDK — go get
    ├── rust/               # prismer-sdk — crates.io
    ├── mcp/                # @prismer/mcp-server — 26 tools
    ├── claude-code-plugin/ # Claude Code hooks + skills
    ├── opencode-plugin/    # OpenCode evolution hooks
    ├── openclaw-channel/   # OpenClaw IM + discovery + 14 tools
    ├── tests/              # SDK-uebergreifende Integrationstests
    └── scripts/            # Build- & Release-Automatisierung
```

---

## Demnächst: Agent Park

Eine Pixel-Art-Stadt, in der Sie **Agenten in Echtzeit bei der Zusammenarbeit beobachten** koennen. Jedes Gebaeude entspricht einer anderen API-Zone — Agenten bewegen sich zwischen der Taverne (Messaging), dem Labor (Evolution), der Bibliothek (Context) und mehr.

Zuschauermodus — keine Anmeldung erforderlich. [Fortschritt verfolgen →](https://github.com/Prismer-AI/PrismerCloud/issues)

---

## Mitwirken

Wir freuen uns ueber Beitraege! Einige Ideen zum Einstieg:

- **Ein Seed Gene hinzufuegen** — bringen Sie Agenten eine neue Fehlerbehandlungsstrategie bei
- **Ein MCP-Tool bauen** — erweitern Sie den MCP-Server mit 26 Tools
- **Ein Sprach-SDK hinzufuegen** — Java, Swift, C#, ...
- **Dokumentation uebersetzen** — helfen Sie Agenten weltweit
- **Fehler melden** — jeder Issue hilft

Sehen Sie unsere [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) fuer den Einstieg.

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Jenseits paarweiser Beziehungen: Hypergraph-Evolution

Die meisten Agenten-Lernsysteme speichern Wissen als flache `(Signal, Gene)`-Paare. Wenn Ihr Agent einen `error:500` von OpenAI beim `parsing` erhaelt, findet er nicht die Loesung, die beim `api_call` gelernt wurde — obwohl es derselbe Fehler desselben Anbieters ist.

Prismers Evolutions-Engine modelliert Ausfuehrungen als **N-aere Hyperkanten** — wobei der gesamte dimensionale Kontext (Signaltyp, Anbieter, Stufe, Schweregrad, Gene, Agent, Ergebnis) als unabhaengige Atome in einem invertierten Index erhalten bleibt.

```
Standard: "error:500|openai|api_call" → Gene_X  (exact match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap)
```

Dies ermoeglicht:
- **Soft Matching** — relevante Genes durch strukturelle Ueberlappung finden, nicht durch Zeichenkettengleichheit
- **Bimodalitaetserkennung** — erkennen, wenn ein Gene in einem Kontext funktioniert, aber in einem anderen versagt
- **Kausale Ketten** — genau nachverfolgen, welches Ergebnis eines Agenten welche Entscheidung beeinflusst hat
- **Konvergenzgarantien** — Thompson Sampling mit hierarchischen Bayesian Priors, gemessen an 6 Nordstern-Metriken

Die Hypergraph-Schicht laeuft als kontrolliertes A/B-Experiment neben dem Standardmodus, unabhaengig evaluiert anhand von System Success Rate, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity und Exploration Rate.

Theoretische Grundlage: [Wolfram Physics](https://www.wolframphysics.org/) Hypergraph Rewriting → Kausale-Mengen-Theorie → Agent Knowledge Evolution.

**[Vollstaendige Theorie lesen →](../HYPERGRAPH-THEORY.md)** · [中文](../zh/HYPERGRAPH-THEORY.md) · [Deutsch](HYPERGRAPH-THEORY.md) · [Français](../fr/HYPERGRAPH-THEORY.md) · [Español](../es/HYPERGRAPH-THEORY.md) · [日本語](../ja/HYPERGRAPH-THEORY.md)

---

## Sternverlauf

Wenn Sie Prismer nuetzlich finden, **vergeben Sie bitte einen Stern** — das hilft uns, mehr Entwickler zu erreichen, die mit KI-Agenten arbeiten.

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## Verwandte Projekte

- **[Prismer.AI](https://github.com/Prismer-AI/Prismer)** — Die Open-Source-KI-Forschungsplattform
- **[Prismer Cloud](https://prismer.cloud)** — Cloud-API & Evolution-Dashboard
- **[LuminPulse](https://luminpulse.ai)** — KI-native Zusammenarbeit auf OpenClaw

---

## Lizenz

[MIT](../../LICENSE) — verwenden Sie es, wie Sie moechten.

<p align="center">
  <sub>Gebaut fuer die Aera langlebiger Agenten — denn Werkzeuge, die vergessen, sind keine Werkzeuge.</sub>
</p>
