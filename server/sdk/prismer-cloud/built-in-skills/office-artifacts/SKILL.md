---
name: office-artifacts
description: Generate real DOCX, PPTX, XLSX, PDF, CSV files using python-docx / python-pptx / openpyxl / reportlab by writing them into the dispatch artifacts dir, then explicitly deliver each one with `cloud deliver <abs-path>`. Use whenever the user asks for documents, slides, spreadsheets, reports, or PDFs.
---

# Office Artifacts

Produce real binary office files (not markdown-as-PDF) by writing each
one into the **artifacts dir** (`$PRISMER_ARTIFACTS_DIR` /
`<artifacts_dir>` from `<execution_context>`). Prose-only completions are
not valid.

## Delivery contract — explicit, two steps (release202/09 P2)

Delivery is **explicit**. Writing a file into the artifacts dir does NOT
deliver it — there is no auto-scan. You must run **`cloud deliver`** for
every file you want the user to receive.

1. **Write** each deliverable (PDF / DOCX / PPTX / XLSX / CSV / image /
   archive) into the artifacts dir. Drafts / intermediate scratch →
   `$PRISMER_SCRATCH_DIR` (never delivered).
2. **Deliver** it with the absolute path:

   ```bash
   cloud deliver "<artifacts_dir>/report.pdf"
   ```

   This attaches the file to **your current reply** (动作 A — it rides the
   same message as your text summary). Run it once per file. The command
   prints the `assetId` on success.

- **`$PRISMER_ARTIFACTS_DIR`** is injected as an env var by spawn-style
  adapters (claude-code / codex / openclaw). **Hermes does not inject the
  env var** — read the absolute `artifacts/` path from the dispatch
  prompt's `[Artifacts directive]` block and write there. Either way, pass
  the **absolute path** to `cloud deliver`.
- **Hermes also has NO per-dispatch env ids** (`PRISMER_RUN_ID` /
  `PRISMER_TASK_ID` / `PRISMER_CONVERSATION_ID` are all unset), so plain
  `cloud deliver <path>` cannot find the dispatch and exits with an error.
  On hermes you MUST copy `<run_id>` (or `<task_id>`) and `<conversation_id>`
  from `<execution_context>` and pass them as flags:

  ```bash
  # Hermes — ids come from <execution_context>, not env:
  cloud deliver "<artifacts_dir>/report.pdf" --run-id "<run_id>" --conversation-id "<conversation_id>"
  ```

  Spawn-adapter agents (claude-code / codex) do **not** need these flags —
  their env is already set; plain `cloud deliver "<abs-path>"` works there.
- **Sending a file as its OWN message** (动作 B — separate from your reply,
  e.g. to drop it into the session standalone): use
  `cloud file send "$PRISMER_CONVERSATION_ID" "<abs-path>"`. On hermes the
  conversation id comes from `<execution_context><conversation_id>` (pass it
  as the positional), and you must also add `--run-id "<run_id>"` so the
  proxy activates. Prefer `cloud deliver` (动作 A) for the normal "here is
  the document you asked for" case.
