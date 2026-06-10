/**
 * /workspace design tokens — Wave-7 ζ.
 *
 * Centralises the glass / spring / radius vocabulary so every component
 * speaks the same language. Don't inline ad-hoc Tailwind glass strings —
 * pull from here so the next polish pass touches one file, not nine.
 *
 * Style direction (per user brief):
 *   - Glassmorphism: backdrop-blur-xl + thin white-on-zinc borders +
 *     restrained gradients. Reference /playground.
 *   - Spring-damper physics: framer-motion springs tuned for "expensive"
 *     feel — slightly underdamped so things settle with a single
 *     gentle bounce. Cards land softer than buttons; drawers slower
 *     than chips.
 *   - Comfortable rounded rectangles: rounded-2xl for surfaces,
 *     rounded-xl for cards, rounded-lg for buttons / chips.
 */

import type { Transition } from 'framer-motion';

// ─── Surface presets ───────────────────────────────────────────────

export const surface = {
  /** Floor-level glass — main page panes (left rail, kanban, channel). */
  pane: {
    dark: 'bg-zinc-950/40 backdrop-blur-xl border-white/[0.06]',
    light: 'bg-white/70 backdrop-blur-xl border-zinc-200',
  },
  /** Lifted glass — cards on a pane. */
  card: {
    dark: 'bg-zinc-900/60 backdrop-blur-md border-white/[0.08]',
    light: 'bg-white/80 backdrop-blur-md border-zinc-200',
  },
  /** Highest elevation — dialogs, drawers, popovers. */
  modal: {
    dark: 'bg-zinc-900/85 backdrop-blur-2xl border-white/[0.1] shadow-[0_30px_120px_-20px_rgba(0,0,0,0.7)]',
    light: 'bg-white/90 backdrop-blur-2xl border-zinc-200 shadow-2xl',
  },
  /** Subtle inset surface, e.g. composer / inputs. */
  inset: {
    dark: 'bg-zinc-950/60 border-white/[0.05]',
    light: 'bg-zinc-50/80 border-zinc-200',
  },
};

export function s(theme: 'dark' | 'light', preset: keyof typeof surface): string {
  return surface[preset][theme];
}

// ─── Radius scale ─────────────────────────────────────────────────

export const radius = {
  pane: 'rounded-3xl',
  card: 'rounded-2xl',
  chip: 'rounded-full',
  button: 'rounded-xl',
  small: 'rounded-lg',
};

// ─── Spring presets (framer-motion `transition`) ─────────────────────

/**
 * Slightly underdamped — settles in ~350ms with a gentle overshoot.
 * Use for: cards entering/leaving, kanban column reordering.
 */
export const springSoft: Transition = {
  type: 'spring',
  stiffness: 320,
  damping: 28,
  mass: 0.7,
};

/**
 * Snappy — settles in ~200ms, no visible overshoot. Use for: button
 * presses, hover scale, chip toggles.
 */
export const springSnap: Transition = {
  type: 'spring',
  stiffness: 520,
  damping: 38,
  mass: 0.5,
};

/**
 * Heavy — for big surfaces sliding in. Drawers, modals, hero cards.
 * Underdamped enough to feel expensive but never wobbly.
 */
export const springHeavy: Transition = {
  type: 'spring',
  stiffness: 220,
  damping: 26,
  mass: 1,
};

/**
 * Drag follow — used inside @dnd-kit DragOverlay so the dragged card
 * follows the pointer with subtle springiness instead of a rigid lock.
 */
export const springDrag: Transition = {
  type: 'spring',
  stiffness: 700,
  damping: 40,
  mass: 0.4,
};

// ─── Gradient accents ────────────────────────────────────────────────

export const accentGradients = {
  violet: 'from-violet-500/30 via-fuchsia-500/20 to-rose-500/30',
  cyan: 'from-cyan-400/30 via-sky-400/20 to-blue-500/30',
  emerald: 'from-emerald-400/30 via-teal-400/20 to-cyan-500/30',
  amber: 'from-amber-300/30 via-orange-400/20 to-rose-500/30',
  ghost: 'from-zinc-400/15 via-zinc-400/10 to-zinc-500/15',
};

