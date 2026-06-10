/**
 * Unit test for workspace-member.service.ts — release201/16 Phase 8 DoD (16 §0.2.1).
 *
 * Run:
 *   npx tsx src/im/services/__tests__/workspace-member.service.test.ts
 *
 * Pure in-process. Stubs prisma models, mirrors the pattern from
 * project.service.test.ts. Covers:
 *   • list — owner can read; non-member 404; member can read
 *   • add  — owner only; rejects role=owner; rejects unknown user; rejects duplicate
 *   • patch — owner only; rejects promote to owner; rejects demote owner
 *   • remove — owner only; cannot remove owner; cascade deletes project memberships
 *   • isMember / getRole — convenience accessors
 *
 * Forbidden patterns (16 §0.2.4):
 *   - role=owner via POST or PATCH is rejected (must use ownership transfer, v2.1+)
 *   - owner can't be removed without transfer
 */

import {
  WorkspaceMemberService,
  WorkspaceNotFoundError,
  WorkspaceForbiddenError,
  WorkspaceValidationError,
  WorkspaceConflictError,
  MemberNotFoundError,
  OwnerCannotBeRemovedError,
} from '../workspace-member.service';

import { prisma } from '@/lib/prisma';

// ─── In-memory fake tables ──────────────────────────────────────────────────
type Workspace = { id: string; ownerImUserId: string; deletedAt: Date | null };
type Member = {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: string;
  joinedAt: Date;
};
type Project = { id: string; workspaceId: string };
type Membership = {
  id: string;
  projectId: string;
  principalKind: string;
  principalId: string;
  role: string;
  joinedAt: Date;
};
type ImUser = { id: string };

const workspaces: Workspace[] = [];
const members: Member[] = [];
const projects: Project[] = [];
const projectMemberships: Membership[] = [];
const imUsers: ImUser[] = [];
let memberIdCounter = 0;

function resetDb() {
  workspaces.length = 0;
  members.length = 0;
  projects.length = 0;
  projectMemberships.length = 0;
  imUsers.length = 0;
  memberIdCounter = 0;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    const cell = row[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const cond = v as Record<string, unknown>;
      if ('in' in cond) {
        if (!(cond.in as unknown[]).includes(cell)) return false;
        continue;
      }
    }
    if (cell !== v) return false;
  }
  return true;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
(prisma as any).iMWorkspace = {
  async findFirst({ where }: { where: { id: string; deletedAt?: null } }) {
    return (
      workspaces.find((w) => w.id === where.id && (where.deletedAt === undefined || w.deletedAt === where.deletedAt)) ??
      null
    );
  },
};

(prisma as any).iMWorkspaceMember = {
  async findUnique({ where }: any) {
    if (where.id) return members.find((m) => m.id === where.id) ?? null;
    if (where.workspaceId_memberImUserId) {
      const { workspaceId, memberImUserId } = where.workspaceId_memberImUserId;
      return members.find((m) => m.workspaceId === workspaceId && m.memberImUserId === memberImUserId) ?? null;
    }
    return null;
  },
  async findMany({ where, orderBy: _orderBy }: any) {
    return members.filter((m) => matchesWhere(m as unknown as Record<string, unknown>, where ?? {}));
  },
  async create({ data }: any) {
    const dup = members.find((m) => m.workspaceId === data.workspaceId && m.memberImUserId === data.memberImUserId);
    if (dup) throw new Error('Unique constraint failed');
    const row: Member = {
      id: `wsm_${++memberIdCounter}`,
      workspaceId: data.workspaceId,
      memberImUserId: data.memberImUserId,
      role: data.role,
      joinedAt: new Date(),
    };
    members.push(row);
    return row;
  },
  async update({ where, data }: any) {
    const idx = members.findIndex((m) => m.id === where.id);
    if (idx === -1) throw new Error('Record to update not found');
    members[idx] = { ...members[idx], ...data };
    return members[idx];
  },
  async delete({ where }: any) {
    const idx = members.findIndex((m) => m.id === where.id);
    if (idx === -1) throw new Error('Record to delete not found');
    const [removed] = members.splice(idx, 1);
    return removed;
  },
};

(prisma as any).iMProject = {
  async findMany({ where, select: _select }: any) {
    return projects.filter((p) => matchesWhere(p as unknown as Record<string, unknown>, where ?? {}));
  },
};

