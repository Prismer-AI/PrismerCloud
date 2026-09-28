// Run after installing the tarball and wheel in isolated customer directories:
// node scripts/verify-installed-environment.mjs <npm-directory> <venv-python>
// This is a local HTTP contract fixture, not a live Cloud/Runtime acceptance gate.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [installDir, python] = process.argv.slice(2);
assert(installDir && python, 'Provide installed npm directory and venv Python');
const run = promisify(execFile);
const config = await mkdtemp(join(tmpdir(), 'eaas-installed-config-'));
const requests = [];
const key = 'sk-eaas-installed-contract-fixture';
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const url = new URL(req.url, 'http://fixture');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });
    let data;
    if (url.pathname === '/api/v1/context') data = { project: { id: 'fixture-project' }, defaults: {} };
    else if (url.pathname === '/api/v1/environments' && req.method === 'POST') {
      assert([{}, { profile: '4c8g' }, { poolId: 'configured-pool', ttlSeconds: 600 }]
        .some(expected => isDeepStrictEqual(body, expected)), 'Unexpected create defaults/profile payload');
      assert(req.headers['idempotency-key']);
      data = { environmentId: 'env/a', state: 'pending' };
    } else if (url.pathname.endsWith('/access-sessions') && req.method === 'POST') {
      assert.equal(body.subject, 'user-42');
      assert(req.headers['idempotency-key']);
      data = { sessionId: 'session/1', token: 'ps-eaas-fixture-secret', expiresAt: '2026-09-25T00:00:00Z' };
    } else if (url.pathname.endsWith('/access-sessions')) {
      const start = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor').slice(5)) : 0;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      assert(Number.isInteger(start) && start >= 0);
      const end = Math.min(101, start + limit);
      data = { sessions: Array.from({ length: end - start }, (_, i) => ({ id: `session-${start + i}` })), nextCursor: end < 101 ? `page/${end}` : null };
    } else if (url.pathname.endsWith('/revoke')) data = { id: 'session/1', revokedAt: '2026-09-24T00:00:00Z' };
    else throw new Error(`Unexpected request: ${req.method} ${url.pathname}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data, requestId: 'fixture' }));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ success: false, error: { code: 'invalid_request', message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, PRISMER_API_KEY: key, PRISMER_BASE_URL: `http://127.0.0.1:${server.address().port}`, PRISMER_HOME: config };
delete env.PYTHONPATH;
const options = { cwd: resolve(installDir), env, timeout: 30000 };
try {
  await run(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { PrismerClient } = require('@prismer/sdk');
    (async () => {
      const c = new PrismerClient({ apiKey: process.env.PRISMER_API_KEY, baseUrl: process.env.PRISMER_BASE_URL });
      assert((await c.environments.create({})).success);
      assert((await c.environments.create({ profile: '4c8g' })).success);
      assert((await c.eaas.context()).success);
      const issued = await c.environments.issueAccessSession('env/a', { subject: 'user-42' });
      assert.equal(issued.data.token, 'ps-eaas-fixture-secret');
      const ids = []; let cursor;
      do {
        const page = await c.environments.listAccessSessions('env/a', { limit: 50, cursor });
        assert(page.success); ids.push(...page.data.sessions.map(s => s.id)); cursor = page.data.nextCursor;
      } while (cursor);
      assert.equal(ids.length, 101); assert.equal(new Set(ids).size, 101);
      assert((await c.environments.listAccessSessions('env/a')).success);
      assert((await c.environments.revokeAccessSession('env/a', issued.data.sessionId)).success);
    })().catch(e => { console.error(e); process.exit(1); });
  `], options);
  await run(resolve(python), ['-c', `
import asyncio, os
from prismer import PrismerClient, AsyncPrismerClient
from prismer.types import EnvironmentCreateSpec
opts = dict(api_key=os.environ['PRISMER_API_KEY'], base_url=os.environ['PRISMER_BASE_URL'])
with PrismerClient(**opts) as c:
    assert c.environments.create({})['success']
    assert c.environments.create(EnvironmentCreateSpec(profile='4c8g'))['success']
    assert c.eaas.context()['success']
    issued = c.environments.issue_access_session('env/a', {'subject': 'user-42'})
    assert issued['data']['token'] == 'ps-eaas-fixture-secret'
    ids, cursor = [], None
    while True:
        page = c.environments.list_access_sessions('env/a', limit=50, cursor=cursor)['data']
        ids.extend(s['id'] for s in page['sessions'])
        cursor = page['nextCursor']
        if not cursor: break
    assert len(ids) == len(set(ids)) == 101
    assert c.environments.list_access_sessions('env/a')['success']
    assert c.environments.revoke_access_session('env/a', issued['data']['sessionId'])['success']
async def main():
    async with AsyncPrismerClient(**opts) as c:
        assert (await c.environments.create({}))['success']
        assert (await c.environments.create(EnvironmentCreateSpec(profile='4c8g')))['success']
        assert (await c.eaas.context())['success']
        issued = await c.environments.issue_access_session('env/a', {'subject': 'user-42'})
        ids, cursor = [], None
        while True:
            page = (await c.environments.list_access_sessions('env/a', limit=50, cursor=cursor))['data']
            ids.extend(s['id'] for s in page['sessions'])
            cursor = page['nextCursor']
            if not cursor: break
        assert len(ids) == len(set(ids)) == 101
        assert (await c.environments.list_access_sessions('env/a'))['success']
        assert (await c.environments.revoke_access_session('env/a', issued['data']['sessionId']))['success']
asyncio.run(main())
  `], options);
  const cli = async (...args) => run(join(resolve(installDir), 'node_modules/.bin/cloud'), ['environment', ...args, '--json'], options);
  assert.equal(JSON.parse((await cli('context')).stdout).project.id, 'fixture-project');
  assert.equal(JSON.parse((await cli('create')).stdout).environmentId, 'env/a');
  assert.equal(JSON.parse((await cli('create', '--profile', '4c8g')).stdout).environmentId, 'env/a');
  assert.equal(JSON.parse((await cli('create', '--pool', 'configured-pool', '--ttl', '600')).stdout).environmentId, 'env/a');
  const issued = await cli('access-session', 'issue', 'env/a', '--subject', 'user-42', '--idempotency-key', 'cli-1');
  assert(!issued.stdout.includes('ps-eaas-fixture-secret'));
  const revealed = await cli('access-session', 'issue', 'env/a', '--subject', 'user-42', '--idempotency-key', 'cli-1', '--show-token');
  assert.equal(JSON.parse(revealed.stdout).token, 'ps-eaas-fixture-secret');
  assert(revealed.stderr.includes('Sensitive'));
  const ids = []; let cursor;
  do {
    const page = JSON.parse((await cli('access-session', 'list', 'env/a', '--limit', '50', ...(cursor ? ['--cursor', cursor] : []))).stdout);
    ids.push(...page.sessions.map(s => s.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 101); assert.equal(new Set(ids).size, 101);
  assert.equal(JSON.parse((await cli('access-session', 'revoke', 'env/a', 'session/1')).stdout).id, 'session/1');
  const creates = requests.filter(r => r.method === 'POST' && r.path === '/api/v1/environments');
  assert.equal(creates.filter(r => isDeepStrictEqual(r.body, {})).length, 4);
  assert.equal(creates.filter(r => isDeepStrictEqual(r.body, { profile: '4c8g' })).length, 4);
  assert.equal(creates.filter(r => isDeepStrictEqual(r.body, { poolId: 'configured-pool', ttlSeconds: 600 })).length, 1);
  console.log(JSON.stringify({ passed: true, evidence: 'installed packages against local HTTP contract fixture', clients: ['TS', 'Python sync', 'Python async', 'cloud CLI'], sessionsPerClient: 101, explicitProfileClients: 4, implicitProfileInjection: false, requests: requests.length }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(config, { recursive: true, force: true });
}
