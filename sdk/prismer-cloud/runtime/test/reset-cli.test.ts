import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/index.js';
import { buildResetCommand } from '../src/cli/commands/reset.js';

const execFileSyncMock = vi.hoisted(() => vi.fn(() => ''));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-reset-test-'));
}

describe('reset command', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('');
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is registered on the top-level program', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('reset');
    expect(buildResetCommand().helpInformation()).toContain('--yes');
    expect(buildResetCommand().helpInformation()).toContain('--wipe');
  });

  it('check mode prints a plan without changing files', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    vi.stubEnv('PRISMER_ASSET_SYNC_ROOT', join(home, 'Prismer Assets'));
    vi.stubEnv('HERMES_HOME', join(home, '.hermes'));
    writeFileSync(join(home, 'config.toml'), 'api_key = "sk-prismer-test"\n');
    execFileSyncMock.mockReturnValue('');

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await buildResetCommand().parseAsync(['--check', '--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(join(home, 'config.toml'))).toBe(true);
    const parsed = JSON.parse(out.join('')) as {
      ok: boolean;
      check: boolean;
      plan: { root: string; mode: string; assetSyncRoot: string; hermesHome: string; hermesGatewayPids: number[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.check).toBe(true);
    expect(parsed.plan.root).toBe(home);
    expect(parsed.plan.mode).toBe('archive');
    expect(parsed.plan.assetSyncRoot).toBe(join(home, 'Prismer Assets'));
    expect(parsed.plan.hermesHome).toBe(join(home, '.hermes'));
    expect(parsed.plan.hermesGatewayPids).toEqual([]);
  });

  it('requires --yes outside check mode', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(buildResetCommand().parseAsync([], { from: 'user' })).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('archives the runtime home and recreates an empty root', async () => {
    const parent = tmpHome();
    cleanup.push(parent);
    const home = join(parent, '.prismer');
    const assetSyncRoot = join(parent, 'Prismer Assets');
    const hermesHome = join(parent, '.hermes');
    vi.stubEnv('PRISMER_HOME', home);
    vi.stubEnv('PRISMER_ASSET_SYNC_ROOT', assetSyncRoot);
    vi.stubEnv('HERMES_HOME', hermesHome);
    execFileSyncMock.mockReturnValue('');
    rmSync(home, { recursive: true, force: true });
    writeFileSync(join(parent, 'marker'), 'parent');
    // Create root + nested state.
    writeFileSync(join(parent, '.keep'), 'x');
    mkdirSync(join(home, 'cache'), { recursive: true });
    mkdirSync(join(assetSyncRoot, 'ws_1', 'uploaded'), { recursive: true });
    mkdirSync(join(hermesHome, 'profiles', 'ceo'), { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'api_key = "sk-prismer-test"\n');
    writeFileSync(join(home, 'cache', 'asset'), 'bytes');
    writeFileSync(join(assetSyncRoot, 'ws_1', 'uploaded', 'local.txt'), 'local asset');
    writeFileSync(join(hermesHome, 'profiles', 'ceo', '.env'), 'API_SERVER_KEY="old"\n');

    await buildResetCommand().parseAsync(['--yes', '--json'], { from: 'user' });

    expect(existsSync(home)).toBe(true);
    expect(readdirSync(home)).toEqual([]);
    const archives = readdirSync(parent).filter((name) => name.startsWith('.prismer.reset.'));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(parent, archives[0]!, 'cache', 'asset'), 'utf8')).toBe('bytes');
    const assetArchives = readdirSync(parent).filter((name) => name.startsWith('Prismer Assets.reset.'));
    expect(assetArchives).toHaveLength(1);
    expect(readFileSync(join(parent, assetArchives[0]!, 'ws_1', 'uploaded', 'local.txt'), 'utf8')).toBe('local asset');
    const hermesArchives = readdirSync(parent).filter((name) => name.startsWith('.hermes.reset.'));
    expect(hermesArchives).toHaveLength(1);
    expect(readFileSync(join(parent, hermesArchives[0]!, 'profiles', 'ceo', '.env'), 'utf8')).toContain(
      'API_SERVER_KEY',
    );
  });

  it('detects Python-wrapped Hermes gateway processes', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    vi.stubEnv('PRISMER_ASSET_SYNC_ROOT', join(home, 'Prismer Assets'));
    vi.stubEnv('HERMES_HOME', join(home, '.hermes'));
    execFileSyncMock.mockReturnValue(
      [
        '101 /opt/homebrew/bin/python /Users/prismer/.local/bin/hermes -p ceo gateway run',
        '102 /usr/bin/python3 /tmp/not-hermes gateway run',
        '103 /Users/prismer/.local/bin/hermes -p engineer gateway run',
        '104 /Users/prismer/.local/bin/hermes -p ceo chat',
      ].join('\n'),
    );

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await buildResetCommand().parseAsync(['--check', '--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }

    const parsed = JSON.parse(out.join('')) as { plan: { hermesGatewayPids: number[] } };
    expect(parsed.plan.hermesGatewayPids).toEqual([101, 103]);
  });
});
