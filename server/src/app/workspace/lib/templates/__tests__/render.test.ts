/**
 * §30 B2 — renderTemplate() snapshot tests.
 *
 * Drives 24 cells (6 industry × 4 size). Compared against
 * `__fixtures__/render-24-cells.json` — the contract is the slug list
 * order produced by the algorithm. If a SoT JSON in `../data/` changes
 * and the algorithm output shifts, the fixture diff will surface the
 * change for human review (intentional snapshot semantics).
 *
 *   Algorithm contract:
 *     primary first → industry pack roles → remaining core roles
 *     filtered by appliesAtSize, capped at modifier.maxRoles,
 *     CORPORATE_NAME at size D drops roles without corporateName
 *     (except primary).
 *
 * After §30 B2.1 SoT patches + §30 P2-6 (Research-D editorial decision —
 * add cto + hr-research to pack-research and drop marketer/salesperson +
 * narrow lab-manager so the algorithm reproduces §A exactly), 22 of 24
 * cells set-match the §A appendix in `30-unified-creation-simple-pro-modes.md`.
 * The 2 residual divergences are documented in `KNOWN_A_APPENDIX_DELTAS`
 * below — both are "algorithm gives 1 more role than §A" at Size D,
 * Option Y (accept superset) deliberately chosen.
 */

import { describe, expect, it } from 'vitest';
import expected from './__fixtures__/render-24-cells.json';
import { renderTemplate, renderTemplateSlugs } from '../render';
import type { IndustryKey, SizeKey } from '../types';

const INDUSTRIES: readonly IndustryKey[] = [
  'it_software',
  'retail',
  'service',
  'research',
  'manufacturing',
  'government',
] as const;

const SIZES: readonly SizeKey[] = ['A', 'B', 'C', 'D'] as const;

describe('renderTemplate — 24-cell snapshot', () => {
  for (const industry of INDUSTRIES) {
    for (const size of SIZES) {
      const expectedSlugs = (expected as unknown as Record<string, Record<string, string[]>>)[industry][size];
      it(`renders ${industry} × ${size} → [${expectedSlugs.join(', ')}]`, () => {
        const actual = renderTemplateSlugs(industry, size);
        expect(actual).toEqual(expectedSlugs);
      });
    }
  }
});

describe('renderTemplate — invariants', () => {
  it('CEO (primary) appears first in every cell — guaranteed by selection priority', () => {
    for (const industry of INDUSTRIES) {
      for (const size of SIZES) {
        const slugs = renderTemplateSlugs(industry, size);
        // Government Solo + Research Solo + IT Solo etc. all start with `ceo`.
        // §A confirms CEO is required across all 24 cells.
        expect(slugs[0], `${industry}/${size} missing CEO first`).toBe('ceo');
      }
    }
  });

  it('never exceeds the size modifier maxRoles cap', () => {
    const caps: Record<SizeKey, number> = { A: 3, B: 5, C: 7, D: 8 };
    for (const industry of INDUSTRIES) {
      for (const size of SIZES) {
        const slugs = renderTemplateSlugs(industry, size);
        expect(slugs.length, `${industry}/${size} over cap`).toBeLessThanOrEqual(caps[size]);
      }
    }
  });

  it('government cells never include marketer or salesperson (coreOverrides)', () => {
    for (const size of SIZES) {
      const slugs = renderTemplateSlugs('government', size);
      expect(slugs).not.toContain('marketer');
      expect(slugs).not.toContain('salesperson');
    }
  });

  it('size D uses corporate names; size A-C use casual names', () => {
    // IT/Software Marketer: casual "Marketer" at A/B/C, corporate "CMO" at D.
    expect(renderTemplate('it_software', 'A', 'en').find((r) => r.slug === 'marketer')?.displayName).toBe('Marketer');
    expect(renderTemplate('it_software', 'B', 'en').find((r) => r.slug === 'marketer')?.displayName).toBe('Marketer');
    expect(renderTemplate('it_software', 'C', 'en').find((r) => r.slug === 'marketer')?.displayName).toBe('Marketer');
    expect(renderTemplate('it_software', 'D', 'en').find((r) => r.slug === 'marketer')?.displayName).toBe('CMO');
  });

  it('locale "zh" returns Chinese displayNames', () => {
    const zhIt = renderTemplate('it_software', 'A', 'zh');
    expect(zhIt.find((r) => r.slug === 'ceo')?.displayName).toBe('CEO');
    expect(zhIt.find((r) => r.slug === 'marketer')?.displayName).toBe('市场');
    expect(zhIt.find((r) => r.slug === 'engineer')?.displayName).toBe('工程师');
  });

  it('locale "en" returns English displayNames', () => {
    const enRetail = renderTemplate('retail', 'D', 'en');
    expect(enRetail.find((r) => r.slug === 'support')?.displayName).toBe('Head of CX');
    expect(enRetail.find((r) => r.slug === 'merchandiser')?.displayName).toBe('Chief Merchant');
  });

  it('rendered output includes all RenderedRole fields', () => {
    const out = renderTemplate('it_software', 'A', 'en');
    expect(out.length).toBeGreaterThan(0);
    for (const role of out) {
      expect(role).toHaveProperty('slug');
      expect(role).toHaveProperty('displayName');
      expect(role).toHaveProperty('agentType');
      expect(role).toHaveProperty('primary');
      expect(role).toHaveProperty('rationale');
      expect(role).toHaveProperty('capabilities');
      expect(role).toHaveProperty('defaultIcon');
    }
    // CEO is the only role with primary: true.
    expect(out.filter((r) => r.primary).map((r) => r.slug)).toEqual(['ceo']);
  });

  it('unknown industry throws', () => {
    expect(() => renderTemplate('nonsense' as IndustryKey, 'A')).toThrow();
  });
});

/**
 * KNOWN_A_APPENDIX_DELTAS — residual divergences after §30 B2.1 + P2-6 patches.
 *
 * §A in docs/54release/30-unified-creation-simple-pro-modes.md is hand-
 * curated example output. B2.1 patched the SoT JSONs to make §A
 * achievable via the formal algorithm; P2-6 closed Research-D (added
 * pack-research.cto + pack-research.hr-research, dropped marketer +
 * salesperson via coreOverrides, narrowed lab-manager to B/C). 22 of 24
 * cells now set-match §A. The 2 unresolved cells:
 *
 *   1. **IT-D**: §A picks 7 roles {CEO, CTO, CPO, CMO, CRO, CFO, CHRO}.
 *      Algorithm picks 8 — same 7 plus COO (core.operations renders as
 *      COO at size D since modifier-large uses CORPORATE_NAME and
 *      operations has corporateName). §A author appears to have applied
 *      a hidden tie-breaker dropping Operations for IT specifically.
 *      Option Y chosen (accept extra role) — providing 1 extra peer
 *      C-suite role is generous, not wrong.
 *
 *   2. **Retail-D**: §A picks 7 roles {CEO, CMO, COO, Chief Merchant,
 *      CFO, CTO, Head of CX}. Algorithm picks 8 — same 7 plus CRO
 *      (core.salesperson rendered as CRO). Same Option Y rationale.
 *
 * Pattern: both residuals are Size D ("Large 100+"). At smaller sizes
 * (Solo / Small / Mid) the algorithm + SoT JSONs reproduce §A exactly.
 * Size D divergences reflect §A's hand-curated taste calls at the
 * C-suite level that don't generalize cleanly into a pure data
 * pipeline. Option Y (accept algorithm-side superset) chosen for both.
 */
