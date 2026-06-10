import { DEFAULT_MAX_AUTONOMOUS_ROUNDS, getDefaultPolicy, projectMcpAllowlist, type AcpAuthority } from './policy';
import { buildSkillFirstClause } from './injection';

export interface WorkspaceRolePromptSeed {
  displayName: string;
  rationale: string;
}

export interface WorkspaceRoleTemplateSnapshotInput extends WorkspaceRolePromptSeed {
  slug: string;
  organizationName: string;
  authority: AcpAuthority;
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

export function buildWorkspaceSystemPrompt(input: WorkspaceRolePromptSeed & { organizationName: string }): string {
  return joinLines([
    `你是 ${input.organizationName} 的${input.displayName}。`,
    `组织名称: ${input.organizationName}`,
    `角色职责: ${input.rationale}`,
    '',
    '你在该组织的团队群聊中协作。所有判断、任务拆解、委派和汇报都应围绕该组织上下文。',
    '主动推进低风险事项；遇到破坏性、不可逆或需要业务确认的动作时，使用 human approval 流程。',
  ]);
}

export function buildWorkspaceRoleTemplateSnapshot(input: WorkspaceRoleTemplateSnapshotInput): Record<string, unknown> {
  const policy = getDefaultPolicy(input.authority);
  const mcpAllowlist = projectMcpAllowlist(policy);
  const skillFirstClause = buildSkillFirstClause(input.authority === 'orchestrator');
  const operatingPrinciples = joinLines([
    `[Organization] ${input.organizationName}`,
    `[Role] ${input.displayName} (${input.authority})`,
    input.rationale,
    '',
    skillFirstClause,
    '[Scheduling discipline — v2.0]',
    '- Wait for an explicit human goal before delegating. If no goal is stated in this session, ask "What outcome do you want?" and HOLD; do not pre-dispatch, do not invent goals.',
    '- Track every assignable unit of work with prismer.task.create. Humans are valid assignees — you may assign a task to a human.',
    `- Default autonomous-round budget: ${DEFAULT_MAX_AUTONOMOUS_ROUNDS} (maxAutonomousRounds=${DEFAULT_MAX_AUTONOMOUS_ROUNDS}). After ${DEFAULT_MAX_AUTONOMOUS_ROUNDS} rounds of agent-to-agent dispatch without human input, STOP and call prismer.approval.request_human_approval. You maintain and may reset the counter explicitly.`,
    '- Use prismer.agent.send for verified delegation; use prismer.approval.request_human_approval for human sign-off.',
    '- Decide and act only AFTER the goal is clear. For ambiguous goals, gather context; do not auto-launch multi-agent plans.',
  ]);

  return {
    slug: input.slug,
    version: '1.0.0',
    templateParams: {
      organizationName: input.organizationName,
    },
    requiredSkills: [],
    mcpServers: [
      {
        name: 'prismer-tasks',
        package: '@prismer/mcp-server',
        transport: 'stdio',
        toolsAllowlist: mcpAllowlist,
      },
    ],
    operatingPrinciples: { en: operatingPrinciples },
    taskAuthority: input.authority,
    approvalPolicy: 'auto-low-risk',
    maxAutonomousRounds: DEFAULT_MAX_AUTONOMOUS_ROUNDS,
    metadata: { roleRuntimePolicy: policy },
  };
}

export function buildWorkspaceKickoffMessage(ceoHandle: string): string {
  return `@${ceoHandle} 请你做一下 team kickoff,向大家介绍一下我们这个团队的每位成员和分工，让大家认识一下,然后大家可以各自开始工作。`;
}
