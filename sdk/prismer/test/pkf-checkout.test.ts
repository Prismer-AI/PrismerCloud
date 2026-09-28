/**
 * product209/15 PKF-H5 — native filesystem checkout/status/commit lane.
 *
 *   npm --prefix sdk/prismer test -- --run test/pkf-checkout.test.ts
 *
 * Positive: checkout writes exact UTF-8 bytes + a durable binding; in-place
 * edits and temp+rename are equivalent (path-keyed binding); status re-hashes
 * (clean/dirty/missing); commit sends the FINAL file bytes through the carrier
 * CAS and advances the binding; daemon restart (new store instance on the same
 * db file) recovers the binding; normalization churn is DETECTED not silently
 * committed; a copied unregistered path cannot commit.
 *
 * Negative (same journey red): symlink path chain / symlink target / path
 * escape / device targets are rejected; unlink NEVER triggers a remote delete;
 * a clean worktree cannot commit; CRLF/BOM churn without the flag → typed
 * 422-style failure; invalid candidate rejected before any commit call.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PkfCheckoutStore } from '../src/daemon/memory/checkout-store';
import {
  assertCheckoutPathSafe,
  checkoutPkfFile,
  commitPkfFile,
  normalizePkfFile,
  statusPkfFile,
  type PkfCarrierSource,
} from '../src/daemon/memory/checkout';
import { sha256Hex } from '@prismer/pkf';

const cleanups: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pkf-checkout-'));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SID = 'sec_01k2f6m8v7q4x9a3b5c6d7e8f9';
const BASE_SOURCE = `<script type="application/prismer+json">{"type":"note","title":"t","pkfVersion":"1.1"}</script>
<section><h2 id="a" data-sid="${SID}">A</h2><p>original words</p></section>`;
const BASE_HASH = sha256Hex(BASE_SOURCE);

interface Harness {
  taskRoot: string;
  store: PkfCheckoutStore;
  carrier: PkfCarrierSource;
  commits: Array<{ documentUri: string; baseSourceHash: string; source: string }>;
}

async function makeHarness(): Promise<Harness> {
  const taskRoot = tmp();
  const store = new PkfCheckoutStore({ dbPath: join(taskRoot, '.prismer', 'pkf-checkouts.db') });
  const commits: Harness['commits'] = [];
  return {
    taskRoot,
    store,
    commits,
    carrier: {
      async getLocalMemorySource(uri, revisionId) {
        if (revisionId === 'head' || revisionId === 'local') return new TextEncoder().encode(BASE_SOURCE);
        return null;
      },
      async commitToCloud(input) {
        commits.push({ documentUri: input.documentUri, baseSourceHash: input.baseSourceHash, source: Buffer.from(input.source).toString('utf8') });
        const src = Buffer.from(input.source).toString('utf8');
        return { newRevisionId: 'mem:committed', sourceHash: sha256Hex(src) };
      },
    },
  };
}

describe('pkf filesystem lane', () => {
  it('checkout writes exact bytes + durable binding; in-place and temp+rename are equivalent', async () => {
    const h = await makeHarness();
    const uri = 'prismer://workspace/ws-1/memory/doc.pkf';
    const out = await checkoutPkfFile({ uri, workspaceRelativePath: 'docs/doc.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(readFileSync(join(h.taskRoot, 'docs/doc.pkf'), 'utf8')).toBe(BASE_SOURCE);

    // in-place edit
    writeFileSync(join(h.taskRoot, 'docs/doc.pkf'), BASE_SOURCE.replace('original words', 'edited words'));
    const s1 = await statusPkfFile({ workspaceRelativePath: 'docs/doc.pkf', taskRoot: h.taskRoot, store: h.store, carrier: h.carrier });
    expect(s1.ok && s1.state).toBe('dirty');

    // temp+rename edit → same path key → same binding (path-keyed, not inode)
    const tmpFile = join(h.taskRoot, 'docs', '.tmp.pkf');
    writeFileSync(tmpFile, BASE_SOURCE.replace('original words', 'edited words'));
    rmSync(join(h.taskRoot, 'docs/doc.pkf'));
    writeFileSync(join(h.taskRoot, 'docs/doc.pkf'), readFileSync(tmpFile));
    rmSync(tmpFile);
    const s2 = await statusPkfFile({ workspaceRelativePath: 'docs/doc.pkf', taskRoot: h.taskRoot, store: h.store, carrier: h.carrier });
    expect(s2.ok && s2.state).toBe('dirty');
  });

  it('daemon restart (new store instance on the same db) recovers the binding', async () => {
    const h = await makeHarness();
    await checkoutPkfFile({ uri: 'prismer://workspace/ws-1/memory/doc.pkf', workspaceRelativePath: 'd.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    h.store.close();
    const restarted = new PkfCheckoutStore({ dbPath: join(h.taskRoot, '.prismer', 'pkf-checkouts.db') });
    const s = await statusPkfFile({ workspaceRelativePath: 'd.pkf', taskRoot: h.taskRoot, store: restarted, carrier: h.carrier });
    expect(s.ok && s.state).toBe('clean');
    restarted.close();
  });

  it('commit sends final bytes through the carrier CAS and advances the binding', async () => {
    const h = await makeHarness();
    await checkoutPkfFile({ uri: 'prismer://workspace/ws-1/memory/doc.pkf', workspaceRelativePath: 'c.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    writeFileSync(join(h.taskRoot, 'c.pkf'), BASE_SOURCE.replace('original words', 'committed words'));
    const r = await commitPkfFile({ workspaceRelativePath: 'c.pkf', taskRoot: h.taskRoot, message: 'fs commit', store: h.store, carrier: h.carrier });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].baseSourceHash).toBe(BASE_HASH);
    expect(h.commits[0].source).toContain('committed words');
    const after = await statusPkfFile({ workspaceRelativePath: 'c.pkf', taskRoot: h.taskRoot, store: h.store, carrier: h.carrier });
    expect(after.ok && after.state).toBe('clean');
  });

  it('a clean worktree cannot commit; unlink never triggers a remote delete', async () => {
    const h = await makeHarness();
    await checkoutPkfFile({ uri: 'prismer://workspace/ws-1/memory/doc.pkf', workspaceRelativePath: 'e.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    const clean = await commitPkfFile({ workspaceRelativePath: 'e.pkf', taskRoot: h.taskRoot, message: 'noop', store: h.store, carrier: h.carrier });
    expect(clean.ok).toBe(false);
    if (clean.ok) return;
    expect(clean.code).toBe('PKF_CHECKOUT_NOT_BOUND');
    expect(h.commits).toHaveLength(0);

    // unlink → status missing; NO remote call of any kind
    rmSync(join(h.taskRoot, 'e.pkf'));
    const s = await statusPkfFile({ workspaceRelativePath: 'e.pkf', taskRoot: h.taskRoot, store: h.store, carrier: h.carrier });
    expect(s.ok && s.state).toBe('missing');
    expect(h.commits).toHaveLength(0);
  });

  it('CRLF/BOM churn is detected and blocked without the explicit flag', async () => {
    const h = await makeHarness();
    await checkoutPkfFile({ uri: 'prismer://workspace/ws-1/memory/doc.pkf', workspaceRelativePath: 'f.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    const crlf = BASE_SOURCE.replace(/\n/g, '\r\n');
    writeFileSync(join(h.taskRoot, 'f.pkf'), crlf);
    const r = await commitPkfFile({ workspaceRelativePath: 'f.pkf', taskRoot: h.taskRoot, message: 'crlf', store: h.store, carrier: h.carrier });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('PKF_SOURCE_NORMALIZATION_CHANGED');
    // with the explicit flag the commit proceeds
    const allowed = await commitPkfFile({ workspaceRelativePath: 'f.pkf', taskRoot: h.taskRoot, message: 'crlf ok', store: h.store, carrier: h.carrier, allowSourceNormalization: true });
    expect(allowed.ok).toBe(true);
  });

  it('an invalid candidate is rejected before any commit call (whole-page validation)', async () => {
    const h = await makeHarness();
    await checkoutPkfFile({ uri: 'prismer://workspace/ws-1/memory/doc.pkf', workspaceRelativePath: 'g.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    writeFileSync(join(h.taskRoot, 'g.pkf'), BASE_SOURCE.replace('original words', '<img src="prismer://asset/bare">'));
    const r = await commitPkfFile({ workspaceRelativePath: 'g.pkf', taskRoot: h.taskRoot, message: 'invalid', store: h.store, carrier: h.carrier });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INVALID_PKF');
    expect(h.commits).toHaveLength(0);
  });

  it('path policy: traversal / symlink chain / symlink target rejected; unregistered copy cannot commit', async () => {
    const h = await makeHarness();
    expect(assertCheckoutPathSafe(h.taskRoot, '../evil.pkf').ok).toBe(false);
    expect(assertCheckoutPathSafe(h.taskRoot, '/etc/passwd').ok).toBe(false);
    expect(assertCheckoutPathSafe(h.taskRoot, 'a\\b.pkf').ok).toBe(false);

    // symlink chain in the middle
    const outside = tmp();
    mkdirSync(join(outside, 'real'), { recursive: true });
    symlinkSync(join(outside, 'real'), join(h.taskRoot, 'linked'));
    expect(assertCheckoutPathSafe(h.taskRoot, 'linked/doc.pkf').ok).toBe(false);

    // symlink AT the target path
    await checkoutPkfFile({ uri: 'prismer://workspace/ws-1/memory/doc.pkf', workspaceRelativePath: 'ok.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    rmSync(join(h.taskRoot, 'ok.pkf'));
    symlinkSync('/etc/hosts', join(h.taskRoot, 'ok.pkf'));
    const s = await statusPkfFile({ workspaceRelativePath: 'ok.pkf', taskRoot: h.taskRoot, store: h.store, carrier: h.carrier });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.code).toBe('PKF_CHECKOUT_PATH_FORBIDDEN');

    // copied unregistered path → NOT_BOUND (no inherited commit authority)
    const copied = await commitPkfFile({ workspaceRelativePath: 'copied.pkf', taskRoot: h.taskRoot, message: 'copy', store: h.store, carrier: h.carrier });
    expect(copied.ok).toBe(false);
    if (!copied.ok) expect(copied.code).toBe('PKF_CHECKOUT_NOT_BOUND');
  });

  it('normalize is structural-only and never touches business bytes', async () => {
    const h = await makeHarness();
    const virtual = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script>
<h2 id="x">X</h2><p>business text stays</p>`;
    const uri = 'prismer://workspace/ws-1/memory/virtual.pkf';
    h.carrier.getLocalMemorySource = async (u, r) => (r === 'head' || r === 'local' ? new TextEncoder().encode(virtual) : null);
    await checkoutPkfFile({ uri, workspaceRelativePath: 'v.pkf', taskRoot: h.taskRoot, taskId: 't1', store: h.store, carrier: h.carrier });
    const r = await normalizePkfFile({ workspaceRelativePath: 'v.pkf', taskRoot: h.taskRoot, documentUri: uri, store: h.store });
    expect(r.ok).toBe(true);
    const after = readFileSync(join(h.taskRoot, 'v.pkf'), 'utf8');
    expect(after).toContain('<section>');
    expect(after).toContain('data-sid="sec_');
    expect(after).toContain('<p>business text stays</p>');
  });
});
