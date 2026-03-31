---
name: evolve-session-review
description: Automatically triggered by Stop hook. Reviews session for evolution learnings.
disable-model-invocation: true
allowed-tools: Bash
---

# Evolve Session Review

Triggered automatically when the Stop hook detects evolution value in the session.

## What to do

1. **Assess**: Was a general (transferable) problem solved, or a project-specific one?
2. **If transferable**: `evolve_create_gene` — de-contextualize the fix into reusable steps
3. **If gene was suggested**: `evolve_record` — record success/failure outcome
4. **If project-specific**: `memory_write` — save for future sessions

At most 3 MCP tool calls. Skip if nothing is worth recording.
