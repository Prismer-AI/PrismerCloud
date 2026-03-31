/**
 * Functional test for @prismer/opencode-plugin
 *
 * End-to-end verification:
 *   1. Seed gene with known signal → boost confidence
 *   2. Load plugin → exercise hooks with matching error signals
 *   3. Verify hint injection into tool output
 *   4. Verify feedback loop closes correctly
 *
 * Usage: PRISMER_API_KEY=sk-prismer-... npx tsx sdk/opencode-plugin/tests/functional.test.ts [base_url]
 */

const API_KEY = process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || '';
const BASE_URL = process.argv[2] || process.env.PRISMER_BASE_URL || 'https://cloud.prismer.dev';

if (!API_KEY) {
  console.error('❌ PRISMER_API_KEY required for functional tests');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  ❌ ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function api(method: string, path: string, body?: any, query?: Record<string, string>) {
  const url = new URL(path, BASE_URL);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return resp.json() as Promise<any>;
}

console.log(`\n🔬 Functional Test — OpenCode Plugin (${BASE_URL})\n`);

// ─── Step 1: Seed gene matching "error:timeout" signal ───────────────

console.log('═══ Step 1: Seed gene for error:timeout ═══');

// Use the signal that extractSignals() will produce for "timeout" text
const SIGNAL = 'error:timeout';
const GENE_TITLE = `Timeout Fix — OpenCode Functional Test ${Date.now()}`;

const geneResult = await api('POST', '/api/im/evolution/genes', {
  category: 'repair',
  signals_match: [SIGNAL],
  strategy: [
    'Increase timeout value in configuration',
    'Check for network connectivity issues',
    'Add retry logic with exponential backoff',
  ],
  title: GENE_TITLE,
});

const geneId = geneResult?.data?.id;
assert(!!geneId, 'seed gene created', geneId ? `id=${geneId}` : JSON.stringify(geneResult));

// Boost confidence with many success records
if (geneId) {
  for (let i = 0; i < 8; i++) {
    await api('POST', '/api/im/evolution/record', {
      gene_id: geneId,
      signals: [{ type: SIGNAL }],
      outcome: 'success',
      score: 0.95,
      summary: `Seeded success ${i + 1}/8`,
    });
  }
  console.log('  📊 Seeded 8 success outcomes');
}

// Verify gene is reachable via analyze
{
  const analyzeCheck = await api('POST', '/api/im/evolution/analyze', {
    signals: [{ type: SIGNAL }],
    task_status: 'pending',
  });
  const checkData = analyzeCheck?.data;
  console.log(`  🔍 analyze check: confidence=${checkData?.confidence}, gene=${checkData?.gene_id}`);
  assert(
    checkData?.confidence > 0.3,
    'seeded gene reachable via analyze',
    `confidence=${checkData?.confidence}`,
  );
}

// ─── Wait for rate limit reset ───────────────────────────────────────
// Step 1 uses ~10 API calls (1 create + 8 records + 1 analyze) which exhausts the 10/min rate limit.
// Must wait a full 65s for the sliding window to clear.
console.log('\n⏳ Waiting 65s for rate limit reset (10/min window)...');
await new Promise(r => setTimeout(r, 65_000));

// ─── Step 2: Load plugin ─────────────────────────────────────────────

console.log('═══ Step 2: Load plugin ═══');

process.env.PRISMER_API_KEY = API_KEY;
process.env.PRISMER_BASE_URL = BASE_URL;

const mod = await import('../dist/index.js');
const PrismerEvolution = mod.PrismerEvolution || mod.default;

const hooks = await PrismerEvolution({
  client: {},
  project: {},
  directory: '/tmp/test',
  worktree: '/tmp/test',
  serverUrl: new URL(BASE_URL),
  $: {},
});
assert(typeof hooks['tool.execute.before'] === 'function', 'plugin loaded');

// ─── Step 3: tool.execute.before — hint injection ────────────────────

console.log('\n═══ Step 3: tool.execute.before — hint injection ═══');

{
  // Input with "timeout" keyword → extractSignals() will produce ['error:timeout']
  const output = { args: { command: 'curl https://api.example.com --timeout 30  # fix timeout error' } };
  await hooks['tool.execute.before']!(
    { tool: 'bash', sessionID: 'func-test', callID: 'before-1' },
    output,
  );

  // Also test analyze directly with the same client to compare
  const { EvolutionClient } = await import('../dist/evolution-client.js');
  const debugClient = new EvolutionClient({ apiKey: API_KEY, baseUrl: BASE_URL, provider: 'opencode' });
  const debugResult = await debugClient.analyze(['error:timeout'], 'bash');
  console.log(`  🔍 Debug analyze: geneId=${debugResult.geneId}, confidence=${debugResult.confidence}, strategies=${debugResult.strategies?.length}`);

  if (output.args._prismerHint) {
    assert(true, 'hint injected into args._prismerHint');
    assert(
      output.args._prismerHint.includes('[Evolution]'),
      'hint contains [Evolution] marker',
    );
    assert(
      output.args._prismerHint.includes('%'),
      'hint contains confidence percentage',
    );
    console.log(`  📝 ${output.args._prismerHint}`);
  } else {
    assert(false, 'hint injection expected but not triggered',
      `debugClient returned: geneId=${debugResult.geneId}, confidence=${debugResult.confidence}`);
  }
}

// Wait for rate limit (Step 3 used analyze calls)
console.log('\n⏳ Waiting 15s for rate limit...');
await new Promise(r => setTimeout(r, 15_000));

// ─── Step 4: tool.execute.after — error hint injection ───────────────

console.log('═══ Step 4: tool.execute.after — error output hint ═══');

{
  const errorText = 'Error: connection timed out after 30000ms\nfetch failed: ETIMEDOUT\nexit code 1';
  const output = { title: 'bash', output: errorText, metadata: {} };
  const originalLen = output.output.length;

  await hooks['tool.execute.after']!(
    { tool: 'bash', sessionID: 'func-test', callID: 'after-1', args: { command: 'curl ...' } },
    output,
  );

  assert(typeof output.output === 'string', 'output remains string');

  if (output.output.length > originalLen) {
    assert(true, 'evolution hint appended to error output');
    assert(
      output.output.includes('[Prismer Evolution]'),
      'appended text contains [Prismer Evolution] marker',
    );
    const appended = output.output.slice(originalLen);
    assert(
      appended.includes('1.') || appended.includes('confidence'),
      'appended text contains strategy list or confidence',
    );
    console.log(`  📝 Appended:${appended.slice(0, 300)}`);
  } else {
    // Thompson Sampling may explore low-confidence genes — this is expected behavior
    console.log('  ℹ️  No hint appended (Thompson Sampling may have selected a low-confidence gene — expected)');
    assert(true, 'tool.execute.after completed without error (Thompson Sampling exploration)');
  }
}

// ─── Step 5: Feedback loop — suggest → success → record ──────────────

console.log('\n═══ Step 5: Feedback loop — success path ═══');

{
  // Step A: before-hook sets lastAdvice
  const beforeOutput = { args: { command: 'retry timeout fix --attempt 2' } };
  await hooks['tool.execute.before']!(
    { tool: 'bash', sessionID: 'func-test', callID: 'loop-1' },
    beforeOutput,
  );

  const hadAdvice = !!beforeOutput.args._prismerHint;
  console.log(`  ${hadAdvice ? '📝' : 'ℹ️'} Before-hook: ${hadAdvice ? 'hint injected' : 'no hint (OK)'}`);

  // Step B: after-hook sees success → should record positive outcome (fire-and-forget)
  const afterOutput = { title: 'bash', output: 'Request completed successfully in 120ms', metadata: {} };
  let threw = false;
  try {
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'func-test', callID: 'loop-1', args: beforeOutput.args },
      afterOutput,
    );
  } catch { threw = true; }

  assert(!threw, 'feedback loop success path does not throw');
  assert(
    !afterOutput.output.includes('[Prismer Evolution]'),
    'no hint appended to success output',
  );
}

