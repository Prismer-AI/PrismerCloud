---
name: liteparse
scope: common
description: "Parse local document files into LLM-ready content on the daemon itself — PDFs → Markdown / structured JSON (with bounding boxes) / page screenshots via the bundled `lit` CLI. PDF works out of the box, offline, zero external deps (Tesseract + PDFium are bundled): digital PDFs use a near-instant native text path (`--no-ocr`), scanned PDFs fall back to bundled OCR. Image files (PNG/JPG) additionally need ImageMagick, and Office files (DOCX/XLSX/PPTX) need LibreOffice — install those on demand only when required. Use whenever the user attaches or points to a local file that must be read before reasoning, or asks to extract text / tables / page images from a file on disk. For web URLs and search, use the `ingest` skill instead."
---

# LiteParse (local-first document parsing)

LiteParse turns document files into text the model can read — **on the
daemon machine, offline, zero cloud dependency**. It ships as the
`@llamaindex/liteparse` npm package (CLI: `lit`) with **PDFium and
Tesseract bundled inside the package** — the digital-PDF and scanned-OCR
paths need no external system dependencies.

> Upstream: [`run-llama/liteparse`](https://github.com/run-llama/liteparse)
> + skill [`run-llama/llamaparse-agent-skills`](https://github.com/run-llama/llamaparse-agent-skills/blob/main/skills/liteparse/SKILL.md).
> Apache-2.0 (core) / MIT (skill), © LlamaIndex. Vendored as a Prismer
> built-in.

## Capability tiers — what works where

| Tier | Inputs | External dep | Status |
| --- | --- | --- | --- |
| **1 — PDF** | digital + scanned PDF | **none** (Tesseract + PDFium bundled) | **Default, out of the box** — `lit` is baked into the daemon image |
| **2 — Images** | PNG / JPG / TIFF / … | **ImageMagick** | Install on demand |
| **3 — Office** | DOCX / XLSX / PPTX / ODT | **LibreOffice** (~1GB) | Install on demand |

Only Tier 1 is guaranteed present. Tiers 2 and 3 pull large system
dependencies that are **deliberately not baked into the daemon image** —
install them yourself, only when the actual input requires it (see
below). Do not assume they are already installed.

## Tier 1 — PDF (default, ready to use)

`lit` is available on the daemon. Sanity-check once, quietly:

```bash
command -v lit && lit --version    # baked into the image
```

If (and only if) it is somehow missing, install the package locally — it
is ~38MB with the OCR/render binaries bundled and installs in a few
seconds:

```bash
npm i @llamaindex/liteparse && npx lit --version
```

> Do **not** rely on the CLI "self-installing on first use" — that path
> is unreliable (npm permission / cache conflicts). Either it is baked
> in, or you install the package explicitly as above.

### Native text path vs OCR — pick deliberately, cost differs ~10×

- **Digital PDF (has an embedded text layer): use `--no-ocr`.** PDFium
  extracts the text directly — **near-instant (~0.35s/page)**, no OCR.
  This is the fast, cheap path; prefer it whenever the PDF is
  computer-generated.
- **Scanned / image-only PDF: leave OCR on (default).** The bundled
  Tesseract OCRs each page — **~5s/page**, an order of magnitude slower.
  Only pay this when there is no real text layer.

If unsure which kind you have, run `--no-ocr` first: empty/garbled output
means it's a scan → re-run without `--no-ocr` to OCR it.

```bash
lit parse report.pdf --no-ocr                       # digital PDF → fast native text
lit parse scan.pdf                                   # scanned PDF → bundled OCR
lit parse report.pdf --format markdown -o out.md     # Markdown output to a file
lit parse report.pdf --format json -o out.json       # structured JSON + bounding boxes
lit parse report.pdf --target-pages "1-5,10,15-20"   # page subset (huge speedup on OCR path)
```

`--format` accepts `markdown` (default) or `json` (adds per-block
bounding boxes). Other useful flags: `-o/--output`, `--target-pages
"1-5,10"`, `--dpi <n>` (render DPI, default 150 — bump to 300 for small
scanned text), `--ocr-language eng+chi_sim` (Tesseract lang codes for the
OCR path), `--password '****'` (encrypted PDFs), `-q/--quiet`.

### Page screenshots (for figures/charts text can't capture)

```bash
lit screenshot report.pdf -o ./shots                   # all pages → PNG
lit screenshot report.pdf --target-pages "1,3,5" -o ./shots
lit screenshot report.pdf --dpi 300 -o ./shots         # high-res
```

## Tier 2 — Image files (install ImageMagick on demand)

Parsing standalone image files (PNG/JPG/TIFF/…) needs **ImageMagick**,
which is not in the daemon image. Install it the first time you actually
have an image input:

```bash
apt-get update && apt-get install -y imagemagick   # Debian/Ubuntu (daemon image)
brew install imagemagick                            # macOS (local dev)
lit parse diagram.png --format markdown
```

If ImageMagick can't be installed (no network / no apt), report
`ImageMagick unavailable` and stop — don't fabricate the image's contents.

## Tier 3 — Office documents (install LibreOffice on demand)

DOCX / XLSX / PPTX / ODT conversion needs **LibreOffice (~1GB)**, which is
**intentionally not baked into the daemon image**. Install it only when
you genuinely need to parse an Office file (it's a big download — don't do
it speculatively):

```bash
apt-get update && apt-get install -y libreoffice   # Debian/Ubuntu (daemon image)
brew install --cask libreoffice                     # macOS (local dev)
lit parse deck.pptx --format markdown
```

If LibreOffice can't be installed, say so and ask the user for a PDF
export of the document instead of guessing.

> A shared **cloud parse service for heavy formats** (offloading Office /
> hi-res OCR to a hosted backend so agents don't install 1GB deps) is a
> future TODO — it is **not** running today. Don't route to a cloud OCR
> endpoint.

## Scope — liteparse vs `ingest`

Two skills, clean split by **source location**:

- **`liteparse` (this skill)** — **local files on disk.** PDF / image /
  Office files already on the machine → Markdown / JSON / screenshots,
  fully offline. This is the only local document-parsing path.
- **`ingest` (sibling skill)** — **web URLs and search.** `cloud load` /
  `cloud search` fetch and compress remote pages. `liteparse` cannot
  fetch URLs; if you only have a URL, either `curl -sL <url> -o file`
  then parse the local copy with `liteparse`, or route to `ingest`.

Decision rule: **local file → `liteparse`. Web page / search → `ingest`.**

## Workflow

1. **Locate the file.** Workspace asset → resolve its local path (see the
   `assets` skill). URL-only → `curl -sL <url> -o <name>` first, then
   parse the local copy (or use `ingest`).
2. **Pick the path by input type + kind.**
   - PDF, computer-generated → `lit parse <f> --no-ocr` (fast native).
   - PDF, scanned/image-only → `lit parse <f>` (OCR); set
     `--ocr-language`, bump `--dpi 300` for small text, and use
     `--target-pages` to avoid OCR'ing pages you don't need.
   - Need spatial structure / table coordinates → `--format json`.
   - Need to *see* a chart/figure/signature → `lit screenshot`, then read
     the PNG.
   - Image file → install ImageMagick (Tier 2), then parse.
   - Office file → install LibreOffice (Tier 3), then parse.
3. **Read the result as source of truth.** Base extraction/summary only on
   what `lit` returned. Empty or low-confidence page → say so; never guess.
4. **Deliver products** only when the user requests the parse output as a
   file. Write the requested final file into `$PRISMER_ARTIFACTS_DIR`, then
   explicitly run `cloud deliver <abs-path>` for the current reply or
   `cloud task attach <abs-path>` for a task. Auto-scan is OFF; writing the
   file alone is not delivery. See `office-artifacts` SKILL.md §Delivery contract.

## Output reporting

- After a parse: `Parsed <filename>: <N> pages, format=<markdown|json>,
  path=<native|ocr>` — then answer the user's actual question, citing page
  numbers. Don't dump the whole parsed body into chat unless asked.
- After screenshots: `Rendered <N> page screenshot(s) → <dir>`, then read
  the relevant ones.

## HARD RULE — never claim a parse you didn't run

Forbidden unless `lit` actually ran with exit 0 and produced output:
"parsed the document", "the PDF says…", "extracted the table". If `lit` is
unavailable, a required dependency (ImageMagick / LibreOffice) can't be
installed, or the parse failed, completion text must start with `无法解析
文档 (reason)` / `Cannot parse document (reason)` — do not substitute
guessed content.