// ─── Status colour map (kanban + tasks) ─────────────────────────────

export const statusAccent: Record<string, { dot: string; bg: string; text: string; ring: string }> = {
  backlog: {
    dot: 'bg-zinc-400',
    bg: 'bg-zinc-500/10 border-zinc-500/20',
    text: 'text-zinc-300',
    ring: 'ring-zinc-400/20',
  },
  todo: {
    dot: 'bg-sky-400',
    bg: 'bg-sky-500/10 border-sky-500/20',
    text: 'text-sky-200',
    ring: 'ring-sky-400/30',
  },
  in_progress: {
    dot: 'bg-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    text: 'text-amber-200',
    ring: 'ring-amber-400/40',
  },
  review: {
    dot: 'bg-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
    text: 'text-violet-200',
    ring: 'ring-violet-400/40',
  },
  blocked: {
    dot: 'bg-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
    text: 'text-orange-200',
    ring: 'ring-orange-400/40',
  },
  done: {
    dot: 'bg-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    text: 'text-emerald-200',
    ring: 'ring-emerald-400/40',
  },
  completed: {
    dot: 'bg-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    text: 'text-emerald-200',
    ring: 'ring-emerald-400/40',
  },
  failed: {
    dot: 'bg-rose-400',
    bg: 'bg-rose-500/10 border-rose-500/20',
    text: 'text-rose-200',
    ring: 'ring-rose-400/40',
  },
  cancelled: {
    dot: 'bg-zinc-500',
    bg: 'bg-zinc-500/10 border-zinc-500/20',
    text: 'text-zinc-400',
    ring: 'ring-zinc-500/20',
  },
};

// ─── Priority palette ────────────────────────────────────────────────

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export const priorityAccent: Record<TaskPriority, { dot: string; label: string; chipBg: string }> = {
  low: { dot: 'bg-zinc-400', label: 'Low', chipBg: 'bg-zinc-500/10 text-zinc-300' },
  medium: { dot: 'bg-sky-400', label: 'Medium', chipBg: 'bg-sky-500/10 text-sky-200' },
  high: { dot: 'bg-amber-400', label: 'High', chipBg: 'bg-amber-500/10 text-amber-200' },
  urgent: { dot: 'bg-rose-400', label: 'Urgent', chipBg: 'bg-rose-500/10 text-rose-200' },
};

/**
 * Read priority off a TaskDTO's metadata blob. The cloud schema doesn't
 * have a typed priority column yet (Wave-7 follow-up); we read from
 * `metadata.priority` and fall back to derived priority based on
 * deadline / cost. Defaults to 'medium' so cards don't render colourless.
 */
