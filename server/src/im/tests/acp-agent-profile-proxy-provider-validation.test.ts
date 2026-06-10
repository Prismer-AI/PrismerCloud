/**
 * release202/12 finding C2 — validate provider-chain id at agent-profile write time.
 *
 * Guards `validateProxyProvider` (the pure helper that POST /agent_profiles and
 * PATCH /agent_profiles/:id call before persisting `config`). The bug class:
 * a typo'd / stale `config.proxyProvider` (e.g. `deepsek`, or a chain id that no
 * longer maps to a configured chain) was persisted VERBATIM. At runtime
 * `resolveChain` silently falls back to `default`, so the user's explicit pick
 * is ignored with no error and the UI shows a chain that isn't really used.
 *
 * Contracts asserted (all against the BUILT-IN chain registry — env-absent path,
 * which exposes chains `default`, `newapi`, `deepseek`):
 *   (a) a known chain id (default / newapi / deepseek) → accepted (null error)
 *   (b) an unknown chain id (`bogus-chain`, `deepsek`) → rejected (error string)
 *   (c) absent / empty / null proxyProvider → unaffected (null error)
 *   (d) non-string proxyProvider → rejected (defensive)
 *   (e) the error string the handler surfaces in the 400 body is the helper's
 *       return value, matching the `{ ok:false, error:{ code, message } }` shape.
 *
 * Self-contained (no DB / no server). Run:
 *   npx tsx src/im/tests/acp-agent-profile-proxy-provider-validation.test.ts
 */

import assert from 'node:assert/strict';
import { validateProxyProvider } from '../api/agent-profiles';
import { getProviderChainIds } from '../../lib/llm/provider-sources';

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function main() {
  // Built-in registry (env-absent) advertises exactly these chains.
  const known = getProviderChainIds();
  console.log(`\nKnown chain ids: ${known.join(', ')}`);
  assert.ok(known.includes('default'), 'precondition: built-in chains include `default`');
  assert.ok(known.includes('newapi'), 'precondition: built-in chains include `newapi`');
  assert.ok(known.includes('deepseek'), 'precondition: built-in chains include `deepseek`');

  // (a) known chain ids → accepted (null = no error)
  for (const id of ['default', 'newapi', 'deepseek']) {
    check(`(a) known chain "${id}" accepted`, () => {
      assert.equal(validateProxyProvider({ proxyProvider: id }), null);
    });
  }

  // (b) unknown chain ids → rejected (non-null error string mentioning the id)
  for (const id of ['bogus-chain', 'deepsek']) {
    check(`(b) unknown chain "${id}" rejected`, () => {
      const err = validateProxyProvider({ proxyProvider: id });
      assert.equal(typeof err, 'string', 'expected an error string');
      assert.ok(err!.includes(id), `error should name the offending id "${id}"`);
    });
  }

  // (c) absent / empty / null proxyProvider → unaffected (null)
  check('(c) absent proxyProvider unaffected', () => {
    assert.equal(validateProxyProvider({ model: 'us-kimi-k2.6' }), null);
  });
  check('(c) empty-string proxyProvider unaffected', () => {
    assert.equal(validateProxyProvider({ proxyProvider: '' }), null);
  });
  check('(c) null proxyProvider unaffected', () => {
    assert.equal(validateProxyProvider({ proxyProvider: null }), null);
  });
  check('(c) empty config unaffected', () => {
    assert.equal(validateProxyProvider({}), null);
  });
  check('(c) non-object config unaffected', () => {
    assert.equal(validateProxyProvider(undefined), null);
    assert.equal(validateProxyProvider(null), null);
    assert.equal(validateProxyProvider('nope'), null);
  });

  // (d) non-string proxyProvider → rejected (defensive)
  check('(d) numeric proxyProvider rejected', () => {
    const err = validateProxyProvider({ proxyProvider: 42 });
    assert.equal(typeof err, 'string');
  });

  // (e) model is NOT validated — only proxyProvider is gated.
  check('(e) bogus model alone (no proxyProvider) is NOT rejected', () => {
    assert.equal(validateProxyProvider({ model: 'totally-made-up-model' }), null);
  });
  check('(e) bogus model with VALID proxyProvider is NOT rejected', () => {
    assert.equal(validateProxyProvider({ proxyProvider: 'newapi', model: 'totally-made-up-model' }), null);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
