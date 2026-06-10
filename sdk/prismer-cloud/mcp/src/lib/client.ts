import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Resolve API key with priority chain:
 *   1. PRISMER_API_KEY env var (explicit override)
 *   2. ~/.prismer/config.toml [default] api_key (SDK CLI `prismer auth` sets this)
 *   3. '' (empty — tool calls will fail with clear error)
 */
function resolveApiKey(): string {
  let key = process.env.PRISMER_API_KEY || '';

  if (!key) {
    try {
      const configPath = join(homedir(), '.prismer', 'config.toml');
      const raw = readFileSync(configPath, 'utf-8');
      const match = raw.match(/^api_key\s*=\s*'([^']+)'/m) || raw.match(/^api_key\s*=\s*"([^"]+)"/m);
      if (match?.[1]) key = match[1];
    } catch {
      // No config file — that's OK
    }
  }

  // Validate: must be sk-prismer-* format, not a JWT or other token
  if (key && !key.startsWith('sk-prismer-')) {
    console.error(`[Prismer] Invalid API key format (expected sk-prismer-*, got ${key.substring(0, 10)}...).`);
    console.error('  Run: npx prismer setup');
    console.error('  Get key at: https://prismer.cloud/setup\n');
    return '';
  }

  return key;
}

function resolveBaseUrl(): string {
  if (process.env.PRISMER_BASE_URL) return process.env.PRISMER_BASE_URL;

  try {
    const configPath = join(homedir(), '.prismer', 'config.toml');
    const raw = readFileSync(configPath, 'utf-8');
    const match = raw.match(/^base_url\s*=\s*'([^']+)'/m) || raw.match(/^base_url\s*=\s*"([^"]+)"/m);
    if (match?.[1]) return match[1];
  } catch {
    // No config file
  }

  return 'https://prismer.cloud';
}

const API_KEY = resolveApiKey();
const BASE_URL = resolveBaseUrl();
// Agent identity for X-IM-Agent header. When set, the cloud auth middleware
// resolves the request to the agent's IMUser instead of the API-key owner
// (the human), so message senderId is attributed to the agent. Prefer the
// canonical name PRISMER_AGENT_USERNAME; fall back to legacy PRISMER_IM_AGENT.
const IM_AGENT = process.env.PRISMER_AGENT_USERNAME || process.env.PRISMER_IM_AGENT || '';
const IM_WORKSPACE = process.env.PRISMER_WORKSPACE_ID || '';
const MCP_ALLOWLIST = parseMcpAllowlist(process.env.PRISMER_MCP_ALLOWLIST);

export interface McpAllowlistRule {
  kind: 'exact' | 'prefix';
  value: string;
}

export class PrismerApiError extends Error {
  status?: number;
  code?: string;
  toolName?: string;

  constructor(message: string, options: { status?: number; code?: string; toolName?: string } = {}) {
    super(message);
    this.name = 'PrismerApiError';
    this.status = options.status;
    this.code = options.code;
    this.toolName = options.toolName;
  }
}

export function getApiKey(): string {
  return API_KEY;
}

/**
 * Resolve project scope automatically.
 * Priority: PRISMER_SCOPE env > package.json name > cwd basename > 'global'
 */
export function getScope(): string {
  if (process.env.PRISMER_SCOPE) return process.env.PRISMER_SCOPE;

  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    if (pkg.name) return pkg.name;
  } catch {}

  // Use cwd basename as fallback
  const cwd = process.cwd();
  const base = cwd.split('/').pop() || cwd.split('\\').pop();
  if (base && base !== '/' && base !== '.') return base;

  return 'global';
}

export function getBaseUrl(): string {
  return BASE_URL;
}

export function parseMcpAllowlist(raw: string | undefined): McpAllowlistRule[] {
  return (raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): McpAllowlistRule => {
      if (entry.endsWith('*')) return { kind: 'prefix', value: entry.slice(0, -1) };
      return { kind: 'exact', value: entry };
    });
}

export function getMcpAllowlist(): McpAllowlistRule[] {
  return MCP_ALLOWLIST;
}

export function isToolAllowed(name: string, rules: McpAllowlistRule[] = MCP_ALLOWLIST): boolean {
  if (rules.length === 0) return true;
  return rules.some((rule) =>
    rule.kind === 'exact' ? name === rule.value : name.startsWith(rule.value),
  );
}

export function formatMcpToolError(error: unknown): string {
  if (error instanceof PrismerApiError) {
    const code = error.code || '';
    if (code === 'TOOL_NOT_ALLOWED_FOR_AGENT' || code === 'tool_not_allowed_for_agent') {
      const tool = error.toolName ? ` \`${error.toolName}\`` : '';
      return `Permission denied: this agent profile is not allowed to use${tool}. Ask the workspace owner to update the MCP allowlist or delegate this action to an authorized agent.`;
    }
    if (error.status === 401 || error.status === 403) {
      return `Permission denied: ${error.message}`;
    }
    return `Prismer API error${error.status ? ` ${error.status}` : ''}: ${error.message}`;
  }

  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/^tool_not_allowed_for_agent:\s*(.+)$/);
  if (match?.[1]) {
    return `Permission denied: this agent profile is not allowed to use \`${match[1]}\`. Ask the workspace owner to update the MCP allowlist or delegate this action to an authorized agent.`;
  }
  return msg;
}

