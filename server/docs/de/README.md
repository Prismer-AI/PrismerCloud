<p align="center">
  <img src="../../public/cloud_regular.svg" alt="Prismer Cloud" width="100" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Open-Source-Infrastruktur fuer langlebige KI-Agenten</strong><br/>
  <sub>Kontext, Gedaechtnis, Evolution, Orchestrierung und Kommunikation — damit Ihr Agent nie bei null anfaengt.</sub>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="https://prismer.cloud">API-Key holen</a> ·
  <a href="https://prismer.cloud/docs">Dokumentation</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

## Schnellstart

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

### MCP-Server (Claude Code / Cursor / Windsurf)

```bash
npx -y @prismer/mcp-server
```

23 Tools: Kontextladen, Agent-Messaging, Gedaechtnis, Evolution, Aufgabenplanung und mehr.

### Self-Hosting (docker compose)

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud && cp .env.example .env
docker compose up -d    # localhost:3000, bereit in ca. 30 Sekunden
```

Vollstaendige Anleitung: [docs/SELF-HOST.md](../SELF-HOST.md)

---

## Warum ein Agent Harness?

Langlebige Agenten scheitern ohne Infrastruktur. Die meisten Teams bauen diese Faehigkeiten ad hoc. Prismer bietet sie als einheitliche Schicht:

| Faehigkeit | Beschreibung |
|------------|-------------|
| **Kontext** | Webinhalte komprimiert fuer LLM-Kontextfenster |
| **Gedaechtnis** | Arbeits- + episodisches Gedaechtnis, sitzungsuebergreifend |
| **Evolution** | Agenten lernen aus den Ergebnissen anderer |
| **Aufgaben** | Planung, Wiederholung, Cron, exponentielles Backoff |
| **Messaging** | Agent-zu-Agent Echtzeit via WebSocket + SSE |
| **Sicherheit** | Ed25519 Ende-zu-Ende-Signierung, 4-stufiges Vertrauensmodell |

---

## SDK-Uebersicht

| SDK | Installation |
|-----|-------------|
| TypeScript / JavaScript | `npm i @prismer/sdk` |
| Python | `pip install prismer` |
| Go | `go get github.com/Prismer-AI/PrismerCloud/sdk/golang` |
| Rust | `cargo add prismer-sdk` |
| MCP-Server | `npx -y @prismer/mcp-server` |

Alle SDKs unterstuetzen `PRISMER_BASE_URL` fuer [prismer.cloud](https://prismer.cloud) (Standard) oder Ihre Self-Hosted-Instanz.

---

## Evolution Engine

Die Evolutionsschicht nutzt **Thompson Sampling mit hierarchischen Bayes'schen Priors**, um fuer jedes Fehlersignal die beste Strategie auszuwaehlen. Jedes Ergebnis fliesst ins Modell zurueck — je mehr Agenten es nutzen, desto praeziser die Empfehlungen.

- **91,7 % Genauigkeit** — hit@1 ueber 48 Testsignale, 5 Benchmark-Runden
- **267 ms Propagation** — ein Agent lernt, alle sehen es sofort
- **100 % Kaltstart-Abdeckung** — 50 Seed-Gene decken gaengige Fehlermuster ab
- **Konvergenz garantiert** — Kendall-Tau-Rangstabilitaet erreicht 0,917

Die Hypergraph-Schicht ermoeglicht dimensionales Soft-Matching jenseits einfacher Zeichenkettenvergleiche und kausale Nachverfolgung ueber Agenten hinweg.

---

## Links

- [Vollstaendige API-Referenz](../API.md)
- [SDK-Leitfaden](../../sdk/Skill.md)
- [Self-Hosting-Anleitung](../SELF-HOST.md)
- [English README](../../README.md)

## Lizenz

[MIT](../../LICENSE)
