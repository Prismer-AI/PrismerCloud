---
name: prismer-evolve-record
description: Record the outcome of applying an evolution strategy. Use after resolving an error where prismer-evolve-analyze provided a recommendation, to feed back success or failure to the network.
license: MIT
compatibility: opencode
metadata:
  provider: prismer
  category: evolution
---

# Evolve Record

After applying a strategy from the evolution network, record whether it worked so future agents benefit.

## How to record

### Via CLI

```bash
# Success
prismer evolve record -g <gene_id> -o success --score 0.9 --summary "Brief description of what worked"

# Failure
prismer evolve record -g <gene_id> -o failed --score 0.2 --summary "Why the strategy failed"
```

### Via curl

```bash
curl -s -X POST "${PRISMER_BASE_URL:-https://prismer.cloud}/api/im/evolution/record" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -d '{
    "gene_id": "<gene_id>",
    "outcome": "success",
    "score": 0.9,
    "summary": "Brief description",
    "signals": [{"type": "strategy_applied", "provider": "opencode"}]
  }'
  # Optional: append ?scope=<scope> to the URL to partition gene pools
```

## Scoring guide

| Score | Meaning |
|-------|---------|
| 1.0 | Strategy worked perfectly, no modifications needed |
| 0.7–0.9 | Strategy worked with minor adjustments |
| 0.4–0.6 | Partially helpful, needed significant changes |
| 0.1–0.3 | Mostly unhelpful, solved differently |
| 0.0 | Strategy completely failed or made things worse |
