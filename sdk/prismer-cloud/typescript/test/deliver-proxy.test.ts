/**
 * Unit tests for the file-delivery proxy detection (release202/09 P2 + P5#1).
 *
 * Focus: `detectDeliverProxy()` resolution — env-based activation (spawn
 * adapters) AND the new args-fallback that activates the proxy on hermes, whose
 * gateway has NO per-dispatch env (ids ride the <execution_context> XML and the
 * agent passes them as --run-id / --conversation-id / --daemon-port flags).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectDeliverProxy, proxyDeliver, type DeliverProxyContext } from '../src/commands/deliver-proxy';

const DISPATCH_ENV = [
  'PRISMER_TASK_ID',
  'PRISMER_RUN_ID',
  'PRISMER_DAEMON_PORT',
  'PRISMER_CONVERSATION_ID',
  'PRISMER_AGENT_USERNAME',
];

describe('detectDeliverProxy', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of DISPATCH_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of DISPATCH_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns null when no task/run id is resolvable from flags or env', () => {
    expect(detectDeliverProxy()).toBeNull();
    expect(detectDeliverProxy({})).toBeNull();
    // a conversation id alone (no run/task id) must NOT activate the proxy
    expect(detectDeliverProxy({ conversationId: 'conv-1' })).toBeNull();
  });

  it('activates from env (spawn adapters — claude-code / codex)', () => {
    process.env.PRISMER_TASK_ID = 'task-env';
    process.env.PRISMER_DAEMON_PORT = '3300';
    process.env.PRISMER_CONVERSATION_ID = 'conv-env';
    process.env.PRISMER_AGENT_USERNAME = 'ceo';
    const ctx = detectDeliverProxy();
    expect(ctx).not.toBeNull();
    expect(ctx!.taskId).toBe('task-env');
    expect(ctx!.daemonUrl).toBe('http://127.0.0.1:3300');
    expect(ctx!.conversationId).toBe('conv-env');
    expect(ctx!.agentUsername).toBe('ceo');
  });

  it('activates from --run-id when env is ABSENT (hermes path)', () => {
    // No PRISMER_TASK_ID / PRISMER_RUN_ID in env at all.
    const ctx = detectDeliverProxy({
      runId: 'run-from-xml',
      conversationId: 'conv-from-xml',
      daemonPort: '3210',
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.taskId).toBe('run-from-xml');
    expect(ctx!.daemonUrl).toBe('http://127.0.0.1:3210');
    expect(ctx!.conversationId).toBe('conv-from-xml');
  });

  it('defaults daemon port to 3210 when neither flag nor env is set', () => {
    const ctx = detectDeliverProxy({ runId: 'run-1' });
    expect(ctx!.daemonUrl).toBe('http://127.0.0.1:3210');
  });

  it('explicit flag WINS over env for each field', () => {
    process.env.PRISMER_TASK_ID = 'task-env';
    process.env.PRISMER_DAEMON_PORT = '3300';
    process.env.PRISMER_CONVERSATION_ID = 'conv-env';
    const ctx = detectDeliverProxy({
      runId: 'run-flag',
      conversationId: 'conv-flag',
      daemonPort: '3999',
    });
    expect(ctx!.taskId).toBe('run-flag');
    expect(ctx!.daemonUrl).toBe('http://127.0.0.1:3999');
    expect(ctx!.conversationId).toBe('conv-flag');
  });

  it('falls back to env per-field when a flag is omitted', () => {
    process.env.PRISMER_DAEMON_PORT = '3300';
    process.env.PRISMER_CONVERSATION_ID = 'conv-env';
    // only run-id passed as flag; port + conversation come from env
    const ctx = detectDeliverProxy({ runId: 'run-flag' });
    expect(ctx!.taskId).toBe('run-flag');
    expect(ctx!.daemonUrl).toBe('http://127.0.0.1:3300');
    expect(ctx!.conversationId).toBe('conv-env');
  });

  it('treats taskId alias the same as runId', () => {
    const ctx = detectDeliverProxy({ taskId: 'task-flag' });
    expect(ctx!.taskId).toBe('task-flag');
  });
});

describe('proxyDeliver mode:message-attach (release202/09 P5#3 / A2)', () => {
  const ctx: DeliverProxyContext = {
    daemonUrl: 'http://127.0.0.1:3210',
    taskId: 'run-1',
    agentUsername: 'ceo',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts taskId/path/mode + conversationId + messageId to /local/deliver', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, assetId: 'asset-1' }), { status: 200 });
      }),
    );
    const result = await proxyDeliver(ctx, '/tmp/addendum.pdf', 'message-attach', 'conv-9', 'msg-existing');
    expect(result.ok).toBe(true);
    expect(result.assetId).toBe('asset-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:3210/local/deliver');
    expect(calls[0]!.body).toMatchObject({
      mode: 'message-attach',
      conversationId: 'conv-9',
      messageId: 'msg-existing',
      agentUsername: 'ceo',
    });
    // path is resolved to absolute.
    expect(calls[0]!.body.path).toMatch(/addendum\.pdf$/);
  });

  it('rejects message-attach with no messageId (400, no fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await proxyDeliver(ctx, '/tmp/x.pdf', 'message-attach', 'conv-9');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to ctx.conversationId when none passed positionally', async () => {
    const calls: Array<{ body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, assetId: 'a' }), { status: 200 });
      }),
    );
    const ctxWithConv: DeliverProxyContext = { ...ctx, conversationId: 'conv-ctx' };
    const result = await proxyDeliver(ctxWithConv, '/tmp/x.pdf', 'message-attach', undefined, 'msg-1');
    expect(result.ok).toBe(true);
    expect(calls[0]!.body.conversationId).toBe('conv-ctx');
  });
});
