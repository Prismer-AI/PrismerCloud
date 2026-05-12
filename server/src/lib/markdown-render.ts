/**
 * Markdown → HTML render pipeline for memory pages (M-D, doc 25 §4).
 *
 * Important: HTML is an INDEPENDENT source on `IMMemoryPage.contentHtml`.
 * This module is **only** used by the backfill cron (`scripts/ops/
 * backfill-memory-html.ts`) to bridge historical rows that have markdown
 * content but no HTML version yet, and to upgrade rows whose
 * `contentHtmlVersion` is stale (less than `MARKDOWN_RENDER_VERSION`).
 *
 * It is intentionally NOT wired into `memory-write.service.ts` /
 * `memory-page.service.ts` write paths. Markdown writes leave `contentHtml`
 * alone so that user / agent edits in the rich-text editor are never
 * clobbered by an automatic re-render. See
 * `feedback_memory_html_independent_source.md` (claude memory) and
 * `docs/cookbook/m-memory-html-independent-source.md` for the spec.
 *
 * Pipeline:
 *   markdown → remark-parse → remark-gfm → remark-rehype (no raw HTML) →
 *   rehype-sanitize (default GitHub-style schema) → rehype-stringify
 *
 * The `allowDangerousHtml: false` setting in `remark-rehype` blocks raw
 * HTML pass-through from markdown source, and `rehype-sanitize` enforces
 * a strict schema on the AST regardless. Together they make script tags,
 * event-handler attributes, and `javascript:` URLs unrepresentable in the
 * output.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

/**
 * Pipeline version. Bumped when the pipeline (plugins, schema, options)
 * changes in a way that should trigger backfill re-render of pages whose
 * `contentHtmlVersion` is below this value.
 *
 * Convention: rows with `contentHtmlVersion = 0` are user-authored (or
 * agent-authored via the dedicated HTML write surface) — backfill cron
 * MUST skip these regardless of the version number, because they are
 * not derived from markdown.
 */
export const MARKDOWN_RENDER_VERSION = 1;

/**
 * Sanitize schema. Inherits the GitHub-flavored default from
 * `rehype-sanitize` and adds nothing — we deliberately stay tight here.
 * If a future memory feature needs additional tag/attribute support
 * (e.g. callout admonitions, custom data-* attributes for cross-page
 * widgets), extend this schema and bump `MARKDOWN_RENDER_VERSION` so
 * the backfill cron re-renders historical rows.
 */
const SANITIZE_SCHEMA = defaultSchema;

const PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, SANITIZE_SCHEMA)
  .use(rehypeStringify);

/**
 * Render a markdown string to a sanitized HTML string.
 *
 * - Pure / synchronous: the underlying `unified().processSync` is fully
 *   synchronous when the plugin chain has no async transforms, which is
 *   the case for the M-D pipeline. Backfill cron processes one row at a
 *   time and doesn't benefit from async, and the production hot path
 *   doesn't call this at all.
 * - Returns `''` on empty input. Never throws on well-formed strings;
 *   the only realistic failure mode is the parser running out of memory
 *   on absurdly large inputs, which is bounded upstream by the 64KB
 *   memory-page content limit (`MAX_CONTENT_BYTES` in
 *   `memory-write.service.ts`).
 */
export function renderMemoryMarkdownToHtml(markdown: string): string {
  if (!markdown) return '';
  return String(PROCESSOR.processSync(markdown));
}
