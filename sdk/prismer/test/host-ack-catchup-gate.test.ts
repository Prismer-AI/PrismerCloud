import { describe, expect, it } from 'vitest';
import { HostAckCatchupGate } from '../src/daemon/host-ack-catchup-gate.js';

describe('HostAckCatchupGate', () => {
  it('runs heavy catch-up once per authenticated connection/workspace', () => {
    const gate = new HostAckCatchupGate();
    gate.onConnected();
    expect(gate.takeHeavyCatchup('ws-a')).toBe(true);
    expect(gate.takeHeavyCatchup('ws-a')).toBe(false);
    expect(gate.takeHeavyCatchup('ws-a')).toBe(false);

    expect(gate.takeHeavyCatchup('ws-b')).toBe(true);
    expect(gate.takeHeavyCatchup('ws-b')).toBe(false);

    gate.onConnected();
    expect(gate.takeHeavyCatchup('ws-b')).toBe(true);
  });

  it('deduplicates a successful transport report but retries after failure', async () => {
    const gate = new HostAckCatchupGate();
    gate.onConnected();
    let calls = 0;
    const fail = await gate.runTransportOnce('ws-a', async () => {
      calls += 1;
      throw new Error('offline');
    });
    expect(fail).toBe(false);
    const retry = await gate.runTransportOnce('ws-a', async () => {
      calls += 1;
    });
    expect(retry).toBe(true);
    expect(await gate.runTransportOnce('ws-a', async () => { calls += 1; })).toBe(false);
    expect(calls).toBe(2);
  });

  it('shares one in-flight transport report across concurrent heartbeat acks', async () => {
    const gate = new HostAckCatchupGate();
    gate.onConnected();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const a = gate.runTransportOnce('ws-a', async () => { calls += 1; await pending; });
    const b = gate.runTransportOnce('ws-a', async () => { calls += 1; });
    release();
    expect(await Promise.all([a, b])).toEqual([true, false]);
    expect(calls).toBe(1);
  });
});
