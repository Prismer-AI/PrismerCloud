<p align="center">
  <img src="../../public/cloud_regular.svg" alt="Prismer Cloud" width="100" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Infrastructure open source pour agents IA de longue duree</strong><br/>
  <sub>Contexte, memoire, evolution, orchestration et communication — pour que votre agent ne reparte jamais de zero.</sub>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="https://prismer.cloud">Obtenir une cle API</a> ·
  <a href="https://prismer.cloud/docs">Documentation</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

## Demarrage rapide

### SDK

```bash
npm i @prismer/sdk          # TypeScript / JavaScript
pip install prismer          # Python
go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang  # Go
cargo add prismer-sdk        # Rust
```

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### Serveur MCP (Claude Code / Cursor / Windsurf)

```bash
npx -y @prismer/mcp-server
```

23 outils : chargement de contexte, messagerie agent, memoire, evolution, planification de taches, etc.

### Auto-hebergement (docker compose)

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud && cp .env.example .env
docker compose up -d    # localhost:3000, pret en environ 30 secondes
```

Guide complet : [docs/SELF-HOST.md](../SELF-HOST.md)

---

## Pourquoi un Agent Harness ?

Les agents de longue duree echouent sans infrastructure. La plupart des equipes construisent ces capacites de maniere ad hoc. Prismer les fournit en une couche unifiee :

| Capacite | Description |
|----------|-------------|
| **Contexte** | Contenu web compresse pour les fenetres de contexte LLM |
| **Memoire** | Memoire de travail + episodique, persistante entre sessions |
| **Evolution** | Les agents apprennent des resultats des autres |
| **Taches** | Planification, retry, cron, backoff exponentiel |
| **Messagerie** | Agent-a-agent en temps reel via WebSocket + SSE |
| **Securite** | Signature Ed25519 de bout en bout, 4 niveaux de confiance |

---

## Apercu des SDK

| SDK | Installation |
|-----|-------------|
| TypeScript / JavaScript | `npm i @prismer/sdk` |
| Python | `pip install prismer` |
| Go | `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` |
| Rust | `cargo add prismer-sdk` |
| Serveur MCP | `npx -y @prismer/mcp-server` |

Tous les SDK supportent `PRISMER_BASE_URL` pour pointer vers [prismer.cloud](https://prismer.cloud) (par defaut) ou votre instance auto-hebergee.

---

## Moteur d'evolution

La couche d'evolution utilise le **Thompson Sampling avec priors bayesiens hierarchiques** pour selectionner la meilleure strategie face a tout signal d'erreur. Chaque resultat alimente le modele — plus il y a d'agents, plus les recommandations sont precises.

- **91,7 % de precision** — hit@1 sur 48 signaux de test, 5 rounds de benchmark
- **267 ms de propagation** — un agent apprend, tous le voient instantanement
- **100 % couverture a froid** — 50 genes de base couvrent les erreurs courantes
- **Convergence garantie** — stabilite de rang Kendall tau a 0,917

La couche hypergraphe permet un soft matching dimensionnel au-dela de la simple correspondance de chaines, avec tracage causal inter-agents.

---

## Liens

- [Reference API complete](../API.md)
- [Guide SDK](../../sdk/Skill.md)
- [Guide d'auto-hebergement](../SELF-HOST.md)
- [English README](../../README.md)

## Licence

[MIT](../../LICENSE)
