import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({ api_key: 'sk-test', cloud_api_base: 'http://cloud.test' })),
  resolvePaths: vi.fn(() => ({ localDb: '/tmp/not-used.db' })),
}));

describe('prismer memory write --visibility', () => {
  const originalFetch = globalThis.fetch;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.resetModules();
    bodies = [];
    process.env.PRISMER_WORKSPACE_ID = 'ws_cli_visibility';
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, data: { written: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PRISMER_WORKSPACE_ID;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('passes task:<id> unchanged to the daemon write endpoint', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
    await buildMemoryCommand().parseAsync([
      'write',
      '--path',
      'reports/task.pkf',
      '--content',
      '<h1>Task report</h1>',
      '--visibility',
      'task:cmp_cli_1',
    ], { from: 'user' });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.visibility).toBe('task:cmp_cli_1');
  });

  it('omits visibility when the flag is absent, preserving the daemon default', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
    await buildMemoryCommand().parseAsync([
      'write',
      '--path',
      'reports/default.pkf',
      '--content',
      '<h1>Default report</h1>',
    ], { from: 'user' });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('visibility');
  });
});
