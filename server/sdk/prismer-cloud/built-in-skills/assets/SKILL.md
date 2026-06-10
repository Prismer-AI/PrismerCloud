---
name: assets
description: Locate, inspect, and read content-addressed workspace assets — search by filename/metadata, describe before reading bytes, then read bounded ranges. Use whenever the user references an uploaded file, when you need to cite file evidence, or when a task input/output is an asset URI. Executes via the `cloud asset` CLI and tools.
---

# Assets

Workspace assets are **content-addressed** (SHA-256). Each asset has a stable URI, MIME type, size, and metadata. Treat assets as **opaque bytes you must search → describe → read** in that order. Don't claim you read a file unless a CLI call actually returned its content.

## When to use

- The user references a file by name, path, or `prismer://...` URI and you need its content.
- A task description includes asset attachments — find them, inspect them, decide if you need to read bytes.
- You're answering a question that requires citing file evidence (extract text, quote a paragraph, summarize a doc).
- You need to find a file by hash, filename, or content keyword.

## CLI Reference

### Search

```bash
cloud asset list                                          # everything in current workspace
cloud asset list --limit 20 --kind file
cloud asset list --filename "design-doc*"                 # filename glob
cloud asset list --mime "application/pdf"                 # by MIME
cloud asset list --updated-after "2026-05-01"             # recency
cloud asset by-hash <sha256>                              # exact content lookup
```

### Describe (metadata only, no bytes)

```bash
cloud asset get <assetId>                                 # full metadata, no content
# OR for in-process MCP tools (when daemon exposes them):
#   prismer.asset.describe { uri | assetId | contentHash }
```

### Read (bounded ranges only)

```bash
cloud asset download <assetId> --out ./local-copy         # whole file to disk
cloud asset download <assetId> --offset 0 --length 4096   # first 4 KB
# For LLM-friendly text extraction:
cloud asset read <assetId> --offset 0 --length 4096       # text range read
cloud asset read <assetId> --as-text                      # full text (for small text-like assets)
```

### Upload / Sync

```bash
cloud asset upload ./report.pdf                           # → asset record + content hash
cloud asset upload ./report.pdf --conversation-id <id>    # pin to conversation
cloud asset sync                                          # refresh local cache index
```

## Workflow

1. **Search first** — use `cloud asset list` with filename / MIME / hash filters unless the user gave you an exact ID or URI.
2. **Describe before reading bytes** — `cloud asset get <id>` to confirm MIME, size, and that this is the right file.
3. **Read bounded ranges** — `--offset` + `--length`. Start with a small range (4 KB) to identify encoding/structure, then expand only if needed.
4. **Preserve the locator** — record the asset ID, content hash, and URI in your reply so the user can follow up.

## Operating Rules

### Search

- Don't guess asset identifiers when `asset list` can locate them. Filename + size + workspace = usually unique.
- Prefer **exact** filters (hash, full filename, MIME) over broad terms.
- Content search is **best-effort for text-like assets only**. PDFs, images, binaries won't match content queries — search by metadata.
- Use a small `--limit` for targeted lookups; expand only when the first batch misses.

### Describe

- **Always describe before reading.** Metadata tells you whether reading is safe (text vs binary, size, encoding).
- Don't treat metadata as proof of file contents — title and MIME can lie. The content hash is the only authoritative identity.
- If multiple locators disagree (e.g. filename matches two assets with different hashes), **stop and re-search** rather than reading the wrong file.
- Avoid reading binary or image-heavy assets directly. For images, use `cloud parse` (OCR) or a vision-capable downstream tool; for PDFs, use `cloud parse`.

### Read

- **Never load an entire large file** — `--length` caps reads. Start at 4 KB, expand only when the answer requires it.
- Byte offsets don't align to line or character boundaries in multibyte text — handle the partial-token edge at the read boundary.
- Watch the `truncated` flag in the response. If set, plan additional reads or tell the user the answer is based on a partial read.
- Report partial reads explicitly when drawing conclusions from excerpts ("based on the first 8 KB of `<filename>`...").

### Cite

- When citing file evidence, **include the asset ID/URI and the locator** (offset + length, page number, or hash). The user needs to be able to follow up.
- Never claim you read an asset unless a CLI/tool call **succeeded** with content in the response. Hallucinated reads are the #1 trust failure.

## Output reporting

After search: list matches with `<assetId> <filename> <mime> <sizeBytes>`. If 0 matches, say so and suggest broader filters.

After describe: surface MIME, size, and any structured metadata fields relevant to the user's question (page count for PDFs, dimensions for images, etc.).

After read: include the asset locator + range + content. If `truncated: true`, say "(partial — read X of Y bytes)".

## ContentBlock output (v2.0 §4.6 / Gap E-⑤)

When this skill resolves an **image** asset for downstream rendering, emit a
ContentBlock pointing at the asset id rather than inlining bytes or a
pre-signed URL into prose:

```json
{ "kind": "image", "assetId": "<assetId>", "mediaType": "image/png", "alt": "<one-line desc>" }
```

When it resolves a **file** asset (PDF, CSV, archive) the reply should include
the asset as an attachment (auto-handled by writing into
`$PRISMER_ARTIFACTS_DIR` — daemon's artifacts-watcher scans the dispatch's
`artifacts/` dir and auto-archives + attaches per release201/30 §4 — or
explicitly as):

```json
{ "kind": "file", "assetId": "<assetId>", "mediaType": "application/pdf", "filename": "<original>" }
```

Do NOT paste raw bytes or `data:` URIs into the reply body — they bypass the
content-addressed store, defeat caching, and make follow-up retrieval
impossible. The chat renderer reads ContentBlock attachments and surfaces
them as previews automatically.

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `asset-search`, `asset-describe`, `asset-read`.

Implements Gap E-⑤ (built-in skill multimodal output) for the asset family —
`assets.describe` / `assets.read` outputs flow through dispatch reply
attachments (`AgentDispatchReplyPayload.attachments` typed as `{kind, assetId}`
which maps to ContentBlock at chat-render time).
