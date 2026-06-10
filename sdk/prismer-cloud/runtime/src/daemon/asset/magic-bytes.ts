// Magic-bytes content sniffer.
//
// Why: agent_output_policy validates extension + declared mime, but a malicious
// or careless agent can name a markdown file `report.pdf` and call it done.
// The cloud then dutifully stores it as application/pdf and the user downloads
// a "PDF" that won't open. We add a cheap byte-level sniff so the outbox
// watcher catches the mismatch BEFORE upload and the cloud rejects it as a
// second line of defense (2026-05-22, evidence/v20-acceptance/10).
//
// Detection is intentionally narrow — only the high-value binary formats users
// are likely to be misled about (PDF, PNG, JPEG, GIF, ZIP-container, SVG).
// Everything else returns `null` and is allowed through (text formats can be
// validated by extension+ASCII check separately if ever needed).
//
// The detector reads the FIRST 4 KiB of the file; signatures live within the
// first ~16 bytes, the rest is unused capacity that callers can scan with
// other heuristics later.

export type DetectedKind =
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'zip'
  | 'svg'
  | 'html'
  | 'markdown-or-text'
  | 'json'
  | null;

export interface DetectionResult {
  detected: DetectedKind;
  /**
   * Canonical mime for the detected kind. `null` when nothing matched — caller
   * may then choose to accept the declared mime or reject.
   */
  mime: string | null;
}

const PDF_SIG = Buffer.from('%PDF-', 'ascii');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from('GIF87a', 'ascii');
const GIF89 = Buffer.from('GIF89a', 'ascii');
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_SPANNED = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

