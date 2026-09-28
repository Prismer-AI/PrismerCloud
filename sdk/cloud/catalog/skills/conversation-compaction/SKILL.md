---
name: conversation-compaction
scope: common
metadata:
  internal: true
  excludeFromDefaultInstall: true
description: Produce the SESSION PROJECTION of memory for an aging conversation slice. Runs as a single background model call (mirroring the memory `extract` hook) with NO live memory tools — durable capture to memory is `extract`'s job. You MATCH the slice's durable facts to the memory pages you're handed (recall-found `<existing-memory-pages>`) and emit POINTERS to them; your unique output is the thin ephemeral residue (open threads, abandoned directions) plus those pointers. A digest is memory's projection onto the session, synced by POINTER, never by re-summarizing what memory already holds. Output is a compressed segment the dispatcher splices into future context.
---

# Conversation Compaction — memory's session projection

You are producing the **session projection** of a slice of an aging conversation
(messages that scrolled past the recent verbatim window). The projection replaces the
raw slice in future agent context.

## The model — sync by POINTER, not by re-summary

Durable knowledge lives in **memory** (the `memory` skill owns it). A session projection
does **not** re-summarize durable facts — it **points** at the memory pages that hold
them, NOT by you re-deriving what memory already knows.

> **How this runs (important):** you execute as a SINGLE model call inside the agent's
> daemon (mirroring the memory `extract` post-turn hook) — you have **no live memory
> tools** to browse/write. Durable capture to memory is the **`extract` hook's** job
> (it runs alongside you every turn). Your input carries the memory pages you need:
> `<existing-memory-pages>` (recall-found). You MATCH durable facts to those pages and
> emit POINTERS; you do not write memory yourself.

Your job over a slice is only:

```
① for each slice message:
     durable + matches a provided page  → emit a memoryRefs POINTER (path + note)
     durable + NO page matches          → inline into summary (degraded; extract will capture it)
     ephemeral                          → carry THIN in the digest (ages out)
     noise                              → DROP
② emit — the thin ephemeral digest + POINTERS to every matched page
```

## Input you receive

- `slice`: the raw messages, oldest first, each `[msgId] @username (role): text`.
- `conversationType`: `group` | `direct`.
- `<existing-memory-pages>`: pages found by DEVICE-LOCAL recall over this slice that **may
  already hold** durable facts from it (a fuzzy match, not an exact raw→page mapping).

## Pointer-first rule (recall-fed)

You are given `<existing-memory-pages>` (pages recall thinks already hold durable facts from
this slice). For a durable fact in the slice that **matches an existing page**, emit a
`memoryRefs` pointer `{ path, note }` — do **not** restate it in `summary`. Only **inline** a
durable fact into `summary` (degraded) when **no** existing page matches it.

## Flow

Triage each slice message:

- **Durable** ("would matter in a *different* conversation next week?") → does a page in
  `<existing-memory-pages>` already hold it? **Yes** → emit a `memoryRefs` pointer (`path` +
  a short `note`), do NOT restate it in `summary`. **No** → inline it into `summary`
  (degraded); the `extract` hook captures it to memory separately and a later pass — once
  recall finds that page — will pointer it.
- **Ephemeral** ("only matters to keep *this* thread coherent?") → thin digest line.
- **Noise** ("lose it, nothing changes?") → drop.

Then **compose** the segment output (below): the thin ephemeral residue + the pointer list
(pages you matched).

**Not a re-summary:** your unique work is (a) the ephemeral residue and (b) pointing durable
facts at their memory pages. Durable *capture* (writing pages) is the `extract` hook's job,
not yours.

## Speaker attribution → into the memory page's provenance

For `group` slices, who decided / who objected IS content. Carry attribution into the
memory page (who decided, who dissented). Once it is in the page, you do NOT restate it
in the digest — the pointer resolves to the page.

## Output shape

Return ONLY this JSON — no prose, no fences:

```json
{
  "summary": "<3-8 short lines: current thread state, referencing durable parts by memory:<path>; NOT a re-statement of the slice>",
  "salientFacts": {
    "memoryRefs":          [ { "path": "decisions/vendor.pkf", "note": "vendor B (compliance); @ceo decided, @eng dissented" } ],
    "openThreads":         [ "awaiting @ceo sign-off on A4 vs Letter page size" ],
    "abandonedDirections": [ "tried gpt-4o for compaction — too slow, dropped" ]
  }
}
```

- `memoryRefs` — one POINTER per matched page (`{ path, note }`).
- `openThreads` / `abandonedDirections` — the ephemeral residue only. Omit if empty.
- **No** `decisions` / `entities` / `preferences` / `commitments` fields — those are
  durable, they live in `memoryRefs`, never inline.

**Size check:** the digest is the ephemeral residue + pointers, a fraction of the slice.
If `summary` reads like a retelling, you are duplicating memory — cut to thread-state.

## Failure / degradation

- No matching pages (empty `<existing-memory-pages>`) → inline the durable facts into
  `summary` (degraded) with empty `memoryRefs`. `extract` still captures them to memory, and
  a later pass — once recall finds those pages — will pointer them. Never fail the compaction.
- Slice is pure noise → `{ "summary": "(no substantive content)", "salientFacts": {} }`.

## Anti-patterns

- ❌ **Restating in the digest what lives in memory** — point to the page.
- ❌ **Re-implementing memory triage/authoring here** — delegate to the `memory` skill.
- ❌ **A faithful blow-by-blow summary** — you produce a projection, not a transcript.
- ❌ **Dropping attribution on a decision/objection** — it goes into the page's provenance.
- ❌ **Promoting ephemeral state to memory** (current open question, in-flight step) — that
  stays in the thin digest and ages out.
- ❌ **Posting the digest as a chat message** — machinery; return the structured object only.
