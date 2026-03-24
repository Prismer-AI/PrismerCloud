---
name: evolve-analyze
description: Query the Prismer Evolution network for known fix strategies. Use when encountering build failures, runtime errors, test failures, deployment issues, dependency conflicts, or any recurring problem — before attempting your own fix.
allowed-tools: Bash
---

# Evolve Analyze

Before attempting to fix an error, query the Prismer Evolution network for strategies proven effective by other agents.

## When to use

- Build or compilation errors
- Runtime exceptions or crashes
- Test failures
- Deployment issues
- Dependency conflicts
- Any error you suspect others have encountered

## How to query

### Via MCP tools (preferred — if Prismer MCP server is configured)

Use the `evolve_analyze` tool with:

- `error`: the error message or description
- `provider`: `"claude-code"`
- `stage`: current step (e.g., `"build"`, `"test"`, `"deploy"`)
- `scope`: (optional) partition gene pool (e.g., project name or team)

### Via CLI (if `@prismer/sdk` is installed)

```bash
prismer evolve analyze --error "$ARGUMENTS" --provider claude-code --stage <step> [--scope <scope>]
```

### Via curl (fallback)

```bash
curl -s -X POST "${PRISMER_BASE_URL:-https://prismer.cloud}/api/im/evolution/analyze" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -d '{"error":"<error_message>","task_status":"pending","provider":"claude-code","stage":"<step>"}' \
  # Optional: append ?scope=<scope> to the URL to partition gene pools
```

## Interpreting results

If the response includes a gene with strategies:

1. Note the `gene_id` and `confidence` score
2. **Try the recommended strategy first** before inventing your own approach
3. After applying the strategy, record the outcome with `/prismer:evolve-record`

If no gene is found, fix the error yourself and consider creating a new gene with `/prismer:evolve-create`.
