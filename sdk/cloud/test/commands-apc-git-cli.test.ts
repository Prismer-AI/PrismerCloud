/**
 * apc P0-5 (F4) — `cloud git *` error rendering.
 *
 * §0.8's honest boundary said "CLI 本体零用例". That gap is what let the
 * following through: `src/im/api/workdirs.ts` returned the forbidden branch as
 * `{ ok:false, error:'Workspace not found' }` — the STRING arm of
 * `ApiResponse.error` — while the CLI read `res.error?.code ?? 'git_failed'`.
 * Reading `.code`/`.message` off a string yields `undefined`, so a
 * "you are not a member of this workspace" refusal printed as
 *
 *     Error [git_failed]: git failed          (--json: {"code":"git_failed","message":""})
 *
 * i.e. the diagnosis was 100% lost and the operator was pointed at git.
 *
 * Anti-open-book discipline (apc/11 §1) — same harness as the ack/meta suite:
 * REAL `node:http` server, REAL `PrismerClient` over global fetch, REAL
 * commander tree. Oracles are the process exit code and the bytes the CLI
 * wrote, plus (for negative controls) the ABSENCE of any HTTP call.
 *
 * The envelopes fed in below are the ones the route really produces:
 *   structured  — workdirs.ts git route (post-fix): {code:'forbidden',message}
 *   string      — workdirs.ts GET /workdirs :147/:149, still the string arm
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { register as registerGit } from '../src/commands/git';
import { startFakeCloud, makeRealClient, runCli, type FakeCloud, type Route } from './helpers/fake-cloud';

const notFound: Route = () => ({ status: 404, json: { ok: false, error: 'Not found' } });

let cloud: FakeCloud;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  cloud = await startFakeCloud(notFound);
  for (const k of ['PRISMER_WORKSPACE_ID', 'PRISMER_DAEMON_ID']) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await cloud.close();
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const scope = ['--workspace', 'ws_1', '--daemon', 'daemon_9'];

describe('cloud git — a STRING-shaped server error must not be swallowed (F4)', () => {
  it('surfaces the server text and does NOT claim git failed', async () => {
    cloud.setRoute(() => ({ status: 404, json: { ok: false, error: 'Workspace not found' } }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerGit, client, ['git', 'commit', 'wd_1', '-m', 'x', ...scope]);

    expect(r.exitCode).toBe(1);
    expect(cloud.calls).toHaveLength(1);
    // The whole point: the server's own words reach the operator…
    expect(r.stderr).toContain('Workspace not found');
    // …and the failure is NOT attributed to git.
    expect(r.stderr).not.toContain('git_failed');
    expect(r.stderr).not.toContain('git failed');
    // …and it is NOT rendered as an escalatable merge conflict either.
    expect(r.stderr).not.toContain('Merge conflict');
  });

  it('--json carries the message instead of an empty string', async () => {
    cloud.setRoute(() => ({ status: 404, json: { ok: false, error: 'Workspace not found' } }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerGit, client, ['git', 'commit', 'wd_1', '-m', 'x', '--json', ...scope]);

    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; code: string; message: string; files: string[] };
    expect(out.ok).toBe(false);
    expect(out.message).toBe('Workspace not found'); // was ''
    expect(out.code).not.toBe('git_failed');
    expect(out.files).toEqual([]);
  });

  it('`git workdirs` (whose route still returns the string arm) surfaces it too', async () => {
    cloud.setRoute(() => ({ status: 404, json: { ok: false, error: 'Workspace not found' } }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerGit, client, ['git', 'workdirs', '--workspace', 'ws_1']);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Workspace not found');
    expect(r.stderr).not.toContain('list workdirs failed');
  });

  // NEGATIVE CONTROL 1: the structured arm must keep its own code + message.
  // Without this, "always print the raw error" would pass case 1 while
  // destroying the conflict / prod_tag / remote_denied codes the skills branch on.
  it('negative control — a STRUCTURED error keeps its own code and message', async () => {
    cloud.setRoute(() => ({
      status: 404,
      json: { ok: false, error: { code: 'forbidden', message: 'Workspace not found' } },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerGit, client, ['git', 'commit', 'wd_1', '-m', 'x', '--json', ...scope]);

    const out = JSON.parse(r.stdout) as { code: string; message: string };
    expect(out.code).toBe('forbidden');
    expect(out.message).toBe('Workspace not found');
  });

  // NEGATIVE CONTROL 2: a REAL conflict must still escalate with its file list.
  // This is 不变量 6's user-visible half; loosening the error handling must not
  // cost it.
  it('negative control — a conflict still escalates WITH the conflicted file list', async () => {
    cloud.setRoute(() => ({
      status: 200,
      json: {
        ok: false,
        error: {
          code: 'conflict',
          message: 'CONFLICT (content): Merge conflict in a.txt',
          details: { files: ['a.txt', 'c.txt'] },
        },
      },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerGit, client, ['git', 'merge', 'wd_1', '--source', 'feat', ...scope]);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Merge conflict');
    expect(r.stderr).toContain('Conflicted files (2)');
    expect(r.stderr).toContain('a.txt');
    expect(r.stderr).toContain('c.txt');
  });

  // NEGATIVE CONTROL 3: a success must still be a success (exit 0), so none of
  // the above passes because every path now errors.
  it('negative control — a successful op exits 0 and prints the sha', async () => {
    cloud.setRoute(() => ({
      status: 200,
      json: { ok: true, data: { op: 'commit', cwd: '/w/repo', stdout: '1 file changed', sha: 'a'.repeat(40) } },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerGit, client, ['git', 'commit', 'wd_1', '-m', 'x', ...scope]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('a'.repeat(40));
  });

  // NEGATIVE CONTROL 4: scope resolution failures must not reach the network at
  // all (a missing --workspace is not a git failure either).
  it('negative control — missing --workspace exits 1 with ZERO requests', async () => {
    const client = makeRealClient(cloud.baseUrl);
    const r = await runCli(registerGit, client, ['git', 'commit', 'wd_1', '-m', 'x', '--daemon', 'd']);
    expect(r.exitCode).toBe(1);
    expect(cloud.calls).toHaveLength(0);
  });
});
