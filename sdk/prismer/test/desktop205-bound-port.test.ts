// desktop205 O16-b — PRISMER_DAEMON_PORT must carry the BOUND port, not the requested one.
import { afterEach, describe, expect, it } from 'vitest';
import { LocalServer } from '../src/daemon/local-server.js';

const servers: LocalServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.stop().catch(() => {}); delete process.env.PRISMER_DAEMON_PORT; });

function make(port: number): LocalServer {
  const s = new LocalServer({ port, getState: () => ({ daemonId: 'd', daemonVersion: '0', cloudBaseUrl: '', workspaceId: null, pid: 1, startedAt: Date.now(), wsConnected: false, hostedAgents: [], observability: {}, adapters: [], resources: {} }) } as never);
  servers.push(s); return s;
}

describe('O16-b — PRISMER_DAEMON_PORT reflects the bound socket', () => {
  it('port: 0 ⇒ env carries the kernel-assigned port, never "0"', async () => {
    const s = make(0); await s.start();
    expect(s.boundPort).toBeGreaterThan(0);
    expect(process.env.PRISMER_DAEMON_PORT).toBe(String(s.boundPort));
    expect(process.env.PRISMER_DAEMON_PORT).not.toBe('0');   // the bug
  });
  it('NEGATIVE CONTROL — an explicit port still round-trips unchanged', async () => {
    const probe = make(0); await probe.start(); const free = probe.boundPort!; await probe.stop();
    const s = make(free); await s.start();
    expect(s.boundPort).toBe(free);
    expect(process.env.PRISMER_DAEMON_PORT).toBe(String(free));
  });
});
