<p align="center">
  <a href="../HYPERGRAPH-THEORY.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh/HYPERGRAPH-THEORY.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/HYPERGRAPH-THEORY.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./HYPERGRAPH-THEORY.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/HYPERGRAPH-THEORY.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/HYPERGRAPH-THEORY.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

# Theorie de l'evolution par hypergraphe

> Comment Prismer modelise l'apprentissage des agents sous forme de structures
> de connaissance N-aires, inspirees par la physique de Wolfram et la theorie des
> ensembles causaux.

---

## Le probleme des aretes binaires

Les systemes classiques d'apprentissage d'agents modelisent la connaissance sous forme d'**aretes binaires** (2-ary edges) : des paires `(signal, gene)` accompagnees de compteurs de succes et d'echecs.

```
Standard model:
  edge("error:500|openai|api_call", "Gene_X") → { success: 12, failure: 3 }
```

Cela fonctionne -- jusqu'a ce que cela ne fonctionne plus. La cle de signal est une **chaine compactee** (collapsed string) qui fusionne plusieurs dimensions en une seule. Considerons :

```
Real event:
  Agent A encounters error:500 from OpenAI during api_call stage,
  applies Gene_X (500 Error Triage), outcome: success.

Stored as:
  signal_key = "error:500|openai|api_call"
  gene_id    = "Gene_X"
```

Maintenant, l'Agent B rencontre `error:500` provenant d'OpenAI lors de l'etape `parsing`. Le modele standard voit une cle de signal totalement differente -- `"error:500|openai|parsing"` -- et ne retourne aucune correspondance. Pourtant, `Gene_X` fonctionnerait probablement ici aussi, car c'est la combinaison `error:500 + openai` qui importe, pas l'etape.

**Le modele binaire detruit les relations dimensionnelles en les compactant dans des chaines de caracteres.**

---

## Hypergraphe : preserver le contexte complet