- **Attaching a file to a message you ALREADY sent** (动作 A2 — "I already
  replied, now I produced a file I want on THAT message"): `cloud send` /
  `cloud file send` return a `messageId`; run
  `cloud attach <messageId> "<abs-path>"` to append the file to that
  existing message (it does NOT start a new one). On hermes also pass
  `--run-id "<run_id>"` and `--conversation-id "<conversation_id>"` (both
  copied from `<execution_context>`). Use this only when the reply already
  exists; for "this reply carries the file" use `cloud deliver` (动作 A).
- **Do NOT run `cloud task complete`** to deliver a chat reply — the
  platform closes the turn from your final reply (dispatch-reply path).
- **`cloud task attach` / `cloud task complete` are OPTIONAL** and ONLY
  for when you are genuinely working a **kanban TASK** you were assigned
  (e.g. moving a board card to `review` / `done`). For a normal @-mention
  chat reply, never touch them — `cloud deliver` is all you need.
- **Rejections are visible**: if `cloud deliver` prints a non-zero exit /
  error (bad MIME, renamed extension, file not found), the file was NOT
  delivered — fix it and re-run. Do not claim a file you failed to deliver.

## HARD RULE — never claim a file you didn't actually write

Lie-guard (`src/im/ws/handler.ts`) **as of release201/30 §8 is
warn-only telemetry**, not a destructive interceptor — the audit
banner ("CEO 声明已生成文件但未真正落盘") that used to render in
red is removed. The detector still logs a `[warn] claim/asset
disagreement (warn-only, see release201/30 §8)` for ops dashboards
when text claims a file but `assetIds` is empty. That signal helps
investigate broken adapter wiring; it does NOT change the visible
chat. Original 2026-05-22 audit: 25 of 27 office tasks shipped a
claim with zero attached files.

Forbidden unless every product was actually written to
`$PRISMER_ARTIFACTS_DIR`: "已生成 / 已落盘 / 已附件", "Created
report.pdf", "Attached the file", "Generated slides.pptx".

Before claiming a file, **all** must hold:

1. Generator import (`import docx` / `pptx` / `openpyxl` / `reportlab`)
   succeeds.
2. Script ran with exit 0 (no traceback).
3. `ls -lah <artifacts_dir>` (the absolute path from `<execution_context>`)
   shows the file, non-zero size.

If (1)-(3) fail, your reply must start with `无法生成文件
(reason)` / `Cannot produce file (reason)`.

## Runtime baseline (release 201)

Sandbox image bakes `python-docx`, `python-pptx`, `openpyxl`,
`reportlab`, `pandas`, `pillow`, `numpy`, `imageio`, apt `file`. If an
import fails at task time, fail with `module 'X' missing — rebuild
sandbox image`. Do not `pip install` on the fly.

## Resolving the output directory

Your artifacts dir is delivered as an ABSOLUTE path in your prompt's
`<execution_context>` block:

```xml
<execution_context …>
  <artifacts_dir>/home/user/.prismer/workspaces/<ws>/…/tasks/<id>/artifacts</artifacts_dir>
  …
</execution_context>
```

It is also re-stated in the `[Artifacts directive]` block. **Use that exact
absolute path.** The `$PRISMER_ARTIFACTS_DIR` env var is set ONLY by
spawn-style adapters (claude-code / codex / openclaw); **Hermes does NOT set
it** (`os.environ.get("PRISMER_ARTIFACTS_DIR")` returns `None`). Never write to
a relative path, the CWD, or a literal placeholder — copy the `<artifacts_dir>`
value verbatim:

```python
import os
from pathlib import Path
# Paste the absolute path from <execution_context><artifacts_dir> here:
ARTIFACTS_DIR = "/home/user/.prismer/workspaces/.../tasks/.../artifacts"  # ← from <artifacts_dir>
out = Path(os.environ.get("PRISMER_ARTIFACTS_DIR") or ARTIFACTS_DIR)
out.mkdir(parents=True, exist_ok=True)
```

## Generator recipes

```python
# DOCX
from docx import Document
d = Document(); d.add_heading("Report", 0)
d.add_paragraph("Executive summary…"); d.save(out / "report.docx")

# PPTX
from pptx import Presentation
p = Presentation(); s = p.slides.add_slide(p.slide_layouts[0])
s.shapes.title.text = "Deck"; s.placeholders[1].text = "Key message"
p.save(out / "deck.pptx")

# XLSX
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "Model"
ws.append(["Metric", "Value"]); ws.append(["Revenue", 100000])
ws.freeze_panes = "A2"; wb.save(out / "model.xlsx")

# PDF — reportlab (never rename markdown/html to .pdf)
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
c = canvas.Canvas(str(out / "report.pdf"), pagesize=letter)
c.drawString(72, 720, "Report"); c.save()
```

## Validation + delivery

1. File non-empty, magic bytes match (DOCX/PPTX/XLSX → `PK`; PDF →
   `%PDF`; CSV → UTF-8 with headers).
2. Confirm every product landed in the artifacts dir:

```bash
ls -lah <artifacts_dir>   # the absolute path from <execution_context><artifacts_dir>
```

3. **Deliver each file explicitly** (this is the step that actually
   delivers — there is no auto-scan):

```bash
cloud deliver "<artifacts_dir>/report.pdf"
cloud deliver "<artifacts_dir>/deck.pptx"

# On hermes (no env ids) append --run-id / --conversation-id from <execution_context>:
cloud deliver "<artifacts_dir>/report.pdf" --run-id "<run_id>" --conversation-id "<conversation_id>"
```

   Each call attaches the file to your reply (动作 A). Confirm exit 0 and
   the printed `assetId`. Then write your final reply describing what you
   produced. Do NOT run `cloud task attach` / `cloud task complete` for
   chat delivery.

> Working a real kanban TASK (board card), not a chat reply? Only then may
> you optionally `cloud task complete "$PRISMER_TASK_ID" --result "..."` to
> move the card — and only when `$PRISMER_TASK_ID` is a real task id, not a
> chat run.

## Failure mode

Missing library + cannot install → fail with `module 'X' missing` and
list the package. No renamed extensions, no prose-only substitute.
