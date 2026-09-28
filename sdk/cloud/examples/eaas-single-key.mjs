// Standalone server-side example. Install @prismer/sdk in the consuming project.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

function data(result) {
  if (!result.success) {
    const { code, message } = result.error;
    throw new Error(message ? `${code}: ${message}` : code, { cause: result.error });
  }
  return result.data;
}

export async function runDemo(client, {
  prompt = 'Reply with a brief greeting.', timeoutMs = 300_000, pollMs = 1500,
  progress = () => {},
} = {}) {
  const context = data(await client.eaas.context());
  assert.equal(context.credential.kind, 'machine', 'Use a project API key, not an operator credential');
  const requestId = randomUUID();
  // Keep this key in logs: an uncertain CREATE must be reconciled, never blindly retried.
  progress({ stage: 'create', idempotencyKey: requestId });
  const created = data(await client.environments.create({}, { idempotencyKey: requestId }));
  const id = created.environmentId;
  assert(id, 'CREATE did not return environmentId');
  let outcome;
  let failure;
  try {
    progress({ stage: 'created', environmentId: id });
    await client.environments.waitUntilReady(id, { capability: 'services', timeoutMs, pollMs });
    const conversation = data(await client.environments.createConversation(id));
    const sent = data(await client.environments.sendMessage(id, conversation.conversationId, { content: prompt }));
    progress({ stage: 'agent', environmentId: id, runId: sent.runId });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = data(await client.environments.getRun(id, sent.runId));
      if (run.status === 'completed') {
        assert.equal(run.message.messageId, sent.messageId, 'Run does not belong to the sent message');
        break;
      }
      if (['failed', 'canceled', 'awaiting_input'].includes(run.status)) throw new Error(`Agent run: ${run.status}`);
      if (Date.now() >= deadline) throw new Error('Agent run timeout');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    const messages = data(await client.environments.listMessages(id, conversation.conversationId, { limit: 100 }));
    assert(!messages.truncated, 'reply history truncated');
    assert(messages.messages.some(message => message.id === sent.messageId), 'reply history missing sent message');
    const replies = messages.messages.filter(message => message.role === 'agent' && message.content?.trim());
    assert(replies.length, 'Completed run has no agent reply');
    outcome = { environmentId: id, runId: sent.runId, reply: replies.map(message => message.content).join('\n') };
  } catch (error) {
    failure = error;
  }
  try {
    const deletion = data(await client.environments.delete(id));
    const after = await client.environments.get(id);
    assert(!after.success && after.error.code === 'not_owned', 'Environment still visible after DELETE');
    // API tombstone is not proof of physical provider cleanup.
    progress({ stage: 'api-deleted', environmentId: id, operationId: deletion.operationId });
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], `Demo and cleanup failed for ${id}`);
    throw cleanupError;
  }
  if (failure) throw failure;
  return { ...outcome, cleanup: 'api-deleted' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.env.PRISMER_API_KEY, 'Set PRISMER_API_KEY');
    assert(process.env.PRISMER_BASE_URL, 'Set PRISMER_BASE_URL to your local or test deployment');
    const url = new URL(process.env.PRISMER_BASE_URL);
    assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'Use HTTPS outside localhost');
    const require = createRequire(resolve(process.cwd(), 'package.json'));
    const { PrismerClient } = require('@prismer/sdk');
    const client = new PrismerClient({ apiKey: process.env.PRISMER_API_KEY, baseUrl: url.origin, timeout: 120_000 });
    const result = await runDemo(client, { progress: entry => console.log(JSON.stringify(entry)) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof AggregateError ? error.errors.map(e => e.message).join('; ') : error.message);
    process.exitCode = 1;
  }
}
