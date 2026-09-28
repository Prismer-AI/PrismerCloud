// Runtime-side-effect checkers (apc/12 §0.6): json-claim / declared-id-readback
// / git-claim-readback.
//
// Same discipline as bundle-structured-criteria.test.ts: every checker gets a
// GREEN case and the minimal faithful injection of the fault it claims to
// catch, which must be RED. Nothing is mocked — the readback checker talks to a
// real (loopback) HTTP server and the git checker reads real git object stores,
// because "re-reading the real side effect" is the entire feature under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchCriterion, type AcceptanceCriterion } from '../src/bundle/index.js';

// ───────────────────────── json-claim ──────────────────────────────────────

describe('json-claim — the pasted product is re-parsed, not read as prose', () => {
  let repo: string;
  const RUN_AT = '2026-07-26T04:00:00.000Z';

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'apc-jsonclaim-'));
    mkdirSync(join(repo, 'scripts/test203/artifacts'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts/test203/baseline.json'),
      JSON.stringify({ 'known-red.test.ts (vitest exit 1)': 'fail' }),
    );
    const artifact = join(repo, 'scripts/test203/artifacts/smoke-evidence.txt');
    writeFileSync(artifact, 'skip-with-evidence\n');
    const at = new Date(RUN_AT).getTime() / 1000;
    utimesSync(artifact, at, at);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const product = (over: Record<string, unknown> = {}, tierOver: Record<string, unknown> = {}) => ({
    schema: 'test203.run/v1',
    timestamp: RUN_AT,
    envStatus: 'ok',
    tiers: [
      {
        tier: 'TD',
        passed: 2,
        failed: 0,
        skipped: 1,
        total: 3,
        failedNames: [],
        skippedNames: ['desktop-shell.ts (skip)'],
        durationMs: 12,
        envStatus: 'ok',
        regressions: [],
        ...tierOver,
      },
    ],
    regressions: [],
    fixed: [],
    exitCode: 0,
    ...over,
  });

  const report = (doc: unknown, lines: string[] = ['RUN-EXIT: 0', 'VERDICT: passed']) =>
    [...lines, '', '```json', JSON.stringify(doc, null, 2), '```'].join('\n');

  const criterion: AcceptanceCriterion = {
    label: 'structured run product',
    type: 'structured',
    checker: 'json-claim',
    match: '<structured:json-claim>',
    args: {
      equals: { schema: 'test203.run/v1' },
      require: ['exitCode', 'envStatus', 'tiers', 'regressions', 'timestamp'],
      types: { exitCode: 'number', tiers: 'array', regressions: 'array' },
      allowed: { exitCode: [0, 1, 78], envStatus: ['ok', 'env_blocked'] },
      declaredLines: { 'RUN-EXIT': 'exitCode' },
      derivedLines: { VERDICT: { from: 'exitCode', map: { '0': 'passed', '1': 'failed', '78': 'env-fault' } } },
      implications: [
        { if: { path: 'exitCode', equals: 78 }, then: { path: 'envStatus', equals: 'env_blocked' } },
        { if: { path: 'exitCode', equals: 1 }, then: { path: 'regressions', nonEmpty: true } },
        { if: { path: 'exitCode', equals: 0 }, then: { path: 'regressions', empty: true } },
      ],
      eachItem: { path: 'tiers', sum: { parts: ['passed', 'failed', 'skipped'], total: 'total' }, lengths: { failedNames: 'failed' } },
      requireItems: { path: 'tiers', key: 'tier', values: ['TD'] },
      baselineRecompute: {
        file: 'scripts/test203/baseline.json',
        itemsPath: 'tiers',
        failedNamesKey: 'failedNames',
        regressionsPath: 'regressions',
      },
      freshArtifacts: { timestampPath: 'timestamp', paths: ['scripts/test203/artifacts/smoke-evidence.txt'], skewMinutes: 30 },
    },
  };

  const run = (out: string, args?: Record<string, unknown>) =>
    matchCriterion(args ? { ...criterion, args } : criterion, out, { cwd: repo });

  it('passes a report that pastes a real, self-consistent product', () => {
    const r = run(report(product()));
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/baseline diff recomputed/);
  });

  it('FAILS when there is no fenced JSON at all (prose-only "it was green")', () => {
    const r = run('RUN-EXIT: 0\nVERDICT: passed\n\napc test ran green, no regressions.');
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/no parseable fenced JSON/);
  });

  it('FAILS when the prose exit code contradicts the pasted product', () => {
    const r = run(report(product({ exitCode: 1, regressions: ['new.test.ts (vitest exit 1)'] }, { failed: 1, passed: 1, failedNames: ['new.test.ts (vitest exit 1)'], regressions: ['new.test.ts (vitest exit 1)'] })));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/contradicts the pasted product/);
  });

  it('FAILS when the verdict is chosen instead of derived (78 narrated as a SUT red)', () => {
    const doc = product({ exitCode: 78, envStatus: 'env_blocked' });
    const r = run(report(doc, ['RUN-EXIT: 78', 'VERDICT: failed']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/not the verdict derived from exitCode=78 \(must be `env-fault`\)/);
  });

  it('passes the env_blocked run when the verdict IS the derived one', () => {
    const doc = product({ exitCode: 78, envStatus: 'env_blocked' });
    expect(run(report(doc, ['RUN-EXIT: 78', 'VERDICT: env-fault'])).pass).toBe(true);
  });

  it('FAILS the exit-code contract (green exit while regressions are listed)', () => {
    const doc = product({ regressions: ['x.test.ts (vitest exit 1)'] }, { failed: 1, passed: 1, failedNames: ['x.test.ts (vitest exit 1)'] });
    const r = run(report(doc));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/exitCode=0 ⇒ regressions must be empty/);
  });

  it('FAILS invented per-tier counts (passed+failed+skipped no longer equals total)', () => {
    const r = run(report(product({}, { passed: 9 })));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/passed\+failed\+skipped = 10 but total = 3/);
  });

  it('FAILS when failedNames does not line up with the failed count', () => {
    const doc = product({ exitCode: 1, regressions: ['a.test.ts (vitest)'] }, { failed: 2, passed: 0, failedNames: ['a.test.ts (vitest)'] });
    const r = run(report(doc, ['RUN-EXIT: 1', 'VERDICT: failed']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/failedNames\.length = 1 but failed = 2/);
  });

  it('FAILS when the tier this task pinned is not the tier that ran', () => {
    const r = run(report(product({}, { tier: 'T0(root)' })));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/pinned tiers\.tier = TD but the product ran T0\(root\)/);
  });

  it('FAILS when a NEW red is passed off as the baseline known red (the --diff verdict faked)', () => {
    // exit 1 + a non-empty regressions[] satisfies every internal invariant —
    // only recomputing the diff from the real baseline.json catches the swap.
    const doc = product(
      { exitCode: 1, regressions: ['known-red.test.ts (vitest exit 1)'] },
      {
        failed: 2,
        passed: 1,
        skipped: 0,
        total: 3,
        failedNames: ['known-red.test.ts (vitest exit 1)', 'brand-new.test.ts (vitest exit 1)'],
      },
    );
    const r = run(report(doc, ['RUN-EXIT: 1', 'VERDICT: failed']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/NEW red\(s\) hidden from regressions: brand-new/);
  });

  it('FAILS when a baseline KNOWN red is reported as a regression (over-reporting is also wrong)', () => {
    const doc = product(
      { exitCode: 1, regressions: ['known-red.test.ts (vitest exit 1)'] },
      { failed: 1, passed: 1, failedNames: ['known-red.test.ts (vitest exit 1)'] },
    );
    const r = run(report(doc, ['RUN-EXIT: 1', 'VERDICT: failed']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/ARE baseline known-red/);
  });

  it('accepts a run whose only red is the baseline known red (exit 0, empty regressions)', () => {
    const doc = product({}, { failed: 1, passed: 1, skipped: 1, total: 3, failedNames: ['known-red.test.ts (vitest exit 1)'] });
    expect(run(report(doc)).pass).toBe(true);
  });

  it('FAILS when the run byproduct does not exist (nothing on disk was touched)', () => {
    const r = run(report(product()), {
      ...(criterion.args as Record<string, unknown>),
      freshArtifacts: { timestampPath: 'timestamp', paths: ['scripts/test203/artifacts/never-written.txt'], skewMinutes: 30 },
    });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/does not exist — the run this report describes left no trace/);
  });

  it('FAILS when the byproduct is stale relative to the timestamp the report claims', () => {
    const r = run(report(product({ timestamp: new Date(Date.parse(RUN_AT) + 6 * 3600_000).toISOString() }), ['RUN-EXIT: 0', 'VERDICT: passed']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/did not come from a run that touched this file/);
  });

  it('FAILS closed when the checker is given no verification args', () => {
    const r = run(report(product()), {});
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/misconfigured/);
  });

  it('FAILS when the baseline file the verdict depends on is absent', () => {
    const r = run(report(product()), {
      ...(criterion.args as Record<string, unknown>),
      baselineRecompute: { file: 'scripts/test203/nope.json', itemsPath: 'tiers', failedNamesKey: 'failedNames', regressionsPath: 'regressions' },
    });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/baseline file not found/);
  });
});

