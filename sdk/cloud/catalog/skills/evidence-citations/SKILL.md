---
name: evidence-citations
scope: common
description: Build source-backed research answers and documents with a task-isolated citation ledger, verified quotations, and explicit evidence gaps.
license: MIT
metadata:
  nativeReplaces: [grounded-citations]
  upstream: Hermes Agent skills/research/grounded-citations at 1a1f4a59e2
---
# Evidence Citations

Use for research, comparisons, reports, and factual document generation.
Retrieve through the available ingest/browser tools; a URL alone is not evidence.
Read the actual source and distinguish its claims from your inference.

Resolve `scripts/sources.py` relative to this installed skill directory.
Always pass an absolute, task-specific `--ledger <scratch-dir>/citations.json`.
For Hermes, obtain the current scratch directory from execution context.
Never reset a profile-global ledger or another task's ledger. Resume an existing
ledger when continuing the same task.

1. Register retrieved URLs with `sources.py --ledger <path> add <url> --title <title>`.
2. Store fetched text in task scratch. Attach exact supporting quotations with
   `quote <id> --text <quote> --from <source-file>`; fabricated quotes fail.
3. Write a Markdown draft using the returned numeric citation IDs.
   Unknown facts stay unresolved; preserve contradictory sources.
4. Append the source list from `render --cited-in <draft>` to the draft.
5. Run `verify <draft> --strict --evidence`. This checks citation consistency
   and attached quotations, not whether a source is truthful or entails a claim.
   Add `--min-coverage 1` when every claim needs declared provenance; CJK claims
   are counted, and an unmeasurable draft fails rather than reporting coverage.
   Only numeric `[n]` Markdown is verified; footnotes/LaTeX require their own checks.
6. For PKF, map verified ledger URLs to the citation format in pkf-writing;
   run the PKF validator separately. Do not claim the Markdown checker validates PKF.
7. Deliver requested files through assets/office-artifacts and cloud deliver.
   A short chat answer can cite the same verified sources inline.

No credentials are needed by the ledger. Missing retrieval tools are a coverage
blocker, not a reason to fabricate sources. See references/citation-formats.md
and references/grounding-rationale.md for background; this task-isolation and
Prismer delivery contract takes precedence over upstream host-specific examples.

`render --replace-in` replaces only one unambiguous terminal Sources section and
writes atomically. Fenced examples remain untouched; a non-terminal or duplicate
heading fails without modifying the draft. A lock timeout is a failure, not
permission to delete another writer's lock or continue without exclusivity.
