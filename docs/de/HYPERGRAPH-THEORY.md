<p align="center">
  <a href="../HYPERGRAPH-THEORY.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/HYPERGRAPH-THEORY.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./HYPERGRAPH-THEORY.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/HYPERGRAPH-THEORY.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/HYPERGRAPH-THEORY.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/HYPERGRAPH-THEORY.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

# Hypergraph-Evolutionstheorie

> Wie Prismer das Lernen von Agenten als N-äre Wissensstruktur modelliert, inspiriert von Wolfram Physics und der Theorie kausaler Mengen (Causal Set Theory).

## Das Problem mit paarweisen Kanten
Traditionelle Lernsysteme für Agenten modellieren Wissen als **2-äre Kanten**: `(Signal, Gen)`-Paare mit Erfolgs-/Fehlschlagzählern.
```
Standard model:
  edge("error:500|openai|api_call", "Gene_X") → { success: 12, failure: 3 }
```
Das funktioniert — bis es nicht mehr funktioniert. Der Signal-Schlüssel ist ein **kollabierter String**, der mehrere Dimensionen in einen einzigen Wert zusammenfasst. Betrachten wir folgendes Beispiel:
```
Real event:
  Agent A encounters error:500 from OpenAI during api_call stage, applies Gene_X (500 Error Triage), outcome: success.
Stored as:
  signal_key = "error:500|openai|api_call"
  gene_id    = "Gene_X"
```
Nun stößt Agent B auf `error:500` von OpenAI während der `parsing`-Phase. Das Standardmodell sieht einen völlig anderen Signal-Schlüssel — `"error:500|openai|parsing"` — und liefert null Treffer. Aber `Gene_X` würde hier wahrscheinlich ebenfalls funktionieren, denn die Kombination `error:500 + openai` ist entscheidend, nicht die Phase.
**Das 2-äre Modell zerstört dimensionale Beziehungen, indem es sie in Strings kollabiert.**

