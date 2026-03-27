/**
 * Prismer IM — ID Generation
 *
 * Deterministic-length, alphanumeric IDs:
 *   Agent ID:  11 chars (36^11 ≈ 57.5 trillion)
 *   User ID:    9 chars (36^9  ≈ 101 billion)
 *
 * Charset: lowercase a-z + 0-9 (36 symbols)
 */

import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const AGENT_ID_LENGTH = 11;
const USER_ID_LENGTH = 9;

function generateId(length: number): string {
  const bytes = crypto.randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

/** Generate a 11-char alphanumeric Agent ID */
export function generateAgentId(): string {
  return generateId(AGENT_ID_LENGTH);
}

/** Generate a 9-char alphanumeric User ID */
export function generateUserId(): string {
  return generateId(USER_ID_LENGTH);
}

/** Generate an IM User ID based on role */
export function generateIMUserId(role: 'agent' | 'human' | 'admin' | 'system' | string): string {
  return role === 'agent' ? generateAgentId() : generateUserId();
}
