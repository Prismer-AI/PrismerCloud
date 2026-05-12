/**
 * §30 B2 — `renderTemplate(industry, size, locale)`.
 *
 * Reads 11 SoT JSON files under `./data/` and returns the team
 * composition for one of 24 (industry × size) cells. Output is consumed
 * by Simple mode Step 2 (team review) — see
 * `docs/54release/30-unified-creation-simple-pro-modes.md` §2.5 + §A.
 *
 * Algorithm (per `template/README.md` + task B2 spec):
 *   1. Load core.json + pack-{industry}.json
 *   2. Apply pack.coreOverrides (e.g. pack-government drops marketer +
 *      salesperson because public-sector orgs have no sales pipeline)
 *   3. Filter the union by role.appliesAtSize.includes(size)
 *   4. Apply size modifier:
 *        CORPORATE_NAME (size D)  → render as role.corporateName;
 *                                   roles without corporateName are
 *                                   skipped when modifier.skipRolesWith-
 *                                   outCorporateName === true
 *        CASUAL_NAME              → render as role.displayName (also
 *                                   honouring role.renameAtSize[size])
 *   5. Apply maxRoles cap. Priority:
 *        a. role.primary === true (CEO) always first
 *        b. then industry-pack roles in pack JSON order
 *        c. then remaining core roles in core JSON order
 *   6. Return RenderedRole[] in priority order.
 */

import type { CorePack, IndustryKey, IndustryPack, Locale, RenderedRole, Role, SizeKey, SizeModifier } from './types';

import coreJson from './data/core.json';
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

// JSON imports are loosely typed; we cast through unknown to our strict
// schema so the algorithm body stays type-safe without dragging JSON's
// inferred literal types around.
const CORE: CorePack = coreJson as unknown as CorePack;

const PACKS: Readonly<Record<IndustryKey, IndustryPack>> = {
  it_software: packItSoftware as unknown as IndustryPack,
  retail: packRetail as unknown as IndustryPack,
  service: packService as unknown as IndustryPack,
  research: packResearch as unknown as IndustryPack,
  manufacturing: packManufacturing as unknown as IndustryPack,
  government: packGovernment as unknown as IndustryPack,
};

const MODIFIERS: Readonly<Record<SizeKey, SizeModifier>> = {
  A: modifierSolo as unknown as SizeModifier,
  B: modifierSmall as unknown as SizeModifier,
  C: modifierMid as unknown as SizeModifier,
  D: modifierLarge as unknown as SizeModifier,
};

/** Resolve the visible name for one role given size + locale + rename rule.
 *
 *  Returns `null` when the role should be SKIPPED at this size (currently
 *  only happens for CORPORATE_NAME + skipRolesWithoutCorporateName=true
 *  + missing role.corporateName). `primary: true` roles (CEO) are always
 *  exempt from skipping — §A appendix shows CEO present in every size-D
 *  cell despite core.json not giving CEO a corporateName. */
function resolveName(role: Role, size: SizeKey, modifier: SizeModifier, locale: Locale): string | null {
  if (modifier.renameRule === 'CORPORATE_NAME') {
    if (!role.corporateName) {
      if (modifier.skipRolesWithoutCorporateName && role.primary !== true) return null;
      return role.displayName[locale];
    }
    return role.corporateName[locale];
  }
  // CASUAL_NAME — honour per-size override if present, else displayName.
  const override = role.renameAtSize?.[size]?.displayName;
  return (override ?? role.displayName)[locale];
}

function toRendered(role: Role, name: string, locale: Locale): RenderedRole {
  return {
    slug: role.slug,
    displayName: name,
    agentType: role.agentType,
    primary: role.primary === true,
    rationale: role.rationale[locale],
    capabilities: role.capabilities,
    defaultIcon: role.defaultIcon,
  };
}

/**
 * Render the recommended team for one (industry, size) cell.
 *
 * @param industry  Industry key — one of 6 packs.
 * @param size      Headcount bucket — A (solo) / B (small) / C (mid) / D (large).
 * @param locale    'zh' (default) or 'en' — picks which side of the i18n
 *                  pair each name resolves to. Caller is responsible for
 *                  honouring this; the output strings are flat (not nested).
 * @returns RenderedRole[] in priority order (CEO first, then pack roles,
 *          then remaining core roles), capped at modifier.maxRoles.
 */
