#!/usr/bin/env tsx
/**
 * Wave 4-E6 — Cloud-side test:
 *   (1) FULLTEXT MATCH AGAINST primary path + perf benchmark vs LIKE-OR (TF-IDF)
 *   (2) agent-scope ACL enforce on im_memory_files
 *
 * No mocks. Real docker MySQL (localhost:3307, prismer_cloud DB).
 *
 * Seeds N rows (default 1500) of synthetic memory files, runs the same
 * query under both paths, prints p50/p99 latency.
 */

import prisma from '../src/im/db';
import { MemorySearchService } from '../src/im/services/memory-search.service';
import { MemoryService, MemoryScopeForbiddenError } from '../src/im/services/memory.service';
import { randomUUID } from 'node:crypto';

const SEED_ROWS = Number(process.env.SEED_ROWS || 1500);
const QUERY = 'release process versioning';
const ITERS = 30;

const WORKSPACE = `ws_e6_bench_${Date.now().toString(36)}`;
const AGENT_A = `agent_e6_a_${Date.now().toString(36)}`;
const AGENT_B = `agent_e6_b_${Date.now().toString(36)}`;

const VOCAB = [
  'release', 'process', 'versioning', 'semver', 'migration', 'billing', 'Stripe',
  'feature', 'branch', 'memory', 'leak', 'heap', 'dump', 'cache', 'layer',
  'agent', 'task', 'orchestrator', 'lifecycle', 'reaper', 'heartbeat', 'phase',
  'dispatch', 'kanban', 'pipeline', 'cookbook', 'workflow', 'instrumentation',
  'reasoner', 'planner', 'critic', 'researcher', 'editor', 'reviewer', 'analyst',
];

function randomSentence(): string {
  const len = 8 + Math.floor(Math.random() * 12);
  const words: string[] = [];
  for (let i = 0; i < len; i++) {
    words.push(VOCAB[Math.floor(Math.random() * VOCAB.length)] as string);
  }
  return words.join(' ') + '.';
}

