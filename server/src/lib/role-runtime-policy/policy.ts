/**
 * Unified Role Runtime Policy (release 201 P0-7).
 *
 * Single source for the mapping `(role authority) → (system capability scope)
 *                                              → (transport-specific allowlist)`.
 *
 * Keep this file boring. It owns the canonical policy shape and the MCP
 * projection table; prompt text lives in `prompt-contract.ts`.
 */

export type AcpAuthority = 'executor' | 'orchestrator';

export interface RoleRuntimePolicy {
  version: string;
  systemCapabilities: SystemCapabilities;
  memoryPolicy: MemoryPolicy;
}

export interface SystemCapabilities {
  /**
   * Canonical surface for the role. `built-in-skills+cli` means the agent
   * reaches system capabilities through built-in skills + CLI (the v2.1
   * primary path). MCP allowlist is a derived projection only.
   */
  surface: 'built-in-skills+cli';
  /**
   * Workflow skills the role must have installed. Hard requirement — used
   * by built-in-skill.service.installAllBuiltInsToAgent + role validators.
   */
  requiredWorkflowSkills: string[];
  /**
   * Authority verbs grouped by capability domain. Each verb maps to a
   * concrete MCP tool name (see CAPABILITY_TO_MCP_TOOL). Strip a verb here
   * and the corresponding MCP tool disappears from the projected allowlist.
   */
  authorityScope: AuthorityScope;
  /**
   * Action classes that always require human approval, regardless of
   * Chief-of-Staff pre-authorization. Surface-only — adapters enforce.
   */
  approvalBoundaries: ApprovalBoundary[];
}

export interface AuthorityScope {
  tasks: TaskVerb[];
  agentCoordination: AgentCoordinationVerb[];
  memory: MemoryVerb[];
  assets: AssetVerb[];
  approval: ApprovalVerb[];
  skills: SkillVerb[];
}

export type TaskVerb = 'create' | 'list' | 'get' | 'update' | 'complete' | 'approve' | 'reject' | 'cancel';
export type AgentCoordinationVerb = 'discover' | 'listConversationAgents' | 'sendToAgent' | 'sendFile';
export type MemoryVerb = 'read' | 'write' | 'recall';
export type AssetVerb = 'search' | 'describe' | 'read';
export type ApprovalVerb = 'requestHumanApproval';
export type SkillVerb = 'listInstalled' | 'showContent' | 'sync';

export type ApprovalBoundary =
  | 'destructive'
  | 'irreversible'
  | 'spend'
  | 'external-publish'
  | 'policy'
  | 'credential'
  | 'data-export';

export interface MemoryPolicy {
  writeScopes: MemoryScope[];
  readScopes: MemoryScope[];
  recallPlan: RecallPass[];
  sourceStampRequired: boolean;
}

export type MemoryScope =
  | 'workspace-public'
  | 'workspace-shared'
  | 'role-self'
  | 'role-shared'
  | 'agent-self'
  | 'agent-private'
  | 'orchestrator-workspace';

export interface RecallPass {
  pass: 'workspace-public' | 'role-sourced' | 'agent-private';
  topK: number;
}

export const DEFAULT_MAX_AUTONOMOUS_ROUNDS = 5;

/**
 * Verb → MCP tool name mapping. ANY change to the MCP tool surface MUST be
 * reflected here; the projection function below trusts this table.
 *
 * Tools that have no policy-verb counterpart (e.g. `prismer.message.send` is
 * implicit in agent-coordination.sendToAgent) are grouped under their
 * closest verb so that adding/removing the verb adds/removes them together.
 */
const CAPABILITY_TO_MCP_TOOL: {
  tasks: Record<TaskVerb, readonly string[]>;
  agentCoordination: Record<AgentCoordinationVerb, readonly string[]>;
  memory: Record<MemoryVerb, readonly string[]>;
  assets: Record<AssetVerb, readonly string[]>;
  approval: Record<ApprovalVerb, readonly string[]>;
  skills: Record<SkillVerb, readonly string[]>;
} = {
  tasks: {
    create: ['prismer.task.create'],
    list: ['prismer.task.list'],
    get: ['prismer.task.get'],
    update: ['prismer.task.update'],
    complete: ['prismer.task.complete'],
    approve: ['prismer.task.approve'],
    reject: ['prismer.task.reject'],
    cancel: ['prismer.task.cancel'],
  },
  agentCoordination: {
    discover: ['prismer.conversation.listAgents'],
    listConversationAgents: ['prismer.conversation.listAgents'],
    sendToAgent: ['prismer.agent.send', 'prismer.message.send'],
    sendFile: ['prismer.message.sendFile'],
  },
  memory: {
    read: ['prismer.memory.read'],
    write: ['prismer.memory.write'],
    recall: ['prismer.memory.recall'],
  },
  assets: {
    search: ['prismer.asset.search'],
    describe: ['prismer.asset.describe'],
    read: ['prismer.asset.read'],
  },
  approval: {
    requestHumanApproval: ['prismer.approval.request_human_approval'],
  },
  skills: {
    listInstalled: ['prismer.skill.installed'],
    showContent: [], // content show is read-side, no dedicated tool yet
    sync: ['prismer.skill.sync'],
  },
};

