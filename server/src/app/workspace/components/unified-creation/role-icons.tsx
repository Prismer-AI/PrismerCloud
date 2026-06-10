/**
 * Role-slug → lucide line icon map.
 *
 * Shared by SimpleStep2Team (recommended row icons) and SimpleStep2RolePicker
 * (popover row icons). Mirrors the Step 1 industry-icon refactor — replaces
 * the emoji `role.defaultIcon` from JSON SoT with elegant flat-style
 * `lucide-react` icons.
 *
 * Choice notes:
 *   - Each icon is `h-5 w-5` at strokeWidth 1.5 — slightly smaller than the
 *     Step 1 industry icons (28×28) because role rows are denser
 *   - Color: idle `text-zinc-{400,500}`, selected/recommended `text-violet-500`
 *   - Some slugs collide in semantic meaning (e.g. `comms` ≈ marketer broadcast)
 *     — we pick the closest distinct icon to keep the visual grid scannable
 *   - The JSON `defaultIcon` emoji stays in SoT for backwards compatibility
 *     and is shown elsewhere (eg agent card avatar fallback) but never here
 */

import {
  Atom,
  BadgeCheck,
  BookOpen,
  Brain,
  Briefcase,
  CalendarCheck,
  CircleDollarSign,
  ClipboardList,
  Code,
  Compass,
  Cpu,
  Crown,
  FlaskConical,
  Gamepad2,
  Globe,
  GraduationCap,
  HardHat,
  Headphones,
  Layers,
  LifeBuoy,
  LineChart,
  Megaphone,
  Microscope,
  Package,
  Palette,
  PenLine,
  Radio,
  Rocket,
  Scale,
  Scissors,
  ScrollText,
  ShoppingCart,
  Sparkles,
  Target,
  TestTube,
  Truck,
  User,
  UserCheck,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const ROLE_ICON_BY_SLUG: Record<string, LucideIcon> = {
  // Core
  ceo: Crown,
  marketer: Megaphone,
  salesperson: CircleDollarSign,
  operations: Workflow,
  finance: BadgeCheck, // money-management — alternatives: Wallet, PiggyBank
  // IT / Software pack
  cto: Cpu,
  engineer: Code,
  designer: Palette,
  pm: Compass,
  hr: Users,
  // Retail pack
  support: Headphones,
  merchandiser: Package,
  analyst: LineChart,
  // Service pack
  'account-manager': UserCheck,
  legal: Scale,
  // Research pack
  researcher: FlaskConical,
  writer: PenLine,
  'lab-manager': TestTube,
  'chief-scientist': Atom,
  'ip-legal': BookOpen,
  // Manufacturing pack
  quality: ClipboardList,
  procurement: Truck,
  'hr-safety': HardHat,
  // Government pack
  policy: ScrollText,
  comms: Radio,
  'chief-of-staff': CalendarCheck,
};

/** Fallback icon for unknown slugs — generic person. */
export const FALLBACK_ROLE_ICON: LucideIcon = User;

/**
 * Category → lucide icon map for agency-agents (and any future imported
 * source whose slugs aren't covered by ROLE_ICON_BY_SLUG). Keeps the role
 * card grid visually scannable when the imported template's slug is novel.
 */
export const ROLE_ICON_BY_CATEGORY: Record<string, LucideIcon> = {
  engineering: Code,
  design: Palette,
  marketing: Megaphone,
  sales: CircleDollarSign,
  'paid-media': Target,
  support: LifeBuoy,
  testing: TestTube,
  product: Compass,
  strategy: Brain,
  'project-management': ClipboardList,
  finance: BadgeCheck,
  academic: GraduationCap,
  'game-development': Gamepad2,
  'spatial-computing': Layers,
  specialized: Sparkles,
  integrations: Workflow,
  'business-operations': Workflow,
  research: FlaskConical,
  // Native pack categories (Step 1/2 SoT JSON):
  retail: ShoppingCart,
  service: Briefcase,
  manufacturing: Wrench,
  government: Scale,
  it_software: Cpu,
  // Catch-all neutral.
  general: User,
  recommended: Rocket,
  'workspace-template': Users,
  'prismer-native': Users,
};

/** Fallback icon when category is missing/unrecognised. */
export const FALLBACK_CATEGORY_ICON: LucideIcon = Globe;

/**
 * Resolve a slug to its lucide icon component.
 * Returns the fallback `User` icon when slug is unmapped (forwards-compat —
 * new pack roles can ship before this map catches up, with a sensible default).
 */
export function getRoleIcon(slug: string): LucideIcon {
  return ROLE_ICON_BY_SLUG[slug] ?? FALLBACK_ROLE_ICON;
}

/**
 * Resolve a category to its lucide icon. Use this for imported sources
 * (e.g. agency-agents) whose 200+ slugs aren't enumerated in
 * ROLE_ICON_BY_SLUG; falls back to a neutral globe icon.
 */
export function getCategoryIcon(category: string | undefined): LucideIcon {
  if (!category) return FALLBACK_CATEGORY_ICON;
  return ROLE_ICON_BY_CATEGORY[category] ?? FALLBACK_CATEGORY_ICON;
}

/**
 * Resolve the best icon for a template — prefer slug-specific (5 native
 * templates have curated picks), fall back to category-based, then
 * neutral. Single entry point for surfaces that render imported + native
 * rows in the same list (RoleCardCatalog, SelectionFooter).
 */
export function getTemplateIcon(slug: string, category?: string): LucideIcon {
  const bySlug = ROLE_ICON_BY_SLUG[slug];
  if (bySlug) return bySlug;
  if (category && ROLE_ICON_BY_CATEGORY[category]) return ROLE_ICON_BY_CATEGORY[category];
  return FALLBACK_CATEGORY_ICON;
}
