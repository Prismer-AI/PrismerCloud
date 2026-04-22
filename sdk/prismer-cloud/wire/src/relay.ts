/**
 * @prismer/wire — Cloud Relay control messages
 *
 * JSON control-plane messages exchanged over WS `/ws/daemon/control` and
 * `/ws/client/control`. Reference: docs/version190/07-remote-control.md §5.6.1b,
 * §5.6.2 (offer v2), §5.6.3. Data-plane frames are handled by frame.ts; the
 * outer E2EE envelope is defined in envelopes.ts.
 *
 * The shapes here are aligned with the in-tree consumers:
 *   - src/im/services/pairing.service.ts  (offer / binding fields)
 *   - src/im/services/relay.service.ts    (control message sinks)
 *   - src/im/ws/relay-handler.ts          (push.trigger, seq.update, etc.)
 */

import { z } from 'zod';

// ─── Connection candidates (Paseo-style multi-path) ──────────────────────

/** Candidate endpoint for a daemon — LAN direct TCP or cloud relay. */
export const ConnectionCandidateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('directTcp'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({
    type: z.literal('directSocket'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({
    type: z.literal('relay'),
    endpoint: z.string().min(1),
  }),
]);

export type ConnectionCandidate = z.infer<typeof ConnectionCandidateSchema>;

// ─── Pairing offer (QR / deeplink payload, offer v2) ──────────────────────

/**
 * PairingOffer v2 — embedded in `prismer://pair?offer=<base64>` deeplinks
 * and in QR codes. Signed+sealed by daemon; consumed by mobile client.
 */
export const PairingOfferSchema = z.object({
  v: z.literal(2),
  daemonPubKey: z.string().min(1), // X25519 base64
  daemonSignPub: z.string().min(1), // Ed25519 base64
  candidates: z.array(ConnectionCandidateSchema).min(1),
  serverId: z.string().min(1), // stable daemon identifier
  nonce: z.string().min(1),
  ttl: z.number().int().positive().optional(), // seconds; server default 300s
  deviceName: z.string().optional(),
});

export type PairingOffer = z.infer<typeof PairingOfferSchema>;

// ─── Individual control message schemas ───────────────────────────────────

/** `binding.register` — daemon announces itself on control channel connect. */
const BindingRegisterMsgSchema = z.object({
  type: z.literal('binding.register'),
  daemonId: z.string().min(1),
  bindingId: z.string().min(1).optional(),
  deviceFingerprint: z.string().optional(),
  deviceName: z.string().optional(),
});

/** `binding.update` — cloud notifies daemon that binding state changed. */
const BindingUpdateMsgSchema = z.object({
  type: z.literal('binding.update'),
  bindingId: z.string().min(1),
  status: z.enum(['active', 'revoked', 'pending']),
  reason: z.string().optional(),
});

/** `push.trigger` — daemon asks cloud to fan-out a push notification. */
const PushTriggerMsgSchema = z.object({
  type: z.literal('push.trigger'),
  data: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    category: z.string().optional(),
    payload: z.unknown().optional(),
  }),
});

/** `heartbeat` — 30s ping, either direction. */
const HeartbeatMsgSchema = z.object({
  type: z.literal('heartbeat'),
  ts: z.number().int().nonnegative(),
});

/** `connection.offer` — daemon publishes a fresh offer (LAN candidates + serverId). */
const ConnectionOfferMsgSchema = z.object({
  type: z.literal('connection.offer'),
  offer: PairingOfferSchema,
});

/** `connection.accept` — client confirms it consumed an offer. */
const ConnectionAcceptMsgSchema = z.object({
  type: z.literal('connection.accept'),
  offerId: z.string().min(1),
  clientPubKey: z.string().min(1), // X25519 base64
  consumerDevice: z.string().optional(),
});

/** `seq.update` — daemon reports latest timeline seq (for backfill math). */
const SeqUpdateMsgSchema = z.object({
  type: z.literal('seq.update'),
  seq: z.number().int().nonnegative(),
});

/** `command.ack` — daemon acknowledges receipt of a queued command. */
const CommandAckMsgSchema = z.object({
  type: z.literal('command.ack'),
  commandId: z.string().min(1),
});

/** `command.result` — daemon reports command execution result. */
const CommandResultMsgSchema = z.object({
  type: z.literal('command.result'),
  commandId: z.string().min(1),
  result: z.unknown(),
  status: z.enum(['ok', 'error']).optional(),
});

// ─── Discriminated union ──────────────────────────────────────────────────

/** All relay control-plane messages (JSON over WS control channels). */
export const RelayControlMessageSchema = z.discriminatedUnion('type', [
  BindingRegisterMsgSchema,
  BindingUpdateMsgSchema,
  PushTriggerMsgSchema,
  HeartbeatMsgSchema,
  ConnectionOfferMsgSchema,
  ConnectionAcceptMsgSchema,
  SeqUpdateMsgSchema,
  CommandAckMsgSchema,
  CommandResultMsgSchema,
]);

export type RelayControlMessage = z.infer<typeof RelayControlMessageSchema>;

// ─── Re-export individual schemas ─────────────────────────────────────────

export {
  BindingRegisterMsgSchema,
  BindingUpdateMsgSchema,
  PushTriggerMsgSchema,
  HeartbeatMsgSchema,
  ConnectionOfferMsgSchema,
  ConnectionAcceptMsgSchema,
  SeqUpdateMsgSchema,
  CommandAckMsgSchema,
  CommandResultMsgSchema,
};
