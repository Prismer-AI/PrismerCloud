// Origin Adapter SPI shape tests.
//
// These pin the contract that drop-folder, agent-gen, and (refactored) Web
// upload all implement. Each adapter is a producer of asset bytes for a
// workspace; the SPI separates the three steps so the outbox + uploader can
// drive them uniformly.

import { describe, expect, it } from 'vitest';
import type { OriginAdapter, OriginKind, SourceObservation } from '../src/daemon/asset/origin/spi.js';

describe('OriginAdapter SPI', () => {
  it('exposes a discriminated kind covering the three rev-5 producers', () => {
    const allowed: OriginKind[] = ['upload', 'drop-folder', 'agent-gen'];
    expect(allowed).toHaveLength(3);
  });

  it('lets a no-op adapter satisfy the contract (compile-time + structural)', async () => {
    class StubAdapter implements OriginAdapter {
      readonly kind: OriginKind = 'agent-gen';
      async *observe(): AsyncIterable<SourceObservation> {
        // empty stream
      }
      async identifySource(obs: SourceObservation) {
        return { sourceRef: `stub://${obs.workspaceId}` };
      }
      async fetch(obs: SourceObservation) {
        return { bytes: Buffer.from(`hello ${obs.workspaceId}`), mime: 'text/plain', size: 0 };
      }
    }
    const a = new StubAdapter();
    expect(a.kind).toBe('agent-gen');
    const id = await a.identifySource({ workspaceId: 'w1', detail: {}, observedAt: 0 });
    expect(id.sourceRef).toBe('stub://w1');
    const bytes = await a.fetch({ workspaceId: 'w1', detail: {}, observedAt: 0 });
    expect((bytes.bytes as Buffer).toString()).toBe('hello w1');
  });

  it('passes adapter-specific detail through observation payload', async () => {
    const obs: SourceObservation = {
      workspaceId: 'w1',
      detail: { path: '/tmp/x.csv', mtime: 12345 },
      observedAt: 12345,
    };
    expect(obs.detail.path).toBe('/tmp/x.csv');
    expect(obs.observedAt).toBe(12345);
  });
});