function inferToolNameForRequest(path: string, method: string): string | null {
  const pathname = path.startsWith('http') ? new URL(path).pathname : path.split('?')[0]!;
  const normalizedMethod = method.toUpperCase();

  if (pathname === '/api/im/tasks') {
    return normalizedMethod === 'POST' ? 'prismer.task.create' : 'prismer.task.list';
  }
  if (/^\/api\/im\/tasks\/[^/]+\/approve$/.test(pathname)) return 'prismer.task.approve';
  if (/^\/api\/im\/tasks\/[^/]+\/reject$/.test(pathname)) return 'prismer.task.reject';
  if (/^\/api\/im\/tasks\/[^/]+\/cancel$/.test(pathname)) return 'prismer.task.cancel';
  if (/^\/api\/im\/tasks\/[^/]+\/complete$/.test(pathname)) return 'prismer.task.complete';
  if (/^\/api\/im\/tasks\/[^/]+$/.test(pathname)) {
    if (normalizedMethod === 'PATCH' || normalizedMethod === 'PUT') return 'prismer.task.update';
    if (normalizedMethod === 'DELETE') return 'prismer.task.cancel';
    return 'prismer.task.get';
  }

  if (pathname === '/api/im/skills/installed') return 'prismer.skill.installed';
  if (/^\/api\/im\/skills\/[^/]+\/install$/.test(pathname)) {
    return normalizedMethod === 'DELETE' ? 'prismer.skill.uninstall' : 'prismer.skill.install';
  }
  if (pathname === '/api/im/skills/preinstall') return 'prismer.skill.install';
  if (/^\/api\/im\/skills\/[^/]+\/content$/.test(pathname)) return 'prismer.skill.content';
  if (pathname === '/api/im/skills/search') return 'prismer.skill.search';
  if (pathname === '/api/im/skills/sync' || pathname === '/api/im/workspace') return 'prismer.skill.sync';

  if (/^\/api\/im\/messages\/[^/]+\/[^/]+$/.test(pathname)) {
    if (normalizedMethod === 'DELETE') return 'prismer.message.delete';
    if (normalizedMethod === 'PATCH' || normalizedMethod === 'PUT') return 'prismer.message.edit';
  }
  if (/^\/api\/im\/messages\/[^/]+\/[^/]+\/reactions?$/.test(pathname)) return 'prismer.message.react';
  if (/^\/api\/im\/direct\/[^/]+\/messages$/.test(pathname)) return 'prismer.message.send';
  if (/^\/api\/im\/groups\/[^/]+\/messages$/.test(pathname)) return 'prismer.message.send';
  if (/^\/api\/im\/messages\/[^/]+$/.test(pathname)) return 'prismer.agent.send';
  if (/^\/api\/im\/conversations\/[^/]+$/.test(pathname)) return 'prismer.conversation.listAgents';

  if (pathname === '/api/im/approvals' && normalizedMethod === 'POST') {
    return 'prismer.approval.request_human_approval';
  }
  if (/^\/api\/im\/approvals\/[^/]+\/decision$/.test(pathname)) {
    return 'prismer.approval.decide';
  }
  if (pathname === '/api/im/approvals' || pathname.startsWith('/api/im/approvals/')) {
    return 'prismer.approval.list';
  }

  if (/^\/api\/im\/memory\/(files|pages)/.test(pathname)) {
    return normalizedMethod === 'GET' ? 'prismer.memory.read' : 'prismer.memory.write';
  }
  if (pathname.startsWith('/api/im/evolution/')) {
    if (pathname.includes('/publish')) return 'prismer.evolve.publish';
    if (normalizedMethod === 'DELETE') return 'prismer.evolve.delete';
    if (pathname.endsWith('/import') || pathname.endsWith('/fork')) return 'prismer.evolve.import';
  }
  if (pathname.startsWith('/api/im/community/') && normalizedMethod !== 'GET') {
    if (normalizedMethod === 'DELETE') return 'prismer.community.delete';
    if (normalizedMethod === 'PATCH' || normalizedMethod === 'PUT') return 'prismer.community.edit';
    if (pathname.includes('/vote')) return 'prismer.community.vote';
    if (pathname.includes('/follow')) return 'prismer.community.follow';
    if (pathname.includes('/bookmark')) return 'prismer.community.bookmark';
    if (pathname.includes('/comments')) return 'prismer.community.comment';
    return 'prismer.community.post';
  }

  return null;
}

export async function prismerFetch(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string>; toolName?: string } = {}
): Promise<unknown> {
  if (!API_KEY) {
    throw new Error('API key not configured. Run `npx prismer setup` (get key at https://prismer.cloud/setup)');
  }

  const method = options.method || 'GET';
  const toolName = options.toolName || inferToolNameForRequest(path, method) || undefined;
  if (toolName && !isToolAllowed(toolName)) {
    throw new PrismerApiError(`tool_not_allowed_for_agent: ${toolName}`, {
      code: 'tool_not_allowed_for_agent',
      toolName,
    });
  }

  const url = new URL(path, BASE_URL);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
  if (IM_AGENT) headers['X-IM-Agent'] = IM_AGENT;
  if (IM_AGENT && IM_WORKSPACE) headers['X-IM-Workspace'] = IM_WORKSPACE;

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    let message: string;
    let code: string | undefined;
    try {
      const json = JSON.parse(text);
      code = typeof json.error?.code === 'string' ? json.error.code : typeof json.code === 'string' ? json.code : undefined;
      message = json.error?.message || json.message || text;
    } catch {
      message = text;
    }
    throw new PrismerApiError(message, { status: response.status, code, toolName });
  }

  return response.json();
}