// ── json-claim: the release-verb args (apc/12 §0.6 final four) ──────────────
// `apc release *` products carry NO clock and NO tier arithmetic; their ground
// truth is (a) a list of filenames the run READ off disk, (b) a file the run
// REWROTE, (c) the run's own input file. Those are `filesExist` / `fileEquals`
// / `freshArtifacts.timestampLine`.

describe('json-claim — filesExist / fileEquals / timestampLine (the release verbs)', () => {
  let repo2: string;
  const RUN_AT = '2026-07-25T23:32:11.000Z';
  const LEDGER = [
    { version: '2.0.6', tag: 'k8s-test-20260710-v2.0.6', status: 'current', ts: '2026-07-10T00:00:00Z' },
    { version: '2.0.7', tag: 'k8s-test-20260720-v2.0.7', status: 'pulled', ts: '2026-07-20T00:00:00Z' },
  ];

  beforeAll(() => {
    repo2 = mkdtempSync(join(tmpdir(), 'apc-release-claim-'));
    mkdirSync(join(repo2, 'src/im/sql'), { recursive: true });
    mkdirSync(join(repo2, '.e2e-tmp'), { recursive: true });
    writeFileSync(join(repo2, 'src/im/sql/501_a.sql'), '-- a\n');
    writeFileSync(join(repo2, 'src/im/sql/502_b.sql'), '-- b\n');
    writeFileSync(join(repo2, 'VERSION'), '2.2.4\n');
    const ledger = join(repo2, '.e2e-tmp/ledger.json');
    writeFileSync(ledger, JSON.stringify(LEDGER, null, 2) + '\n');
    const at = Date.parse(RUN_AT) / 1000;
    utimesSync(ledger, at, at);
  });
  afterAll(() => rmSync(repo2, { recursive: true, force: true }));

  const fence = (doc: unknown, lines: string[]) => [...lines, '', '```json', JSON.stringify(doc, null, 2), '```'].join('\n');
  const crit = (args: Record<string, unknown>): AcceptanceCriterion => ({
    label: 'release product',
    type: 'structured',
    checker: 'json-claim',
    match: '<structured:json-claim>',
    args,
  });
  const run = (args: Record<string, unknown>, out: string) => matchCriterion(crit(args), out, { cwd: repo2 });

  // (a) filesExist — the enumeration the run read off disk
  const syncDoc = (pending: string[]) => ({ verb: 'db-config-sync', decision: 'staged', migration: { exitCode: 0, pending } });
  const syncArgs = { equals: { verb: 'db-config-sync' }, filesExist: { path: 'migration.pending', dir: 'src/im/sql', min: 1 } };

  it('passes when every enumerated filename is a real file in the directory it was read from', () => {
    const r = run(syncArgs, fence(syncDoc(['501_a.sql', '502_b.sql']), []));
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/all 2 name\(s\) .* resolve to real files in src\/im\/sql/);
  });

  it('FAILS one invented filename hidden among real ones', () => {
    const r = run(syncArgs, fence(syncDoc(['501_a.sql', '529_invented.sql']), []));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/529_invented\.sql`, which does not exist under src\/im\/sql/);
  });

  it('FAILS an empty plan when the task pins at least one entry (the command never reached the ledger)', () => {
    const r = run(syncArgs, fence(syncDoc([]), []));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/enumerates 0 entr\(ies\) but this task pins at least 1/);
  });

  it('FAILS a path-traversal filename instead of stat-ing it', () => {
    const r = run(syncArgs, fence(syncDoc(['../../../etc/passwd']), []));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/is not a plain filename/);
  });

  // (b) fileEquals — text mode against the run's own input
  const otaDoc = (version: string) => ({ verb: 'ota-promote', k8s: { request: { version } } });
  const otaArgs = { equals: { verb: 'ota-promote' }, fileEquals: { 'k8s.request.version': { file: 'VERSION' } } };

  it('passes when the product field equals the file on disk (trimmed)', () => {
    expect(run(otaArgs, fence(otaDoc('2.2.4'), [])).pass).toBe(true);
  });

  it('FAILS a product whose version does not match VERSION on disk (a stale run passed off as this one)', () => {
    const r = run(otaArgs, fence(otaDoc('2.2.3'), []));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/VERSION on disk says "2\.2\.4"/);
  });

  it('FAILS closed when the cross-checked file does not exist', () => {
    const r = run({ equals: { verb: 'ota-promote' }, fileEquals: { 'k8s.request.version': { file: 'NOPE' } } }, fence(otaDoc('2.2.4'), []));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/there is no on-disk fact to cross-check/);
  });

  // (c) fileEquals — json mode against the file the run REWROTE
  const rbDoc = (next: unknown, over: Record<string, unknown> = {}) => ({ verb: 'rollback', decision: 'green', applied: true, plan: { ok: true, next }, ...over });
  const rbArgs = {
    equals: { verb: 'rollback', applied: true },
    fileEquals: { 'plan.next': { file: '.e2e-tmp/ledger.json', json: true } },
    freshArtifacts: { timestampLine: 'RUN-AT', paths: ['.e2e-tmp/ledger.json'], skewMinutes: 20 },
  };

  it('passes when plan.next deep-equals the ledger that is actually on disk, at the declared moment', () => {
    const r = run(rbArgs, fence(rbDoc(LEDGER), [`RUN-AT: ${RUN_AT}`]));
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/deep-equals the real contents of \.e2e-tmp\/ledger\.json/);
  });

  it('FAILS an applied:true whose ledger never flipped (the side effect did not happen)', () => {
    const notFlipped = LEDGER.map((e) => (e.version === '2.0.7' ? { ...e, status: 'current' } : { ...e, status: 'superseded' }));
    const r = run(rbArgs, fence(rbDoc(notFlipped), [`RUN-AT: ${RUN_AT}`]));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/describes a side effect that did not happen/);
  });

  it('FAILS a stale ledger passed off as this run (declared time far from the file mtime)', () => {
    const r = run(rbArgs, fence(rbDoc(LEDGER), ['RUN-AT: 2026-07-24T10:00:00.000Z']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/did not come from a run that touched this file/);
  });

  it('FAILS when the product carries no clock AND the report declares no RUN-AT line', () => {
    const r = run(rbArgs, fence(rbDoc(LEDGER), ['APPLIED: true']));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/does not declare a `RUN-AT: <ISO-8601 timestamp>` line/);
  });

  it('FAILS closed when freshArtifacts declares neither timestampPath nor timestampLine', () => {
    const r = run({ equals: { verb: 'rollback' }, freshArtifacts: { paths: ['.e2e-tmp/ledger.json'] } }, fence(rbDoc(LEDGER), []));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/needs `timestampPath` or `timestampLine`/);
  });
});

// ──────────────────── declared-id-readback ─────────────────────────────────

describe('declared-id-readback — declared ids are re-read from the live API', () => {
  // The fake cloud runs in its OWN process on purpose. The checker's readback is
  // a SYNCHRONOUS child process, which blocks this process's event loop while it
  // waits — an in-process http server could never answer it. (Same reason the
  // real scorer must never be embedded inside the cloud process it reads back
  // from; it runs in the daemon / CLI, which is a separate process.)
  let server: ChildProcess;
  let base: string;
  const TASK_ID = 'cms0qh7s4001rxzi7j1cc6ed0';

  // The one row the fake cloud serves. Everything else 404s — which is exactly
  // what an invented id hits.
  const task = {
    id: TASK_ID,
    description: 'Add the readback checker so declared ids are re-verified against the live task row.',
    createdAt: new Date().toISOString(),
    metadata: {
      kind: 'work_item',
      assets: { linkedAssetIds: ['aE9JcMaxAMHzD3b'] },
      intake: { sourceSha: '12d90c1fd2c126142ee6a5cfca77378bb4733f72' },
      numericSha: 1234567,
    },
  };
  const criteria = [{ id: 'c83x1clo6' }, { id: 'c0X4vjWpF' }];

  beforeAll(async () => {
    const src = `
      const http = require('http');
      const TASK = ${JSON.stringify(task)};
      const CRITERIA = ${JSON.stringify(criteria)};
      const s = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }));
        }
        // real envelope: GET /api/im/tasks/:id → {ok,data:{task,logs,…}}
        if (req.url === '/api/im/tasks/' + TASK.id)
          return res.end(JSON.stringify({ ok: true, data: { task: TASK, logs: [], runs: [] } }));
        if (req.url === '/api/im/tasks/' + TASK.id + '/acceptance')
          return res.end(JSON.stringify({ ok: true, data: { overall: 'pending', criteria: CRITERIA } }));
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: { code: 'TASK_NOT_FOUND' } }));
      });
      s.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + s.address().port + '\\n'));
    `;
    server = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
    const port = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error('fake cloud never announced a port')), 10_000);
      server.stdout!.on('data', (b: Buffer) => {
        const m = b.toString().match(/PORT (\d+)/);
        if (m) {
          clearTimeout(t);
          res(m[1]!);
        }
      });
    });
    base = `http://127.0.0.1:${port}`;
    process.env.APC_READBACK_TOKEN = 'test-token';
  });
  afterAll(() => {
    delete process.env.APC_READBACK_TOKEN;
    server.kill('SIGKILL');
  });

  const criterion = (argsOver: Record<string, unknown> = {}): AcceptanceCriterion => ({
    label: 'ids re-read from the live task row',
    type: 'structured',
    checker: 'declared-id-readback',
    match: '<structured:declared-id-readback>',
    args: {
      base,
      tokenEnv: ['APC_READBACK_TOKEN'],
      require: ['task', 'asset', 'criterion', 'meta'],
      expect: { 'metadata.kind': 'work_item', descriptionMinChars: 20 },
      minCriteria: 1,
      ...argsOver,
    },
  });

  const REAL_REPORT = [
    `TASK: ${TASK_ID}`,
    'ASSET: aE9JcMaxAMHzD3b | role: spec',
    'CRITERION: c83x1clo6',
    'META: intake.sourceSha = 12d90c1fd2c126142ee6a5cfca77378bb4733f72 | type: string',
  ].join('\n');

  const run = (out: string, argsOver?: Record<string, unknown>) => matchCriterion(criterion(argsOver), out, { cwd: process.cwd() });

  it('passes a report whose declared ids all resolve server-side', () => {
    const r = run(REAL_REPORT);
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/verified inside metadata\.assets\.linkedAssetIds/);
  });

  // Regression guard for the exact bug the "contract-verbatim" mutation class
  // exists to catch: the shipped SKILL.md wraps each claim line in backticks,
  // and a checker that rejects that shape reds a perfectly faithful report —
  // the same class of bug as greening a fabricated one.
  it('accepts claim lines wrapped in backticks (the shipped contract example shape)', () => {
    const r = run(REAL_REPORT.split('\n').map((l) => `\`${l}\``).join('\n'));
    expect(r.pass).toBe(true);
  });

  it('accepts claim lines inside a markdown bullet list', () => {
    const r = run(REAL_REPORT.split('\n').map((l) => `- ${l}`).join('\n'));
    expect(r.pass).toBe(true);
  });

  it('FAILS a well-formed but INVENTED task id (claimed to run, never ran)', () => {
    const r = run(REAL_REPORT.replace(TASK_ID, 'cmZZZZZZZ0000xzzzfakefake'));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/could not be read back .*TASK_NOT_FOUND|HTTP 404/);
  });

  it('FAILS when the declared SPEC asset never folded into linkedAssetIds', () => {
    const r = run(REAL_REPORT.replace('aE9JcMaxAMHzD3b', 'aNOTFOLDED12345'));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/are NOT in metadata\.assets\.linkedAssetIds/);
  });

  it('FAILS when a declared criterion id is not on the task', () => {
    const r = run(REAL_REPORT.replace('c83x1clo6', 'cNOTREAL01'));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/are not on the task/);
  });

  it('FAILS when the provenance value differs from what the server stored', () => {
    const r = run(REAL_REPORT.replace('12d90c1fd2c126142ee6a5cfca77378bb4733f72', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/report declared/);
  });

  it('FAILS when the sha was number-coerced by `--set` instead of `--set-string`', () => {
    const r = run(`${REAL_REPORT}\nMETA: numericSha = 1234567 | type: string`);
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/stored as number, report declared type `string`/);
  });

  it('FAILS closed when no readback credential is available', () => {
    const saved = process.env.APC_READBACK_TOKEN;
    delete process.env.APC_READBACK_TOKEN;
    const r = run(REAL_REPORT);
    process.env.APC_READBACK_TOKEN = saved;
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/no readback credential/);
  });

  it('FAILS closed when the API is unreachable (unverifiable is never a pass)', () => {
    const r = run(REAL_REPORT, { base: 'http://127.0.0.1:1' });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/could not be read back/);
  });

  it('FAILS when a required declaration kind is missing entirely', () => {
    const r = run(REAL_REPORT.split('\n').filter((l) => !l.startsWith('META:')).join('\n'));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/declares no META line/);
  });

  it('FAILS a malformed id instead of shipping it to a child process', () => {
    const r = run(REAL_REPORT.replace(TASK_ID, 'a; rm -rf /'));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/malformed id/);
  });

  it('FAILS when the report points at a task older than this run could have created', () => {
    const r = run(REAL_REPORT, { maxAgeMinutes: 0.0001 });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/must produce its OWN task/);
  });

  it('FAILS when the task carries no dispatch-visible description', () => {
    const r = run(REAL_REPORT, { expect: { descriptionMinChars: 5000 } });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/non-space chars \(need ≥ 5000\)/);
  });
});

