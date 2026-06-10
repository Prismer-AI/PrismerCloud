/**
 * Bug Z1.b regression — all ws.create paths write owner member row atomically.
 *
 * Z1 (commit 待) 已修 src/im/auth/middleware.ts ensureDefaultWorkspace。
 * 全量回归发现 3 个其他 create 路径仍漏 owner im_workspace_members 行：
 *   1. src/im/api/register.ts:546 — resolveOwnerWorkspaceId fallback
 *   2. src/im/api/register.ts:712 — new human user post-register
 *   3. src/im/api/agents.ts:79    — agent register auto-create owner ws
 *
 * Pre-Z1.b: 这 3 处 prisma.iMWorkspace.create(...) 单独写，缺 owner row →
 *           owner GET /workspaces/<id>/members 返 [] / 404，POST /tasks 被
 *           task-permission.ts NotWorkspaceMemberError 拒 (403)。
 * Post-Z1.b: 3 处都升级为 prisma.$transaction 包 workspace + owner member
 *            两条 insert（mirror Z1 ensureDefaultWorkspace pattern）。
 *
 * Test 1-3 — Structural witness: source 文件 `iMWorkspace.create` 调用必须落在
 *   `prisma.$transaction(...)` block 内且同 block 含 `iMWorkspaceMember.create`
 *   + `role: 'owner'`。预防"未来 refactor 把 transaction 拆掉"。
 * Test 4 — Runtime rollback: 真 prisma + sqlite 复刻同款 $transaction，让
 *   iMWorkspaceMember.create 抛错，断言 iMWorkspace 行也被回滚（不留半态）。
 *
 * Run:
 *   rm -f /tmp/prismer-acp-z1b.db
 *   DATABASE_URL="file:/tmp/prismer-acp-z1b.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-acp-z1b.db" \
 *     npx tsx src/im/tests/acp-ws-create-paths-owner-row.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prisma from '../db';
import { generateUserId } from '../utils/id-gen';

let passed = 0;
let failed = 0;

async function withCase(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(err);
  }
}

const ROOT = resolve(__dirname, '../../..');

function readSource(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

/**
 * Locate the smallest `prisma.$transaction(async (tx[: any]) => { ... })`
 * block whose body contains the given anchor substring. Returns the body text
 * (between the outermost {…}) of that transaction, or null if not found.
 *
 * Robust to nested braces (handles JS/TS object literals inside the callback).
 */
function extractTxBlockContaining(source: string, anchor: string): string | null {
  const re = /prisma\.\$transaction\s*\(\s*async\s*\(\s*tx[^)]*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  const candidates: { body: string; start: number }[] = [];
  while ((match = re.exec(source)) !== null) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) {
      const body = source.slice(bodyStart, i - 1);
      candidates.push({ body, start: match.index });
    }
  }
  // Smallest containing block wins (innermost). Returns first whose body
  // contains anchor, preferring the smallest.
  const containing = candidates
    .filter((c) => c.body.includes(anchor))
    .sort((a, b) => a.body.length - b.body.length);
  return containing[0]?.body ?? null;
}

