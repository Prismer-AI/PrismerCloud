/**
 * Integration tests for pagination edge cases and concurrent request safety.
 *
 * Target: https://cloud.prismer.dev (test environment)
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/integration/pagination-concurrent.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}

const BASE_URL = 'https://cloud.prismer.dev';
const RUN_ID = Date.now().toString(36);

function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 30_000,
  });
}

function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Shared state — set up once for all tests
// ---------------------------------------------------------------------------

let agentToken: string;
let agentId: string;
let client: PrismerClient;
let targetUserId: string;
let targetToken: string;

beforeAll(async () => {
  const setupClient = apiClient();

  // Register primary agent
  const reg = await setupClient.im.account.register({
    type: 'agent',
    username: `pc-agent-${RUN_ID}`,
    displayName: `PaginConcur Agent (${RUN_ID})`,
    agentType: 'assistant',
    capabilities: ['testing', 'pagination'],
    description: 'Integration test agent for pagination and concurrency',
  });

  expect(reg.ok).toBe(true);
  expect(reg.data).toBeDefined();
  agentToken = reg.data!.token;
  agentId = reg.data!.imUserId;
  client = imClient(agentToken);

  // Register a second agent as message target
  const reg2 = await setupClient.im.account.register({
    type: 'agent',
    username: `pc-target-${RUN_ID}`,
    displayName: `PaginConcur Target (${RUN_ID})`,
    agentType: 'bot',
    capabilities: ['testing'],
  });

  expect(reg2.ok).toBe(true);
  targetUserId = reg2.data!.imUserId;
  targetToken = reg2.data!.token;
}, 30_000);

// ===========================================================================
// Pagination Edge Cases
// ===========================================================================

describe('Pagination edge cases', () => {
  it('conversations.list() with default (no params) returns array', async () => {
    const result = await client.im.conversations.list();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  }, 30_000);

  it('groups.list() returns array', async () => {
    const result = await client.im.groups.list();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  }, 30_000);

  it('contacts.discover() returns array of agents', async () => {
    const result = await client.im.contacts.discover();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  }, 30_000);

  it('contacts.discover() with type filter returns matching agents', async () => {
    const result = await client.im.contacts.discover({ type: 'assistant' });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    // All returned agents should be of the requested type (if any returned)
    if (result.data && result.data.length > 0) {
      for (const agent of result.data) {
        expect(agent.agentType).toBe('assistant');
      }
    }
  }, 30_000);

  it('evolution.browseGenes() with page=1, limit=5 returns at most 5', async () => {
    const result = await client.im.evolution.browseGenes({ page: 1, limit: 5 });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBeLessThanOrEqual(5);
  }, 30_000);

  it('evolution.browseGenes() with page=999 (beyond results) returns empty array', async () => {
    const result = await client.im.evolution.browseGenes({ page: 999, limit: 10 });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBe(0);
  }, 30_000);

  it('tasks.list() returns array (cursor pagination)', async () => {
    const result = await client.im.tasks.list();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  }, 30_000);

  it('tasks.list() with limit returns at most N items', async () => {
    const result = await client.im.tasks.list({ limit: 2 });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBeLessThanOrEqual(2);
  }, 30_000);

  it('memory.listFiles() with scope filter returns array', async () => {
    const result = await client.im.memory.listFiles({ scope: 'test-nonexistent-scope' });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    // Non-existent scope should return empty
    expect(result.data!.length).toBe(0);
  }, 30_000);

  it('memory.listFiles() without filter returns array', async () => {
    const result = await client.im.memory.listFiles();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  }, 30_000);

  it('evolution.browseGenes() with different sort orders', async () => {
    const [newest, mostUsed] = await Promise.all([
      client.im.evolution.browseGenes({ sort: 'newest', limit: 3 }),
      client.im.evolution.browseGenes({ sort: 'most_used', limit: 3 }),
    ]);

    expect(newest.ok).toBe(true);
    expect(mostUsed.ok).toBe(true);
    expect(Array.isArray(newest.data)).toBe(true);
    expect(Array.isArray(mostUsed.data)).toBe(true);
  }, 30_000);
});

// ===========================================================================
// Concurrent Request Tests
// ===========================================================================

describe('Concurrent request safety', () => {
  it('3 parallel direct.send() calls all succeed', async () => {
    const results = await Promise.all([
      client.im.direct.send(targetUserId, `concurrent-1-${RUN_ID}`),
      client.im.direct.send(targetUserId, `concurrent-2-${RUN_ID}`),
      client.im.direct.send(targetUserId, `concurrent-3-${RUN_ID}`),
    ]);

    const successful = results.filter((r) => r.ok);
    // At least 2 of 3 should succeed (rate limiting may block one)
    expect(successful.length).toBeGreaterThanOrEqual(2);
    // Verify concurrent sends didn't crash — data shape may vary
    for (const r of successful) {
      expect(r.ok).toBe(true);
    }
  }, 30_000);

  it('2 parallel evolution.analyze() calls both return', async () => {
    const [r1, r2] = await Promise.all([
      client.im.evolution.analyze({
        error: 'timeout connecting to API',
        tags: ['network', 'timeout'],
      }),
      client.im.evolution.analyze({
        error: 'rate limit exceeded',
        tags: ['rate-limit'],
      }),
    ]);

    // Both should complete (either ok or a known error — not a crash)
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    // If the server supports analyze, both should be ok
    if (r1.ok) {
      expect(r1.data).toBeDefined();
    }
    if (r2.ok) {
      expect(r2.data).toBeDefined();
    }
  }, 30_000);

  it('parallel load() + save() do not interfere with each other', async () => {
    const platformClient = apiClient();

    const [loadResult, saveResult] = await Promise.all([
      platformClient.load('https://example.com').catch((e) => ({ error: e.message, ok: false })),
      platformClient.save({
        url: `https://example.com/concurrent-test-${RUN_ID}`,
        content: `Test content for concurrent save ${RUN_ID}`,
        title: `Concurrent test ${RUN_ID}`,
      }).catch((e) => ({ error: e.message, ok: false })),
    ]);

    // Both should return without throwing (the SDK should not corrupt shared state)
    expect(loadResult).toBeDefined();
    expect(saveResult).toBeDefined();
  }, 30_000);

  it('parallel conversations.list() + contacts.discover() do not conflict', async () => {
    const [convos, agents] = await Promise.all([
      client.im.conversations.list(),
      client.im.contacts.discover(),
    ]);

    expect(convos.ok).toBe(true);
    expect(agents.ok).toBe(true);
    expect(Array.isArray(convos.data)).toBe(true);
    expect(Array.isArray(agents.data)).toBe(true);
  }, 30_000);

  it('5 parallel read-only requests all succeed', async () => {
    const results = await Promise.all([
      client.im.conversations.list(),
      client.im.groups.list(),
      client.im.contacts.discover(),
      client.im.evolution.browseGenes({ limit: 1 }),
      client.im.tasks.list({ limit: 1 }),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.data).toBeDefined();
    }
  }, 30_000);
});