(prisma as any).iMAgentProjectMembership = {
  async deleteMany({ where }: any) {
    const before = projectMemberships.length;
    for (let i = projectMemberships.length - 1; i >= 0; i--) {
      const m = projectMemberships[i];
      const projectIdMatch =
        where.projectId && typeof where.projectId === 'object' && 'in' in where.projectId
          ? (where.projectId.in as string[]).includes(m.projectId)
          : m.projectId === where.projectId;
      const kindMatch = !where.principalKind || m.principalKind === where.principalKind;
      const idMatch = !where.principalId || m.principalId === where.principalId;
      if (projectIdMatch && kindMatch && idMatch) {
        projectMemberships.splice(i, 1);
      }
    }
    return { count: before - projectMemberships.length };
  },
};

(prisma as any).iMUser = {
  async findUnique({ where }: any) {
    return imUsers.find((u) => u.id === where.id) ?? null;
  },
};

// $transaction stub — supports both forms:
//   array  : prisma.$transaction([op1, op2])           → Promise.all
//   fn(tx) : prisma.$transaction(async (tx) => {...})  → tx === prisma
(prisma as any).$transaction = async (arg: Promise<unknown>[] | ((tx: typeof prisma) => Promise<unknown>)) => {
  if (typeof arg === 'function') return arg(prisma);
  return Promise.all(arg);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
async function groupBlock(name: string, fn: () => Promise<void>) {
  console.log(`\n• ${name}`);
  await fn();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const svc = new WorkspaceMemberService();

  // Seed helpers
  const seed = (ownerId: string, otherIds: string[] = []) => {
    resetDb();
    workspaces.push({ id: 'ws_1', ownerImUserId: ownerId, deletedAt: null });
    // M444 backfill effect — owner row exists.
    members.push({
      id: 'wsm_seed_owner',
      workspaceId: 'ws_1',
      memberImUserId: ownerId,
      role: 'owner',
      joinedAt: new Date(),
    });
    imUsers.push({ id: ownerId });
    for (const id of otherIds) imUsers.push({ id });
  };

  await groupBlock('isMember / getRole — M444 backfill + non-member', async () => {
    seed('owner_1', ['stranger_1']);
    eq('owner is member', await svc.isMember('ws_1', 'owner_1'), true);
    eq('owner role is owner', await svc.getRole('ws_1', 'owner_1'), 'owner');
    eq('stranger is not member', await svc.isMember('ws_1', 'stranger_1'), false);
    eq('stranger role is null', await svc.getRole('ws_1', 'stranger_1'), null);
  });

  await groupBlock('list — owner reads; non-member 404; member reads', async () => {
    seed('owner_1', ['member_1', 'stranger_1']);
    members.push({
      id: 'wsm_alice',
      workspaceId: 'ws_1',
      memberImUserId: 'member_1',
      role: 'member',
      joinedAt: new Date(),
    });

    const ownerList = await svc.list('ws_1', 'owner_1');
    eq('owner sees 2 rows', ownerList.length, 2);

    const memberList = await svc.list('ws_1', 'member_1');
    eq('non-owner member sees 2 rows', memberList.length, 2);

    await expectThrows(
      'stranger gets WorkspaceNotFoundError (anti-enumeration)',
      () => svc.list('ws_1', 'stranger_1'),
      WorkspaceNotFoundError,
    );

    await expectThrows('missing workspace 404', () => svc.list('ws_404', 'owner_1'), WorkspaceNotFoundError);
  });

  await groupBlock('add — owner only; rejects owner role / unknown user / duplicate', async () => {
    seed('owner_1', ['new_user']);

    await expectThrows(
      'non-owner forbidden',
      () => svc.add('ws_1', 'new_user', { memberImUserId: 'new_user', role: 'member' }),
      WorkspaceForbiddenError,
    );

    const added = await svc.add('ws_1', 'owner_1', { memberImUserId: 'new_user', role: 'member' });
    truthy('member created with id', added.id);
    eq('role is member', added.role, 'member');

    await expectThrows(
      'rejects role=owner via POST (use ownership transfer)',
      () => svc.add('ws_1', 'owner_1', { memberImUserId: 'new_user_2', role: 'owner' as never }),
      WorkspaceValidationError,
    );

    imUsers.length = 1; // wipe new_user from im_users to simulate non-existent FK
    await expectThrows(
      'rejects unknown user',
      () => svc.add('ws_1', 'owner_1', { memberImUserId: 'phantom', role: 'member' }),
      WorkspaceValidationError,
    );

    imUsers.push({ id: 'new_user' }); // restore
    await expectThrows(
      'rejects duplicate',
      () => svc.add('ws_1', 'owner_1', { memberImUserId: 'new_user', role: 'admin' }),
      WorkspaceConflictError,
    );
  });

  await groupBlock('patch — owner only; rejects promote to owner; rejects demote owner', async () => {
    seed('owner_1', ['alice']);
    const added = await svc.add('ws_1', 'owner_1', { memberImUserId: 'alice', role: 'member' });

    const promoted = await svc.updateRole('ws_1', 'owner_1', added.id, 'admin');
    eq('promoted to admin', promoted.role, 'admin');

    await expectThrows(
      'non-owner cannot patch',
      () => svc.updateRole('ws_1', 'alice', added.id, 'member'),
      WorkspaceForbiddenError,
    );

    await expectThrows(
      'cannot promote to owner',
      () => svc.updateRole('ws_1', 'owner_1', added.id, 'owner'),
      WorkspaceValidationError,
    );

    // owner row from M444 — cannot be demoted
    const ownerRow = members.find((m) => m.memberImUserId === 'owner_1' && m.role === 'owner')!;
    await expectThrows(
      'cannot demote workspace owner',
      () => svc.updateRole('ws_1', 'owner_1', ownerRow.id, 'admin'),
      WorkspaceValidationError,
    );

    await expectThrows(
      'unknown member 404',
      () => svc.updateRole('ws_1', 'owner_1', 'wsm_phantom', 'member'),
      MemberNotFoundError,
    );
  });

  await groupBlock('remove — owner only; cannot remove owner; cascades project memberships', async () => {
    seed('owner_1', ['alice']);
    const added = await svc.add('ws_1', 'owner_1', { memberImUserId: 'alice', role: 'member' });

    // Seed 2 projects under ws_1, both with alice as user membership
    projects.push({ id: 'proj_a', workspaceId: 'ws_1' });
    projects.push({ id: 'proj_b', workspaceId: 'ws_1' });
    // Another workspace's project — alice's membership there should NOT be touched
    projects.push({ id: 'proj_other_ws', workspaceId: 'ws_OTHER' });

    projectMemberships.push({
      id: 'pm_1',
      projectId: 'proj_a',
      principalKind: 'user',
      principalId: 'alice',
      role: 'contributor',
      joinedAt: new Date(),
    });
    projectMemberships.push({
      id: 'pm_2',
      projectId: 'proj_b',
      principalKind: 'user',
      principalId: 'alice',
      role: 'observer',
      joinedAt: new Date(),
    });
    projectMemberships.push({
      id: 'pm_3',
      projectId: 'proj_other_ws',
      principalKind: 'user',
      principalId: 'alice',
      role: 'contributor',
      joinedAt: new Date(),
    });
    // Agent membership for alice imuserid should also not be touched (principalKind='agent')
    projectMemberships.push({
      id: 'pm_4',
      projectId: 'proj_a',
      principalKind: 'agent',
      principalId: 'alice', // intentional collision id — agent kind protects
      role: 'contributor',
      joinedAt: new Date(),
    });

    await expectThrows('non-owner cannot remove', () => svc.remove('ws_1', 'alice', added.id), WorkspaceForbiddenError);

    const ownerRow = members.find((m) => m.memberImUserId === 'owner_1' && m.role === 'owner')!;
    await expectThrows(
      'owner cannot remove themselves (ownership transfer required)',
      () => svc.remove('ws_1', 'owner_1', ownerRow.id),
      OwnerCannotBeRemovedError,
    );

    const result = await svc.remove('ws_1', 'owner_1', added.id);
    eq('removed alice row', result.removed.memberImUserId, 'alice');
    eq('cascaded 2 project memberships (proj_a + proj_b user kind)', result.projectMembershipsRemoved, 2);
    truthy('alice not in members table anymore', !members.find((m) => m.memberImUserId === 'alice'));
    truthy(
      'alice user memberships in same workspace gone',
      projectMemberships.filter(
        (m) => m.principalKind === 'user' && m.principalId === 'alice' && m.projectId !== 'proj_other_ws',
      ).length === 0,
    );
    truthy(
      'alice membership in OTHER workspace project preserved',
      projectMemberships.some((m) => m.projectId === 'proj_other_ws' && m.principalId === 'alice'),
    );
    truthy(
      'agent-kind row with same principalId preserved',
      projectMemberships.some((m) => m.principalKind === 'agent' && m.principalId === 'alice'),
    );
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