export function detectMagicBytes(bytes: Buffer): DetectionResult {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (head.length === 0) return { detected: null, mime: null };

  // Binary signatures (cheapest first).
  if (head.length >= PDF_SIG.length && head.subarray(0, PDF_SIG.length).equals(PDF_SIG)) {
    return { detected: 'pdf', mime: 'application/pdf' };
  }
  if (head.length >= PNG_SIG.length && head.subarray(0, PNG_SIG.length).equals(PNG_SIG)) {
    return { detected: 'png', mime: 'image/png' };
  }
  if (head.length >= JPEG_SIG.length && head.subarray(0, JPEG_SIG.length).equals(JPEG_SIG)) {
    return { detected: 'jpeg', mime: 'image/jpeg' };
  }
  if (
    (head.length >= GIF87.length && head.subarray(0, GIF87.length).equals(GIF87)) ||
    (head.length >= GIF89.length && head.subarray(0, GIF89.length).equals(GIF89))
  ) {
    return { detected: 'gif', mime: 'image/gif' };
  }
  if (
    head.length >= 4 &&
    (head.subarray(0, 4).equals(ZIP_LOCAL) ||
      head.subarray(0, 4).equals(ZIP_EMPTY) ||
      head.subarray(0, 4).equals(ZIP_SPANNED))
  ) {
    return { detected: 'zip', mime: 'application/zip' };
  }

  // Heuristic text-ish detection. Decode the head as utf-8 best-effort; we do
  // NOT need full parse — just shape recognition.
  const text = head.toString('utf8');
  const trimmed = text.trimStart();
  if (/^<\?xml[^>]*>\s*<svg[\s>]/i.test(trimmed) || /^<svg[\s>]/i.test(trimmed)) {
    return { detected: 'svg', mime: 'image/svg+xml' };
  }
  if (/^<(!doctype html|html[\s>])/i.test(trimmed)) {
    return { detected: 'html', mime: 'text/html' };
  }
  // Very loose JSON detect: starts with `{` or `[` and we can find a matching
  // top-level structure character in the head. Not strict — only used to
  // confirm declared mime, not to reject.
  if (/^[{[]/.test(trimmed)) {
    return { detected: 'json', mime: 'application/json' };
  }
  // Plain text / markdown fallback when bytes are mostly printable ASCII.
  if (looksLikePrintableText(head)) {
    return { detected: 'markdown-or-text', mime: 'text/plain' };
  }
  return { detected: null, mime: null };
}

/**
 * Compare detected vs declared mime. Returns `null` when consistent (declared
 * is acceptable for the detected family), or a string explaining the mismatch
 * when the declared mime contradicts the bytes.
 *
 * `null` is also returned when detection produced no opinion (`detected ===
 * null`) — caller may then trust the declared mime.
 *
 * Rules:
 *  - PDF bytes MUST be declared as application/pdf (or null/octet-stream).
 *  - PNG / JPEG / GIF bytes MUST match image/* of the same subtype.
 *  - ZIP bytes are accepted for any application/* (zip, docx, xlsx, pptx all
 *    share the ZIP container).
 *  - SVG bytes are accepted for image/svg+xml or text/*.
 *  - HTML/text/markdown/JSON bytes are accepted for text/* and the matching
 *    application/json declaration.
 *  - When the agent declared `application/pdf` but bytes were text/markdown,
 *    that is the canonical mismatch we want to catch.
 */
// v2.0 BLOCKER 4 — ZIP-derived mime types where the on-disk bytes legitimately
// look like ZIP. Anything outside this set declaring ZIP bytes is a fraud
// (e.g. ZIP bytes claimed as application/pdf).
const ZIP_DERIVED_MIMES = new Set<string>([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
  'application/java-archive',
]);

export function mimeMismatchReason(
  detected: DetectionResult,
  declared: string | null | undefined,
): string | null {
  if (detected.detected === null) return null;
  const dec = (declared ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (!dec || dec === 'application/octet-stream') return null;
  switch (detected.detected) {
    case 'pdf':
      return dec === 'application/pdf' ? null : `declared ${dec} but content is application/pdf`;
    case 'png':
      return dec === 'image/png' ? null : `declared ${dec} but content is image/png`;
    case 'jpeg':
      return dec === 'image/jpeg' || dec === 'image/jpg' ? null : `declared ${dec} but content is image/jpeg`;
    case 'gif':
      return dec === 'image/gif' ? null : `declared ${dec} but content is image/gif`;
    case 'zip':
      // v2.0 BLOCKER 4 fix — ZIP bytes are ONLY acceptable for declared
      // ZIP-derived formats (docx/xlsx/pptx/odt/zip/jar/epub). Previously
      // any application/* declaration was accepted, letting ZIP-as-PDF through.
      if (ZIP_DERIVED_MIMES.has(dec)) return null;
      return `declared ${dec} but content is a ZIP-container (application/zip family)`;
    case 'svg':
      if (dec === 'image/svg+xml' || dec.startsWith('text/')) return null;
      return `declared ${dec} but content is image/svg+xml`;
    case 'html':
      if (dec === 'text/html' || dec === 'application/xhtml+xml' || dec.startsWith('text/')) return null;
      // Declared pdf/png/etc but bytes are HTML — clear lie.
      if (dec === 'application/pdf' || dec.startsWith('image/') || dec === 'application/zip') {
        return `declared ${dec} but content is text/html`;
      }
      return null;
    case 'json':
      if (dec === 'application/json' || dec.startsWith('text/')) return null;
      if (dec === 'application/pdf' || dec.startsWith('image/') || dec === 'application/zip') {
        return `declared ${dec} but content is application/json`;
      }
      return null;
    case 'markdown-or-text':
      // Text bytes declared as a binary format = the canonical .pdf-but-actually-md fraud.
      if (dec === 'application/pdf' || dec.startsWith('image/') || dec === 'application/zip') {
        return `declared ${dec} but content is text (not a real ${dec} payload)`;
      }
      return null;
    default:
      return null;
  }
}

function looksLikePrintableText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let printable = 0;
  let total = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    // null byte = strong binary signal
    if (b === 0x00) return false;
    total++;
    if (
      (b >= 0x20 && b <= 0x7e) ||
      b === 0x09 ||
      b === 0x0a ||
      b === 0x0d ||
      // utf-8 lead bytes
      b >= 0x80
    ) {
      printable++;
    }
  }
  return total > 0 && printable / total >= 0.95;
}
