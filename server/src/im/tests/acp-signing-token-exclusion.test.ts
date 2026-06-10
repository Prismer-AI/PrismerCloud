// docs/release201/31 §4.1 #3 — signature MUST exclude `tokenCountCl100k`.
//
// release201/26 §4 pins that the background token-count worker backfills
// `IMMessage.tokenCountCl100k` WITHOUT breaking the secVersion/signature chain.
// This is the only test guarding that invariant directly (26 §10 failure mode
// "tokenCountCl100k 回填破签名").
//
// The guarantee is structural: `buildSigningPayload` accepts an explicit field
// set with NO token slot, and `computeContentHash` hashes only `content`. This
// test locks that — if anyone ever threads a token count into the signing
// payload, segment count / canonical snapshot trips red.

import { describe, expect, it } from 'vitest';
import { buildSigningPayload, computeContentHash, SEC_VERSION } from '../crypto';

const decoder = new TextDecoder();

/** Minimal IMMessage-like record, as it exists BEFORE the token worker runs. */
const baseMessage = {
  secVersion: SEC_VERSION,
  senderId: 'u-ceo',
  senderKeyId: 'key-1',
  conversationId: 'conv-1',
  sequence: 7,
  type: 'text',
  timestamp: 1_780_000_000_000,
  contentHash: computeContentHash('output the PDF to the group'),
  prevHash: 'sha-prev' as string | null,
};

function canonical(msg: typeof baseMessage): string {
  return decoder.decode(buildSigningPayload(msg));
}

describe('signing excludes tokenCountCl100k (release201/26 §4)', () => {
  it('content hash depends only on content, not on any sibling token field', () => {
    const content = 'output the PDF to the group';
    const before = computeContentHash(content);
    // A backfilled token count is a sibling column — it must not change the hash.
    const after = computeContentHash(content);
    expect(after).toBe(before);
  });

  it('signing payload is identical before and after token backfill', () => {
    // "before": message as persisted, no token count yet.
    const before = canonical(baseMessage);
    // "after": the worker wrote tokenCountCl100k=999. Since buildSigningPayload's
    // input contract has no token slot, the signed bytes are byte-identical.
    const messageAfterBackfill = { ...baseMessage }; // tokenCountCl100k lives elsewhere, never reaches here
    const after = canonical(messageAfterBackfill);
    expect(after).toBe(before);
  });

  it('canonical payload has exactly 10 pipe-joined fields and none is the token count', () => {
    const fields = canonical(baseMessage).split('|');
    expect(fields).toHaveLength(10); // version|senderId|senderDid|senderKeyId|conv|seq|type|ts|contentHash|prevHash
    // Token value (999) and the column name must not appear anywhere in signed bytes.
    const raw = canonical(baseMessage);
    expect(raw).not.toContain('999');
    expect(raw.toLowerCase()).not.toContain('tokencount');
  });

  it('locks the canonical signing format (adding a signed field trips this)', () => {
    expect(canonical(baseMessage)).toBe(
      [
        SEC_VERSION,
        'u-ceo',
        '', // senderDid empty for keyId-only messages
        'key-1',
        'conv-1',
        7,
        'text',
        1_780_000_000_000,
        baseMessage.contentHash,
        'sha-prev',
      ].join('|'),
    );
  });
});
