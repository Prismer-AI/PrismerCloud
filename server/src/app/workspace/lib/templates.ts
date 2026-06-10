/**
 * Long-running agent role templates — Wave-7 ζ.
 *
 * When a user picks "+ Long-running Agent" they instantiate one of these.
 * Each template ships with:
 *   - A canonical role name (CEO, Engineer, …)
 *   - System prompt seed (loaded into the agent's first AgentProfile)
 *   - Suggested adapter (hermes | openclaw)
 *   - Capability tags (drives discover() + mention picker filtering)
 *   - Authority hints (UI surface — what the user is granting by
 *     instantiating this role)
 *
 * Templates are intentionally OPINIONATED. The user can fork to
 * "Custom" if none fit. We seed five archetypes covering exec / R&D /
 * marketing / ops / product — enough breadth to see the shape without
 * trying to be a marketplace.
 */

import type { LucideIcon } from 'lucide-react';
import { Crown, Wrench, Megaphone, ClipboardCheck, Compass, Sparkles } from 'lucide-react';
import {
  buildChiefOfStaffSystemPrompt,
  buildChiefMarketingSystemPrompt,
  buildChiefOperatingSystemPrompt,
  buildEngineeringLeadSystemPrompt,
  buildProductLeadSystemPrompt,
  getDefaultPolicy,
  projectMcpAllowlist,
} from '@/lib/role-runtime-policy';

export interface AgentRoleTemplate {
  /** Stable id used in dialogs + URL params. */
  id: string;
  /** UI label, e.g. "Chief Executive". */
  label: string;
  /** One-word role chip, e.g. "CEO". */
  roleBadge: string;
  /** Lucide icon shown in the picker tile. */
  icon: LucideIcon;
  /** Tailwind gradient classes for the picker tile halo. */
  gradient: string;
  /** Short pitch shown under the title in the picker. */
  pitch: string;
  /** What this agent is granted authority to do — surfaced as bullets. */
  authority: string[];
  /** Default capability tags persisted with the agent. */
  capabilities: string[];
  /** Default adapter for the AgentProfile. */
  defaultAdapter: 'hermes' | 'openclaw';
  /** System-prompt seed — written into the AgentProfile.config on register. */
  systemPrompt: string;
  /** Optional default agent display-name suffix shown in the form. */
  defaultDisplayName: string;
  /** Default username slug seed. */
  defaultUsernameSeed: string;
}

export function buildRoleTemplateSnapshot(template?: AgentRoleTemplate): Record<string, unknown> | null {
  if (!template || template.id === 'custom') return null;

  // v2.1 (release 201 P0-7) — MCP allowlist is now a projection of the
  // shared RoleRuntimePolicy (`src/lib/role-runtime-policy.ts`). The
  // previous literal `commonTools` + `orchestratorTools` arrays were
  // removed — they had drifted from the backend's profile-defaults.ts
  // (skill_sync alias) and from the seed scripts. One projection function
  // serves backend bootstrap + frontend snapshot + adapter wiring.
  //
  // Only CEO carries orchestrator authority + task.approve/reject/cancel
  // (matches DB migration 425 + profile-defaults.ts ORCHESTRATOR_SLUGS).
  // COO / PM are specialists in the RBAC plane.
  const isOrchestrator = template.id === 'ceo';
  const policy = getDefaultPolicy(isOrchestrator ? 'orchestrator' : 'executor');
  const mcpAllowlist = projectMcpAllowlist(policy);
  const systemPrompt = isOrchestrator ? buildChiefOfStaffSystemPrompt() : template.systemPrompt;

  return {
    slug: template.id,
    version: '1.0.0',
    requiredSkills: [],
    mcpServers: [
      {
        name: 'prismer-tasks',
        package: '@prismer/mcp-server',
        transport: 'stdio',
        toolsAllowlist: mcpAllowlist,
      },
    ],
    operatingPrinciples: { en: systemPrompt },
    taskAuthority: isOrchestrator ? 'orchestrator' : 'executor',
    approvalPolicy: 'auto-low-risk',
    // Surface the unified policy so the daemon side can persist it on
    // first profile create (or use it as the fallback when DB lookup races).
    metadata: { roleRuntimePolicy: policy },
  };
}

