/**
 * ProjectionRenderer (TypeScript) — source of truth.
 * Plugin .mjs version synced manually from this file.
 * v1.8.1 extracts @prismer/renderer shared package.
 */

// ── Types ──

export interface LocalFile {
  relativePath: string;
  content: string;
  meta: {
    sourceSlot: string;
    sourceId: string;
    scope: string;
    checksum: string;
  };
}

export interface GeneStrategy {
  gene: {
    id: string;
    title?: string;
    description?: string;
    strategy?: string | string[];
    signals_match?: Array<{ type: string }>;
    preconditions?: string | string[];
  };
  skillSlug?: string;
  successRate: number;
  executions: number;
}

export interface WorkspaceView {
  scope: string;
  strategies?: GeneStrategy[];
  memory?: Array<{
    path: string;
    memoryType?: string;
    content?: string;
  }>;
  personality?: { soul?: string };
  identity?: {
    did: string;
    displayName: string;
    agentType: string;
    capabilities: string[];
  };
  extensions?: Array<{
    path: string;
    content: string;
    type: string;
  }>;
}

// ── Helpers ──

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

// ── Renderers ──

export function renderGeneAsSkillMd(strategy: GeneStrategy, platform: string): string {
  const gene = strategy.gene;
  const slug = strategy.skillSlug || slugify(gene.title || gene.id);

  const fm: Record<string, string> = {
    name: slug,
    description: truncate(gene.description || gene.title || slug, 250),
  };

  if (platform === 'openclaw' && gene.preconditions) {
    const preconds = safeParseJson(gene.preconditions, []);
    const envReqs = preconds.filter((p: string) => p.startsWith('env:'));
    if (envReqs.length) {
      fm.metadata = JSON.stringify({
        openclaw: { requires: { env: envReqs.map((e: string) => e.replace('env:', '')) } },
      });
    }
  }

  const frontmatter = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === 'string' && v.includes('\n') ? `|\n  ${v}` : v}`)
    .join('\n');

  const steps = safeParseJson(gene.strategy, []);
  const signals = (gene.signals_match || []).map(s => s.type).join(', ');
  const preconditions = safeParseJson(gene.preconditions, []);

  let body = `# ${gene.title || gene.id}\n\n`;
  if (gene.description) body += `${gene.description}\n\n`;
  if (steps.length) {
    body += `## Strategy\n\n`;
    body += steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n') + '\n\n';
  }
  if (signals) {
    body += `## Signals\n\nTriggers on: ${signals}\n\n`;
  }
  if (preconditions.length) {
    body += `## Preconditions\n\n`;
    body += preconditions.map((p: string) => `- ${p}`).join('\n') + '\n\n';
  }
  body += `---\n`;
  body += `*Prismer Evolution Gene \`${gene.id}\` | ${Math.round(strategy.successRate * 100)}% success | ${strategy.executions} runs*\n`;

  return `---\n${frontmatter}\n---\n\n${body}`;
}

export function renderForClaudeCode(workspace: WorkspaceView): LocalFile[] {
  const files: LocalFile[] = [];
  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s, 'claude-code');
    files.push({
      relativePath: `skills/${slug}/SKILL.md`,
      content,
      meta: { sourceSlot: 'strategies', sourceId: s.gene.id, scope: workspace.scope, checksum: simpleHash(content) },
    });
  }
  return files;
}

export function renderForOpenCode(workspace: WorkspaceView): LocalFile[] {
  const files: LocalFile[] = [];
  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s, 'opencode');
    files.push({
      relativePath: `skills/${slug}/SKILL.md`,
      content,
      meta: { sourceSlot: 'strategies', sourceId: s.gene.id, scope: workspace.scope, checksum: simpleHash(content) },
    });
  }
  return files;
}

const OPENCLAW_MAX_CHARS = 20_000;
const OPENCLAW_TOTAL_MAX_CHARS = 150_000;

const TYPE_TO_PATH: Record<string, string> = {
  instructions: 'AGENTS.md',
  user: 'USER.md',
  tools: 'TOOLS.md',
  heartbeat: 'HEARTBEAT.md',
};

export function renderForOpenClaw(workspace: WorkspaceView): LocalFile[] {
  const files: LocalFile[] = [];
  let totalChars = 0;

  function addBootstrap(path: string, content: string, slot: string, sourceId: string) {
    const truncated = content.length > OPENCLAW_MAX_CHARS
      ? content.slice(0, OPENCLAW_MAX_CHARS) + '\n...(truncated)'
      : content;
    if (totalChars + truncated.length > OPENCLAW_TOTAL_MAX_CHARS) return;
    totalChars += truncated.length;
    files.push({
      relativePath: path,
      content: truncated,
      meta: { sourceSlot: slot, sourceId, scope: workspace.scope, checksum: simpleHash(truncated) },
    });
  }

  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s, 'openclaw');
    files.push({
      relativePath: `skills/${slug}/SKILL.md`,
      content,
      meta: { sourceSlot: 'strategies', sourceId: s.gene.id, scope: workspace.scope, checksum: simpleHash(content) },
    });
  }

  if (workspace.personality?.soul) {
    addBootstrap('SOUL.md', workspace.personality.soul, 'personality', 'soul');
  }

  if (workspace.identity?.did) {
    const id = workspace.identity;
    addBootstrap('IDENTITY.md', [
      `# Agent Identity`, ``,
      `- **Name**: ${id.displayName}`,
      `- **DID**: \`${id.did}\``,
      `- **Type**: ${id.agentType}`,
      `- **Capabilities**: ${id.capabilities.join(', ') || 'none'}`,
    ].join('\n'), 'identity', id.did);
  }

  for (const m of (workspace.memory || [])) {
    const targetPath = TYPE_TO_PATH[m.memoryType || ''];
    if (targetPath && m.content) {
      addBootstrap(targetPath, m.content, 'memory', m.path);
    }
  }

  const memoryMd = (workspace.memory || []).find(m => m.path === 'MEMORY.md');
  if (memoryMd?.content) {
    addBootstrap('MEMORY.md', memoryMd.content, 'memory', 'MEMORY.md');
  }

  for (const m of (workspace.memory || [])) {
    if (m.memoryType === 'daily' && m.content) {
      addBootstrap(m.path, m.content, 'memory', m.path);
    }
  }

  for (const m of (workspace.memory || [])) {
    const isHandled = TYPE_TO_PATH[m.memoryType || ''] || m.memoryType === 'daily'
      || m.memoryType === 'soul' || m.path === 'MEMORY.md';
    if (!isHandled && m.content) {
      const target = m.path.startsWith('memory/') ? m.path : `memory/${m.path}`;
      addBootstrap(target, m.content, 'memory', m.path);
    }
  }

  for (const ext of (workspace.extensions || [])) {
    files.push({
      relativePath: ext.path,
      content: ext.content,
      meta: { sourceSlot: 'extensions', sourceId: ext.type, scope: workspace.scope, checksum: simpleHash(ext.content) },
    });
  }

  return files;
}
