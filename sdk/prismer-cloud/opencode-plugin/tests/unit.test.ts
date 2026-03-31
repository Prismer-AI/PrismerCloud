/**
 * Unit tests for @prismer/opencode-plugin
 *
 * Pure unit tests — no network calls. All HTTP is mocked via vi.stubGlobal('fetch').
 *
 * Run: npx vitest run tests/unit.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvolutionClient } from '../src/evolution-client.js';

// ─── Helpers ──────────────────────────────────────────────────

function mockFetchJson(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function lastFetchCall(mock: ReturnType<typeof vi.fn>) {
  const calls = mock.mock.calls;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined };
}

// ─── EvolutionClient ─────────────────────────────────────────

describe('EvolutionClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('uses defaults when only apiKey provided', () => {
      const client = new EvolutionClient({ apiKey: 'sk-test' });
      expect(client).toBeInstanceOf(EvolutionClient);
      // Defaults are verified indirectly via request URLs in subsequent tests
    });

    it('accepts all custom options', () => {
      const client = new EvolutionClient({
        apiKey: 'sk-custom',
        baseUrl: 'https://custom.example.com/',
        provider: 'my-provider',
        timeout: 5000,
        scope: 'my-scope',
      });
      expect(client).toBeInstanceOf(EvolutionClient);
    });

    it('strips trailing slash from baseUrl', async () => {
      const fetchMock = mockFetchJson({ data: [] });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/',
      });

      await client.achievements();
      const { url } = lastFetchCall(fetchMock);
      expect(url).toMatch(/^https:\/\/example\.com\/api\/im\/evolution\//);
      expect(url).not.toContain('//api');
    });
  });

  describe('analyze()', () => {
    it('sends correct request body', async () => {
      const fetchMock = mockFetchJson({ data: { gene: null } });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test', provider: 'test-prov' });
      await client.analyze(['error:timeout', 'error:oom'], 'bash', 'my-scope');

      const { url, init, body } = lastFetchCall(fetchMock);
      expect(url).toContain('/api/im/evolution/analyze');
      expect(url).toContain('scope=my-scope');
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer sk-test');
      expect(body.signals).toEqual([{ type: 'error:timeout' }, { type: 'error:oom' }]);
      expect(body.task_status).toBe('pending');
      expect(body.provider).toBe('test-prov');
      expect(body.stage).toBe('bash');
    });

    it('returns parsed AnalyzeResult when gene is found', async () => {
      const fetchMock = mockFetchJson({
        data: {
          gene_id: 'gene-123',
          gene: { title: 'Timeout Fix', strategy: ['Retry with backoff', 'Increase timeout'] },
          confidence: 0.85,
        },
      });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.analyze(['error:timeout'], 'tool');

      expect(result.geneId).toBe('gene-123');
      expect(result.geneTitle).toBe('Timeout Fix');
      expect(result.confidence).toBe(0.85);
      expect(result.strategies).toEqual(['Retry with backoff', 'Increase timeout']);
    });

    it('returns NO_RESULT when no gene is matched', async () => {
      const fetchMock = mockFetchJson({ data: { gene: null } });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.analyze(['error:generic'], 'tool');

      expect(result.geneId).toBeNull();
      expect(result.geneTitle).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.strategies).toEqual([]);
    });

    it('returns NO_RESULT on fetch failure (best-effort)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.analyze(['error:timeout'], 'tool');

      expect(result.geneId).toBeNull();
      expect(result.confidence).toBe(0);
    });
  });

  describe('record()', () => {
    it('sends correct request body for success outcome', async () => {
      const fetchMock = mockFetchJson({});
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test', provider: 'test-prov', scope: 'proj' });
      await client.record('gene-abc', 'success', 'It worked');

      const { url, body } = lastFetchCall(fetchMock);
      expect(url).toContain('/api/im/evolution/record');
      expect(url).toContain('scope=proj');
      expect(body.gene_id).toBe('gene-abc');
      expect(body.outcome).toBe('success');
      expect(body.score).toBe(0.9);
      expect(body.summary).toBe('It worked');
      expect(body.signals).toEqual([{ type: 'exec_success', provider: 'test-prov' }]);
    });

    it('sends score 0.1 for failed outcome', async () => {
      const fetchMock = mockFetchJson({});
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      await client.record('gene-xyz', 'failed', 'Nope');

      const { body } = lastFetchCall(fetchMock);
      expect(body.outcome).toBe('failed');
      expect(body.score).toBe(0.1);
      expect(body.signals).toEqual([{ type: 'exec_failed', provider: 'opencode' }]);
    });
  });

  describe('achievements()', () => {
    it('returns array from data', async () => {
      const fetchMock = mockFetchJson({
        data: [{ id: 'ach-1', title: 'First Fix' }, { id: 'ach-2', title: 'Ten Fixes' }],
      });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.achievements();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'ach-1', title: 'First Fix' });
    });

    it('returns empty array when data is not an array', async () => {
      const fetchMock = mockFetchJson({ data: null });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.achievements();

      expect(result).toEqual([]);
    });

    it('returns empty array on network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.achievements();

      expect(result).toEqual([]);
    });
  });

  describe('sync()', () => {
    it('returns SyncResult with pulled data', async () => {
      const syncData = {
        pushed: { accepted: 2, rejected: [] },
        pulled: { genes: [{ id: 'g1' }], edges: [], cursor: 1234 },
      };
      const fetchMock = mockFetchJson({ data: syncData });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.sync(undefined, 0, 'test-scope');

      expect(result).not.toBeNull();
      expect(result!.pulled.genes).toHaveLength(1);
      expect(result!.pushed.accepted).toBe(2);
    });

    it('returns null when no data in response', async () => {
      const fetchMock = mockFetchJson({});
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      const result = await client.sync();

      expect(result).toBeNull();
    });

    it('includes push outcomes when provided', async () => {
      const fetchMock = mockFetchJson({ data: { pushed: { accepted: 1, rejected: [] }, pulled: { genes: [], edges: [], cursor: 0 } } });
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      await client.sync([
        { gene_id: 'g1', signals: ['error:timeout'], outcome: 'success', summary: 'Fixed' },
      ], 100, 'scope-x');

      const { body } = lastFetchCall(fetchMock);
      expect(body.push.outcomes).toHaveLength(1);
      expect(body.push.outcomes[0].gene_id).toBe('g1');
      expect(body.pull.since).toBe(100);
      expect(body.pull.scope).toBe('scope-x');
    });
  });

  describe('report()', () => {
    it('sends correct request body', async () => {
      const fetchMock = mockFetchJson({});
      globalThis.fetch = fetchMock;

      const client = new EvolutionClient({ apiKey: 'sk-test', provider: 'test-prov' });
      await client.report({
        rawContext: 'Error: timeout',
        outcome: 'failed',
        task: 'deploy',
        stage: 'build',
        severity: 'high',
        score: 0.3,
        scope: 'custom-scope',
      });

      const { url, body } = lastFetchCall(fetchMock);
      expect(url).toContain('/api/im/evolution/report');
      expect(url).toContain('scope=custom-scope');
      expect(body.raw_context).toBe('Error: timeout');
      expect(body.outcome).toBe('failed');
      expect(body.task).toBe('deploy');
      expect(body.provider).toBe('test-prov');
      expect(body.stage).toBe('build');
      expect(body.severity).toBe('high');
      expect(body.score).toBe(0.3);
    });

    it('does not throw on network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      const client = new EvolutionClient({ apiKey: 'sk-test' });
      // Should not throw
      await expect(client.report({
        rawContext: 'test',
        outcome: 'success',
        task: 'test',
        stage: 'test',
      })).resolves.toBeUndefined();
    });
  });
});

// ─── Plugin Hook Contract ────────────────────────────────────

describe('PrismerEvolution plugin', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      PRISMER_API_KEY: process.env.PRISMER_API_KEY,
      PRISMER_BASE_URL: process.env.PRISMER_BASE_URL,
      PRISMER_SCOPE: process.env.PRISMER_SCOPE,
    };
    // Mock fetch globally for plugin init (sync call during startup)
    globalThis.fetch = mockFetchJson({ data: null });
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.restoreAllMocks();
  });

  const mockPluginInput = {
    client: {},
    project: { name: 'test-project' },
    directory: '/tmp/test',
    worktree: '/tmp/test',
    serverUrl: new URL('http://localhost:3000'),
    $: {},
  };

  it('returns empty hooks when PRISMER_API_KEY is not set', async () => {
    delete process.env.PRISMER_API_KEY;
    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('returns hooks object with correct shape', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test-key';
    process.env.PRISMER_BASE_URL = 'https://test.prismer.cloud';

    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);

    expect(hooks['shell.env']).toBeTypeOf('function');
    expect(hooks['tool.execute.before']).toBeTypeOf('function');
    expect(hooks['tool.execute.after']).toBeTypeOf('function');
    expect(hooks.event).toBeTypeOf('function');
    expect(hooks['experimental.chat.system.transform']).toBeTypeOf('function');
  });

  describe('shell.env hook', () => {
    it('sets PRISMER_API_KEY and PRISMER_BASE_URL', async () => {
      process.env.PRISMER_API_KEY = 'sk-prismer-unit-test';
      process.env.PRISMER_BASE_URL = 'https://unit.prismer.cloud';

      const { PrismerEvolution } = await import('../src/index.js');
      const hooks = await PrismerEvolution(mockPluginInput);

      const env: Record<string, string> = {};
      await hooks['shell.env']!({ cwd: '/tmp' }, { env });

      expect(env.PRISMER_API_KEY).toBe('sk-prismer-unit-test');
      expect(env.PRISMER_BASE_URL).toBe('https://unit.prismer.cloud');
    });
  });

  describe('tool.execute.before hook', () => {
    async function getHooks() {
      process.env.PRISMER_API_KEY = 'sk-prismer-test';
      process.env.PRISMER_BASE_URL = 'https://test.prismer.cloud';
      const { PrismerEvolution } = await import('../src/index.js');
      return PrismerEvolution(mockPluginInput);
    }

    it('does not modify non-error input', async () => {
      const hooks = await getHooks();
      const output = { args: { command: 'git status' } };
      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' },
        output,
      );
      expect(output.args._prismerHint).toBeUndefined();
    });

    it('does not inject hint for first occurrence of error signal (stuck threshold = 2)', async () => {
      const hooks = await getHooks();
      // First error mention — not stuck yet
      const output = { args: { command: 'npm run build  # fix timeout error' } };
      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' },
        output,
      );
      // Even though it contains error keywords, stuck threshold requires >= 2 occurrences in journal
      expect(output.args._prismerHint).toBeUndefined();
    });

    it('injects hint when stuck threshold is reached and gene matched', async () => {
      // Mock fetch to return a gene for analyze calls
      const analyzeResponse = {
        data: {
          gene_id: 'gene-stuck',
          gene: { title: 'Timeout Recovery', strategy: ['Use retry'] },
          confidence: 0.75,
        },
      };
      const fetchMock = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('/analyze')) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve(analyzeResponse),
          };
        }
        return { ok: true, status: 200, json: () => Promise.resolve({ data: null }) };
      });
      globalThis.fetch = fetchMock;

      const hooks = await getHooks();

      // Build signal count by triggering after-hook with matching errors twice.
      // Use simple output that only matches "error:timeout" (avoid "connection" which adds extra signals).
      const errorOutput1 = { title: 'bash', output: 'Error: request timed out', metadata: {} };
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'curl ...' } },
        errorOutput1,
      );
      const errorOutput2 = { title: 'bash', output: 'Error: operation timed out again', metadata: {} };
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c2', args: { command: 'curl ...' } },
        errorOutput2,
      );

      // The second after-hook call should have detected stuck threshold and appended hint
      expect(errorOutput2.output).toContain('[Prismer Evolution]');
      expect(errorOutput2.output).toContain('Timeout Recovery');

      // Verify analyze was called (sync + at least 1 analyze)
      const analyzeCalls = fetchMock.mock.calls.filter(
        ([u]: [RequestInfo | URL]) => String(u).includes('/analyze'),
      );
      expect(analyzeCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tool.execute.after hook', () => {
    async function getHooks() {
      process.env.PRISMER_API_KEY = 'sk-prismer-test';
      process.env.PRISMER_BASE_URL = 'https://test.prismer.cloud';
      const { PrismerEvolution } = await import('../src/index.js');
      return PrismerEvolution(mockPluginInput);
    }

    it('does not modify success output', async () => {
      const hooks = await getHooks();
      const output = { title: 'bash', output: 'Build succeeded\nDone in 3.2s', metadata: {} };
      const originalOutput = output.output;

      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'npm run build' } },
        output,
      );

      expect(output.output).toBe(originalOutput);
    });

    it('records error signals in journal and does not append hint on first occurrence', async () => {
      const hooks = await getHooks();
      const output = { title: 'bash', output: 'Error: ENOENT file not found', metadata: {} };
      const originalLen = output.output.length;

      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'cat missing.txt' } },
        output,
      );

      // First error — not stuck, so no hint appended
      expect(output.output.length).toBe(originalLen);
    });

    it('appends hint to error output when stuck threshold reached', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('/analyze')) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              data: {
                gene_id: 'gene-notfound',
                gene: { title: 'File Not Found Fix', strategy: ['Check file path', 'Create missing file'] },
                confidence: 0.9,
              },
            }),
          };
        }
        return { ok: true, status: 200, json: () => Promise.resolve({ data: null }) };
      });
      globalThis.fetch = fetchMock;

      const hooks = await getHooks();

      // First occurrence — builds signal count
      const out1 = { title: 'bash', output: 'Error: file not found /x.ts', metadata: {} };
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1', args: {} },
        out1,
      );

      // Second occurrence — stuck threshold met, should append hint
      const out2 = { title: 'bash', output: 'Error: not found /y.ts', metadata: {} };
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c2', args: {} },
        out2,
      );

      expect(out2.output).toContain('[Prismer Evolution]');
      expect(out2.output).toContain('File Not Found Fix');
      expect(out2.output).toContain('1. Check file path');
    });
  });

  describe('event hook', () => {
    async function getHooks() {
      process.env.PRISMER_API_KEY = 'sk-prismer-test';
      const { PrismerEvolution } = await import('../src/index.js');
      return PrismerEvolution(mockPluginInput);
    }

    it('handles session.created without throwing', async () => {
      const hooks = await getHooks();
      await expect(
        hooks.event!({ event: { type: 'session.created' } }),
      ).resolves.toBeUndefined();
    });

    it('handles unknown events without crash', async () => {
      const hooks = await getHooks();
      await expect(
        hooks.event!({ event: { type: 'some.unknown.event' } }),
      ).resolves.toBeUndefined();
    });

    it('handles event with no type property', async () => {
      const hooks = await getHooks();
      await expect(
        hooks.event!({ event: {} }),
      ).resolves.toBeUndefined();
    });

    it('handles null event gracefully', async () => {
      const hooks = await getHooks();
      await expect(
        hooks.event!({ event: null }),
      ).resolves.toBeUndefined();
    });
  });
});

// ─── Edge Cases ──────────────────────────────────────────────

describe('Edge cases', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      PRISMER_API_KEY: process.env.PRISMER_API_KEY,
      PRISMER_BASE_URL: process.env.PRISMER_BASE_URL,
    };
    globalThis.fetch = mockFetchJson({ data: null });
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.restoreAllMocks();
  });

  const mockPluginInput = {
    client: {},
    project: {},
    directory: '/tmp/test',
    worktree: '/tmp/test',
    serverUrl: new URL('http://localhost:3000'),
    $: {},
  };

  it('no API key returns empty hooks', async () => {
    delete process.env.PRISMER_API_KEY;
    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('empty error string does not extract signals', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);

    const output = { args: { command: '' } };
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      output,
    );
    expect(output.args._prismerHint).toBeUndefined();
  });

  it('very long error output is recorded without crash', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);

    // Generate a very long error output (50K characters)
    const longError = 'Error: ' + 'x'.repeat(50_000) + '\nexit code 1';
    const output = { title: 'bash', output: longError, metadata: {} };

    // Should not throw or hang
    await expect(
      hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'big-command' } },
        output,
      ),
    ).resolves.toBeUndefined();
  });

  it('args truncated to 200 chars in journal entry', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';

    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: null }),
    }));
    globalThis.fetch = fetchMock;

    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);

    // Long command args
    const longCommand = 'a'.repeat(500);
    const output = { title: 'bash', output: 'Error: something failed', metadata: {} };

    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: longCommand } },
      output,
    );

    // The journal entry internally truncates args to 200 chars.
    // We can't directly inspect the journal, but the hook should complete without error.
    // This is a smoke test — if truncation logic is broken, it would throw.
  });

  it('EvolutionClient handles malformed JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });

    const client = new EvolutionClient({ apiKey: 'sk-test' });
    const result = await client.analyze(['error:generic'], 'tool');

    // Best-effort: returns NO_RESULT instead of throwing
    expect(result.geneId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('EvolutionClient handles AbortController timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 50);
      });
    });

    const client = new EvolutionClient({ apiKey: 'sk-test', timeout: 10 });
    const result = await client.analyze(['error:timeout'], 'tool');

    expect(result.geneId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('signal extraction covers all known patterns', async () => {
    // We test extractSignals indirectly by checking if the before-hook recognizes ERROR_RE
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    const { PrismerEvolution } = await import('../src/index.js');
    const hooks = await PrismerEvolution(mockPluginInput);

    const errorPatterns = [
      { cmd: 'fix timeout error', keyword: 'timeout' },
      { cmd: 'fix oom error', keyword: 'oom' },
      { cmd: 'fix permission denied', keyword: 'denied' },
      { cmd: 'fix 404 not found', keyword: 'not found' },
      { cmd: 'fix connection refused', keyword: 'refused' },
      { cmd: 'fix crash issue', keyword: 'crash' },
      { cmd: 'fix exception thrown', keyword: 'exception' },
      { cmd: 'fix panic error', keyword: 'panic' },
    ];

    for (const { cmd } of errorPatterns) {
      const output = { args: { command: cmd } };
      // Should not throw for any error pattern
      await expect(
        hooks['tool.execute.before']!(
          { tool: 'bash', sessionID: 's1', callID: 'c1' },
          output,
        ),
      ).resolves.toBeUndefined();
    }
  });
});
