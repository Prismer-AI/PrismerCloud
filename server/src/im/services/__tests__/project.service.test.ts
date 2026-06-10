/**
 * Unit test for project.service.ts — release201/09 Phase 1 DoD (09 §0.2.1).
 *
 * Run:
 *   npx tsx src/im/services/__tests__/project.service.test.ts
 *
 * Pure in-process. Stubs the prisma models so no real DB is touched. Covers:
 *   • Workspace owner short-circuit (§5.2): owner is implicit project owner
 *   • CRUD validation (slug pattern, name required, status enum)
 *   • Permission gates: contributor/observer/none for update/delete/members
 *   • Membership conflict + role validation
 *   • Effective user role resolution (owner | contributor | observer | none)
 *
 * Forbidden log patterns checked: none in service layer.
 */

import {
  ProjectService,
  ProjectNotFoundError,
  WorkspaceNotFoundError,
  ProjectForbiddenError,
  ProjectValidationError,
  ProjectConflictError,
  MembershipNotFoundError,
  NotWorkspaceMemberError,
  HardCascadeNotImplementedError,
} from '../project.service';

import { prisma } from '@/lib/prisma';

// ─── In-memory fake tables ──────────────────────────────────────────────────
type Workspace = { id: string; ownerImUserId: string; deletedAt: Date | null };
type Project = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  ownerUserId: string;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};
type Membership = {
  id: string;
  projectId: string;
  principalKind: string;
  principalId: string;
  role: string;
  joinedAt: Date;
};
type Task = {
  id: string;
  workspaceId: string;
  projectId: string | null;
};

// release201/16 Phase 10 — workspace_members rows are now consulted by
// ProjectService.addMember for user-kind principals (§3.3.3a). Tests must
// seed members so existing "owner adds CONTRIB" paths still pass; agent
// principals are exempt by design.
type WorkspaceMember = { id: string; workspaceId: string; memberImUserId: string; role: string };

const workspaces: Workspace[] = [];
const workspaceMembers: WorkspaceMember[] = [];
const projects: Project[] = [];
const memberships: Membership[] = [];
const tasks: Task[] = [];
let projectIdCounter = 0;
let membershipIdCounter = 0;
let taskIdCounter = 0;

function resetDb() {
  workspaces.length = 0;
  workspaceMembers.length = 0;
  projects.length = 0;
  memberships.length = 0;
  tasks.length = 0;
  projectIdCounter = 0;
  membershipIdCounter = 0;
  taskIdCounter = 0;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === 'OR' && Array.isArray(v)) {
      const any = v.some((cond) => matchesWhere(row, cond as Record<string, unknown>));
      if (!any) return false;
      continue;
    }
    const cell = row[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const cond = v as Record<string, unknown>;
      if ('in' in cond) {
        if (!(cond.in as unknown[]).includes(cell)) return false;
        continue;
      }
      if ('contains' in cond) {
        if (typeof cell !== 'string' || !cell.includes(cond.contains as string)) return false;
        continue;
      }
    }
    if (cell !== v) return false;
  }
  return true;
}

(prisma as any).iMWorkspace = {
  async findFirst({ where }: { where: { id: string; deletedAt?: null } }) {
    return (
      workspaces.find((w) => w.id === where.id && (where.deletedAt === undefined || w.deletedAt === where.deletedAt)) ??
      null
    );
  },
};

// release201/16 Phase 10 — invariant check uses findUnique with the
// (workspaceId, memberImUserId) composite unique. Mirror that shape.
(prisma as any).iMWorkspaceMember = {
  async findUnique({ where }: any) {
    if (where.workspaceId_memberImUserId) {
      const { workspaceId, memberImUserId } = where.workspaceId_memberImUserId;
      return workspaceMembers.find((m) => m.workspaceId === workspaceId && m.memberImUserId === memberImUserId) ?? null;
    }
    return null;
  },
};

