// memory211/01 W5 E (W2-M5) — plaintext projection parity, daemon side.
//
// The daemon's chunk text projection (`pkfToPlainTextLocal` in
// daemon/memory/asset-chunks.ts) and the cloud's `pkfToPlainText`
// (src/im/services/memory-plaintext.ts) must produce the SAME readable text
// for the same PKF body — otherwise the T3 chunk index and the page projection
// index different words for one document and the two recall surfaces drift.
// The two implementations cannot share a module (independent npm projects), so
// the anti-drift guard is the W4-2b pattern: BOTH sides pin the same LITERAL
// vectors, the expectation strings are written here by hand (never recomputed
// through the code under test), and the files cross-reference each other.
// Cloud twin of this file: src/im/services/__tests__/memory-plaintext-parity.test.ts.
//
// Run: npx vitest run test/memory-w5-plaintext-parity.test.ts

import { describe, expect, it } from 'vitest';
import { pkfToPlainTextLocal } from '../src/daemon/memory/asset-chunks.js';

// ── SHARED literal vectors (byte-identical on the cloud side) ────────────────

// Vector 1 — frontmatter preview fields + heading + prose + a typed link.
const PKF_WITH_FRONTMATTER = [
  '<script type="application/prismer+json">{"type":"note","title":"Kestrel lease","description":"How the lease renews.","tags":["kestrel","lease"]}</script>',
  '<section><h2 id="renewal">Renewal</h2>',
  '<p>The lease renews after <strong>300</strong> seconds &amp; refuses a stale token.</p>',
  '<a rel="derived-from" href="prismer://asset/abc">source</a>',
  '</section>',
].join('\n');
// Expected: title, description, tags, then heading + prose. The markup
// (`<h2 id>`, `<strong>`, `<a rel>`) and the frontmatter SCRIPT do not survive.
const EXPECTED_FRONTMATTER =
  'Kestrel lease How the lease renews. kestrel lease Renewal The lease renews after 300 seconds & refuses a stale token. source';

// Vector 2 — a `<prismer-data>` config script must not leak its JSON keys.
const PKF_WITH_DATA = [
  '<script type="application/prismer+json">{"type":"note","title":"Sampled metrics","description":"downsampling rules"}</script>',
  '<section><h2 id="rules">Rules</h2>',
  '<prismer-data kind="table"><script type="application/prismer+data+json">{"columns":["window"],"rows":[["5m"]]}</script></prismer-data>',
  '<p>Cardinality stays bounded.</p>',
  '</section>',
].join('\n');
const EXPECTED_DATA = 'Sampled metrics downsampling rules Rules Cardinality stays bounded.';

// Vector 3 — markdown / plain text passes through whitespace-normalised.
const MARKDOWN_BODY = '# Title\n\nSome   prose\twith odd spacing.\n';
const EXPECTED_MARKDOWN = '# Title Some prose with odd spacing.';

describe('plaintext projection parity (daemon twin of cloud pkfToPlainText)', () => {
  it('vector 1 — frontmatter previews are prepended, markup stripped', () => {
    expect(pkfToPlainTextLocal(PKF_WITH_FRONTMATTER)).toBe(EXPECTED_FRONTMATTER);
  });

  it('vector 2 — prismer-data config scripts never reach the haystack', () => {
    const out = pkfToPlainTextLocal(PKF_WITH_DATA);
    expect(out).toBe(EXPECTED_DATA);
    expect(out).not.toContain('columns');
    expect(out).not.toContain('prismer');
  });

  it('vector 3 — markdown sources are whitespace-normalised verbatim', () => {
    expect(pkfToPlainTextLocal(MARKDOWN_BODY)).toBe(EXPECTED_MARKDOWN);
  });

  it('vector 4 — a malformed PKF degrades to a non-empty haystack (never throws)', () => {
    const broken = '<section><h2 id="x">Unclosed';
    expect(pkfToPlainTextLocal(broken).length).toBeGreaterThan(0);
  });

  it('vector 5 — empty input stays empty', () => {
    expect(pkfToPlainTextLocal('')).toBe('');
  });
});
