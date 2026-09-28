# Why numbered ledger ids (grounding research basis)

Design notes for anyone changing the citation instructions or the ledger
mechanics. The wording in SKILL.md is not arbitrary.

## The structural trick

Hallucinated citations happen when a model reconstructs a URL from memory. If
the only thing the model has to emit is a small integer it was handed at
retrieval time, there is nothing to reconstruct — a wrong id is detectable
(it's not in the ledger) and rendering avoids retyping a registered URL.
Registration itself can still contain an incorrect URL; check retrieved identity,
content and claim support independently. The ledger owns numbering, not truth.

Consequence: **register at retrieval, render mechanically.** Any workflow that
lets the model type a URL into the Sources block gives the guarantee back.

## Cite while writing, not after

ALCE (arXiv:2305.14627) evaluates attribution for LLM answers and finds that
generating citations during composition, from numbered retrieved snippets,
produces materially better attribution than post-hoc citation insertion.
Post-hoc attribution invites the model to find a source that plausibly matches
a sentence it already wrote — which is exactly how a citation ends up
supporting something the page doesn't say.

Hence: cite per supported sentence, in-line, as the sentence is written. Never
a citation dump at the end of a paragraph or document.

## Verbatim quotes ground claims

WebGPT (arXiv:2112.09332) collects verbatim quotes at browse time and composes
answers from them. The practical rule for this skill: when a claim carries a
figure, date, name, or quantity, take it from the source's own words rather
than paraphrasing from a summary of a summary. Each summarization hop is a
chance for a number to drift.

## Formatting conventions

From Perplexity's leaked system prompts (jujumilk3/leaked-system-prompts) — the
conventions are worth copying because they're the ones users have been trained
to read:

- Marker directly after the terminal punctuation, no space: `water.[1]`
- Each id in its own brackets: `[1][2]`, not `[1, 2]`
- At most 3 ids per sentence — beyond that the citation stops identifying which
  source carries the claim
- Never cite a source not actually consulted
- Query classes that shouldn't be cited (translation, creative writing, casual
  chat) are exempted by instruction, not by a separate classifier

Perplexity forbids raw URLs in the answer because its UI renders source cards.
For Markdown files this skill renders the id → URL list explicitly. For Prismer
chat/PKF, use the active carrier's citation contract, not a second Markdown copy.

## Related in-tree implementation

`scripts/sources.py`, relative to this installed skill, is the shipped ledger.
Upstream Hermes repository tools are not bundled dependencies. Retrieval can
come from the available browser, ingest CLI, or local documents. The ledger is
task-specific and persists IDs across that task's drafts. A lock timeout fails
without stealing an active writer's lock; stale-lock recovery requires checking
the owning process before removal. Citation coverage measures declared provenance,
not semantic entailment or factual accuracy.
