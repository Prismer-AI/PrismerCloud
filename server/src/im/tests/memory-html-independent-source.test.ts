/**
 * M-D — IMMemoryPage.contentHtml independent-source tests (doc 25 §4).
 *
 * Asserts the contract that `contentHtml` is a parallel writable column,
 * NOT a markdown derivation:
 *
 *   - markdown writes do NOT clobber an existing contentHtml
 *   - HTML writes do NOT clobber the markdown content / version
 *   - backfill cron skips contentHtmlVersion = 0 (user-authored)
 *   - read API format=markdown|html|both filters payload correctly
 *   - markdown-render pipeline strips script tags and javascript: URLs
 *
 * Run:
 *   rm -f /tmp/prismer-memory-html.db
 *   DATABASE_URL="file:/tmp/prismer-memory-html.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-memory-html.db" \
 *     npx tsx src/im/tests/memory-html-independent-source.test.ts
 */

import assert from 'node:assert/strict';
import prisma from '../db';
import { _clearMemoryAclCache, loadWorkspaceForMemoryAccess } from '../services/memory-acl';
import { MemoryReadService } from '../services/memory-read.service';
import { MemoryWriteError, MemoryWriteService } from '../services/memory-write.service';
import { MemoryPageService } from '../services/memory-page.service';
import { MARKDOWN_RENDER_VERSION, renderMemoryMarkdownToHtml } from '../../lib/markdown-render';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `md_owner_${suffix}`;
const wsA = `md_ws_a_${suffix}`;

const writer = new MemoryWriteService();
const reader = new MemoryReadService();
const pageService = new MemoryPageService();

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  _clearMemoryAclCache();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function cleanup() {
  await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryPageVersion.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMKnowledgeLink.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMWorkspace.deleteMany({ where: { id: wsA } });
  await prisma.iMUser.deleteMany({ where: { id: ownerId } });
}

async function setup() {
  await prisma.iMUser.create({
    data: { id: ownerId, username: `o_${suffix}`, displayName: 'Owner', role: 'human' },
  });
  await prisma.iMWorkspace.create({
    data: { id: wsA, ownerImUserId: ownerId, name: 'A', slug: `a_${suffix}`, isDefault: true },
  });
}

async function ownerAcl() {
  const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
  assert.ok(acl);
  return acl!;
}

