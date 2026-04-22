/**
 * @prismer/wire — EncryptedEnvelope schema
 *
 * Thin wrapper around an encrypted PARA event. The wire package does NOT
 * implement encryption — only the schema for the envelope structure.
 * Crypto is handled by @prismer/sandbox-runtime using tweetnacl (§5.2).
 */

import { z } from 'zod';

/**
 * EncryptedEnvelope — a PARA event encrypted as a NaCl box.
 *
 * Fields:
 *   t  - literal 'encrypted' (discriminator)
 *   c  - base64-encoded NaCl box ciphertext (non-empty)
 *   v  - envelope version (always 1 for PARA v0.1)
 */
export const EncryptedEnvelopeSchema = z.object({
  t: z.literal('encrypted'),
  c: z.string().min(1, 'ciphertext must not be empty'),
  v: z.literal(1),
});

export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
