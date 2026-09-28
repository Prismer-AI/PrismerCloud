---
name: memory-import
scope: common
description: Bulk-import an external knowledge base into Prismer memory via the three-layer import pipeline (07 §3.1). Use when the user asks to import/migrate documents, a knowledge base, or notes into workspace memory. Layer 1 lands raw documents (zero LLM, instantly searchable); Layer 2 is YOUR distillation work — you read the landed documents and write candidate pages; Layer 3 commits candidates through the memory evolution gate. Distinct from the native memory_write tool face (that is for single, in-conversation writes).
---

# Memory Import

Bulk-import external material into workspace memory through a **session** — the
unit of quota, audit, and gate evaluation. Three layers, two of which are yours:

## Layer 1 — land the documents (zero LLM, do this first)

```bash
cloud memory imports open --workspace <ws>          # → { id }
cloud memory imports write-documents <id> --workspace <ws> --documents '[{"name":"…","content":"…"}]'
```

Raw documents become searchable in seconds. No quality bar here — that is Layer 2's job.

## Layer 2 — distill (YOUR LLM, your compute)

Read the landed documents, then author candidate pages and submit them:

- One page per coherent topic, attached under the right hub (`<hub>/<topic>.pkf`, relative to the Memory root; do not prepend another `memory/`).
- Every candidate MUST carry the `memory` frontmatter block — the pipeline rejects
  the whole batch otherwise:
  `{"type":"note","title":"…","description":"…","memory":{"memoryRole":"knowledge|procedure|action_result","source":"<where this came from, in words a human can read>"}}`.
- Distill, don't dump: conclusions and procedures, not transcripts. The raw
  documents stay in Layer 1 as the reference layer.

```bash
cloud memory imports write-batch <id> --workspace <ws> --candidates '[{"pagePath":"…","contentDiff":"<full PKF body>"}]'
```

## Layer 3 — commit (cloud-side gate, zero negotiation)

```bash
cloud memory imports commit <id> --workspace <ws>   # runs the evolution gate
cloud memory imports status <id> --workspace <ws>   # per-candidate verdicts
```

The gate REJECTS batches that lose retrieval coverage (a candidate replacing a
page must not delete its keywords) or lack metadata. A rejected commit is final
for the session: read the verdict, fix the candidates, open a NEW session, resubmit.
Never re-submit an identical rejected batch — the Ledger rejects same-shape
candidates for 30 days.

**Routing**: raw archive / small batch → L1 + owner review. Knowledge-base
migration / high-quality distillation → L1 → L2 → L3 (semantic work on YOUR
compute; the cloud only gates and records).
