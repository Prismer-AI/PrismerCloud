---
name: memory-curation
description: |
  When you have read / processed a workspace asset in this session and learned something
  durable about it, write a memory page so future sessions benefit. Maintain the workspace
  wiki's hierarchical structure as it grows.
applies_to: [hermes, claude-code, openclaw, codex]
version: 1
---

# Memory Curation Skill

You have access to a workspace memory layer. Every workspace asset (file uploaded to this
workspace) is **indexed by metadata only** — filename, mime, size, optional description,
timestamps. The system does **not** pre-process file contents.

To inspect assets, use bounded asset tools:

- `prismer.asset.search` to find candidate files
- `prismer.asset.describe` before reading bytes
- `prismer.asset.read` for explicit byte ranges only

Do not claim to have read an asset unless one of these tool calls succeeded.

Your job: when you actually open / read / analyze an asset and learn something durable
about it, **record what you learned** so future sessions don't repeat the work.

## When to write a memory page

Write a memory page after handling an asset if and only if **all** of these are true:

1. You actually read the asset content (not just listed it).
2. You produced an analysis, decision, or summary that is non-trivial — not "this file is a
   CSV with 1000 rows" but "this CSV is Q4 sales data with revenue collapse in region APAC".
3. The conclusion is **durable** — it will still matter weeks from now.
4. The conclusion is **not derivable** from the asset metadata alone or from re-reading
   the asset directly.

Do **not** write a memory page for:

- Files you only listed / saw in a directory listing
- Trivial summaries ("this is a PDF about marketing")
- Conversation context that belongs in the session, not in long-term memory
- Process artifacts: build logs, temporary downloads, cache files, scratch outputs
- Anything the user explicitly asked you not to remember

## What to write

Format: short Markdown page (typical 200-1000 words). Required structure:

```markdown
# <Short descriptive title>

**Source:** [original-filename.ext](prismer://workspace/<wid>/asset/<contentHash>)

**Why this matters:** one sentence explaining the durable conclusion.

<body — your actual analysis / decision / summary>

## Provenance
- Session: <session id or date>
- Tools used: <which tools/skills you ran on this asset>
```

Use `prismer://` URIs for any cross-reference to other assets, memory pages, tasks, etc.
This is the wiki link form — agents in future sessions navigate by following these.

## Where to put it

Path convention:

```
memory/<topic>/<source-slug>.md         ← leaf page about one source
memory/<topic>/<source-slug>/<aspect>.md ← finer-grained aspect of one source
```

`<topic>` is your judgment: `datasets`, `customer-research`, `architecture`, etc. If you
are uncertain, default to the asset's content kind (`datasets/` for tabular, `documents/`
for text-heavy, etc.). The Dream consolidation phase will reorganize sub-optimal placements.

## Index hygiene (important)

The workspace has a top-level `INDEX.md` that points to memory pages. **Do not write
directly into `INDEX.md`** — the system maintains it. Just write your page at the right
path and the indexer will pick it up.

If you notice the top-level INDEX already has >200 entries, **do not create a fresh
top-level page**. Instead nest under an existing sub-index (e.g. `memory/datasets/INDEX.md`
if it exists). The Dream phase will rebalance the hierarchy when it ticks.

## Hub merging

If you write a page about a topic and there is already a hub page for the same topic
(check via `memory_search` before writing), **append to or update the existing hub**
rather than creating a sibling. Hub merging at runtime keeps the wiki coherent and
reduces work for the Dream phase later.

## Deduplication

Before writing, run `memory_search` with terms drawn from the asset content. If a memory
page already contains the same conclusion, do nothing. If a memory page contains a
**different** conclusion about the same source, do not silently overwrite — append a note
or update with an explicit reason.

## What the Dream phase will do for you

You do not need to be perfect. The Dream phase runs periodically (typically idle ≥ 5
minutes or session boundaries) and will:

- Merge duplicates you missed
- Cluster N pages about one topic into a new sub-hub
- Mark stale pages (when the source asset was deleted or the conclusion contradicts a
  newer page)
- Prune low-signal pages that were never recalled and never linked
- Enforce top-level INDEX size invariants

This means: if you are uncertain whether a memory is worth writing, **err on the side of
not writing**. Dream cannot reconstruct missing knowledge, but Dream can prune excess
writes.

## Anti-patterns

- ❌ Writing one memory page per asset by default. Most assets are noise; only a fraction
  yield durable knowledge.
- ❌ Writing memory pages with content equal to a paste of the asset itself. Memory is
  for **conclusions**, not raw content (the raw is already in the asset).
- ❌ Writing memory pages for files the user said to ignore.
- ❌ Editing `INDEX.md` directly.
- ❌ Creating new top-level INDEX entries when one already exists for the topic.

## Anti-pattern detector (rhetorical check)

Before saving, ask yourself: "If I encounter this memory page 6 months from now in a
different session, will it tell me something that re-reading the source asset would not?"
If the answer is no, do not save.
