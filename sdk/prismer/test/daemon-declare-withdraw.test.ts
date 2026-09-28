/**
 * daemon-declare-withdraw.test.ts — desktop204 M1-3, daemon side.
 *
 *   D204-3  `sendDeclare()` puts the device identity ON THE WIRE. Until now the
 *           daemon sent only daemonId/version/platform and the cloud had to
 *           guess kind + label from the daemonId string.
 *   D204-4  `stop({withdraw})` emits `agent.host.withdraw` AFTER the drain and
 *           BEFORE the WS closes. Ordering is the whole point: a withdraw sent
 *           after close() never reaches the cloud, and the cloud then keeps
 *           dispatching to a dead daemon for the full 3-minute stale window.
 *
 * The Runner class is heavy to boot, so (as in daemon-version-skew-directive.
 * test.ts) we construct it WITHOUT start() and stub only the fields the
 * declare/stop paths touch. No I/O.
 *
 * Usage: npx vitest run test/daemon-declare-withdraw.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import { Runner } from '../src/daemon/runner';
import type { AgentHostDeclarePayload, AgentHostWithdrawPayload } from '../src/types/im-events';

interface Frame {
  type: string;
  payload: unknown;
  timestamp: number;
}

function makeRunner(config: Record<string, unknown> = {}): any {
  const r = new Runner() as any;
  r.config = { daemon_id: 'daemon-testbox', ...config };
  r.opts = { daemonVersion: '2.0.9' };
  r.hostedAgents = new Map();
  r.registry = new Map(); // .get(adapterName) → undefined (no capabilityFlags)
  r.runningTasks = new Map();
  r.state = 'running';
  return r;
}

/** WS double that records send/sendAndFlush/close in invocation order. */
function makeWs() {
  const calls: string[] = [];
  const sent: Frame[] = [];
  return {
    calls,
    sent,
    flushResult: true as boolean | 'throw' | 'hang',
    send: vi.fn((msg: Frame) => {
      calls.push(`send:${msg.type}`);
      sent.push(msg);
    }),
    sendAndFlush: vi.fn(async function (this: any, msg: Frame) {
      calls.push(`flush:${msg.type}`);
      sent.push(msg);
      if (this.flushResult === 'throw') throw new Error('socket exploded');
      if (this.flushResult === 'hang') return false; // WsClient's own timeout already fired
      return this.flushResult as boolean;
    }),
    close: vi.fn(() => {
      calls.push('close');
    }),
  };
}

function inflight(): { ctrl: AbortController; startedAt: number; lastProgressAt: number; timeoutMs: number } {
  return { ctrl: new AbortController(), startedAt: Date.now(), lastProgressAt: Date.now(), timeoutMs: 0 };
}

describe('D204-3 — agent.host.declare carries the device identity', () => {
  it('always sends daemonLabel + daemonKind (cloud must never have to guess)', () => {
    const r = makeRunner();
    const ws = makeWs();
    r.ws = ws;

    r.sendDeclare();

    expect(ws.sent).toHaveLength(1);
    const payload = ws.sent[0].payload as AgentHostDeclarePayload;
    expect(ws.sent[0].type).toBe('agent.host.declare');
    expect(payload.daemonId).toBe('daemon-testbox');
    // The two fields this milestone exists for.
    expect(payload.daemonKind).toBe('local');
    expect(payload.daemonLabel).toBe(hostname());
    expect(payload.daemonLabel).not.toBe('');
  });

  it("declares the user's config.toml daemon_label as the device name", () => {
    const r = makeRunner({ daemon_label: '客厅的 Mac mini' });
    const ws = makeWs();
    r.ws = ws;

    r.sendDeclare();

    const payload = ws.sent[0].payload as AgentHostDeclarePayload;
    expect(payload.daemonLabel).toBe('客厅的 Mac mini');
    // …and it is NOT derivable from the daemonId — which is exactly why the
    // cloud's `daemonId.slice('daemon-'.length)` fallback cannot replace this.
    expect(payload.daemonLabel).not.toContain('testbox');
  });
});

describe('D204-4 — agent.host.withdraw on intentional shutdown', () => {
  it('sends withdraw BEFORE closing the WS (after the drain)', async () => {
    const r = makeRunner();
    const ws = makeWs();
    r.ws = ws;

    await r.stop({ withdraw: { reason: 'user-quit' } });

    // Ordering is the contract: a withdraw sent after close() is a no-op.
    expect(ws.calls).toEqual(['flush:agent.host.withdraw', 'close']);
    const payload = ws.sent[0].payload as AgentHostWithdrawPayload;
    // Cloud rejects (WITHDRAW_DAEMON_MISMATCH) unless this equals the declared id.
    expect(payload.daemonId).toBe('daemon-testbox');
    expect(payload.reason).toBe('user-quit');
    expect(payload.inflightDrained).toBe(true);
  });

  it('reports inflightDrained=false when runs were still in flight (cloud requeues them)', async () => {
    const r = makeRunner();
    const ws = makeWs();
    r.ws = ws;
    r.runningTasks.set('task-1', inflight());

    await r.stop({ withdraw: { reason: 'user-quit' } });

    const payload = ws.sent[0].payload as AgentHostWithdrawPayload;
    expect(payload.inflightDrained).toBe(false);
  });

  it('does NOT withdraw when the caller gave no intent (crash / auth-fail / version respawn keep the binding)', async () => {
    const r = makeRunner();
    const ws = makeWs();
    r.ws = ws;

    await r.stop();

    expect(ws.sendAndFlush).not.toHaveBeenCalled();
    expect(ws.calls).toEqual(['close']);
  });

  it('is best-effort: a failing flush neither throws nor blocks the close (⌘Q on a plane)', async () => {
    const r = makeRunner();
    const ws = makeWs();
    ws.flushResult = 'throw';
    r.ws = ws;

    await expect(r.stop({ withdraw: { reason: 'user-quit' } })).resolves.toBeUndefined();
    expect(ws.calls).toEqual(['flush:agent.host.withdraw', 'close']);
    expect(r.state).toBe('idle'); // shutdown completed regardless
  });

  it('an offline socket (flush returns false) still completes the shutdown', async () => {
    const r = makeRunner();
    const ws = makeWs();
    ws.flushResult = 'hang';
    r.ws = ws;

    await r.stop({ withdraw: { reason: 'app-uninstall' } });

    expect(ws.calls).toEqual(['flush:agent.host.withdraw', 'close']);
    expect(r.state).toBe('idle');
  });

  it('honours the caller-supplied flush budget', async () => {
    const r = makeRunner();
    const ws = makeWs();
    r.ws = ws;

    await r.stop({ withdraw: { reason: 'transfer-out', timeoutMs: 300 } });

    expect(ws.sendAndFlush).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.host.withdraw' }), 300);
  });
});
