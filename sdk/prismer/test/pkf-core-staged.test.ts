// product209/15 PKF-D2 — runtime consumes the hash-verified staged @prismer/pkf
// bundle (pkf209/07 §6 merged pkf-core/pkf-reader into it). This test imports
// ONLY the staged package (sdk/prismer/node_modules/@prismer/pkf, populated by
// `prebuild` → sdk/build/stage-pkf-core.cjs). It runs with no network and no
// monorepo root source — the offline fallback must parse/validate the same
// golden fixture as Cloud.

import { describe, expect, it } from 'vitest';
import { parsePkf, validatePkf } from '@prismer/pkf';

const GOLDEN = `<script type="application/prismer+json">{"type":"note","title":"golden","description":"d","pkfVersion":"1.1"}</script><h2 id="a">A</h2><p>golden fixture</p>`;

describe('pkf-core staged bundle (offline)', () => {
  it('parses and validates the golden v1.1 fixture', () => {
    const parsed = parsePkf(GOLDEN);
    expect(parsed.schemaVersion).toBe('1.1');
    const v = validatePkf(parsed);
    expect(v.ok).toBe(true);
    expect(v.strictOk).toBe(true);
  });

  it('rejects an invalid v1.1 body (same result as Cloud)', () => {
    const bad = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script><p><img src="prismer://asset/abc"></p>`;
    const v = validatePkf(parsePkf(bad));
    expect(v.structureStatus).toBe('fail');
    expect(v.errors.some((e) => e.code === 'bare-asset-uri')).toBe(true);
  });
});
