// release203/13 P1 — per-role Hermes-native skill scope (allow+deny) math.
//   resolveNativeSkillScope (top-level vs roleTemplate snapshot precedence)
//   computeDisabledSkills   (deny = floor ∪ in-scope; allow = keep-only net-body)
import { describe, expect, it } from 'vitest';
import {
  computeDisabledSkills,
  resolveNativeSkillScope,
} from '../src/adapters/persistence/hermes/index.js';

// release203/17 changed computeDisabledSkills' 3rd arg from string[] to a
// CapabilityFloor object ({categories?, skills?}). FLOOR_NAMES is the expected
// disabled output; FLOOR is the object form passed into the function.
const FLOOR_NAMES = ['openhue', 'serving-llms-vllm', 'godmode'] as const;
const FLOOR = { skills: [...FLOOR_NAMES] } as const;

// A tiny stand-in bundle: 2 github, 1 social-media, 1 smart-home.
const BUNDLE = [
  { name: 'github-auth', category: 'github' },
  { name: 'github-pr-workflow', category: 'github' },
  { name: 'xurl', category: 'social-media' },
  { name: 'openhue', category: 'smart-home' },
];

describe('resolveNativeSkillScope — precedence', () => {
  it('top-level config wins over roleTemplate snapshot', () => {
    const scope = resolveNativeSkillScope({
      nativeSkillScope: { mode: 'allow', categories: ['github'] },
      roleTemplate: { nativeSkillScope: { mode: 'deny', categories: ['gaming'] } } as never,
    });
    expect(scope).toEqual({ mode: 'allow', categories: ['github'] });
  });

  it('falls back to roleTemplate snapshot when no top-level', () => {
    const scope = resolveNativeSkillScope({
      roleTemplate: { nativeSkillScope: { mode: 'deny', categories: ['gaming'] } } as never,
    });
    expect(scope).toEqual({ mode: 'deny', categories: ['gaming'] });
  });

  it('null when neither present', () => {
    expect(resolveNativeSkillScope({})).toBeNull();
  });
});

describe('computeDisabledSkills', () => {
  it('no scope → exactly the global floor', () => {
    expect(computeDisabledSkills(null, BUNDLE, FLOOR).sort()).toEqual([...FLOOR_NAMES].sort());
  });

  it('deny by category → floor ∪ expanded category names', () => {
    const out = computeDisabledSkills({ mode: 'deny', categories: ['social-media'] }, BUNDLE, FLOOR);
    expect(out).toContain('xurl'); // social-media expanded
    expect(out).toEqual(expect.arrayContaining([...FLOOR_NAMES])); // floor preserved
    expect(out).not.toContain('github-auth'); // github untouched
  });

  it('deny by explicit skill name', () => {
    const out = computeDisabledSkills({ mode: 'deny', skills: ['github-auth'] }, BUNDLE, FLOOR);
    expect(out).toContain('github-auth');
    expect(out).not.toContain('github-pr-workflow');
  });

  it('allow keep-only → every bundled name NOT in scope disabled', () => {
    const out = computeDisabledSkills({ mode: 'allow', categories: ['github'] }, BUNDLE, FLOOR);
    expect(out).not.toContain('github-auth'); // kept
    expect(out).not.toContain('github-pr-workflow'); // kept
    expect(out).toContain('xurl'); // out of scope → disabled
    expect(out).toContain('openhue'); // out of scope → disabled
  });

  it('allow with explicit skill name kept alongside category', () => {
    const out = computeDisabledSkills({ mode: 'allow', categories: ['github'], skills: ['xurl'] }, BUNDLE, FLOOR);
    expect(out).not.toContain('xurl'); // explicitly allowed
    expect(out).toContain('openhue'); // still out of scope
  });

  it('allow with an unenumerable bundle fail-safes to the floor (never ungoverned)', () => {
    const out = computeDisabledSkills({ mode: 'allow', categories: ['github'] }, [], FLOOR);
    expect(out.sort()).toEqual([...FLOOR_NAMES].sort());
  });
});
