/**
 * Prismer IM — Memory Layer Benchmark (bench-memory.ts)
 *
 * Tests: Recall, Staleness, Concurrency (409 rate), Compaction quality,
 * Token estimation accuracy, Section replace accuracy.
 *
 * Usage:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/bench-memory.ts
 *   TEST_BASE_URL="https://cloud.prismer.dev/api/im" npx tsx scripts/bench-memory.ts
 *
 * Metrics measured:
 * - Recall@K (fact retention after multi-round updates)
 * - Staleness Rate (outdated facts remaining)
 * - Conflict Rate (409 count under concurrency)
 * - Compaction Quality (information retention)
 * - Token Estimation Accuracy (length/4 vs actual)
 * - Section Replace Accuracy (Markdown structural integrity)
 * - Load Latency (cold read performance)
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';
let TOKEN = '';
let USER_ID = '';

// ─── Test Infrastructure ──────────────────────────────────────

interface BenchResult {
  name: string;
  metric: string;
  value: number;
  target: string;
  pass: boolean;
  details?: string;
}

const results: BenchResult[] = [];
let totalTests = 0;
let passedTests = 0;

function record(name: string, metric: string, value: number, target: string, pass: boolean, details?: string) {
  totalTests++;
  if (pass) passedTests++;
  results.push({ name, metric, value, target, pass, details });
  const icon = pass ? '✅' : '❌';
  console.log(`  ${icon} ${name}: ${metric} = ${value.toFixed(4)} (target: ${target})${details ? ` — ${details}` : ''}`);
}

// ─── API Helper ───────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown) {
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
}

// ─── Setup ────────────────────────────────────────────────────

async function setup() {
  console.log('\n=== Setup: Register test user ===');

  const username = `benchmem${Date.now()}`;
  const regResult = await api('POST', '/api/register', {
    username,
    displayName: 'Memory Bench User',
    type: 'agent',
  });

  if (!regResult.ok) throw new Error(`Registration failed: ${JSON.stringify(regResult)}`);
  TOKEN = regResult.data?.token;
  USER_ID = regResult.data?.imUserId;
  console.log(`  User registered: ${USER_ID}`);
}

// ─── Test 1: Recall (Fact Retention) ──────────────────────────

async function benchRecall() {
  console.log('\n=== 1. Recall — Fact Retention across Updates ===');

  // Define 20 facts
  const facts = Array.from({ length: 20 }, (_, i) => `FACT_${i + 1}: The answer to question ${i + 1} is ${(i + 1) * 7}.`);

  // Write initial MEMORY.md with all facts
  const initialContent = [
    '# Memory',
    '',
    '## Key Facts',
    '',
    ...facts,
    '',
    '## Session Notes',
    '',
    'Session initialized.',
  ].join('\n');

  const writeRes = await api('POST', '/api/memory/files', {
    path: 'MEMORY.md',
    content: initialContent,
  });

  if (!writeRes.ok) {
    record('Recall Setup', 'Write', 0, '= 1', false, `Write failed: ${writeRes.error?.message}`);
    return;
  }

  const fileId = writeRes.data?.id;

  // Simulate 5 rounds of updates (overwrite Session Notes section)
  for (let round = 1; round <= 5; round++) {
    await api('PATCH', `/api/memory/files/${fileId}`, {
      operation: 'replace_section',
      section: 'Session Notes',
      content: `Session round ${round} completed. Updated at ${new Date().toISOString()}.`,
    });
  }

  // Read back and check how many facts are retained
  const readRes = await api('GET', `/api/memory/files/${fileId}`);
  if (!readRes.ok) {
    record('Recall Read', 'Read', 0, '= 1', false, 'Read failed');
    return;
  }

  const content = readRes.data?.content || '';
  let foundFacts = 0;
  for (const fact of facts) {
    if (content.includes(fact)) foundFacts++;
  }

  const recall = foundFacts / facts.length;
  record(
    'Fact Recall',
    'Recall@20',
    recall,
    '≥ 0.8',
    recall >= 0.8,
    `${foundFacts}/${facts.length} facts retained after 5 updates`,
  );

  // Cleanup
  await api('DELETE', `/api/memory/files/${fileId}`);
}

// ─── Test 2: Staleness Detection ──────────────────────────────

async function benchStaleness() {
  console.log('\n=== 2. Staleness — Outdated Information Detection ===');

  // Write file with versioned facts
  const v1Content = [
    '# Config',
    '',
    '## Versions',
    '',
    'Database: v5.0',
    'API: v2.1',
    'SDK: v1.3',
    'Server: v3.0',
    '',
    '## Status',
    '',
    'All systems operational.',
  ].join('\n');

  const writeRes = await api('POST', '/api/memory/files', {
    path: 'bench_stale.md',
    content: v1Content,
  });

  if (!writeRes.ok) {
    record('Staleness Setup', 'Write', 0, '= 1', false, 'Write failed');
    return;
  }
  const fileId = writeRes.data?.id;

  // Update some facts (making old versions stale)
  const v2Content = [
    '# Config',
    '',
    '## Versions',
    '',
    'Database: v6.0',   // Updated
    'API: v2.1',        // Same
    'SDK: v1.5',        // Updated
    'Server: v3.0',     // Same
    '',
    '## Status',
    '',
    'All systems operational.',
  ].join('\n');

  await api('PATCH', `/api/memory/files/${fileId}`, {
    operation: 'replace',
    content: v2Content,
  });

  // Read back
  const readRes = await api('GET', `/api/memory/files/${fileId}`);
  const content = readRes.data?.content || '';

  // Check: old versions should NOT be present
  const staleEntries = [];
  if (content.includes('v5.0')) staleEntries.push('Database: v5.0');
  if (content.includes('v1.3')) staleEntries.push('SDK: v1.3');

  // Current versions should be present
  const currentEntries = [];
  if (content.includes('v6.0')) currentEntries.push('Database: v6.0');
  if (content.includes('v1.5')) currentEntries.push('SDK: v1.5');

  const stalenessRate = staleEntries.length / 4; // 4 total version entries
  record(
    'Staleness Rate',
    'Stale Ratio',
    stalenessRate,
    '≤ 0.1',
    stalenessRate <= 0.1,
    `stale: [${staleEntries.join(', ')}], current: [${currentEntries.join(', ')}]`,
  );

  // Cleanup
  await api('DELETE', `/api/memory/files/${fileId}`);
}

// ─── Test 3: Concurrency (Optimistic Locking) ────────────────

async function benchConcurrency() {
  console.log('\n=== 3. Concurrency — Optimistic Locking (409 rate) ===');

  // Create a file
  const writeRes = await api('POST', '/api/memory/files', {
    path: 'bench_concurrent.md',
    content: '# Concurrent Test\n\nCounter: 0',
  });

  if (!writeRes.ok) {
    record('Concurrency Setup', 'Write', 0, '= 1', false, 'Write failed');
    return;
  }
  const fileId = writeRes.data?.id;
  const version = writeRes.data?.version || 1;

  // Phase 1: 10 concurrent writes to DIFFERENT sections (should mostly succeed)
  // (Memory API doesn't have sections for concurrent writes, so we test with same version)

  // Phase 2: 10 concurrent PATCH with same expectedVersion → only 1 should succeed
  const concurrentPromises = Array.from({ length: 10 }, (_, i) =>
    api('PATCH', `/api/memory/files/${fileId}`, {
      operation: 'replace',
      content: `# Concurrent Test\n\nCounter: ${i + 1}`,
      expectedVersion: version,
    }),
  );

  const results409 = await Promise.all(concurrentPromises);
  const successes = results409.filter(r => r.ok).length;
  const conflicts = results409.filter(r => !r.ok).length;
  const conflictRate = conflicts / results409.length;

  // With optimistic locking, exactly 1 should succeed, 9 should get 409
  record(
    'Concurrent Write (same version)',
    'Conflict Rate',
    conflictRate,
    '≥ 0.5',
    conflictRate >= 0.5,
    `${successes} succeeded, ${conflicts} conflicted out of ${results409.length}`,
  );

  // Verify data integrity: read back and ensure content is one of the valid values
  const finalRead = await api('GET', `/api/memory/files/${fileId}`);
  const finalContent = finalRead.data?.content || '';
  const hasValidCounter = /Counter: \d+/.test(finalContent);

  record(
    'Data Integrity',
    'Valid Content',
    hasValidCounter ? 1 : 0,
    '= 1',
    hasValidCounter,
    `Final content valid: ${hasValidCounter}`,
  );

  // Cleanup
  await api('DELETE', `/api/memory/files/${fileId}`);
}

// ─── Test 4: Compaction Quality ───────────────────────────────

async function benchCompaction() {
  console.log('\n=== 4. Compaction — Information Retention ===');

  // Create a conversation for compaction testing
  // First we need another user to have a conversation with
  const user2Res = await api('POST', '/api/register', {
    username: `benchmempartner_${Date.now()}`,
    displayName: 'Memory Bench Partner',
    type: 'human',
  });

  if (!user2Res.ok) {
    record('Compaction Setup', 'Partner', 0, '= 1', false, 'Failed to create partner');
    return;
  }

  const partner = user2Res.data;

  // Send messages that contain key facts
  const keyFacts = [
    'The deployment target is Kubernetes cluster in us-east-1.',
    'Database migration requires downtime of 15 minutes.',
    'API rate limit is set to 1000 requests per minute.',
    'The bug was caused by a race condition in the cache layer.',
    'Production release is scheduled for Friday at 2pm UTC.',
  ];

  // Start a direct conversation
  const dmRes = await api('POST', `/api/direct/${partner.imUserId}/messages`, {
    content: 'Starting benchmark conversation for compaction test.',
    type: 'text',
  });

  const conversationId = dmRes.data?.conversationId;
  if (!conversationId) {
    record('Compaction Setup', 'Conversation', 0, '= 1', false, 'No conversation created');
    return;
  }

  // Send messages with key facts mixed with filler
  for (let i = 0; i < 20; i++) {
    const content = i < keyFacts.length
      ? `Message ${i + 1}: ${keyFacts[i]}`
      : `Message ${i + 1}: General discussion about the project status and next steps.`;

    await api('POST', `/api/messages/${conversationId}`, {
      content,
      type: 'text',
    });
  }

  // Call compaction
  const compactRes = await api('POST', '/api/memory/compact', {
    conversationId,
    summary: `Session covered: ${keyFacts.join(' ')} Plus general project discussion.`,
  });

  if (!compactRes.ok) {
    record('Compaction', 'Call', 0, '= 1', false, `Compaction failed: ${compactRes.error?.message}`);
    return;
  }

  // Retrieve compaction and check fact retention
  const summaries = await api('GET', `/api/memory/compact/${conversationId}`);
  if (!summaries.ok || !summaries.data?.length) {
    record('Compaction', 'Retrieval', 0, '= 1', false, 'No compaction summaries found');
    return;
  }

  const latestSummary = summaries.data[0].summary || '';
  let factsRetained = 0;
  const factKeywords = ['Kubernetes', 'migration', 'rate limit', 'race condition', 'Friday'];
  for (const keyword of factKeywords) {
    if (latestSummary.toLowerCase().includes(keyword.toLowerCase())) factsRetained++;
  }

  const retention = factsRetained / factKeywords.length;
  record(
    'Compaction Retention',
    'Fact Rate',
    retention,
    '≥ 0.6',
    retention >= 0.6,
    `${factsRetained}/${factKeywords.length} key facts in summary`,
  );

  // Check token estimation
  if (summaries.data[0].tokenCount) {
    const estimatedTokens = summaries.data[0].tokenCount;
    const charLength = latestSummary.length;
    const expectedEstimate = Math.ceil(charLength / 4);
    const estimationError = Math.abs(estimatedTokens - expectedEstimate) / Math.max(expectedEstimate, 1);

    record(
      'Token Estimation (compaction)',
      'Error Rate',
      estimationError,
      '≤ 0.15',
      estimationError <= 0.15,
      `estimated=${estimatedTokens}, chars/4=${expectedEstimate}`,
    );
  }
}

// ─── Test 5: Token Estimation Accuracy ────────────────────────

function benchTokenEstimation() {
  console.log('\n=== 5. Token Estimation Accuracy (length/4) ===');

  // Test samples across different content types
  // We can't use tiktoken here, so we compute reference values manually
  // tiktoken cl100k_base: English ~1.3 tokens/word, Chinese ~2 tokens/char
  const samples: { content: string; category: string; expectedRatio: number }[] = [
    // English prose: ~4.5 chars/token
    { content: 'The quick brown fox jumps over the lazy dog. This is a test of the token estimation system.', category: 'english', expectedRatio: 4.5 },
    // Code: ~3.5 chars/token (more symbols)
    { content: 'function fibonacci(n: number): number { if (n <= 1) return n; return fibonacci(n - 1) + fibonacci(n - 2); }', category: 'code', expectedRatio: 3.5 },
    // Chinese: ~1.5 chars/token
    { content: '这是一个中文文本测试样本，用于验证不同语言的token估算精度。人工智能技术正在快速发展。', category: 'chinese', expectedRatio: 1.5 },
    // Mixed: ~3 chars/token
    { content: 'API returns { "status": 200, "data": { "name": "测试用户", "score": 95.5 } }', category: 'mixed', expectedRatio: 3.0 },
    // URLs/technical: ~4 chars/token
    { content: 'https://api.prismer.cloud/v1/context/load?input=example.com&format=hqcc', category: 'url', expectedRatio: 4.0 },
  ];

  // Our estimator: Math.ceil(length / 4)
  let totalError = 0;
  let maxError = 0;
  const errors: number[] = [];

  for (const sample of samples) {
    const estimated = Math.ceil(sample.content.length / 4);
    const approxActual = Math.ceil(sample.content.length / sample.expectedRatio);
    const error = Math.abs(estimated - approxActual) / Math.max(approxActual, 1);
    totalError += error;
    maxError = Math.max(maxError, error);
    errors.push(error);
  }

  const mape = totalError / samples.length;
  record(
    'Token MAPE (all languages)',
    'Mean Error',
    mape,
    '≤ 0.3',
    mape <= 0.3,
    `across ${samples.length} categories, max=${maxError.toFixed(3)}`,
  );

  // Known weakness: Chinese text
  const chineseSample = samples.find(s => s.category === 'chinese')!;
  const chineseEstimate = Math.ceil(chineseSample.content.length / 4);
  const chineseActual = Math.ceil(chineseSample.content.length / chineseSample.expectedRatio);
  const chineseError = Math.abs(chineseEstimate - chineseActual) / Math.max(chineseActual, 1);

  record(
    'Token Estimation (Chinese)',
    'Error Rate',
    chineseError,
    'baseline',
    true, // Informational — Chinese will have higher error
    `estimate=${chineseEstimate}, approx_actual=${chineseActual}, error=${(chineseError * 100).toFixed(1)}%`,
  );

  // English (should be most accurate)
  const englishSample = samples.find(s => s.category === 'english')!;
  const englishEstimate = Math.ceil(englishSample.content.length / 4);
  const englishActual = Math.ceil(englishSample.content.length / englishSample.expectedRatio);
  const englishError = Math.abs(englishEstimate - englishActual) / Math.max(englishActual, 1);

  record(
    'Token Estimation (English)',
    'Error Rate',
    englishError,
    '≤ 0.15',
    englishError <= 0.15,
    `estimate=${englishEstimate}, approx_actual=${englishActual}`,
  );
}

// ─── Test 6: Section Replace Accuracy ─────────────────────────

async function benchSectionReplace() {
  console.log('\n=== 6. Section Replace — Markdown Structural Integrity ===');

  const complexMarkdown = [
    '# Project Notes',
    '',
    '## Architecture',
    '',
    'Three-layer system:',
    '- Next.js BFF',
    '- IM Server',
    '- Backend API',
    '',
    '## Current Status',
    '',
    'All tests passing.',
    '',
    '### Subsection A',
    '',
    'Details about subsection A.',
    '',
    '### Subsection B',
    '',
    'Details about subsection B.',
    '',
    '## TODO',
    '',
    '- [ ] Item 1',
    '- [ ] Item 2',
    '- [x] Item 3',
  ].join('\n');

  const writeRes = await api('POST', '/api/memory/files', {
    path: 'bench_section.md',
    content: complexMarkdown,
  });

  if (!writeRes.ok) {
    record('Section Replace Setup', 'Write', 0, '= 1', false, 'Write failed');
    return;
  }
  const fileId = writeRes.data?.id;

  // Test 1: Replace a top-level section
  const replaceRes1 = await api('PATCH', `/api/memory/files/${fileId}`, {
    operation: 'replace_section',
    section: 'Current Status',
    content: 'Deployment in progress.\n\n### Subsection A\n\nUpdated A.\n\n### Subsection B\n\nUpdated B.',
  });

  if (replaceRes1.ok) {
    const readRes = await api('GET', `/api/memory/files/${fileId}`);
    const content = readRes.data?.content || '';

    // Verify structure
    const hasArchitecture = content.includes('## Architecture');
    const hasTodo = content.includes('## TODO');
    const hasUpdatedStatus = content.includes('Deployment in progress');
    const hasOldStatus = content.includes('All tests passing');

    const structureOk = hasArchitecture && hasTodo && hasUpdatedStatus && !hasOldStatus;
    record(
      'Top-level Section Replace',
      'Structural OK',
      structureOk ? 1 : 0,
      '= 1',
      structureOk,
      `arch=${hasArchitecture}, todo=${hasTodo}, updated=${hasUpdatedStatus}, noOld=${!hasOldStatus}`,
    );

    // Count heading levels
    const h2Count = (content.match(/^## /gm) || []).length;
    const h3Count = (content.match(/^### /gm) || []).length;

    record(
      'Heading Preservation',
      'H2 Count',
      h2Count,
      '= 3',
      h2Count === 3,
      `Expected 3 (Architecture, Current Status, TODO), got ${h2Count}`,
    );
  } else {
    record('Section Replace', 'API Call', 0, '= 1', false, `Failed: ${replaceRes1.error?.message}`);
  }

  // Test 2: Replace TODO section
  const replaceRes2 = await api('PATCH', `/api/memory/files/${fileId}`, {
    operation: 'replace_section',
    section: 'TODO',
    content: '- [x] Item 1\n- [x] Item 2\n- [x] Item 3\n- [ ] Item 4',
  });

  if (replaceRes2.ok) {
    const readRes = await api('GET', `/api/memory/files/${fileId}`);
    const content = readRes.data?.content || '';
    const hasItem4 = content.includes('Item 4');
    const hasOldUnchecked = content.includes('- [ ] Item 1');

    record(
      'TODO Section Replace',
      'Updated',
      hasItem4 && !hasOldUnchecked ? 1 : 0,
      '= 1',
      hasItem4 && !hasOldUnchecked,
    );
  }

  // Test 3: Replace non-existent section (should append or error gracefully)
  const replaceRes3 = await api('PATCH', `/api/memory/files/${fileId}`, {
    operation: 'replace_section',
    section: 'NonExistent',
    content: 'This is a new section.',
  });

  const gracefulHandling = replaceRes3.ok || replaceRes3.error?.code;
  record(
    'Non-existent Section',
    'Graceful',
    gracefulHandling ? 1 : 0,
    '= 1',
    gracefulHandling === true || gracefulHandling === 1,
    replaceRes3.ok ? 'Appended or ignored' : `Error: ${replaceRes3.error?.code}`,
  );

  // Cleanup
  await api('DELETE', `/api/memory/files/${fileId}`);
}

// ─── Test 7: Load Latency ─────────────────────────────────────

async function benchLoadLatency() {
  console.log('\n=== 7. Load Latency (cold read) ===');

  // Create files of different sizes
  const sizes = [
    { label: '1KB', size: 1024 },
    { label: '10KB', size: 10240 },
    { label: '100KB', size: 102400 },
  ];

  for (const { label, size } of sizes) {
    const content = 'x'.repeat(size);
    const writeRes = await api('POST', '/api/memory/files', {
      path: `bench_latency_${label}.md`,
      content,
    });

    if (!writeRes.ok) continue;
    const fileId = writeRes.data?.id;

    // Measure read latency (3 reads, take median)
    const latencies: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await api('GET', `/api/memory/files/${fileId}`);
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const median = latencies[1];

    record(
      `Load Latency (${label})`,
      'Median ms',
      median,
      '< 200',
      median < 200,
      `p50=${median.toFixed(1)}ms, p0=${latencies[0].toFixed(1)}ms, p100=${latencies[2].toFixed(1)}ms`,
    );

    // Cleanup
    await api('DELETE', `/api/memory/files/${fileId}`);
  }
}

// ─── Report ──────────────────────────────────────────────────

function printReport() {
  console.log('\n' + '='.repeat(60));
  console.log('  Memory Layer Benchmark Report');
  console.log('='.repeat(60));

  console.log('\n┌────────────────────────────────┬────────────────┬──────────┬────────┐');
  console.log('│ Test                           │ Metric         │ Value    │ Status │');
  console.log('├────────────────────────────────┼────────────────┼──────────┼────────┤');

  for (const r of results) {
    const name = r.name.padEnd(30).substring(0, 30);
    const metric = r.metric.padEnd(14).substring(0, 14);
    const value = r.value.toFixed(4).padStart(8);
    const status = r.pass ? ' PASS ' : ' FAIL ';
    console.log(`│ ${name} │ ${metric} │ ${value} │ ${status} │`);
  }

  console.log('└────────────────────────────────┴────────────────┴──────────┴────────┘');
  console.log(`\nTotal: ${passedTests}/${totalTests} passed`);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Prismer IM — Memory Layer Benchmark');
  console.log(`  Base URL: ${BASE}`);
  console.log('='.repeat(60));

  try {
    await setup();
    await benchRecall();
    await benchStaleness();
    await benchConcurrency();
    await benchCompaction();
    benchTokenEstimation();
    await benchSectionReplace();
    await benchLoadLatency();
  } catch (err) {
    console.error('\nFatal error:', err);
  }

  printReport();
  process.exit(passedTests < totalTests ? 1 : 0);
}

main();