async function main() {
  console.log('[memory-html] setup fixtures');
  await cleanup();
  await setup();

  // ─── markdown-render pipeline ───────────────────────────────
  await runTest('markdown-render: strips raw script tags from input', async () => {
    const dirty = '# Title\n\nText <script>alert(1)</script> and `code`.';
    const html = renderMemoryMarkdownToHtml(dirty);
    assert.ok(!/<script/i.test(html), `expected no <script>, got: ${html}`);
    assert.ok(html.includes('<h1>Title</h1>') || html.includes('<h1>'), `expected h1 in output`);
  });

  await runTest('markdown-render: blocks javascript: URLs in links', async () => {
    const dirty = '[click](javascript:alert(1))';
    const html = renderMemoryMarkdownToHtml(dirty);
    assert.ok(!/javascript:/i.test(html), `expected javascript: stripped, got: ${html}`);
  });

  await runTest('markdown-render: preserves GFM tables and code blocks', async () => {
    const md = '# H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log(1);\n```';
    const html = renderMemoryMarkdownToHtml(md);
    assert.ok(html.includes('<table>'), 'expected GFM table');
    assert.ok(html.includes('<code'), 'expected code element');
  });

  await runTest('markdown-render: empty input returns empty string', async () => {
    assert.equal(renderMemoryMarkdownToHtml(''), '');
  });

  await runTest('MARKDOWN_RENDER_VERSION is a positive integer', async () => {
    assert.ok(Number.isInteger(MARKDOWN_RENDER_VERSION) && MARKDOWN_RENDER_VERSION >= 1);
  });

  // ─── createPage (write-side independence) ───────────────────
  await runTest('createPage without contentHtml leaves both columns null', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/md-only.md',
      content: '# md only',
      sourceRefs: ['cv:1'],
    });
    const row = await prisma.iMMemoryPage.findUnique({ where: { id: page.id } });
    assert.ok(row);
    assert.equal(row!.content, '# md only');
    assert.equal(row!.contentHtml, null);
    assert.equal(row!.contentHtmlVersion, null);
  });

  await runTest('createPage with contentHtml stores both as v0 (independent)', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/dual.md',
      content: '# dual',
      contentHtml: '<h1>dual edited</h1>',
      sourceRefs: ['cv:1'],
    });
    const row = await prisma.iMMemoryPage.findUnique({ where: { id: page.id } });
    assert.ok(row);
    assert.equal(row!.content, '# dual');
    assert.equal(row!.contentHtml, '<h1>dual edited</h1>');
    assert.equal(row!.contentHtmlVersion, 0);
  });

  await runTest('createPage rejects oversize contentHtml', async () => {
    const acl = await ownerAcl();
    const huge = 'x'.repeat(300_000);
    await assert.rejects(
      writer.createPage({
        acl,
        path: 'memory/test/oversize.md',
        content: '# x',
        contentHtml: huge,
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'content_html_too_large',
    );
  });

  await runTest('createPage rejects contentHtml carrying a secret pattern', async () => {
    const acl = await ownerAcl();
    await assert.rejects(
      writer.createPage({
        acl,
        path: 'memory/test/secret.md',
        content: '# safe',
        contentHtml: '<p>token AKIA-EXAMPLE-FAKE-KEY here</p>',
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'secret_detected',
    );
  });

  // ─── updateHtml (independent write path) ────────────────────
  await runTest('updateHtml writes only contentHtml; leaves content + version intact', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/update-html.md',
      content: '# original markdown',
      sourceRefs: ['cv:1'],
    });
    const before = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });

    const updated = await writer.updateHtml({
      acl,
      pageId: page.id,
      contentHtml: '<h1>rich-text edited</h1>',
    });

    const after = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(after.content, before.content, 'markdown must not change');
    assert.equal(after.version, before.version, 'page version must not bump');
    assert.equal(after.contentHash, before.contentHash, 'markdown contentHash must not change');
    assert.equal(after.contentHtml, '<h1>rich-text edited</h1>');
    assert.equal(after.contentHtmlVersion, 0);
    assert.equal(updated.contentHtml, '<h1>rich-text edited</h1>');
  });

  await runTest('updateHtml respects If-Match (412 on version mismatch)', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/ifmatch.md',
      content: '# x',
      sourceRefs: ['cv:1'],
    });
    await assert.rejects(
      writer.updateHtml({
        acl,
        pageId: page.id,
        contentHtml: '<p>x</p>',
        ifMatch: 'W/"99"',
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'etag_mismatch' && err.status === 412,
    );
  });

  // ─── upsertFromAsset (markdown re-write does not clobber HTML) ─────
  await runTest('upsertFromAsset on existing page does NOT clobber a user-authored contentHtml', async () => {
    const acl = await ownerAcl();
    // Seed via asset upsert (HTML absent — null on insert).
    const page = await pageService.upsertFromAsset({
      workspaceId: wsA,
      actorImUserId: ownerId,
      assetId: `asset_${suffix}`,
      title: 'Photo Note',
      content: '# v1 markdown',
      sourceKind: 'photo',
    });
    // User edits HTML in the rich-text editor.
    await writer.updateHtml({
      acl,
      pageId: page.id,
      contentHtml: '<h1>user-rich</h1>',
    });
    // Asset re-ingested — supplies new markdown but no HTML.
    await pageService.upsertFromAsset({
      workspaceId: wsA,
      actorImUserId: ownerId,
      assetId: `asset_${suffix}`,
      title: 'Photo Note',
      content: '# v2 markdown',
      sourceKind: 'photo',
    });
    const row = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.match(row.content, /v2 markdown/);
    assert.equal(row.contentHtml, '<h1>user-rich</h1>', 'user HTML must survive markdown re-ingest');
    assert.equal(row.contentHtmlVersion, 0);
  });

  await runTest('upsertFromAsset with explicit contentHtml overrides HTML field on update', async () => {
    const acl = await ownerAcl();
    const page = await pageService.upsertFromAsset({
      workspaceId: wsA,
      actorImUserId: ownerId,
      assetId: `asset_b_${suffix}`,
      title: 'PDF Note',
      content: '# v1',
      sourceKind: 'pdf',
    });
    await writer.updateHtml({ acl, pageId: page.id, contentHtml: '<h1>old</h1>' });
    await pageService.upsertFromAsset({
      workspaceId: wsA,
      actorImUserId: ownerId,
      assetId: `asset_b_${suffix}`,
      title: 'PDF Note',
      content: '# v2',
      contentHtml: '<h1>pipeline html v2</h1>',
      sourceKind: 'pdf',
    });
    const row = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(row.contentHtml, '<h1>pipeline html v2</h1>');
    // Pipeline-supplied HTML is still tagged v0 — pipeline owns its derivation.
    assert.equal(row.contentHtmlVersion, 0);
  });

  // ─── applyBackfillHtml (cron skips user-authored) ──────────
  await runTest('applyBackfillHtml updates rows with NULL contentHtmlVersion', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/backfill-null.md',
      content: '# bf',
      sourceRefs: ['cv:1'],
    });
    const updated = await writer.applyBackfillHtml(page.id, wsA, '<h1>bf rendered</h1>', MARKDOWN_RENDER_VERSION);
    assert.equal(updated, 1);
    const row = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(row.contentHtml, '<h1>bf rendered</h1>');
    assert.equal(row.contentHtmlVersion, MARKDOWN_RENDER_VERSION);
  });

  await runTest('applyBackfillHtml SKIPS rows with contentHtmlVersion = 0 (user-authored)', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/backfill-skip.md',
      content: '# md',
      contentHtml: '<h1>user-edited</h1>',
      sourceRefs: ['cv:1'],
    });
    const updated = await writer.applyBackfillHtml(
      page.id,
      wsA,
      '<h1>backfill should NOT win</h1>',
      MARKDOWN_RENDER_VERSION,
    );
    assert.equal(updated, 0, 'backfill cron must NOT touch user-authored HTML');
    const row = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(row.contentHtml, '<h1>user-edited</h1>');
    assert.equal(row.contentHtmlVersion, 0);
  });

  await runTest('applyBackfillHtml upgrades rows from older pipeline versions', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/backfill-upgrade.md',
      content: '# x',
      sourceRefs: ['cv:1'],
    });
    // Simulate prior backfill at v1.
    await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { contentHtml: '<h1>old pipeline</h1>', contentHtmlVersion: 1 },
    });
    const future = MARKDOWN_RENDER_VERSION + 1;
    const updated = await writer.applyBackfillHtml(page.id, wsA, '<h1>new pipeline</h1>', future);
    assert.equal(updated, 1);
    const row = await prisma.iMMemoryPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(row.contentHtmlVersion, future);
    assert.equal(row.contentHtml, '<h1>new pipeline</h1>');
  });

  // ─── readPage format=… filters ──────────────────────────────
  await runTest('readPage format=both returns content + contentHtml', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/read-both.md',
      content: '# md',
      contentHtml: '<h1>html</h1>',
      sourceRefs: ['cv:1'],
    });
    const detail = await reader.readPage(acl, page.id, { format: 'both' });
    assert.ok(detail);
    assert.equal(detail!.content, '# md');
    assert.equal(detail!.contentHtml, '<h1>html</h1>');
    assert.equal(detail!.contentHtmlVersion, 0);
  });

  await runTest('readPage format=markdown drops contentHtml', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/read-md.md',
      content: '# md',
      contentHtml: '<h1>html</h1>',
      sourceRefs: ['cv:1'],
    });
    const detail = await reader.readPage(acl, page.id, { format: 'markdown' });
    assert.ok(detail);
    assert.equal(detail!.content, '# md');
    assert.equal(detail!.contentHtml, null);
    assert.equal(detail!.contentHtmlVersion, null);
  });

  await runTest('readPage format=html drops content (markdown)', async () => {
    const acl = await ownerAcl();
    const page = await writer.createPage({
      acl,
      path: 'memory/test/read-html.md',
      content: '# md',
      contentHtml: '<h1>html</h1>',
      sourceRefs: ['cv:1'],
    });
    const detail = await reader.readPage(acl, page.id, { format: 'html' });
    assert.ok(detail);
    assert.equal(detail!.content, null);
    assert.equal(detail!.contentHtml, '<h1>html</h1>');
    assert.equal(detail!.contentHtmlVersion, 0);
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  await cleanup();
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
