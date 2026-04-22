/**
 * Integration test: FS RPC relay path (P7 × Cloud Relay, v1.9.0).
 *
 * Wires the RelayClient's rpc.request/rpc.response handler to an in-memory
 * transport and verifies that FS handlers registered via fs-rpc.ts round-trip
 * correctly. No network — we fake the WebSocket with a typed pair of queues.
 *
 * The full path covered:
 *
 *   mobile → Cloud /bindings/:id/fs/read
 *          → RelayService.sendDaemonRequest  (cloud side)
 *          → WebSocket frame 'rpc.request'
 *          → RelayClient.handleControlMessage ('rpc.request')
 *          → registered fs.read handler
 *          → fsRead() from @prismer/sandbox-runtime
 *          → reply 'rpc.response'
 *          → Cloud promise resolves
 *          → HTTP 200 back to mobile
 *
 * We can't wire the WS endpoints without a full daemon + cloud stack, so this
 * test exercises the two halves (RelayClient message dispatch, and the fs-rpc
 * handler bindings) plus a round-trip fake that proves the contract is
 * symmetric.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { RelayClient } from '../src/relay-client.js';
import { registerFsRpcHandlers } from '../src/http/fs-rpc.js';
import type { FsContext } from '@prismer/sandbox-runtime';

/** Minimal WebSocket stand-in exposing the surface RelayClient uses for
 *  sending responses. readyState=1 = OPEN so `send()` is exercised. */
class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

/** Spin up a RelayClient with a fake WS attached to its controlWs slot.
 *  The ctor requires apiKey/daemonId/userId but does NOT auto-connect when we
 *  never call .connect(), so we can inject directly. */
function makeRelayClient(): { client: RelayClient; fakeWs: FakeWebSocket } {
  const client = new RelayClient({
    apiKey: 'sk-test',
    daemonId: 'test-daemon',
    userId: 'u1',
    autoReconnect: false,
    // relayUrl is required by ctor validation since commit 741f49d; we never
    // call .connect() in these tests (controlWs is injected directly), so the
    // `.invalid` TLD is safe and makes intent explicit.
    relayUrl: 'wss://relay.test.invalid',
  });
  const fakeWs = new FakeWebSocket();
  (client as any).controlWs = fakeWs as unknown as WebSocket;
  return { client, fakeWs };
}

describe('RelayClient RPC dispatcher', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-rpc-ws-'));
    // Resolve symlinks (macOS /tmp → /private/tmp) so sandbox-runtime's
    // workspace boundary check sees paths inside the sandbox.
    workspace = fs.realpathSync(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('dispatches rpc.request to registered handler and sends rpc.response', async () => {
    const { client, fakeWs } = makeRelayClient();
    client.registerRpcHandler('echo', async (params) => ({ got: params }));

    // Simulate cloud sending rpc.request over the control channel
    const req = { type: 'rpc.request', rpcId: 'r1', method: 'echo', params: { a: 1 } };
    (client as any).handleControlMessage(Buffer.from(JSON.stringify(req), 'utf-8'));

    // Give the async handler one tick to resolve
    await new Promise((r) => setTimeout(r, 50));

    // RelayClient should have written back a single rpc.response
    expect(fakeWs.sent).toHaveLength(1);
    const resp = JSON.parse(fakeWs.sent[0]);
    expect(resp.type).toBe('rpc.response');
    expect(resp.rpcId).toBe('r1');
    expect(resp.result).toEqual({ got: { a: 1 } });
    expect(resp.error).toBeUndefined();
  });

  it('unknown method → rpc.response with error field', async () => {
    const { client, fakeWs } = makeRelayClient();
    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'r2',
      method: 'nope',
      params: {},
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    const resp = JSON.parse(fakeWs.sent[0]);
    expect(resp.rpcId).toBe('r2');
    expect(resp.error).toMatch(/unknown rpc method/);
    expect(resp.result).toBeUndefined();
  });

  it('handler throw → rpc.response with error field', async () => {
    const { client, fakeWs } = makeRelayClient();
    client.registerRpcHandler('boom', async () => {
      throw new Error('kapow');
    });
    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'r3',
      method: 'boom',
      params: {},
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    const resp = JSON.parse(fakeWs.sent[0]);
    expect(resp.error).toBe('kapow');
  });

  it('malformed rpc.request (missing rpcId) is dropped silently', async () => {
    const { client, fakeWs } = makeRelayClient();
    client.registerRpcHandler('x', async () => 'ok');
    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      method: 'x',
      params: {},
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeWs.sent).toHaveLength(0);
  });
});

