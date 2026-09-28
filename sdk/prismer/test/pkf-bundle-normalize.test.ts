/**
 * pkf209/07 §4a — Runtime bundle-commit normalizer (hash sinking).
 *
 * The model surface is RELAXED: resources carry content (bytesBase64 | text),
 * paths, mime and usage; the runtime computes sha256 contentHash / SRI /
 * root.sourceHash, generates the harness manifest through the deterministic
 * packer when it is missing/incomplete, and rewrites bundle-internal relative
 * references into host-bound scoped asset URIs. Self-supplied hashes are
 * verified locally (fast fail). The output is the frozen server wire shape —
 * the /api/pkf/bundles/commit contract is unchanged.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizePkfBundleCommit,
  PkfBundleNormalizeError,
  type PkfBundleCommitRelaxedInput,
} from '../src/daemon/pkf/bundle-normalize.js';

const WS = 'ws-normalize';
const scoped = (hash: string) => `prismer://workspace/${WS}/asset/${hash}`;
const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sri = (data: string | Buffer) => `sha256-${createHash('sha256').update(data).digest('base64')}`;

const JS = 'console.log("hi");\n';
const CSS = 'body { margin: 0 }\n';
const CSV = 'a,b\n1,2\n';

function rootSource(manifestRef: string, dataRef: string): string {
  return (
    '<script type="application/prismer+json">{"type":"note","title":"Bundle","pkfVersion":"1.1"}</script>' +
    `<section><h2 id="b">B</h2><prismer-interactive manifest="${manifestRef}">static fallback</prismer-interactive>` +
    `<prismer-data src="${dataRef}" format="csv" view="table"></prismer-data></section>`
  );
}

describe('normalizePkfBundleCommit — bare-bytes full path (weak model)', () => {
  const input: PkfBundleCommitRelaxedInput = {
    idempotencyKey: 'norm-1',
    root: { filename: 'report.pkf', source: rootSource('manifest.json', 'data.csv') },
    resources: [
      { path: 'main.js', text: JS, mime: 'text/javascript', usage: 'harness-script' },
      { path: 'styles.css', text: CSS, mime: 'text/css', usage: 'harness-style' },
      { path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' },
    ],
    harnessDecl: { scripts: ['main.js'], styles: ['styles.css'] },
  };

  it('computes byte-exact hashes/SRI and emits the frozen wire shape', () => {
    const { input: wire } = normalizePkfBundleCommit(input, WS);
    expect(wire.idempotencyKey).toBe('norm-1');
    expect(wire.root.filename).toBe('report.pkf');
    const csv = wire.resources.find((r) => r.path === 'data.csv')!;
    expect(csv.contentHash).toBe(hex(CSV));
    expect(csv.integrity).toBe(sri(CSV));
    expect(csv.bytesBase64).toBe(Buffer.from(CSV, 'utf8').toString('base64'));
    expect(csv.fromPath).toBeUndefined();
    expect(wire.resources).toHaveLength(4);
  });

  it('generates the manifest via the deterministic packer with scoped src + real SRI', () => {
    const { input: wire } = normalizePkfBundleCommit(input, WS);
    const manifest = wire.resources.find((r) => r.usage === 'harness-manifest')!;
    expect(manifest.path).toBe('manifest.json');
    expect(manifest.mime).toBe('application/json');
    expect(manifest.fromPath).toBeUndefined();
    const decoded = JSON.parse(Buffer.from(manifest.bytesBase64, 'base64').toString('utf8')) as {
      scripts: Array<{ path: string; src: string; integrity: string }>;
      styles: Array<{ path: string; src: string; integrity: string }>;
    };
    expect(decoded.scripts).toEqual([{ path: 'main.js', src: scoped(hex(JS)), integrity: sri(JS) }]);
    expect(decoded.styles).toEqual([{ path: 'styles.css', src: scoped(hex(CSS)), integrity: sri(CSS) }]);
    // the manifest's own hashes are over its serialized bytes
    expect(manifest.contentHash).toBe(hex(Buffer.from(manifest.bytesBase64, 'base64')));
    expect(manifest.integrity).toBe(sri(Buffer.from(manifest.bytesBase64, 'base64')));
    // scripts/styles hang off the manifest referrer
    expect(wire.resources.find((r) => r.path === 'main.js')!.fromPath).toBe('manifest.json');
    expect(wire.resources.find((r) => r.path === 'styles.css')!.fromPath).toBe('manifest.json');
  });

  it('rewrites bundle-relative references in root.source to scoped asset URIs and hashes the rewritten source', () => {
    const { input: wire, warnings } = normalizePkfBundleCommit(input, WS);
    expect(warnings).toEqual([]);
    const manifest = wire.resources.find((r) => r.usage === 'harness-manifest')!;
    const csv = wire.resources.find((r) => r.path === 'data.csv')!;
    expect(wire.root.source).toContain(`manifest="${scoped(manifest.contentHash)}"`);
    expect(wire.root.source).toContain(`src="${scoped(csv.contentHash)}"`);
    expect(wire.root.source).not.toContain('manifest.json');
    expect(wire.root.sourceHash).toBe(hex(wire.root.source));
  });

  it('is deterministic: identical input → byte-identical wire', () => {
    const first = normalizePkfBundleCommit(input, WS);
    const second = normalizePkfBundleCommit(JSON.parse(JSON.stringify(input)), WS);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('accepts bytesBase64 and derives the same hashes as the text form', () => {
    const viaBase64 = normalizePkfBundleCommit(
      {
        ...input,
        resources: input.resources.map((r) =>
          r.path === 'data.csv'
            ? { path: r.path, bytesBase64: Buffer.from(CSV).toString('base64'), mime: r.mime, usage: r.usage }
            : r,
        ),
      },
      WS,
    );
    const viaText = normalizePkfBundleCommit(input, WS);
    expect(viaBase64.input.resources.find((r) => r.path === 'data.csv')).toEqual(
      viaText.input.resources.find((r) => r.path === 'data.csv'),
    );
  });
});

describe('normalizePkfBundleCommit — legacy self-supplied hash path', () => {
  it('passes through unchanged when every supplied hash matches (no harness)', () => {
    const source = rootSource('', 'prismer://workspace/other/asset/deadbeef');
    const legacy = {
      idempotencyKey: 'legacy-1',
      root: { filename: 'plain.pkf', source, sourceHash: hex(source) },
      resources: [
        {
          path: 'data.csv',
          bytesBase64: Buffer.from(CSV).toString('base64'),
          contentHash: hex(CSV),
          integrity: sri(CSV),
          mime: 'text/csv',
          usage: 'data' as const,
        },
      ],
    };
    const { input: wire, warnings } = normalizePkfBundleCommit(legacy, WS);
    expect(wire.root.sourceHash).toBe(hex(source));
    expect(wire.resources[0]!.contentHash).toBe(hex(CSV));
    expect(wire.resources[0]!.integrity).toBe(sri(CSV));
    expect(wire.resources).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

describe('normalizePkfBundleCommit — local fast failures', () => {
  it('rejects a wrong self-supplied resource contentHash with a readable, path-named error', () => {
    const bad = {
      idempotencyKey: 'bad-hash',
      root: { filename: 'report.pkf', source: '<p>x</p>' },
      resources: [
        {
          path: 'data.csv',
          bytesBase64: Buffer.from(CSV).toString('base64'),
          contentHash: 'b'.repeat(64),
          integrity: sri(CSV),
          mime: 'text/csv',
          usage: 'data' as const,
        },
      ],
    };
    expect(() => normalizePkfBundleCommit(bad, WS)).toThrow(PkfBundleNormalizeError);
    try {
      normalizePkfBundleCommit(bad, WS);
    } catch (error) {
      const e = error as PkfBundleNormalizeError;
      expect(e.code).toBe('pkf_bundle_resource_hash_mismatch');
      expect(e.message).toContain('data.csv');
      expect(e.message).toContain(hex(CSV));
    }
  });

  it('rejects a wrong self-supplied resource integrity (SRI)', () => {
    const bad = {
      idempotencyKey: 'bad-sri',
      root: { filename: 'report.pkf', source: '<p>x</p>' },
      resources: [
        {
          path: 'data.csv',
          text: CSV,
          contentHash: hex(CSV),
          integrity: `sha256-${'c'.repeat(43)}=`,
          mime: 'text/csv',
          usage: 'data' as const,
        },
      ],
    };
    expect(() => normalizePkfBundleCommit(bad, WS)).toThrow(/integrity/i);
  });

  it('rejects a wrong root sourceHash (verified against the supplied source)', () => {
    const bad = {
      idempotencyKey: 'bad-root',
      root: { filename: 'report.pkf', source: '<p>x</p>', sourceHash: 'a'.repeat(64) },
      resources: [{ path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const }],
    };
    expect(() => normalizePkfBundleCommit(bad, WS)).toThrow(/sourceHash|root/i);
  });

  it('rejects resources with neither bytesBase64 nor text, and both at once', () => {
    const neither = {
      idempotencyKey: 'empty-res',
      root: { filename: 'report.pkf', source: '<p>x</p>' },
      resources: [{ path: 'data.csv', mime: 'text/csv', usage: 'data' as const }],
    };
    expect(() => normalizePkfBundleCommit(neither, WS)).toThrow(/bytesBase64|text/i);
    const both = {
      idempotencyKey: 'both-res',
      root: { filename: 'report.pkf', source: '<p>x</p>' },
      resources: [
        {
          path: 'data.csv',
          bytesBase64: Buffer.from(CSV).toString('base64'),
          text: CSV,
          mime: 'text/csv',
          usage: 'data' as const,
        },
      ],
    };
    expect(() => normalizePkfBundleCommit(both, WS)).toThrow(/exactly one/i);
  });

  it('rejects unknown usage values and duplicate paths before any hashing', () => {
    const badUsage = {
      idempotencyKey: 'bad-usage',
      root: { filename: 'report.pkf', source: '<p>x</p>' },
      resources: [{ path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'widget' as never }],
    };
    expect(() => normalizePkfBundleCommit(badUsage, WS)).toThrow(/usage/i);
    const dup = {
      idempotencyKey: 'dup-path',
      root: { filename: 'report.pkf', source: '<p>x</p>' },
      resources: [
        { path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const },
        { path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const },
      ],
    };
    expect(() => normalizePkfBundleCommit(dup, WS)).toThrow(/duplicate/i);
  });

  it('surfaces the packer failure when a harnessDecl script is missing from the bundle', () => {
    const missing = {
      idempotencyKey: 'missing-script',
      root: { filename: 'report.pkf', source: rootSource('manifest.json', 'data.csv') },
      resources: [{ path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const }],
      harnessDecl: { scripts: ['ghost.js'] },
    };
    expect(() => normalizePkfBundleCommit(missing, WS)).toThrow(/ghost\.js/);
  });
});

describe('normalizePkfBundleCommit — reference rewriting warnings', () => {
  it('keeps unmatched relative references verbatim and reports them as warnings', () => {
    const input = {
      idempotencyKey: 'unmatched',
      root: { filename: 'report.pkf', source: rootSource('other.json', 'ghost.csv') },
      resources: [{ path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const }],
    };
    const { input: wire, warnings } = normalizePkfBundleCommit(input, WS);
    expect(wire.root.source).toContain('other.json');
    expect(wire.root.source).toContain('ghost.csv');
    expect(warnings.some((w) => w.includes('other.json'))).toBe(true);
    expect(warnings.some((w) => w.includes('ghost.csv'))).toBe(true);
  });

  it('resolves ./-prefixed and prismer://-tailed references that hit the bundle path set', () => {
    const source = rootSource('prismer://bundle/manifest.json', './data.csv');
    const input = {
      idempotencyKey: 'tail-match',
      root: { filename: 'report.pkf', source },
      resources: [
        { path: 'main.js', text: JS, mime: 'text/javascript', usage: 'harness-script' as const },
        { path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const },
      ],
      harnessDecl: { scripts: ['main.js'] },
    };
    const { input: wire, warnings } = normalizePkfBundleCommit(input, WS);
    const manifest = wire.resources.find((r) => r.usage === 'harness-manifest')!;
    const csv = wire.resources.find((r) => r.path === 'data.csv')!;
    expect(wire.root.source).toContain(`manifest="${scoped(manifest.contentHash)}"`);
    expect(wire.root.source).toContain(`src="${scoped(csv.contentHash)}"`);
    expect(warnings).toEqual([]);
  });

  it('warns about scoped asset URIs that point outside the declared resources', () => {
    const stale = `${scoped('f'.repeat(64))}`;
    const input = {
      idempotencyKey: 'stale-uri',
      root: { filename: 'report.pkf', source: rootSource(stale, 'data.csv') },
      resources: [{ path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const }],
    };
    const { warnings } = normalizePkfBundleCommit(input, WS);
    expect(warnings.some((w) => w.includes('not in the bundle'))).toBe(true);
  });
});

describe('normalizePkfBundleCommit — manifest regeneration when incomplete', () => {
  it('regenerates a stale model-authored manifest whose entries carry wrong SRI', () => {
    const staleManifest = JSON.stringify({
      version: 'prismer-harness@1',
      scripts: [{ path: 'main.js', src: 'prismer://workspace/ws/asset/deadbeef', integrity: `sha256-${'c'.repeat(43)}=` }],
      styles: [],
      actions: [],
    });
    const input = {
      idempotencyKey: 'stale-manifest',
      root: { filename: 'report.pkf', source: rootSource('manifest.json', 'data.csv') },
      resources: [
        { path: 'manifest.json', text: staleManifest, mime: 'application/json', usage: 'harness-manifest' as const },
        { path: 'main.js', text: JS, mime: 'text/javascript', usage: 'harness-script' as const },
        { path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const },
      ],
    };
    const { input: wire } = normalizePkfBundleCommit(input, WS);
    const manifest = wire.resources.find((r) => r.usage === 'harness-manifest')!;
    const decoded = JSON.parse(Buffer.from(manifest.bytesBase64, 'base64').toString('utf8')) as {
      scripts: Array<{ src: string; integrity: string }>;
    };
    expect(decoded.scripts[0]!.src).toBe(scoped(hex(JS)));
    expect(decoded.scripts[0]!.integrity).toBe(sri(JS));
    expect(wire.root.source).toContain(`manifest="${scoped(manifest.contentHash)}"`);
  });

  it('keeps a complete model-authored manifest untouched', () => {
    const goodManifest = JSON.stringify({
      version: 'prismer-harness@1',
      scripts: [{ path: 'main.js', src: scoped(hex(JS)), integrity: sri(JS) }],
      styles: [],
      actions: [],
    });
    const input = {
      idempotencyKey: 'good-manifest',
      root: { filename: 'report.pkf', source: rootSource('manifest.json', 'data.csv') },
      resources: [
        { path: 'manifest.json', text: goodManifest, mime: 'application/json', usage: 'harness-manifest' as const },
        { path: 'main.js', text: JS, mime: 'text/javascript', usage: 'harness-script' as const },
        { path: 'data.csv', text: CSV, mime: 'text/csv', usage: 'data' as const },
      ],
    };
    const { input: wire } = normalizePkfBundleCommit(input, WS);
    const manifest = wire.resources.find((r) => r.usage === 'harness-manifest')!;
    expect(Buffer.from(manifest.bytesBase64, 'base64').toString('utf8')).toBe(goodManifest);
    expect(wire.root.source).toContain(`manifest="${scoped(manifest.contentHash)}"`);
  });
});
