/**
 * §30 B2 — Template system types.
 *
 * Templates render 6 industry × 4 size → AgentRole[] consumed by the
 * unified creation Simple mode (Step 2: confirm recommended team).
 *
 * Source-of-truth JSON lives under `./data/` (copied from
 * `docs/54release/template/`). These types describe the shape of those
 * JSON files plus the rendered output `renderTemplate()` returns.
 *
 * See `docs/54release/template/README.md` for the rendering formula and
 * `docs/54release/30-unified-creation-simple-pro-modes.md` §2.5 / §A.
 */

export type IndustryKey = 'it_software' | 'retail' | 'service' | 'research' | 'manufacturing' | 'government';

export type SizeKey = 'A' | 'B' | 'C' | 'D';

export type Locale = 'zh' | 'en';

export type AgentType = 'orchestrator' | 'specialist' | 'support';

export type RenameRule = 'CASUAL_NAME' | 'CORPORATE_NAME';

/** i18n string pair shared by displayName / corporateName / rationale / etc. */
export interface I18nString {
  zh: string;
  en: string;
}

/** Per-size rename override (currently used by manufacturing pack to relabel
 * Engineer → Chief Engineer at size D before the CORPORATE_NAME rule kicks
 * in — kept as an optional escape hatch). */
export interface RenameAtSizeEntry {
  displayName?: I18nString;
}

/** Role schema as it appears in core.json / pack-*.json. */
export interface Role {
  /** Stable identifier; unique inside one JSON file but a slug may repeat
   *  across pack + core (e.g. pack-it-software has its own `cto` slug). */
  id: string;
  /** Username slug prefix — used by Simple mode for default agent handles. */
  slug: string;
  displayName: I18nString;
  /** Size-D rename target (CORPORATE_NAME rule). Missing → role is dropped
   *  when `modifier.skipRolesWithoutCorporateName === true`. */
  corporateName?: I18nString;
  agentType: AgentType;
  /** CEO is `primary: true` — always wins selection priority. */
  primary?: boolean;
  rationale: I18nString;
  appliesAtSize: readonly SizeKey[];
  capabilities: readonly string[];
  defaultIcon: string;
  /** Optional size → displayName override (rarely used). */
  renameAtSize?: Partial<Record<SizeKey, RenameAtSizeEntry>>;
}

/** core.json. */
export interface CorePack {
  id: string;
  type: 'core';
  name: I18nString;
  description: string;
  roles: readonly Role[];
}

/** Override applied to a core role when an industry pack opts out of it.
 *  Currently only `pack-government.json` uses this (skips marketer +
 *  salesperson because public-sector orgs have no revenue pipeline). */
export interface CoreOverride {
  skip?: boolean;
}

/** pack-*.json. */
export interface IndustryPack {
  id: string;
  type: 'pack';
  industryKey: IndustryKey;
  name: I18nString;
  icon: string;
  description: string;
  taskPatterns?: I18nString;
  rolesNote?: string;
  /** Map of core role id → override. */
  coreOverrides?: Readonly<Record<string, CoreOverride>>;
  roles: readonly Role[];
}

/** modifier-*.json. */
export interface SizeModifier {
  id: string;
  type: 'modifier';
  sizeKey: SizeKey;
  name: I18nString;
  headcountRange: readonly [number, number | null];
  maxRoles: number;
  renameRule: RenameRule;
  skipRolesWithoutCorporateName: boolean;
  description: string;
  tagline: I18nString;
  selectionPriority?: readonly string[];
}

/** Output row returned by renderTemplate(). Names are pre-resolved for the
 *  caller's locale + the modifier's rename rule. */
export interface RenderedRole {
  slug: string;
  displayName: string;
  agentType: AgentType;
  /** True only for CEO (Core role with `primary: true`). */
  primary: boolean;
  rationale: string;
  capabilities: readonly string[];
  defaultIcon: string;
}
