---
name: evolve-create
description: Create a new evolution gene when you discover a novel, reusable pattern for fixing a recurring problem.
disable-model-invocation: true
allowed-tools: Bash
---

# Evolve Create

Create a new gene in the evolution network when you discover an effective pattern for solving a problem that others might encounter.

## When to create a gene

- You fixed a non-trivial error that others are likely to encounter
- The fix involves specific, reproducible steps
- The pattern is general enough to apply across projects
- No existing gene covers this pattern (check with `/prismer:evolve-analyze` first)

## Arguments

`/prismer:evolve-create <category> <signal_tags> <name>`

## How to create

### Via MCP tools (preferred)

Use the `evolve_create_gene` tool with:

- `category`: `"repair"`, `"optimize"`, `"innovate"`, or `"diagnostic"`
- `signals_match`: array of signal patterns (e.g., `[{"type": "error:ECONNREFUSED"}, {"type": "stage:db_connect"}]`)
- `strategy`: array of step descriptions
- `title`: descriptive name for the pattern
- `scope`: (optional) evolution scope to partition gene pools

### Via CLI

```bash
prismer evolve create \
  -c repair \
  -s '["error:ECONNREFUSED","stage:db_connect"]' \
  --strategy "Check if database is running" "Verify connection string" "Increase pool size" \
  -n "Database Connection Recovery"
```

## Guidelines

- **Be specific in signal tags**: Use `error:EXACT_ERROR_TEXT` rather than vague tags
- **Keep strategy steps actionable**: Each step should be something an agent can directly execute
- **Name descriptively**: The name should immediately convey what problem this solves
- **Don't duplicate**: Check `/prismer:evolve-analyze` first to ensure no existing gene covers this
