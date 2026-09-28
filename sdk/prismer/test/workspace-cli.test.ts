import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const request = vi.fn();
const fetchRaw = vi.fn();

vi.mock('../src/auth.js', () => ({
  CloudClient: vi.fn().mockImplementation(() => ({
    get,
    request,
    fetchRaw,
  })),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({
    api_key: 'sk-test',
    cloud_api_base: 'http://cloud.test',
    daemon_id: 'daemon-1',
  })),
  resolvePaths: vi.fn(() => ({
    root: '/tmp/prismer',
    configFile: '/tmp/prismer/config.toml',
    localDb: '/tmp/prismer/local.db',
    cacheDir: '/tmp/prismer/cache',
    logsDir: '/tmp/prismer/logs',
  })),
}));

import { buildWorkspaceCommand } from '../src/cli/commands/workspace.js';

describe('buildWorkspaceCommand', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    get.mockReset();
    request.mockReset();
    fetchRaw.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('exposes the workspace subcommand tree', () => {
    const cmd = buildWorkspaceCommand();
    expect(cmd.name()).toBe('workspace');
    // release201/16 Phase 8/9 added `member` + `invite` subcommands.
    expect(cmd.commands.map((c) => c.name())).toEqual([
      'list',
      'create',
      'get',
      'runtime',
      'files',
      'member',
      'invite',
    ]);
  });

  it('lists workspaces as JSON through CloudClient', async () => {
    get.mockResolvedValue([
      {
        id: 'ws_1',
        name: 'Alpha',
        slug: 'alpha',
        isDefault: true,
      },
    ]);

    const cmd = buildWorkspaceCommand();
    await cmd.parseAsync(['list', '--json'], { from: 'user' });

    expect(get).toHaveBeenCalledWith('/api/im/workspaces');
    expect(JSON.parse(stdout)).toEqual([
      {
        id: 'ws_1',
        name: 'Alpha',
        slug: 'alpha',
        isDefault: true,
      },
    ]);
    expect(stderr).toBe('');
  });
});
