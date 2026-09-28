// memory202/09 P0 — section-level (anchor) granularity, pure helpers (daemon).
//
// Doc: docs/memory202/09-section-level-granularity.md §2.2, §10, §11.
//
// MIRROR of cloud `src/im/services/memory-section.ts`. The daemon is an
// independent npm project and cannot import `src/im`, so this logic is
// duplicated rather than shared. Any change to `headingToSlug` / `sliceSection`
// semantics MUST be applied to BOTH files so slug rules stay consistent across
// the cloud <-> daemon boundary.
//
// HEADING DETECTION (memory202/09 P3): the cloud copy detects headings via the
// remark AST (shared with the HTML render). The daemon cannot pull remark into
// the agent-rt pod bundle, so it uses a FENCE-AWARE line scanner: `#` lines
// inside ``` / ~~~ fenced code blocks are NOT treated as headings — matching the
// cloud AST for the common case (shell comments / markdown examples in code
// fences). Setext (`===`/`---`) headings are NOT recognised by the daemon scanner;
// a recall addressing a setext-only section just falls back to the whole page
// (graceful, never wrong) — agents author ATX `#` headings in practice.

/**
 * Canonical heading-text -> anchor slug. See cloud copy for the rule.
 * CJK preserved: `## 部署流程` -> `部署流程`.
 */
export function headingToSlug(heading: string): string {
  const collapsed = heading.replace(/^#+\s*/, '').trim().toLowerCase().replace(/\s+/g, '-');
  let out = '';
  for (const ch of collapsed) {
    if (ch === '-' || /[a-z0-9]/.test(ch) || ch.charCodeAt(0) > 127) out += ch;
  }
  return out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Slice the markdown sub-section addressed by `anchor` out of `content`.
 * Heading line + nested deeper sub-sections, up to the next same/higher heading.
 * Returns `null` when no heading matches (caller falls back to whole page).
 */
/**
 * Scan markdown lines for ATX headings, skipping any inside fenced code blocks
 * (``` or ~~~). A fence opens on the first ```/~~~ run and closes on the next run
 * of the SAME char; `#` lines in between are code, not headings — mirroring the
 * cloud remark AST. Returns headings in document order.
 */
function scanHeadings(lines: string[]): Array<{ lineIdx: number; level: number; text: string }> {
  const out: Array<{ lineIdx: number; level: number; text: string }> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fm) {
      const ch = (fm[1] ?? '')[0] ?? '';
      if (fence === null) fence = ch;
      else if (ch === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ lineIdx: i, level: (m[1] ?? '').length, text: (m[2] ?? '').trim() });
  }
  return out;
}

/**
 * memory202 doc 05 §4.2a — fence-aware ATX heading scan, exposed for the
 * INDEX-TOC builder (`index-toc.ts`). Same scanner the recall section-slice path
 * uses, so "what counts as a section" is identical across both. Returns
 * `{ level, text }` in document order; `lineIdx` is dropped (the TOC builder
 * only needs the heading shape, not source positions).
 */
export function scanHeadingsForToc(lines: string[]): Array<{ level: number; text: string }> {
  return scanHeadings(lines).map((h) => ({ level: h.level, text: h.text }));
}

export function sliceSection(content: string, anchor: string): string | null {
  const wanted = headingToSlug(anchor);
  if (!wanted) return null;

  // Memory truth is PKF. The daemon historically scanned markdown only, so
  // `memory_load(uri#section)` silently fell back to the whole page for every
  // canonical `.pkf` page. Keep the local implementation dependency-free but
  // mirror the cloud's declared-id/text matching and complete-wrapper slice.
  if (/application\/prismer\+json|<section\b|<h[1-6]\b[^>]*\bid\s*=/i.test(content)) {
    return slicePkfSection(content, anchor, wanted);
  }

  const lines = content.split('\n');
  const heads = scanHeadings(lines);

  let startHeadIdx = -1;
  for (let k = 0; k < heads.length; k++) {
    if (headingToSlug(heads[k]!.text) === wanted) {
      startHeadIdx = k;
      break;
    }
  }
  if (startHeadIdx < 0) return null;

  const start = heads[startHeadIdx]!;
  let endIdx = lines.length;
  for (let k = startHeadIdx + 1; k < heads.length; k++) {
    if (heads[k]!.level <= start.level) {
      endIdx = heads[k]!.lineIdx;
      break;
    }
  }

  let sliceEnd = endIdx;
  while (sliceEnd > start.lineIdx + 1 && (lines[sliceEnd - 1] ?? '').trim() === '') sliceEnd--;
  return lines.slice(start.lineIdx, sliceEnd).join('\n');
}

function slicePkfSection(content: string, anchor: string, wantedSlug: string): string | null {
  const headingRe = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  const headings: Array<{ level: number; id: string | null; text: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(content)) !== null) {
    const attrs = match[2] ?? '';
    const idMatch = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs);
    headings.push({
      level: Number(match[1]),
      id: idMatch ? idMatch[1]! : null,
      text: (match[3] ?? '').replace(/<[^>]*>/g, '').trim(),
      start: match.index,
    });
  }
  let hitIndex = headings.findIndex((heading) => heading.id === anchor.trim() || heading.id === wantedSlug);
  if (hitIndex < 0) hitIndex = headings.findIndex((heading) => headingToSlug(heading.text) === wantedSlug);
  if (hitIndex < 0) return null;
  const hit = headings[hitIndex]!;

  const sectionTagRe = /<\/?section\b[^>]*>/gi;
  const stack: number[] = [];
  const containing: Array<{ start: number; end: number }> = [];
  let sectionTag: RegExpExecArray | null;
  while ((sectionTag = sectionTagRe.exec(content)) !== null) {
    if (/^<\/section\b/i.test(sectionTag[0])) {
      const start = stack.pop();
      if (start !== undefined) {
        const end = sectionTagRe.lastIndex;
        if (start <= hit.start && hit.start < end) containing.push({ start, end });
      }
    } else {
      stack.push(sectionTag.index);
    }
  }
  if (containing.length > 0) {
    const wrapper = containing.sort((a, b) => b.start - a.start)[0]!;
    return content.slice(wrapper.start, wrapper.end).replace(/\s+$/, '');
  }

  let end = content.length;
  for (let index = hitIndex + 1; index < headings.length; index++) {
    if (headings[index]!.level <= hit.level) {
      end = headings[index]!.start;
      break;
    }
  }
  return content.slice(hit.start, end).replace(/\s+$/, '');
}
