// Envelope crypto interface.
//
// Doc 18 §"Encryption modes" defines three modes:
//   - Standard:   workspace-keyed envelope encryption (default for shared workspaces)
//   - Private:    user-keyed; cloud forward search returns metadata-only fallback
//   - Regulated:  daemon-only, no cloud forward at all
//
// Per doc 18 migration plan, encryption proper is M4 (post-MVP). Phase-0
// (Line C C1) ships only:
//   - The `inline` payload mode where content is plaintext on disk.
//     File-system perms (0o600 on the SQLite DB + 0o700 on the directory)
//     are the only protection. This is appropriate for dev/local-only daemon.
//   - The `blobRef` interface stub. Calling unsealPayload on a blobRef
//     payload throws an explicit error so it's obvious encryption is not
//     wired yet. M4 owner replaces this without touching the call sites.
//
// IMPORTANT: agent processes MUST NOT see workspace keys (doc 18 M4). When
// real encryption ships, agent adapters can only request decrypted content
// via daemon RPC — keys never leave the daemon. The interface below is
// already shaped that way: the daemon owns the unseal call.

import type { z } from 'zod';
import type { PagePayload } from './envelope.js';

type PagePayloadT = z.infer<typeof PagePayload>;

/**
 * Wrap plaintext content into the on-disk payload representation.
 * Phase-0: always returns inline mode. M4 owner switches to blobRef when
 * encryption is enabled for the workspace.
 */
export function sealPlaintext(content: string): PagePayloadT {
  return { kind: 'inline', content };
}

/**
 * Recover plaintext content from a stored payload. inline mode is a passthrough;
 * blobRef mode requires keychain unseal which is M4 work — phase-0 throws.
 */
export function unsealPayload(payload: PagePayloadT): string {
  if (payload.kind === 'inline') return payload.content;
  throw new Error(
    `unsealPayload: blobRef payload (uri=${payload.uri}) requires M4 encryption support (not yet implemented in phase-0)`,
  );
}
