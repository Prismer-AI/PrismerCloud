/**
 * Evolution Studio v2 — mock fixtures (release201/28 §6.2).
 *
 * Same shapes as the live endpoints (see ../types) so every surface renders
 * identically whether fed by these fixtures (`FF_STUDIO_MOCK`) or the API.
 * Mirrors the prototype's mock data (docs/release201/proto/evolution-studio.html).
 *
 * `simulateAuthoringRun()` replays a phased AuthoringEvent timeline (file.writing
 * → file.written → source.pulled → eval.progress → eval.finished) so the Skill
 * Creator is fully point-through-able offline, matching the prototype's scripted
 * timing.
 */

import type { AuthoringEvent } from '../authoring-events';
import type {
  AgentProfile,
  AgentSnapshot,
  AgentSummary,
  DraftSummary,
  EvalRun,
  GeneNode,
  InstalledSkill,
  ManifestFile,
  RoleTemplate,
  SourceRef,
  StudioOverview,
} from '../types';

// ─── Agents / overview ────────────────────────────────────────────────────────

export const MOCK_AGENTS: AgentSummary[] = [
  { id: 'agt_ml', handle: '@ml_agent', type: 'specialist · prismer-base', state: 'thinking', isOrchestrator: false, skills: 4, genes: 3, snapshots: 2 },
  { id: 'agt_ceo', handle: '@ceo', type: 'orchestrator', state: 'idle', isOrchestrator: true, skills: 7, genes: 5, snapshots: 4 },
  { id: 'agt_qa', handle: '@qa_bot', type: 'specialist · qa', state: 'busy', isOrchestrator: false, skills: 3, genes: 1, snapshots: 1 },
  { id: 'agt_doc', handle: '@doc_writer', type: 'specialist', state: 'idle', isOrchestrator: false, skills: 5, genes: 2, snapshots: 3 },
  { id: 'agt_ops', handle: '@ops', type: 'specialist · sre', state: 'idle', isOrchestrator: false, skills: 6, genes: 4, snapshots: 2 },
];

export const MOCK_OVERVIEW: StudioOverview = {
  workspaceId: 'wsp_acme',
  workspaceName: 'Acme Co',
  orchestratorAgentId: 'agt_ceo',
  agents: MOCK_AGENTS,
};

// ─── Drafts / lifecycle ─────────────────────────────────────────────────────

