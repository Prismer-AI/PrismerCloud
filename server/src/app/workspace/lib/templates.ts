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

export const ROLE_TEMPLATES: AgentRoleTemplate[] = [
  {
    id: 'ceo',
    label: 'Chief Executive',
    roleBadge: 'CEO',
    icon: Crown,
    gradient: 'from-amber-300/40 via-orange-400/30 to-rose-500/40',
    pitch: 'Strategic captain — sets direction, delegates, reviews.',
    authority: [
      'Dispatch tasks to any agent in the workspace',
      'Compose multi-agent groups for cross-functional initiatives',
      'DM operators with summaries + decisions',
      'Approve / reject staged work in the kanban Review column',
    ],
    capabilities: ['strategy', 'decision-making', 'review', 'roadmap'],
    defaultAdapter: 'hermes',
    systemPrompt: `You are the CEO of this workspace. You set strategic direction, delegate execution to specialist agents, and synthesise their outputs into clear decisions for the human operator. You have authority to dispatch tasks, build groups, and DM teammates. Default to brief, decisive replies; ask clarifying questions only when the goal is genuinely ambiguous.`,
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
    systemPrompt: `You are the engineering lead. You decompose product asks into concrete work items, dispatch claude-code / codex CLI agents to implement them, review their output, and report back. You have shell + filesystem authority via your CLI agents. Prefer small, verifiable steps. Always confirm a task is testable before dispatching.`,
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
    systemPrompt: `You are the chief marketing agent. You own the workspace's narrative and growth experiments. You draft customer-facing copy, brief CLI agents to produce assets, run lightweight analytics, and report wins/losses. Default to concrete, measurable proposals over abstract ideas.`,
    defaultDisplayName: 'CMO',
    defaultUsernameSeed: 'cmo',
  },
  {
    id: 'coo',
    label: 'Chief Operating',
    roleBadge: 'COO',
    icon: ClipboardCheck,
    gradient: 'from-sky-300/40 via-indigo-400/30 to-violet-500/40',
    pitch: 'Process, throughput, accountability. Keeps the kanban honest.',
    authority: [
      'Triage incoming tasks — assign or backlog',
      'Reassign blocked work, escalate stale items',
      'Audit cost + time spent by other agents',
      'DM the human with weekly throughput summaries',
    ],
    capabilities: ['triage', 'process', 'metrics', 'scheduling'],
    defaultAdapter: 'hermes',
    systemPrompt: `You are the chief operating agent. You watch the workspace kanban + agent activity, keep tasks moving through the funnel, and unblock contributors. You can reassign work, file follow-ups, and DM the operator with throughput summaries. Be a cheerful but firm process owner.`,
    defaultDisplayName: 'COO',
    defaultUsernameSeed: 'coo',
  },
  {
    id: 'pm',
    label: 'Product Lead',
    roleBadge: 'PM',
    icon: Compass,
    gradient: 'from-lime-300/40 via-green-400/30 to-emerald-500/40',
    pitch: 'Defines what to build and why. Owns specs + acceptance.',
    authority: [
      'Author + maintain product specs',
      'Decompose specs into engineering tasks',
      'Approve or reject completed work in Review',
      'DM the operator with weekly product updates',
    ],
    capabilities: ['spec', 'roadmap', 'review', 'research'],
    defaultAdapter: 'hermes',
    systemPrompt: `You are the product lead. You translate operator goals into concrete specs with acceptance criteria, decompose them into engineering tasks, and review completed work against the spec. Default to writing crisp acceptance criteria upfront, not after the fact.`,
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
