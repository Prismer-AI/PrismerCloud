/**
 * Unit tests for src/lib/log-redaction.ts — Phase E1 of the v2.1 debug pipeline.
 *
 * Verifies every redaction pattern documented in §5.2 of
 * docs/release201/06-debug-pipeline-design.md AND the deep-walk / circular-ref
 * safety guarantees of `redactObject`. The redactor sits on the buffer-write
 * hot path; false negatives leak credentials, so coverage breadth (not
 * precision) is the goal.
 *
 * Test runner: built-in `node:test` (invoked via `tsx --test ...`). Deliberately
 * does NOT use vitest so the file is runnable with zero config in CI / pre-push
 * hooks where vitest's worker overhead is unwanted.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { redactString, redactObject } from '../log-redaction';

describe('redactString — individual patterns', () => {
  test('scrubs sk-prismer-live-* API key', () => {
    const input = 'sk-prismer-live-dea50222cb9aec9eca33f2e947d9f49dbb4a719cae8b58ce9e197290302e5f06';
    const out = redactString(input);
    assert.equal(out, 'sk-prismer-***REDACTED***');
    assert.equal(out.includes('dea50222'), false, 'tail must be stripped');
  });

  test('scrubs sk-prismer-test-* API key', () => {
    const input = 'sk-prismer-test-8203d352cc8d2b41d17efe877b4b9c9420afd1e89666b5b0ae7161e80c39acd2';
    const out = redactString(input);
    assert.equal(out, 'sk-prismer-***REDACTED***');
  });

  test('scrubs API key embedded in a larger string', () => {
    const input = 'Bearer sk-prismer-live-aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00112233 from header';
    const out = redactString(input);
    assert.ok(out.includes('sk-prismer-***REDACTED***'), `expected redacted marker, got: ${out}`);
    assert.ok(!out.match(/aaaaaaaa/), 'plaintext key suffix must not survive');
  });

  test('scrubs three-segment JWT', () => {
    // Three base64url-ish segments separated by dots; leading `eyJ` is the
    // base64-encoded `{"` header prefix that every JWT carries.
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSIsImlhdCI6MTUxNjIzfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactString(jwt);
    assert.equal(out, '<jwt-redacted>');
  });

  test('scrubs JWT embedded inside a sentence', () => {
    const input = 'Got token eyJabc.eyJdef.GhI-_ from the client';
    const out = redactString(input);
    assert.equal(out.includes('<jwt-redacted>'), true);
    assert.equal(out.includes('eyJabc'), false, 'jwt header must be stripped');
  });

  test('scrubs password=<value>', () => {
    const out = redactString('user=foo password=supersecret123 host=db');
    assert.match(out, /password=\*\*\*/);
    assert.ok(!out.includes('supersecret123'), `plaintext password leaked: ${out}`);
  });

  test('scrubs secret: "value" (JSON style)', () => {
    const out = redactString('config = { "secret": "abc-xyz-999", "name": "ok" }');
    assert.ok(out.includes('***'), `expected mask, got: ${out}`);
    assert.ok(!out.includes('abc-xyz-999'), `plaintext secret leaked: ${out}`);
  });

  test('scrubs token=<value> case-insensitive', () => {
    const out = redactString('Token=letmein123 and TOKEN=admin99');
    assert.ok(!out.includes('letmein123'), 'first token value leaked');
    assert.ok(!out.includes('admin99'), 'second token value leaked');
  });

  test('scrubs Authorization: Bearer <token>', () => {
    const out = redactString('Authorization: Bearer abc.def.ghi-token-99');
    assert.match(out, /Authorization: Bearer \*\*\*/);
    assert.ok(!out.includes('abc.def.ghi-token-99'), `Bearer token leaked: ${out}`);
  });

  test('multiple patterns in one string are all scrubbed', () => {
    const input = [
      'Request: Authorization: Bearer some-opaque-token',
      'used key sk-prismer-live-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      'and password=hunter2',
      'plus JWT eyJabc.eyJdef.MNO_pqr',
    ].join(' ; ');
    const out = redactString(input);
    assert.ok(!out.includes('some-opaque-token'), 'Bearer survived');
    assert.ok(!out.includes('aabbccddeeff'), 'API key survived');
    assert.ok(!out.includes('hunter2'), 'password survived');
    assert.ok(!out.includes('eyJabc.eyJdef.MNO_pqr'), 'JWT survived');
    assert.ok(out.includes('sk-prismer-***REDACTED***'), 'expected api-key marker');
    assert.ok(out.includes('<jwt-redacted>'), 'expected jwt marker');
    assert.ok(out.includes('Authorization: Bearer ***'), 'expected bearer marker');
    assert.match(out, /password=\*\*\*/);
  });

  test('idempotent — running twice leaves output unchanged', () => {
    const input = 'sk-prismer-live-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    const once = redactString(input);
    const twice = redactString(once);
    assert.equal(twice, once);
  });

  test('passes through strings with no secrets unchanged', () => {
    const input = '[admin-debug] called {action: db-snapshot, entity: workspace}';
    assert.equal(redactString(input), input);
  });
});

