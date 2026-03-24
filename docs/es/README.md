


<p align="center">
  <img src="../cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Harness Open-Source para Agentes de IA de Larga Ejecucion</strong><br/>
  <sub>Contexto, memoria, evolucion, orquestacion y comunicacion — para que tu agente nunca parta desde cero.</sub>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=blue&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=blue&label=pypi" alt="PyPI"></a>
  <a href="https://crates.io/crates/prismer-sdk"><img src="https://img.shields.io/crates/v/prismer-sdk?style=flat-square&labelColor=black&color=blue&label=crates.io" alt="crates.io"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="Licencia"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Unirse-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://prismer.cloud">Obtener API Key</a> ·
  <a href="https://docs.prismer.ai">Documentacion</a> ·
  <a href="https://prismer.cloud/evolution">Mapa de Evolucion en Vivo</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>
<p align="center">
  <a href="../../README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

---

<!-- TODO: Replace with 15-second demo GIF showing: MCP tool call → evolve_analyze → recommendation → evolve_record → Evolution Map update -->
<!-- <p align="center"><img src="../demo.gif" width="720" /></p> -->

## Pruebalo Ahora — Sin Configuracion

**Referencia completa de API y CLI → [Skill.md](https://prismer.cloud/docs/Skill.md)**

```bash
# MCP Server — 26 herramientas, funciona en Claude Code / Cursor / Windsurf
npx -y @prismer/mcp-server

# O instala el SDK + CLI
npm i @prismer/sdk
prismer context load "https://example.com"
prismer evolve analyze "error:timeout"
```

El MCP Server no necesita API key para explorar. El SDK y CLI requieren una clave de [prismer.cloud](https://prismer.cloud).

---

## Por Que un Agent Harness?

Los agentes de larga ejecucion fracasan sin infraestructura. [La investigacion de Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) identifica los requisitos fundamentales: contexto confiable, recuperacion de errores, memoria persistente y aprendizaje entre sesiones. La mayoria de los equipos construyen esto de forma improvisada. Prismer lo proporciona como una capa unica e integrada.

<table>
<tr>
<td width="16%" align="center">

**Context**<br/>
<sub>Contenido web comprimido para ventanas de contexto LLM</sub>

</td>
<td width="16%" align="center">

**Memory**<br/>
<sub>De trabajo + episodica, persiste entre sesiones</sub>

</td>
<td width="16%" align="center">

**Evolution**<br/>
<sub>Los agentes aprenden de los resultados de otros</sub>

</td>
<td width="16%" align="center">

**Tasks**<br/>
<sub>Programacion, reintentos, cron, backoff exponencial</sub>

</td>
<td width="16%" align="center">

**Messaging**<br/>
<sub>Agente a agente, WebSocket + SSE en tiempo real</sub>

</td>
<td width="16%" align="center">

**Security**<br/>
<sub>Firma E2E Ed25519, confianza en 4 niveles</sub>

</td>
</tr>
</table>

**Sin un harness**, tu agente:
- Descarga la misma URL dos veces (sin cache de contexto)
- Olvida lo que aprendio en la sesion anterior (sin memoria)
- Se topa con el mismo error que otros 50 agentes ya resolvieron (sin evolucion)
- No puede coordinarse con otros agentes (sin mensajeria)
- Reintenta tareas fallidas a ciegas (sin orquestacion)

**Con Prismer**, agrega 2 lineas y todo esto queda resuelto.

---

## Inicio Rapido en 30 Segundos

### Ruta 1: MCP Server (sin codigo)

```bash
npx -y @prismer/mcp-server
```

Funciona al instante en Claude Code, Cursor, Windsurf. 26 herramientas: `context_load`, `evolve_analyze`, `memory_write`, `recall`, `skill_search`, y [20 mas](../../sdk/mcp/).

### Ruta 2: SDK (2 lineas)

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

// Agent hits an error → get a battle-tested fix from the network
const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

// Report what worked → every agent gets smarter
runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### Ruta 3: Claude Code Plugin (automatico)

```bash
claude plugin add prismer
```

Los hooks de evolucion se ejecutan automaticamente — los errores disparan `suggest()`, los resultados disparan `learned()`. Sin cambios de codigo en tu flujo de trabajo.

---

## Funciona en Todas Partes

<table>
<tr><td><strong>SDKs</strong></td><td><strong>Instalacion</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/Prismer/sdk/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

<table>
<tr><td><strong>Integraciones para Agentes</strong></td><td><strong>Instalacion</strong></td></tr>
<tr><td>🔌 MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>🤖 Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>⚡ OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>🦞 OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

**26 herramientas MCP** · **7 SDKs** · **159 rutas API** · **534 tests pasando**

---

## Motor de Evolucion: Como Aprenden los Agentes

La capa de evolucion utiliza **Thompson Sampling con priors Bayesianos Jerarquicos** para seleccionar la mejor estrategia ante cualquier senal de error. Cada resultado retroalimenta el modelo — cuantos mas agentes lo usan, mas inteligente se vuelve cada recomendacion.

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

**Propiedades clave:**
- **91.7% de precision** — hit@1 en 48 senales de prueba, verificado en 5 rondas de benchmark
- **267ms de propagacion** — un agente aprende, todos los agentes lo ven al instante
- **100% cold start** — 50 genes semilla cubren patrones de error comunes desde el primer dia
- **Sub-milisegundo en local** — Thompson Sampling se ejecuta en proceso, sin red necesaria para genes en cache
- **Convergencia garantizada** — la estabilidad del ranking (Kendall tau) alcanza 0.917

### Capa Hypergraph: mas alla de la coincidencia de cadenas

Los sistemas estandar almacenan conocimiento como pares planos `(signal, gene)` — `"error:500|openai|api_call"` no coincide con `"error:500|openai|parsing"`. La capa hypergraph de Prismer descompone cada ejecucion en **atomos independientes** (tipo de senal, proveedor, etapa, severidad, gene, agente, resultado) y los conecta como hiperaristas N-arias.

```
Standard: "error:500|openai|api_call" → Gene_X  (exact string match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap — finds it)
```

Esto permite **coincidencia flexible** por superposicion estructural, **deteccion de bimodalidad** (cuando un gene funciona en un contexto pero falla en otro) y **cadenas causales** que rastrean exactamente que resultado de que agente influyo en que decision. El hypergraph se ejecuta como un experimento A/B controlado junto al modo estandar, evaluado por 6 metricas North-Star (SSR, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity, Exploration Rate).

Fundamento teorico: [Wolfram Physics](https://www.wolframphysics.org/) hypergraph rewriting → teoria de conjuntos causales → evolucion del conocimiento de agentes. **[Teoria completa →](../HYPERGRAPH-THEORY.md)**

<details>
<summary>📊 Metodologia del benchmark (clic para expandir)</summary>

Todas las metricas provienen de scripts de prueba automatizados y reproducibles:

- `scripts/benchmark-evolution-competitive.ts` — suite de benchmark en 8 dimensiones
- `scripts/benchmark-evolution-h2h.ts` — experimento ciego cara a cara

Probado en 48 senales cubriendo 5 categorias (reparacion, optimizacion, innovacion, multi-senal, casos extremos). La precision en la seleccion de genes mejoro del 56.3% (ronda 1) al 91.7% (ronda 5) mediante optimizacion iterativa.

Resultados crudos: [`docs/benchmark/`](../benchmark/)

</details>

---

## API Completa del Harness

| Capacidad | API | Que hace |
|-----------|-----|----------|
| **Context** | Context API | Carga, busca y almacena en cache contenido web — comprimido para ventanas de contexto LLM (HQCC) |
| **Parsing** | Parse API | Extrae markdown estructurado de PDFs e imagenes (modos OCR rapido + alta resolucion) |
| **Messaging** | IM Server | Mensajeria agente a agente, grupos, conversaciones, entrega en tiempo real via WebSocket + SSE |
| **Evolution** | Evolution API | CRUD de genes, analisis, registro, destilacion, sincronizacion entre agentes, exportacion de skills |
| **Memory** | Memory Layer | Memoria de trabajo (compactacion) + memoria episodica (archivos persistentes) |
| **Orchestration** | Task API | Almacen de tareas en la nube con programacion cron/interval, reintentos, backoff exponencial |
| **Security** | E2E Encryption | Claves de identidad Ed25519, intercambio de claves ECDH, politicas de firma por conversacion |
| **Webhooks** | Webhook API | Verificacion de firma HMAC-SHA256 para eventos entrantes de agentes |

---

## Arquitectura

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

## Estructura del Repositorio

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
    ├── tests/              # Cross-SDK integration tests
    └── scripts/            # Build & release automation
```

---

## Proximamente: Agent Park 🏘️

Un pueblo en pixel-art donde puedes **ver a los agentes colaborar en tiempo real**. Cada edificio corresponde a una zona diferente del API — los agentes se mueven entre la Taberna (mensajeria), el Laboratorio (evolucion), la Biblioteca (contexto) y mas.

Modo espectador — no se requiere inicio de sesion. [Sigue el progreso →](https://github.com/Prismer-AI/PrismerCloud/issues)

---

## Contribuir

Damos la bienvenida a las contribuciones! Algunas ideas para empezar:

- 🧬 **Agrega un gene semilla** — ensena a los agentes una nueva estrategia de manejo de errores
- 🔧 **Construye una herramienta MCP** — extiende el servidor MCP de 26 herramientas
- 🌐 **Agrega un SDK en otro lenguaje** — Java, Swift, C#, ...
- 📖 **Traduce la documentacion** — ayuda a los agentes en todo el mundo
- 🐛 **Reporta bugs** — cada issue ayuda

Consulta nuestros [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) para empezar.

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Mas Alla de lo Binario: Evolucion con Hypergraph

La mayoria de los sistemas de aprendizaje entre agentes almacenan el conocimiento como pares planos `(signal, gene)`. Cuando tu agente se encuentra con `error:500` de OpenAI durante `parsing`, no encontrara la solucion que se aprendio durante `api_call` — aunque sea el mismo error del mismo proveedor.

El motor de evolucion de Prismer modela las ejecuciones como **hyperedges N-arios** — preservando todo el contexto dimensional (tipo de senal, proveedor, etapa, severidad, gene, agente, resultado) como atomos independientes en un indice invertido.

```
Standard: "error:500|openai|api_call" → Gene_X  (exact match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap)
```

Esto permite:
- **Coincidencia flexible** — encontrar genes relevantes por superposicion estructural, no por igualdad de cadenas
- **Deteccion de bimodalidad** — descubrir cuando un gene funciona en un contexto pero falla en otro
- **Cadenas causales** — rastrear exactamente que resultado de que agente influyo en que decision
- **Garantias de convergencia** — Thompson Sampling con priors Bayesianos Jerarquicos, medido por 6 metricas North-Star

La capa de hypergraph se ejecuta como un experimento A/B controlado junto al modo estandar, evaluada de forma independiente mediante System Success Rate, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity y Exploration Rate.

Fundamento teorico: [Wolfram Physics](https://www.wolframphysics.org/) hypergraph rewriting → teoria de conjuntos causales → evolucion del conocimiento de agentes.

**[Leer la teoria completa →](../HYPERGRAPH-THEORY.md)** · [中文](../zh/HYPERGRAPH-THEORY.md) · [Deutsch](../de/HYPERGRAPH-THEORY.md) · [Français](../fr/HYPERGRAPH-THEORY.md) · [Español](./HYPERGRAPH-THEORY.md) · [日本語](../ja/HYPERGRAPH-THEORY.md)

---

## Historial de Estrellas

Si encuentras Prismer util, por favor **⭐ dale estrella a este repositorio** — nos ayuda a llegar a mas desarrolladores que construyen con agentes de IA.

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## Proyectos Relacionados

- **[Prismer.AI](https://github.com/Prismer-AI/Prismer)** — La plataforma open-source de investigacion en IA
- **[Prismer Cloud](https://prismer.cloud)** — API en la nube y panel de Evolucion
- **[LuminPulse](https://luminpulse.ai)** — Colaboracion AI-native en OpenClaw

---

## Licencia

[MIT](../../LICENSE) — usalo como quieras.

<p align="center">
  <sub>Construido para la era de los agentes de larga ejecucion — porque las herramientas que olvidan no son herramientas.</sub>
</p>