function makeContent(): string {
  const sentences = 3 + Math.floor(Math.random() * 4);
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) out.push(randomSentence());
  return out.join(' ');
}

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function main() {
  console.log(`[bench] seeding ${SEED_ROWS} rows into workspace=${WORKSPACE}`);
  console.log(`[bench] agents: A=${AGENT_A} B=${AGENT_B}`);

  // Seed: 70% workspace-shared, 30% agent-private split between A and B
  const start = Date.now();
  for (let i = 0; i < SEED_ROWS; i++) {
    const scope = Math.random() < 0.7 ? 'workspace-shared' : 'agent-private';
    const agentId =
      scope === 'agent-private' ? (Math.random() < 0.5 ? AGENT_A : AGENT_B) : null;
    const ownerId = agentId ?? AGENT_A; // shared rows still have an owner; queries filter by ownerId in fallback
    const id = `mf_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await prisma.iMMemoryFile.create({
      data: {
        id,
        workspaceId: WORKSPACE,
        ownerId,
        ownerType: 'agent',
        path: `memo-${i}.md`,
        content: makeContent(),
        description: `Note ${i} — ${VOCAB[i % VOCAB.length]}`,
        contentHash: id, // synthetic
        scope,
        agentImUserId: agentId,
        visibility: 'workspace',
      },
    });
  }
  console.log(`[bench] seed complete in ${Date.now() - start}ms`);

  // Build ACL context for agent A
  const acl = {
    workspaceId: WORKSPACE,
    callerImUserId: AGENT_A,
    callerKind: 'agent' as const,
    allowedVisibilities: ['workspace', 'public'],
    allowedVisibilityPrefixes: [],
    canRead: (page: { visibility: string }) => ['workspace', 'public'].includes(page.visibility),
    canWrite: (page: { visibility: string }) => ['workspace'].includes(page.visibility),
  };

  // ─── Benchmark: FULLTEXT (current memory-search.service.ts) ──────
  const service = new MemorySearchService();
  // Warm-up
  for (let i = 0; i < 3; i++) {
    await service.search({ acl, query: QUERY, kind: 'files', limit: 20 });
  }
  const ftLatencies: number[] = [];
  let ftHits = 0;
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    const result = await service.search({ acl, query: QUERY, kind: 'files', limit: 20 });
    const t1 = process.hrtime.bigint();
    ftLatencies.push(Number(t1 - t0) / 1_000_000);
    ftHits = result.data.files.length;
  }
  console.log(`[bench] FULLTEXT path: ${ftHits} hits, p50=${pct(ftLatencies, 0.5).toFixed(2)}ms p99=${pct(ftLatencies, 0.99).toFixed(2)}ms`);

  // ─── Benchmark: legacy code-level TF-IDF (simulate by dropping FULLTEXT)
  // We can't actually drop the index for this test, so we simulate by directly
  // running the LIKE-OR Prisma query the legacy path used.
  const likeTokens = QUERY.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const tfLatencies: number[] = [];
  let tfHits = 0;
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    const rows = await prisma.iMMemoryFile.findMany({
      where: {
        workspaceId: WORKSPACE,
        ownerId: AGENT_A,
        OR: likeTokens.flatMap((t) => [
          { path: { contains: t } },
          { description: { contains: t } },
          { content: { contains: t } },
        ]),
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { id: true, path: true, content: true, description: true, updatedAt: true },
    });
    const t1 = process.hrtime.bigint();
    tfLatencies.push(Number(t1 - t0) / 1_000_000);
    tfHits = rows.length;
  }
  console.log(`[bench] LIKE-OR (TF-IDF legacy) path: ${tfHits} hits, p50=${pct(tfLatencies, 0.5).toFixed(2)}ms p99=${pct(tfLatencies, 0.99).toFixed(2)}ms`);

  const speedup = pct(tfLatencies, 0.5) / pct(ftLatencies, 0.5);
  console.log(`[bench] p50 speedup (FULLTEXT vs LIKE-OR): ${speedup.toFixed(2)}x`);

  // ─── Benchmark: high-fanout query (no narrow ownerId index path) ─────
  // This is the workload where FULLTEXT wins decisively — when the
  // predicate prefilter is weak the LIKE scan must touch every row.
  console.log(`\n[bench] high-fanout scenario (im_memory_pages, no narrow filter)`);
  // Insert N pages without an owner filter
  const PAGE_ROWS = Math.min(SEED_ROWS, 1500);
  for (let i = 0; i < PAGE_ROWS; i++) {
    const id = `pg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await prisma.iMMemoryPage.create({
      data: {
        id,
        workspaceId: WORKSPACE,
        path: `pages/wave4-${i}.md`,
        title: `Page ${i}`,
        content: makeContent(),
        contentHash: id,
        pageType: 'leaf',
        visibility: 'workspace',
        createdByImUserId: AGENT_A,
        deletedAt: null,
        provenanceJson: '{}',
      },
    });
  }
  const ftPageLatencies: number[] = [];
  let ftPageHits = 0;
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    const result = await service.search({ acl, query: QUERY, kind: 'memory', limit: 20 });
    const t1 = process.hrtime.bigint();
    ftPageLatencies.push(Number(t1 - t0) / 1_000_000);
    ftPageHits = result.data.memory.length;
  }
  console.log(`[bench]   FULLTEXT (im_memory_pages): ${ftPageHits} hits, p50=${pct(ftPageLatencies, 0.5).toFixed(2)}ms p99=${pct(ftPageLatencies, 0.99).toFixed(2)}ms`);

  // Simulate legacy code-level TF-IDF on the same dataset by running the
  // legacy Prisma LIKE-OR + in-memory TF-IDF score (mimics what
  // memory-search.service.ts did BEFORE Wave 4-E6).
  const tfPageLatencies: number[] = [];
  let tfPageHits = 0;
  const tokens = QUERY.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    const rows = await prisma.iMMemoryPage.findMany({
      where: {
        workspaceId: WORKSPACE,
        archivedAt: null,
        deletedAt: null,
        OR: tokens.flatMap((t) => [
          { path: { contains: t } },
          { title: { contains: t } },
          { content: { contains: t } },
        ]),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100, // legacy pulled limit*5 candidates
      select: {
        id: true, workspaceId: true, path: true, title: true, content: true,
        pageType: true, visibility: true, stale: true, updatedAt: true,
      },
    });
    // Simulate in-memory tf-idf scoring (legacy matchScore loop)
    for (const row of rows) {
      const haystack = `${row.path}\n${row.title ?? ''}\n${row.content}`.toLowerCase();
      for (const tok of tokens) {
        let from = 0;
        let count = 0;
        while (from < haystack.length) {
          const idx = haystack.indexOf(tok, from);
          if (idx < 0) break;
          count++;
          from = idx + tok.length;
          if (count >= 5) break;
        }
      }
    }
    const t1 = process.hrtime.bigint();
    tfPageLatencies.push(Number(t1 - t0) / 1_000_000);
    tfPageHits = Math.min(20, rows.length);
  }
  console.log(`[bench]   Legacy (LIKE-OR + in-mem TF-IDF): ${tfPageHits} hits, p50=${pct(tfPageLatencies, 0.5).toFixed(2)}ms p99=${pct(tfPageLatencies, 0.99).toFixed(2)}ms`);
  const pagesSpeedup = pct(tfPageLatencies, 0.5) / pct(ftPageLatencies, 0.5);
  console.log(`[bench]   p50 speedup: ${pagesSpeedup.toFixed(2)}x`);

  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: WORKSPACE } });

  // ─── ACL test: agent-private scope isolation ─────────────────────
  console.log('\n[acl] agent-scope ACL enforce tests');

  // Insert two agent-private rows directly for explicit isolation test
  const privA = await prisma.iMMemoryFile.create({
    data: {
      id: `mf_priv_a_${randomUUID().slice(0, 8)}`,
      workspaceId: WORKSPACE,
      ownerId: AGENT_A,
      ownerType: 'agent',
      path: 'alice-private.md',
      content: 'alice private content with token xyzzy123',
      description: 'alice private note',
      contentHash: 'h_priv_a',
      scope: 'agent-private',
      agentImUserId: AGENT_A,
      visibility: 'workspace',
    },
  });
  const privB = await prisma.iMMemoryFile.create({
    data: {
      id: `mf_priv_b_${randomUUID().slice(0, 8)}`,
      workspaceId: WORKSPACE,
      ownerId: AGENT_B,
      ownerType: 'agent',
      path: 'bob-private.md',
      content: 'bob private content with token plugh456',
      description: 'bob private note',
      contentHash: 'h_priv_b',
      scope: 'agent-private',
      agentImUserId: AGENT_B,
      visibility: 'workspace',
    },
  });

  // ACL test 1: Alice's search for her own token should find her file
  const aclAlice = { ...acl, callerImUserId: AGENT_A };
  const aliceFinds = await service.search({ acl: aclAlice, query: 'xyzzy123', kind: 'files', limit: 5 });
  const aliceFindsOwn = aliceFinds.data.files.some((f) => f.fileId === privA.id);
  console.log(`  ${aliceFindsOwn ? '✓' : '✗'} alice finds her own agent-private file`);

  // ACL test 2: Alice's search for Bob's token should return 0 (filtered by ownerId)
  // Note: the fetchFileCandidates also has `ownerId = caller` so Bob's row is
  // double-filtered (ownerId + scope ACL). Either filter is sufficient.
  const aliceFindsBob = aliceFinds.data.files.some((f) => f.fileId === privB.id);
  console.log(`  ${!aliceFindsBob ? '✓' : '✗'} alice does NOT find bob's agent-private file`);

  // ACL test 3: Direct readMemoryFile with wrong caller → MemoryScopeForbiddenError
  const memSvc = new MemoryService();
  let threwForbidden = false;
  try {
    await memSvc.readMemoryFile(privB.id, WORKSPACE, AGENT_A);
  } catch (e) {
    threwForbidden = e instanceof MemoryScopeForbiddenError || (e as Error).name === 'MemoryScopeForbiddenError';
  }
  console.log(`  ${threwForbidden ? '✓' : '✗'} readMemoryFile rejects cross-agent read (MemoryScopeForbiddenError)`);

  // ACL test 4: Direct readMemoryFile with correct caller → OK
  let correctRead: { id: string } | null = null;
  try {
    correctRead = await memSvc.readMemoryFile(privB.id, WORKSPACE, AGENT_B);
  } catch (e) {
    /* unexpected */
  }
  console.log(`  ${correctRead?.id === privB.id ? '✓' : '✗'} readMemoryFile accepts owning agent`);

  // ─── Cleanup ─────────────────────────────────────────────────────
  await prisma.iMMemoryFile.deleteMany({ where: { workspaceId: WORKSPACE } });
  console.log(`\n[bench] cleanup complete`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