export const MOCK_DRAFTS: DraftSummary[] = [
  { id: 'drf_admin', slug: 'sandbox-admin-debug', name: 'Sandbox Admin Debug', stage: 'draft', revision: 'a3f9', passRate: null, createdByAgentId: 'agt_ceo', updatedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
  { id: 'drf_summr', slug: 'paper-summr', name: 'Paper Summariser', stage: 'eval', revision: 'b1c2', passRate: 88, createdByAgentId: 'agt_ml', updatedAt: new Date(Date.now() - 36 * 60_000).toISOString() },
  { id: 'drf_regr', slug: 'regression-guard', name: 'Regression Guard', stage: 'review', revision: 'd4e5', passRate: 92, createdByAgentId: 'agt_qa', updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
];

// ─── Creator artifact (manifest + sources + eval) ─────────────────────────────

export const MOCK_MANIFEST: ManifestFile[] = [
  { path: 'SKILL.md', size: null, status: 'pending' },
  { path: 'references/sandboxes-admin.md', size: null, status: 'pending' },
  { path: 'scripts/call-admin.ts', size: null, status: 'pending' },
  { path: 'skill.json', size: null, status: 'pending' },
];

/** Final sizes (bytes) keyed by path — used to settle the skeleton rows. */
export const MOCK_MANIFEST_SIZES: Record<string, number> = {
  'SKILL.md': 4300,
  'references/sandboxes-admin.md': 5200,
  'scripts/call-admin.ts': 1100,
  'skill.json': 900,
};

export const MOCK_SOURCE_REFS: SourceRef[] = [
  { kind: 'doc', ref: 'docs/api/sandboxes.md §Admin', bytes: 5200, meta: 'fetched · compressed' },
];

export const MOCK_EVAL_RUN: EvalRun = {
  runId: 'run_a3f9_2',
  revision: '2',
  passRate: 80,
  cases: [
    { name: 'pod stuck → bundle returns logs', passed: true, ms: 1200 },
    { name: 'task id → db slice present', passed: true, ms: 800 },
    { name: 'redacts secrets in output', passed: true, ms: 1000 },
    { name: 'unknown entity → graceful 404', passed: false, ms: 600 },
    { name: 'workspace → events fanned out', passed: true, ms: 1400 },
  ],
};

export const MOCK_SKILL_MD = `---
name: sandbox-admin-debug
description: Pull cloud logs, K8s pod logs/events, daemon healthz and DB
  snapshots for a workspace, task or pod. Use when debugging "why is X stuck".
license: MIT
---

# Sandbox Admin Debug

Composite debug bundle over the admin endpoints. Resolves an entity
(\`workspace\` / \`task\` / \`pod\`) and fans out across logs, events, daemon
state and a DB slice.

## Workflow
- Resolve entity id from the prompt
- \`call-admin.ts\` hits \`/_admin/debug-bundle\`
- Redact secrets, summarise top errors
`;

export const MOCK_SKILL_JSON = `{
  "slug": "sandbox-admin-debug",
  "version": "0.1.0",
  "compatibility": ["hermes"],
  "inputs": [{ "name": "entity", "required": true }],
  "sampleTasks": 3,
  "security": { "dataAccess": ["external-network"] }
}`;

// ─── Per-agent assets ────────────────────────────────────────────────────────

export const MOCK_INSTALLED: Record<string, InstalledSkill[]> = {
  agt_ml: [
    { skillId: 'skl_paper', slug: 'paper-summr', name: 'Paper Summariser', version: 'v1.2', health: 'ok' },
    { skillId: 'skl_websearch', slug: 'web-search', name: 'Web Search', version: 'v0.4', health: 'ok' },
    { skillId: 'skl_mdedit', slug: 'md-edit', name: 'Markdown Edit', version: 'v3.0', health: 'warn' },
    { skillId: 'skl_admin', slug: 'sandbox-admin-debug', name: 'Sandbox Admin Debug', version: 'v0.1', health: 'ok' },
  ],
  agt_ceo: [
    { skillId: 'skl_coord', slug: 'agent-coord', name: 'Agent Coordination', version: 'v2.1', health: 'ok' },
    { skillId: 'skl_plan', slug: 'planner', name: 'Planner', version: 'v1.0', health: 'ok' },
    { skillId: 'skl_insights', slug: 'insights', name: 'Insights', version: 'v0.7', health: 'ok' },
  ],
  agt_qa: [
    { skillId: 'skl_pw', slug: 'playwright-run', name: 'Playwright Runner', version: 'v1.4', health: 'ok' },
    { skillId: 'skl_regr', slug: 'regression', name: 'Regression', version: 'v0.9', health: 'warn' },
  ],
};

export const MOCK_GENES: Record<string, GeneNode[]> = {
  agt_ml: [
    { id: 'gen_summ', title: 'summarise-long-doc', kind: 'gene', successRate: 0.91, exportedAsSkill: true },
    { id: 'cap_chunk', title: 'chunk-retry-capsule', kind: 'capsule', successRate: 0.84, exportedAsSkill: false },
    { id: 'cap_cite', title: 'citation-format-capsule', kind: 'capsule', successRate: 0.77, exportedAsSkill: false },
  ],
};

export const MOCK_PROFILES: Record<string, AgentProfile> = {
  agt_ml: {
    agentId: 'agt_ml',
    handle: '@ml_agent',
    type: 'specialist · prismer-base',
    state: 'thinking',
    personality: { rigor: 0.8, creativity: 0.6, riskTolerance: 0.4 },
    operatingPrinciples: ['Cite sources before asserting', 'Prefer reproducible scripts', 'Fail loud, never silently'],
    workspaceCount: 3,
  },
};

export const MOCK_SNAPSHOTS: Record<string, AgentSnapshot[]> = {
  agt_ml: [
    { id: 'snp_1', label: 'Apr 12', createdAt: '2026-04-12T10:00:00Z', definitionVersion: 'v1', skillCount: 2, includeMemory: false, sizeBytes: 64 * 1024 * 1024, createdBy: '@founder', status: 'ready' },
    { id: 'snp_2', label: 'Apr 28', createdAt: '2026-04-28T10:00:00Z', definitionVersion: 'v2', skillCount: 3, includeMemory: false, sizeBytes: 96 * 1024 * 1024, createdBy: '@founder', status: 'ready' },
    { id: 'snp_3', label: 'May 20', createdAt: '2026-05-20T14:32:00Z', definitionVersion: 'v3', skillCount: 4, includeMemory: true, sizeBytes: 128 * 1024 * 1024, createdBy: '@founder', status: 'ready' },
    { id: 'snp_4', label: 'May 28', createdAt: '2026-05-28T09:00:00Z', definitionVersion: 'v3', skillCount: 4, includeMemory: true, sizeBytes: 132 * 1024 * 1024, createdBy: '@founder', status: 'ready' },
  ],
};

export const MOCK_TEMPLATES: RoleTemplate[] = [
  { slug: 'ceo', name: 'CEO', agentType: 'orchestrator', curatedQuality: 'gold', requiredSkills: ['agent-coord', 'planner', 'insights'], mcpServers: ['filesystem', 'web', 'calendar'], operatingPrinciplesSummary: 'Coordinate the fleet, set priorities, unblock.' },
  { slug: 'skill-author', name: 'skill-author', agentType: 'specialist', curatedQuality: 'gold', requiredSkills: ['skill-authoring', 'ingest', 'assets', 'agent-coordination'], mcpServers: [], operatingPrinciplesSummary: 'Turn intents and sources into verifiable skills.' },
  { slug: 'qa', name: 'QA', agentType: 'specialist', curatedQuality: 'silver', requiredSkills: ['playwright-run', 'regression', 'reporter'], mcpServers: ['browser'], operatingPrinciplesSummary: 'Reproduce, isolate, prove fixed.' },
  { slug: 'doc-writer', name: 'doc-writer', agentType: 'specialist', curatedQuality: 'bronze', requiredSkills: ['assets', 'md-edit', 'screenshot', 'publish'], mcpServers: [], operatingPrinciplesSummary: 'Clear, sourced, skimmable docs.' },
];

// ─── Simulated AuthoringEvent timeline (Creator demo) ────────────────────────

/**
 * Replay a phased AuthoringEvent stream for a draft, mirroring the prototype's
 * scripted timing: phase → source pull → file writing/written (per file) →
 * eval per-case → eval finished → done.
 *
 * Returns a `cancel()` that clears pending timers — callers MUST invoke it on
 * unmount so a navigated-away Creator stops emitting (no leaked timers).
 */
export function simulateAuthoringRun(
  draftId: string,
  emit: (event: AuthoringEvent) => void,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let t = 0;
  const at = (ms: number, fn: () => void) => {
    t += ms;
    timers.push(setTimeout(fn, t));
  };

  at(300, () => emit({ type: 'authoring.phase', draftId, phase: 'intent' }));
  at(600, () =>
    emit({
      type: 'authoring.message',
      draftId,
      role: 'agent',
      text: 'Got it — I suggest slug sandbox-admin-debug. Confirm?',
      quickReplies: [
        { label: 'Use this', action: 'confirm' },
        { label: 'Rename', action: 'rename' },
      ],
    }),
  );
  at(900, () => emit({ type: 'authoring.phase', draftId, phase: 'fetch' }));
  at(700, () =>
    emit({ type: 'authoring.source.pulled', draftId, kind: 'doc', ref: 'docs/api/sandboxes.md §Admin', bytes: 5200 }),
  );
  at(500, () => emit({ type: 'authoring.phase', draftId, phase: 'compose' }));

  for (const file of MOCK_MANIFEST) {
    at(400, () => emit({ type: 'authoring.file.writing', draftId, path: file.path }));
    at(900, () =>
      emit({
        type: 'authoring.file.written',
        draftId,
        path: file.path,
        size: MOCK_MANIFEST_SIZES[file.path] ?? 0,
        sha256: 'a3f9' + file.path.length,
      }),
    );
  }

  at(600, () => emit({ type: 'authoring.phase', draftId, phase: 'eval' }));
  MOCK_EVAL_RUN.cases.forEach((c, i) => {
    at(700, () =>
      emit({
        type: 'eval.progress',
        draftId,
        runId: MOCK_EVAL_RUN.runId,
        caseIndex: i,
        total: MOCK_EVAL_RUN.cases.length,
        passed: c.passed,
        ms: c.ms,
      }),
    );
  });
  at(500, () =>
    emit({ type: 'eval.finished', draftId, runId: MOCK_EVAL_RUN.runId, passRate: MOCK_EVAL_RUN.passRate, revision: MOCK_EVAL_RUN.revision }),
  );
  at(300, () => emit({ type: 'authoring.phase', draftId, phase: 'done' }));

  return () => {
    for (const id of timers) clearTimeout(id);
    timers.length = 0;
  };
}
