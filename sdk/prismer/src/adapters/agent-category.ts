/**
 * Runtime-side SSOT for adapter → category and the skill `scope` taxonomy.
 *
 * doc release203/09 §7.6 — built-in skills are split into two verticals
 * (persistence / coding) plus a shared `common` band. The cloud side already
 * owns this mapping in
 * `src/app/workspace/components/unified-creation/pro/profile-config.ts`
 * (`ADAPTER_CATEGORY`), but the daemon cannot import from `src/app` (layer
 * rules), so this is the runtime-local equivalent. Keep the two in sync.
 */

export type AgentCategory = 'persistence' | 'coding' | 'runtime-engine';

export type SkillScope = 'common' | 'persistence' | 'coding' | 'runtime-engine';

/**
 * hermes → persistence; claude-code/codex/opencode → coding;
 * pi-core → runtime-engine (runtime210/09 §2.3 — its own vertical, so
 * coding-scope skills never leak into the pi prompt and vice versa).
 */
export const ADAPTER_CATEGORY: Record<string, AgentCategory> = {
  hermes: 'persistence',
  'claude-code': 'coding',
  codex: 'coding',
  opencode: 'coding',
  'pi-core': 'runtime-engine',
};

/** Resolve an adapter name to its category, or null when the adapter is unknown. */
export function categoryForAdapter(adapterName: string | undefined): AgentCategory | null {
  if (!adapterName) return null;
  return ADAPTER_CATEGORY[adapterName] ?? null;
}

/**
 * A skill belongs to an agent category iff it is `common` (shared by all) or
 * its scope matches the category exactly. Pure helper — no I/O.
 */
export function skillScopeMatchesCategory(scope: SkillScope, category: AgentCategory): boolean {
  return scope === 'common' || scope === category;
}
