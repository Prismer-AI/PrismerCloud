/**
 * Integration test: full Cloud ↔ Daemon FS relay round-trip.
 *
 * This wires the two halves together via a shared fake bidirectional pipe:
 *
 *   [Cloud RelayService]
 *     .sendDaemonRequest()  → sends 'rpc.request' frame
 *                            → pipe forwards to daemon side
 *   [Daemon RelayClient]
 *     .handleControlMessage('rpc.request') → dispatches fs-rpc handler
 *                                          → sends 'rpc.response' frame
 *                            → pipe forwards to cloud side
 *   [Cloud RelayService]
 *     .handleDaemonRpcResponse() resolves pending promise with result
 *
 * If any link in this chain has a contract mismatch (wrong field name,
 * wrong message type, wrong payload shape), this test fails.
 *
 * The RelayService lives in src/im/services — we'd import it but that pulls
 * Prisma / Redis / pino. For focused integration we reimplement a minimal
 * cloud-side RPC dispatcher that mirrors RelayService's logic. The real
 * RelayService is tested in src/im/tests/relay-rpc.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { RelayClient } from '../src/relay-client.js';
import { registerFsRpcHandlers } from '../src/http/fs-rpc.js';
import type { FsContext } from '@prismer/sandbox-runtime';

/** Bidirectional pipe — two FakeWs instances that forward messages to each
 *  other. Mimics the cloud↔daemon WS pair without TCP. */
class FakeWs extends EventEmitter {
  readyState = 1;
  peer?: FakeWs;
  send(data: string): void {
    // Peer receives via its own 'message' dispatch (handleControlMessage
    // consumes Buffer, so we wrap accordingly).
    if (this.peer) {
      const buf = Buffer.from(data, 'utf-8');
      // Simulate Node WS emit + RelayClient's internal handler
      if (this.peer.onMessage) this.peer.onMessage(buf);
    }
  }
  // Daemon-side RelayClient never listens via .on('message', ...) in this
  // harness — we hook it through onMessage directly.
  onMessage?: (data: Buffer) => void;
}

/** Minimal cloud-side RPC dispatcher (mirrors RelayService.sendDaemonRequest
 *  + handleDaemonRpcResponse). Same logic, no Prisma/Redis/pino deps. */
class CloudRpcDispatcher {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private controlWs: FakeWs) {}

  onResponse(payload: { rpcId: string; result?: unknown; error?: string }): void {
    const entry = this.pending.get(payload.rpcId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(payload.rpcId);
    if (payload.error) {
      entry.reject(new Error(payload.error));
    } else {
      entry.resolve(payload.result);
    }
  }

  async send<T>(method: string, params: unknown, timeoutMs = 2000): Promise<T> {
    const rpcId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(new Error('rpc timeout'));
      }, timeoutMs);
      this.pending.set(rpcId, { resolve: (v) => resolve(v as T), reject, timer });
      this.controlWs.send(JSON.stringify({ type: 'rpc.request', rpcId, method, params }));
    });
  }
}

describe('End-to-end: Cloud RpcDispatcher ↔ Daemon RelayClient over fake pipe', () => {
  let workspace: string;
  let daemon: RelayClient;
  let cloud: CloudRpcDispatcher;
  let cloudWs: FakeWs;
  let daemonWs: FakeWs;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e2e-')));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'contents of a', 'utf-8');

    // Build bidirectional pipe
    cloudWs = new FakeWs();
    daemonWs = new FakeWs();
    cloudWs.peer = daemonWs;
    daemonWs.peer = cloudWs;

    cloud = new CloudRpcDispatcher(cloudWs);
    daemon = new RelayClient({
      apiKey: 'sk-test',
      daemonId: 'd1',
      userId: 'u1',
      autoReconnect: false,
      // relayUrl required by ctor validation (commit 741f49d); .connect() is
      // never called here — controlWs is injected via the FakeWs pipe below.
      relayUrl: 'wss://relay.test.invalid',
    });
    (daemon as any).controlWs = daemonWs as unknown as WebSocket;

    // Pipe wiring:
    //  - cloudWs.send(data) → daemonWs receives → daemon.handleControlMessage(data)
    //  - daemonWs.send(data) → cloudWs receives → cloud.onResponse(parsed)
    daemonWs.onMessage = (data: Buffer) => {
      (daemon as any).handleControlMessage(data);
    };
    cloudWs.onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.type === 'rpc.response') cloud.onResponse(msg);
    };

    const ctx: FsContext = {
      agentId: 'a1',
      workspace,
      mode: 'default',
      rules: [{ source: 'session', behavior: 'allow', value: { tool: '*' } }],
    } as FsContext;
    registerFsRpcHandlers(daemon, { fsContextProvider: () => ctx });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('round-trip fs.read: cloud request → daemon sandbox → cloud result', async () => {
    const filePath = path.join(workspace, 'a.txt');
    const result = await cloud.send<{ content: string }>(
      'fs.read',
      { agentId: 'a1', path: filePath },
    );
    expect(result.content).toBe('contents of a');
  });

  it('round-trip fs.write followed by fs.read', async () => {
    const target = path.join(workspace, 'new.txt');
    await cloud.send('fs.write', { agentId: 'a1', path: target, content: 'through pipe' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('through pipe');

    const readResult = await cloud.send<{ content: string }>(
      'fs.read',
      { agentId: 'a1', path: target },
    );
    expect(readResult.content).toBe('through pipe');
  });

  it('unknown method surfaces as error on cloud side', async () => {
    await expect(
      cloud.send('fs.teleport', { agentId: 'a1' }),
    ).rejects.toThrow(/unknown rpc method/);
  });

  it('missing agentId surfaces as error on cloud side', async () => {
    await expect(
      cloud.send('fs.read', { path: '/x' }),
    ).rejects.toThrow(/agentId required/);
  });

  // (Sandbox boundary enforcement itself is covered by sandbox-runtime's own
  // tests — this e2e only asserts the relay contract. We intentionally do NOT
  // re-test "path outside workspace" here because the boundary behavior
  // depends on PermissionMode + rule shape, which is orthogonal to relay
  // plumbing.)
});
