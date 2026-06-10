/**
 * Agent role → Lucide icon map.
 *
 * The kanban / contact / inspector surfaces previously rendered every agent
 * with the same `<Bot />` glyph regardless of their role, which made it
 * impossible to tell a CEO from an engineer at a glance. This map covers
 * the 24 role slugs declared in `lib/templates/data/pack-*.json` plus the
 * common C-suite variants users frequently rename to.
 *
 * Lookup is case-insensitive on the slug. Unknown slugs fall back to
 * `Bot` — same as before — so introducing a new role is non-breaking even
 * if the icon table hasn't been updated yet.
 *
 * Icons are intentionally restricted to lucide-react's flat-line set so
 * they sit consistently inside the small 12-24px circular avatars used
 * across the workspace.
 */

import {
  BadgeCheck,
  BarChart3,
  Bot,
  BookOpen,
  Briefcase,
  ClipboardList,
  Code2,
  Cog,
  Compass,
  Crown,
  DollarSign,
  FileText,
  FlaskConical,
  Handshake,
  HardHat,
  Headphones,
  Megaphone,
  Microscope,
  Palette,
  PenTool,
  Scale,
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Target,
  TrendingUp,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** Catalog role slugs known to ship from `lib/templates/data/pack-*.json`. */
const ROLE_ICONS: Record<string, LucideIcon> = {
  // ── C-suite ────────────────────────────────────────────────────────
  ceo: Crown,
  cto: Code2,
  cmo: Megaphone,
  coo: Settings,
  cfo: DollarSign,
  cso: ShieldCheck,

  // ── Template pack slugs (24 today) ─────────────────────────────────
  'account-manager': Handshake,
  analyst: BarChart3,
  'chief-of-staff': ClipboardList,
  'chief-scientist': FlaskConical,
  comms: Megaphone,
  designer: Palette,
  engineer: Wrench,
  hr: UserCheck,
  'hr-safety': HardHat,
  'ip-legal': Scale,
  'lab-manager': FlaskConical,
  legal: Scale,
  marketer: Megaphone,
  merchandiser: ShoppingBag,
  operations: Cog,
  pm: Compass,
  policy: BookOpen,
  procurement: ShoppingCart,
  quality: BadgeCheck,
  researcher: Microscope,
  salesperson: TrendingUp,
  support: Headphones,
  writer: PenTool,

  // ── Common aliases / free-form labels users tend to set ────────────
  developer: Code2,
  dev: Code2,
  programmer: Code2,
  product: Compass,
  pm_owner: Compass,
  marketing: Megaphone,
  sales: TrendingUp,
  customer_success: Headphones,
  finance: DollarSign,
  hr_manager: UserCheck,
  executive: Briefcase,
  manager: Briefcase,
  ops: Cog,
  qa: BadgeCheck,
  test: BadgeCheck,
  doc: FileText,
  docs: FileText,
};

/** Probe a single candidate string against the role map. */
function lookupRole(candidate: string | null | undefined): LucideIcon | null {
  if (!candidate) return null;
  const key = candidate.trim().toLowerCase().replace(/\s+/g, '-');
  if (!key) return null;
  if (key in ROLE_ICONS) return ROLE_ICONS[key];
  // Try a stripped variant — drop any cuid suffix like `engineer-abc123`
  // since IMUser.username is auto-minted in that shape.
  const head = key.split('-')[0];
  if (head && head in ROLE_ICONS) return ROLE_ICONS[head];
  return null;
}

/**
 * Resolve an agent's role string (slug, free-form label, or null) to a
 * Lucide icon component. Accepts a single string OR an ordered array of
 * candidates — the first one that maps to a known role wins. Falls back to
 * `Bot` when none resolve.
 *
 * The array form is the recommended call shape from avatar code: pass
 * `[agent.agentType, agent.name, agent.username]` so a generic
 * `agentType='agent'` doesn't shadow a meaningful name like `CEO`.
 */
export function getAgentRoleIcon(
  role: string | null | undefined | Array<string | null | undefined>,
): LucideIcon {
  if (Array.isArray(role)) {
    for (const candidate of role) {
      const hit = lookupRole(candidate);
      if (hit) return hit;
    }
    return Bot;
  }
  return lookupRole(role) ?? Bot;
}
