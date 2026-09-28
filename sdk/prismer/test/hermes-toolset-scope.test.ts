// release203/16 §3 — per-role Hermes toolset scope (allow+deny) math.
//   resolveToolsetScope    (top-level vs roleTemplate snapshot precedence)
//   computeDisabledToolsets (deny = listed; allow = ALL_KNOWN − listed)
// Projection target: config.yaml agent.disabled_toolsets (hermes-agent
// agent/agent_init.py:457 + hermes_cli/tools_config.py:1353-1360).
import { describe, expect, it } from 'vitest';
import {
  computeDisabledToolsets,
  resolveToolsetScope,
} from '../src/adapters/persistence/hermes/index.js';

// A tiny stand-in toolset universe for deterministic allow-mode math.
const ALL = ['web', 'terminal', 'file', 'browser', 'memory', 'skills'] as const;

describe('resolveToolsetScope — precedence', () => {
  it('top-level config wins over roleTemplate snapshot', () => {
    const scope = resolveToolsetScope({
      toolsetScope: { mode: 'allow', toolsets: ['web', 'file'] },
      roleTemplate: { toolsetScope: { mode: 'deny', toolsets: ['terminal'] } } as never,
    });
    expect(scope).toEqual({ mode: 'allow', toolsets: ['web', 'file'] });
  });

  it('falls back to roleTemplate snapshot when no top-level', () => {
    const scope = resolveToolsetScope({
      roleTemplate: { toolsetScope: { mode: 'deny', toolsets: ['terminal'] } } as never,
    });
    expect(scope).toEqual({ mode: 'deny', toolsets: ['terminal'] });
  });

  it('null when neither present', () => {
    expect(resolveToolsetScope({})).toBeNull();
  });
});

describe('computeDisabledToolsets', () => {
  it('no scope → empty (Hermes default, no restriction)', () => {
    expect(computeDisabledToolsets(null, ALL)).toEqual([]);
  });

  it('deny → exactly the listed toolsets', () => {
    const out = computeDisabledToolsets({ mode: 'deny', toolsets: ['terminal', 'browser'] }, ALL);
    expect(out.sort()).toEqual(['browser', 'terminal']);
  });

  it('allow keep-only → every known toolset NOT allowed is disabled', () => {
    const out = computeDisabledToolsets({ mode: 'allow', toolsets: ['web', 'file'] }, ALL);
    expect(out).not.toContain('web'); // allowed
    expect(out).not.toContain('file'); // allowed
    expect(out.sort()).toEqual(['browser', 'memory', 'skills', 'terminal']);
  });

  it('allow with an unknown toolset name → ignored (cannot subtract a non-member)', () => {
    const out = computeDisabledToolsets({ mode: 'allow', toolsets: ['web', 'does-not-exist'] }, ALL);
    expect(out).not.toContain('web');
    expect(out).not.toContain('does-not-exist');
    expect(out.sort()).toEqual(['browser', 'file', 'memory', 'skills', 'terminal']);
  });

  it('empty toolsets list: deny → no-op, allow → disable everything', () => {
    expect(computeDisabledToolsets({ mode: 'deny', toolsets: [] }, ALL)).toEqual([]);
    expect(computeDisabledToolsets({ mode: 'allow', toolsets: [] }, ALL).sort()).toEqual([...ALL].sort());
  });

  it('defaults to the real HERMES_ALL_TOOLSETS registry when no universe passed', () => {
    // deny never needs the registry — exact regardless.
    expect(computeDisabledToolsets({ mode: 'deny', toolsets: ['terminal'] })).toEqual(['terminal']);
    // allow against the real 33-name registry: terminal must be among the disabled.
    const out = computeDisabledToolsets({ mode: 'allow', toolsets: ['web', 'file', 'memory'] });
    expect(out).toContain('terminal');
    expect(out).not.toContain('web');
  });
});
