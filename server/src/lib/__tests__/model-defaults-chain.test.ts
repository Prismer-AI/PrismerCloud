/**
 * release202/12 C1 + C3 — model-default consistency for the UNBOUNDED
 * provider-chain world.
 *
 * C1: switching `proxyProvider` to ANY chain (including a custom, operator-
 *     configured one) must resolve a real, non-undefined default model.
 *     `getDefaultModelForProvider` derives it from the fetched chain list
 *     (`primaryDefaultModel`), falling back to the built-in funnels.
 *
 * C3: the model-id defaults are single-sourced from `provider-sources.ts`
 *     within `src/app` + `src/lib`. The `src/lib`↔`sdk/runtime` copy is
 *     structurally unmergeable (runtime can't import src/), so this test
 *     cross-checks the two vision-model lists by reading their literal values
 *     — any drift fails CI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getDefaultModelForProvider, type ProviderChainDefault } from '../../app/workspace/lib/model-defaults';
import { NEWAPI_DEFAULT_MODEL, DEEPSEEK_DEFAULT_MODEL } from '../llm/provider-sources';

// vitest runs from the repo root (no reliable __dirname in ESM).
const REPO_ROOT = process.cwd();

/**
 * Extract the single-quoted string literals from the array/Set literal that
 * follows the anchor. Anchors past the `=` first so a `readonly string[]` type
 * annotation's empty `[]` isn't mistaken for the literal.
 */
function extractIds(source: string, anchor: RegExp): string[] {
  const start = source.search(anchor);
  if (start < 0) throw new Error(`anchor not found: ${anchor}`);
  const eq = source.indexOf('=', start);
  const open = source.indexOf('[', eq);
  const close = source.indexOf(']', open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('release202/12 C1 — chain-aware default model resolution', () => {
  it('built-in providers keep their hardcoded defaults (no chains arg)', () => {
    // Backward-compat contract relied on by the Pro tiles + Simple wizard.
    expect(getDefaultModelForProvider('newapi')).toBe(NEWAPI_DEFAULT_MODEL);
    expect(getDefaultModelForProvider('deepseek')).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(getDefaultModelForProvider('default')).toBe(NEWAPI_DEFAULT_MODEL);
  });

  it('a CUSTOM chain resolves to its primaryDefaultModel (never undefined)', () => {
    const chains: ProviderChainDefault[] = [
      { id: 'newapi', primaryDefaultModel: NEWAPI_DEFAULT_MODEL },
      { id: 'deepseek', primaryDefaultModel: DEEPSEEK_DEFAULT_MODEL },
      { id: 'acme-openrouter', primaryDefaultModel: 'anthropic/claude-x' },
    ];
    const resolved = getDefaultModelForProvider('acme-openrouter', chains);
    expect(resolved).toBe('anthropic/claude-x');
    expect(resolved).not.toBeUndefined();
  });

  it('unknown chain with no primaryDefaultModel falls back to a stable string (never undefined)', () => {
    const chains: ProviderChainDefault[] = [{ id: 'broken-chain', primaryDefaultModel: null }];
    const resolved = getDefaultModelForProvider('broken-chain', chains);
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('chain default wins over the built-in map for the same id', () => {
    const chains: ProviderChainDefault[] = [{ id: 'newapi', primaryDefaultModel: 'operator-pinned-model' }];
    expect(getDefaultModelForProvider('newapi', chains)).toBe('operator-pinned-model');
  });
});

describe('release202/12 C3 — src/lib ↔ sdk/runtime vision-model parity', () => {
  it('BUILTIN_VISION_MODELS (src/lib) equals VISION_CAPABLE_MODELS (runtime hermes adapter)', () => {
    const libSrc = readFileSync(join(REPO_ROOT, 'src/lib/llm/provider-sources.ts'), 'utf8');
    const runtimeSrc = readFileSync(
      join(REPO_ROOT, 'sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts'),
      'utf8',
    );

    const libIds = extractIds(libSrc, /BUILTIN_VISION_MODELS\s*:\s*readonly/);
    const runtimeIds = extractIds(runtimeSrc, /VISION_CAPABLE_MODELS\s*=\s*new Set/);

    expect(libIds.length).toBeGreaterThan(0);
    expect(runtimeIds.length).toBeGreaterThan(0);
    // Order-insensitive set equality so reordering a list doesn't false-fail.
    expect(new Set(runtimeIds)).toEqual(new Set(libIds));
  });

  it('newapi default model (src/lib NEWAPI_DEFAULT_MODEL) equals the runtime hermes zod default', () => {
    // C3 — the platform default model id is mirrored in the runtime adapter
    // (runtime can't import src/lib). Catch drift: the hermes profile-config zod
    // schema defaults `model` to the same id as NEWAPI_DEFAULT_MODEL.
    const runtimeSrc = readFileSync(
      join(REPO_ROOT, 'sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts'),
      'utf8',
    );
    const m = runtimeSrc.match(/model:\s*z\.string\(\)[^\n]*\.default\(\s*['"]([^'"]+)['"]\s*\)/);
    expect(m, 'could not find the hermes model zod default — update this parity test').toBeTruthy();
    expect(m![1]).toBe(NEWAPI_DEFAULT_MODEL);
  });
});
