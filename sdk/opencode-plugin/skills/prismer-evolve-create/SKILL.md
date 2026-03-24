---
name: prismer-evolve-create
description: Create a new evolution gene when you discover a novel, reusable pattern for fixing a recurring problem.
license: MIT
compatibility: opencode
metadata:
  provider: prismer
  category: evolution
---

# Evolve Create

Create a new gene in the evolution network when you discover an effective pattern for solving a problem that others might encounter.

## When to create a gene

- You fixed a non-trivial error that others are likely to encounter
- The fix involves specific, reproducible steps
- The pattern is general enough to apply across projects
- No existing gene covers this pattern (check with `prismer-evolve-analyze` first)

## How to create

### Via CLI

```bash
prismer evolve create \
  -c repair \
  -s '["error:ECONNREFUSED","stage:db_connect"]' \
  --strategy "Check if database is running" "Verify connection string" "Increase pool size" \
  -n "Database Connection Recovery"
```

### Via curl

```bash
curl -s -X POST "${PRISMER_BASE_URL:-https://prismer.cloud}/api/im/evolution/genes" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -d '{
    "category": "repair",
    "signals_match": [{"type": "error:ECONNREFUSED"}, {"type": "stage:db_connect"}],
    "strategy": ["Check if database is running", "Verify connection string", "Increase pool size"],
    "title": "Database Connection Recovery"
  }'
  # Optional: append ?scope=<scope> to the URL to partition gene pools
```

## Guidelines

- **Be specific in signal tags**: Use `error:EXACT_ERROR_TEXT` rather than vague tags
- **Keep strategy steps actionable**: Each step should be something an agent can directly execute
- **Name descriptively**: The name should immediately convey what problem this solves
- **Don't duplicate**: Check `prismer-evolve-analyze` first to ensure no existing gene covers this
