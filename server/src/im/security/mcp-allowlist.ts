import type { Context, Next } from 'hono';
import prisma from '../db';

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function resolveTaskWorkspaceId(taskId: string): Promise<string | null> {
  const task = await prisma.iMTask.findUnique({ where: { id: taskId }, select: { workspaceId: true } });
  if (task?.workspaceId) return task.workspaceId;

  const run = await prisma.iMTaskRun.findUnique({ where: { id: taskId }, select: { workspaceId: true } });
  return run?.workspaceId ?? null;
}

export async function resolveApprovalWorkspaceId(input: {
  workspaceId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  approvalId?: string | null;
}): Promise<string | null> {
  if (input.workspaceId) return input.workspaceId;
  if (input.taskId) {
    const workspaceId = await resolveTaskWorkspaceId(input.taskId);
    if (workspaceId) return workspaceId;
  }
  if (input.conversationId) {
    const conversation = await prisma.iMConversation.findUnique({
      where: { id: input.conversationId },
      select: { workspaceId: true },
    });
    if (conversation?.workspaceId) return conversation.workspaceId;
  }
  if (input.approvalId && (prisma as any).iMApproval) {
    const approval = await (prisma as any).iMApproval.findUnique({
      where: { id: input.approvalId },
      select: { workspaceId: true },
    });
    if (approval?.workspaceId) return approval.workspaceId;
  }
  return null;
}

async function isToolAllowedForAgent(agentImUserId: string, workspaceId: string, toolName: string): Promise<boolean> {
  const where: Record<string, unknown> = { agentImUserId, deletedAt: null };
  if (workspaceId) where.workspaceId = workspaceId;
  const profile = await prisma.iMAgentProfile.findFirst({
    where,
    orderBy: { updatedAt: 'desc' },
    select: { config: true },
  });
  if (!profile) return true;

  const config = parseJsonObject(profile.config);
  const allowlist = resolveMcpAllowlist(config);
  if (allowlist == null) return true;
  if (!Array.isArray(allowlist)) return false;
  return isMcpToolAllowed(toolName, allowlist);
}

export function resolveMcpAllowlist(config: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(config, 'mcpAllowlist')
    ? config.mcpAllowlist
    : resolveRoleTemplateAllowlist(config.roleTemplate);
}

export function isMcpToolAllowed(toolName: string, allowlist: unknown[]): boolean {
  return allowlist.some((entry) => {
    if (typeof entry !== 'string') return false;
    const rule = entry.trim();
    if (!rule) return false;
    if (rule.endsWith('*')) return toolName.startsWith(rule.slice(0, -1));
    return rule === toolName;
  });
}

export function resolveRoleTemplateAllowlist(raw: unknown): unknown {
  const roleTemplate = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const servers = Array.isArray(roleTemplate?.mcpServers) ? roleTemplate.mcpServers : [];
  const prismer = servers.find((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    const record = server as Record<string, unknown>;
    return record.package === '@prismer/mcp-server' || record.name === 'prismer-tasks';
  });
  if (!prismer || typeof prismer !== 'object' || Array.isArray(prismer)) return null;
  return (prismer as Record<string, unknown>).toolsAllowlist ?? null;
}

export async function resolveConversationWorkspaceId(
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null;
  const conversation = await prisma.iMConversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true },
  });
  return conversation?.workspaceId ?? null;
}

export async function requireAgentToolAllowed(
  c: Context,
  toolName: string,
  workspaceId: string | null | undefined,
): Promise<Response | null> {
  const user = c.get('user');
  if (user?.role !== 'agent') return null;

  const allowed = await isToolAllowedForAgent(user.imUserId, workspaceId ?? '', toolName);
  if (allowed) return null;
  return c.json(
    {
      ok: false,
      error: {
        code: 'TOOL_NOT_ALLOWED_FOR_AGENT',
        message: `Tool ${toolName} is not allowed for this agent profile`,
      },
    },
    403,
  );
}

export async function requireAgentToolAllowedForTask(
  c: Context,
  toolName: string,
  taskId: string,
): Promise<Response | null> {
  const workspaceId = await resolveTaskWorkspaceId(taskId);
  return requireAgentToolAllowed(c, toolName, workspaceId);
}

export function agentToolAllowlistMiddleware(
  toolName: string,
  resolveWorkspaceId: (c: Context) => Promise<string | null>,
) {
  return async (c: Context, next: Next) => {
    const workspaceId = await resolveWorkspaceId(c);
    const denied = await requireAgentToolAllowed(c, toolName, workspaceId);
    if (denied) return denied;
    return next();
  };
}
