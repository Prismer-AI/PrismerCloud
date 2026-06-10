/**
 * Evolution Studio v2 — shared types (release201/28 §6.2).
 *
 * Shapes mirror the existing IM endpoints listed in doc 28 §6.2 + the known
 * Prisma columns (IMSkill / IMAgentSkill / IMGene / IMAgentProfile /
 * IMAgentSnapshot / IMRoleTemplate). The mock layer (`./mock`) produces the
 * same shapes so surfaces render identically whether fed by fixtures or the
 * live API — runtime wiring later swaps the source with 0 UI changes.
 *
 * Section-owning agents (Creator / Roster / Lifecycle / …) consume these from
 * here; do not redeclare them per-surface.
 */

import type { SpatialGrammarKey, GrammarAccent } from '@/app/workspace/lib/design';

// ─── Section enum + per-section grammar binding ──────────────────────────────

/** The 8 Studio sections (doc 28 §2.2). `create` = Skill Creator (hero). */
export type StudioSection =
  | 'roster'
  | 'create'
  | 'lifecycle'
  | 'installed'
  | 'genes'
  | 'profiles'
  | 'snapshots'
  | 'templates';

export const STUDIO_SECTIONS: StudioSection[] = [
  'roster',
  'create',
  'lifecycle',
  'installed',
  'genes',
  'profiles',
  'snapshots',
  'templates',
];

/** Sections under the Workspace rail group (agent-agnostic). */
export const WORKSPACE_SECTIONS: StudioSection[] = ['roster', 'create', 'lifecycle'];

/**
 * Sections under the Per-agent rail group (driven by the context chip agent).
 *
 * NOTE (focus on the core path: user material → standardized skill generation →
 * test/optimize → package/publish): `genes`, `profiles` and `snapshots` are
 * intentionally HIDDEN from the nav for now (gene work is off-path; profile data
 * is uncalibrated; snapshots has no real backend). Their surface components and
 * the StudioSection union are kept intact so a deep-link still routes and they
 * can be re-enabled by adding them back here.
 */
export const PER_AGENT_SECTIONS: StudioSection[] = ['installed', 'templates'];

/** Sections hidden from nav but still routable (see note above). */
export const HIDDEN_SECTIONS: StudioSection[] = ['genes', 'profiles', 'snapshots'];

/** Per-section spatial grammar + accent (doc 28 §4 + §5.3). */
export interface SectionGrammar {
  grammar: SpatialGrammarKey;
  accent: GrammarAccent;
}

export const SECTION_GRAMMAR: Record<StudioSection, SectionGrammar> = {
  roster: { grammar: 'map', accent: 'indigo' },
  // Creator uses the workshop grammar (conversational-steering variant) with the
  // brand violet accent (amber/yellow is off-brand — feedback).
  create: { grammar: 'workshop', accent: 'violet' },
  lifecycle: { grammar: 'pipeline', accent: 'cyan' },
  installed: { grammar: 'shelf', accent: 'violet' },
  genes: { grammar: 'garden', accent: 'emerald' },
  profiles: { grammar: 'identityCard', accent: 'rose' },
  snapshots: { grammar: 'vault', accent: 'sky' },
  templates: { grammar: 'atelier', accent: 'indigo' },
};

// ─── URL state ───────────────────────────────────────────────────────────────

export type CreatorSourceKind = 'inline' | 'doc' | 'code' | 'service';

export interface StudioUrlState {
  section: StudioSection;
  agentId: string | null;
  draftId: string | null;
  /** Where the Creator was entered from (pre-selects a source bench chip). */
  from: CreatorSourceKind | null;
}

// ─── Domain summaries (read shapes) ──────────────────────────────────────────

export type AgentRuntimeState = 'idle' | 'thinking' | 'busy' | 'offline';

export interface AgentSummary {
  id: string;
  /** Handle including the leading `@`, e.g. `@ml_agent`. */
  handle: string;
  /** Free-text role line, e.g. `specialist · qa`. */
  type: string;
  state: AgentRuntimeState;
  /** True for the workspace orchestrator (default authoring actor, §3.1). */
  isOrchestrator: boolean;
  skills: number;
  genes: number;
  snapshots: number;
}

export type DraftLifecycleStage =
  | 'draft'
  | 'eval'
  | 'review'
  | 'published'
  | 'archived';

export interface DraftSummary {
  id: string;
  slug: string;
  name: string;
  stage: DraftLifecycleStage;
  /** Manifest revision short hash, e.g. `a3f9`. */
  revision: string | null;
  /** Latest eval pass rate 0..100, null if never evaluated. */
  passRate: number | null;
  createdByAgentId: string | null;
  updatedAt: string;
}

export interface ManifestFile {
  path: string;
  /** Bytes; null until written (skeleton row). */
  size: number | null;
  /** ○ pending → ◉ writing → ● done (doc 28 §3.3.2). */
  status: 'pending' | 'writing' | 'done';
  sha256?: string;
}

export interface SourceRef {
  kind: CreatorSourceKind;
  /** Human ref, e.g. `docs/api/sandboxes.md §Admin`. */
  ref: string;
  bytes: number;
  /** Sub-label, e.g. `fetched · compressed`. */
  meta?: string;
}

export interface EvalCase {
  name: string;
  passed: boolean;
  ms: number;
}

export interface EvalRun {
  runId: string;
  revision: string;
  passRate: number;
  cases: EvalCase[];
}

// ─── Per-agent assets ────────────────────────────────────────────────────────

export interface InstalledSkill {
  skillId: string;
  slug: string;
  name: string;
  version: string;
  /** `ok` (healthy) / `warn` (needs config). */
  health: 'ok' | 'warn';
}

export interface GeneNode {
  id: string;
  title: string;
  /** `capsule` = filled node, `gene` = distilled ring (doc 28 §4.4). */
  kind: 'capsule' | 'gene';
  successRate: number;
  exportedAsSkill: boolean;
}

export interface AgentProfile {
  agentId: string;
  handle: string;
  type: string;
  state: AgentRuntimeState;
  personality: { rigor: number; creativity: number; riskTolerance: number };
  operatingPrinciples: string[];
  workspaceCount: number;
}

export interface AgentSnapshot {
  id: string;
  label: string;
  createdAt: string;
  definitionVersion: string;
  skillCount: number;
  includeMemory: boolean;
  sizeBytes: number;
  createdBy: string;
  status: 'ready' | 'creating' | 'failed';
}

export type CuratedQuality = 'gold' | 'silver' | 'bronze';

export interface RoleTemplate {
  slug: string;
  name: string;
  agentType: string;
  curatedQuality: CuratedQuality | null;
  requiredSkills: string[];
  mcpServers: string[];
  operatingPrinciplesSummary: string;
}

// ─── Workspace overview (orchestrator resolution, §0.2.3) ───────────────────

export interface StudioOverview {
  workspaceId: string;
  workspaceName: string;
  /** Resolved orchestrator agent id; null when none authorized (§3.1 fallback). */
  orchestratorAgentId: string | null;
  agents: AgentSummary[];
}
