<p align="center">
  <img src="../../public/cloud_regular.svg" alt="Prismer Cloud" width="100" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Infraestructura open source para agentes IA de larga duracion</strong><br/>
  <sub>Contexto, memoria, evolucion, orquestacion y comunicacion — para que tu agente nunca empiece desde cero.</sub>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="https://prismer.cloud">Obtener API Key</a> ·
  <a href="https://prismer.cloud/docs">Documentacion</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

## Inicio rapido

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

### Servidor MCP (Claude Code / Cursor / Windsurf)

```bash
npx -y @prismer/mcp-server
```

23 herramientas: carga de contexto, mensajeria entre agentes, memoria, evolucion, tareas y mas.

### Autoalojamiento (docker compose)

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud && cp .env.example .env
docker compose up -d    # localhost:3000, listo en ~30 segundos
```

Guia completa: [docs/SELF-HOST.md](../SELF-HOST.md)

---

## Por que un Agent Harness?

Los agentes de larga duracion fallan sin infraestructura. La mayoria de los equipos construyen estas capacidades de forma ad hoc. Prismer las ofrece como una capa unificada:

| Capacidad | Descripcion |
|-----------|-------------|
| **Contexto** | Contenido web comprimido para ventanas de contexto LLM |
| **Memoria** | Memoria de trabajo + episodica, persistente entre sesiones |
| **Evolucion** | Los agentes aprenden de los resultados de otros |
| **Tareas** | Programacion, reintentos, cron, backoff exponencial |
| **Mensajeria** | Agente a agente en tiempo real via WebSocket + SSE |
| **Seguridad** | Firma Ed25519 de extremo a extremo, 4 niveles de confianza |

---

## Resumen de SDKs

| SDK | Instalacion |
|-----|------------|
| TypeScript / JavaScript | `npm i @prismer/sdk` |
| Python | `pip install prismer` |
| Go | `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` |
| Rust | `cargo add prismer-sdk` |
| Servidor MCP | `npx -y @prismer/mcp-server` |

Todos los SDKs soportan `PRISMER_BASE_URL` para apuntar a [prismer.cloud](https://prismer.cloud) (por defecto) o tu instancia autoalojada.

---

## Motor de evolucion

La capa de evolucion utiliza **Thompson Sampling con priors bayesianos jerarquicos** para seleccionar la mejor estrategia ante cualquier senal de error. Cada resultado retroalimenta el modelo — cuantos mas agentes lo usan, mas precisas son las recomendaciones.

- **91,7 % de precision** — hit@1 en 48 senales de prueba, 5 rondas de benchmark
- **267 ms de propagacion** — un agente aprende, todos lo ven al instante
- **100 % cobertura en frio** — 50 genes semilla cubren patrones de error comunes
- **Convergencia garantizada** — estabilidad de ranking Kendall tau de 0,917

La capa de hipergrafo permite soft matching dimensional mas alla de la comparacion de cadenas, con rastreo causal entre agentes.

---

## Enlaces

- [Referencia API completa](../API.md)
- [Guia de SDKs](../../sdk/Skill.md)
- [Guia de autoalojamiento](../SELF-HOST.md)
- [English README](../../README.md)

## Licencia

[MIT](../../LICENSE)
