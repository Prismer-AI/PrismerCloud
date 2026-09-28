// memory211 fix round (external review P1) — the T3 chunk lane respects the cap
// read boundary.
//
// Pre-fix hole: `runWorkspaceSearch` post-filtered hits with
// `store.loadById(r.pageId)`, but a chunk hit's `pageId` mirrors an ASSET id and
// `memory_pages` never has that row — so every chunk hit fell through the
// "!page" pass and was KEPT. The RPC search lane was therefore fail-OPEN for
// asset raw text while the hook recall path (filterRecallHits, which drops a hit
// with no page row) is fail-CLOSED: on a shared daemon, a scoped sub-agent cap
// could read any materialized asset's raw body via memory_search.
//
// Fix under test: chunk hits are judged by `canCapReadAsset` against the
// workspace's asset-ACL projection (the same fields the cloud `im_assets` row
// carries, mirrored locally by AssetMetadataIndex). No verdict ⇒ DENY.
//
// End to end over the real RPC surface (real LocalServer + attachMemoryRpc +
// minted caps), with the runner's resolver seam faked exactly the way runner.ts
// wires it — a local read of the workspace's asset projection. The in-test
// control proves the fixture: the SAME chunk text IS surfaced to the system cap
// (which bypasses the boundary), so a dark result for the scoped actor is the
// boundary and not an empty fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap, mintSystemCap, __resetCapKeyForTest } from '../src/daemon/memory/cap.js';
import type { AssetAclProjection } from '../src/daemon/memory/acl-predicate.js';
import type { ResolveAssetAcl } from '../src/daemon/memory/rpc.js';

const WS = 'ws_asset_cap';
const ACTOR = 'im_cap_actor';
const OTHER = 'im_other_owner';
const CAP_HEADER = 'x-prismer-memory-cap';

// Terms are asset-exclusive: each upload's chunk text matches only its own term.
const SHARED_TERM = 'Kelvinbypass42';
const RESTRICTED_TERM = 'Quasarcascade77';
const UNVERIFIED_TERM = 'Nebuladraft55';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

/**
 * The runner's seam, faked in-memory: the projection a real daemon reads from
 * its workspace AssetMetadataIndex. `asset_unverified` has NO row at all — the
 * fail-closed case (offline daemon / pre-v17 mirror / older cloud).
 */
const projection: Record<string, AssetAclProjection | null> = {
  asset_shared: { visibility: 'workspace', ownerImUserId: OTHER },
  asset_restricted: { visibility: 'user', ownerImUserId: OTHER },
  asset_unverified: null,
};
const resolveAssetAcl: ResolveAssetAcl = (workspaceId, assetId) => {
  if (workspaceId !== WS) return null;
  return projection[assetId] ?? null;
};

beforeEach(async () => {
  delete process.env.PRISMER_MEMORY_CAP;
  __resetCapKeyForTest();
  const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-cap-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, resolveAssetAcl }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);

  const { store } = runtime.resolve(WS);
  const chunkIn = (assetId: string, hash: string, term: string): void => {
    store.replaceAssetChunks({
      assetId,
      contentHash: hash,
      filename: `${assetId}.md`,
      rows: [
        {
          ordinal: 0,
          text: `The cooling loop manual. ${term} governs the intake valve of this upload.`,
          tokenEstimate: 16,
        },
      ],
    });
  };
  chunkIn('asset_shared', 'a'.repeat(64), SHARED_TERM);
  chunkIn('asset_restricted', 'b'.repeat(64), RESTRICTED_TERM);
  chunkIn('asset_unverified', 'c'.repeat(64), UNVERIFIED_TERM);
});

afterEach(async () => {
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exitCode = undefined;
});

interface SearchBody {
  results: Array<{ assetId?: string; path: string; snippet: string }>;
}

async function search(cap: string, q: string): Promise<SearchBody> {
  const res = await fetch(`${baseUrl}/local/memory/search?workspaceId=${WS}&q=${encodeURIComponent(q)}`, {
    headers: { [CAP_HEADER]: cap },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchBody;
}

describe('daemon chunk lane respects the cap read boundary (P1)', () => {
  it('a workspace-visible asset is still searchable (the lane survives the fix)', async () => {
    const body = await search(mintCap(ACTOR, WS)!, SHARED_TERM);
    const hits = body.results.filter((r) => r.assetId === 'asset_shared');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain(SHARED_TERM);
  });

  it('another actor-owned asset stays dark for a scoped cap — and the system cap still sees it (fixture control)', async () => {
    // NEGATIVE CONTROL SURFACE: the identical query over the identical chunk
    // rows DOES surface for the daemon-internal system cap, so the empty result
    // below is the boundary, not a fixture that never matched.
    const systemBody = await search(mintSystemCap(), RESTRICTED_TERM);
    expect(systemBody.results.some((r) => r.assetId === 'asset_restricted')).toBe(true);

    const body = await search(mintCap(ACTOR, WS)!, RESTRICTED_TERM);
    expect(body.results.filter((r) => r.assetId === 'asset_restricted')).toEqual([]);
    // Neither the path token nor the raw body may leak through another hit.
    expect(JSON.stringify(body.results)).not.toContain(RESTRICTED_TERM);
    expect(JSON.stringify(body.results)).not.toContain('asset_restricted');
  });

  it('an asset with no resolvable ACL verdict is dropped (fail-closed)', async () => {
    const body = await search(mintCap(ACTOR, WS)!, UNVERIFIED_TERM);
    expect(body.results.filter((r) => r.assetId === 'asset_unverified')).toEqual([]);
    expect(JSON.stringify(body.results)).not.toContain(UNVERIFIED_TERM);
    expect(JSON.stringify(body.results)).not.toContain('asset_unverified');
  });

  it('wiki pages are unaffected: the page boundary still governs non-asset hits', async () => {
    const store = runtime!.resolve(WS).store;
    store.write({
      workspaceId: WS,
      path: 'notes/shared-page.md',
      title: 'Shared page',
      content: `# Shared page\n\n${SHARED_TERM} also appears in a curated page.`,
      pageType: 'leaf',
      visibility: { kind: 'workspace' },
      actorImUserId: ACTOR,
      actorKind: 'agent',
    });
    const body = await search(mintCap(ACTOR, WS)!, SHARED_TERM);
    expect(body.results.some((r) => r.path === 'notes/shared-page.md')).toBe(true);
  });
});
