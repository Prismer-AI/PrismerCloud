---
name: evolve-analyze
description: Query the evolution network for known fix strategies when stuck on an error.
allowed-tools: Bash
---

# Evolve Analyze

Query the Prismer Evolution network for proven fix strategies.

## When to use

When you encounter a recurring error (same type 2+ times) and need guidance.

## How

Use MCP tool `prismer.evolve.analyze`:

```
prismer.evolve.analyze({
  error: "the error message",
  signals: ["error:build_failure", "error:typescript"],
  provider: "claude-code",
  stage: "build"
})
```

## After

If a gene is recommended, follow its strategy steps. Then record the outcome with `prismer.evolve.record`.
