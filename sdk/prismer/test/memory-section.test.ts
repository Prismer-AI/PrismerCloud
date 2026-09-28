// memory202/09 P0 — section-level granularity pure-function unit tests (daemon).
//
// Covers docs/memory202/09-section-level-granularity.md §11 P0 ①-⑥ for the daemon
// copy of `sliceSection` / `headingToSlug`, plus URI-parsing contract ⑦/⑧ for the
// daemon parsers `pathFromMemoryUri` (store.ts) and `parsePrismerUri` (rpc.ts).
//
// Pure functions, no daemon process / no DB. Run:
//   cd sdk/prismer && npx vitest run test/memory-section.test.ts
//
// NOTE on URI parsing (⑦/⑧): `pathFromMemoryUri` and `parsePrismerUri` are
// module-private (not exported) in production, and the test guardrail forbids
// editing production code to export them. So this file pins an inline copy that
// is byte-faithful to production, and a drift sentinel (`assertInlineMatchesSource`)
// fails loudly if the production source changes shape.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headingToSlug, sliceSection } from '../src/daemon/memory/section.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Inline-faithful copies of the two PRIVATE daemon URI parsers.
// ---------------------------------------------------------------------------

function pathFromMemoryUri(uri: string): { path: string; section?: string } | null {
  const schemeIdx = uri.indexOf('://');
  if (schemeIdx < 0) return null;
  let rest = uri.slice(schemeIdx + 3);
  let section: string | undefined;
  const anchorIdx = rest.indexOf('#');
  if (anchorIdx >= 0) {
    const anchor = rest.slice(anchorIdx + 1).trim();
    if (anchor) section = anchor;
    rest = rest.slice(0, anchorIdx);
  }
  rest = rest.trim();
  if (!rest || rest.startsWith('/') || rest.includes('..')) return null;
  return section ? { path: rest, section } : { path: rest };
}

function parsePrismerUri(
  uri: string,
): { workspaceId: string; path: string; section?: string } | null {
  const PREFIX = 'prismer://workspace/';
  if (!uri.startsWith(PREFIX)) return null;
  const rest = uri.slice(PREFIX.length);
  const segMemory = '/memory/';
  const memoryIdx = rest.indexOf(segMemory);
  if (memoryIdx <= 0) return null;
  const workspaceId = rest.slice(0, memoryIdx);
  let path = rest.slice(memoryIdx + segMemory.length);
  let section: string | undefined;
  const anchorIdx = path.indexOf('#');
  if (anchorIdx >= 0) {
    const anchor = path.slice(anchorIdx + 1).trim();
    if (anchor) section = anchor;
    path = path.slice(0, anchorIdx);
  }
  if (!workspaceId || !path) return null;
  return section ? { workspaceId, path, section } : { workspaceId, path };
}

