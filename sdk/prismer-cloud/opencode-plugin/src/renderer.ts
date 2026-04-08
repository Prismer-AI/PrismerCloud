// Inlined from MCP renderers.ts (shared @prismer/renderer package in v1.8.1)

export interface LocalFile {
  relativePath: string;
  content: string;
  meta: { sourceSlot: string; sourceId: string; scope: string; checksum: string };
}

interface GeneStrategy {
  gene: { id: string; title?: string; description?: string; strategy?: string | string[]; signals_match?: Array<{ type: string }>; preconditions?: string | string[] };
  skillSlug?: string;
  successRate: number;
  executions: number;
}

interface WorkspaceView {
  scope: string;
  strategies?: GeneStrategy[];
}

function slugify(id: string): string {
  return id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function safeParseJson(val: unknown, fallback: string[]): string[] {
  if (Array.isArray(val)) return val;
  try { return JSON.parse((val as string) || '[]'); } catch { return fallback; }
}

function renderGeneAsSkillMd(strategy: GeneStrategy): string {
  const gene = strategy.gene;
  const slug = strategy.skillSlug || slugify(gene.title || gene.id);

  const fm = `name: ${slug}\ndescription: ${truncate(gene.description || gene.title || slug, 250)}`;

  const steps = safeParseJson(gene.strategy, []);
  const signals = (gene.signals_match || []).map(s => s.type).join(', ');
  const preconditions = safeParseJson(gene.preconditions, []);

  let body = `# ${gene.title || gene.id}\n\n`;
  if (gene.description) body += `${gene.description}\n\n`;
  if (steps.length) body += `## Strategy\n\n${steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}\n\n`;
  if (signals) body += `## Signals\n\nTriggers on: ${signals}\n\n`;
  if (preconditions.length) body += `## Preconditions\n\n${preconditions.map((p: string) => `- ${p}`).join('\n')}\n\n`;
  body += `---\n*Prismer Evolution Gene \`${gene.id}\` | ${Math.round(strategy.successRate * 100)}% success | ${strategy.executions} runs*\n`;

  return `---\n${fm}\n---\n\n${body}`;
}

export function renderForOpenCode(workspace: WorkspaceView): LocalFile[] {
  const files: LocalFile[] = [];
  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s);
    files.push({
      relativePath: `skills/${slug}/SKILL.md`,
      content,
      meta: { sourceSlot: 'strategies', sourceId: s.gene.id, scope: workspace.scope, checksum: simpleHash(content) },
    });
  }
  return files;
}
