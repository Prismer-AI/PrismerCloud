import { prisma } from '@/lib/prisma';
import { sanitizeHtml } from '@/lib/sanitize';

const GENE_REF_REGEX = /\[\[gene:([a-zA-Z0-9_-]+)\]\]/g;
const SKILL_REF_REGEX = /\[\[skill:([a-zA-Z0-9_-]+)\]\]/g;

/**
 * Resolve [[gene:slug]] references — look up gene by title/slug pattern.
 * Returns HTML placeholder: <span class="gene-embed" data-gene-slug="xxx"></span>
 */
async function resolveGeneRefs(content: string): Promise<string> {
  const matches = [...content.matchAll(GENE_REF_REGEX)];
  if (matches.length === 0) return content;

  let result = content;
  for (const match of matches) {
    const slug = match[1];
    const gene = await prisma.iMGene.findFirst({
      where: {
        OR: [
          { title: { contains: slug.replace(/-/g, ' ') } },
          { id: slug },
        ],
      },
      select: { id: true, title: true },
    });

    if (gene) {
      result = result.replace(
        match[0],
        `<span class="gene-embed" data-gene-id="${gene.id}" data-gene-slug="${slug}">${gene.title}</span>`
      );
    } else {
      result = result.replace(
        match[0],
        `<span class="gene-embed gene-embed--unresolved" data-gene-slug="${slug}">${slug}</span>`
      );
    }
  }
  return result;
}

/**
 * Resolve [[skill:slug]] references.
 */
async function resolveSkillRefs(content: string): Promise<string> {
  const matches = [...content.matchAll(SKILL_REF_REGEX)];
  if (matches.length === 0) return content;

  let result = content;
  for (const match of matches) {
    const slug = match[1];
    const skill = await prisma.iMSkill.findFirst({
      where: {
        OR: [{ slug }, { name: { contains: slug.replace(/-/g, ' ') } }],
      },
      select: { id: true, name: true, slug: true },
    });

    if (skill) {
      result = result.replace(
        match[0],
        `<span class="skill-embed" data-skill-id="${skill.id}" data-skill-slug="${skill.slug}">${skill.name}</span>`
      );
    } else {
      result = result.replace(
        match[0],
        `<span class="skill-embed skill-embed--unresolved" data-skill-slug="${slug}">${slug}</span>`
      );
    }
  }
  return result;
}

/**
 * Convert a block of markdown table lines into an HTML <table>.
 */
function convertTable(lines: string[]): string {
  const parseRow = (line: string) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const headerCells = parseRow(lines[0]);
  const alignRow = parseRow(lines[1]);
  const aligns = alignRow.map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });

  let html = '<table><thead><tr>';
  for (let i = 0; i < headerCells.length; i++) {
    html += `<th style="text-align:${aligns[i] ?? 'left'}">${headerCells[i]}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let r = 2; r < lines.length; r++) {
    const cells = parseRow(lines[r]);
    html += '<tr>';
    for (let i = 0; i < headerCells.length; i++) {
      html += `<td style="text-align:${aligns[i] ?? 'left'}">${cells[i] ?? ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/**
 * Convert consecutive list lines (- / * / 1.) into <ul>/<ol>.
 */
function convertList(lines: string[]): string {
  const ordered = /^\d+\.\s/.test(lines[0]);
  const tag = ordered ? 'ol' : 'ul';
  const items = lines.map((l) => {
    const text = l.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
    return `<li>${text}</li>`;
  });
  return `<${tag}>${items.join('')}</${tag}>`;
}

/**
 * Simple Markdown to HTML converter for community content.
 * Handles: headings, bold/italic/strikethrough, inline code, fenced code blocks,
 * links, images, blockquotes, horizontal rules, tables, and lists.
 */
function markdownToHtml(md: string): string {
  let html = md;

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, '<hr />');

  const rawLines = html.split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];

    if (/^\|.+\|/.test(line) && i + 1 < rawLines.length && /^\|[\s:|-]+\|/.test(rawLines[i + 1])) {
      const tableLines: string[] = [line];
      i++;
      while (i < rawLines.length && /^\|.+\|/.test(rawLines[i])) {
        tableLines.push(rawLines[i]);
        i++;
      }
      blocks.push(convertTable(tableLines));
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const listLines: string[] = [line];
      i++;
      while (i < rawLines.length && /^[-*]\s+/.test(rawLines[i])) {
        listLines.push(rawLines[i]);
        i++;
      }
      blocks.push(convertList(listLines));
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const listLines: string[] = [line];
      i++;
      while (i < rawLines.length && /^\d+\.\s+/.test(rawLines[i])) {
        listLines.push(rawLines[i]);
        i++;
      }
      blocks.push(convertList(listLines));
      continue;
    }

    blocks.push(line);
    i++;
  }

  html = blocks.join('\n');

  html = html
    .split(/\n\n+/)
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<blockquote') ||
        trimmed.startsWith('<hr') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol') ||
        trimmed.startsWith('<table')
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br />')}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  return html;
}

/**
 * Process community content: resolve references + convert markdown + sanitize.
 * Called on post/comment create and update.
 */
export async function renderCommunityContent(markdown: string): Promise<string> {
  let content = markdown;

  content = await resolveGeneRefs(content);
  content = await resolveSkillRefs(content);

  content = markdownToHtml(content);

  content = sanitizeHtml(content);

  return content;
}

/**
 * Search for Gene/Skill names matching a prefix (for editor autocomplete).
 */
export async function searchGeneNames(
  prefix: string,
  limit = 10
): Promise<Array<{ id: string; title: string }>> {
  return prisma.iMGene.findMany({
    where: { title: { contains: prefix } },
    select: { id: true, title: true },
    take: limit,
    orderBy: { createdAt: 'desc' },
  });
}

export async function searchSkillNames(
  prefix: string,
  limit = 10
): Promise<Array<{ id: string; name: string; slug: string }>> {
  return prisma.iMSkill.findMany({
    where: {
      OR: [{ name: { contains: prefix } }, { slug: { contains: prefix } }],
    },
    select: { id: true, name: true, slug: true },
    take: limit,
    orderBy: { createdAt: 'desc' },
  });
}
