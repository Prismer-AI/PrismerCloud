<p align="center">
  <a href="../HYPERGRAPH-THEORY.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/HYPERGRAPH-THEORY.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/HYPERGRAPH-THEORY.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/HYPERGRAPH-THEORY.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./HYPERGRAPH-THEORY.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/HYPERGRAPH-THEORY.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

# Teoria de la Evolucion mediante Hipergrafos

> Como Prismer modela el aprendizaje de agentes como una estructura de conocimiento
> N-aria, inspirada en la Fisica de Wolfram y la teoria de conjuntos causales.

---

## El Problema de las Aristas Binarias

Los sistemas tradicionales de aprendizaje de agentes modelan el conocimiento como **aristas 2-arias** (2-ary edges): pares `(signal, gene)` con conteos de exitos y fallos.

```
Standard model:
  edge("error:500|openai|api_call", "Gene_X") → { success: 12, failure: 3 }
```

Esto funciona, hasta que deja de funcionar. La clave de la signal es una **cadena colapsada** que combina multiples dimensiones en una sola. Consideremos:

```
Real event:
  Agent A encounters error:500 from OpenAI during api_call stage,
  applies Gene_X (500 Error Triage), outcome: success.

Stored as:
  signal_key = "error:500|openai|api_call"
  gene_id    = "Gene_X"
```

Ahora el Agente B encuentra un `error:500` de OpenAI durante la etapa de `parsing`. El modelo estandar ve una clave de signal completamente diferente -- `"error:500|openai|parsing"` -- y devuelve cero coincidencias. Pero `Gene_X` probablemente funcionaria aqui tambien, porque lo que importa es la combinacion `error:500 + openai`, no la etapa.

**El modelo 2-ario destruye las relaciones dimensionales al colapsarlas en cadenas de texto.**

---

## Hipergrafo: Preservando el Contexto Completo

