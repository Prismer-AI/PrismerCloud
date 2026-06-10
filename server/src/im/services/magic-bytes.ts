// Cloud-side magic-bytes content sniffer for asset upload.
//
// Parallel implementation of the daemon-side detector at
// `sdk/prismer-cloud/runtime/src/daemon/asset/magic-bytes.ts`. We can't
// import from the SDK tree because the cloud uses a separate tsconfig and
// path roots — keeping a tight in-process copy here. Logic MUST stay in
// sync with the SDK copy; if either grows new detections, mirror them.
//
// Why this exists separately from `validateAgentOutputAsset` (extension+mime
// policy): policy validates the FILE NAME, not the bytes. An agent that
// names markdown bytes `report.pdf` and declares mime `application/pdf`
// passes the policy and ends up stored as a corrupt PDF. The cloud is the
// last gate before persistence, so we sniff the head bytes here as a
// defense-in-depth check on top of the daemon-side guard (2026-05-22,
// evidence/v20-acceptance/10).

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

  const text = head.toString('utf8');
  const trimmed = text.trimStart();
  if (/^<\?xml[^>]*>\s*<svg[\s>]/i.test(trimmed) || /^<svg[\s>]/i.test(trimmed)) {
    return { detected: 'svg', mime: 'image/svg+xml' };
  }
  if (/^<(!doctype html|html[\s>])/i.test(trimmed)) {
    return { detected: 'html', mime: 'text/html' };
  }
  if (/^[{[]/.test(trimmed)) {
    return { detected: 'json', mime: 'application/json' };
  }
  if (looksLikePrintableText(head)) {
    return { detected: 'markdown-or-text', mime: 'text/plain' };
  }
  return { detected: null, mime: null };
}

// v2.0 BLOCKER 4 — ZIP-derived mime types where the on-disk bytes legitimately
// look like ZIP. Anything outside this set declaring ZIP bytes is a fraud.
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
      // v2.0 BLOCKER 4 fix — only allow ZIP bytes when declared mime is
      // actually a ZIP-derived format. Previously `application/*` blanket
      // pass let ZIP-as-PDF through.
      if (ZIP_DERIVED_MIMES.has(dec)) return null;
      return `declared ${dec} but content is a ZIP-container (application/zip family)`;
    case 'svg':
      if (dec === 'image/svg+xml' || dec.startsWith('text/')) return null;
      return `declared ${dec} but content is image/svg+xml`;
    case 'html':
      if (dec === 'text/html' || dec === 'application/xhtml+xml' || dec.startsWith('text/')) return null;
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
    if (b === 0x00) return false;
    total++;
    if (
      (b >= 0x20 && b <= 0x7e) ||
      b === 0x09 ||
      b === 0x0a ||
      b === 0x0d ||
      b >= 0x80
    ) {
      printable++;
    }
  }
  return total > 0 && printable / total >= 0.95;
}
