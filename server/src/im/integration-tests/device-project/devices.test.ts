/**
 * Phase A integration — Device × Project binding (release201/20 Gap A, M448).
 *
 * Endpoints under test:
 *   POST   /api/workspace/runtime-installations    body { workspaceId, kind, projectId?, ... }
 *   GET    /api/workspace/runtime-installations    query { workspaceId, projectId? }
 *   PATCH  /api/workspace/runtime-installations/:id   body { projectId?: string | null }
 *
 * Notes on test target:
 *   - These are Next.js App Router routes (NOT IM Hono). We hit them by passing
 *     absolute `/api/workspace/...` paths to the `api()` helper which bypasses
 *     the default `/api/im` prefix (see _helpers/http.ts resolveUrl).
 *   - Local dev MUST honour `K8S_CONTROLLER_AVAILABLE=false` so creating a row
 *     persists the synthetic 202 provisioning row without needing a real EKS
 *     cluster. The cloud route falls back to that path automatically when
 *     `hasK8sConfig()` is false; the assertions here therefore accept 200/201/202.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api } from '../_helpers';

interface ProjectDTO {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  status: 'active' | 'archived';
}
interface ProjectEnvelope {
  ok: boolean;
  data?: ProjectDTO;
  error?: unknown;
}

interface RuntimeInstallationDTO {
  id: string;
  workspaceId: string;
  projectId: string | null;
  daemonId: string;
  podName: string;
}
interface RuntimeInstallationEnvelope {
  ok: boolean;
  data?: RuntimeInstallationDTO;
  error?: { code?: string; message?: string } | string;
}
interface RuntimeInstallationListEnvelope {
  ok: boolean;
  data?: RuntimeInstallationDTO[];
  error?: unknown;
}

function uniqProjectSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
}

const SUCCESS_OR_PROVISIONING = [200, 201, 202];

describe('device × project binding (release201/20 Gap A, M448)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;
  let secondWorkspaceId: string;
  let activeProjectId: string;
  let secondWsProjectId: string;
  let archivedProjectId: string;

  beforeAll(async () => {
    ctx = await bootstrapSuite('devproj');

    // 1) Active project in the suite workspace.
    const active = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: uniqProjectSlug('active'), name: 'Active P' },
      expectStatus: 201,
    });
    activeProjectId = active.data.data!.id;

    // 2) Archived project (status flipped via PATCH so we can hit PROJECT_NOT_ACTIVE).
    const arch = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: uniqProjectSlug('arch'), name: 'Archived P' },
      expectStatus: 201,
    });
    archivedProjectId = arch.data.data!.id;
    await api('PATCH', `/projects/${archivedProjectId}`, {
      actor: ctx.owner,
      body: { status: 'archived' },
    });

    // 3) Separate workspace + project so we can test cross-workspace mismatch.
    const ws2 = await api<{ ok: boolean; data?: { id: string } }>('POST', '/workspaces', {
      actor: ctx.owner,
      body: { name: 'IT devproj ws2', slug: uniqProjectSlug('ws2') },
      expectStatus: 201,
    });
    secondWorkspaceId = ws2.data.data!.id;
    const ws2Project = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: secondWorkspaceId, slug: uniqProjectSlug('ws2p'), name: 'WS2 P' },
      expectStatus: 201,
    });
    secondWsProjectId = ws2Project.data.data!.id;
  }, 90_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('POST with projectId — persists projectId on the row', async () => {
    const r = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s', projectId: activeProjectId },
    });
    expect(SUCCESS_OR_PROVISIONING).toContain(r.status);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.projectId).toBe(activeProjectId);
    expect(r.data.data?.workspaceId).toBe(ctx.workspace.id);
  });

  test('POST projectId in wrong workspace — 422 PROJECT_WORKSPACE_MISMATCH', async () => {
    const r = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s', projectId: secondWsProjectId },
    });
    expect(r.status).toBe(422);
    const err = typeof r.data.error === 'object' && r.data.error !== null ? r.data.error : {};
    expect('code' in err ? err.code : undefined).toBe('PROJECT_WORKSPACE_MISMATCH');
  });

  test('POST projectId on archived project — 422 PROJECT_NOT_ACTIVE', async () => {
    const r = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s', projectId: archivedProjectId },
    });
    expect(r.status).toBe(422);
    const err = typeof r.data.error === 'object' && r.data.error !== null ? r.data.error : {};
    expect('code' in err ? err.code : undefined).toBe('PROJECT_NOT_ACTIVE');
  });

  test('POST without projectId — 200/201/202 with NULL projectId (backward compat)', async () => {
    const r = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s' },
    });
    expect(SUCCESS_OR_PROVISIONING).toContain(r.status);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.projectId).toBeNull();
  });

  test('GET ?projectId=<id> — list contains only scoped rows', async () => {
    // Bootstrap one explicitly-scoped row so the filter has something to find.
    await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s', projectId: activeProjectId },
    });

    const list = await api<RuntimeInstallationListEnvelope>('GET', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, projectId: activeProjectId },
    });
    expect(list.status).toBe(200);
    expect(list.data.ok).toBe(true);
    const items = list.data.data ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.projectId).toBe(activeProjectId);
    }
  });

  test('GET ?projectId=__unscoped — only NULL projectId rows', async () => {
    await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s' },
    });

    const list = await api<RuntimeInstallationListEnvelope>('GET', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, projectId: '__unscoped' },
    });
    expect(list.status).toBe(200);
    const items = list.data.data ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.projectId).toBeNull();
    }
  });

  test('GET ?projectId=all — no project filter applied (default behaviour)', async () => {
    const list = await api<RuntimeInstallationListEnvelope>('GET', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, projectId: 'all' },
    });
    expect(list.status).toBe(200);
    const items = list.data.data ?? [];
    // Mix of NULL + scoped rows from earlier tests.
    const projectIds = new Set(items.map((it) => it.projectId));
    expect(projectIds.size).toBeGreaterThanOrEqual(1);
  });

  test('PATCH /:id projectId=null — unbinds the installation', async () => {
    const created = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s', projectId: activeProjectId },
    });
    expect(SUCCESS_OR_PROVISIONING).toContain(created.status);
    const id = created.data.data!.id;

    const patched = await api<RuntimeInstallationEnvelope>('PATCH', `/api/workspace/runtime-installations/${id}`, {
      actor: ctx.owner,
      body: { projectId: null },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.data?.projectId).toBeNull();
  });

  test('PATCH /:id projectId=<new id> — rebinds to a different active project', async () => {
    // Need a second active project in the same workspace.
    const second = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: uniqProjectSlug('rebind'), name: 'Rebind P' },
      expectStatus: 201,
    });
    const secondId = second.data.data!.id;

    const created = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s' },
    });
    expect(SUCCESS_OR_PROVISIONING).toContain(created.status);
    const id = created.data.data!.id;

    const patched = await api<RuntimeInstallationEnvelope>('PATCH', `/api/workspace/runtime-installations/${id}`, {
      actor: ctx.owner,
      body: { projectId: secondId },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.data?.projectId).toBe(secondId);
  });

  test('PATCH /:id projectId cross-workspace — 422 PROJECT_WORKSPACE_MISMATCH', async () => {
    const created = await api<RuntimeInstallationEnvelope>('POST', '/api/workspace/runtime-installations', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, kind: 'k8s' },
    });
    expect(SUCCESS_OR_PROVISIONING).toContain(created.status);
    const id = created.data.data!.id;

    const patched = await api<RuntimeInstallationEnvelope>('PATCH', `/api/workspace/runtime-installations/${id}`, {
      actor: ctx.owner,
      body: { projectId: secondWsProjectId },
    });
    expect(patched.status).toBe(422);
    const err = typeof patched.data.error === 'object' && patched.data.error !== null ? patched.data.error : {};
    expect('code' in err ? err.code : undefined).toBe('PROJECT_WORKSPACE_MISMATCH');
  });
});
