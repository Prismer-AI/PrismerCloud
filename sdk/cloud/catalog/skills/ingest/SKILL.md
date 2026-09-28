---
name: ingest
scope: common
description: Turn external web URLs into LLM-ready content — load + cache web pages (HQCC compression) and search the web. Use whenever the user gives a URL, asks you to read a webpage, or wants top-K pages on a topic. Executes via the `cloud load` and `cloud search` CLIs. For local document parsing (PDF text + OCR), use the `liteparse` skill instead.
---

# Ingest

Use this skill to **bring external web content into the LLM context window** without copy-pasting raw HTML or burning tokens on uncompressed prose:

- **Web content** → `cloud load` / `cloud search` → returns HQCC (a compressed, LLM-optimized form). Cache hits are free.

> **Local documents (PDF text extraction + OCR) are handled by the `liteparse` skill**, not here — it's a local-first, zero-network tool with Tesseract + PDFium bundled. `ingest` covers web URLs only.

> If your runtime registers the `workspace_web_search` / `web_load` tools (Hermes agents do), prefer them over the CLI — same workspace-billed cloud lane (`/api/context/load`). Never script HTTP via `execute_code`/subprocess for web research.

## When to use

- The user pastes a URL or asks "what does this page say".
- The user asks to research a topic ("AI agent frameworks 2025") — use `search` to fetch top-K relevant pages.
- A task description contains URLs that need to be resolved into actual content before the assignee can act.

> Attached PDFs / images / scans → use the `liteparse` skill (local-first PDF text + OCR), not `ingest`.

## CLI Reference

```bash
# Single URL → HQCC
cloud load https://example.com
cloud load https://example.com --format raw     # exact wording / code / tables (more tokens)

# Batch (up to 50 URLs)
cloud load https://a.com https://b.com https://c.com

# Search → load (fetch top-K relevant pages)
cloud search "AI agent frameworks 2025"
cloud search "topic" -k 10

# Pre-save to cache (e.g. content you scraped elsewhere)
cloud context save https://example.com "compressed content"
```

## Workflow

### For web URLs

1. Decide: single URL load? Batch? Or search query?
2. Default to `--format hqcc` (compressed). Use `raw` only when **exact wording, code, or tables** are needed.
3. Run `cloud load` / `cloud search` and capture: source URLs, titles, cache status, cost.
4. Base downstream reasoning **only on the returned content**. If a load failed, say so; don't pretend you read it.

## Operating Rules

### Load / Search

- **Prefer cached context.** Don't re-process the same source — the service handles cache lookup automatically; just don't re-issue identical loads in tight loops.
- Preserve **source URLs** in your notes and citations. The HQCC return retains origin pointers; use them.
- Don't claim to have read a source until the load **succeeds**. If it fails (404, blocked, timeout), report the failed URL and continue only with clearly stated assumptions or ask for a better source.
- `--format raw` costs more tokens. Only use when the user needs exact wording (legal text, code snippets, tables that compress badly).
- For batch loads, the service runs them concurrently up to a limit; you don't need to throttle yourself.
- For a document / image / scan (not a web page), hand off to the `liteparse` skill — `ingest` does not do OCR or PDF extraction.

## Output reporting

After load/search:
- One-line summary per source: `<title> · <url> · cache_hit | fresh · <cost>`
- Then proceed with the user's actual question, citing the source by URL.

## Backing capabilities (D22 mapping)

Replaces the v1.x built-in skill `context-load`. Local document OCR /
extraction (formerly `parse-document`, backed by the now-retired
`parser.prismer.dev` service) moved to the local-first `liteparse` skill.