export function readTaskPriority(task: {
  metadata?: Record<string, unknown> | string | null;
  deadline?: string | null;
  budget?: number | null;
}): TaskPriority {
  let meta: Record<string, unknown> = {};
  if (typeof task.metadata === 'string') {
    try {
      meta = JSON.parse(task.metadata) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  } else if (task.metadata && typeof task.metadata === 'object') {
    meta = task.metadata as Record<string, unknown>;
  }
  const explicit = meta.priority;
  if (typeof explicit === 'string' && ['low', 'medium', 'high', 'urgent'].includes(explicit)) {
    return explicit as TaskPriority;
  }
  // derived: deadline within 24h → urgent; budget very large → high
  if (task.deadline) {
    const dt = Date.parse(task.deadline);
    if (Number.isFinite(dt)) {
      const hours = (dt - Date.now()) / 3_600_000;
      if (hours < 24) return 'urgent';
      if (hours < 72) return 'high';
    }
  }
  if (typeof task.budget === 'number' && task.budget > 5000) return 'high';
  return 'medium';
}

// ─── Avatar gradient by hash ─────────────────────────────────────────

const AVATAR_GRADIENTS = [
  ['#a78bfa', '#22d3ee'], // violet → cyan
  ['#fb923c', '#fb7185'], // orange → rose
  ['#34d399', '#22d3ee'], // emerald → cyan
  ['#fbbf24', '#fb923c'], // amber → orange
  ['#f472b6', '#a78bfa'], // pink → violet
  ['#60a5fa', '#a78bfa'], // blue → violet
  ['#22d3ee', '#34d399'], // cyan → emerald
];

export function avatarGradient(seed: string): { from: string; to: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const pair = AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
  return { from: pair[0], to: pair[1] };
}

export function avatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return trimmed.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── Common transitions ─────────────────────────────────────────────

/**
 * Short stagger for entrance animations. Used by hero CTAs, kanban
 * columns, and onboarding cards.
 */
export const stagger = (delay = 0): Transition => ({
  ...springSoft,
  delay,
});

// ─── Wave-13 / S44 — Motion vocab for spatial grammar ───────────────
//
// release201/12 §8.8.6 + release201/13 §3.11 anchor: 5 motion preset
// + 7 spatial grammar token + lifecycleAccent + projectAccent.
// 引用语境见 doc 13 §3.2-§3.8 各 view storyboard。

/**
 * 液态流动 — pipeline 中 draft 球沿阶段移动 / cascade 展开 evidence。
 * 比 springHeavy 更慢更软，给"流体"感。
 * Doc 13 §3.3 Lifecycle pipeline / §3.2 source-bench → workshop 流入。
 */
export const springLiquid: Transition = {
  type: 'spring',
  stiffness: 180,
  damping: 30,
  mass: 1.2,
};

/**
 * 翻转 — chip / 卡片 3D flip。
 * Doc 13 §3.4 Installed chip configure (rotateY 0 → 180).
 */
export const springFlip: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 32,
  mass: 0.6,
};

/**
 * Splat — celebration。distill 完成 / publish 通过 / acceptance 全 passed。
 * 低 damping + 低 mass 让"炸开"感最强，有 1-2 次回弹。
 * Doc 13 §3.6 Evolution distill ring splash / §3.3 publish capsule.
 */
export const springSplat: Transition = {
  type: 'spring',
  stiffness: 600,
  damping: 18,
  mass: 0.4,
};

// ─── Spatial grammar tokens (release201/12 §8.8.6.5) ────────────────
//
// 每个 view 必须 quote 一个 grammar key。同 grammar 的两个 view 必须
// 有可见差异（详 doc 13 §3.11.1 反同质化判据）。

export type SpatialGrammarKey =
  | 'workshop'
  | 'pipeline'
  | 'shelf'
  | 'identityCard'
  | 'garden'
  | 'controlTower'
  | 'map'
  | 'vault'
  | 'atelier';

/**
 * Per-grammar accent palette. Each view must paint its primary affordance
 * with this color family so users get a chromatic "you are in X" signal
 * when they switch sub-tab. See doc 13 §3.11.1 anti-同质化 anchor.
 */
export type GrammarAccent = 'amber' | 'cyan' | 'violet' | 'rose' | 'emerald' | 'sky' | 'indigo';

export interface SpatialGrammarSpec {
  /** Tailwind layout class for the outer container. */
  layout: string;
  /** Human-readable description of each region. */
  regions: Record<string, string>;
  /**
   * Chromatic anchor (doc 13 §3.11 table). Used by view headers / accent
   * rings / chip borders so each view paints a different family.
   */
  accentColor: GrammarAccent;
  /** One-liner primary metaphor — surfaces in dev-tools + visual audit. */
  primaryMetaphor: string;
}

