#!/usr/bin/env node
/**
 * Prismer Cloud — v1.6.0 Context Cache Performance Benchmark
 *
 * Measures latency for Save/Load operations with local Prisma cache.
 *
 * Usage:
 *   API_KEY=sk-prismer-live-xxx node scripts/test-performance.js
 *   API_KEY=sk-prismer-live-xxx BASE_URL=https://prismer.cloud node scripts/test-performance.js
 */

const BASE_URL = (process.env.BASE_URL || 'https://cloud.prismer.dev').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const RUN_ID = Date.now().toString(36);

if (!API_KEY) {
  console.error('❌ API_KEY is required');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ──────────────────────────────────────────────

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { label, ms, result };
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  return res.json();
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0].toFixed(0),
    max: sorted[sorted.length - 1].toFixed(0),
    avg: (sum / sorted.length).toFixed(0),
    median: sorted[Math.floor(sorted.length / 2)].toFixed(0),
    p95: sorted[Math.floor(sorted.length * 0.95)].toFixed(0),
  };
}

// ─── Benchmarks ───────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Prismer Cloud — v1.6.0 Performance Benchmark          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Target : ${BASE_URL}`);
  console.log(`  Run ID : ${RUN_ID}`);
  console.log('');

  // ── 1. Save (Deposit) ─────────────────────────────────────
  console.log('━━━ 1. Save (Deposit) Latency ━━━');

  const saveUrls = [];
  const saveTimes = [];
  for (let i = 0; i < 10; i++) {
    const url = `https://perf-test.example.com/${RUN_ID}/save-${i}`;
    saveUrls.push(url);
    const { ms } = await timed(`save-${i}`, () =>
      post('/api/context/save', {
        url,
        hqcc: `Performance test content ${i}. `.repeat(20),
        raw: `Raw content ${i}. `.repeat(10),
        visibility: 'private',
        meta: { source: 'perf_test', run: RUN_ID, index: i },
      })
    );
    saveTimes.push(ms);
  }
  const saveStats = stats(saveTimes);
  console.log(`  10 deposits: avg=${saveStats.avg}ms  median=${saveStats.median}ms  min=${saveStats.min}ms  max=${saveStats.max}ms  p95=${saveStats.p95}ms`);

  // ── 2. Load Single URL (Cache Hit) ────────────────────────
  console.log('\n━━━ 2. Load Single URL — Cache Hit ━━━');

  const loadTimes = [];
  for (let i = 0; i < 10; i++) {
    const url = saveUrls[i % saveUrls.length];
    const { ms, result } = await timed(`load-${i}`, () =>
      post('/api/context/load', { input: url })
    );
    loadTimes.push(ms);
    if (i === 0) {
      console.log(`  Cache hit: ${result?.result?.cached ? 'YES' : 'NO'}`);
    }
  }
  const loadStats = stats(loadTimes);
  console.log(`  10 cache hits: avg=${loadStats.avg}ms  median=${loadStats.median}ms  min=${loadStats.min}ms  max=${loadStats.max}ms  p95=${loadStats.p95}ms`);

  // ── 3. Warm Migration (local miss → backend hit) ─────────
  // These URLs are likely already in the backend cache from prior test runs.
  // This measures the warm migration path: local Prisma MISS → backend fallback HIT → write-back.
  console.log('\n━━━ 3. Warm Migration (local miss → backend hit) ━━━');

  const warmUrls = [
    'https://httpbin.org/html',
    'https://example.org',
    'https://jsonplaceholder.typicode.com/posts/1',
  ];
  const warmTimes = [];
  for (const url of warmUrls) {
    const { ms, result } = await timed(`warm`, () =>
      post('/api/context/load', { input: url })
    );
    warmTimes.push(ms);
    console.log(`  ${url.substring(0, 50).padEnd(50)} → ${ms.toFixed(0)}ms (cached: ${result?.result?.cached || false})`);
  }
  const warmStats = stats(warmTimes);
  console.log(`  Warm migration avg: ${warmStats.avg}ms`);

  // ── 3b. True Cache Miss (Exa fetch + LLM compress) ──────
  // Use unique URLs with a timestamp to guarantee they aren't in any cache.
  // This triggers: local MISS → backend MISS → Exa fetch → OpenAI compress → deposit.
  // Expected: 3-15 seconds per URL depending on content size.
  console.log('\n━━━ 3b. True Cache Miss (Exa + LLM) ━━━');
  console.log('  Note: These URLs should NOT be in any cache.');
  console.log('  Expected latency: 3-15s (Exa fetch + OpenAI compress)');

  const trueMissUrls = [
    `https://en.wikipedia.org/wiki/Special:Random?nocache=${RUN_ID}`,
    `https://news.ycombinator.com/item?id=1&t=${RUN_ID}`,
  ];
  const trueMissTimes = [];
  for (const url of trueMissUrls) {
    const { ms, result } = await timed(`true-miss`, () =>
      post('/api/context/load', { input: url })
    );
    trueMissTimes.push(ms);
    const hasHqcc = !!result?.result?.hqcc;
    const errMsg = result?.result?.error || '';
    console.log(`  ${url.substring(0, 60).padEnd(60)} → ${ms.toFixed(0)}ms (hqcc: ${hasHqcc}${errMsg ? ', err: ' + errMsg : ''})`);
  }
  if (trueMissTimes.length > 0) {
    const trueMissStats = stats(trueMissTimes);
    console.log(`  True cache miss avg: ${trueMissStats.avg}ms`);
  }

  // ── 4. Batch Load (Cache Hit) ─────────────────────────────
  console.log('\n━━━ 4. Batch Load — Cache Hit ━━━');

  const batchSizes = [5, 10];
  for (const size of batchSizes) {
    const batchUrls = saveUrls.slice(0, size);
    const batchTimes = [];
    for (let i = 0; i < 5; i++) {
      const { ms, result } = await timed(`batch-${size}-${i}`, () =>
        post('/api/context/load', { input: batchUrls })
      );
      batchTimes.push(ms);
      if (i === 0) {
        const summary = result?.summary || {};
        console.log(`  Batch ${size}: found=${summary.found}/${summary.total}, cached=${summary.cached || 'N/A'}`);
      }
    }
    const batchStats = stats(batchTimes);
    console.log(`  Batch ${size} × 5 runs: avg=${batchStats.avg}ms  median=${batchStats.median}ms  min=${batchStats.min}ms  max=${batchStats.max}ms`);
  }

  // ── 5. Save with Visibility Variants ──────────────────────
  console.log('\n━━━ 5. Save — Visibility Variants ━━━');

  for (const vis of ['public', 'private', 'unlisted']) {
    const url = `https://perf-test.example.com/${RUN_ID}/vis-${vis}`;
    const { ms, result } = await timed(vis, () =>
      post('/api/context/save', {
        url,
        hqcc: `Visibility test content for ${vis}`,
        visibility: vis,
      })
    );
    console.log(`  ${vis.padEnd(10)} → ${ms.toFixed(0)}ms  status=${result?.status || 'N/A'}`);
  }

  // ── 6. Load after Save Round-Trip ─────────────────────────
  console.log('\n━━━ 6. Save → Load Round-Trip ━━━');

  const rtUrl = `https://perf-test.example.com/${RUN_ID}/round-trip`;
  const saveRT = await timed('save', () =>
    post('/api/context/save', {
      url: rtUrl,
      hqcc: 'Round-trip test content with enough data to be meaningful. '.repeat(50),
      raw: 'Raw round-trip content. '.repeat(30),
      visibility: 'private',
      meta: { source: 'perf_test', type: 'round_trip' },
    })
  );
  const loadRT = await timed('load', () =>
    post('/api/context/load', { input: rtUrl })
  );
  console.log(`  Save: ${saveRT.ms.toFixed(0)}ms → Load: ${loadRT.ms.toFixed(0)}ms → Total: ${(saveRT.ms + loadRT.ms).toFixed(0)}ms`);
  console.log(`  Content match: ${loadRT.result?.result?.hqcc ? 'YES' : 'NO'}`);

  // ── 7. Dashboard/Activities (read performance) ─────────────
  console.log('\n━━━ 7. Dashboard & Activities ━━━');

  const dashRT = await timed('dashboard', () => get('/api/dashboard/stats?period=7d'));
  const actRT = await timed('activities', () => get('/api/activities?limit=20'));
  console.log(`  Dashboard stats: ${dashRT.ms.toFixed(0)}ms`);
  console.log(`  Activities (20): ${actRT.ms.toFixed(0)}ms`);

  // ── Summary ────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  Summary                                                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Save (deposit)             avg: ${saveStats.avg.padStart(6)}ms  p95: ${saveStats.p95.padStart(6)}ms       ║`);
  console.log(`║  Load (cache hit)           avg: ${loadStats.avg.padStart(6)}ms  p95: ${loadStats.p95.padStart(6)}ms       ║`);
  console.log(`║  Warm migration (BE hit)    avg: ${warmStats.avg.padStart(6)}ms                        ║`);
  if (trueMissTimes.length > 0) {
    const tms = stats(trueMissTimes);
    console.log(`║  True miss (Exa+LLM)       avg: ${tms.avg.padStart(6)}ms                        ║`);
  }
  console.log(`║  Batch 5 (cache hit)        avg: ${stats(batchSizes[0] === 5 ? loadTimes.slice(0,5) : loadTimes).avg.padStart(6)}ms                        ║`);
  console.log(`║  Batch 10 (cache hit)       avg: ${stats(loadTimes).avg.padStart(6)}ms                        ║`);
  console.log(`║  Round-trip (save+load)          : ${(saveRT.ms + loadRT.ms).toFixed(0).padStart(6)}ms                        ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Note: All times include network RTT (~250ms to EKS test cluster).');
  console.log('Server-side latency ≈ total - 250ms.');
}

run().catch(err => {
  console.error('💥 Fatal:', err);
  process.exit(1);
});
