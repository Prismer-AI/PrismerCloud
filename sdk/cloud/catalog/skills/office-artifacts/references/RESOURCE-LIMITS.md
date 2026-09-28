# Imported resource execution contract

Use absolute script paths relative to the chosen format GUIDE.md directory.
Never install packages into the shared runtime merely because an upstream guide
includes an installation command. Reopen outputs and inspect rendered pages before
claiming visual correctness; the parent office-artifacts delivery contract applies.

## Runtime tiers

- Core DOCX: Python 3.10+, python-docx and lxml. Accepted text includes insertions
  and excludes deletions/moveFrom. Structural/table/property revisions remain
  unresolved: this is not a full Word revision engine or OOXML XSD validator.
- Core PDF: pypdf (flatten tested on 6.x), reportlab, Pillow and pdfplumber where
  the chosen helper imports it. Flatten needs pypdf's `flatten=True` field update;
  older versions fail before output rather than label an interactive file flat.
  AES requires cryptography. Rendering uses pypdfium2 or Poppler, with a 120-second
  subprocess bound and DPI 1..600. Native renderer memory is still a sandbox concern.
- PDF creation: JSON `font_file` selects a local TrueType font with verified glyph
  coverage. Non-WinAnsi content without it is rejected before output. Font licensing
  and embedding rights belong to the supplied font. Bold/italic currently use the
  supplied font face; use a custom recipe for separate style faces. CFF collections
  are not supported by this helper. Render CJK output to verify layout.
- Optional PyMuPDF: pymupdf; Markdown adds pymupdf4llm; tables add pandas/tabulate.
  Its page selection is ZERO-based, unlike the other PDF helper CLIs (ONE-based).
  PyMuPDF has separate AGPL/commercial licensing, not the resource's MIT grant.
- Optional Marker: marker-pdf/model downloads and its separate model/library
  licensing, storage and accelerator budget. Output adapter is fixture-tested,
  not proof that model inference or arbitrary installed versions work.
- Core XLSX: openpyxl. Formula rewrite uses tokens, including whole-row/column
  references; structured/external references are preserved. Partial deletion of
  table columns and header-only deletion fail before saving because dependent
  structured formulas cannot yet be rewritten. Column insertion updates table
  columns, header names and filter indices. Charts/images, validation formulas,
  conditional-format rule formulas and table calculated-column formulas are not
  automatically repaired; rebuild/review them before delivery. CSV formulas are
  always literal imported data, including under type inference.
- Core PPTX: python-pptx/Pillow. Grouped text is supported; copying slides with
  nested charts is rejected. Rendering requires LibreOffice and Poppler, uses a
  private profile/work directory and returns only this invocation's pages. Existing
  unrelated images in the destination are not a render result. Recalculation of
  spreadsheets also requires LibreOffice; openpyxl alone does not calculate cells.

Input files are untrusted data. Native parsers/models should run in a bounded
task sandbox. No helper confers remote write permissions or installs a scheduler.
