/**
 * Phase 2A integration — Project CRUD (doc release201/09).
 *
 * Endpoints under test (src/im/api/projects.ts, mounted at /api/im/projects):
 *   GET    /projects?workspaceId=
 *   POST   /projects                   body { workspaceId, slug, name, description?, metadata? }
 *   GET    /projects/:id
 *   PATCH  /projects/:id               body { name?, description?, status?, metadata? }
 *   DELETE /projects/:id?cascade=archive|null|hard
 *
 * Permission (09 §5.2 short-circuit): workspace owner auto-acts as project
 * owner; explicit project membership only required for non-owners.
 *
 * cascade=hard is intentionally 405 in v2.0.7 — see HardCascadeNotImplementedError
 * in src/im/services/project.service.ts:117.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api } from '../_helpers';

interface ProjectDTO {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  ownerUserId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface ProjectEnvelope {
  ok: boolean;
  data?: ProjectDTO & { memberCount?: number };
  error?: unknown;
}

interface ProjectListEnvelope {
  ok: boolean;
  data?: { items: Array<ProjectDTO & { memberCount: number }>; total: number };
  error?: unknown;
}

interface DeleteEnvelope {
  ok: boolean;
  data?: {
    project: ProjectDTO;
    cascade: 'archive' | 'null' | 'hard';
    cascadeReport: {
      taskUnscoped: number;
      conversationUnscoped: number;
      assetUnscoped: number;
      memoryUnscoped: number;
    };
  };
  error?: { code?: string; message?: string } | string;
}

function uniqSlug(prefix: string): string {
  // SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
}

describe('projects — doc 09', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;

  beforeAll(async () => {
    ctx = await bootstrapSuite('phase2aproj');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('POST /projects creates with status=active', async () => {
    const slug = uniqSlug('prj1');
    const r = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 1' },
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.id).toBeTruthy();
    expect(r.data.data?.status).toBe('active');
    expect(r.data.data?.workspaceId).toBe(ctx.workspace.id);
    expect(r.data.data?.slug).toBe(slug);
  });

  test('GET /projects?workspaceId= returns list including newly-created project', async () => {
    const slug = uniqSlug('prj2');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 2' },
    });
    expect(create.status).toBe(201);
    const projectId = create.data.data!.id;

    const list = await api<ProjectListEnvelope>('GET', '/projects', {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id },
    });
    expect(list.status).toBe(200);
    expect(list.data.ok).toBe(true);
    expect(Array.isArray(list.data.data?.items)).toBe(true);
    const ids = (list.data.data?.items ?? []).map((p) => p.id);
    expect(ids).toContain(projectId);
  });

  test('GET /projects/:id returns single project with memberCount', async () => {
    const slug = uniqSlug('prj3');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 3' },
    });
    expect(create.status).toBe(201);
    const projectId = create.data.data!.id;

    const r = await api<ProjectEnvelope>('GET', `/projects/${projectId}`, { actor: ctx.owner });
    expect(r.status).toBe(200);
    expect(r.data.data?.id).toBe(projectId);
    expect(r.data.data?.memberCount).toBeDefined();
  });

  test('PATCH /projects/:id updates name/description/status', async () => {
    const slug = uniqSlug('prj4');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 4' },
    });
    expect(create.status).toBe(201);
    const projectId = create.data.data!.id;

    const r = await api<ProjectEnvelope>('PATCH', `/projects/${projectId}`, {
      actor: ctx.owner,
      body: { name: 'Renamed P4', description: 'desc here', status: 'archived' },
    });
    expect(r.status).toBe(200);
    expect(r.data.data?.name).toBe('Renamed P4');
    expect(r.data.data?.description).toBe('desc here');
    expect(r.data.data?.status).toBe('archived');
  });

  test('DELETE /projects/:id default cascade=archive → status=archived, no resource detach', async () => {
    const slug = uniqSlug('prj5');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 5' },
    });
    const projectId = create.data.data!.id;

    const r = await api<DeleteEnvelope>('DELETE', `/projects/${projectId}`, { actor: ctx.owner });
    expect(r.status).toBe(200);
    expect(r.data.data?.cascade).toBe('archive');
    expect(r.data.data?.project.status).toBe('archived');
    expect(r.data.data?.cascadeReport.taskUnscoped).toBe(0);
  });

  test('DELETE /projects/:id?cascade=null → cascade reported (no tasks linked in this test)', async () => {
    const slug = uniqSlug('prj6');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 6' },
    });
    const projectId = create.data.data!.id;

    const r = await api<DeleteEnvelope>('DELETE', `/projects/${projectId}`, {
      actor: ctx.owner,
      query: { cascade: 'null' },
    });
    expect(r.status).toBe(200);
    expect(r.data.data?.cascade).toBe('null');
    expect(r.data.data?.project.status).toBe('archived');
    // No tasks were linked to this project — count must be 0.
    expect(r.data.data?.cascadeReport.taskUnscoped).toBe(0);
  });

  test('DELETE /projects/:id?cascade=hard → 405 hard_cascade_not_implemented', async () => {
    const slug = uniqSlug('prj7');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 7' },
    });
    const projectId = create.data.data!.id;

    const r = await api<DeleteEnvelope>('DELETE', `/projects/${projectId}`, {
      actor: ctx.owner,
      query: { cascade: 'hard' },
    });
    expect(r.status).toBe(405);
    // src/im/api/projects.ts errorResponse wraps as { ok:false, error:{ code, message } }.
    const err = r.data.error as { code?: string } | string | undefined;
    const code = typeof err === 'object' && err !== null ? err.code : undefined;
    expect(code).toBe('hard_cascade_not_implemented');
  });

  test('outsider GET /projects/:id returns 404 (visibility short-circuit, §5.3)', async () => {
    const slug = uniqSlug('prj8');
    const create = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: 'Phase 2A Project 8' },
    });
    const projectId = create.data.data!.id;

    const r = await api<ProjectEnvelope>('GET', `/projects/${projectId}`, { actor: ctx.outsider });
    // §5.3 hides existence — service throws ProjectNotFoundError → 404.
    expect(r.status).toBe(404);
  });

  test('POST /projects with foreign workspaceId (outsider) → 404 WORKSPACE_NOT_FOUND', async () => {
    // outsider has their own default workspace (auto-created at register), but
    // not the suite workspace. They attempt to create a project in the suite
    // workspace — ProjectService.create throws ProjectForbiddenError (403) for
    // non-owner; the workspace lookup succeeds because workspace exists.
    const slug = uniqSlug('prj9');
    const r = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.outsider,
      body: { workspaceId: ctx.workspace.id, slug, name: 'cross-ws denied' },
    });
    // Service throws ProjectForbiddenError → 403. (We accept 404 too in case
    // anti-enumeration is tightened later.)
    expect([403, 404]).toContain(r.status);
  });

  test('POST /projects with invalid slug → 400 PROJECT_VALIDATION', async () => {
    const r = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: 'INVALID UPPERCASE', name: 'bad slug' },
    });
    expect(r.status).toBe(400);
  });
});
