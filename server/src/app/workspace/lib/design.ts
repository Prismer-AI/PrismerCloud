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
  done: {
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
