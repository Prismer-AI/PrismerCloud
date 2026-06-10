/**
 * Release 201 P0-6 — Role provenance resolver.
 *
 * Looks up the role-template stamps that should accompany a memory write by
 * the given caller (IMUser) in the given workspace. The result is fed
 * verbatim into CreateMemoryFileData.sourceRoleTemplateSlug /
 * sourceTaskAuthority / sourceIsOrchestrator so recall can later filter on
 * role-self, orchestrator-workspace, etc.
 *
 * What we resolve:
 *   - agent caller bound to an IMAgentProfile → role-template slug from
 *     profile.config.roleTemplate.slug; authority from
 *     profile.config.taskAuthority (or roleTemplate.taskAuthority); the
 *     orchestrator bit is derived as authority === 'orchestrator'
 *   - human caller (workspace owner) → currently stamped as
 *     (slug=null, authority='orchestrator', isOrchestrator=true) — the owner
 *     is the canonical workspace orchestrator until a CEO agent is appointed.
 *   - anything we can't resolve → all-null (recall treats unstamped rows as
 *     "any-role"; matches the historical 1516 rows with sourceKind=NULL).
 *
 * This module deliberately does NOT cache. The lookup is small (one
 * IMAgentProfile fetch) and role bindings are mutable enough that a
 * MemoryAclContext-style 60s LRU would cause race conditions on role
 * reassignment. If hot-path cost shows up in profiling, cache at the
 * caller level with explicit invalidation hooks.
 */

import prisma from '../db';

export interface MemoryRoleProvenance {
  sourceRoleTemplateSlug: string | null;
  sourceTaskAuthority: 'orchestrator' | 'executor' | null;
  sourceIsOrchestrator: boolean | null;
}

const EMPTY: MemoryRoleProvenance = {
  sourceRoleTemplateSlug: null,
  sourceTaskAuthority: null,
  sourceIsOrchestrator: null,
};

function parseConfig(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

function readAuthority(config: Record<string, unknown>): 'orchestrator' | 'executor' | null {
  const direct = typeof config.taskAuthority === 'string' ? config.taskAuthority : null;
  if (direct === 'orchestrator' || direct === 'executor') return direct;
  const role = parseConfig((config as { roleTemplate?: unknown }).roleTemplate);
  const fromRole = role && typeof role.taskAuthority === 'string' ? role.taskAuthority : null;
  if (fromRole === 'orchestrator' || fromRole === 'executor') return fromRole;
  return null;
}

function readSlug(config: Record<string, unknown>): string | null {
  const role = parseConfig((config as { roleTemplate?: unknown }).roleTemplate);
  const slug = role && typeof role.slug === 'string' ? role.slug.trim() : '';
  return slug || null;
}

export async function resolveMemoryRoleProvenance(
  workspaceId: string,
  callerImUserId: string,
  callerKind: 'user' | 'agent',
): Promise<MemoryRoleProvenance> {
  if (!workspaceId || !callerImUserId) return EMPTY;

  if (callerKind === 'user') {
    // Workspace owner = canonical orchestrator until a CEO agent is the
    // active Chief of Staff. We still stamp authority='orchestrator' so
    // human-written memories surface under orchestrator-workspace recall.
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, ownerImUserId: callerImUserId, deletedAt: null },
      select: { id: true },
    });
    if (!ws) return EMPTY;
    return {
      sourceRoleTemplateSlug: null,
      sourceTaskAuthority: 'orchestrator',
      sourceIsOrchestrator: true,
    };
  }

  // Agent caller — look up the most recently updated profile for this agent
  // in this workspace and read its role config.
  const profile = await prisma.iMAgentProfile.findFirst({
    where: { agentImUserId: callerImUserId, workspaceId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    select: { config: true },
  });
  if (!profile) return EMPTY;
  const config = parseConfig(profile.config);
  if (!config) return EMPTY;
  const authority = readAuthority(config);
  const slug = readSlug(config);
  if (!authority && !slug) return EMPTY;
  return {
    sourceRoleTemplateSlug: slug,
    sourceTaskAuthority: authority,
    sourceIsOrchestrator: authority === 'orchestrator',
  };
}