/**
 * Project a RoleRuntimePolicy down to the MCP tool allowlist. Order-stable
 * across runs so DB snapshots / projections compare cleanly. De-dups when
 * two verbs map to the same tool (e.g. discover + listConversationAgents).
 */
export function projectMcpAllowlist(policy: RoleRuntimePolicy): string[] {
  const tools = new Set<string>();
  const scope = policy.systemCapabilities.authorityScope;

  for (const verb of scope.tasks) for (const t of CAPABILITY_TO_MCP_TOOL.tasks[verb] ?? []) tools.add(t);
  for (const verb of scope.agentCoordination)
    for (const t of CAPABILITY_TO_MCP_TOOL.agentCoordination[verb] ?? []) tools.add(t);
  for (const verb of scope.memory) for (const t of CAPABILITY_TO_MCP_TOOL.memory[verb] ?? []) tools.add(t);
  for (const verb of scope.assets) for (const t of CAPABILITY_TO_MCP_TOOL.assets[verb] ?? []) tools.add(t);
  for (const verb of scope.approval) for (const t of CAPABILITY_TO_MCP_TOOL.approval[verb] ?? []) tools.add(t);
  for (const verb of scope.skills) for (const t of CAPABILITY_TO_MCP_TOOL.skills[verb] ?? []) tools.add(t);

  // Stable lexicographic order. The previous literal arrays in
  // profile-defaults.ts were in semantic order; lexicographic is just as
  // valid and protects against drift between callers.
  return [...tools].sort();
}

/**
 * Baseline executor policy — what every active non-CEO role gets by default.
 * Mirrors migration 425's non-CEO authority shape (no task.approve/reject/cancel).
 */
export const DEFAULT_SPECIALIST_POLICY: RoleRuntimePolicy = {
  version: '2.1.0',
  systemCapabilities: {
    surface: 'built-in-skills+cli',
    requiredWorkflowSkills: ['tasks', 'agent-coordination', 'memory', 'assets'],
    authorityScope: {
      tasks: ['create', 'list', 'get', 'update', 'complete'],
      agentCoordination: ['discover', 'listConversationAgents', 'sendToAgent', 'sendFile'],
      memory: ['read', 'write', 'recall'],
      assets: ['search', 'describe', 'read'],
      approval: ['requestHumanApproval'],
      skills: ['listInstalled', 'sync'],
    },
    approvalBoundaries: [
      'destructive',
      'irreversible',
      'spend',
      'external-publish',
      'policy',
      'credential',
      'data-export',
    ],
  },
  memoryPolicy: {
    writeScopes: ['workspace-shared', 'agent-private'],
    readScopes: ['workspace-public', 'role-self', 'agent-self'],
    recallPlan: [
      { pass: 'workspace-public', topK: 3 },
      { pass: 'role-sourced', topK: 2 },
      { pass: 'agent-private', topK: 2 },
    ],
    sourceStampRequired: true,
  },
};

/**
 * Baseline orchestrator policy — CEO scope. Adds task.approve/reject/cancel
 * + orchestrator-workspace memory read + role-shared write.
 */
export const DEFAULT_ORCHESTRATOR_POLICY: RoleRuntimePolicy = {
  version: '2.1.0',
  systemCapabilities: {
    surface: 'built-in-skills+cli',
    requiredWorkflowSkills: ['tasks', 'agent-coordination', 'human-approval', 'memory', 'assets', 'ingest'],
    authorityScope: {
      tasks: ['create', 'list', 'get', 'update', 'complete', 'approve', 'reject', 'cancel'],
      agentCoordination: ['discover', 'listConversationAgents', 'sendToAgent', 'sendFile'],
      memory: ['read', 'write', 'recall'],
      assets: ['search', 'describe', 'read'],
      approval: ['requestHumanApproval'],
      skills: ['listInstalled', 'showContent', 'sync'],
    },
    approvalBoundaries: [
      'destructive',
      'irreversible',
      'spend',
      'external-publish',
      'policy',
      'credential',
      'data-export',
    ],
  },
  memoryPolicy: {
    writeScopes: ['workspace-shared', 'agent-private', 'role-shared'],
    readScopes: ['workspace-public', 'role-self', 'agent-self', 'orchestrator-workspace'],
    recallPlan: [
      { pass: 'workspace-public', topK: 3 },
      { pass: 'role-sourced', topK: 3 },
      { pass: 'agent-private', topK: 2 },
    ],
    sourceStampRequired: true,
  },
};

export function getDefaultPolicy(authority: AcpAuthority): RoleRuntimePolicy {
  return authority === 'orchestrator' ? DEFAULT_ORCHESTRATOR_POLICY : DEFAULT_SPECIALIST_POLICY;
}

/**
 * Backward-compatible wrappers for the previous flat-module API.
 * These stay exported so existing consumers can migrate gradually.
 */
export function buildDefaultMcpAllowlist(authority: AcpAuthority): string[] {
  return projectMcpAllowlist(getDefaultPolicy(authority));
}

export function buildDefaultRoleRuntimePolicy(authority: AcpAuthority): RoleRuntimePolicy {
  return getDefaultPolicy(authority);
}