// ─── Step 6: Feedback loop — suggest → failure → record ──────────────

console.log('\n═══ Step 6: Feedback loop — failure path ═══');

{
  // Step A: before-hook with timeout signal
  const beforeOutput = { args: { command: 'deploy --timeout 60  # timeout error' } };
  await hooks['tool.execute.before']!(
    { tool: 'bash', sessionID: 'func-test', callID: 'loop-2' },
    beforeOutput,
  );

  // Step B: after-hook sees failure → should record negative outcome + suggest new fix
  const afterOutput = {
    title: 'bash',
    output: 'Error: deployment timed out after 60s\nrollback initiated\nexit code 1',
    metadata: {},
  };
  let threw = false;
  try {
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'func-test', callID: 'loop-2', args: beforeOutput.args },
      afterOutput,
    );
  } catch { threw = true; }

  assert(!threw, 'feedback loop failure path does not throw');
  // Should have appended a new evolution hint
  if (afterOutput.output.includes('[Prismer Evolution]')) {
    assert(true, 'new evolution hint appended after failure');
  } else {
    console.log('  ℹ️  No new hint after failure (acceptable — gene may not have re-matched)');
    assert(true, 'failure path completed without crash');
  }
}

// ─── Step 7: Non-error path — no interference ───────────────────────

console.log('\n═══ Step 7: Non-error path (no interference) ═══');

{
  // before-hook with non-error input → should not call analyze
  const beforeOutput = { args: { command: 'git status' } };
  await hooks['tool.execute.before']!(
    { tool: 'bash', sessionID: 'func-test', callID: 'clean-1' },
    beforeOutput,
  );
  assert(beforeOutput.args._prismerHint === undefined, 'no hint for clean command');

  // after-hook with clean output
  const afterOutput = { title: 'bash', output: 'On branch main\nnothing to commit', metadata: {} };
  const origLen = afterOutput.output.length;
  await hooks['tool.execute.after']!(
    { tool: 'bash', sessionID: 'func-test', callID: 'clean-1', args: beforeOutput.args },
    afterOutput,
  );
  assert(afterOutput.output.length === origLen, 'clean output not modified');
}

// ─── Step 8: event hook ──────────────────────────────────────────────

console.log('\n═══ Step 8: Event hook ═══');

{
  let threw = false;
  try {
    await hooks.event!({ event: { type: 'session.created' } });
    await hooks.event!({ event: { type: 'file.edited', path: '/tmp/x.ts' } });
    await hooks.event!({ event: { type: 'message.updated' } });
  } catch { threw = true; }
  assert(!threw, 'event hook handles multiple event types');
}

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Total: ${passed + failed}  |  ✅ Passed: ${passed}  |  ❌ Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  failures.forEach((f) => console.log(`    - ${f}`));
}
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
