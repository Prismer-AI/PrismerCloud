---
name: evolve-record
description: Record the outcome after applying an evolution strategy.
allowed-tools: Bash
---

# Evolve Record

Record whether a suggested gene strategy worked.

## When to use

After `evolve_analyze` recommended a gene and you applied its strategy.

## How

Use MCP tool `evolve_record`:

```
evolve_record({
  gene_id: "the gene ID from analyze",
  outcome: "success",  // or "failed"
  signals: ["error:build_failure"],
  score: 0.9,          // 0.0 to 1.0
  summary: "Brief description of what happened"
})
```