Un [hipergrafo](https://en.wikipedia.org/wiki/Hypergraph) (hypergraph) generaliza los grafos al permitir que las aristas conecten **cualquier numero de nodos** (no solo 2). En el motor de evolucion de Prismer, usamos hipergrafos para modelar eventos de ejecucion de agentes como relaciones N-arias.

### Componentes Fundamentales

#### Atomos (Atoms) -- Dimensiones Normalizadas

Cada dimension de un evento de ejecucion se almacena como un **atomo** independiente:

| Tipo | Ejemplos | Que captura |
|------|----------|-------------|
| `signal_type` | `error:500`, `error:timeout`, `perf:high_latency` | La signal de error o rendimiento |
| `provider` | `openai`, `exa`, `anthropic` | Servicio externo involucrado |
| `stage` | `api_call`, `network_request`, `parsing` | Fase de ejecucion |
| `severity` | `transient`, `critical`, `degraded` | Gravedad del error |
| `gene` | `seed_timeout_retry_v1`, `500_Error_Triage` | Estrategia aplicada |
| `agent` | `agent_alice`, `agent_bob` | Agente ejecutor |
| `outcome` | `success`, `failed` | Resultado |

Los atomos son **unicos por (kind, value)** -- el mismo nodo atomo se reutiliza en todas las hiperaristas que lo comparten.

#### Hiperaristas (Hyperedges) -- Eventos de Ejecucion N-arios

Una sola hiperarista captura el **contexto completo** de la ejecucion de una capsula:

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

Esta es una **relacion 7-aria unica**, no 7 aristas separadas. La distincion es importante para las consultas.

#### Enlaces Causales (Causal Links) -- Cadenas de Aprendizaje

Cuando el Agente B selecciona un gen porque el resultado del Agente A actualizo la distribucion posterior, registramos un **enlace causal** explicito:

```
Capsule_A (alice, Gene_X, success)
    │
    │  learning link (strength: 1.0)
    │  "A's success updated Gene_X's Beta posterior,
    │   which influenced B's Thompson Sampling draw"
    ▼
Capsule_B (bob, Gene_X, success)
```

Los enlaces causales son **invisibles en el modelo estandar** -- no se puede rastrear por que un agente selecciono un gen en particular. Con el hipergrafo, se puede reconstruir la cadena de influencia completa.

---

## Consulta: Interseccion de Conjuntos sobre Atomos

La ventaja clave del hipergrafo es la **descomposicion dimensional** durante las consultas.

### Modo Estandar (Coincidencia de Cadenas)

```
Query: "error:500|openai|parsing"
Result: No match (exact string differs from "error:500|openai|api_call")
```

### Modo Hipergrafo (Interseccion de Atomos)

```
Query atoms: {signal_type: "error:500", provider: "openai", stage: "parsing"}

Step 1: Find all hyperedges containing atom "error:500" → {cap_001, cap_007, cap_012}
Step 2: Find all hyperedges containing atom "openai"    → {cap_001, cap_003, cap_007}
Step 3: Intersection: {cap_001, cap_007}
Step 4: Extract gene atoms from matched hyperedges → {"500_Error_Triage", "API_Retry_Backoff"}
Step 5: These are candidates for Thompson Sampling selection
```

La consulta encontro coincidencia con `cap_001` aunque la `stage` difiere, porque comparte 2 de 3 atomos de consulta. Esto es **coincidencia flexible** (soft matching) por superposicion estructural, no igualdad exacta de cadenas.

### Rendimiento

El indice invertido (`atom -> hyperedges`) hace esto eficiente:

| Cantidad de Genes | Modo Estandar | Modo Hipergrafo |
|-----------|--------------|-----------------|
| 50 (actual) | O(G × T) full scan | O(postings) inverted index |
| 1,000 | Needs LIMIT + ORDER BY | Same inverted index |
| 10,000 | Needs materialized views | Atom cardinality stays bounded |

La cardinalidad de los atomos crece logaritmicamente (hay un numero limitado de tipos de error, proveedores y etapas unicos), mientras que la cantidad de genes crece linealmente. El hipergrafo escala mejor.

---

## Deteccion de Bimodalidad

El hipergrafo habilita un mecanismo de deteccion imposible en el modelo estandar: el **indice de bimodalidad** (bimodality index).

### El Problema del Contexto Oculto

```
Gene_X overall success rate: 50%  (looks mediocre)

Actually:
  When provider=openai:  90% success  (Gene_X is excellent here)
  When provider=anthropic: 10% success (Gene_X is terrible here)
```

El modelo 2-ario ve 50% y sigue adelante. El hipergrafo detecta que los resultados se agrupan segun el atomo `provider` y marca esto como **bimodal**.

### Algoritmo: Deteccion de Sobredispersion

```
1. Compute global success rate p from recent outcomes
2. Split outcomes into time windows of size W
3. Compute success rate per window → [r₁, r₂, ..., rₖ]
4. Compute cross-window variance: Var(rᵢ)
5. Compute expected variance if i.i.d.: p(1-p)/W
6. Overdispersion ratio = Var(rᵢ) / expected_var
7. Bimodality index = clamp((ratio - 1) / 9, 0, 1)
```

| Indice | Interpretacion | Accion |
|-------|---------------|--------|
| 0.0 | Resultados homogeneos | El Thompson Sampling estandar funciona bien |
| 0.3 | Heterogeneidad leve | Monitorear, podria beneficiarse de division por contexto |
| 0.7 | Bimodalidad fuerte | La signal probablemente necesita descomposicion dimensional |
| 1.0 | Bimodalidad extrema | Se recomienda analisis a nivel de atomos del hipergrafo |

Cuando se detecta bimodalidad, el sistema puede descomponer la signal en sub-signals a nivel de atomos y seleccionar genes por contexto -- una capacidad que solo existe en el modo hipergrafo.

---

## Metricas Estrella del Norte (North Star Metrics)

Seis indicadores cuantitativos evaluan el rendimiento del motor de evolucion, calculados independientemente para los modos estandar e hipergrafo:

| Metrica | Simbolo | Formula | Que mide |
|--------|--------|---------|----------|
| **Tasa de Exito del Sistema** | SSR | `success / total capsules` | Efectividad general |
| **Velocidad de Convergencia** | CS | Capsulas para que un nuevo agente alcance SSR >= 0.7 | Eficiencia en arranque en frio (cold start) |
| **Precision de Enrutamiento** | RP | `capsules with coverage ≥ 1 / total` | Calidad del emparejamiento signal-gen |
| **Proxy de Arrepentimiento** | RegP | `1 - (SSR_actual / SSR_oracle)` | Costo de oportunidad de una seleccion suboptima |
| **Diversidad de Genes** | GD | `1 - HHI(gene usage shares)` | Evitar el monocultivo |
| **Tasa de Exploracion** | ER | `edges with < 10 executions / total edges` | Equilibrio entre exploracion y explotacion |

### Comparacion A/B

Ambos modos acumulan metricas en paralelo. Cuando ambos tienen >= 200 capsulas:

```
If hypergraph.SSR - standard.SSR > 0.05  →  hypergraph is better
If delta < -0.05                          →  standard is better
Otherwise                                 →  no significant difference
```

El umbral de 0.05 es conservador -- queremos evidencia solida antes de cambiar de modo.

---

## Conexion con la Fisica de Wolfram

El modelo de hipergrafo se inspira en [Wolfram Physics](https://www.wolframphysics.org/), que propone que el universo es un hipergrafo que evoluciona mediante reglas de reescritura. La correspondencia:

| Concepto de Wolfram | Analogo en el Motor de Evolucion |
|----------------|----------------------|
| **Atomos** (tokens discretos) | Dimensiones de signal, genes, agentes -- el vocabulario de la evolucion |
| **Hiperaristas** (relaciones N-arias) | Ejecuciones de capsulas -- contexto completo preservado |
| **Reglas de reescritura** (transiciones de estado) | Ejecucion de estrategias de genes -- transforma el estado de error en estado resuelto |
| **Grafo causal** (alcanzabilidad) | Cadenas de aprendizaje -- que capsulas influyeron en que decisiones |
| **Sistema multicamino** (ramas paralelas) | Diferentes agentes probando diferentes estrategias simultaneamente |
| **Espacio branchial** (distancias entre ramas) | Similitud de estrategias entre agentes -- que tan cercanos son los enfoques de dos agentes |

### Lo que Esto Permite (Futuro)

- **Atribucion causal**: "La tasa de exito de este gen mejoro porque las 3 capsulas exitosas del Agente A se propagaron a traves de 2 enlaces causales para influir en la seleccion del Agente B"
- **Similitud de estrategias**: Medir la distancia entre agentes en el espacio branchial para encontrar clusters naturales
- **Similitud estructural de genes**: Dos genes que co-ocurren con los mismos patrones de atomos probablemente son intercambiables
- **Diversidad MAP-Elites**: Asegurar que el pool de genes cubra todo el espacio de atomos, no solo las regiones de alto trafico

---

## Modelo de Datos

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

### Tamanos de Tabla (Estimados)

| Tabla | Patron de Crecimiento | Con 10K capsulas |
|-------|---------------|-----------------|
| `im_atoms` | Logaritmico (vocabulario acotado) | ~500 filas |
| `im_hyperedges` | Lineal (1 por capsula) | 10,000 filas |
| `im_hyperedge_atoms` | Lineal x factor de ramificacion (~7 por arista) | 70,000 filas |
| `im_causal_links` | Sublineal (no todas las capsulas estan vinculadas) | ~3,000 filas |

El indice invertido es la tabla mas grande, pero se mantiene comodamente dentro de la capacidad de MySQL en una sola maquina hasta millones de capsulas.

---

## Estado de Implementacion

| Fase | Alcance | Estado |
|-------|-------|--------|
| **Fase 0** | Metricas estrella del norte + columna de modo + aislamiento de datos | Completado |
| **Fase 1** | Escritura de atomos/hiperaristas/enlaces causales + consulta por indice invertido + bimodalidad | Completado (con feature gate) |
| **Fase 2** | Evaluacion A/B con >= 200 capsulas/modo + decision de expansion de modo | Esperando datos |
| **Fase 3** | Distancia branchial + decaimiento causal + MAP-Elites + similitud de genes | Planificado |

La capa de hipergrafo es **aditiva** -- escribe en tablas nuevas sin modificar la logica existente de aristas/capsulas. Ambos modos se ejecutan en paralelo, aislados por la columna `mode` en las tablas compartidas.

---

## Lectura Adicional

- [Wolfram Physics Project](https://www.wolframphysics.org/) -- La base teorica
- [Thompson Sampling for Bernoulli Bandits](https://arxiv.org/abs/1707.02038) -- El algoritmo de seleccion
- [Hierarchical Bayesian Models](https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling) -- Distribuciones a priori agrupadas para arranque en frio
- [Herfindahl-Hirschman Index](https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index) -- Medicion de diversidad de genes
- [MAP-Elites](https://arxiv.org/abs/1504.04909) -- Optimizacion de calidad-diversidad (Fase 3)

---

<p align="center">
  <sub>Parte del Motor de Evolucion de <a href="https://github.com/Prismer-AI/PrismerCloud">Prismer Cloud</a></sub>
</p>
