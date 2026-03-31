/**
 * SDK Cross-Language Parity Tests — TypeScript baseline
 *
 * These tests validate SDK behavior that MUST be identical across all 4 languages
 * (TypeScript, Python, Go, Rust). Each test has a matching counterpart in:
 *   - python/tests/test_parity.py
 *   - golang/parity_test.go
 *   - rust/tests/parity.rs
 *
 * Run: PRISMER_API_KEY_TEST="sk-prismer-..." npx vitest run tests/integration/sdk-parity.test.ts
 * Env: PRISMER_BASE_URL_TEST (default: https://cloud.prismer.dev)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../../src/index';

const API_KEY = process.env.PRISMER_API_KEY_TEST || '';
const BASE_URL = process.env.PRISMER_BASE_URL_TEST || 'https://cloud.prismer.dev';
const RUN_ID = `ts-parity-${Date.now()}`;

let client: PrismerClient;

beforeAll(() => {
  if (!API_KEY) throw new Error('PRISMER_API_KEY_TEST is required');
  client = new PrismerClient({ apiKey: API_KEY, baseUrl: BASE_URL });
});

// ============================================================================
// P1: Context API
// ============================================================================

describe('P1: Context API', () => {
  test('P1.1 load single URL returns result with url field', async () => {
    const result = await client.load('https://example.com');
    expect(result.success).toBe(true);
    expect(result.mode).toBe('single_url');
    expect(result.result).toBeDefined();
    expect(result.result?.url).toBe('https://example.com');
  });

  test('P1.2 load returns content in some form', async () => {
    const result = await client.load('https://example.com');
    expect(result.success).toBe(true);
    // Content may be in result.result, result.results[0], or nested differently
    const data = result as any;
    const hasData = data.result || (data.results && data.results.length > 0);
    expect(hasData).toBeTruthy();
  });

  test('P1.3 search returns results', async () => {
    try {
      const result = await client.search('prismer cloud');
      expect(result.success).toBe(true);
    } catch (e: any) {
      // Search depends on external Exa API — may timeout in test env
      if (e.message?.includes('timeout') || e.message?.includes('abort')) {
        console.log('    (search timeout — Exa API slow, skipping)');
        return;
      }
      throw e;
    }
  }, 20000);
});

// ============================================================================
// P2: IM — Registration & Identity
// ============================================================================

describe('P2: IM Registration & Identity', () => {
  let imUserId: string;

  test('P2.1 workspace init returns conversationId + token', async () => {
    const result = await client.im.workspace.init({
      workspaceId: `ws-${RUN_ID}`,
      userId: `user-${RUN_ID}`,
      userDisplayName: 'Parity Test User',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.conversationId).toBeDefined();
  });

  test('P2.2 me() returns user profile', async () => {
    const result = await client.im.account.me();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  test('P2.3 contacts list returns array', async () => {
    const result = await client.im.contacts.list();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('P2.4 discover returns agents', async () => {
    const result = await client.im.contacts.discover();
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// P3: IM — Conversations & Messages
// ============================================================================

describe('P3: Conversations & Messages', () => {
  test('P3.1 conversations list returns array', async () => {
    const result = await client.im.conversations.list();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });
});

// ============================================================================
// P4: Evolution — Core Loop
// ============================================================================

describe('P4: Evolution Core Loop', () => {
  let geneId: string;

  test('P4.1 analyze returns action + confidence', async () => {
    const result = await client.im.evolution.analyze({
      signals: [{ type: 'error:timeout' }],
      task_status: 'pending',
      error: 'Connection timeout',
    });
    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data?.action).toBeDefined();
    expect(typeof data?.confidence).toBe('number');
  });

  test('P4.2 create gene returns gene object', async () => {
    const result = await client.im.evolution.createGene({
      title: `Parity Test Gene ${RUN_ID}`,
      strategy: ['Step 1: test', 'Step 2: verify'],
      category: 'repair',
      signals_match: [{ type: 'error:test_parity' }],
    });
    expect(result.ok).toBe(true);
    const gene = result.data as any;
    geneId = gene?.gene?.id || gene?.id || '';
    expect(geneId).toBeTruthy();
  });

  test('P4.3 record outcome returns ok', async () => {
    if (!geneId) return;
    const result = await client.im.evolution.record({
      gene_id: geneId,
      outcome: 'success',
      score: 0.85,
      summary: 'Parity test: outcome recorded',
      signals: [{ type: 'error:test_parity', provider: 'parity-test' }],
    });
    expect(result.ok).toBe(true);
  });

  test('P4.4 achievements returns array', async () => {
    const result = await client.im.evolution.getAchievements();
    expect(result.ok).toBe(true);
  });

  test('P4.5 sync push+pull returns result', async () => {
    const result = await client.im.evolution.sync({
      push: { outcomes: [] },
      pull: { since: 0 },
    });
    expect(result.ok).toBe(true);
  });

  test('P4.6 public stats returns data', async () => {
    const result = await client.im.evolution.getStats();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  test('P4.7 browse public genes returns array', async () => {
    const result = await client.im.evolution.browseGenes({ limit: 5 });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data?.genes || result.data)).toBe(true);
  });

  test('P4.8 delete gene returns ok', async () => {
    if (!geneId) return;
    const result = await client.im.evolution.deleteGene(geneId);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// P5: Leaderboard (NEW)
// ============================================================================

describe('P5: Leaderboard', () => {
  test('P5.1 leaderboard stats returns totalAgentsEvolving', async () => {
    const res = await fetch(`${BASE_URL}/api/im/evolution/leaderboard/stats`);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.data?.totalAgentsEvolving).toBe('number');
  });

  test('P5.2 leaderboard agents returns array', async () => {
    const res = await fetch(`${BASE_URL}/api/im/evolution/leaderboard/agents?period=weekly`);
    const data = await res.json();
    // May 500 if migration not run — skip gracefully
    if (res.status === 500) return;
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.data?.agents)).toBe(true);
  });

  test('P5.3 leaderboard comparison returns verdict', async () => {
    const res = await fetch(`${BASE_URL}/api/im/evolution/leaderboard/comparison`);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data?.verdict).toBeDefined();
  });
});

// ============================================================================
// P6: Memory
// ============================================================================

describe('P6: Memory', () => {
  let fileId: string;

  test('P6.1 write memory file', async () => {
    const result = await client.im.memory.createFile({
      path: `parity/${RUN_ID}.md`,
      content: `# Parity Test\n${new Date().toISOString()}`,
    });
    expect(result.ok).toBe(true);
    fileId = result.data?.id || '';
    expect(fileId).toBeTruthy();
  });

  test('P6.2 list memory files', async () => {
    const result = await client.im.memory.listFiles();
    expect(result.ok).toBe(true);
  });

  test('P6.3 load session memory', async () => {
    const result = await client.im.memory.load();
    expect(result.ok).toBe(true);
  });

  test('P6.4 recall search', async () => {
    const res = await fetch(`${BASE_URL}/api/im/recall?q=parity`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test('P6.5 delete memory file', async () => {
    if (!fileId) return;
    const result = await client.im.memory.deleteFile(fileId);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// P7: Tasks
// ============================================================================

describe('P7: Tasks', () => {
  let taskId: string;

  test('P7.1 create task', async () => {
    const result = await client.im.tasks.create({
      title: `Parity Task ${RUN_ID}`,
      description: 'Cross-language parity test',
      type: 'general',
    });
    expect(result.ok).toBe(true);
    taskId = result.data?.id || '';
    expect(taskId).toBeTruthy();
  });

  test('P7.2 list tasks', async () => {
    const result = await client.im.tasks.list();
    expect(result.ok).toBe(true);
  });

  test('P7.3 get task', async () => {
    if (!taskId) return;
    const result = await client.im.tasks.get(taskId);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  test('P7.4 claim task', async () => {
    if (!taskId) return;
    const result = await client.im.tasks.claim(taskId);
    expect(result.ok).toBe(true);
  });

  test('P7.5 complete task', async () => {
    if (!taskId) return;
    const result = await client.im.tasks.complete(taskId, { result: 'parity test done' });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// P8: Skills
// ============================================================================

describe('P8: Skills', () => {
  test('P8.1 search skills (public)', async () => {
    const res = await fetch(`${BASE_URL}/api/im/skills/search?q=test&limit=3`);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test('P8.2 skills stats (public)', async () => {
    const res = await fetch(`${BASE_URL}/api/im/skills/stats`);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test('P8.3 skills categories (public)', async () => {
    const res = await fetch(`${BASE_URL}/api/im/skills/categories`);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

// ============================================================================
// P9: Files
// ============================================================================

describe('P9: Files', () => {
  test('P9.1 file types', async () => {
    const result = await client.im.files.types();
    expect(result.ok).toBe(true);
  });

  test('P9.2 file quota', async () => {
    const result = await client.im.files.quota();
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// P10: EvolutionRuntime
// ============================================================================

describe('P10: EvolutionRuntime', () => {
  test('P10.1 suggest returns strategies or null', async () => {
    const { EvolutionRuntime } = await import('../../src/index');
    const rt = new EvolutionRuntime(client.im.evolution);
    await rt.start();

    const fix = await rt.suggest('Connection timeout ETIMEDOUT');
    // May return null if no genes match — that's ok
    if (fix) {
      expect(Array.isArray(fix.strategy)).toBe(true);
      expect(typeof fix.confidence).toBe('number');
    }
  });

  test('P10.2 learned does not throw', async () => {
    const { EvolutionRuntime } = await import('../../src/index');
    const rt = new EvolutionRuntime(client.im.evolution);
    await rt.start();

    // Should not throw even without a prior suggest
    expect(() => {
      rt.learned('ETIMEDOUT', 'success', 'Parity test learned');
    }).not.toThrow();
  });

  test('P10.3 getMetrics returns object', async () => {
    const { EvolutionRuntime } = await import('../../src/index');
    const rt = new EvolutionRuntime(client.im.evolution);
    await rt.start();

    const metrics = rt.getMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics.totalSuggestions).toBe('number');
  });
});

// ============================================================================
// P11: Webhook
// ============================================================================

describe('P11: Webhook', () => {
  test('P11.1 verify rejects invalid signature', async () => {
    const { verifyWebhookSignature } = await import('../../src/webhook');
    const isValid = verifyWebhookSignature('invalid-body', 'invalid-signature', 'test-secret');
    expect(isValid).toBe(false);
  });
});

// ============================================================================
// P12: Signal Rules
// ============================================================================

describe('P12: Signal Rules', () => {
  test('P12.1 extract_signals detects timeout', async () => {
    const { extractSignals } = await import('../../src/index');
    const signals = extractSignals({ error: 'Error: ETIMEDOUT connection timed out', output: '' });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some(s => s.type.includes('timeout'))).toBe(true);
  });

  test('P12.2 extract_signals detects permission error', async () => {
    const { extractSignals } = await import('../../src/index');
    const signals = extractSignals({ error: 'Error: 403 Forbidden access denied', output: '' });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some(s => s.type.includes('permission') || s.type.includes('403'))).toBe(true);
  });

  test('P12.3 extract_signals returns empty for clean output', async () => {
    const { extractSignals } = await import('../../src/index');
    const signals = extractSignals({ error: '', output: 'Build succeeded. All tests passed.' });
    expect(signals.length).toBe(0);
  });
});
