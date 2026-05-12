/**
 * Agent kind taxonomy — Wave-7 ζ workspace refactor.
 *
 * Two distinct flavors of agent live side-by-side in a workspace:
 *
 *   1. CLI agents (`kind: 'cli'`) — adapters: codex, claude-code.
 *      Stateless dispatch targets. Run a single bounded prompt with
 *      claude-print or codex-cli, return one result. Deterministic. No
 *      authority to mutate the workspace beyond the task's own output.
 *      Visualised as a terminal icon, neutral chrome.
 *
 *   2. Long-running agents (`kind: 'long-running'`) — adapters: hermes,
 *      openclaw. Persistent role-based agents instantiated from templates
 *      (CEO / Engineer / CMO / COO / Custom). They retain memory across
 *      sessions, can dispatch CLI agents, create groups, DM users, and
 *      manage their own task queues. Functionally peers of the human
 *      operator — power scoped only by what the human authorises.
 *      Visualised with a brain/orb glyph, role badge, vivid accent colour.
 *
 * Backed by the existing `IMAgentCard.metadata.adapter` field so no
 * schema migration is required. The classifier below is the source of
 * truth in UI code; cloud-side will gain a typed column when v1.9.x
 * lands native role tracking.
 */

export type AgentKind = 'cli' | 'long-running';

const CLI_ADAPTERS = new Set(['claude-code', 'codex']);
const LONG_RUNNING_ADAPTERS = new Set(['hermes', 'openclaw']);

/**
 * Read the adapter name out of a card's metadata blob (which arrives as a
 * JSON string for IMAgentCard rows or as an already-parsed object for
 * AgentDTO envelopes). Tolerant of both shapes.
 */
function readAdapter(metadata: unknown): string | null {
  if (!metadata) return null;
  let parsed: Record<string, unknown> | null = null;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof metadata === 'object') {
    parsed = metadata as Record<string, unknown>;
  }
  if (!parsed) return null;
  const adapter = parsed.adapter;
  return typeof adapter === 'string' ? adapter : null;
}

/**
 * Classify an agent by its adapter. Falls back to `'cli'` for unknown
 * adapters — the conservative default since CLI agents have less
 * authority than long-running ones, so misclassifying long-running →
 * cli only undersells UI affordances; misclassifying the other way
 * would inflate trust unhelpfully.
 */
export function classifyAdapter(adapter: string | null | undefined): AgentKind {
  if (!adapter) return 'cli';
  if (LONG_RUNNING_ADAPTERS.has(adapter)) return 'long-running';
  if (CLI_ADAPTERS.has(adapter)) return 'cli';
  return 'cli';
}

export function classifyAgent(opts: { metadata?: unknown; adapterName?: string | null }): AgentKind {
  if (opts.adapterName) return classifyAdapter(opts.adapterName);
  return classifyAdapter(readAdapter(opts.metadata));
}

/**
 * Visual presets keyed by kind. Pick once here, reuse everywhere — keeps
 * the kanban card, LeftRail, channel header, mention picker, and detail
 * drawer perfectly in sync as the kind moves through the UI.
 */
export interface AgentKindPreset {
  label: string;
  shortLabel: string;
  description: string;
  /** Tailwind classes for the gradient halo behind the avatar / icon. */
  haloGradient: string;
  /** Tailwind class fragment for the accent ring/border colour. */
  accentRing: string;
  /** Tailwind class fragment for the chip background tint. */
  chipBg: string;
  /** Tailwind class for accent text. */
  accentText: string;
}

export const AGENT_KIND_PRESETS: Record<AgentKind, AgentKindPreset> = {
  cli: {
    label: 'CLI agent',
    shortLabel: 'CLI',
    description: 'Bounded, deterministic prompt → response. Runs once per task.',
    haloGradient: 'from-cyan-400/30 via-sky-400/20 to-blue-500/30',
    accentRing: 'ring-cyan-400/30',
    chipBg: 'bg-cyan-500/10 text-cyan-200 border-cyan-400/20',
    accentText: 'text-cyan-300',
  },
  'long-running': {
    label: 'Long-running agent',
    shortLabel: 'Lifelong',
    description: 'Persistent role agent. Holds memory, dispatches CLI agents, manages tasks + groups.',
    haloGradient: 'from-violet-400/30 via-fuchsia-400/20 to-rose-400/30',
    accentRing: 'ring-violet-400/40',
    chipBg: 'bg-violet-500/10 text-violet-200 border-violet-400/20',
    accentText: 'text-violet-300',
  },
};

/**
 * Convenience: extract a stable colour seed from a username so two CLI
 * agents with the same kind still get distinguishable avatars. Returns
 * an HSL hue 0-359.
 */
export function nameHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