export function renderTemplate(industry: IndustryKey, size: SizeKey, locale: Locale = 'zh'): RenderedRole[] {
  const pack = PACKS[industry];
  const modifier = MODIFIERS[size];
  if (!pack || !modifier) {
    throw new Error(`[renderTemplate] unknown industry/size: ${industry}/${size}`);
  }

  const overrides = pack.coreOverrides ?? {};

  // Step 1-3: build size-filtered core + pack lists, applying coreOverrides.
  const coreFiltered: Role[] = CORE.roles.filter((role) => {
    if (overrides[role.id]?.skip) return false;
    return role.appliesAtSize.includes(size);
  });

  const packFiltered: Role[] = pack.roles.filter((role) => role.appliesAtSize.includes(size));

  // Step 5 — priority buckets:
  //   primaryRoles : role.primary === true (CEO, lives in core)
  //   packRoles    : industry pack roles
  //   coreRoles    : remaining core roles (primary excluded)
  const primaryRoles = coreFiltered.filter((r) => r.primary === true);
  const otherCoreRoles = coreFiltered.filter((r) => r.primary !== true);

  // Step 4 — resolve names; drop roles whose name resolves to null
  // (CORPORATE_NAME + skipRolesWithoutCorporateName === true).
  const resolveOrNull = (role: Role): RenderedRole | null => {
    const name = resolveName(role, size, modifier, locale);
    return name === null ? null : toRendered(role, name, locale);
  };

  const ordered: RenderedRole[] = [];
  const seenSlugs = new Set<string>();

  const pushIfNew = (rendered: RenderedRole | null): void => {
    if (!rendered) return;
    // De-duplicate by slug — packs and core sometimes share a slug (e.g.
    // pack-it-software's `engineer` slug and pack-retail's `cto` slug do not
    // collide across cells, but core's `operations` slug overlapping a
    // pack would surface here. The first occurrence (higher priority bucket)
    // wins.
    if (seenSlugs.has(rendered.slug)) return;
    seenSlugs.add(rendered.slug);
    ordered.push(rendered);
  };

  for (const role of primaryRoles) pushIfNew(resolveOrNull(role));
  for (const role of packFiltered) pushIfNew(resolveOrNull(role));
  for (const role of otherCoreRoles) pushIfNew(resolveOrNull(role));

  // Step 5 — cap at maxRoles.
  return ordered.slice(0, modifier.maxRoles);
}

/** Helper for tests / debugging — returns just the slugs. */
export function renderTemplateSlugs(industry: IndustryKey, size: SizeKey): string[] {
  return renderTemplate(industry, size).map((r) => r.slug);
}

/**
 * §30 B3.3 — Roster of roles a user COULD add at one (industry, size) cell.
 *
 * Returns the union of core + industry-pack roles whose `appliesAtSize`
 * includes `size`, with name resolution honouring the size modifier's
 * rename rule (CASUAL_NAME / CORPORATE_NAME) and locale. Used by Simple
 * mode Step 2's "+ 添加其他角色" popover — broader than `renderTemplate()`
 * because we want every legal role (not just the maxRoles-capped slate).
 *
 * Differences from `renderTemplate()`:
 *   - No `modifier.maxRoles` cap — caller (Step 2) enforces capacity at
 *     the device level (e.g. Solo Cloud Device → 3 agents).
 *   - Order: primary first → industry pack (in JSON order) → remaining
 *     core (in JSON order). De-duped by slug, first occurrence wins.
 *   - CORPORATE_NAME roles missing `corporateName` ARE included (we keep
 *     the casual name as a fallback) so the popover never silently hides
 *     a role the user might want.
 */
export function getAvailableRoles(industry: IndustryKey, size: SizeKey, locale: Locale = 'zh'): RenderedRole[] {
  const pack = PACKS[industry];
  const modifier = MODIFIERS[size];
  if (!pack || !modifier) {
    throw new Error(`[getAvailableRoles] unknown industry/size: ${industry}/${size}`);
  }

  const overrides = pack.coreOverrides ?? {};

  const coreFiltered: Role[] = CORE.roles.filter((role) => {
    if (overrides[role.id]?.skip) return false;
    return role.appliesAtSize.includes(size);
  });
  const packFiltered: Role[] = pack.roles.filter((role) => role.appliesAtSize.includes(size));

  const primaryRoles = coreFiltered.filter((r) => r.primary === true);
  const otherCoreRoles = coreFiltered.filter((r) => r.primary !== true);

  const ordered: RenderedRole[] = [];
  const seen = new Set<string>();

  // Popover should never silently drop a role — fall back to displayName
  // when corporateName missing at size D rather than returning null.
  const resolveAlways = (role: Role): string => {
    if (modifier.renameRule === 'CORPORATE_NAME') {
      return (role.corporateName ?? role.displayName)[locale];
    }
    const override = role.renameAtSize?.[size]?.displayName;
    return (override ?? role.displayName)[locale];
  };

  const push = (role: Role): void => {
    if (seen.has(role.slug)) return;
    seen.add(role.slug);
    ordered.push(toRendered(role, resolveAlways(role), locale));
  };

  for (const role of primaryRoles) push(role);
  for (const role of packFiltered) push(role);
  for (const role of otherCoreRoles) push(role);

  return ordered;
}