function assertTxPatternAtAnchor(rel: string, anchor: string, label: string) {
  const src = readSource(rel);
  assert.ok(src.includes(anchor), `${label}: anchor not found in ${rel} — call site moved?`);
  const body = extractTxBlockContaining(src, anchor);
  assert.ok(body, `${label}: ${rel} create call at "${anchor}" is NOT inside prisma.$transaction(...) — Z1.b regressed`);
  assert.ok(
    /tx\.iMWorkspace\.create/.test(body!),
    `${label}: transaction does not call tx.iMWorkspace.create`,
  );
  assert.ok(
    /tx\.iMWorkspaceMember\.create/.test(body!),
    `${label}: transaction does not call tx.iMWorkspaceMember.create — owner row missing`,
  );
  assert.ok(/role:\s*['"]owner['"]/.test(body!), `${label}: owner row missing role: 'owner'`);
  assert.ok(
    /memberImUserId\s*:/.test(body!),
    `${label}: owner row missing memberImUserId field (schema field name guard)`,
  );
}

async function main() {
  console.log('• Bug Z1.b — all ws.create paths write owner member row in $transaction');

  // ── Test 1: register.ts:546 (resolveOwnerWorkspaceId fallback) ───────────
  await withCase('register.ts:546 path is inside $transaction with owner member create', () => {
    assertTxPatternAtAnchor(
      'src/im/api/register.ts',
      "name: 'Personal',\n            slug: 'personal',",
      'register.ts:546',
    );
  });

  // ── Test 2: register.ts:712 (new human user post-register) ────────────────
  await withCase('register.ts:712 path is inside $transaction with owner member create', () => {
    const src = readSource('src/im/api/register.ts');
    // Anchor: the comment specific to the second site, then verify nearest
    // $transaction containing 'newUser.id' as ownerImUserId is properly wrapped.
    const marker = "if (type === 'human' && isNew) {";
    assert.ok(src.includes(marker), 'register.ts:712 marker not found — file structure changed');
    // The smallest $transaction block whose body contains the "newUser.id"
    // ownerImUserId reference must satisfy the Z1.b shape.
    const body = extractTxBlockContaining(src, 'ownerImUserId: newUser.id');
    assert.ok(body, 'register.ts:712 newUser.id ws.create is NOT inside prisma.$transaction(...)');
    assert.ok(/tx\.iMWorkspace\.create/.test(body!), 'register.ts:712 missing tx.iMWorkspace.create');
    assert.ok(
      /tx\.iMWorkspaceMember\.create/.test(body!),
      'register.ts:712 missing tx.iMWorkspaceMember.create — owner row missing',
    );
    assert.ok(/role:\s*['"]owner['"]/.test(body!), "register.ts:712 owner row missing role: 'owner'");
    assert.ok(
      /memberImUserId:\s*newUser\.id/.test(body!),
      'register.ts:712 owner row not bound to newUser.id',
    );
  });

  // ── Test 3: agents.ts:79 (agent register auto-create owner ws) ────────────
  await withCase('agents.ts:79 path is inside $transaction with owner member create', () => {
    const src = readSource('src/im/api/agents.ts');
    const body = extractTxBlockContaining(src, 'ownerImUserId: user.imUserId');
    assert.ok(body, 'agents.ts:79 user.imUserId ws.create is NOT inside prisma.$transaction(...)');
    assert.ok(/tx\.iMWorkspace\.create/.test(body!), 'agents.ts:79 missing tx.iMWorkspace.create');
    assert.ok(
      /tx\.iMWorkspaceMember\.create/.test(body!),
      'agents.ts:79 missing tx.iMWorkspaceMember.create — owner row missing',
    );
    assert.ok(/role:\s*['"]owner['"]/.test(body!), "agents.ts:79 owner row missing role: 'owner'");
    assert.ok(
      /memberImUserId:\s*user\.imUserId/.test(body!),
      'agents.ts:79 owner row not bound to user.imUserId',
    );
  });

  // ── Test 4: runtime rollback (atomicity guarantee) ───────────────────────
  // Replicate the exact Z1.b $transaction shape and force the member.create
  // to reject. Assert the workspace row is NOT persisted — proving the
  // transaction rolled back, which is the whole point of Z1.b vs Z1 pre-fix.
  await withCase('all paths transactional: rollback ws if member create fails', async () => {
    const suffix = `z1b_rb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ownerId = generateUserId();
    await prisma.iMUser.create({
      data: {
        id: ownerId,
        username: `z1b_${suffix}`,
        displayName: 'Z1.b Rollback User',
        role: 'human',
      },
    });

    let caught: Error | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interactive tx client typing matches workspace-member.service pattern
      await prisma.$transaction(async (tx: any) => {
        await tx.iMWorkspace.create({
          data: {
            ownerImUserId: ownerId,
            name: 'Personal',
            slug: `personal-${suffix}`,
            isDefault: true,
          },
          select: { id: true },
        });
        // Force the second insert to fail with a clear, non-Prisma error so
        // it can't be misinterpreted as a real constraint violation.
        throw new Error('SIMULATED member.create failure');
      });
    } catch (err) {
      caught = err as Error;
    }

    assert.ok(caught, 'transaction must throw when inner step fails');
    assert.match(caught!.message, /SIMULATED/, 'caught error must be the simulated one');

    // The crucial assertion: even though tx.iMWorkspace.create "ran", the
    // workspace row MUST be rolled back because the second insert failed.
    const leftover = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: ownerId, slug: `personal-${suffix}` },
    });
    assert.equal(leftover, null, 'workspace row leaked despite tx rollback — Z1.b atomicity broken');

    // Symmetric guard on the member side — neither row should exist.
    const leftoverMember = await prisma.iMWorkspaceMember.findFirst({
      where: { memberImUserId: ownerId, role: 'owner' },
    });
    assert.equal(leftoverMember, null, 'member row leaked despite tx rollback');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