export const spatialGrammar: Record<SpatialGrammarKey, SpatialGrammarSpec> = {
  /** Workshop — 3 列工作流 (input → process → reference). doc 13 §3.2 Authoring.
   *
   * v2.0.8 X1 fix: middle track uses `minmax(0,1fr)` instead of `1fr` so long
   * content in the centre pane wraps/truncates inside its own column instead of
   * overflowing into the reference column. Grid item default `min-width: auto`
   * lets content force the track wider than `1fr` would otherwise allow. */
  workshop: {
    layout: 'grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_320px] gap-4',
    regions: {
      leftPane: 'source-bench (vertical card stack of input sources)',
      centerPane: 'active artifact (manifest tree + monaco editor)',
      rightPane: 'reference panel (stacked fetched cards)',
    },
    accentColor: 'amber',
    primaryMetaphor: 'source-bench → active-draft → reference-panel',
  },
  /** Pipeline — 横向 / 纵向 流 + 移动的 draft 球. doc 13 §3.3 Lifecycle. */
  pipeline: {
    layout: 'flex flex-col gap-6',
    regions: {
      railPane: '11 sub-stage rail with draft ball indicator (flowing)',
      detailPane: 'evidence cascade below the active capsule',
    },
    accentColor: 'cyan',
    primaryMetaphor: 'flowing-draft-ball',
  },
  /** Shelf — agent row × skill chip array (横向 rows). doc 13 §3.4 Installed. */
  shelf: {
    layout: 'flex flex-col gap-4',
    regions: {
      agentRow: 'one row per agent (avatar + skill chip array)',
      beltPane: 'chip strip per row, hover/configure flips chip',
    },
    accentColor: 'violet',
    primaryMetaphor: 'agent-row × skill-chip-array',
  },
  /** Identity card — siri-orb + 卡片堆叠. doc 13 §3.5 Profile. */
  identityCard: {
    layout: 'grid grid-cols-1 lg:grid-cols-[40%_60%] gap-8',
    regions: {
      portraitPane: 'siri-orb avatar (large, state-driven)',
      bioPane: 'principles card stack + memberships narrative',
    },
    accentColor: 'rose',
    primaryMetaphor: 'siri-orb + card-stack',
  },
  /** Garden — force-layout 节点图 + sparkline. doc 13 §3.6 Evolution. */
  garden: {
    layout: 'relative w-full h-full',
    regions: {
      canvas: 'force-layout svg with gene-node clusters',
      timeline: 'bottom sparkline showing capsule velocity',
    },
    accentColor: 'emerald',
    primaryMetaphor: 'gene-node-cluster + sparkline',
  },
  /** Control tower — widget grid. doc 13 §3.7 Metrics. */
  controlTower: {
    layout: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4',
    regions: {
      widgets: 'counter / sparkline / timeseries / bar / table / status-grid',
    },
    accentColor: 'sky',
    primaryMetaphor: 'widget-grid',
  },
  /** Map — 6 区块画布 + 浮动 avatar. doc 13 §3.8 Overview. */
  map: {
    layout: 'relative w-full h-full',
    regions: {
      canvas: '6-zone canvas (tasks / projects / skills / agents / latency / activity)',
      avatars: 'agent avatars float on the most-recent zone',
    },
    accentColor: 'indigo',
    primaryMetaphor: '6-zone-canvas + floating-avatars',
  },
  /** Vault — agent 版本化还原点沿时间轴排列。Snapshots 用。doc 28 §4.5/§5.3. */
  vault: {
    layout: 'flex flex-col gap-6',
    regions: {
      timeline: 'horizontal axis with draggable scrubber + restore-point dots',
      cardPane: 'selected restore-point card (definition + skills + memory + size)',
    },
    accentColor: 'sky',
    primaryMetaphor: 'time machine — scrub history, restore or clone a point',
  },
  /** Atelier — role template 蓝图卡墙，stamp 到 agent。Templates 用。doc 28 §4.6/§5.3. */
  atelier: {
    layout: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4',
    regions: {
      wall: 'blueprint cards (role portrait + curated badge + skillset + mcp)',
      stampTarget: 'top agent chip — drag a blueprint onto it to apply',
    },
    accentColor: 'indigo',
    primaryMetaphor: 'blueprint workshop — stamp a role onto an agent',
  },
};

