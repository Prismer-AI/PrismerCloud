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

/**
 * release202/09 §3.2 — chat-dispatch RUN id prefix.
 *
 * A `run_`-prefixed id makes a chat run structurally distinguishable from a
 * kanban task (whose ids stay bare `cuid()` for legacy compatibility). A
 * `run_` id on a `cloud task <op>` / task API route is now a hard error
 * instead of a silent 404.
 *
 * Shape: `run_` + 21 lowercase-alnum chars = 25 chars total, fits the
 * `@db.VarChar(30)` column. We do NOT rewrite historical run ids; legacy
 * bare-cuid run ids stay valid (probe-both / unknown-id fallback).
 */
export const RUN_ID_PREFIX = 'run_';
const RUN_ID_SUFFIX_LENGTH = 21;

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

/** Generate a `run_`-prefixed RUN id (release202/09 §3.2). */
export function generateRunId(): string {
  return RUN_ID_PREFIX + generateId(RUN_ID_SUFFIX_LENGTH);
}

/** True if `id` is a new-shape RUN id (`run_…`). Bare-cuid ids return false. */
export function isRunId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(RUN_ID_PREFIX);
}