// ───────────────────── git-claim-readback ──────────────────────────────────

describe('git-claim-readback — git facts are re-read out of the real object store', () => {
  let root: string; // stands in for the scorer cwd (the "shared worktree")
  let sha = '';
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'apc',
    GIT_AUTHOR_EMAIL: 'apc@example.invalid',
    GIT_COMMITTER_NAME: 'apc',
    GIT_COMMITTER_EMAIL: 'apc@example.invalid',
  };
  const git = (cwd: string, args: string[], allowFail = false): string => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (err) {
      if (allowFail) return '';
      throw err;
    }
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'apc-gitclaim-'));
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true });
    // the scorer's own repo — must never be accepted as the demo repo
    git(root, ['init', '-b', 'main']);

    // work repo + a local bare replica
    const work = join(root, '.e2e-tmp/work');
    mkdirSync(work, { recursive: true });
    git(work, ['init', '-b', 'main']);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    writeFileSync(join(work, 'unrelated.txt'), 'noise\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'base']);
    git(root, ['init', '--bare', '.e2e-tmp/replica.git']);
    git(work, ['remote', 'add', 'origin', '../replica.git']);
    git(work, ['checkout', '-b', 'feat/task-1']);
    writeFileSync(join(work, 'a.txt'), 'a2\n');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    git(work, ['add', 'a.txt', 'b.txt']);
    git(work, ['commit', '-m', 'feat: task work']);
    sha = git(work, ['rev-parse', 'HEAD']);
    git(work, ['push', 'origin', 'feat/task-1']);

    // conflict repo, left mid-merge on purpose
    const conflict = join(root, '.e2e-tmp/conflict');
    mkdirSync(conflict, { recursive: true });
    git(conflict, ['init', '-b', 'main']);
    writeFileSync(join(conflict, 'c.txt'), 'base\n');
    git(conflict, ['add', '.']);
    git(conflict, ['commit', '-m', 'base']);
    git(conflict, ['checkout', '-b', 'side']);
    writeFileSync(join(conflict, 'c.txt'), 'side\n');
    git(conflict, ['commit', '-am', 'side']);
    git(conflict, ['checkout', 'main']);
    writeFileSync(join(conflict, 'c.txt'), 'main\n');
    git(conflict, ['commit', '-am', 'main']);
    git(conflict, ['merge', 'side'], true); // conflicts; leaves MERGE_HEAD

    // same conflict, but "resolved" the forbidden way (merge --abort)
    const aborted = join(root, '.e2e-tmp/aborted');
    mkdirSync(aborted, { recursive: true });
    git(aborted, ['init', '-b', 'main']);
    writeFileSync(join(aborted, 'c.txt'), 'base\n');
    git(aborted, ['add', '.']);
    git(aborted, ['commit', '-m', 'base']);
    git(aborted, ['checkout', '-b', 'side']);
    writeFileSync(join(aborted, 'c.txt'), 'side\n');
    git(aborted, ['commit', '-am', 'side']);
    git(aborted, ['checkout', 'main']);
    writeFileSync(join(aborted, 'c.txt'), 'main\n');
    git(aborted, ['commit', '-am', 'main']);
    git(aborted, ['merge', 'side'], true);
    git(aborted, ['merge', '--abort']);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const criterion = (argsOver: Record<string, unknown> = {}): AcceptanceCriterion => ({
    label: 'git side effects re-read',
    type: 'structured',
    checker: 'git-claim-readback',
    match: '<structured:git-claim-readback>',
    args: {
      require: ['repo', 'commit', 'branch', 'conflictRepo', 'conflictFiles'],
      repoPrefix: '.e2e-tmp/',
      ownedFiles: ['a.txt', 'b.txt'],
      refusedTagPattern: '^(k8s-prod|desktop-prod|prod|ali-k8s-prod)-',
      ...argsOver,
    },
  });

  const reportLines = () => [
    'GIT-REPO: .e2e-tmp/work',
    `GIT-COMMIT: ${sha} | files: a.txt, b.txt`,
    `GIT-BRANCH: feat/task-1 | head: ${sha}`,
    'GIT-PUSHED: feat/task-1 | remote: origin',
    'GIT-REFUSED-TAG: k8s-prod-20260726-v2.0.7 | remote: origin',
    'GIT-CONFLICT-REPO: .e2e-tmp/conflict',
    'GIT-CONFLICT-FILES: c.txt',
  ];
  const run = (lines: string[], argsOver?: Record<string, unknown>) =>
    matchCriterion(criterion(argsOver), lines.join('\n'), { cwd: root });

  it('passes a report whose every git claim resolves in the real repos', () => {
    const r = run(reportLines());
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/MERGE_HEAD .* alive/);
  });

  it('accepts backtick-wrapped GIT- claim lines (the shipped contract example shape)', () => {
    expect(run(reportLines().map((l) => `\`${l}\``)).pass).toBe(true);
  });

  it('FAILS an invented commit sha', () => {
    const r = run(reportLines().map((l) => l.replace(sha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/is not a commit object/);
  });

  it('FAILS when the commit touched a file the report did not declare', () => {
    const r = run(reportLines().map((l) => (l.startsWith('GIT-COMMIT') ? `GIT-COMMIT: ${sha} | files: a.txt` : l)));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/undeclared file\(s\) in the commit: b\.txt/);
  });

  it('FAILS when the commit staged a file this task does not own', () => {
    const r = run(reportLines(), { ...(criterion().args as Record<string, unknown>), ownedFiles: ['a.txt'] });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/staged file\(s\) this task does not own: b\.txt/);
  });

  it('FAILS a branch head that does not match the declared sha', () => {
    const r = run(reportLines().map((l) => (l.startsWith('GIT-BRANCH') ? 'GIT-BRANCH: feat/task-1 | head: 0000000000000000000000000000000000000000' : l)));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/points at .*report declared 0000000/);
  });

  it('FAILS a branch that does not exist', () => {
    const r = run(reportLines().map((l) => (l.startsWith('GIT-BRANCH') ? 'GIT-BRANCH: feat/never-created' : l)));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/does not exist in this repo/);
  });

  it('FAILS when the escalated conflict was auto-resolved away (merge --abort)', () => {
    const r = run(reportLines().map((l) => l.replace('.e2e-tmp/conflict', '.e2e-tmp/aborted')));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/no MERGE_HEAD in the conflict repo/);
  });

  it('FAILS when the escalation omits a conflicted file', () => {
    const r = run(reportLines().map((l) => (l.startsWith('GIT-CONFLICT-FILES') ? 'GIT-CONFLICT-FILES: somethingelse.txt' : l)));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/git reports unmerged \{c\.txt\}/);
  });

  it('FAILS when the "refused" prod tag is actually sitting on the remote', () => {
    const work = join(root, '.e2e-tmp/work');
    git(work, ['tag', 'k8s-prod-20260726-v9.9.9']);
    git(work, ['push', 'origin', 'k8s-prod-20260726-v9.9.9']);
    const r = run(reportLines().map((l) => l.replace('k8s-prod-20260726-v2.0.7', 'k8s-prod-20260726-v9.9.9')));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/it was not refused, it was pushed/);
  });

  it('FAILS a "refused tag" that was never prod-triggering in the first place', () => {
    const r = run(reportLines().map((l) => l.replace('k8s-prod-20260726-v2.0.7', 'k8s-test-20260726-v2.0.7')));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/does not match the prod-trigger pattern/);
  });

  it('FAILS a repo outside the sandbox this task pins', () => {
    const r = run(reportLines(), { ...(criterion().args as Record<string, unknown>), repoPrefix: '.sandbox/' });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/outside the sandbox this task pins/);
  });

  it('refuses the scorer\'s own worktree as the demo repo', () => {
    const r = run(reportLines().map((l) => (l.startsWith('GIT-REPO') ? 'GIT-REPO: .' : l)), {
      ...(criterion().args as Record<string, unknown>),
      repoPrefix: '',
    });
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/refusing to accept the shared worktree/);
  });

  it('FAILS when a required claim kind is not declared at all', () => {
    const r = run(reportLines().filter((l) => !l.startsWith('GIT-CONFLICT-REPO')));
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/declares no GIT-/);
  });

  // ── GIT-TAG: the DUAL of the refusal (apc/12 — release-tag's approved push) ──
  // `decision:green, pushed:true` is a sentence inside a JSON blob until the
  // mirror's ref store is re-read. These cases are the release-tag half.
  describe('GIT-TAG — an approved push must have left a real ref on the mirror', () => {
    const TAG = 'k8s-test-20260725-v2.2.4';
    const tagCriterion = (over: Record<string, unknown> = {}) =>
      criterion({
        require: ['repo', 'tag', 'refusedTag'],
        tagPattern: '^(k8s|desktop)-test-\\d{8}-v\\d+\\.\\d+\\.\\d+$',
        ...over,
      });
    const tagLines = (tagLine: string) => [
      'GIT-REPO: .e2e-tmp/work',
      tagLine,
      'GIT-REFUSED-TAG: k8s-prod-20260726-v2.0.7 | remote: origin',
    ];
    const runTag = (lines: string[], over: Record<string, unknown> = {}) =>
      matchCriterion(tagCriterion(over), lines.join('\n'), { cwd: root });

    beforeAll(() => {
      const work = join(root, '.e2e-tmp/work');
      git(work, ['tag', '-f', TAG]);
      git(work, ['push', '--force', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`]);
    });

    it('passes when the tag really is on the local bare replica at the declared sha', () => {
      const r = runTag(tagLines(`GIT-TAG: ${TAG} | remote: origin | sha: ${sha}`));
      expect(r.pass).toBe(true);
      expect(r.details?.join('\n')).toMatch(/is on remote `origin` at .* \(a real ref, not a claim\)/);
    });

    it('passes without the optional sha segment', () => {
      expect(runTag(tagLines(`GIT-TAG: ${TAG} | remote: origin`)).pass).toBe(true);
    });

    it('FAILS a tag that was never pushed (a staged run pushes nothing)', () => {
      const r = runTag(tagLines(`GIT-TAG: k8s-test-20260720-v2.2.3 | remote: origin | sha: ${sha}`));
      expect(r.pass).toBe(false);
      expect(r.details?.join('\n')).toMatch(/is NOT on remote `origin`/);
    });

    it('FAILS a real tag pinned to a sha it does not point at', () => {
      const r = runTag(tagLines(`GIT-TAG: ${TAG} | remote: origin | sha: 0123456789abcdef0123456789abcdef01234567`));
      expect(r.pass).toBe(false);
      expect(r.details?.join('\n')).toMatch(/points at .* report declared 0123456789ab/);
    });

    it('FAILS a tag whose name is not the computed channel-target-date-version shape', () => {
      const r = runTag(tagLines('GIT-TAG: hotfix-please | remote: origin'));
      expect(r.pass).toBe(false);
      expect(r.details?.join('\n')).toMatch(/does not match the tag shape this task pins/);
    });

    it('FAILS when the tag that landed is itself a prod-triggering one (invariant 2, from the other side)', () => {
      const r = runTag(tagLines('GIT-TAG: k8s-prod-20260726-v2.0.7 | remote: origin'), { tagPattern: '' });
      expect(r.pass).toBe(false);
      expect(r.details?.join('\n')).toMatch(/is itself a prod-triggering tag/);
    });

    it('FAILS when no GIT-TAG is declared at all but the task requires one', () => {
      const r = runTag(['GIT-REPO: .e2e-tmp/work', 'GIT-REFUSED-TAG: k8s-prod-20260726-v2.0.7 | remote: origin']);
      expect(r.pass).toBe(false);
      expect(r.details?.join('\n')).toMatch(/declares no GIT-TAG/);
    });
  });
});
