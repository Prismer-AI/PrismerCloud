// SDK boundary wave2 B3 — CLI handle axis unification + rename --handle.
//
// - `prismer agent rename` must PATCH { displayName, username? } (username only
//   when --handle is given).
// - register validation is narrowed to the unified axis /^[a-z][a-z0-9-]{2,30}$/
//   (retired old axis [a-zA-Z0-9_-] is rejected before any cloud call).
// - auto-derived slugs stay inside the axis (no underscore, letter-start).
//
// CloudClient + config are mocked; resolvePaths is real (PRISMER_HOME → temp
// dir) so the local mirror write lands in a scratch sqlite.
//
// Usage: npx vitest run test/cli-agent-rename.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; path: string; body?: unknown }>,
}));

vi.mock('../src/auth.js', () => ({
  CloudClient: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    request: vi.fn(async (method: string, path: string, init?: { body?: unknown }) => {
      h.requests.push({ method, path, body: init?.body });
      return { ok: true, status: 200, data: { ok: true, imUserId: 'im-cli-test' } };
    }),
  })),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'd1' })),
  };
});

import { buildAgentCommand } from '../src/cli/commands/agent.js';
import { openLocalDb } from '../src/sync/store.js';
import { setUI, UI, __resetUIForTests } from '../src/cli/ui.js';

let root: string;
let stdout = '';
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-agent-'));
  stdout = '';
  h.requests.length = 0;
  process.env.PRISMER_HOME = root;
  setUI(new UI({ mode: 'json', color: false }));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    stdout += String(c);
    return true;
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}`);
  }) as never);
});
afterEach(() => {
  delete process.env.PRISMER_HOME;
  rmSync(root, { recursive: true, force: true });
  // NOTE: restore only the per-test spies — vi.restoreAllMocks() would also
  // wipe the vi.fn() implementations installed by the vi.mock factories for
  // auth.js/config.js (vitest resets those too), breaking subsequent tests.
  stdoutSpy.mockRestore();
  exitSpy.mockRestore();
  __resetUIForTests();
});

function firstJson(s: string): any {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  return JSON.parse(s);
}

function lastPatch(): h['requests'][number] | undefined {
  const patches = h.requests.filter((r) => r.method === 'PATCH');
  return patches[patches.length - 1];
}

describe('B3 — rename --handle constructs the dual-field PATCH body', () => {
  it('sends { displayName, username } when --handle is given and mirrors locally', async () => {
    // local mirror UPDATE only touches existing rows — seed one first
    const seed = openLocalDb(join(root, 'local.db'));
    seed
      .prepare(
        `INSERT INTO agents (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
         VALUES ('im-cli-test', 'ws-1', 'Old Name', 'hermes', '[]', 'offline', 1, 0, 0)`,
      )
      .run();
    seed.close();

    await buildAgentCommand().parseAsync(
      ['rename', 'im-cli-test', 'New Name', '--handle', 'prod-manager-v2', '--json'],
      { from: 'user' },
    );

    const patch = lastPatch();
    expect(patch?.path).toBe('/api/im/agents/im-cli-test');
    expect(patch?.body).toEqual({ displayName: 'New Name', username: 'prod-manager-v2' });
    expect(firstJson(stdout).ok).toBe(true);
    // local mirror: name landed in the scratch db
    const db = openLocalDb(join(root, 'local.db'));
    const row = db.prepare('SELECT name FROM agents WHERE im_user_id = ?').get('im-cli-test') as
      | { name: string }
      | undefined;
    db.close();
    expect(row?.name).toBe('New Name');
  });

  it('omits username from the body when --handle is absent', async () => {
    await buildAgentCommand().parseAsync(
      ['rename', 'im-cli-test', 'Just Name', '--json'],
      { from: 'user' },
    );

    expect(lastPatch()?.body).toEqual({ displayName: 'Just Name' });
  });

  it('rejects an old-axis handle (uppercase/underscore) before any cloud call', async () => {
    await expect(
      buildAgentCommand().parseAsync(
        ['rename', 'im-cli-test', 'X', '--handle', 'Prod_Manager', '--json'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/__exit_1/);

    const err = firstJson(stdout);
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('agent_rename_bad_username');
    expect(h.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });
});

describe('B3 — register narrowed to the unified axis', () => {
  it('passes a lowercase/hyphen username and mirrors the agent row locally', async () => {
    await buildAgentCommand().parseAsync(
      ['register', '--adapter', 'hermes', '--display-name', 'Product Manager', '--username', 'prod-manager', '--json'],
      { from: 'user' },
    );

    const post = h.requests.find((r) => r.method === 'POST' && r.path === '/api/im/register');
    expect(post?.body).toMatchObject({ username: 'prod-manager', displayName: 'Product Manager' });
    const db = openLocalDb(join(root, 'local.db'));
    const row = db.prepare('SELECT name FROM agents WHERE im_user_id = ?').get('im-cli-test') as
      | { name: string }
      | undefined;
    db.close();
    expect(row?.name).toBe('Product Manager');
  });

  it('rejects the retired old axis (Prod_Manager) before any cloud call', async () => {
    await expect(
      buildAgentCommand().parseAsync(
        ['register', '--adapter', 'hermes', '--display-name', 'Prod Manager', '--username', 'Prod_Manager', '--json'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/__exit_1/);

    const err = firstJson(stdout);
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('agent_register_bad_username');
    expect(h.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('auto-derives a valid slug (no underscores, letter-start for digit-first names)', async () => {
    await buildAgentCommand().parseAsync(
      ['register', '--adapter', 'hermes', '--display-name', '3D Model', '--json'],
      { from: 'user' },
    );

    const post = h.requests.find((r) => r.method === 'POST' && r.path === '/api/im/register');
    expect((post?.body as { username?: string }).username).toBe('agent-3d-model');
  });
});
