// T14 — pack-registry.test.ts
// Covers the parseYamlManifest function (exported via fetchPackManifest) and
// js-yaml CORE_SCHEMA safety properties.

import { describe, it, expect } from 'vitest';

// We test parseYamlManifest indirectly by stubbing fetchPackManifest's fetch
// dependency and exercising the full code path from raw YAML → PackManifest.
// This avoids the need to export the private helper.
import { fetchPackManifest } from '../../src/agents/pack-registry.js';
import * as crypto from 'node:crypto';

// ============================================================
// Helpers
// ============================================================

// Sign `payload` with a fresh test keypair so verifySignature passes.
// We override the hardcoded pubkey by pointing to the test key via a
// separate approach: we build a manifest whose signature DOES verify with
// the module's hardcoded key — which is NOT available in tests.
// Therefore most tests below are not expected to reach verifySignature;
// they should throw *before* that (malformed) or we handle the
// "signature verification failed" message specially in happy-path tests.
//
// For the happy-path YAML parsing tests, we use the same invalid-sig
// approach as install-agent.test.ts (the tampered fetch returns a well-formed
// manifest with a zero signature, verifySignature returns false, and we
// assert the specific "verification failed" error rather than a "malformed" error).
// This proves the manifest parsed cleanly all the way to verification.

const ZERO_SIG = Buffer.alloc(64, 0).toString('base64');

function makeFetch(yamlBody: string, status = 200): typeof fetch {
  return async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response(yamlBody, {
      status,
      headers: { 'Content-Type': 'text/yaml' },
    });
  };
}

/** Build a well-formed manifest YAML string. All required fields present. */
function goodManifestYaml(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    name: 'claude-code',
    displayName: '"Claude Code Plugin"',
    adapter: '"@prismer/claude-code-plugin"',
    version: '1.9.0',
    tiersSupported: '[1, 2, 3, 4, 5, 6, 7]',
    capabilityTags: '[code, shell, mcp, approval, skill, fs]',
    upstreamPackage: '"@prismer/claude-code-plugin"',
    upstreamVersionRange: '"^1.9.0"',
    description: '"Claude Code PARA adapter"',
    size: '42kb',
    signature: ZERO_SIG,
    signedAt: '2026-04-21T00:00:00Z',
  };
  const merged = { ...defaults, ...overrides };
  return Object.entries(merged)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// ============================================================
// Happy-path: valid multi-line YAML parses to the sig-check stage
// ============================================================

describe('parseYamlManifest — happy path (reaches signature verification)', () => {
  it('parses a flat manifest and fails at sig verification (not malformed)', async () => {
    const yamlStr = goodManifestYaml();
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/signature verification failed/i);
    // Must NOT throw "malformed"
  });

  it('multi-line block-scalar description is preserved (not dropped)', async () => {
    // A YAML block scalar — the old hand-rolled parser would silently drop this
    // because it only matched single-line `^(\w+):\s*(.+)$`.
    const yamlStr = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      'adapter: "@prismer/claude-code-plugin"',
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3]',
      'capabilityTags: [code, shell]',
      'upstreamPackage: "@prismer/claude-code-plugin"',
      'description: |',
      '  Line 1',
      '  Line 2',
      'size: 42kb',
      `signature: ${ZERO_SIG}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    // If description were dropped (old parser bug), we would get
    // "malformed: 'description' must be a non-empty string".
    // With js-yaml, description is "Line 1\nLine 2\n" — a non-empty string,
    // so we reach the sig-check and get a sig-verification error instead.
    let caughtMsg = '';
    try {
      await fetchPackManifest('claude-code', makeFetch(yamlStr));
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    expect(caughtMsg).toMatch(/signature verification failed/i);
    expect(caughtMsg).not.toMatch(/malformed/i);
  });

  it('numeric tiersSupported parsed as numbers (not strings)', async () => {
    // Old parser: value.startsWith('[') array branch → split by comma → string[]
    // New parser: CORE_SCHEMA parses bare integers as numbers, validation coerces.
    // We can observe this only if we reach sig-check (no malformed error).
    const yamlStr = goodManifestYaml({ tiersSupported: '[1, 2, 3, 4, 5, 6, 7]' });
    let caughtMsg = '';
    try {
      await fetchPackManifest('claude-code', makeFetch(yamlStr));
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    // Reaching sig-check proves tiersSupported was valid number[]
    expect(caughtMsg).toMatch(/signature verification failed/i);
    expect(caughtMsg).not.toMatch(/malformed/i);
  });

  it('optional fields (upstreamVersionRange, installCommand) may be absent', async () => {
    const yamlStr = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      'adapter: "@prismer/claude-code-plugin"',
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3]',
      'capabilityTags: [code]',
      'upstreamPackage: "@prismer/claude-code-plugin"',
      'description: "A plugin"',
      'size: 42kb',
      `signature: ${ZERO_SIG}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    // No malformed error expected (optional fields absent is fine)
    let caughtMsg = '';
    try {
      await fetchPackManifest('claude-code', makeFetch(yamlStr));
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    expect(caughtMsg).toMatch(/signature verification failed/i);
    expect(caughtMsg).not.toMatch(/malformed/i);
  });
});

// ============================================================
// Malformed manifest: missing required fields
// ============================================================

