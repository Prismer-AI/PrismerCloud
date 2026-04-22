import { describe, expect, it } from 'vitest';
import { ConnectionProber } from '../src/connection-prober.js';

describe('ConnectionProber', () => {
  it('uses an explicit LAN host for direct candidates', () => {
    const prober = new ConnectionProber({
      lanHost: '192.168.1.23',
      lanPort: 3210,
      relayHost: 'relay.test',
      relayPort: 443,
    });

    expect(prober.getCandidates()).toContainEqual({
      type: 'lan',
      endpoint: '192.168.1.23:3210',
      priority: 1,
    });
  });

  it('does not report localhost as a LAN direct candidate', () => {
    const prober = new ConnectionProber({
      lanHost: undefined,
      lanPort: 3210,
      relayHost: 'relay.test',
      relayPort: 443,
    });

    expect(prober.getCandidates().some((candidate) => candidate.type === 'lan')).toBe(false);
    expect(prober.getCandidates()).not.toContainEqual({
      type: 'lan',
      endpoint: '127.0.0.1:3210',
      priority: 1,
    });
  });

  it('filters explicit loopback LAN hosts', () => {
    const prober = new ConnectionProber({
      lanHost: '127.0.0.1',
      lanPort: 3210,
      relayHost: 'relay.test',
      relayPort: 443,
    });

    expect(prober.getCandidates().some((candidate) => candidate.type === 'lan')).toBe(false);
  });

  it('splits host:port relayHost so the embedded port wins over the default', () => {
    // Regression: when `deriveHostFromHttp("http://localhost:3000")` returns
    // `"localhost:3000"` the prober used to produce `localhost:3000:443`,
    // which silently fails in wsPing. The constructor must normalize this
    // into host=`localhost`, port=3000 even when no explicit relayPort is
    // passed.
    const prober = new ConnectionProber({
      lanHost: undefined,
      relayHost: 'localhost:3000',
    });

    const relayCandidate = prober
      .getCandidates()
      .find((candidate) => candidate.type === 'relay');

    expect(relayCandidate?.endpoint).toBe('localhost:3000');
    expect(relayCandidate?.endpoint.split(':').length).toBe(2);
  });

  it('leaves plain hostname untouched when no embedded port is present', () => {
    const prober = new ConnectionProber({
      lanHost: undefined,
      relayHost: 'relay.test',
      relayPort: 443,
    });

    const relayCandidate = prober
      .getCandidates()
      .find((candidate) => candidate.type === 'relay');

    expect(relayCandidate?.endpoint).toBe('relay.test:443');
  });
});
