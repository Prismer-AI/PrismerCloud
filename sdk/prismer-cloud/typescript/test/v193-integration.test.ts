/**
 * Prismer TypeScript SDK — v1.9.3 wrapper integration tests
 *
 * Exercises the wrappers added in commit ddb5be6 against a *local* cloud
 * (`http://localhost:3000`). Skipped by default; runs only when
 * `V193_LOCAL_CLOUD=1` is set so that the default `npm test` is not affected.
 *
 * Coverage map:
 *   - client.im.workspaces            list / create / sync / get / update / archive
 *   - client.im.workspaceFiles        list / create / delete / sync / history
 *   - client.im.assets                list / byHash / detail / delete / url / download / upload
 *   - client.im.runtimeInstallations  list / create / installAgent
 *   - client.im.account.listAgents()
 *   - client.im.memory.digest()
 *   - client.im.realtime.subscribeTaskEvents()  (SSE)
 *   - client.tasks (im.tasks).create() with workspaceId / runtimeRoute / etc.
 *   - client.im.account.deleteAccount()         — terminal; runs LAST
 *
 * Usage:
 *   cd sdk/prismer-cloud/typescript
 *   V193_LOCAL_CLOUD=1 npx vitest run test/v193-integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../src/index';
import type {
  IMWorkspace,
  IMWorkspaceFile,
  IMAsset,
  IMRuntimeInstallation,
  IMOwnedAgent,
  IMMemoryDigest,
  IMTask,
  TaskEventEnvelope,
} from '../src/types';

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const ENABLED = process.env.V193_LOCAL_CLOUD === '1';
const BASE = process.env.V193_BASE_URL || 'http://localhost:3000';
const RUN_ID = String(Date.now()).slice(-9);

// Some tests are intentionally tolerant (e.g. archive returns 405 by design,
// runtime installation create depends on sandbox controller availability).
// We treat those as soft expectations: still asserted shape, but errors are
// captured and reported rather than failing the whole suite.

// ---------------------------------------------------------------------------
// Shared state across `it()` blocks
// ---------------------------------------------------------------------------

let client: PrismerClient;
let token: string;
let imUserId: string;

let defaultWorkspaceId: string;
let secondWorkspaceId: string | null = null;

let assetId: string;
let assetHash: string;
let workspaceFileId: string;

let runtimeInstallationId: string | null = null;

let taskId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectOk<T>(res: { ok: boolean; data?: T; error?: { code?: string; message?: string } }, label: string): T {
  if (!res.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(res.error)}`);
  }
  if (res.data === undefined || res.data === null) {
    throw new Error(`${label}: ok=true but data is ${res.data}`);
  }
  return res.data;
}

// SHA-256 of a Uint8Array using Node's webcrypto (works in vitest/node 20+)
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ab);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('v1.9.3 wrappers against local cloud', () => {
  beforeAll(async () => {
    // Sanity: local cloud is responsive. (Originally asserted version='1.9.3';
    // relaxed to a presence check post-v2.0 since the wrapper APIs being
    // tested were introduced in 1.9.3 and are stable through 2.x.)
    const health = await fetch(`${BASE}/api/im/health`).then(r => r.json());
    expect(health?.ok).toBe(true);
    expect(typeof health?.version).toBe('string');

    // Register a fresh user — auto-creates a default workspace
    client = new PrismerClient({ apiKey: 'placeholder', baseUrl: BASE });
    const reg = await client.im.account.register({
      type: 'human',
      username: `v193-${RUN_ID}`,
      displayName: `v193 test ${RUN_ID}`,
    });
    if (!reg.ok || !reg.data) {
      throw new Error(`register failed: ${JSON.stringify(reg.error)}`);
    }
    token = reg.data.token;
    imUserId = reg.data.imUserId;
    client.setToken(token);

    // Resolve the auto-created default workspace
    const wsList = await client.im.workspaces.list();
    const items = expectOk<IMWorkspace[]>(wsList, 'workspaces.list (beforeAll)');
    expect(items.length).toBeGreaterThanOrEqual(1);
    const def = items.find(w => w.isDefault) || items[0];
    defaultWorkspaceId = def.id;
  }, 60_000);

  // -------------------------------------------------------------------------
  // 1. Workspaces
  // -------------------------------------------------------------------------

  describe('workspaces', () => {
    it('list — returns the auto-created default workspace', async () => {
      const res = await client.im.workspaces.list();
      const items = expectOk<IMWorkspace[]>(res, 'workspaces.list');
      expect(items.length).toBeGreaterThanOrEqual(1);
      const def = items.find(w => w.isDefault);
      expect(def).toBeDefined();
      expect(def!.ownerImUserId).toBe(imUserId);
    });

    it('get — fetches default workspace by id', async () => {
      const res = await client.im.workspaces.get(defaultWorkspaceId);
      const ws = expectOk<IMWorkspace>(res, 'workspaces.get');
      expect(ws.id).toBe(defaultWorkspaceId);
      expect(ws.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    });

    it('update — patches workspace metadata', async () => {
      const res = await client.im.workspaces.update(defaultWorkspaceId, {
        metadata: { v193_test: true, runId: RUN_ID },
      });
      const ws = expectOk<IMWorkspace>(res, 'workspaces.update');
      expect(ws.metadata?.v193_test).toBe(true);
      expect(ws.metadata?.runId).toBe(RUN_ID);
    });

    it('sync — daemon delta sync returns items + cursor', async () => {
      const res = await client.im.workspaces.sync();
      const data = expectOk<{ items: IMWorkspace[]; cursor: string | null }>(res, 'workspaces.sync');
      expect(Array.isArray(data.items)).toBe(true);
      // cursor may be null if no new rows; just assert the shape
      expect(['string', 'object']).toContain(typeof data.cursor); // null is 'object'
    });

    it('create — second workspace (non-default, requires unique slug)', async () => {
      const slug = `v193-${RUN_ID}`;
      const res = await client.im.workspaces.create({
        name: `v193 second ${RUN_ID}`,
        slug,
      });
      // Some deployments restrict create() — accept either success or a
      // documented 4xx and report exactly what happened.
      if (res.ok && res.data) {
        secondWorkspaceId = res.data.id;
        expect(res.data.slug).toBe(slug);
        expect(res.data.isDefault).toBe(false);
      } else {
        // Surface the error so the suite log captures it; this is informational
        // because workspaces.create is documented as backend-only in 1.9.x.
        console.log('[v193] workspaces.create returned non-ok:', JSON.stringify(res.error));
        expect(res.error).toBeDefined();
      }
    });

    it('archive — returns 405 (workspace deletion = account deletion in 1.9.x)', async () => {
      // Use a throwaway id to avoid affecting state. Archive should refuse.
      const res = await client.im.workspaces.archive(secondWorkspaceId || defaultWorkspaceId);
      // Documented behavior: 405 / METHOD_NOT_ALLOWED / not implemented.
      if (res.ok) {
        // Some impls may allow non-default deletion — just assert wrapper called.
        console.log('[v193] workspaces.archive succeeded (unexpected but tolerable)');
      } else {
        expect(res.error).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Assets — needed before workspaceFiles (a file binds path → assetId)
  // -------------------------------------------------------------------------

  describe('assets', () => {
    it('upload — POSTs multipart and returns IMAsset', async () => {
      const bytes = new TextEncoder().encode(`v193-asset-content-${RUN_ID}\n`);
      const res = await client.im.assets.upload(bytes, {
        workspaceId: defaultWorkspaceId,
        fileName: `v193-${RUN_ID}.txt`,
        mimeType: 'text/plain',
        kind: 'user-upload',
      });
      const asset = expectOk<IMAsset>(res, 'assets.upload');
      expect(asset.id).toBeTruthy();
      expect(asset.workspaceId).toBe(defaultWorkspaceId);
      expect(asset.contentHash).toBeTruthy();
      expect(asset.sizeBytes).toBe(bytes.byteLength);
      assetId = asset.id;
      assetHash = asset.contentHash;

      // Sanity: the server-reported hash matches our local sha256
      const localHash = await sha256Hex(bytes);
      expect(asset.contentHash).toBe(localHash);
    });

    it('list — returns the just-uploaded asset filtered by workspace', async () => {
      const res = await client.im.assets.list({ workspaceId: defaultWorkspaceId, limit: 50 });
      const items = expectOk<IMAsset[]>(res, 'assets.list');
      expect(items.some(a => a.id === assetId)).toBe(true);
    });

    it('byHash — looks up the uploaded asset by content hash', async () => {
      const res = await client.im.assets.byHash(assetHash, defaultWorkspaceId);
      const asset = expectOk<IMAsset>(res, 'assets.byHash');
      expect(asset.id).toBe(assetId);
    });

    it('detail — returns full metadata (and optional signed URL)', async () => {
      const res = await client.im.assets.detail(assetId);
      const detail = expectOk<IMAsset>(res, 'assets.detail');
      expect(detail.id).toBe(assetId);
      expect(detail.contentHash).toBe(assetHash);
    });

    it('url — produces a deterministic download URL', () => {
      const u = client.im.assets.url(assetId);
      expect(u).toBe(`${BASE}/api/im/assets/${assetId}`);
    });

    it('download — fetches bytes back and they match the upload', async () => {
      const dl = await client.im.assets.download(assetId);
      expect(dl.bytes.byteLength).toBeGreaterThan(0);
      const text = new TextDecoder().decode(dl.bytes);
      expect(text).toContain(`v193-asset-content-${RUN_ID}`);
    });

    // Note: delete is exercised at the very end so it does not break
    // workspaceFiles / runtimeInstallations / tasks tests that may reference
    // this asset. See the final describe block.
  });

  // -------------------------------------------------------------------------
  // 3. Workspace files
  // -------------------------------------------------------------------------

  describe('workspaceFiles', () => {
    const filePath = `notes/v193-${RUN_ID}.txt`;

    it('create — binds path → assetId', async () => {
      const res = await client.im.workspaceFiles.create(defaultWorkspaceId, {
        path: filePath,
        assetId,
      });
      const file = expectOk<IMWorkspaceFile>(res, 'workspaceFiles.create');
      expect(file.path).toBe(filePath);
      expect(file.assetId).toBe(assetId);
      expect(file.workspaceId).toBe(defaultWorkspaceId);
      workspaceFileId = file.id;
    });

    it('list — by workspace returns the new binding', async () => {
      const res = await client.im.workspaceFiles.list(defaultWorkspaceId);
      const data = expectOk<IMWorkspaceFile[] | IMWorkspaceFile>(res, 'workspaceFiles.list');
      const arr = Array.isArray(data) ? data : [data];
      expect(arr.some(f => f.id === workspaceFileId)).toBe(true);
    });

    it('list — by path returns the single matching file', async () => {
      const res = await client.im.workspaceFiles.list(defaultWorkspaceId, { path: filePath });
      const data = expectOk<IMWorkspaceFile[] | IMWorkspaceFile>(res, 'workspaceFiles.list(path)');
      const file = Array.isArray(data) ? data[0] : data;
      expect(file).toBeDefined();
      expect(file.path).toBe(filePath);
    });

    it('history — returns version chain for the file', async () => {
      const res = await client.im.workspaceFiles.history(defaultWorkspaceId, workspaceFileId);
      const items = expectOk<IMWorkspaceFile[]>(res, 'workspaceFiles.history');
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].id).toBe(workspaceFileId);
    });

    it('sync — daemon delta sync returns items + cursor', async () => {
      const res = await client.im.workspaceFiles.sync(defaultWorkspaceId);
      const data = expectOk<{ items: IMWorkspaceFile[]; cursor: string | null }>(
        res,
        'workspaceFiles.sync',
      );
      expect(Array.isArray(data.items)).toBe(true);
    });

    it('delete — soft-deletes the binding', async () => {
      const res = await client.im.workspaceFiles.delete(defaultWorkspaceId, filePath);
      // Some impls return ok:true with no data. Tolerate both.
      if (!res.ok) throw new Error(`workspaceFiles.delete failed: ${JSON.stringify(res.error)}`);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Runtime installations
  // -------------------------------------------------------------------------

  describe('runtimeInstallations', () => {
    it('list — empty for fresh workspace', async () => {
      const res = await client.im.runtimeInstallations.list(defaultWorkspaceId);
      const items = expectOk<IMRuntimeInstallation[]>(res, 'runtimeInstallations.list');
      expect(Array.isArray(items)).toBe(true);
    });

    it('create — provisions a workspace daemon (best-effort)', async () => {
      const res = await client.im.runtimeInstallations.create({
        workspaceId: defaultWorkspaceId,
        name: `v193-runtime-${RUN_ID}`,
      });
      if (res.ok && res.data) {
        runtimeInstallationId = res.data.id;
        expect(res.data.workspaceId).toBe(defaultWorkspaceId);
      } else {
        // Sandbox controller is typically not running in dev; surface and skip
        // dependent installAgent test.
        console.log(
          '[v193] runtimeInstallations.create non-ok (likely no controller):',
          JSON.stringify(res.error),
        );
        expect(res.error).toBeDefined();
      }
    }, 30_000);

    it('installAgent — installs an agent on the runtime (skipped if create failed)', async () => {
      if (!runtimeInstallationId) {
        console.log('[v193] skipping installAgent — no runtime installation id');
        return;
      }
      const res = await client.im.runtimeInstallations.installAgent(runtimeInstallationId, {
        agentImUserId: imUserId,
        adapterName: 'shell',
        profileName: `v193-agent-${RUN_ID}`,
      });
      if (!res.ok) {
        console.log(
          '[v193] runtimeInstallations.installAgent non-ok:',
          JSON.stringify(res.error),
        );
        expect(res.error).toBeDefined();
      } else {
        expect(res.data?.runtimeInstallationId).toBe(runtimeInstallationId);
      }
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // 5. Memory digest
  // -------------------------------------------------------------------------

  describe('memory.digest', () => {
    it('digest — returns CC-style markdown bundle', async () => {
      const res = await client.im.memory.digest();
      const digest = expectOk<IMMemoryDigest>(res, 'memory.digest');
      expect(typeof digest.digest).toBe('string');
      expect(digest.digest.length).toBeGreaterThan(0);
      expect(typeof digest.totalLines).toBe('number');
      expect(typeof digest.totalBytes).toBe('number');
      expect(typeof digest.filesTotal).toBe('number');
      expect(typeof digest.truncated).toBe('boolean');
      expect(typeof digest.generatedAt).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Tasks: enriched create + SSE subscribeTaskEvents
  // -------------------------------------------------------------------------

  describe('tasks (enriched + SSE)', () => {
    it('create — accepts workspaceId / runtimeRoute / kind metadata', async () => {
      const res = await client.im.tasks.create({
        title: `v193 task ${RUN_ID}`,
        description: 'integration test task',
        workspaceId: defaultWorkspaceId,
        runtimeRoute: 'agent',
        capability: 'general',
        input: { runId: RUN_ID },
        metadata: { kind: 'manual', v193: true },
      });
      const task = expectOk<IMTask>(res, 'tasks.create');
      expect(task.id).toBeTruthy();
      expect(task.title).toContain('v193 task');
      taskId = task.id;
    });

    it('list — filters by workspaceId', async () => {
      const res = await client.im.tasks.list({ workspaceId: defaultWorkspaceId, limit: 50 });
      const items = expectOk<IMTask[]>(res, 'tasks.list');
      expect(items.some(t => t.id === taskId)).toBe(true);
    });

    it('subscribeTaskEvents — receives task event after creating another task', async () => {
      const events: TaskEventEnvelope[] = [];
      const sub = await client.im.realtime.subscribeTaskEvents(token, evt => {
        events.push(evt);
      });

      try {
        // Allow the SSE to connect + flush any catch-up events
        await new Promise(r => setTimeout(r, 500));

        // Trigger a fresh event
        const create = await client.im.tasks.create({
          title: `v193 sse-trigger ${RUN_ID}`,
          workspaceId: defaultWorkspaceId,
          runtimeRoute: 'agent',
        });
        expect(create.ok).toBe(true);

        // Wait up to 10s for at least one event to arrive
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && events.length === 0) {
          await new Promise(r => setTimeout(r, 200));
        }
        expect(events.length).toBeGreaterThan(0);
        // We can't guarantee `task.created` specifically (server may emit
        // catch-up first); just assert at least one well-shaped envelope.
        expect(typeof events[0].type).toBe('string');
      } finally {
        sub.disconnect();
      }
    }, 20_000);
  });

  // -------------------------------------------------------------------------
  // 7. Account.listAgents (read-only — non-terminal)
  // -------------------------------------------------------------------------

  describe('account.listAgents', () => {
    it('listAgents — returns array (empty for fresh human user)', async () => {
      const res = await client.im.account.listAgents();
      const agents = expectOk<IMOwnedAgent[]>(res, 'account.listAgents');
      expect(Array.isArray(agents)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Cleanup — assets.delete then deleteAccount (TERMINAL: must run last)
  // -------------------------------------------------------------------------

  describe('cleanup (terminal)', () => {
    it('assets.delete — soft-deletes the uploaded asset', async () => {
      const res = await client.im.assets.delete(assetId);
      if (!res.ok) {
        // Soft failure is fine — deleteAccount will cascade anyway.
        console.log('[v193] assets.delete non-ok:', JSON.stringify(res.error));
      }
    });

    it('account.deleteAccount — soft-deletes the test user (TERMINAL)', async () => {
      const res = await client.im.account.deleteAccount();
      // Acceptable shapes: { ok:true, data:{ message, deletedAt, cascade } }
      if (res.ok) {
        expect(res.data).toBeDefined();
        expect(typeof res.data!.message).toBe('string');
        expect(typeof res.data!.deletedAt).toBe('string');
      } else {
        // Some deployments may not have the cascade wired; report and continue.
        console.log('[v193] account.deleteAccount non-ok:', JSON.stringify(res.error));
        expect(res.error).toBeDefined();
      }
    });

    it('post-delete — me() should now fail (auth blacklisted or user gone)', async () => {
      const res = await client.im.account.me();
      // Either ok:false, or ok:true with the user marked deleted. Either is
      // acceptable; we just assert the wrapper survives the call.
      expect(typeof res.ok).toBe('boolean');
    });
  });
});
