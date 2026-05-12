/**
 * Focused workspace memory ownership tests.
 *
 * Run:
 *   DATABASE_URL="file:/tmp/prismer-memory-isolation.db" npx prisma db push --schema prisma/schema.prisma
 *   DATABASE_URL="file:/tmp/prismer-memory-isolation.db" npx tsx src/im/tests/memory-workspace-isolation.test.ts
 */

import assert from 'node:assert/strict';
import prisma from '../db';
import { MemoryNotFoundError, MemoryService } from '../services/memory.service';

const suffix = Date.now();
const ownerId = `im_mem_owner_${suffix}`;
const workspaceA = `ws_mem_a_${suffix}`;
const workspaceB = `ws_mem_b_${suffix}`;
const path = `memory/isolation-${suffix}.md`;

async function cleanup() {
  await prisma.iMMemoryPage.deleteMany({
    where: { workspaceId: { in: [workspaceA, workspaceB] } },
  });
  await prisma.iMMemoryFile.deleteMany({
    where: {
      OR: [{ workspaceId: { in: [workspaceA, workspaceB] } }, { ownerId }],
    },
  });
}

async function main() {
  const memoryService = new MemoryService();
  await cleanup();

  const fileA = await memoryService.writeMemoryFile(
    workspaceA,
    ownerId,
    'agent',
    path,
    '# Workspace A\n\nOnly A can read this legacy memory file.\n',
  );

  const visibleA = await memoryService.readMemoryFile(fileA.id, workspaceA);
  assert.equal(visibleA.workspaceId, workspaceA);
  assert.match(visibleA.content, /Only A/);
  assert.equal(visibleA.visibility, 'workspace');
  assert.equal(visibleA.encrypted, false);
  assert.equal(visibleA.contentHash?.length, 64);
  assert.equal(visibleA.etag, visibleA.contentHash);

  await assert.rejects(
    () => memoryService.readMemoryFile(fileA.id, workspaceB),
    (err) => err instanceof MemoryNotFoundError,
    'reading a memory file through the wrong workspace must behave as not found',
  );

  const fileB = await memoryService.writeMemoryFile(
    workspaceB,
    ownerId,
    'agent',
    path,
    '# Workspace B\n\nSame owner and path, different workspace.\n',
  );

  assert.notEqual(fileB.id, fileA.id, 'same owner/path in another workspace must create a separate file');
  assert.equal(fileB.workspaceId, workspaceB);
  assert.match(fileB.content, /Workspace B/);

  const stillA = await memoryService.readMemoryFile(fileA.id, workspaceA);
  assert.match(stillA.content, /Only A/, 'workspace B write must not overwrite workspace A content');

  const byPathA = await memoryService.readMemoryFileByPath(workspaceA, ownerId, 'global', path);
  const byPathB = await memoryService.readMemoryFileByPath(workspaceB, ownerId, 'global', path);
  assert.equal(byPathA?.id, fileA.id);
  assert.equal(byPathB?.id, fileB.id);

  await prisma.iMMemoryPage.createMany({
    data: [
      {
        workspaceId: workspaceA,
        path,
        content: '# Page A\n',
        createdByImUserId: ownerId,
        provenanceJson: '[]',
        contentHash: 'a'.repeat(64),
      },
      {
        workspaceId: workspaceB,
        path,
        content: '# Page B\n',
        createdByImUserId: ownerId,
        provenanceJson: '[]',
        contentHash: 'b'.repeat(64),
      },
    ],
  });

  const pages = await prisma.iMMemoryPage.findMany({
    where: { path, createdByImUserId: ownerId },
    orderBy: { workspaceId: 'asc' },
  });
  assert.equal(pages.length, 2, 'same author/path must be distinct across workspaces in Phase B pages');

  await cleanup();
  console.log('memory workspace isolation tests passed');
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
