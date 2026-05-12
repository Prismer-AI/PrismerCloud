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
  CalendarCheck,
  CircleDollarSign,
  ClipboardList,
  Code,
  Compass,
  Cpu,
  Crown,
  FlaskConical,
  HardHat,
  Headphones,
  LineChart,
  Megaphone,
  Microscope,
  Package,
  Palette,
  PenLine,
  Radio,
  Scale,
  ScrollText,
  TestTube,
  Truck,
  User,
  UserCheck,
  Users,
  Workflow,
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
 * Resolve a slug to its lucide icon component.
 * Returns the fallback `User` icon when slug is unmapped (forwards-compat —
 * new pack roles can ship before this map catches up, with a sensible default).
 */
export function getRoleIcon(slug: string): LucideIcon {
  return ROLE_ICON_BY_SLUG[slug] ?? FALLBACK_ROLE_ICON;
}
