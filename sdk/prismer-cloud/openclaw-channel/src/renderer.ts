// Full OpenClaw renderer — handles complete workspace bootstrap projection

export interface LocalFile {
  relativePath: string;
  content: string;
  meta: { sourceSlot: string; sourceId: string; scope: string; checksum: string };
}

interface WorkspaceView {
  scope: string;
  strategies?: Array<{
    gene: { id: string; title?: string; description?: string; strategy?: string | string[]; signals_match?: Array<{ type: string }>; preconditions?: string | string[] };
    skillSlug?: string;
    successRate: number;
    executions: number;
  }>;
  memory?: Array<{ path: string; memoryType?: string; content?: string }>;
  personality?: { soul?: string };
  identity?: { did: string; displayName: string; agentType: string; capabilities: string[] };
  extensions?: Array<{ path: string; content: string; type: string }>;
}

function slugify(id: string): string { return id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(); }
function truncate(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max - 3) + '...'; }
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}
function safeParseJson(val: unknown, fb: string[]): string[] {
  if (Array.isArray(val)) return val;
  try { return JSON.parse((val as string) || '[]'); } catch { return fb; }
}

type StrategyEntry = NonNullable<WorkspaceView['strategies']>[number];

function renderGeneAsSkillMd(s: StrategyEntry): string {
  const gene = s.gene;
  const slug = s.skillSlug || slugify(gene.title || gene.id);
  const desc = truncate(gene.description || gene.title || slug, 250);

  const preconds = safeParseJson(gene.preconditions, []);
  const envReqs = preconds.filter((p: string) => p.startsWith('env:'));
  let metaLine = '';
  if (envReqs.length) {
    metaLine = `\nmetadata: ${JSON.stringify({ openclaw: { requires: { env: envReqs.map((e: string) => e.replace('env:', '')) } } })}`;
  }

  const fm = `name: ${slug}\ndescription: ${desc}${metaLine}`;
  const steps = safeParseJson(gene.strategy, []);
  const signals = (gene.signals_match || []).map((sig: { type: string }) => sig.type).join(', ');

  let body = `# ${gene.title || gene.id}\n\n`;
  if (gene.description) body += `${gene.description}\n\n`;
  if (steps.length) body += `## Strategy\n\n${steps.map((st: string, i: number) => `${i + 1}. ${st}`).join('\n')}\n\n`;
  if (signals) body += `## Signals\n\nTriggers on: ${signals}\n\n`;
  if (preconds.length) body += `## Preconditions\n\n${preconds.map((p: string) => `- ${p}`).join('\n')}\n\n`;
  body += `---\n*Prismer Evolution Gene \`${gene.id}\` | ${Math.round(s.successRate * 100)}% success | ${s.executions} runs*\n`;

  return `---\n${fm}\n---\n\n${body}`;
}

const OPENCLAW_MAX_CHARS = 20_000;
const OPENCLAW_TOTAL_MAX_CHARS = 150_000;
const TYPE_TO_PATH: Record<string, string> = { instructions: 'AGENTS.md', user: 'USER.md', tools: 'TOOLS.md', heartbeat: 'HEARTBEAT.md' };

export function renderForOpenClaw(workspace: WorkspaceView): LocalFile[] {
  const files: LocalFile[] = [];
  let totalChars = 0;

  function addBootstrap(path: string, content: string, slot: string, sourceId: string) {
    const truncated = content.length > OPENCLAW_MAX_CHARS ? content.slice(0, OPENCLAW_MAX_CHARS) + '\n...(truncated)' : content;
    if (totalChars + truncated.length > OPENCLAW_TOTAL_MAX_CHARS) return;
    totalChars += truncated.length;
    files.push({ relativePath: path, content: truncated, meta: { sourceSlot: slot, sourceId, scope: workspace.scope, checksum: simpleHash(truncated) } });
  }

  // 1. strategies → skills/ (lazy-loaded)
  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s);
    files.push({
      relativePath: `skills/${slug}/SKILL.md`, content,
      meta: { sourceSlot: 'strategies', sourceId: s.gene.id, scope: workspace.scope, checksum: simpleHash(content) },
    });
  }

  // 2. Bootstrap files
  if (workspace.personality?.soul) addBootstrap('SOUL.md', workspace.personality.soul, 'personality', 'soul');
  if (workspace.identity?.did) {
    const id = workspace.identity;
    addBootstrap('IDENTITY.md', `# Agent Identity\n\n- **Name**: ${id.displayName}\n- **DID**: \`${id.did}\`\n- **Type**: ${id.agentType}\n- **Capabilities**: ${id.capabilities.join(', ') || 'none'}`, 'identity', id.did);
  }
  for (const m of (workspace.memory || [])) {
    const tp = TYPE_TO_PATH[m.memoryType || ''];
    if (tp && m.content) addBootstrap(tp, m.content, 'memory', m.path);
  }
  const memMd = (workspace.memory || []).find(m => m.path === 'MEMORY.md');
  if (memMd?.content) addBootstrap('MEMORY.md', memMd.content, 'memory', 'MEMORY.md');
  for (const m of (workspace.memory || [])) {
    if (m.memoryType === 'daily' && m.content) addBootstrap(m.path, m.content, 'memory', m.path);
  }
  for (const m of (workspace.memory || [])) {
    const isHandled = TYPE_TO_PATH[m.memoryType || ''] || m.memoryType === 'daily' || m.memoryType === 'soul' || m.path === 'MEMORY.md';
    if (!isHandled && m.content) {
      const target = m.path.startsWith('memory/') ? m.path : `memory/${m.path}`;
      addBootstrap(target, m.content, 'memory', m.path);
    }
  }

  // extensions
  for (const ext of (workspace.extensions || [])) {
    files.push({ relativePath: ext.path, content: ext.content, meta: { sourceSlot: 'extensions', sourceId: ext.type, scope: workspace.scope, checksum: simpleHash(ext.content) } });
  }

  return files;
}
