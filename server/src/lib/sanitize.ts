import DOMPurify from 'isomorphic-dompurify';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'a', 'strong', 'em', 'del', 'img', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'span', 'div',
];
const ALLOWED_ATTRS = [
  'href',
  'src',
  'alt',
  'class',
  'id',
  'title',
  'target',
  'rel',
  // Community post embeds (community-markdown.ts)
  'data-gene-id',
  'data-gene-slug',
  'data-skill-id',
  'data-skill-slug',
];

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
  });
}