(prisma as any).iMProject = {
  async findUnique({ where }: { where: { id: string } }) {
    return projects.find((p) => p.id === where.id) ?? null;
  },
  async findMany({ where, take, skip, orderBy }: any) {
    let rows = projects.filter((p) => matchesWhere(p as unknown as Record<string, unknown>, where ?? {}));
    if (Array.isArray(orderBy)) {
      // simple multi-key compare: status then createdAt desc when status is asc.
      rows = [...rows].sort((a, b) => {
        for (const clause of orderBy) {
          const [field, dir] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
          const av = (a as any)[field];
          const bv = (b as any)[field];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (skip) rows = rows.slice(skip);
    if (take) rows = rows.slice(0, take);
    return rows;
  },
  async count({ where }: any) {
    return projects.filter((p) => matchesWhere(p as unknown as Record<string, unknown>, where ?? {})).length;
  },
  async create({ data }: any) {
    const dup = projects.find((p) => p.workspaceId === data.workspaceId && p.slug === data.slug);
    if (dup) {
      const err = new Error('Unique constraint failed on workspaceId,slug');
      throw err;
    }
    const row: Project = {
      id: `proj_${++projectIdCounter}`,
      workspaceId: data.workspaceId,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      status: data.status ?? 'active',
      ownerUserId: data.ownerUserId,
      metadata: data.metadata ?? '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: data.archivedAt ?? null,
    };
    projects.push(row);
    return row;
  },
  async update({ where, data }: any) {
    const idx = projects.findIndex((p) => p.id === where.id);
    if (idx === -1) throw new Error('Record to update not found');
    const merged = { ...projects[idx], ...data, updatedAt: new Date() };
    projects[idx] = merged as Project;
    return projects[idx];
  },
};

(prisma as any).iMTask = {
  async updateMany({ where, data }: any) {
    let count = 0;
    for (const t of tasks) {
      if (matchesWhere(t as unknown as Record<string, unknown>, where ?? {})) {
        Object.assign(t, data);
        count++;
      }
    }
    return { count };
  },
};

// $transaction stub — calls fn with the prisma object itself (real Prisma
// returns a TX client; for in-process fake we treat tx === prisma so model
// methods registered above are visible inside the cb).
(prisma as any).$transaction = async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma);

(prisma as any).iMAgentProjectMembership = {
  async findUnique({ where }: any) {
    if (where.id) return memberships.find((m) => m.id === where.id) ?? null;
    if (where.projectId_principalKind_principalId) {
      const { projectId, principalKind, principalId } = where.projectId_principalKind_principalId;
      return (
        memberships.find(
          (m) => m.projectId === projectId && m.principalKind === principalKind && m.principalId === principalId,
        ) ?? null
      );
    }
    return null;
  },
  async findMany({ where, orderBy: _orderBy }: any) {
    const rows = memberships.filter((m) => matchesWhere(m as unknown as Record<string, unknown>, where ?? {}));
    return rows;
  },
  async count({ where }: any) {
    return memberships.filter((m) => matchesWhere(m as unknown as Record<string, unknown>, where ?? {})).length;
  },
  async groupBy({ by, where }: any) {
    const rows = memberships.filter((m) => matchesWhere(m as unknown as Record<string, unknown>, where ?? {}));
    const groups = new Map<string, number>();
    for (const r of rows) {
      const key = (r as any)[by[0]];
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return Array.from(groups.entries()).map(([projectId, n]) => ({
      projectId,
      _count: { _all: n },
    }));
  },
  async create({ data }: any) {
    const dup = memberships.find(
      (m) =>
        m.projectId === data.projectId && m.principalKind === data.principalKind && m.principalId === data.principalId,
    );
    if (dup) throw new Error('Unique constraint failed');
    const row: Membership = {
      id: `mem_${++membershipIdCounter}`,
      projectId: data.projectId,
      principalKind: data.principalKind,
      principalId: data.principalId,
      role: data.role ?? 'contributor',
      joinedAt: new Date(),
    };
    memberships.push(row);
    return row;
  },
  async update({ where, data }: any) {
    const idx = memberships.findIndex((m) => m.id === where.id);
    if (idx === -1) throw new Error('Record to update not found');
    memberships[idx] = { ...memberships[idx], ...data };
    return memberships[idx];
  },
  async delete({ where }: any) {
    const idx = memberships.findIndex((m) => m.id === where.id);
    if (idx === -1) throw new Error('Record to delete not found');
    const [removed] = memberships.splice(idx, 1);
    return removed;
  },
};

// ─── Tiny test harness ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${b}\n    actual:   ${a}`);
  }
}
function truthy(label: string, v: unknown) {
  if (v) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label} (expected truthy)`);
  }
}
async function expectThrows<T extends Error>(
  label: string,
  fn: () => Promise<unknown>,
  ctor: new (...args: any[]) => T,
) {
  try {
    await fn();
    failed++;
    console.error(`  FAIL — ${label} (expected ${ctor.name}, got resolved value)`);
  } catch (err) {
    if (err instanceof ctor) {
      passed++;
      console.log(`  ok — ${label}`);
    } else {
      failed++;
      console.error(`  FAIL — ${label} (expected ${ctor.name}, got ${err})`);
    }
  }
}
async function group(name: string, fn: () => Promise<void>) {
  console.log(`\n• ${name}`);
  await fn();
}

// ─── Tests ──────────────────────────────────────────────────────────────────
async function main() {
  const svc = new ProjectService();
  const OWNER = 'usr_owner';
  const OTHER = 'usr_other';
  const CONTRIB = 'usr_contrib';
  const OBSERVER = 'usr_observer';
  const WS = 'ws_acme';

  // Seed workspace + members (M444 backfill writes owner; collab paths add
  // CONTRIB & OBSERVER explicitly). The new 16 §3.3.3a invariant reads
  // im_workspace_members for user-kind principals, so leaving these unseeded
  // would make existing member-add tests fail. OTHER deliberately stays
  // outside the workspace to keep "non-owner cannot add member" + new
  // "not-workspace-member" cases distinct.
  workspaces.push({ id: WS, ownerImUserId: OWNER, deletedAt: null });
  workspaceMembers.push({ id: 'wsm_owner', workspaceId: WS, memberImUserId: OWNER, role: 'owner' });
  workspaceMembers.push({ id: 'wsm_contrib', workspaceId: WS, memberImUserId: CONTRIB, role: 'member' });
  workspaceMembers.push({ id: 'wsm_observer', workspaceId: WS, memberImUserId: OBSERVER, role: 'member' });

  await group('workspace owner short-circuit', async () => {
    eq('owner detected', await svc.isWorkspaceOwner(WS, OWNER), true);
    eq('non-owner detected', await svc.isWorkspaceOwner(WS, OTHER), false);
    eq('unknown workspace', await svc.isWorkspaceOwner('ws_missing', OWNER), false);
  });

  let projectId = '';
  await group('create — workspace owner only', async () => {
    await expectThrows(
      'non-owner rejected',
      () => svc.create({ workspaceId: WS, actorImUserId: OTHER, slug: 'q2', name: 'Q2 Launch' }),
      ProjectForbiddenError,
    );
    await expectThrows(
      'invalid workspace rejected',
      () => svc.create({ workspaceId: 'nope', actorImUserId: OWNER, slug: 'x', name: 'X' }),
      WorkspaceNotFoundError,
    );
    await expectThrows(
      'invalid slug rejected',
      () => svc.create({ workspaceId: WS, actorImUserId: OWNER, slug: 'INVALID Slug!', name: 'X' }),
      ProjectValidationError,
    );
    await expectThrows(
      'empty name rejected',
      () => svc.create({ workspaceId: WS, actorImUserId: OWNER, slug: 'q3', name: '   ' }),
      ProjectValidationError,
    );

    const created = await svc.create({
      workspaceId: WS,
      actorImUserId: OWNER,
      slug: 'q2-launch',
      name: 'Q2 Launch',
      description: 'Q2 push',
    });
    projectId = created.id;
    eq('created project status', created.status, 'active');
    eq('created project owner', created.ownerUserId, OWNER);
    eq('created project workspace', created.workspaceId, WS);
    eq('created project slug', created.slug, 'q2-launch');

    await expectThrows(
      'duplicate slug → conflict',
      () =>
        svc.create({
          workspaceId: WS,
          actorImUserId: OWNER,
          slug: 'q2-launch',
          name: 'Other',
        }),
      ProjectConflictError,
    );
  });

  await group('effective role — workspace owner short-circuit (§5.2)', async () => {
    eq('workspace owner → owner', await svc.getEffectiveUserRole(projectId, OWNER), 'owner');
    eq('non-member → none', await svc.getEffectiveUserRole(projectId, OTHER), 'none');
    eq('unknown project → none', await svc.getEffectiveUserRole('proj_missing', OWNER), 'none');
  });

  await group('membership add/update/remove', async () => {
    await expectThrows(
      'non-owner cannot add member',
      () => svc.addMember(projectId, OTHER, { principalKind: 'user', principalId: CONTRIB }),
      ProjectForbiddenError,
    );
    await expectThrows(
      'invalid principal kind',
      () => svc.addMember(projectId, OWNER, { principalKind: 'machine' as any, principalId: 'x' }),
      ProjectValidationError,
    );
    await expectThrows(
      'invalid role',
      () =>
        svc.addMember(projectId, OWNER, {
          principalKind: 'user',
          principalId: 'x',
          role: 'super' as any,
        }),
      ProjectValidationError,
    );

    const m1 = await svc.addMember(projectId, OWNER, {
      principalKind: 'user',
      principalId: CONTRIB,
      role: 'contributor',
    });
    eq('contributor membership role', m1.role, 'contributor');
    eq('contributor effective role', await svc.getEffectiveUserRole(projectId, CONTRIB), 'contributor');

    const m2 = await svc.addMember(projectId, OWNER, {
      principalKind: 'user',
      principalId: OBSERVER,
      role: 'observer',
    });
    eq('observer effective role', await svc.getEffectiveUserRole(projectId, OBSERVER), 'observer');

    await expectThrows(
      'duplicate membership → conflict',
      () => svc.addMember(projectId, OWNER, { principalKind: 'user', principalId: CONTRIB }),
      ProjectConflictError,
    );

    const updated = await svc.updateMember(projectId, OWNER, m1.id, { role: 'owner' });
    eq('promoted to owner', updated.role, 'owner');
    eq('explicit owner role visible', await svc.getEffectiveUserRole(projectId, CONTRIB), 'owner');

    await svc.removeMember(projectId, OWNER, m2.id);
    eq('observer removed → none', await svc.getEffectiveUserRole(projectId, OBSERVER), 'none');

    await expectThrows(
      'removing missing membership',
      () => svc.removeMember(projectId, OWNER, 'mem_missing'),
      MembershipNotFoundError,
    );
  });

  await group('release201/16 §3.3.3a — workspace member invariant on addMember', async () => {
    // Negative: user principal not in workspace_members → 422 NOT_WORKSPACE_MEMBER.
    // OTHER was seeded as a non-member specifically for this case.
    await expectThrows(
      'user principal not in workspace → NOT_WORKSPACE_MEMBER',
      () => svc.addMember(projectId, OWNER, { principalKind: 'user', principalId: OTHER }),
      NotWorkspaceMemberError,
    );

    // Positive: agent principal does NOT require a workspace_members row (09 §5.3).
    // Confirms the invariant only bites user-kind principals.
    const AGENT = 'agt_q2_helper';
    const agentMembership = await svc.addMember(projectId, OWNER, {
      principalKind: 'agent',
      principalId: AGENT,
      role: 'contributor',
    });
    eq('agent principal accepted without workspace member row', agentMembership.principalId, AGENT);
    eq('agent role echoed', agentMembership.role, 'contributor');

    // Positive: user principal that IS a workspace member but not yet a project
    // member can still be added (covers the OBSERVER path after the explicit
    // removeMember above).
    const reAdd = await svc.addMember(projectId, OWNER, {
      principalKind: 'user',
      principalId: OBSERVER,
      role: 'observer',
    });
    eq('re-added workspace-member observer', reAdd.principalId, OBSERVER);
  });

  await group('update — only owners', async () => {
    await expectThrows(
      'observer cannot update',
      () => svc.update(projectId, OBSERVER, { name: 'Renamed' }),
      ProjectForbiddenError,
    );
    const updated = await svc.update(projectId, OWNER, { name: 'Q2 GA Push' });
    eq('owner can rename', updated.name, 'Q2 GA Push');

    await expectThrows(
      'invalid status rejected',
      () => svc.update(projectId, OWNER, { status: 'paused' as any }),
      ProjectValidationError,
    );

    const archived = await svc.update(projectId, OWNER, { status: 'archived' });
    eq('archive sets status', archived.status, 'archived');
    truthy('archive sets archivedAt', archived.archivedAt !== null);

    const restored = await svc.update(projectId, OWNER, { status: 'active' });
    eq('restore clears status', restored.status, 'active');
    eq('restore clears archivedAt', restored.archivedAt, null);
  });

  await group('list — owner sees all, non-owner sees only own memberships', async () => {
    // Create another project the contributor (now owner via membership) is in,
    // plus a third project the OTHER user has no membership in.
    await svc.create({ workspaceId: WS, actorImUserId: OWNER, slug: 'q3', name: 'Q3 Plan' });
    const ownerList = await svc.list({ workspaceId: WS, actorImUserId: OWNER });
    eq('owner sees both projects', ownerList.items.length, 2);

    const otherList = await svc.list({ workspaceId: WS, actorImUserId: OTHER });
    eq('non-member sees 0', otherList.items.length, 0);

    // CONTRIB is owner of projectId (1 project), so they should see only that.
    const contribList = await svc.list({ workspaceId: WS, actorImUserId: CONTRIB });
    eq('contributor sees only joined project', contribList.items.length, 1);
    eq('contributor sees Q2', contribList.items[0].id, projectId);

    await expectThrows(
      'list rejects bad workspace',
      () => svc.list({ workspaceId: 'ws_missing', actorImUserId: OWNER }),
      WorkspaceNotFoundError,
    );
  });

  await group('get — hides existence from non-members', async () => {
    const projectForOwner = await svc.get(projectId, OWNER);
    eq('owner sees project', projectForOwner.id, projectId);
    truthy('member count present', projectForOwner.memberCount >= 1);

    await expectThrows('non-member gets 404 (existence hidden)', () => svc.get(projectId, OTHER), ProjectNotFoundError);
  });

  await group('delete — cascade=archive (default)', async () => {
    // Seed a task linked to projectId; archive must NOT touch projectId.
    tasks.push({ id: `task_${++taskIdCounter}`, workspaceId: WS, projectId });
    tasks.push({ id: `task_${++taskIdCounter}`, workspaceId: WS, projectId });

    const result = await svc.remove(projectId, OWNER);
    eq('cascade kind', result.cascade, 'archive');
    eq('removed → status archived', result.project.status, 'archived');
    truthy('removed → archivedAt set', result.project.archivedAt !== null);
    eq('archive: no tasks unscoped', result.cascadeReport.taskUnscoped, 0);
    eq('archive: tasks keep projectId', tasks.filter((t) => t.projectId === projectId).length, 2);
  });

  await group('delete — cascade=null unscopes linked tasks (09 §4.4)', async () => {
    // Create + seed a fresh project so we can verify cascade=null behavior on
    // a still-active project. (The previous group archived projectId.)
    const created = await svc.create({
      workspaceId: WS,
      actorImUserId: OWNER,
      slug: 'cascade-null-test',
      name: 'Cascade Null Test',
    });
    tasks.push({ id: `task_${++taskIdCounter}`, workspaceId: WS, projectId: created.id });
    tasks.push({ id: `task_${++taskIdCounter}`, workspaceId: WS, projectId: created.id });
    tasks.push({ id: `task_${++taskIdCounter}`, workspaceId: WS, projectId: created.id });

    const result = await svc.remove(created.id, OWNER, 'null');
    eq('cascade kind', result.cascade, 'null');
    eq('cascade=null project archived', result.project.status, 'archived');
    truthy('cascade=null archivedAt set', result.project.archivedAt !== null);
    eq('cascade=null: 3 tasks unscoped', result.cascadeReport.taskUnscoped, 3);
    eq('cascade=null: tasks now have projectId=null', tasks.filter((t) => t.projectId === created.id).length, 0);
    // Other resource categories are reserved for v2.0.8+; report counts stay 0.
    eq('cascade=null: conversation count 0 (v2.0.8+)', result.cascadeReport.conversationUnscoped, 0);
    eq('cascade=null: asset count 0 (v2.0.8+)', result.cascadeReport.assetUnscoped, 0);
    eq('cascade=null: memory count 0 (v2.1+)', result.cascadeReport.memoryUnscoped, 0);
  });

  await group('delete — cascade=hard rejected (§15.1 Phase 4 forbidden, v2.1+)', async () => {
    const created = await svc.create({
      workspaceId: WS,
      actorImUserId: OWNER,
      slug: 'hard-rejected',
      name: 'Hard Rejected',
    });
    await expectThrows(
      'cascade=hard → HardCascadeNotImplementedError',
      () => svc.remove(created.id, OWNER, 'hard'),
      HardCascadeNotImplementedError,
    );
    // Project must remain active (the throw aborts before any DB write).
    const stillActive = await svc.get(created.id, OWNER);
    eq('cascade=hard rejected: project still active', stillActive.status, 'active');
  });

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

resetDb();
workspaces.push({ id: 'placeholder', ownerImUserId: 'placeholder', deletedAt: null });
workspaces.length = 0;
main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
