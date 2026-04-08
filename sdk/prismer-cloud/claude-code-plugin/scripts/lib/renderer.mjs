/**
 * ProjectionRenderer — render WorkspaceView into platform-native local files.
 *
 * Design:
 * - One renderer function per platform
 * - Renderers only do format conversion, no IO
 * - Caller (session-start.mjs) handles file writes and incremental checks
 */

// ── Helpers ──

function slugify(id) {
  return id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function safeParseJson(val, fallback) {
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val || '[]'); } catch { return fallback; }
}

/**
 * Render a Gene strategy as SKILL.md content.
 * @param {Object} strategy - { gene, skillSlug, successRate, executions }
 * @param {string} platform - 'claude-code' | 'opencode' | 'openclaw'
 * @returns {string} Full SKILL.md with frontmatter
 */
export function renderGeneAsSkillMd(strategy, platform) {
  const gene = strategy.gene;
  const slug = strategy.skillSlug || slugify(gene.title || gene.id);

  // Frontmatter
  const fm = {
    name: slug,
    description: truncate(gene.description || gene.title || slug, 250),
  };

  // OpenClaw gating: env preconditions
  if (platform === 'openclaw' && gene.preconditions?.length) {
    const envReqs = gene.preconditions.filter(p => p.startsWith('env:'));
    if (envReqs.length) {
      fm.metadata = JSON.stringify({
        openclaw: { requires: { env: envReqs.map(e => e.replace('env:', '')) } },
      });
    }
  }

  const frontmatter = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === 'string' && v.includes('\n') ? `|\n  ${v}` : v}`)
    .join('\n');

  // Body
  const steps = safeParseJson(gene.strategy, []);
  const signals = (gene.signals_match || []).map(s => s.type).join(', ');
  const preconditions = safeParseJson(gene.preconditions, []);

  let body = `# ${gene.title || gene.id}\n\n`;
  if (gene.description) body += `${gene.description}\n\n`;

  if (steps.length) {
    body += `## Strategy\n\n`;
    body += steps.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n\n';
  }

  if (signals) {
    body += `## Signals\n\nTriggers on: ${signals}\n\n`;
  }

  if (preconditions.length) {
    body += `## Preconditions\n\n`;
    body += preconditions.map(p => `- ${p}`).join('\n') + '\n\n';
  }

  body += `---\n`;
  body += `*Prismer Evolution Gene \`${gene.id}\` | ${Math.round(strategy.successRate * 100)}% success | ${strategy.executions} runs*\n`;

  return `---\n${frontmatter}\n---\n\n${body}`;
}

/**
 * Claude Code renderer: workspace → SKILL.md file list.
 * Output also works for Cursor (scans .claude/skills/ compat path).
 */
export function renderForClaudeCode(workspace) {
  const files = [];
  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s, 'claude-code');
    files.push({
      relativePath: `skills/${slug}/SKILL.md`,
      content,
      meta: {
        sourceSlot: 'strategies',
        sourceId: s.gene.id,
        scope: workspace.scope,
        checksum: simpleHash(content),
      },
    });
  }
  return files;
}

/**
 * OpenCode renderer: same SKILL.md format, different write paths handled by caller.
 */
export function renderForOpenCode(workspace) {
  const files = [];
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

/**
 * OpenClaw renderer: full workspace bootstrap projection.
 *
 * Renders strategies, personality, identity, memory, and extensions
 * into the OpenClaw workspace directory structure.
 *
 * Limits (from OpenClaw context docs):
 *   - Per file: ≤ 20,000 chars (bootstrapMaxChars)
 *   - Total: ≤ 150,000 chars (bootstrapTotalMaxChars)
 *   - Skills are lazy-loaded, don't count against limit
 */
export function renderForOpenClaw(workspace) {
  const OPENCLAW_MAX_CHARS = 20_000;
  const OPENCLAW_TOTAL_MAX_CHARS = 150_000;

  const TYPE_TO_PATH = {
    instructions: 'AGENTS.md',
    user: 'USER.md',
    tools: 'TOOLS.md',
    heartbeat: 'HEARTBEAT.md',
  };

  const files = [];
  let totalChars = 0;

  function addBootstrap(path, content, slot, sourceId) {
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

  // 1. strategies → skills/ (lazy-loaded, don't count against bootstrap limit)
  for (const s of (workspace.strategies || [])) {
    const slug = s.skillSlug || slugify(s.gene.title || s.gene.id);
    const content = renderGeneAsSkillMd(s, 'openclaw');
    files.push({
      relativePath: `skills/${slug}/SKILL.md`,
      content,
      meta: { sourceSlot: 'strategies', sourceId: s.gene.id, scope: workspace.scope, checksum: simpleHash(content) },
    });
  }

  // 2. SOUL.md ← personality.soul
  if (workspace.personality?.soul) {
    addBootstrap('SOUL.md', workspace.personality.soul, 'personality', 'soul');
  }

  // 3. IDENTITY.md ← identity slot
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

  // 4. AGENTS.md / USER.md / TOOLS.md / HEARTBEAT.md ← memory slot (by memoryType)
  for (const m of (workspace.memory || [])) {
    const targetPath = TYPE_TO_PATH[m.memoryType];
    if (targetPath && m.content) {
      addBootstrap(targetPath, m.content, 'memory', m.path);
    }
  }

  // 5. MEMORY.md ← curated long-term memory
  const memoryMd = (workspace.memory || []).find(m => m.path === 'MEMORY.md');
  if (memoryMd?.content) {
    addBootstrap('MEMORY.md', memoryMd.content, 'memory', 'MEMORY.md');
  }

  // 6. memory/YYYY-MM-DD.md ← daily notes (OpenClaw auto-loads today + yesterday)
  for (const m of (workspace.memory || [])) {
    if (m.memoryType === 'daily' && m.content) {
      addBootstrap(m.path, m.content, 'memory', m.path);
    }
  }

  // 7. General memory files → memory/{path}
  for (const m of (workspace.memory || [])) {
    const isHandled = TYPE_TO_PATH[m.memoryType] || m.memoryType === 'daily'
      || m.memoryType === 'soul' || m.path === 'MEMORY.md';
    if (!isHandled && m.content) {
      const target = m.path.startsWith('memory/') ? m.path : `memory/${m.path}`;
      addBootstrap(target, m.content, 'memory', m.path);
    }
  }

  // 8. extensions → passthrough (canvas/ etc.)
  for (const ext of (workspace.extensions || [])) {
    files.push({
      relativePath: ext.path,
      content: ext.content,
      meta: { sourceSlot: 'extensions', sourceId: ext.type, scope: workspace.scope, checksum: simpleHash(ext.content) },
    });
  }

  return files;
}
