---
name: liteparse
description: Parse documents into LLM-ready content entirely on the local machine — PDF / DOCX / XLSX / PPTX / images → Markdown, structured JSON (with bounding boxes), or page screenshots, via the `lit` CLI. No cloud, no LLM, works offline. Use whenever the user attaches or points to a document that must be read before reasoning, or asks to extract text / tables / page images from a file.
---

# LiteParse (local-first document parsing)

LiteParse is a standalone OSS parser (Rust core, PDFium + Tesseract +
LibreOffice) that turns documents into text the model can read — **fully
local, zero cloud dependency, works with no network**. It is the
daemon's local-first document-parsing path.

> Upstream: [`run-llama/liteparse`](https://github.com/run-llama/liteparse)
> + skill [`run-llama/llamaparse-agent-skills`](https://github.com/run-llama/llamaparse-agent-skills/blob/main/skills/liteparse/SKILL.md).
> Apache-2.0 (core) / MIT (skill), © LlamaIndex. Vendored as a Prismer
> built-in; the CLI (`lit`) self-installs on first use (see below).

## Scope — liteparse vs `ingest`

Two document paths coexist; pick by network + fidelity needs:

- **`liteparse` (this skill) — local-first.** Local document files →
  Markdown / JSON / screenshots, fully offline, zero cost, zero cloud.
  Covers PDF, Word, PowerPoint, spreadsheets, images. Built-in
  Tesseract OCR for clean scans; LibreOffice for Office formats.
  **Default for**: files already on disk, offline / cloud-unreachable
  situations, digital PDFs, quick extraction, bounding boxes, page
  screenshots.
- **`ingest` (sibling skill) — cloud-backed.** `cloud load` / `cloud
  search` for **web URLs** (HQCC compression) and `cloud parse` for
  **hi-res OCR** of scans / handwriting / dense tables. **Use when**:
  the source is a web page (liteparse can't fetch URLs), or local
  parsing quality is insufficient (dense tables, multi-column,
  handwriting, low-quality scans).

Decision rule: **local file → try `liteparse` first** (free, offline,
fast). Escalate to `ingest`'s `cloud parse -m hires` only when local
fidelity falls short. **Web URL / search → `ingest`** (liteparse parses
local files and stdin, not remote pages — if you only have a URL,
`curl -sL <url> -o file` then parse the local copy, or route to
`ingest`).

When local parsing is low-confidence (empty pages, garbled OCR),
**flag the region** and consider escalating to `ingest`; never invent
content.

## First-use install (self-bootstrapping)

The `lit` CLI ships via npm/pip/cargo (same CLI). Check, then install if
missing. Do this once per environment, quietly.

```bash
# 1. Is it already available? (sandbox image may bake it)
command -v lit && lit --version && echo "lit ready" || {
  # 2. Install the CLI
  npm i -g @llamaindex/liteparse && lit --version
}
```

System dependencies for Office conversion + image handling (only needed
for non-PDF inputs):

```bash
# LibreOffice — required for DOCX/XLSX/PPTX/ODT/RTF conversion
brew install --cask libreoffice        # macOS
apt-get install -y libreoffice         # Debian/Ubuntu (daemon image)

# ImageMagick — required for some image formats
brew install imagemagick               # macOS
apt-get install -y imagemagick         # Debian/Ubuntu
```

If install fails (no network, no package manager), do **not** fabricate
parsed content — report `lit unavailable (<reason>)` and stop.

## CLI reference

### Parse a file

```bash
lit parse document.pdf                                  # → text on stdout
lit parse document.pdf --format json -o out.json        # structured JSON + bounding boxes
lit parse document.pdf --target-pages "1-5,10,15-20"    # page subset
lit parse document.pdf --no-ocr                          # skip OCR (digital PDFs only)
lit parse document.pdf --dpi 300                         # higher render DPI
lit parse scan.pdf --ocr-language eng+chi_sim            # Tesseract lang codes
lit parse secured.pdf --password '****'                  # encrypted docs
curl -sL https://example.com/report.pdf | lit parse -    # stdin (download-then-parse)
```

Key `lit parse` options: `-o/--output`, `--format json|text`
(default text), `--no-ocr`, `--ocr-language <lang>`, `--ocr-server-url
<url>` (plug an external OCR HTTP server), `--tessdata-path`,
`--target-pages "1-5,10"`, `--max-pages <n>` (default 1000), `--dpi`
(default 150), `--preserve-small-text`, `--password`, `--num-workers`,
`-q/--quiet`.

### Batch a directory

```bash
lit batch-parse ./input-dir ./output-dir
lit batch-parse ./input-dir ./output-dir --recursive --extension .pdf --format json
```

### Page screenshots (for visual content text can't capture)

```bash
lit screenshot document.pdf -o ./screenshots                  # all pages → PNG
lit screenshot document.pdf --target-pages "1,3,5" -o ./shots
lit screenshot document.pdf --dpi 300 -o ./shots              # high-res
```

Supported formats: PDF · Word (DOC/DOCX/DOCM/ODT/RTF) · PowerPoint
(PPT/PPTX/PPTM/ODP) · Spreadsheets (XLS/XLSX/ODS/CSV/TSV) · Images
(JPG/PNG/GIF/BMP/TIFF/WEBP/SVG).

## Workflow

1. **Locate the file.** If it's a workspace asset, resolve its local
   path (see `assets` skill). If it's a URL, `curl -sL <url> -o
   <name>` first — `lit` parses local files (and stdin), not remote
   pages.
2. **Pick mode.**
   - Digital PDF / clean doc → `lit parse <f>` (add `--no-ocr` to skip
     OCR and go faster when the PDF has a real text layer).
   - Scan / image / handwriting → leave OCR on; set `--ocr-language`
     and bump `--dpi 300` if text is small.
   - Need spatial structure / tables with coordinates → `--format
     json` (gives bounding boxes).
   - Need to *see* a chart/figure/signature → `lit screenshot`, then
     read the PNG.
3. **Read the result as source of truth.** Base extraction/summary
   only on what `lit` returned. If a page is empty or low-confidence,
   say so; don't guess.
4. **Deliver products, if the parse output itself is the deliverable.**
   Write final files into `$PRISMER_ARTIFACTS_DIR` (the dispatch's
   `artifacts/` dir — auto-archived as IMAssets by the daemon's
   artifacts-watcher and attached to your reply). See `office-artifacts`
   SKILL.md §Delivery contract for the full delivery rules.

## Output reporting

- After a parse: `Parsed <filename>: <N> pages, format=<text|json>,
  ocr=<on|off>` — then proceed with the user's actual question.
- Don't dump the entire parsed body into chat unless asked; summarize
  and cite page numbers.
- After screenshots: `Rendered <N> page screenshot(s) → <dir>` and read
  the relevant ones.

## HARD RULE — never claim a parse you didn't run

Forbidden unless `lit` actually ran with exit 0 and produced output:
"parsed the document", "the PDF says…", "extracted the table". If `lit`
is unavailable or the parse failed, completion text must start with
`无法解析文档 (reason)` / `Cannot parse document (reason)` — do not
substitute guessed content.
