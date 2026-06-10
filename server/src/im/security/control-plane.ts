import type { Context } from 'hono';
import prisma from '../db';
import type { ResolvedUser } from '../auth/middleware';

export type ControlPlaneTool =
  | 'prismer.approval.request_human_approval'
  | 'prismer.task.create'
  | 'prismer.task.list'
  | 'prismer.task.get'
  | 'prismer.task.update'
  | 'prismer.task.complete'
  | 'prismer.task.approve'
  | 'prismer.task.reject'
  | 'prismer.task.cancel';

export type ControlPlaneAllowlistResult =
  | { allowed: true }
  | { allowed: false; status: 403; code: 'MCP_TOOL_NOT_ALLOWED'; message: string; toolName: ControlPlaneTool };

type AgentProfileConfig = {
  mcpAllowlist?: unknown;
};

type ProfileAllowlist = {
  explicit: boolean;
  allowlist: string[] | null;
};

export function mcpToolAllowedByPattern(patterns: string[], toolName: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === toolName) return true;
    if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
    return false;
  });
}

/**
 * Cloud route-side defense in depth for MCP tools.
 *
 * Only agent IM users are restricted here. Human/admin users keep the normal
 * route RBAC. A missing `mcpAllowlist` property means legacy/unconfigured
 * profiles allow all; an explicit null/undefined value also allows all.
 */
export async function checkMcpToolAllowedForRequest(
  c: Context,
  toolName: ControlPlaneTool,
  opts: { workspaceId?: string | null } = {},
): Promise<ControlPlaneAllowlistResult> {
  const user = c.get('user') as ResolvedUser;
  if (user.role !== 'agent') return { allowed: true };

  const profileAllowlists = await loadExplicitMcpAllowlists(user.imUserId, opts.workspaceId);
  if (profileAllowlists.length === 0) return { allowed: true };

  for (const profile of profileAllowlists) {
    if (profile.allowlist === null) return { allowed: true };
    if (mcpToolAllowedByPattern(profile.allowlist, toolName)) return { allowed: true };
  }

  return {
    allowed: false,
    status: 403,
    code: 'MCP_TOOL_NOT_ALLOWED',
    message: `tool_not_allowed_for_agent: ${toolName}`,
    toolName,
  };
}

export async function loadTaskWorkspaceId(taskId: string): Promise<string | null | undefined> {
  const task = await prisma.iMTask.findUnique({
    where: { id: taskId },
    select: { workspaceId: true },
  });
  return task?.workspaceId;
}

async function loadExplicitMcpAllowlists(
  agentImUserId: string,
  workspaceId?: string | null,
): Promise<ProfileAllowlist[]> {
  const rows = await prisma.iMAgentProfile.findMany({
    where: {
      agentImUserId,
      deletedAt: null,
      ...(workspaceId ? { workspaceId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: { config: true },
  });

  const result: ProfileAllowlist[] = [];
  for (const row of rows) {
    const parsed = parseProfileConfig(row.config);
    if (!Object.prototype.hasOwnProperty.call(parsed, 'mcpAllowlist')) continue;

    const raw = parsed.mcpAllowlist;
    if (raw == null) {
      result.push({ explicit: true, allowlist: null });
      continue;
    }

    if (Array.isArray(raw)) {
      result.push({
        explicit: true,
        allowlist: raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
      });
      continue;
    }

    // Malformed explicit allowlist is treated as deny-all for this profile.
    result.push({ explicit: true, allowlist: [] });
  }
  return result;
}

function parseProfileConfig(config: string | null | undefined): AgentProfileConfig {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AgentProfileConfig) : {};
  } catch {
    return {};
  }
}
