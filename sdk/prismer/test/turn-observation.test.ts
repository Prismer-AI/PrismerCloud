import { expect, it } from 'vitest';
import { parseTurnEnvelope, parseTurnResult } from '../src/turn/protocol.js';
import { runTurnOnce } from '../src/turn/runner.js';

it('does not invent a provider request timestamp when session initialization fails', async () => {
  const result = await runTurnOnce(parseTurnEnvelope({ protocolVersion: 2, turnId: 'init-failed',
    message: { text: 'test' }, history: [], systemPrompt: '', workdir: '/tmp', deadlineMs: 1000, cancelFile: '/tmp/no-cancel' }),
  { protocolVersion: 2, url: 'http://unused.invalid', token: 'private-token', model: 'test', provider: 'test' },
  { createSession: async () => { throw new Error('init failed'); } });
  expect(result.status).toBe('error');
  expect(result.spans).toEqual({ t7: null, t8: null });
  expect(result.observation?.modelCalls).toEqual([]);
  expect(result.observation?.sessionInitMs).toBeNull();
});

it.each([false, true])('retains call usage and measured init time on failure=%s without inventing first text', async failed => {
  let notify: (event: any) => void = () => undefined;
  const result = await runTurnOnce(parseTurnEnvelope({ protocolVersion: 2, turnId: 'observed',
    message: { text: 'test' }, history: [], systemPrompt: '', workdir: '/tmp', deadlineMs: 1000, cancelFile: '/tmp/no-cancel' }),
  { protocolVersion: 2, url: 'http://unused.invalid', token: 'private-token', model: 'test', provider: 'test' }, {
    createSession: async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return {
        subscribe: cb => { notify = cb; return () => undefined; },
        run: async () => {
          notify({ type: 'model_request_started', startedAt: 1234 });
          notify({ type: 'model_call_observed', call: { sequence: 1, source: 'pi-engine', provider: 'test', model: 'test',
            startedAt: 1234, durationMs: 12, firstTextMs: null, status: failed ? 'failed' : 'completed',
            usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, cacheWriteTokens: 4 } } });
          if (failed) throw new Error('provider failed');
          return { finalText: 'done', timeline: [] };
        }, interrupt: async () => {}, close: async () => {},
      };
    },
  });
  expect(result.status).toBe(failed ? 'error' : 'ok');
  expect(result.spans).toEqual({ t7: 1234, t8: null });
  const observation = (result as any).observation;
  expect(observation).toMatchObject({ version: 1, source: 'runtime', modelCalls: [{ usage: { cacheWriteTokens: 4 } }] });
  expect(observation.sessionInitMs).toBeGreaterThanOrEqual(10);
  expect(observation.totalMs).toBeGreaterThanOrEqual(observation.sessionInitMs);
  expect(parseTurnResult(JSON.parse(JSON.stringify(result)))).toMatchObject({ observation });
  expect(JSON.stringify(observation)).not.toContain('private-token');
  const untrusted = JSON.parse(JSON.stringify(result));
  untrusted.observation.secret = 'must-not-survive';
  untrusted.observation.modelCalls[0].prompt = 'must-not-survive';
  untrusted.observation.modelCalls[0].usage.apiKey = 'must-not-survive';
  expect(JSON.stringify(parseTurnResult(untrusted))).not.toContain('must-not-survive');
});