/**
 * Per-accent Tailwind class bundle. Centralises the "amber view" vs
 * "cyan view" vs ... chromatic identity so the 7 views can each grep
 * their accent without copy-pasting class strings.
 *
 * `text`  — primary text accent (header label / active chip text).
 * `ring`  — focus / selected ring.
 * `bg`    — soft surface tint (panes, chip backgrounds).
 * `dot`   — small status dot.
 * `glow`  — radial glow / pulse colour (CSS `--prismer-glow` var, used by
 *           prismer-flow-down + prismer-gene-pulse keyframes).
 */
export const grammarAccentClasses: Record<
  GrammarAccent,
  { text: string; ring: string; bg: string; dot: string; glow: string }
> = {
  amber: {
    text: 'text-amber-300',
    ring: 'ring-amber-400/40',
    bg: 'bg-amber-500/10 border-amber-500/20',
    dot: 'bg-amber-400',
    glow: 'rgba(251,191,36,0.6)',
  },
  cyan: {
    text: 'text-cyan-300',
    ring: 'ring-cyan-400/40',
    bg: 'bg-cyan-500/10 border-cyan-500/20',
    dot: 'bg-cyan-400',
    glow: 'rgba(34,211,238,0.6)',
  },
  violet: {
    text: 'text-violet-300',
    ring: 'ring-violet-400/40',
    bg: 'bg-violet-500/10 border-violet-500/20',
    dot: 'bg-violet-400',
    glow: 'rgba(167,139,250,0.6)',
  },
  rose: {
    text: 'text-rose-300',
    ring: 'ring-rose-400/40',
    bg: 'bg-rose-500/10 border-rose-500/20',
    dot: 'bg-rose-400',
    glow: 'rgba(251,113,133,0.6)',
  },
  emerald: {
    text: 'text-emerald-300',
    ring: 'ring-emerald-400/40',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    dot: 'bg-emerald-400',
    glow: 'rgba(52,211,153,0.6)',
  },
  sky: {
    text: 'text-sky-300',
    ring: 'ring-sky-400/40',
    bg: 'bg-sky-500/10 border-sky-500/20',
    dot: 'bg-sky-400',
    glow: 'rgba(56,189,248,0.6)',
  },
  indigo: {
    text: 'text-indigo-300',
    ring: 'ring-indigo-400/40',
    bg: 'bg-indigo-500/10 border-indigo-500/20',
    dot: 'bg-indigo-400',
    glow: 'rgba(129,140,248,0.6)',
  },
};

/**
 * S42 — per-grammar named motion presets (doc 13 §3.11.2).
 *
 * Each preset bundles `initial` + `animate` + `transition` for a single
 * named affordance. Views import the preset by name (`slideFromBench`,
 * `flowDownPipeline` …) so the chromatic + motion contract is greppable.
 *
 * Pair with `useReducedMotion()`:
 *
 *   const m = useReducedMotion() ? motionReduced : motionPreset.slideFromBench;
 */
export interface MotionPreset {
  initial: Record<string, number>;
  animate: Record<string, number>;
  transition: Transition;
}