## Hypergraph: Vollständigen Kontext bewahren
Ein [Hypergraph](https://en.wikipedia.org/wiki/Hypergraph) verallgemeinert Graphen, indem Kanten **beliebig viele Knoten** verbinden können (nicht nur 2). In Prismers Evolution Engine verwenden wir Hypergraphen, um Agenten-Ausführungsereignisse als N-äre Relationen zu modellieren.

### Kernkomponenten
#### Atome — Normalisierte Dimensionen
Jede Dimension eines Ausführungsereignisses wird als unabhängiges **Atom** gespeichert:
| Art | Beispiele | Was es erfasst |
|-----|-----------|----------------|
| `signal_type` | `error:500`, `error:timeout`, `perf:high_latency` | Das Fehler- oder Leistungssignal |
| `provider` | `openai`, `exa`, `anthropic` | Beteiligter externer Dienst |
| `stage` | `api_call`, `network_request`, `parsing` | Ausführungsphase |
| `severity` | `transient`, `critical`, `degraded` | Fehlerschwere |
| `gene` | `seed_timeout_retry_v1`, `500_Error_Triage` | Angewandte Strategie |
| `agent` | `agent_alice`, `agent_bob` | Ausführender Agent |
| `outcome` | `success`, `failed` | Ergebnis |
Atome sind **eindeutig durch (Art, Wert)** — derselbe Atom-Knoten wird in allen Hyperkanten wiederverwendet, die ihn teilen.

#### Hyperkanten (Hyperedges) — N-äre Ausführungsereignisse
Eine einzelne Hyperkante erfasst den **vollständigen Kontext** einer Kapsel-Ausführung:
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
Dies ist eine **einzelne 7-äre Relation**, nicht 7 separate Kanten. Der Unterschied ist für Abfragen entscheidend.

#### Kausale Verknüpfungen (Causal Links) — Lernketten
Wenn Agent B ein Gen auswählt, weil Agent As Ergebnis die Posterior-Verteilung aktualisiert hat, zeichnen wir eine explizite **kausale Verknüpfung** auf:
```
Capsule_A (alice, Gene_X, success)
    │
    │  learning link (strength: 1.0)
    │  "A's success updated Gene_X's Beta posterior,
    │   which influenced B's Thompson Sampling draw"
    ▼
Capsule_B (bob, Gene_X, success)
```
Kausale Verknüpfungen sind **im Standardmodell unsichtbar** — man kann nicht nachvollziehen, warum ein Agent ein bestimmtes Gen ausgewählt hat. Mit dem Hypergraphen lässt sich die vollständige Einflusskette rekonstruieren.

## Abfrage: Mengenschnitt über Atome
Der Hauptvorteil des Hypergraphen ist die **dimensionale Zerlegung** bei Abfragen.
### Standardmodus (String-Abgleich)
```
Query: "error:500|openai|parsing"
Result: No match (exact string differs from "error:500|openai|api_call")
```
### Hypergraph-Modus (Atom-Schnittmenge)
```
Query atoms: {signal_type: "error:500", provider: "openai", stage: "parsing"}
Step 1: Find all hyperedges containing atom "error:500" → {cap_001, cap_007, cap_012}
Step 2: Find all hyperedges containing atom "openai"    → {cap_001, cap_003, cap_007}
Step 3: Intersection: {cap_001, cap_007}
Step 4: Extract gene atoms from matched hyperedges → {"500_Error_Triage", "API_Retry_Backoff"}
Step 5: These are candidates for Thompson Sampling selection
```
Die Abfrage trifft `cap_001`, obwohl die `stage` unterschiedlich ist — weil 2 von 3 Abfrage-Atomen übereinstimmen. Dies ist **weiches Matching** durch strukturelle Überlappung, nicht exakte String-Gleichheit.
### Leistung
Der invertierte Index (`Atom → Hyperkanten`) macht dies effizient:
| Gen-Anzahl | Standardmodus | Hypergraph-Modus |
|------------|--------------|------------------|
| 50 (aktuell) | O(G × T) vollständiger Scan | O(postings) invertierter Index |
| 1.000 | Benötigt LIMIT + ORDER BY | Gleicher invertierter Index |
| 10.000 | Benötigt materialisierte Sichten | Atom-Kardinalität bleibt begrenzt |
Die Atom-Kardinalität wächst logarithmisch (es gibt nur begrenzt viele eindeutige Fehlertypen, Anbieter und Phasen), während die Gen-Anzahl linear wächst. Der Hypergraph skaliert besser.

## Bimodalitätserkennung
Der Hypergraph ermöglicht einen Erkennungsmechanismus, der im Standardmodell unmöglich ist: den **Bimodalitätsindex**.
### Das Problem des verborgenen Kontexts
```
Gene_X overall success rate: 50%  (looks mediocre)
Actually:
  When provider=openai:  90% success  (Gene_X is excellent here)
  When provider=anthropic: 10% success (Gene_X is terrible here)
```
Das 2-äre Modell sieht 50% und geht weiter. Der Hypergraph erkennt, dass sich Ergebnisse nach dem `provider`-Atom clustern, und markiert dies als **bimodal**.
### Algorithmus: Overdispersion-Erkennung (Überdispersion)
```
1. Compute global success rate p from recent outcomes
2. Split outcomes into time windows of size W
3. Compute success rate per window → [r₁, r₂, ..., rₖ]
4. Compute cross-window variance: Var(rᵢ)
5. Compute expected variance if i.i.d.: p(1-p)/W
6. Overdispersion ratio = Var(rᵢ) / expected_var
7. Bimodality index = clamp((ratio - 1) / 9, 0, 1)
```
| Index | Interpretation | Aktion |
|-------|---------------|--------|
| 0.0 | Homogene Ergebnisse | Standard-Thompson-Sampling funktioniert einwandfrei |
| 0.3 | Leichte Heterogenität | Beobachten, könnte von Kontextaufteilung profitieren |
| 0.7 | Starke Bimodalität | Signal benötigt wahrscheinlich dimensionale Zerlegung |
| 1.0 | Extreme Bimodalität | Hypergraph-Analyse auf Atom-Ebene empfohlen |
Wenn Bimodalität erkannt wird, kann das System das Signal in Atom-Ebene-Teilsignale zerlegen und Gene pro Kontext auswählen — eine Fähigkeit, die nur im Hypergraph-Modus existiert.

## Nordstern-Metriken (North Star Metrics)
Sechs quantitative Indikatoren bewerten die Leistung der Evolution Engine, unabhängig berechnet für den Standard- und den Hypergraph-Modus:
| Metrik | Symbol | Formel | Misst |
|--------|--------|--------|-------|
| **Systemerfolgsrate** | SSR | `success / total capsules` | Gesamteffektivität |
| **Konvergenzgeschwindigkeit** | CS | Kapseln, bis neuer Agent SSR ≥ 0,7 erreicht | Kaltstart-Effizienz |
| **Routing-Präzision** | RP | `capsules with coverage ≥ 1 / total` | Qualität der Signal-Gen-Zuordnung |
| **Regret-Proxy** | RegP | `1 - (SSR_actual / SSR_oracle)` | Opportunitätskosten suboptimaler Auswahl |
| **Gen-Diversität** | GD | `1 - HHI(gene usage shares)` | Vermeidung von Monokultur |
| **Explorationsrate** | ER | `edges with < 10 executions / total edges` | Balance zwischen Exploration und Exploitation |
### A/B-Vergleich
Beide Modi akkumulieren Metriken parallel. Sobald beide ≥ 200 Kapseln haben:
```
If hypergraph.SSR - standard.SSR > 0.05  →  hypergraph is better
If delta < -0.05                          →  standard is better
Otherwise                                 →  no significant difference
```
Der Schwellenwert von 0,05 ist konservativ — wir wollen starke Evidenz, bevor wir den Modus wechseln.

## Verbindung zur Wolfram Physics
Das Hypergraph-Modell ist inspiriert von [Wolfram Physics](https://www.wolframphysics.org/), das vorschlägt, dass das Universum ein Hypergraph ist, der sich durch Umschreibungsregeln (Rewrite Rules) entwickelt. Die Zuordnung:
| Wolfram-Konzept | Analogie in der Evolution Engine |
|-----------------|----------------------------------|
| **Atome** (diskrete Token) | Signal-Dimensionen, Gene, Agenten — das Vokabular der Evolution |
| **Hyperkanten** (N-äre Relationen) | Kapsel-Ausführungen — vollständiger Kontext bewahrt |
| **Umschreibungsregeln** (Zustandsübergänge) | Gen-Strategie-Ausführung — transformiert Fehlerzustand in gelösten Zustand |
| **Kausalgraph** (Erreichbarkeit) | Lernketten — welche Kapseln welche Entscheidungen beeinflusst haben |
| **Mehrwegesystem** (parallele Zweige) | Verschiedene Agenten probieren gleichzeitig verschiedene Strategien |
| **Branchialraum** (Zweigabstände) | Strategie-Ähnlichkeit von Agenten — wie nah sind die Ansätze zweier Agenten |
### Was dies ermöglicht (Zukunft)
- **Kausale Zuordnung (Causal Attribution)**: „Die Erfolgsrate dieses Gens hat sich verbessert, weil Agent As 3 erfolgreiche Kapseln über 2 kausale Verknüpfungen Agent Bs Auswahl beeinflusst haben"
- **Strategie-Ähnlichkeit**: Messung des Abstands zwischen Agenten im Branchialraum, um natürliche Cluster zu finden
- **Strukturelle Gen-Ähnlichkeit**: Zwei Gene, die mit denselben Atom-Mustern gemeinsam auftreten, sind wahrscheinlich austauschbar
- **MAP-Elites-Diversität**: Sicherstellen, dass der Gen-Pool den gesamten Atom-Raum abdeckt, nicht nur stark frequentierte Bereiche

## Datenmodell
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
### Tabellengrößen (erwartet)
| Tabelle | Wachstumsmuster | Bei 10K Kapseln |
|---------|----------------|-----------------|
| `im_atoms` | Logarithmisch (begrenztes Vokabular) | ~500 Zeilen |
| `im_hyperedges` | Linear (1 pro Kapsel) | 10.000 Zeilen |
| `im_hyperedge_atoms` | Linear × Verzweigungsfaktor (~7 pro Kante) | 70.000 Zeilen |
| `im_causal_links` | Sublinear (nicht alle Kapseln sind verknüpft) | ~3.000 Zeilen |
Der invertierte Index ist die größte Tabelle, bleibt aber für MySQL auf einer einzelnen Maschine bis zu Millionen von Kapseln gut handhabbar.

## Implementierungsstatus
| Phase | Umfang | Status |
|-------|--------|--------|
| **Phase 0** | Nordstern-Metriken + Modus-Spalte + Datenisolierung | Abgeschlossen |
| **Phase 1** | Atom/Hyperkante/Kausale Verknüpfung Schreibzugriff + invertierter Index Abfrage + Bimodalität | Abgeschlossen (Feature-gated) |
| **Phase 2** | A/B-Auswertung bei ≥200 Kapseln/Modus + Modus-Erweiterungsentscheidung | Warten auf Daten |
| **Phase 3** | Branchialabstand + kausaler Zerfall + MAP-Elites + Gen-Ähnlichkeit | Geplant |
Die Hypergraph-Schicht ist **additiv** — sie schreibt neue Tabellen, ohne die bestehende Kanten-/Kapsel-Logik zu verändern. Beide Modi laufen parallel, isoliert durch die `mode`-Spalte in gemeinsam genutzten Tabellen.

## Weiterführende Literatur
- [Wolfram Physics Project](https://www.wolframphysics.org/) — Die theoretische Grundlage
- [Thompson Sampling for Bernoulli Bandits](https://arxiv.org/abs/1707.02038) — Der Selektionsalgorithmus
- [Hierarchical Bayesian Models](https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling) — Gepoolte Prior-Verteilungen für den Kaltstart
- [Herfindahl-Hirschman Index](https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index) — Messung der Gen-Diversität
- [MAP-Elites](https://arxiv.org/abs/1504.04909) — Qualitäts-Diversitäts-Optimierung (Phase 3)

<p align="center">
  <sub>Teil der <a href="https://github.com/Prismer-AI/PrismerCloud">Prismer Cloud</a> Evolution Engine</sub>
</p>
