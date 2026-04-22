/**
 * @prismer/wire — Public entrypoint
 *
 * Re-exports everything from all modules. Consumers can also import
 * sub-modules directly (e.g. '@prismer/wire/permissions').
 */

// Schemas (Zod)
export * from './schemas.js';

// Types (inferred + hand-written)
export * from './types.js';

// Envelopes
export { EncryptedEnvelopeSchema } from './envelopes.js';
export type { EncryptedEnvelope } from './envelopes.js';

// Binary frame
export {
  Opcode,
  OPCODE_NAMES,
  encodeFrame,
  decodeFrame,
  chunkFile,
  reassembleFile,
  FrameMultiplexer,
  FrameDemultiplexer,
} from './frame.js';
export type { Frame, OpcodeValue } from './frame.js';

// Deep links
export { PrismerDeeplinkSchema, parseDeeplink, serializeDeeplink } from './deeplinks.js';
export type { PrismerDeeplink } from './deeplinks.js';

// Permissions (canonical re-export)
export * from './permissions.js';

// Cloud Relay control messages (§5.6)
export * from './relay.js';

// Timeline / seq / epoch (§5.6.5)
export * from './timeline.js';

// FS Sandbox API messages (§5.1)
export * from './fs.js';

// Task routing (§5.7)
export * from './tasks.js';
