---
name: document-generation
scope: common
description: Generate Word/PDF documents with correct CJK fonts (no tofu boxes). Industry-standard font semantics — 宋体/黑体/SimSun/Times New Roman resolve to the Noto CJK faces installed in the image via fontconfig aliases. Use whenever the task produces a .docx, .pdf, or rendered document containing Chinese/Japanese/Korean text.
---

# Document Generation (Word / PDF, CJK-safe)

The image ships `python-docx` + `reportlab` and the full Noto CJK family
(Sans + Serif, .ttc). Font semantics are handled by
`/etc/fonts/conf.d/99-cjk-semantics.conf` — renderers resolve conventional
Chinese font names to the right Noto face automatically. Do NOT install extra
font packages; use the mapping below.

## Font semantics (industry-standard mapping)

| Scenario | Conventional name | Resolves to (image) |
| --- | --- | --- |
| 官文/学术正文（宋体等效） | 宋体 / SimSun / Times New Roman | **Noto Serif CJK SC** |
| 标题/正文（黑体等效） | 黑体 / SimHei | **Noto Sans CJK SC** |
| 楷体（无开源 Noto 楷体，Serif 兜底） | 楷体 / KaiTi / 仿宋 | Noto Serif CJK SC |
| 代码/等宽 | Courier New / Monospace | DejaVu Sans Mono + Noto fallback |

Rule of thumb: **serif (Noto Serif CJK SC) for official/academic documents,
sans (Noto Sans CJK SC) for UI/headings** — same convention as Times New Roman
vs Arial in Western docs.

## Word (.docx) — python-docx

Word stores font *names*, not glyphs — the rendering machine resolves them.
Two cases:

**A. User opens the docx on their desktop (Word/WPS has 宋体/SimSun)** — write
conventional names so it renders correctly on THEIR machine:

```python
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
# set east-asian font properly (both ascii + eastAsia, or Word ignores it):
style = doc.styles['Normal']
style.font.name = 'Times New Roman'          # ascii
style.font.size = Pt(12)
style.element.rPr.rFonts.set('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia', '宋体')
p = doc.add_paragraph('中文正文——宋体五号')
doc.save('/workspace/output.docx')
```

**B. The sandbox itself must render/convert the docx to PDF** — use Noto names
so fontconfig resolves locally (LibreOffice may not be installed; prefer
generating PDF directly with reportlab instead of converting).

## PDF — weasyprint (HTML→PDF, PREFERRED — industry standard for CJK)

**reportlab cannot render Noto CJK** (CFF/PostScript outlines — a reportlab
limitation, verified 2026-08-07). The industry-standard CJK PDF path is
**HTML/CSS → weasyprint**: CSS font-family resolves via fontconfig, the
aliases make conventional names work directly, and it ships in the image.

```python
from weasyprint import HTML

html = '''<html><head><style>
  body { font-family: '宋体', 'Noto Serif CJK SC', serif; font-size: 12pt; }
  h1   { font-family: '黑体', 'Noto Sans CJK SC', sans-serif; }
  code { font-family: 'Courier New', monospace; }
</style></head><body>
<h1>中文标题——黑体</h1>
<p>中文正文——宋体等效。混合 ASCII text works too.</p>
</body></html>'''
HTML(string=html).write_pdf('/workspace/output.pdf')
```

pandoc is also present — `pandoc input.md -o output.pdf
--pdf-engine=weasyprint` is a valid markdown→PDF pipeline.

## PDF — reportlab (programmatic; ASCII/Latin only for CJK)

reportlab 5.0 rejects Noto CJK .ttc files (`postscript outlines are not
supported` — CFF outlines). Use reportlab only for Latin/ASCII documents, or
for PDFs whose text never contains CJK. For CJK content use weasyprint above.

```html
<style>
  body { font-family: '宋体', 'Noto Serif CJK SC', serif; font-size: 12pt; }
  h1   { font-family: '黑体', 'Noto Sans CJK SC', sans-serif; }
</style>
```

## Verification

```bash
fc-match '宋体'     # → Noto Serif CJK SC (alias working)
fc-match '黑体'     # → Noto Sans CJK SC
fc-list | grep -c 'Noto.*CJK'   # faces present
```

## Output contract

- Deliver the file as a task asset (`cloud file send` / attach) — never paste
  document content as chat text.
- Verify the PDF opens (pdfplumber is installed) and contains the expected
  Chinese text — tofu boxes are a FAIL, not a delivery.
