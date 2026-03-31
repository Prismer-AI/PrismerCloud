/**
 * Integration test for @prismer/opencode-plugin
 *
 * Tests EvolutionClient against live API + Plugin hook contract
 * (matching OpenCode @opencode-ai/plugin v1.3.2 Hooks interface).
 *
 * Usage: PRISMER_API_KEY=sk-prismer-... npx tsx sdk/opencode-plugin/tests/integration.test.ts [base_url]
 */

import { EvolutionClient, type AnalyzeResult, type SyncResult } from '../dist/evolution-client.js';

const API_KEY = process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || '';
const BASE_URL = process.argv[2] || process.env.PRISMER_BASE_URL || 'https://cloud.prismer.dev';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name} — ${detail}` : name;
    failures.push(msg);
    console.log(`  ❌ ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// ─── 1. EvolutionClient unit tests (no network) ─────────────────────

console.log('\n═══ 1. EvolutionClient — construction ═══');

{
  const c = new EvolutionClient({ apiKey: 'test-key' });
  assert(c instanceof EvolutionClient, 'construct with defaults');
}

{
  const c = new EvolutionClient({
    apiKey: 'test-key',
    baseUrl: 'https://custom.example.com/',
    provider: 'test-provider',
    timeout: 5000,
    scope: 'my-scope',
  });
  assert(c instanceof EvolutionClient, 'construct with all options');
}

// ─── 2. EvolutionClient API integration ──────────────────────────────

if (!API_KEY) {
  console.log('\n⚠️  PRISMER_API_KEY not set — skipping API integration tests');
  console.log('   Set PRISMER_API_KEY or PRISMER_API_KEY_TEST to run\n');
} else {
  console.log(`\n═══ 2. EvolutionClient — API integration (${BASE_URL}) ═══`);

  const client = new EvolutionClient({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    provider: 'opencode-test',
    timeout: 15_000,
    scope: 'test-opencode-plugin',
  });

  // 2.1 analyze
  {
    console.log('\n  --- analyze ---');
    const result: AnalyzeResult = await client.analyze(['error:generic'], 'test');
    assert(result !== null && result !== undefined, 'analyze returns result');
    assert(typeof result.confidence === 'number', 'analyze has confidence');
    assert(Array.isArray(result.strategies), 'analyze has strategies array');
    assert(result.geneId === null || typeof result.geneId === 'string', 'analyze geneId is string|null');
  }

  // 2.2 report
  {
    console.log('\n  --- report ---');
    let threw = false;
    try {
      await client.report({
        rawContext: 'Test error: opencode-plugin integration test',
        outcome: 'failed',
        task: 'integration-test',
        stage: 'test',
        severity: 'low',
      });
    } catch { threw = true; }
    assert(!threw, 'report does not throw');
  }

  // 2.3 record
  {
    console.log('\n  --- record ---');
    let threw = false;
    try {
      await client.record('nonexistent-gene-id', 'success', 'integration test record');
    } catch { threw = true; }
    assert(!threw, 'record does not throw on nonexistent gene');
  }

  // 2.4 achievements
  {
    console.log('\n  --- achievements ---');
    const result = await client.achievements();
    assert(Array.isArray(result), 'achievements returns array');
  }

  // 2.5 sync
  {
    console.log('\n  --- sync ---');
    const result: SyncResult | null = await client.sync(undefined, 0, 'test-opencode-plugin');
    assert(result === null || typeof result === 'object', 'sync returns SyncResult|null');
  }
}

// ─── 3. Plugin hook contract (OpenCode @opencode-ai/plugin v1.3.2) ──

console.log('\n═══ 3. Plugin — hook contract (OpenCode v1.3.2) ═══');