function norm(s: string): string {
  return s.replace(/["']/g, '"').replace(/\s+/g, ' ').trim();
}

function assertInlineMatchesSource(file: string, marker: string, inlineFn: Function): void {
  const src = readFileSync(resolve(runtimeRoot, file), 'utf8');
  const idx = src.indexOf(marker);
  expect(idx, `marker ${marker} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const after = src.slice(idx);
  const end = after.indexOf('\n}');
  expect(end, `closing brace not found for ${marker} in ${file}`).toBeGreaterThanOrEqual(0);
  const prodBody = norm(after.slice(0, end));
  const inlineBody = norm(inlineFn.toString());
  for (const piece of ["indexOf('://')", "indexOf('#')", 'startsWith', "includes('..')", '/memory/']) {
    if (prodBody.includes(norm(piece))) {
      expect(inlineBody.includes(norm(piece)), `inline ${marker} drifted from ${file}: missing ${piece}`).toBe(true);
    }
  }
}

const SAMPLE = [
  '# Top Title',
  'intro line',
  '',
  '## Alpha',
  'alpha body 1',
  'alpha body 2',
  '',
  '### Alpha child',
  'nested under alpha',
  '',
  '## Beta',
  'beta body',
  '',
  '## Gamma',
  'gamma body',
  'gamma last line',
].join('\n');

describe('sliceSection (daemon) — §11 P0 ①②③④', () => {
  it('① hit heading → heading to next same/higher heading (excludes next sibling)', () => {
    const slice = sliceSection(SAMPLE, 'Alpha');
    expect(slice).not.toBeNull();
    expect(slice!.startsWith('## Alpha')).toBe(true);
    expect(slice).toContain('alpha body 1');
    expect(slice).toContain('alpha body 2');
    expect(slice).not.toContain('## Beta');
    expect(slice).not.toContain('beta body');
  });

  it('④ nested ### stays inside parent ## (no early truncation)', () => {
    const slice = sliceSection(SAMPLE, 'Alpha')!;
    expect(slice).toContain('### Alpha child');
    expect(slice).toContain('nested under alpha');
  });

  it('② last section runs to EOF', () => {
    const slice = sliceSection(SAMPLE, 'Gamma')!;
    expect(slice.startsWith('## Gamma')).toBe(true);
    expect(slice).toContain('gamma body');
    expect(slice.endsWith('gamma last line')).toBe(true);
  });

  it('② last heading at any level runs to EOF', () => {
    const doc = ['# T', '## A', 'a', '### A-child', 'child line'].join('\n');
    expect(sliceSection(doc, 'A-child')).toBe('### A-child\nchild line');
  });

  it('③ no matching anchor → null (page-level fallback)', () => {
    expect(sliceSection(SAMPLE, 'NonExistent')).toBeNull();
    expect(sliceSection(SAMPLE, '')).toBeNull();
  });

  it('higher-level heading after target terminates the section', () => {
    const doc = ['## Parent', '### Target', 'target body', '## Sibling', 'sib'].join('\n');
    expect(sliceSection(doc, 'Target')).toBe('### Target\ntarget body');
  });

  it('trailing blank lines trimmed', () => {
    const doc = ['## A', 'body', '', '', '## B', 'b'].join('\n');
    expect(sliceSection(doc, 'A')).toBe('## A\nbody');
  });

  it('anchor matched by slug equality (raw heading text or slug form)', () => {
    const doc = ['## Deploy Flow!', 'body'].join('\n');
    expect(sliceSection(doc, 'deploy-flow')!.startsWith('## Deploy Flow!')).toBe(true);
    expect(sliceSection(doc, 'Deploy Flow!')!.startsWith('## Deploy Flow!')).toBe(true);
  });

  it('PKF anchor returns one complete section wrapper, never neighbouring tags', () => {
    const doc = [
      '<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script>',
      '<h1>Page</h1>',
      '<section><h2 id="alpha" data-sid="sec_0123456789abcdefghjkmnpqrs">Alpha</h2><p>A</p></section>',
      '<section><h2 id="beta" data-sid="sec_1234567890abcdefghjkmnpqrs">Beta</h2><p>B</p></section>',
    ].join('\n');
    expect(sliceSection(doc, 'alpha')).toBe(
      '<section><h2 id="alpha" data-sid="sec_0123456789abcdefghjkmnpqrs">Alpha</h2><p>A</p></section>',
    );
  });
});

describe('headingToSlug (daemon) — §11 P0 ⑤⑥', () => {
  it('⑤ CJK preserved: "## 部署流程" → "部署流程"', () => {
    expect(headingToSlug('## 部署流程')).toBe('部署流程');
    expect(headingToSlug('部署流程')).toBe('部署流程');
  });

  it('⑤ lower-cases ASCII', () => {
    expect(headingToSlug('## Deploy Flow')).toBe('deploy-flow');
    expect(headingToSlug('MixedCase Heading')).toBe('mixedcase-heading');
  });

  it('⑤ collapses whitespace to single dash', () => {
    expect(headingToSlug('##   A    B   C')).toBe('a-b-c');
  });

  it('⑤ drops ASCII punctuation + underscore, keeps alnum + dash', () => {
    expect(headingToSlug('## Hello, World!')).toBe('hello-world');
    expect(headingToSlug('foo_bar')).toBe('foobar');
    expect(headingToSlug('a.b.c')).toBe('abc');
    expect(headingToSlug('v2.0 Release')).toBe('v20-release');
  });

  it('⑤ collapses repeated dashes + trims edges', () => {
    expect(headingToSlug('-- leading and trailing --')).toBe('leading-and-trailing');
    expect(headingToSlug('a -- b')).toBe('a-b');
  });

  it('⑤ mixed CJK + ASCII', () => {
    expect(headingToSlug('## 部署 Deploy 流程')).toBe('部署-deploy-流程');
  });

  it('⑤ strips any # run', () => {
    expect(headingToSlug('###### deep')).toBe('deep');
    expect(headingToSlug('#nospace')).toBe('nospace');
  });

  it('⑥ deterministic (same input → same output)', () => {
    for (const c of ['## 部署流程', 'Deploy Flow!', 'a -- b', 'MixedCase']) {
      expect(headingToSlug(c)).toBe(headingToSlug(c));
    }
  });
});

describe('URI parsing (daemon) — §11 P0 ⑦⑧', () => {
  it('drift guard: inline pathFromMemoryUri matches production (store.ts)', () => {
    assertInlineMatchesSource('src/daemon/memory/store.ts', 'function pathFromMemoryUri(', pathFromMemoryUri);
  });

  it('drift guard: inline parsePrismerUri matches production (rpc.ts)', () => {
    assertInlineMatchesSource('src/daemon/memory/rpc.ts', 'function parsePrismerUri(', parsePrismerUri);
  });

  it('⑦ prismer://workspace/<ws>/memory/<path>#<sec> → {workspaceId, path, section}', () => {
    expect(parsePrismerUri('prismer://workspace/ws-123/memory/decisions/auth.md#deployment')).toEqual({
      workspaceId: 'ws-123',
      path: 'decisions/auth.md',
      section: 'deployment',
    });
  });

  it('⑦ pkm://decisions/auth.md#L12 → daemon path parse retains section', () => {
    expect(pathFromMemoryUri('pkm://decisions/auth.md#L12')).toEqual({
      path: 'decisions/auth.md',
      section: 'L12',
    });
  });

  it('⑦ CJK section anchor retained', () => {
    expect(parsePrismerUri('prismer://workspace/ws-1/memory/notes.md#部署流程')).toEqual({
      workspaceId: 'ws-1',
      path: 'notes.md',
      section: '部署流程',
    });
  });

  it('⑧ no "#" → section undefined, path unchanged (backward-compatible)', () => {
    const r1 = parsePrismerUri('prismer://workspace/ws-1/memory/decisions/auth.md');
    expect(r1).toEqual({ workspaceId: 'ws-1', path: 'decisions/auth.md' });
    expect(r1!.section).toBeUndefined();

    const r2 = pathFromMemoryUri('pkm://decisions/auth.md');
    expect(r2).toEqual({ path: 'decisions/auth.md' });
    expect(r2!.section).toBeUndefined();
  });

  it('⑧ empty anchor ("...#") → no section, path preserved', () => {
    expect(pathFromMemoryUri('pkm://decisions/auth.md#')).toEqual({ path: 'decisions/auth.md' });
    expect(parsePrismerUri('prismer://workspace/ws-1/memory/n.md#')).toEqual({
      workspaceId: 'ws-1',
      path: 'n.md',
    });
  });

  it('⑧ malformed URIs → null (no scheme / traversal / leading slash / empty ws)', () => {
    expect(pathFromMemoryUri('no-scheme')).toBeNull();
    expect(pathFromMemoryUri('pkm:///abs.md')).toBeNull();
    expect(pathFromMemoryUri('pkm://../escape.md')).toBeNull();
    expect(parsePrismerUri('prismer://workspace/ws-1/notmemory/x.md')).toBeNull();
    expect(parsePrismerUri('prismer://workspace//memory/x.md')).toBeNull();
  });
});
