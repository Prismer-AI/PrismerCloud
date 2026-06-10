---
name: ingest
description: Turn external URLs and documents into LLM-ready content — load + cache web pages (HQCC compression) and OCR PDFs/images to Markdown. Use whenever the user gives a URL, asks you to read a webpage, or attaches a PDF/scan that needs to be parsed before reasoning. Executes via the `cloud load`, `cloud search`, and `cloud parse` CLIs.
---

# Ingest

Use this skill to **bring external content into the LLM context window** without copy-pasting raw HTML or burning tokens on uncompressed prose. Two paths:

- **Web content** → `cloud load` / `cloud search` → returns HQCC (a compressed, LLM-optimized form). Cache hits are free.
- **Documents (PDF, images)** → `cloud parse` → OCR to Markdown. Two modes: `fast` (digital PDFs, clean images) and `hires` (scans, handwriting).

## When to use

- The user pastes a URL or asks "what does this page say".
- The user asks to research a topic ("AI agent frameworks 2025") — use `search` to fetch top-K relevant pages.
- The user attaches a PDF or image and the next step requires reading its contents.
- A task description contains URLs that need to be resolved into actual content before the assignee can act.

## CLI Reference

### Web content

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

### Documents (OCR)

```bash
# Fast mode — digital PDFs, clean images
cloud parse https://example.com/paper.pdf

# Hi-res — scans, handwriting, complex layouts
cloud parse https://example.com/scan.pdf -m hires

# Async — long parses return a task id; poll until ready
cloud parse <url> --async                       # → returns parseTaskId
cloud parse-status <parseTaskId>                # check progress
cloud parse-result <parseTaskId>                # fetch finished markdown
```

Supported parse formats: PDF, PNG, JPG, TIFF, BMP, GIF, WEBP.

## Workflow

### For web URLs

1. Decide: single URL load? Batch? Or search query?
2. Default to `--format hqcc` (compressed). Use `raw` only when **exact wording, code, or tables** are needed.
3. Run `cloud load` / `cloud search` and capture: source URLs, titles, cache status, cost.
4. Base downstream reasoning **only on the returned content**. If a load failed, say so; don't pretend you read it.

### For documents

1. Confirm the URL points to the **actual document** (PDF/image), not a landing page that hosts it. If unsure, try `cloud load` first to see what's at that URL.
2. Start with `fast` mode for digital PDFs and clean images. Switch to `hires` when fidelity matters (scans, handwriting, dense tables).
3. If parse returns asynchronously, record the **parseTaskId** and **don't invent** content while waiting.
4. When the result returns, capture page count, cost, and any parse warnings.
5. Use the parsed Markdown as the **source of truth** for subsequent extraction or summary.

## Operating Rules

### Load / Search

- **Prefer cached context.** Don't re-process the same source — the service handles cache lookup automatically; just don't re-issue identical loads in tight loops.
- Preserve **source URLs** in your notes and citations. The HQCC return retains origin pointers; use them.
- Don't claim to have read a source until the load **succeeds**. If it fails (404, blocked, timeout), report the failed URL and continue only with clearly stated assumptions or ask for a better source.
- `--format raw` costs more tokens. Only use when the user needs exact wording (legal text, code snippets, tables that compress badly).
- For batch loads, the service runs them concurrently up to a limit; you don't need to throttle yourself.

### Parse

- Don't parse **private or access-controlled documents** unless the user explicitly intended to share that source.
- Prefer `cloud load` for **normal web pages**. Use parse only when the source is a document / image / scan that load can't extract from.
- For large or expensive parses (long PDFs in hi-res), explain the tradeoff before running if the user didn't explicitly ask for full fidelity.
- If the result is **incomplete** (truncated, low confidence on key pages), ask for a clearer source or escalate to `hires` before drawing firm conclusions.
- Async parse is the right call for documents >50 pages or hi-res scans. Sync mode will time out on these.

## Output reporting

After load/search:
- One-line summary per source: `<title> · <url> · cache_hit | fresh · <cost>`
- Then proceed with the user's actual question, citing the source by URL.

After parse:
- `Parsed <filename>: <pageCount> pages, <cost> credits, mode=<fast|hires>`
- If async: `Parse queued as <parseTaskId>; poll with cloud parse-status`
- Use the markdown body for the next step; don't dump the whole thing in chat unless the user asked.

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `context-load`, `parse-document`.
