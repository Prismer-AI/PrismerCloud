import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runDemo } from '../examples/eaas-single-key.mjs';

const ok = data => ({ success: true, data });
function fixture(overrides = {}) {
  const calls = [];
  const client = {
    eaas: { context: async () => ok({ credential: { kind: 'machine' } }) },
    environments: {
      create: async body => { calls.push(['create', body]); return ok({ environmentId: 'env-demo' }); },
      waitUntilReady: async () => ({ readiness: { services: true } }),
      createConversation: async () => ok({ conversationId: 'conversation-demo' }),
      sendMessage: async () => ok({ runId: 'run-demo', messageId: 'question' }),
      getRun: async () => ok({ runId: 'run-demo', status: 'completed', message: { messageId: 'question' } }),
      listMessages: async () => ok({ messages: [{ id: 'question', role: 'principal', content: 'Hello' }, { id: 'reply', role: 'agent', content: 'Actual reply' }], truncated: false }),
      delete: async id => { calls.push(['delete', id]); return ok({ operationId: 'delete-op' }); },
      get: async () => ({ success: false, error: { code: 'not_owned' } }),
      ...overrides,
    },
  };
  return { client, calls };
}

test('uses server defaults and returns only the completed run reply, then deletes', async () => {
  const { client, calls } = fixture();
  const result = await runDemo(client, { pollMs: 0 });
  assert.equal(result.reply, 'Actual reply');
  assert.deepEqual(calls, [['create', {}], ['delete', 'env-demo']]);
  assert.equal(result.cleanup, 'api-deleted');
});

test('failed agent is not a successful demo and still cleans up', async () => {
  const { client, calls } = fixture({ getRun: async () => ok({ status: 'failed' }) });
  await assert.rejects(runDemo(client), /failed/);
  assert.deepEqual(calls.at(-1), ['delete', 'env-demo']);
});

test('completed run without its question in the fresh conversation fails', async () => {
  const { client } = fixture({ listMessages: async () => ok({ messages: [{ id: 'other', role: 'agent', content: 'stale' }], truncated: false }) });
  await assert.rejects(runDemo(client), /reply/);
});

test('cleanup failure cannot produce a green result', async () => {
  const { client } = fixture({ delete: async () => ({ success: false, error: { code: 'provider_unavailable' } }) });
  await assert.rejects(runDemo(client), /provider_unavailable/);
});

test('run timeout fails and cleans up', async () => {
  const { client, calls } = fixture({ getRun: async () => ok({ status: 'running' }) });
  await assert.rejects(runDemo(client, { timeoutMs: 0, pollMs: 0 }), /timeout/);
  assert.deepEqual(calls.at(-1), ['delete', 'env-demo']);
});

test('blocked creation does not attempt deleting an unknown environment', async () => {
  const { client, calls } = fixture({ create: async () => ({ success: false, error: { code: 'provider_unavailable' } }) });
  await assert.rejects(runDemo(client), /provider_unavailable/);
  assert.deepEqual(calls, []);
});

test('preserves the SDK error for diagnosing a rejected create', async () => {
  const error = { code: 'provider_unavailable', message: 'activated platform configuration expired', details: { reason: 'expired' } };
  const { client } = fixture({ create: async () => ({ success: false, error }) });
  await assert.rejects(runDemo(client), failure => {
    assert.match(failure.message, /activated platform configuration expired/);
    assert.deepEqual(failure.cause, error);
    return true;
  });
});

test('a progress callback failure after creation still deletes the known environment', async () => {
  const { client, calls } = fixture();
  await assert.rejects(runDemo(client, { progress: entry => {
    if (entry.stage === 'created') throw new Error('log sink failed');
  } }), /log sink failed/);
  assert.deepEqual(calls.at(-1), ['delete', 'env-demo']);
});
