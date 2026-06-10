---
name: memory
description: Persist and retrieve agent memory across sessions — write durable notes, read by path, recall via semantic search, list/delete, and consolidate. Use whenever the user asks to remember/forget something, when you need to look up past decisions or context, or when episodic state matters beyond the current turn. Executes via the `cloud memory` and `cloud recall` CLI.
---

# Memory

Use this skill for **durable episodic memory** — facts, decisions, feedback, and project context that need to survive across sessions. Memory has four canonical types: `user`, `feedback`, `project`, `reference`. The index is `MEMORY.md`; topic files live under semantic paths.

## When to use

- The user explicitly says **"remember X"** or **"forget X"** → write or delete immediately.
- The user references a past decision, preference, or detail you don't have in current context → recall first.
- Before answering a question that depends on prior agreement (architecture, preferences, deadlines), check memory.
- After a non-obvious clarification or correction lands, write it so the next session keeps the lesson.

## CLI Reference

### Write

```bash
# Single memory file with full frontmatter (path is required, content is the body)
cloud memory write \
  --path "decisions/database-choice.md" \
  --type project \
  --description "We chose PostgreSQL over MySQL; deadline 2026-06-01." \
  --content "## Decision\nPostgres 16 because pgvector + better JSON ops."

# Quick fact (no path → auto-named under inbox/)
cloud memory write --type feedback --content "User prefers terse end-of-turn summaries"

# From a journal blob — service extracts structured entries
cloud memory extract --journal "Long stream-of-consciousness session notes..."
```

### Read

```bash
cloud memory read --path "decisions/database-choice.md"   # full file
cloud memory read <file-id>                                # by id
cloud memory list                                          # everything
cloud memory list --type feedback                          # by type
cloud memory list --updated-after "2026-05-01"             # by recency
```

### Recall (semantic search)

```bash
cloud recall "what database did we choose?"               # default: hybrid
cloud recall "timeout retry" --strategy keyword           # exact-match fast path
cloud recall "the thing with the auth bug" --strategy llm # LLM-assisted; slowest, best for fuzzy
cloud recall --layer memory --top-k 5 "..."              # narrow to one layer
```

### Maintenance

```bash
cloud memory delete <file-id>                              # remove a stale memory
cloud memory consolidate                                   # trigger Dream — merge/dedupe/mark stale
cloud memory compact <conversation-id>                     # summarize a long conversation into memory
```

## Memory Types

| Type | What it is | When to write |
|---|---|---|
| `user` | Who the user is, role, preferences, expertise | When you learn role/responsibility/preference details that should shape future behavior |
| `feedback` | Approach corrections + validated approaches | After a correction ("don't do X") OR a non-obvious approval ("yes that was right") |
| `project` | Goals, deadlines, decisions, ongoing initiatives | When you learn who/what/why/by-when that isn't derivable from code |
| `reference` | Pointers to external systems (Linear, Slack, dashboards) | When the user names a tool/channel and its purpose |

## Operating Rules

### Write

- **Don't save secrets, credentials, personal data, or one-off debugging chatter.** Memory is durable — anything you write may be loaded into future contexts.
- Don't save **generic programming advice** that isn't tied to this project. The model already knows generic things.
- Don't save **ephemeral task state** (in-progress work, current-conversation context) — that belongs in plans/tasks, not memory.
- Don't save things derivable from the **current project state** (file paths, conventions, git history). Reading the code is authoritative.
- Don't save things already in **CLAUDE.md**.
- For `feedback` and `project` types, include a **Why** line (the reason the user gave) and a **How to apply** line so future-you can judge edge cases. Knowing *why* lets you decide if the rule still applies when conditions change.
- Convert relative dates to **absolute dates** before writing ("Thursday" → "2026-05-22") so memory stays interpretable as time passes.
- If a fact may become stale, embed the condition or date that makes it valid.

### Read / Recall

- **Read `MEMORY.md` first** when you don't know the exact path. It's the index.
- Treat recall results as **leads, not evidence**. Snippets with low scores are likely false matches; verify by reading the underlying file.
- Don't let memory **override explicit current user instructions** — if the user says ignore memory or contradicts it, trust the current input and update or remove the stale entry.
- Before recommending action based on memory that names a specific function/file/flag, **verify it still exists** (grep / read). Memory is frozen in time.
- For *current* or *recent* state ("what changed this week"), prefer `git log` over recalling activity-log memories.

### Delete

- When updating an outdated memory, **prefer editing** over deleting + rewriting (preserves the link graph).
- When the user says "forget X", search first, confirm the match, then delete. Don't silently fail if recall finds nothing — tell the user.

## Output reporting

After writing memory, echo the path, type, and one-line description back to the user so they can verify what got persisted.

After recalling, list match titles + paths + scores; do **not** paste full file content unless the user asks. The agent driving this skill can follow up with `memory read` for any specific hit.

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `memory-read`, `memory-write`, `memory-recall`.