describe('fs-rpc handlers × sandbox-runtime', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-rpc-'));
    workspace = fs.realpathSync(workspace);
    fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello world', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function fsContext(): FsContext {
    return {
      agentId: 'a1',
      workspace,
      mode: 'default',
      rules: [{ source: 'session', behavior: 'allow', value: { tool: '*' } }],
      // Leave callPath unset; fs-rpc.ts forces 'relay' before calling fsRead etc.
    } as FsContext;
  }

  it('fs.read round-trips through the rpc dispatch', async () => {
    const { client, fakeWs } = makeRelayClient();
    registerFsRpcHandlers(client, { fsContextProvider: fsContext });

    const filePath = path.join(workspace, 'hello.txt');
    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'fs-1',
      method: 'fs.read',
      params: { agentId: 'a1', path: filePath },
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeWs.sent).toHaveLength(1);
    const resp = JSON.parse(fakeWs.sent[0]);
    expect(resp.rpcId).toBe('fs-1');
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
    expect((resp.result as any).content).toBe('hello world');
  });

  it('fs.write then fs.read — full round-trip', async () => {
    const { client, fakeWs } = makeRelayClient();
    registerFsRpcHandlers(client, { fsContextProvider: fsContext });

    const filePath = path.join(workspace, 'new.txt');

    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'w-1',
      method: 'fs.write',
      params: { agentId: 'a1', path: filePath, content: 'via rpc' },
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));

    const writeResp = JSON.parse(fakeWs.sent[0]);
    expect(writeResp.error).toBeUndefined();

    // The handler actually wrote to disk
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('via rpc');

    // Clear sent buffer, do a read
    fakeWs.sent = [];
    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'r-1',
      method: 'fs.read',
      params: { agentId: 'a1', path: filePath },
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    const readResp = JSON.parse(fakeWs.sent[0]);
    expect((readResp.result as any).content).toBe('via rpc');
  });

  it('missing agentId → error response (input validation at rpc boundary)', async () => {
    const { client, fakeWs } = makeRelayClient();
    registerFsRpcHandlers(client, { fsContextProvider: fsContext });

    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'bad',
      method: 'fs.read',
      params: { path: '/x' },     // no agentId
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    const resp = JSON.parse(fakeWs.sent[0]);
    expect(resp.error).toMatch(/agentId required/);
  });

  it('fs.list exposes files under workspace', async () => {
    const { client, fakeWs } = makeRelayClient();
    registerFsRpcHandlers(client, { fsContextProvider: fsContext });

    (client as any).handleControlMessage(Buffer.from(JSON.stringify({
      type: 'rpc.request',
      rpcId: 'ls',
      method: 'fs.list',
      params: { agentId: 'a1', path: workspace },
    }), 'utf-8'));
    await new Promise((r) => setTimeout(r, 50));
    const resp = JSON.parse(fakeWs.sent[0]);
    expect(resp.error).toBeUndefined();
    // fs.list returns an array or { entries: [...] } depending on impl.
    const data = resp.result as any;
    const names = Array.isArray(data) ? data.map((e: any) => e.name ?? e.path) : (data.entries ?? []).map((e: any) => e.name ?? e.path);
    expect(names.some((n: string) => n.endsWith('hello.txt'))).toBe(true);
  });
});
