/**
 * Bug Z1 regression — auth middleware ensureDefaultWorkspace writes owner
 * row into im_workspace_members atomically.
 *
 * Pre-Z1 behavior (BUG):
 *   src/im/auth/middleware.ts:67 only called prisma.iMWorkspace.create({...}),
 *   skipping im_workspace_members. owner GET /workspaces/<id>/members returned
 *   [] / 404 (anti-enumeration), POST /tasks failed with
 *   403 NOT_WORKSPACE_MEMBER (task-permission.ts L3 ACL).
 *
 * Post-Z1 fix:
 *   ensureDefaultWorkspace wraps both inserts in a single $transaction —
 *   mirrors the B2 hotfix pattern from src/im/api/workspaces.ts:190.
 *
 * Run:
 *   rm -f /tmp/prismer-acp-mw-z1.db
 *   DATABASE_URL="file:/tmp/prismer-acp-mw-z1.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-acp-mw-z1.db" \
 *     npx tsx src/im/tests/acp-auth-middleware-personal-ws-owner.test.ts
 */

import assert from 'node:assert/strict';
import prisma from '../db';
import { ensureDefaultWorkspace } from '../auth/middleware';
import { generateUserId } from '../utils/id-gen';

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ok — ${label}`);
}
function bad(label: string, err: unknown) {
  failed++;
  console.error(`  FAIL — ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

async function withCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}

async function seedHumanUser(suffix: string): Promise<string> {
  const id = generateUserId();
  await prisma.iMUser.create({
    data: {
      id,
      username: `z1_user_${suffix}`,
      displayName: `Z1 User ${suffix}`,
      role: 'human',
      userId: `cloud_${suffix}`,
    },
  });
  return id;
}

async function main() {
  console.log('• Bug Z1 — ensureDefaultWorkspace writes owner member row');

  await withCase('auto-created Personal ws has owner row (role=owner)', async () => {
    const suffix = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const imUserId = await seedHumanUser(suffix);

    await ensureDefaultWorkspace(imUserId);

    const ws = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
    });
    assert.ok(ws, 'workspace must be created');
    assert.equal(ws!.name, 'Personal');
    assert.equal(ws!.ownerImUserId, imUserId);

    const member = await prisma.iMWorkspaceMember.findFirst({
      where: { workspaceId: ws!.id, memberImUserId: imUserId },
    });
    assert.ok(member, 'owner member row must exist (was the Z1 bug)');
    assert.equal(member!.role, 'owner', "member role must be 'owner'");
    assert.equal(member!.memberImUserId, imUserId, 'memberImUserId points to owner');
  });

  await withCase('owner row uses memberImUserId (not memberUserId or userId)', async () => {
    const suffix = `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const imUserId = await seedHumanUser(suffix);

    await ensureDefaultWorkspace(imUserId);

    const ws = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
    });
    // Schema field-name guard: workspace-member.service queries by memberImUserId.
    // If a future refactor renames the column, this query returns null and
    // the assert fires — surfacing the rename to the dev.
    const member = await prisma.iMWorkspaceMember.findFirst({
      where: { workspaceId: ws!.id, memberImUserId: imUserId, role: 'owner' },
    });
    assert.ok(member, 'member found by memberImUserId field name');
  });

  await withCase('idempotent: second call does not throw or duplicate', async () => {
    const suffix = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const imUserId = await seedHumanUser(suffix);

    await ensureDefaultWorkspace(imUserId);
    await ensureDefaultWorkspace(imUserId); // must not throw, must not duplicate

    const wsCount = await prisma.iMWorkspace.count({
      where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
    });
    assert.equal(wsCount, 1, 'exactly one default workspace');

    const ws = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
    });
    const memberCount = await prisma.iMWorkspaceMember.count({
      where: { workspaceId: ws!.id, memberImUserId: imUserId },
    });
    assert.equal(memberCount, 1, 'exactly one owner member row');
  });

  await withCase('atomicity: ws + member created together (no half-state)', async () => {
    const suffix = `d_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const imUserId = await seedHumanUser(suffix);

    await ensureDefaultWorkspace(imUserId);

    const wsList = await prisma.iMWorkspace.findMany({
      where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    // Cross-check: every ws produced by this path has a matching owner row.
    for (const ws of wsList) {
      const ownerRow = await prisma.iMWorkspaceMember.findFirst({
        where: { workspaceId: ws.id, memberImUserId: imUserId, role: 'owner' },
      });
      assert.ok(ownerRow, `ws ${ws.id} missing owner row — Z1 still present`);
    }
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