export const motionPreset = {
  /** Authoring — source card slides into the workshop centre. */
  slideFromBench: {
    initial: { x: -40, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    transition: springLiquid,
  },
  /** Lifecycle — draft ball flows down the pipeline. */
  flowDownPipeline: {
    initial: { y: -20, opacity: 0.6 },
    animate: { y: 0, opacity: 1 },
    transition: springLiquid,
  },
  /** Installed — chip lifted off the shelf. */
  pickFromShelf: {
    initial: { scale: 0.9, y: 4 },
    animate: { scale: 1, y: 0 },
    transition: springSnap,
  },
  /** Profile / Installed — card / chip flips on configure. */
  cardFlip: {
    initial: { rotateY: 90 },
    animate: { rotateY: 0 },
    transition: springFlip,
  },
  /** Evolution — gene node grows into the garden. */
  growInGarden: {
    initial: { scale: 0, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    transition: springSoft,
  },
  /**
   * Control tower — counter value springs from 0 to target.
   * Doc 13 §3.7 Metrics. Actual interpolation happens via framer-motion
   * `useSpring()` inside `<SpringCounter>` (see studio/spring-counter.tsx);
   * this preset's `transition` is the spring config (`springSplat`) used
   * by the hook.
   */
  springCounter: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: springSplat,
  },
} as const satisfies Record<string, MotionPreset>;

/** Zero-duration fallback for `prefers-reduced-motion: reduce`. */
export const motionReduced: MotionPreset = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  transition: { duration: 0 },
};

// ─── Lifecycle accent map (release201/08 §9.6) ──────────────────────
//
// Skill lifecycle stage badge 色彩。复用 statusAccent 既有 entries 而非
// 自定义颜色——5 stage 与 5 task status 语义对齐：
//   draft     → backlog   (灰)
//   eval      → todo      (蓝)
//   review    → review    (紫)
//   published → done      (绿)
//   archived  → cancelled (浅灰)

export type SkillLifecycleStage = 'draft' | 'eval' | 'review' | 'published' | 'archived';

export const lifecycleAccent: Record<SkillLifecycleStage, (typeof statusAccent)[string]> = {
  draft: statusAccent.backlog,
  eval: statusAccent.todo,
  review: statusAccent.review,
  published: statusAccent.done,
  archived: statusAccent.cancelled,
};

// ─── Project accent map (release201/09 §8.8) ────────────────────────
//
// 5 色循环 — projects.metadata.color ∈ 1..5。映射到 --chart-1..5 CSS
// vars，确保 dashboard 配色 (12 doc Insights) 与 task-board project
// chip 配色一致（用户从 dashboard 跳到 task-board 时颜色记忆延续）。

export type ProjectColor = 1 | 2 | 3 | 4 | 5;

export interface ProjectAccentSpec {
  dot: string;
  chip: string;
  ring: string;
}

export const projectAccent: Record<ProjectColor, ProjectAccentSpec> = {
  1: {
    dot: 'bg-[var(--chart-1)]',
    chip: 'bg-[var(--chart-1)]/10 text-[var(--chart-1)] border-[var(--chart-1)]/20',
    ring: 'ring-[var(--chart-1)]/30',
  },
  2: {
    dot: 'bg-[var(--chart-2)]',
    chip: 'bg-[var(--chart-2)]/10 text-[var(--chart-2)] border-[var(--chart-2)]/20',
    ring: 'ring-[var(--chart-2)]/30',
  },
  3: {
    dot: 'bg-[var(--chart-3)]',
    chip: 'bg-[var(--chart-3)]/10 text-[var(--chart-3)] border-[var(--chart-3)]/20',
    ring: 'ring-[var(--chart-3)]/30',
  },
  4: {
    dot: 'bg-[var(--chart-4)]',
    chip: 'bg-[var(--chart-4)]/10 text-[var(--chart-4)] border-[var(--chart-4)]/20',
    ring: 'ring-[var(--chart-4)]/30',
  },
  5: {
    dot: 'bg-[var(--chart-5)]',
    chip: 'bg-[var(--chart-5)]/10 text-[var(--chart-5)] border-[var(--chart-5)]/20',
    ring: 'ring-[var(--chart-5)]/30',
  },
};

/**
 * 新建 project 时若 user 未选色，按 hash(project.id) % 5 + 1 自动分配。
 * 同 id 必返同色（hash 稳定）。与 avatarGradient 同型实现（同一 polynomial
 * hash），但取 1..5 因为 project 是 1-indexed。
 */
export function projectColorFromId(projectId: string): ProjectColor {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) {
    h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return ((h % 5) + 1) as ProjectColor;
}
