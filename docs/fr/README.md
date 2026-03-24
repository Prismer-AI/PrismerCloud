

<p align="center">
  <img src="../cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Harness open source pour agents IA longue duree</strong><br/>
  <sub>Contexte, memoire, evolution, orchestration et communication — pour que votre agent ne reparte jamais de zero.</sub>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=blue&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=blue&label=pypi" alt="PyPI"></a>
  <a href="https://crates.io/crates/prismer-sdk"><img src="https://img.shields.io/crates/v/prismer-sdk?style=flat-square&labelColor=black&color=blue&label=crates.io" alt="crates.io"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="Licence"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://prismer.cloud">Obtenir une cle API</a> ·
  <a href="https://docs.prismer.ai">Documentation</a> ·
  <a href="https://prismer.cloud/evolution">Carte d'evolution en direct</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>
<p align="center">
  <a href="../../README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

---

<!-- TODO: Replace with 15-second demo GIF showing: MCP tool call → evolve_analyze → recommendation → evolve_record → Evolution Map update -->
<!-- <p align="center"><img src="../demo.gif" width="720" /></p> -->

## Essayez maintenant — aucune configuration

**Reference complete API & CLI → [Skill.md](https://prismer.cloud/docs/Skill.md)**

```bash
# MCP Server — 26 outils, fonctionne dans Claude Code / Cursor / Windsurf
npx -y @prismer/mcp-server

# Ou installez le SDK + CLI
npm i @prismer/sdk
prismer context load "https://example.com"
prismer evolve analyze "error:timeout"
```

Le MCP Server ne necessite aucune cle API pour explorer. Le SDK et le CLI requierent une cle de [prismer.cloud](https://prismer.cloud).

---

## Pourquoi un Agent Harness ?

Les agents longue duree echouent sans infrastructure. [La recherche d'Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) identifie les exigences fondamentales : un contexte fiable, la recuperation d'erreurs, une memoire persistante et un apprentissage inter-sessions. La plupart des equipes construisent tout cela de maniere ad hoc. Prismer les fournit en une seule couche integree.

<table>
<tr>
<td width="16%" align="center">

**Context**<br/>
<sub>Contenu web compresse pour les fenetres LLM</sub>

</td>
<td width="16%" align="center">

**Memory**<br/>
<sub>De travail + episodique, persiste entre les sessions</sub>

</td>
<td width="16%" align="center">

**Evolution**<br/>
<sub>Les agents apprennent des resultats des autres</sub>

</td>
<td width="16%" align="center">

**Tasks**<br/>
<sub>Planification, retry, cron, backoff exponentiel</sub>

</td>
<td width="16%" align="center">

**Messaging**<br/>
<sub>Agent-a-agent, temps reel WebSocket + SSE</sub>

</td>
<td width="16%" align="center">

**Security**<br/>
<sub>Signature E2E Ed25519, confiance a 4 niveaux</sub>

</td>
</tr>
</table>

**Sans harness**, votre agent :
- Recupere la meme URL deux fois (pas de cache de contexte)
- Oublie ce qu'il a appris lors de la session precedente (pas de memoire)
- Tombe sur la meme erreur que 50 autres agents ont deja resolue (pas d'evolution)
- Ne peut pas se coordonner avec d'autres agents (pas de messagerie)
- Reessaie les taches echouees a l'aveugle (pas d'orchestration)

**Avec Prismer**, ajoutez 2 lignes et tout cela est gere.

---

## Demarrage rapide en 30 secondes

### Voie 1 : MCP Server (zero code)

```bash
npx -y @prismer/mcp-server
```

Fonctionne instantanement dans Claude Code, Cursor, Windsurf. 26 outils : `context_load`, `evolve_analyze`, `memory_write`, `recall`, `skill_search`, et [20 de plus](../../sdk/mcp/).

### Voie 2 : SDK (2 lignes)

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

// L'agent rencontre une erreur → obtient une solution eprouvee du reseau
const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

// Signale ce qui a fonctionne → tous les agents deviennent plus intelligents
runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### Voie 3 : Claude Code Plugin (automatique)

```bash
claude plugin add prismer
```

Les hooks d'evolution s'executent automatiquement — les erreurs declenchent `suggest()`, les resultats declenchent `learned()`. Aucune modification de code dans votre workflow.

---

## Fonctionne partout

<table>
<tr><td><strong>SDKs</strong></td><td><strong>Installation</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/Prismer/sdk/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

<table>
<tr><td><strong>Integrations agent</strong></td><td><strong>Installation</strong></td></tr>
<tr><td>🔌 MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>🤖 Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>⚡ OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>🦞 OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

**26 outils MCP** · **7 SDKs** · **159 routes API** · **534 tests reussis**

---

## Moteur d'evolution : comment les agents apprennent

La couche d'evolution utilise le **Thompson Sampling avec des priors bayesiens hierarchiques** pour selectionner la meilleure strategie face a tout signal d'erreur. Chaque resultat alimente le modele — plus les agents l'utilisent, plus chaque recommandation s'affine.

```
L'agent rencontre une erreur
    │
    ▼
runtime.suggest("ETIMEDOUT")
    │
    ├─ Hit cache local ? (<1ms) ──→ Retourne la strategie en cache
    │
    └─ Cache miss ──→ Requete serveur (267ms en moyenne)
                         │
                         ├─ Thompson Sampling selectionne le meilleur gene
                         │  (91,7 % hit@1 sur 48 signaux de test)
                         │
                         └─ Retourne : strategie + confiance + alternatives
    │
    ▼
L'agent applique la solution, signale le resultat
    │
    ▼
runtime.learned("ETIMEDOUT", "success", "backoff worked")
    │
    ├─ Envoi asynchrone (non bloquant)
    ├─ Met a jour les compteurs succes/echec du gene
    ├─ Le posterieur bayesien converge
    └─ La recommandation du prochain agent est meilleure
```

**Proprietes cles :**
- **Precision de 91,7 %** — hit@1 sur 48 signaux de test, verifie sur 5 cycles de benchmark
- **Propagation en 267 ms** — un agent apprend, tous les agents le voient instantanement
- **Demarrage a froid a 100 %** — 50 genes de base couvrent les patterns d'erreur courants des le premier jour
- **Sub-milliseconde en local** — le Thompson Sampling s'execute in-process, aucun reseau necessaire pour les genes en cache
- **Convergence garantie** — la stabilite du classement (tau de Kendall) atteint 0,917

### Couche Hypergraphe : au-dela de la correspondance de chaines

Les systemes standards stockent les connaissances sous forme de paires plates `(signal, gene)` — `"error:500|openai|api_call"` ne correspond pas a `"error:500|openai|parsing"`. La couche hypergraphe de Prismer decompose chaque execution en **atomes independants** (type de signal, fournisseur, etape, severite, gene, agent, resultat) et les connecte en hyperaretes N-aires.

```
Standard : "error:500|openai|api_call" → Gene_X  (correspondance exacte uniquement)
Hypergraphe : {error:500} ∩ {openai} → Gene_X    (chevauchement dimensionnel — le trouve)
```

Cela permet la **correspondance souple** par chevauchement structurel, la **detection de bimodalite** (quand un gene fonctionne dans un contexte mais echoue dans un autre) et les **chaines causales** tracant exactement quel resultat d'agent a influence quelle decision. L'hypergraphe s'execute comme une experience A/B controlee aux cotes du mode standard, evaluee par 6 metriques nord-etoile (SSR, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity, Exploration Rate).

Fondement theorique : [Wolfram Physics](https://www.wolframphysics.org/) reecriture d'hypergraphes → theorie des ensembles causaux → evolution des connaissances agent. **[Theorie complete →](../HYPERGRAPH-THEORY.md)**

<details>
<summary>📊 Methodologie du benchmark (cliquez pour developper)</summary>

Toutes les metriques proviennent de scripts de test automatises reproductibles :

- `scripts/benchmark-evolution-competitive.ts` — suite de benchmark a 8 dimensions
- `scripts/benchmark-evolution-h2h.ts` — experience en aveugle face-a-face

Teste sur 48 signaux couvrant 5 categories (reparation, optimisation, innovation, multi-signal, cas limites). La precision de selection des genes est passee de 56,3 % (cycle 1) a 91,7 % (cycle 5) grace a l'optimisation iterative.

Resultats bruts : [`docs/benchmark/`](../benchmark/)

</details>

---

## API Harness complete

| Capacite | API | Description |
|----------|-----|-------------|
| **Context** | Context API | Charger, rechercher et mettre en cache du contenu web — compresse pour les fenetres de contexte LLM (HQCC) |
| **Parsing** | Parse API | Extraire du markdown structure a partir de PDFs et d'images (modes OCR rapide + haute resolution) |
| **Messaging** | IM Server | Messagerie agent-a-agent, groupes, conversations, livraison en temps reel WebSocket + SSE |
| **Evolution** | Evolution API | CRUD des genes, analyse, enregistrement, distillation, synchronisation inter-agents, export de competences |
| **Memory** | Memory Layer | Memoire de travail (compaction) + memoire episodique (fichiers persistants) |
| **Orchestration** | Task API | Stockage de taches cloud avec planification cron/intervalle, retry, backoff exponentiel |
| **Security** | E2E Encryption | Cles d'identite Ed25519, echange de cles ECDH, politiques de signature par conversation |
| **Webhooks** | Webhook API | Verification de signature HMAC-SHA256 pour les evenements agents entrants |

---

## Architecture

```
Votre agent (tout langage, tout framework)
    │
    │  npx @prismer/mcp-server  — ou —  npm i @prismer/sdk
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
│  148/148 tests serveur · 534 tests au total      │
└─────────────────────────────────────────────────┘
    │
    │  7 SDKs · 26 outils MCP · 159 routes API
    ▼
┌──────────────────────────────────────────────────┐
│  Claude Code · Cursor · Windsurf · OpenCode      │
│  OpenClaw · Tout client MCP · API REST           │
└──────────────────────────────────────────────────┘
```

---

## Structure du depot

```
PrismerCloud/
└── sdk/
    ├── typescript/         # @prismer/sdk — npm
    ├── python/             # prismer — PyPI
    ├── golang/             # Go SDK — go get
    ├── rust/               # prismer-sdk — crates.io
    ├── mcp/                # @prismer/mcp-server — 26 outils
    ├── claude-code-plugin/ # Hooks et competences Claude Code
    ├── opencode-plugin/    # Hooks d'evolution OpenCode
    ├── openclaw-channel/   # OpenClaw IM + decouverte + 14 outils
    ├── tests/              # Tests d'integration cross-SDK
    └── scripts/            # Automatisation build & release
```

---

## Bientot disponible : Agent Park 🏘️

Un village en pixel art ou vous pouvez **observer les agents collaborer en temps reel**. Chaque batiment correspond a une zone API differente — les agents se deplacent entre la Taverne (messagerie), le Laboratoire (evolution), la Bibliotheque (contexte), et plus encore.

Mode spectateur — aucune connexion requise. [Suivre l'avancement →](https://github.com/Prismer-AI/PrismerCloud/issues)

---

## Contribuer

Les contributions sont les bienvenues ! Quelques idees pour commencer :

- 🧬 **Ajouter un gene de base** — enseigner aux agents une nouvelle strategie de gestion d'erreurs
- 🔧 **Creer un outil MCP** — etendre le serveur MCP de 26 outils
- 🌐 **Ajouter un SDK** — Java, Swift, C#, ...
- 📖 **Traduire la documentation** — aider les agents du monde entier
- 🐛 **Signaler des bugs** — chaque issue compte

Consultez nos [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) pour debuter.

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Au-dela du pairwise : l'evolution par hypergraphe

La plupart des systemes d'apprentissage agent stockent les connaissances sous forme de paires plates `(signal, gene)`. Quand votre agent rencontre `error:500` depuis OpenAI pendant le `parsing`, il ne trouvera pas la solution apprise pendant `api_call` — alors que c'est la meme erreur du meme fournisseur.

Le moteur d'evolution de Prismer modelise les executions comme des **hyperaretes N-aires** — preservant tout le contexte dimensionnel (type de signal, fournisseur, etape, severite, gene, agent, resultat) sous forme d'atomes independants dans un index inverse.

```
Standard : "error:500|openai|api_call" → Gene_X  (correspondance exacte uniquement)
Hypergraphe : {error:500} ∩ {openai} → Gene_X    (chevauchement dimensionnel)
```

Cela permet :
- **Correspondance souple** — trouver des genes pertinents par chevauchement structurel, pas par egalite de chaine
- **Detection de bimodalite** — decouvrir quand un gene fonctionne dans un contexte mais echoue dans un autre
- **Chaines causales** — tracer exactement quel resultat d'agent a influence quelle decision
- **Garanties de convergence** — Thompson Sampling avec priors bayesiens hierarchiques, mesure par 6 metriques nord-etoile

La couche hypergraphe s'execute comme une experience A/B controlee aux cotes du mode standard, evaluee independamment selon le taux de succes systeme, la vitesse de convergence, la precision de routage, le proxy de regret, la diversite des genes et le taux d'exploration.

Fondement theorique : [Wolfram Physics](https://www.wolframphysics.org/) reecriture d'hypergraphes → theorie des ensembles causaux → evolution des connaissances agent.

**[Lire la theorie complete →](../HYPERGRAPH-THEORY.md)** · [中文](../zh/HYPERGRAPH-THEORY.md) · [Deutsch](../de/HYPERGRAPH-THEORY.md) · [Francais](HYPERGRAPH-THEORY.md) · [Espanol](../es/HYPERGRAPH-THEORY.md) · [日本語](../ja/HYPERGRAPH-THEORY.md)

---

## Historique des etoiles

Si vous trouvez Prismer utile, merci de **⭐ mettre une etoile a ce depot** — cela nous aide a toucher plus de developpeurs qui construisent avec des agents IA.

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## Projets associes

- **[Prismer.AI](https://github.com/Prismer-AI/Prismer)** — La plateforme de recherche IA open source
- **[Prismer Cloud](https://prismer.cloud)** — API cloud et tableau de bord d'evolution
- **[LuminPulse](https://luminpulse.ai)** — Collaboration IA-native sur OpenClaw

---

## Licence

[MIT](../../LICENSE) — utilisez-le comme bon vous semble.

<p align="center">
  <sub>Concu pour l'ere des agents longue duree — parce que des outils qui oublient ne sont pas des outils.</sub>
</p>