{
  const mod = await import('../dist/index.js');
  const PrismerEvolution = mod.PrismerEvolution || mod.default;

  assert(typeof PrismerEvolution === 'function', 'PrismerEvolution is a function');

  // Mock PluginInput
  const mockInput = {
    client: {},
    project: {},
    directory: '/tmp/test',
    worktree: '/tmp/test',
    serverUrl: new URL('http://localhost:3000'),
    $: {},
  };

  // ── 3.1 No API key → empty hooks ──
  const origKey = process.env.PRISMER_API_KEY;
  delete process.env.PRISMER_API_KEY;

  const emptyHooks = await PrismerEvolution(mockInput);
  assert(Object.keys(emptyHooks).length === 0, 'returns empty hooks when PRISMER_API_KEY not set');

  // Restore API key
  process.env.PRISMER_API_KEY = origKey || 'sk-prismer-test-dummy';
  process.env.PRISMER_BASE_URL = BASE_URL;

  const hooks = await PrismerEvolution(mockInput);
  const hookNames = Object.keys(hooks);

  // ── 3.2 Hook registration ──
  assert(hookNames.includes('shell.env'), 'registers shell.env hook');
  assert(hookNames.includes('tool.execute.before'), 'registers tool.execute.before hook');
  assert(hookNames.includes('tool.execute.after'), 'registers tool.execute.after hook');
  assert(hookNames.includes('event'), 'registers event hook');
  assert(!hookNames.includes('session.error'), 'does NOT register non-existent session.error');
  assert(!hookNames.includes('session.created'), 'does NOT register non-existent session.created');

  // ── 3.3 shell.env — mutation pattern (input, output) => void ──
  {
    const env: Record<string, string> = {};
    await hooks['shell.env']!({ cwd: '/tmp' }, { env });
    assert(typeof env.PRISMER_API_KEY === 'string' && env.PRISMER_API_KEY.length > 0, 'shell.env mutates output.env.PRISMER_API_KEY');
    assert(typeof env.PRISMER_BASE_URL === 'string' && env.PRISMER_BASE_URL.length > 0, 'shell.env mutates output.env.PRISMER_BASE_URL');
  }

  // ── 3.4 tool.execute.before — correct signature (input, output) => void ──
  {
    const output = { args: { command: 'ls -la' } };
    let threw = false;
    try {
      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 'test-session', callID: 'call-1' },
        output,
      );
    } catch { threw = true; }
    assert(!threw, 'tool.execute.before handles non-error input without throwing');
    // No _prismerHint expected for non-error commands
    assert(output.args._prismerHint === undefined, 'tool.execute.before does not inject hint for non-error input');
  }

  // ── 3.5 tool.execute.before with error signal ──
  {
    const output = { args: { command: 'npm run build  # fix error' } };
    let threw = false;
    try {
      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 'test-session', callID: 'call-2' },
        output,
      );
    } catch { threw = true; }
    assert(!threw, 'tool.execute.before handles error input without throwing');
    // Hint may or may not be injected depending on gene availability — both are OK
  }

  // ── 3.6 tool.execute.after — success path ──
  {
    const output = { title: 'bash', output: 'file.txt\ndir/', metadata: {} };
    let threw = false;
    try {
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 'test-session', callID: 'call-3', args: { command: 'ls' } },
        output,
      );
    } catch { threw = true; }
    assert(!threw, 'tool.execute.after handles success without throwing');
  }

  // ── 3.7 tool.execute.after — error path (should append evolution hint) ──
  {
    const output = { title: 'bash', output: 'Error: ENOENT file not found\nexit code 1', metadata: {} };
    let threw = false;
    try {
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 'test-session', callID: 'call-4', args: { command: 'cat missing.txt' } },
        output,
      );
    } catch { threw = true; }
    assert(!threw, 'tool.execute.after handles error output without throwing');
    // output.output may have been appended with evolution hint
    assert(typeof output.output === 'string', 'tool.execute.after preserves output string type');
  }

  // ── 3.8 event hook — session lifecycle ──
  {
    let threw = false;
    try {
      await hooks.event!({ event: { type: 'session.created' } });
    } catch { threw = true; }
    assert(!threw, 'event hook handles session.created without throwing');
  }

  {
    let threw = false;
    try {
      await hooks.event!({ event: { type: 'unknown.event' } });
    } catch { threw = true; }
    assert(!threw, 'event hook handles unknown events without throwing');
  }

  // Restore original env
  if (origKey) process.env.PRISMER_API_KEY = origKey;
  else delete process.env.PRISMER_API_KEY;
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