export const ROLE_TEMPLATES: AgentRoleTemplate[] = [
  {
    id: 'ceo',
    label: 'Chief Executive',
    roleBadge: 'CEO',
    icon: Crown,
    gradient: 'from-amber-300/40 via-orange-400/30 to-rose-500/40',
    pitch: 'Workspace orchestrator — clarifies goals, routes through built-in skills, delegates tracked work.',
    authority: [
      'Dispatch tasks to any agent in the workspace',
      'Approve / reject / cancel staged work in the kanban Review column',
      'Compose multi-agent groups for cross-functional initiatives',
      'DM operators with summaries + decisions',
      'Routine reversible workspace work pre-authorized when active Chief of Staff',
    ],
    capabilities: ['strategy', 'decision-making', 'review', 'roadmap'],
    defaultAdapter: 'hermes',
    systemPrompt: buildChiefOfStaffSystemPrompt(),
    defaultDisplayName: 'CEO',
    defaultUsernameSeed: 'ceo',
  },
  {
    id: 'engineer',
    label: 'Engineering Lead',
    roleBadge: 'ENG',
    icon: Wrench,
    gradient: 'from-emerald-300/40 via-teal-400/30 to-cyan-500/40',
    pitch: 'Builds and ships. Owns architecture + delegates to CLI agents.',
    authority: [
      'Spawn claude-code / codex CLI agents to write + ship code',
      'Open work tasks against repos in the workspace',
      'Run + interpret test results, file follow-ups',
      'DM the human with code review summaries',
    ],
    capabilities: ['code', 'architecture', 'review', 'shell'],
    defaultAdapter: 'hermes',
    systemPrompt: buildEngineeringLeadSystemPrompt(),
    defaultDisplayName: 'Engineer',
    defaultUsernameSeed: 'eng',
  },
  {
    id: 'cmo',
    label: 'Chief Marketing',
    roleBadge: 'CMO',
    icon: Megaphone,
    gradient: 'from-fuchsia-300/40 via-pink-400/30 to-rose-500/40',
    pitch: 'Voice, narrative, growth. Owns the customer-facing story.',
    authority: [
      'Draft + revise marketing copy via writing-capable CLI agents',
      'Launch growth experiments as tasks',
      'DM stakeholders with weekly narrative updates',
      'Compose group threads for cross-team launches',
    ],
    capabilities: ['copy', 'narrative', 'growth', 'analytics'],
    defaultAdapter: 'hermes',
    systemPrompt: buildChiefMarketingSystemPrompt(),
    defaultDisplayName: 'CMO',
    defaultUsernameSeed: 'cmo',
  },
  {
    id: 'coo',
    label: 'Chief Operating',
    roleBadge: 'COO',
    icon: ClipboardCheck,
    gradient: 'from-sky-300/40 via-indigo-400/30 to-violet-500/40',
    pitch:
      'Process, throughput, accountability. Keeps the kanban honest. (Specialist — escalates approve/reject decisions to CEO.)',
    authority: [
      'Triage incoming tasks — assign or backlog',
      'Reassign blocked work, escalate stale items',
      'Audit cost + time spent by other agents',
      'DM the human with weekly throughput summaries',
      'Escalates approve/reject/cancel decisions to CEO (release 201 — orchestrator authority is CEO-only)',
    ],
    capabilities: ['triage', 'process', 'metrics', 'scheduling'],
    defaultAdapter: 'hermes',
    systemPrompt: buildChiefOperatingSystemPrompt(),
    defaultDisplayName: 'COO',
    defaultUsernameSeed: 'coo',
  },
  {
    id: 'pm',
    label: 'Product Lead',
    roleBadge: 'PM',
    icon: Compass,
    gradient: 'from-lime-300/40 via-green-400/30 to-emerald-500/40',
    pitch: 'Defines what to build and why. Owns specs + acceptance. (Specialist — recommends approve/reject to CEO.)',
    authority: [
      'Author + maintain product specs',
      'Decompose specs into engineering tasks',
      'Recommend approve/reject decisions to CEO (release 201 — orchestrator authority is CEO-only)',
      'DM the operator with weekly product updates',
    ],
    capabilities: ['spec', 'roadmap', 'review', 'research'],
    defaultAdapter: 'hermes',
    systemPrompt: buildProductLeadSystemPrompt(),
    defaultDisplayName: 'PM',
    defaultUsernameSeed: 'pm',
  },
  {
    id: 'custom',
    label: 'Custom role',
    roleBadge: 'CUSTOM',
    icon: Sparkles,
    gradient: 'from-zinc-300/40 via-zinc-400/20 to-zinc-500/30',
    pitch: 'Define your own role from scratch.',
    authority: ['Whatever capabilities you grant in the form', 'You bring the system prompt'],
    capabilities: [],
    defaultAdapter: 'hermes',
    systemPrompt: '',
    defaultDisplayName: '',
    defaultUsernameSeed: '',
  },
];

export function findTemplate(id: string): AgentRoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.id === id);
}