describe('redactObject — recursive walk', () => {
  test('walks nested objects', () => {
    const out = redactObject({
      headers: {
        // Use the full "Authorization: Bearer X" form — the redactor only matches
        // that header-shaped substring, not bare "Bearer X" (which could be a
        // legitimate token-typed log field name).
        raw: 'Authorization: Bearer abc.def.ghi',
        'content-type': 'application/json',
      },
      body: {
        apiKey: 'sk-prismer-live-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      },
    }) as { headers: { raw: string; 'content-type': string }; body: { apiKey: string } };

    assert.match(out.headers.raw, /Authorization: Bearer \*\*\*/);
    assert.equal(out.headers['content-type'], 'application/json', 'non-secret string preserved');
    assert.equal(out.body.apiKey, 'sk-prismer-***REDACTED***');
  });

  test('walks arrays of strings', () => {
    const out = redactObject([
      'normal log line',
      'using sk-prismer-test-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      'Authorization: Bearer abc',
    ]) as string[];

    assert.equal(out[0], 'normal log line');
    assert.equal(out[1], 'using sk-prismer-***REDACTED***');
    assert.match(out[2], /Bearer \*\*\*/);
  });

  test('walks arrays nested inside objects', () => {
    const out = redactObject({
      events: [
        { msg: 'login ok' },
        { msg: 'token=abc123-deadbeef' },
      ],
    }) as { events: Array<{ msg: string }> };

    assert.equal(out.events[0].msg, 'login ok');
    assert.ok(!out.events[1].msg.includes('abc123-deadbeef'), 'nested token leaked');
  });

  test('safe on circular references — does not infinite-loop', () => {
    type Cyclic = { name: string; self?: Cyclic; nested?: { back: Cyclic } };
    const root: Cyclic = { name: 'root' };
    root.self = root;
    root.nested = { back: root };

    // The bug we're guarding against is infinite recursion / stack overflow.
    // If `redactObject` ever throws / hangs here, the test runner aborts.
    const out = redactObject(root) as { name: string; self: unknown; nested: { back: unknown } };
    assert.equal(out.name, 'root');
    // Cycles must be replaced by a sentinel, NOT the original reference.
    assert.equal(out.self, '<circular>');
    assert.equal(out.nested.back, '<circular>');
  });

  test('preserves number / boolean / null / undefined / bigint', () => {
    const input = {
      count: 42,
      ok: true,
      missing: null,
      undef: undefined,
      big: BigInt(9007199254740993),
      name: 'plain',
    };
    const out = redactObject(input) as typeof input;
    assert.equal(out.count, 42);
    assert.equal(typeof out.count, 'number');
    assert.equal(out.ok, true);
    assert.equal(typeof out.ok, 'boolean');
    assert.equal(out.missing, null);
    assert.equal(out.undef, undefined);
    assert.equal(out.big, BigInt(9007199254740993));
    assert.equal(typeof out.big, 'bigint');
    assert.equal(out.name, 'plain');
  });

  test('returns primitives passed at the root unchanged', () => {
    assert.equal(redactObject(42), 42);
    assert.equal(redactObject(true), true);
    assert.equal(redactObject(null), null);
    assert.equal(redactObject(undefined), undefined);
    assert.equal(redactObject('clean string'), 'clean string');
  });

  test('returns redacted string when called with a root string', () => {
    const out = redactObject('Authorization: Bearer xyz') as string;
    assert.match(out, /Authorization: Bearer \*\*\*/);
  });

  test('does not mutate the input object', () => {
    const input = {
      apiKey: 'sk-prismer-live-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      nested: { key: 'sk-prismer-test-aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899' },
    };
    const snapshot = JSON.stringify(input);
    redactObject(input);
    assert.equal(JSON.stringify(input), snapshot, 'input was mutated');
  });
});
