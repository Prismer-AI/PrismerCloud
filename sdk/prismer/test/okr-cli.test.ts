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

import { buildOkrCommand } from '../src/cli/commands/okr.js';

describe('buildOkrCommand', () => {
  let stdout = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    get.mockReset();
    request.mockReset();
    fetchRaw.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('exposes the okr subcommand tree (no frozen layers)', () => {
    const cmd = buildOkrCommand();
    expect(cmd.name()).toBe('okr');
    expect(cmd.commands.map((c) => c.name()).sort()).toEqual(['insights', 'kr', 'link', 'objective', 'pack']);
    const objective = cmd.commands.find((c) => c.name() === 'objective')!;
    expect(objective.commands.map((c) => c.name()).sort()).toEqual([
      'archive', 'carry-over', 'checkin', 'close', 'commit', 'create', 'get', 'grade', 'list', 'retro',
    ]);
    const kr = cmd.commands.find((c) => c.name() === 'kr')!;
    expect(kr.commands.map((c) => c.name()).sort()).toEqual(['add', 'recompute']);
  });

  it('objective create POSTs the mapped body', async () => {
    request.mockResolvedValue({ ok: true, status: 200, data: { data: { id: 'obj_1', state: 'draft' } } });
    const cmd = buildOkrCommand();
    await cmd.parseAsync(
      ['objective', 'create', '--workspace', 'ws_1', '--title', 'Search GA', '--type', 'committed', '--sponsor', 'u_human'],
      { from: 'user' },
    );
    expect(request).toHaveBeenCalledWith('POST', '/api/im/okr/objectives', {
      body: { workspaceId: 'ws_1', title: 'Search GA', type: 'committed', sponsorImUserId: 'u_human' },
    });
    expect(JSON.parse(stdout)).toEqual({ id: 'obj_1', state: 'draft' });
  });

  it('kr add assembles metricBinding and defaults source to agent-proposed', async () => {
    request.mockResolvedValue({ ok: true, status: 200, data: { data: { id: 'kr_1' } } });
    const cmd = buildOkrCommand();
    await cmd.parseAsync(
      ['kr', 'add', 'obj_1', '--title', 'p95 < 300ms', '--type', 'metric',
        '--baseline', '480', '--target', '300', '--unit', 'ms', '--direction', 'decrease',
        '--metric-namespace', 'search.latency', '--metric-name', 'p95', '--metric-agg', 'last'],
      { from: 'user' },
    );
    expect(request).toHaveBeenCalledWith('POST', '/api/im/okr/objectives/obj_1/key-results', {
      body: {
        title: 'p95 < 300ms',
        type: 'metric',
        baselineNumeric: 480,
        targetNumeric: 300,
        unit: 'ms',
        direction: 'decrease',
        source: 'agent-proposed',
        metricBinding: { namespace: 'search.latency', name: 'p95', agg: 'last' },
      },
    });
  });

  it('link POSTs a work-link triple', async () => {
    request.mockResolvedValue({ ok: true, status: 200, data: { data: { ok: true } } });
    const cmd = buildOkrCommand();
    await cmd.parseAsync(['link', 'obj_1', 'kr_1', 'task_1'], { from: 'user' });
    expect(request).toHaveBeenCalledWith('POST', '/api/im/okr/work-links', {
      body: { objectiveId: 'obj_1', keyResultId: 'kr_1', taskId: 'task_1' },
    });
  });

  it('insights GETs the workspace OKR tree', async () => {
    get.mockResolvedValue({ workspaceId: 'ws_1', objectives: [] });
    const cmd = buildOkrCommand();
    await cmd.parseAsync(['insights', '--workspace', 'ws_1'], { from: 'user' });
    expect(get).toHaveBeenCalledWith('/api/im/insights/okr?workspaceId=ws_1');
  });
});
