/**
 * §30 B3.2 — Industry + size catalog for Simple mode Step 1.
 *
 * INDUSTRIES + SIZES are flat, UI-friendly projections of the 6 pack JSONs
 * and 4 modifier JSONs under `./data/`. Keeping them here (vs forcing the
 * Step 1 picker to spelunk into the full pack schema) means:
 *
 *   - The picker grid renders from a stable 6-entry / 4-entry list — no
 *     branching on `appliesAtSize` / `coreOverrides` / etc.
 *   - JSON ↔ UI drift is centralized: if a pack's `icon` changes upstream
 *     (in `docs/54release/template/`), the data files are re-synced and
 *     this catalog updates with them.
 *   - `renderTemplate()` stays free of any UI-specific shape and continues
 *     to return RenderedRole[] for Step 2 (B3.3).
 *
 * Both exports are `readonly` arrays in display order — that order is the
 * spec's grid order (§2.8.4):
 *   IT → Retail → Service → R&D → Mfg. → Gov.
 *   Solo → Small → Mid → Large
 */

import type { I18nString, IndustryKey, IndustryPack, SizeKey, SizeModifier } from './types';

import packItSoftware from './data/pack-it-software.json';
import packRetail from './data/pack-retail.json';
import packService from './data/pack-service.json';
import packResearch from './data/pack-research.json';
import packManufacturing from './data/pack-manufacturing.json';
import packGovernment from './data/pack-government.json';
import modifierSolo from './data/modifier-solo.json';
import modifierSmall from './data/modifier-small.json';
import modifierMid from './data/modifier-mid.json';
import modifierLarge from './data/modifier-large.json';

// ───────────────────────── Industries ─────────────────────────

export interface IndustryCatalogEntry {
  /** Discriminator used by the rest of the template system. */
  key: IndustryKey;
  /** Pack JSON `name` — caller picks `.zh` / `.en` for display. */
  name: I18nString;
  /** Emoji glyph shipped by the pack JSON (`💻`, `🛍`, etc.). */
  icon: string;
  /** Optional one-liner cue used by Step 1's 800ms hover caption. */
  tagline?: I18nString;
}

function toIndustryEntry(pack: IndustryPack): IndustryCatalogEntry {
  return {
    key: pack.industryKey,
    name: pack.name,
    icon: pack.icon,
    tagline: pack.taskPatterns,
  };
}

/**
 * 6 industries in spec display order (IT first, Gov last). Order is
 * load-bearing for the Step 1 grid — don't sort.
 */
export const INDUSTRIES: readonly IndustryCatalogEntry[] = [
  toIndustryEntry(packItSoftware as unknown as IndustryPack),
  toIndustryEntry(packRetail as unknown as IndustryPack),
  toIndustryEntry(packService as unknown as IndustryPack),
  toIndustryEntry(packResearch as unknown as IndustryPack),
  toIndustryEntry(packManufacturing as unknown as IndustryPack),
  toIndustryEntry(packGovernment as unknown as IndustryPack),
];

// ───────────────────────── Sizes ─────────────────────────

export interface SizeCatalogEntry {
  key: SizeKey;
  /** Modifier JSON `name` — `{ zh: '一人公司', en: 'Solo Founder' }`. */
  name: I18nString;
  /** `[min, max | null]` — null upper bound = "+". */
  headcountRange: readonly [number, number | null];
  /** Short label for the chip's main number (`"1"`, `"3-10"`, `"100+"`). */
  rangeLabel: string;
  /** Optional one-liner used by Step 1's 800ms hover caption. */
  tagline?: I18nString;
}

function formatRange(range: readonly [number, number | null]): string {
  const [min, max] = range;
  if (max === null) return `${min}+`;
  if (min === max) return `${min}`;
  // Solo's range is [1, 2] but the spec card shows just "1"; clamp to the
  // spec's visual ("1" not "1-2"). Wave-7 design pick: single-digit feels
  // more iconic than a range when the lower bound is what users self-id with.
  if (min === 1 && max === 2) return '1';
  return `${min}-${max}`;
}

function toSizeEntry(modifier: SizeModifier): SizeCatalogEntry {
  return {
    key: modifier.sizeKey,
    name: modifier.name,
    headcountRange: modifier.headcountRange,
    rangeLabel: formatRange(modifier.headcountRange),
    tagline: modifier.tagline,
  };
}

/**
 * 4 sizes in ascending headcount order (Solo → Large). Order matches the
 * spec's chip row layout.
 */
export const SIZES: readonly SizeCatalogEntry[] = [
  toSizeEntry(modifierSolo as unknown as SizeModifier),
  toSizeEntry(modifierSmall as unknown as SizeModifier),
  toSizeEntry(modifierMid as unknown as SizeModifier),
  toSizeEntry(modifierLarge as unknown as SizeModifier),
];
