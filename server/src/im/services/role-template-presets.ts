import {
  DEFAULT_ORCHESTRATOR_POLICY,
  DEFAULT_SPECIALIST_POLICY,
  projectMcpAllowlist,
} from '../../lib/role-runtime-policy';

export type RoleTemplateTaskAuthority = 'executor' | 'orchestrator';

export interface RoleTemplateRbacPreset {
  name: string;
  taskAuthority: RoleTemplateTaskAuthority;
  toolsAllowlist: string[];
}

export const ROLE_TEMPLATE_RBAC_PRESETS: Record<RoleTemplateTaskAuthority, RoleTemplateRbacPreset> = {
  orchestrator: {
    name: 'orchestrator-pack',
    taskAuthority: 'orchestrator',
    toolsAllowlist: projectMcpAllowlist(DEFAULT_ORCHESTRATOR_POLICY),
  },
  executor: {
    name: 'executor-pack',
    taskAuthority: 'executor',
    toolsAllowlist: projectMcpAllowlist(DEFAULT_SPECIALIST_POLICY),
  },
};

// v2.0 — only the CEO role carries orchestrator authority. All other roles
// (including former project-management / strategy / product) default to
// executor. Tightened after simple-mode acceptance found multiple
// "orchestrator"-agentType agents dispatching independently in the same
// group, causing divergence with no human-in-the-loop.
// See docs/release200/evidence/v20-acceptance/06-ceo-orchestrator-discipline-2026-05-22.md.
export const ORCHESTRATOR_ROLE_TEMPLATE_CATEGORIES = new Set<string>();

export function resolveRoleTemplateTaskAuthority(category: string, slug?: string): RoleTemplateTaskAuthority {
  if (slug === 'ceo') return 'orchestrator';
  return ORCHESTRATOR_ROLE_TEMPLATE_CATEGORIES.has(category) ? 'orchestrator' : 'executor';
}

export function resolveRoleTemplateRbacPreset(taskAuthority: RoleTemplateTaskAuthority): RoleTemplateRbacPreset {
  return ROLE_TEMPLATE_RBAC_PRESETS[taskAuthority];
}