Un [hypergraphe](https://en.wikipedia.org/wiki/Hypergraph) generalise les graphes en autorisant les aretes a connecter **un nombre quelconque de noeuds** (et non seulement 2). Dans le moteur d'evolution de Prismer, nous utilisons les hypergraphes pour modeliser les evenements d'execution des agents comme des relations N-aires.

### Composants fondamentaux

#### Atomes (Atoms) -- Dimensions normalisees

Chaque dimension d'un evenement d'execution est stockee sous forme d'**atome** independant :

| Type (Kind) | Exemples | Ce qu'il capture |
|------|----------|-----------------|
| `signal_type` | `error:500`, `error:timeout`, `perf:high_latency` | Le signal d'erreur ou de performance |
| `provider` | `openai`, `exa`, `anthropic` | Le service externe implique |
| `stage` | `api_call`, `network_request`, `parsing` | La phase d'execution |
| `severity` | `transient`, `critical`, `degraded` | La severite de l'erreur |
| `gene` | `seed_timeout_retry_v1`, `500_Error_Triage` | La strategie appliquee |
| `agent` | `agent_alice`, `agent_bob` | L'agent executant |
| `outcome` | `success`, `failed` | Le resultat |

Les atomes sont **uniques par (kind, value)** -- le meme noeud atome est reutilise dans toutes les hyperaretes qui le partagent.

#### Hyperaretes (Hyperedges) -- Evenements d'execution N-aires

Une seule hyperarete capture le **contexte complet** d'une execution de capsule :

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

Il s'agit d'une **relation 7-aire unique**, et non de 7 aretes distinctes. Cette distinction est cruciale pour les requetes.

#### Liens causaux (Causal Links) -- Chaines d'apprentissage

Lorsque l'Agent B selectionne un gene parce que le resultat de l'Agent A a mis a jour la distribution a posteriori, nous enregistrons un **lien causal** explicite :

```
Capsule_A (alice, Gene_X, success)
    │
    │  learning link (strength: 1.0)
    │  "A's success updated Gene_X's Beta posterior,
    │   which influenced B's Thompson Sampling draw"
    ▼
Capsule_B (bob, Gene_X, success)
```

Les liens causaux sont **invisibles dans le modele standard** -- on ne peut pas retracer pourquoi un agent a selectionne un gene particulier. Avec l'hypergraphe, on peut reconstruire l'integralite de la chaine d'influence.

---

## Requete : intersection d'ensembles sur les atomes

L'avantage cle de l'hypergraphe est la **decomposition dimensionnelle** lors des requetes.

### Mode standard (correspondance de chaines)

```
Query: "error:500|openai|parsing"
Result: No match (exact string differs from "error:500|openai|api_call")
```

### Mode hypergraphe (intersection d'atomes)

```
Query atoms: {signal_type: "error:500", provider: "openai", stage: "parsing"}

Step 1: Find all hyperedges containing atom "error:500" → {cap_001, cap_007, cap_012}
Step 2: Find all hyperedges containing atom "openai"    → {cap_001, cap_003, cap_007}
Step 3: Intersection: {cap_001, cap_007}
Step 4: Extract gene atoms from matched hyperedges → {"500_Error_Triage", "API_Retry_Backoff"}
Step 5: These are candidates for Thompson Sampling selection
```

La requete a trouve `cap_001` meme si le champ `stage` differe -- car il partage 2 des 3 atomes de la requete. Il s'agit d'une **correspondance souple** (soft matching) par chevauchement structurel, et non d'une egalite stricte de chaines.

### Performance

L'index inverse (`atome -> hyperaretes`) rend cette operation efficace :

| Nombre de genes | Mode standard | Mode hypergraphe |
|-----------|--------------|-----------------|
| 50 (actuel) | O(G x T) parcours complet | O(postings) index inverse |
| 1 000 | Necessite LIMIT + ORDER BY | Meme index inverse |
| 10 000 | Necessite des vues materialisees | La cardinalite des atomes reste bornee |

La cardinalite des atomes croit de maniere logarithmique (il n'existe qu'un nombre limite de types d'erreurs, de fournisseurs et d'etapes), tandis que le nombre de genes croit lineairement. L'hypergraphe passe mieux a l'echelle.

---

## Detection de bimodalite

L'hypergraphe permet un mecanisme de detection impossible dans le modele standard : l'**indice de bimodalite** (bimodality index).

### Le probleme du contexte cache

```
Gene_X overall success rate: 50%  (looks mediocre)

Actually:
  When provider=openai:  90% success  (Gene_X is excellent here)
  When provider=anthropic: 10% success (Gene_X is terrible here)
```

Le modele binaire voit 50 % et passe a la suite. L'hypergraphe detecte que les resultats se regroupent par l'atome `provider` et signale cela comme **bimodal**.

### Algorithme : detection de la surdispersion (Overdispersion Detection)

```
1. Compute global success rate p from recent outcomes
2. Split outcomes into time windows of size W
3. Compute success rate per window → [r₁, r₂, ..., rₖ]
4. Compute cross-window variance: Var(rᵢ)
5. Compute expected variance if i.i.d.: p(1-p)/W
6. Overdispersion ratio = Var(rᵢ) / expected_var
7. Bimodality index = clamp((ratio - 1) / 9, 0, 1)
```

| Indice | Interpretation | Action |
|-------|---------------|--------|
| 0.0 | Resultats homogenes | Le Thompson Sampling standard fonctionne bien |
| 0.3 | Heterogeneite legere | A surveiller, peut beneficier d'un decoupage contextuel |
| 0.7 | Bimodalite marquee | Le signal necessite probablement une decomposition dimensionnelle |
| 1.0 | Bimodalite extreme | Analyse au niveau des atomes de l'hypergraphe recommandee |

Lorsqu'une bimodalite est detectee, le systeme peut decomposer le signal en sous-signaux au niveau des atomes et selectionner des genes par contexte -- une capacite qui n'existe qu'en mode hypergraphe.

---

## Metriques etoile du Nord (North Star Metrics)

Six indicateurs quantitatifs evaluent les performances du moteur d'evolution, calcules independamment pour les modes standard et hypergraphe :

| Metrique | Symbole | Formule | Ce qu'elle mesure |
|--------|--------|---------|----------|
| **Taux de reussite systeme** | SSR | `success / total capsules` | Efficacite globale |
| **Vitesse de convergence** | CS | Capsules pour qu'un nouvel agent atteigne SSR >= 0.7 | Efficacite du demarrage a froid |
| **Precision de routage** | RP | `capsules with coverage >= 1 / total` | Qualite de l'appariement signal-gene |
| **Proxy de regret** | RegP | `1 - (SSR_actual / SSR_oracle)` | Cout d'opportunite d'une selection sous-optimale |
| **Diversite des genes** | GD | `1 - HHI(gene usage shares)` | Prevention de la monoculture |
| **Taux d'exploration** | ER | `edges with < 10 executions / total edges` | Equilibre exploration vs exploitation |

### Comparaison A/B

Les deux modes accumulent des metriques en parallele. Lorsque les deux atteignent >= 200 capsules :

```
If hypergraph.SSR - standard.SSR > 0.05  →  hypergraph is better
If delta < -0.05                          →  standard is better
Otherwise                                 →  no significant difference
```

Le seuil de 0.05 est conservateur -- nous voulons des preuves solides avant de changer de mode.

---

## Connexion avec la physique de Wolfram

Le modele en hypergraphe s'inspire de la [physique de Wolfram](https://www.wolframphysics.org/) (Wolfram Physics), qui propose que l'univers est un hypergraphe evoluant via des regles de reecriture. Voici la correspondance :

| Concept Wolfram | Equivalent dans le moteur d'evolution |
|----------------|----------------------|
| **Atomes** (jetons discrets) | Dimensions de signaux, genes, agents -- le vocabulaire de l'evolution |
| **Hyperaretes** (relations N-aires) | Executions de capsules -- contexte complet preserve |
| **Regles de reecriture** (transitions d'etat) | Execution de strategies de genes -- transforme un etat d'erreur en etat resolu |
| **Graphe causal** (atteignabilite) | Chaines d'apprentissage -- quelles capsules ont influence quelles decisions |
| **Systeme multivoie** (branches paralleles) | Differents agents essayant differentes strategies simultanement |
| **Espace branchial** (distances entre branches) | Similarite de strategies entre agents -- a quel point les approches de deux agents sont proches |

### Ce que cela permet (perspectives futures)

- **Attribution causale** : "Le taux de reussite de ce gene s'est ameliore parce que les 3 capsules reussies de l'Agent A se sont propagees a travers 2 liens causaux pour influencer la selection de l'Agent B"
- **Similarite de strategies** : Mesurer la distance entre agents dans l'espace branchial pour trouver des regroupements naturels
- **Similarite structurelle de genes** : Deux genes qui co-apparaissent avec les memes motifs d'atomes sont probablement interchangeables
- **Diversite MAP-Elites** : S'assurer que le pool de genes couvre l'ensemble de l'espace des atomes, et pas seulement les regions a fort trafic

---

## Modele de donnees

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

### Tailles des tables (estimations)

| Table | Schema de croissance | A 10 000 capsules |
|-------|---------------|-----------------|
| `im_atoms` | Logarithmique (vocabulaire borne) | ~500 lignes |
| `im_hyperedges` | Lineaire (1 par capsule) | 10 000 lignes |
| `im_hyperedge_atoms` | Lineaire x ramification (~7 par arete) | 70 000 lignes |
| `im_causal_links` | Sous-lineaire (toutes les capsules ne sont pas liees) | ~3 000 lignes |

L'index inverse est la plus grande table, mais reste largement dans les capacites d'un MySQL mono-serveur jusqu'a des millions de capsules.

---

## Etat de l'implementation

| Phase | Perimetre | Statut |
|-------|-------|--------|
| **Phase 0** | Metriques etoile du Nord + colonne mode + isolation des donnees | Termine |
| **Phase 1** | Ecriture atome/hyperarete/lien causal + requete par index inverse + bimodalite | Termine (sous feature flag) |
| **Phase 2** | Evaluation A/B a >= 200 capsules/mode + decision d'extension du mode | En attente de donnees |
| **Phase 3** | Distance branchiale + decroissance causale + MAP-Elites + similarite de genes | Planifie |

La couche hypergraphe est **additive** -- elle ecrit dans de nouvelles tables sans modifier la logique existante des aretes et capsules. Les deux modes fonctionnent en parallele, isoles par la colonne `mode` dans les tables partagees.

---

## Lectures complementaires

- [Wolfram Physics Project](https://www.wolframphysics.org/) -- Le fondement theorique
- [Thompson Sampling for Bernoulli Bandits](https://arxiv.org/abs/1707.02038) -- L'algorithme de selection
- [Hierarchical Bayesian Models](https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling) -- A priori mutualises pour le demarrage a froid
- [Herfindahl-Hirschman Index](https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index) -- Mesure de la diversite des genes
- [MAP-Elites](https://arxiv.org/abs/1504.04909) -- Optimisation qualite-diversite (Phase 3)

---

<p align="center">
  <sub>Fait partie du moteur d'evolution de <a href="https://github.com/Prismer-AI/PrismerCloud">Prismer Cloud</a></sub>
</p>
