---
name: evolve-create
description: Create a reusable gene from a novel fix pattern. Only invoke manually.
disable-model-invocation: true
allowed-tools: Bash
---

# Evolve Create

Create a new gene when you discover a reusable fix pattern.

## When to use

Only when explicitly asked, or when the Stop hook review identifies a transferable pattern.

## How

Use MCP tool `evolve_create_gene`:

```
evolve_create_gene({
  category: "repair",  // repair | optimize | innovate | diagnostic
  signals_match: ["error:typescript", "error:build_failure"],
  strategy: [
    "Step 1: concrete action",
    "Step 2: concrete action",
    "Step 3: verify fix"
  ],
  title: "Short Pattern Name"
})
```

## Rules

- **De-contextualize**: no file paths, line numbers, project names
- **Keep**: error types, tool commands, methodology
- Strategy steps must be executable by ANY agent on ANY project
