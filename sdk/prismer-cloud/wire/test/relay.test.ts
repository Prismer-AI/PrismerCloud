/**
 * @prismer/wire — relay.ts test suite
 *
 * Covers ConnectionCandidate, PairingOffer, and every variant of the
 * RelayControlMessage discriminated union (§5.6.3).
 */

import { describe, it, expect } from 'vitest';
import {
  ConnectionCandidateSchema,
  PairingOfferSchema,
  RelayControlMessageSchema,
} from '../src/relay.js';

function mustParse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

function mustFail(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

describe('ConnectionCandidate', () => {
  it('directTcp candidate parses', () => {
    mustParse(ConnectionCandidateSchema, { type: 'directTcp', host: '192.168.1.42', port: 3210 });
  });

  it('relay candidate parses', () => {
    mustParse(ConnectionCandidateSchema, { type: 'relay', endpoint: 'cloud.prismer.dev:443' });
  });

  it('rejects missing host on directTcp', () => {
    mustFail(ConnectionCandidateSchema, { type: 'directTcp', port: 3210 });
  });

  it('rejects out-of-range port', () => {
    mustFail(ConnectionCandidateSchema, { type: 'directTcp', host: '1.2.3.4', port: 99999 });
  });
});

describe('PairingOffer (v2)', () => {
  it('valid v2 offer parses', () => {
    mustParse(PairingOfferSchema, {
      v: 2,
      daemonPubKey: 'base64pub==',
      daemonSignPub: 'base64sign==',
      candidates: [
        { type: 'directTcp', host: '192.168.1.42', port: 3210 },
        { type: 'relay', endpoint: 'cloud.prismer.dev:443' },
      ],
      serverId: 'daemon-abc',
      nonce: 'xyz',
      ttl: 300,
    });
  });

  it('rejects v1 offers (wrong literal)', () => {
    mustFail(PairingOfferSchema, {
      v: 1,
      daemonPubKey: 'k',
      daemonSignPub: 'k',
      candidates: [{ type: 'relay', endpoint: 'r:443' }],
      serverId: 'd',
      nonce: 'n',
    });
  });

  it('rejects empty candidates array', () => {
    mustFail(PairingOfferSchema, {
      v: 2,
      daemonPubKey: 'k',
      daemonSignPub: 'k',
      candidates: [],
      serverId: 'd',
      nonce: 'n',
    });
  });
});

describe('RelayControlMessage', () => {
  it('binding.register', () => {
    mustParse(RelayControlMessageSchema, {
      type: 'binding.register',
      daemonId: 'd1',
      deviceFingerprint: 'fp',
    });
  });

  it('binding.update', () => {
    mustParse(RelayControlMessageSchema, {
      type: 'binding.update',
      bindingId: 'b1',
      status: 'active',
    });
  });

  it('push.trigger', () => {
    mustParse(RelayControlMessageSchema, {
      type: 'push.trigger',
      data: { title: 'Approval needed', body: 'Tool call awaiting approval', payload: { foo: 1 } },
    });
  });

  it('heartbeat', () => {
    mustParse(RelayControlMessageSchema, { type: 'heartbeat', ts: 1700000000000 });
  });

  it('connection.offer wraps a PairingOffer', () => {
    mustParse(RelayControlMessageSchema, {
      type: 'connection.offer',
      offer: {
        v: 2,
        daemonPubKey: 'k',
        daemonSignPub: 'k',
        candidates: [{ type: 'relay', endpoint: 'r:443' }],
        serverId: 'd',
        nonce: 'n',
      },
    });
  });

  it('connection.accept', () => {
    mustParse(RelayControlMessageSchema, {
      type: 'connection.accept',
      offerId: 'o1',
      clientPubKey: 'base64pub',
      consumerDevice: 'iPhone 15',
    });
  });

  it('seq.update', () => {
    mustParse(RelayControlMessageSchema, { type: 'seq.update', seq: 42 });
  });

  it('command.ack', () => {
    mustParse(RelayControlMessageSchema, { type: 'command.ack', commandId: 'cmd-1' });
  });

  it('command.result', () => {
    mustParse(RelayControlMessageSchema, {
      type: 'command.result',
      commandId: 'cmd-1',
      result: { ok: true },
      status: 'ok',
    });
  });

  it('rejects unknown message type', () => {
    mustFail(RelayControlMessageSchema, { type: 'does.not.exist', foo: 'bar' });
  });

  it('rejects binding.update with invalid status', () => {
    mustFail(RelayControlMessageSchema, {
      type: 'binding.update',
      bindingId: 'b1',
      status: 'bogus',
    });
  });

  it('rejects seq.update with negative seq', () => {
    mustFail(RelayControlMessageSchema, { type: 'seq.update', seq: -1 });
  });
});