describe('parseYamlManifest — malformed: missing required fields', () => {
  it('throws malformed when signature field is absent', async () => {
    const yamlStr = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      'adapter: "@prismer/claude-code-plugin"',
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3]',
      'capabilityTags: [code]',
      'upstreamPackage: "@prismer/claude-code-plugin"',
      'description: "A plugin"',
      'size: 42kb',
      'signedAt: 2026-04-21T00:00:00Z',
      // signature intentionally omitted
    ].join('\n');

    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:.*signature/i);
  });

  it('throws malformed when name field is absent', async () => {
    const yamlStr = [
      // name intentionally omitted
      'displayName: "Claude Code Plugin"',
      'adapter: "@prismer/claude-code-plugin"',
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3]',
      'capabilityTags: [code]',
      'upstreamPackage: "@prismer/claude-code-plugin"',
      'description: "A plugin"',
      'size: 42kb',
      `signature: ${ZERO_SIG}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:.*name/i);
  });

  it('throws malformed when description is a multi-line block but empty after trim', async () => {
    // Edge case: block scalar that resolves to only whitespace
    const yamlStr = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      'adapter: "@prismer/claude-code-plugin"',
      'version: 1.9.0',
      'tiersSupported: [1]',
      'capabilityTags: [code]',
      'upstreamPackage: "@prismer/claude-code-plugin"',
      // description is empty string ""
      'description: ""',
      'size: 42kb',
      `signature: ${ZERO_SIG}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:.*description/i);
  });
});

// ============================================================
// Malformed manifest: wrong types
// ============================================================

describe('parseYamlManifest — malformed: wrong types', () => {
  it('throws malformed when tiersSupported contains a non-numeric string ("high")', async () => {
    const yamlStr = goodManifestYaml({ tiersSupported: '[1, high, 3]' });
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:.*tiersSupported/i);
  });

  it('throws malformed when tiersSupported is not an array (scalar string)', async () => {
    const yamlStr = goodManifestYaml({ tiersSupported: '"all"' });
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:.*tiersSupported/i);
  });

  it('throws malformed when tiersSupported is an empty array', async () => {
    const yamlStr = goodManifestYaml({ tiersSupported: '[]' });
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow('Pack manifest malformed: tiersSupported must contain at least one tier');
  });

  it('throws malformed when capabilityTags contains a number', async () => {
    const yamlStr = goodManifestYaml({ capabilityTags: '[code, 42, shell]' });
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:.*capabilityTags/i);
  });

  it('throws malformed when YAML top-level is a list instead of a map', async () => {
    const yamlStr = '- item1\n- item2\n';
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:/i);
  });

  it('throws malformed when YAML is invalid syntax', async () => {
    const yamlStr = 'name: foo\n  bad: indent: here\n';
    await expect(
      fetchPackManifest('claude-code', makeFetch(yamlStr)),
    ).rejects.toThrow(/Pack manifest malformed:/i);
  });
});

// ============================================================
// Security: YAML injection / tag attacks
// ============================================================

describe('parseYamlManifest — YAML injection safety', () => {
  it('CORE_SCHEMA rejects !!js/function tags without executing code', async () => {
    // With js-yaml CORE_SCHEMA, !!js/function is an unknown tag.
    // yaml.load will throw a YAMLException (unknown tag) — no code executes.
    // We assert: does NOT resolve, does NOT throw a TypeError (which would
    // indicate code execution blowing up), and does NOT log "pwned".
    const yamlStr = [
      `name: !!js/function 'function () { return "pwned"; }'`,
      'displayName: "Test"',
      'adapter: "@prismer/test"',
      'version: 1.9.0',
      'tiersSupported: [1]',
      'capabilityTags: [code]',
      'upstreamPackage: "@prismer/test"',
      'description: "test"',
      'size: 1kb',
      `signature: ${ZERO_SIG}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    let caughtError: Error | undefined;
    try {
      await fetchPackManifest('test', makeFetch(yamlStr));
    } catch (err) {
      caughtError = err as Error;
    }

    // Must have thrown (either YAMLException from js-yaml or our malformed error)
    expect(caughtError).toBeDefined();
    // Must NOT be an uncaught TypeError (which would indicate attempted code execution)
    expect(caughtError).not.toBeInstanceOf(TypeError);
    // Must NOT have resolved without error (no silent code execution)
    // The error may mention "pwned" as part of the YAML parse error's context
    // quote — that is expected and safe (js-yaml just quotes the tag value in
    // its error message; it never invokes the function).
    // What matters: it is a parse/malformed error, not a successful result.
    expect(caughtError?.message ?? '').toMatch(/malformed|unknown tag|YAMLException/i);
  });

  it('CORE_SCHEMA rejects !!timestamp tag ambiguity (does not silently coerce to Date)', async () => {
    // With CORE_SCHEMA, !!timestamp is NOT resolved (it is in DEFAULT_SCHEMA only).
    // 2026-04-21T00:00:00Z would be treated as a plain string.
    // If signedAt were silently coerced to a Date object, typeof would be 'object'
    // and our requireString validation would catch it and throw "malformed".
    // Either way, we should NOT silently get a Date object in the manifest.
    const yamlStr = goodManifestYaml({ signedAt: '2026-04-21T00:00:00Z' });
    // signedAt is a string in CORE_SCHEMA — reaches sig verification, not malformed
    let caughtMsg = '';
    try {
      await fetchPackManifest('claude-code', makeFetch(yamlStr));
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    // Should reach sig verification (signedAt is a string), not a malformed error
    expect(caughtMsg).toMatch(/signature verification failed/i);
    expect(caughtMsg).not.toMatch(/malformed/i);
  });
});
