import {
  type AcpAuthority,
  DEFAULT_MAX_AUTONOMOUS_ROUNDS,
  buildRoleOperatingPrinciples,
  getDefaultPolicy,
  projectMcpAllowlist,
  type RoleRuntimePolicy,
} from '../../lib/role-runtime-policy';

export type { AcpAuthority };
export type AcpApprovalPolicy = 'strict' | 'auto-low-risk' | 'autonomous';

export interface DefaultAcpProfileInput {
  username?: string | null;
  displayName?: string | null;
  agentType?: string | null;
  capabilities?: string[] | null;
}

// v2.0 — orchestrator authority is reserved for CEO only. Other roles
// (including coo / operations / pm) default to executor. See
// docs/release200/evidence/v20-acceptance/06-ceo-orchestrator-discipline-2026-05-22.md.
const ORCHESTRATOR_SLUGS = new Set(['ceo']);

export function resolveDefaultTaskAuthority(input: DefaultAcpProfileInput): AcpAuthority {
  const agentType = input.agentType?.trim().toLowerCase();
  const username = input.username?.trim().toLowerCase();
  if (agentType === 'orchestrator') return 'orchestrator';
  if (username && ORCHESTRATOR_SLUGS.has(username)) return 'orchestrator';
  return 'executor';
}

/**
 * v2.1 (release 201 P0-7) — MCP allowlist is now a projection of the
 * unified RoleRuntimePolicy (`src/lib/role-runtime-policy.ts`). The literal
 * `COMMON_MCP_TOOLS` + `ORCHESTRATOR_EXTRA_MCP_TOOLS` arrays were removed —
 * three sources of truth (here + workspace/lib/templates.ts + role-template
 * seed scripts) had already drifted (skill_sync alias, orchestrator extras
 * granted to coo/pm). One projection function eliminates that class of bug.
 *
 * The public signature is unchanged for backward compat with profile-defaults
 * consumers (use-simple-provisioning.ts, agent-profiles.ts, snapshot service).
 */
export function buildDefaultMcpAllowlist(authority: AcpAuthority): string[] {
  return projectMcpAllowlist(getDefaultPolicy(authority));
}

/**
 * Expose the resolved policy (not just the MCP projection) so callers that
 * want to persist `metadata.roleRuntimePolicy` on freshly-created profiles
 * can do so without re-deriving. Matches migration 425's CEO row shape.
 */
export function buildDefaultRoleRuntimePolicy(authority: AcpAuthority): RoleRuntimePolicy {
  return getDefaultPolicy(authority);
}

export function buildDefaultAcpProfileConfig(input: DefaultAcpProfileInput): Record<string, unknown> {
  const username = input.username?.trim() || 'agent';
  const displayName = input.displayName?.trim() || username;
  const authority = resolveDefaultTaskAuthority(input);
  const mcpAllowlist = buildDefaultMcpAllowlist(authority);
  const operatingPrinciples = buildRoleOperatingPrinciples(authority, displayName);
  const roleRuntimePolicy = buildDefaultRoleRuntimePolicy(authority);

  const roleTemplate = {
    slug: username,
    version: '1.0.0',
    agentType: input.agentType || (authority === 'orchestrator' ? 'orchestrator' : 'specialist'),
    requiredSkills: [],
    mcpServers: [
      {
        name: 'prismer-tasks',
        package: '@prismer/mcp-server',
        transport: 'stdio',
        toolsAllowlist: mcpAllowlist,
      },
    ],
    operatingPrinciples,
    taskAuthority: authority,
    approvalPolicy: 'auto-low-risk' satisfies AcpApprovalPolicy,
    metadata: { roleRuntimePolicy },
  };

  return {
    roleTemplate,
    mcpAllowlist,
    taskAuthority: authority,
    approvalPolicy: 'auto-low-risk' satisfies AcpApprovalPolicy,
    operatingPrinciples,
    // v2.0 — only meaningful for orchestrator; included on all profiles
    // for symmetry so client UIs can render a single uniform "round budget"
    // setting. Specialist agents ignore it.
    maxAutonomousRounds: DEFAULT_MAX_AUTONOMOUS_ROUNDS,
  };
}

export function mergeMissingAcpProfileDefaults(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...config };
  for (const key of ['roleTemplate', 'mcpAllowlist', 'taskAuthority', 'approvalPolicy', 'operatingPrinciples']) {
    if (!Object.prototype.hasOwnProperty.call(next, key) && Object.prototype.hasOwnProperty.call(defaults, key)) {
      next[key] = defaults[key];
    }
  }
  return next;
}
