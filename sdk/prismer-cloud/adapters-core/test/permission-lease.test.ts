import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionLeaseManager } from '../src/permission-lease.js';
import type { PermissionRule } from '@prismer/wire';

const rule = (source: PermissionRule['source'], tool: string): PermissionRule => ({
  source,
  behavior: 'allow',
  value: { tool },
});

describe('PermissionLeaseManager', () => {
  let mgr: PermissionLeaseManager;

  beforeEach(() => {
    mgr = new PermissionLeaseManager();
  });

  it('grant → active reflects the granted rules', () => {
    const rules = [rule('skill', 'Bash(npm *)'), rule('skill', 'Read')];
    mgr.grant('my-skill', rules);
    expect(mgr.active()).toEqual(rules);
  });

  it('revoke returns the previously-granted rules', () => {
    const rules = [rule('skill', 'Edit')];
    mgr.grant('my-skill', rules);
    const returned = mgr.revoke('my-skill');
    expect(returned).toEqual(rules);
  });

  it('after revoke, skill is no longer active', () => {
    mgr.grant('my-skill', [rule('skill', 'Edit')]);
    mgr.revoke('my-skill');
    expect(mgr.active()).toEqual([]);
    expect(mgr.has('my-skill')).toBe(false);
  });

  it('re-grant replaces rules (not append)', () => {
    mgr.grant('my-skill', [rule('skill', 'Edit')]);
    mgr.grant('my-skill', [rule('skill', 'Bash'), rule('skill', 'Write')]);
    expect(mgr.active()).toEqual([rule('skill', 'Bash'), rule('skill', 'Write')]);
    expect(mgr.active()).toHaveLength(2);
  });

  it('revoke of unknown skill is a no-op returning []', () => {
    const result = mgr.revoke('nonexistent');
    expect(result).toEqual([]);
  });

  it('active() aggregates rules across 3 skills', () => {
    mgr.grant('skill-a', [rule('skill', 'Read')]);
    mgr.grant('skill-b', [rule('skill', 'Edit')]);
    mgr.grant('skill-c', [rule('skill', 'Bash')]);
    const active = mgr.active();
    expect(active).toHaveLength(3);
    expect(active.map((r) => r.value.tool)).toContain('Read');
    expect(active.map((r) => r.value.tool)).toContain('Edit');
    expect(active.map((r) => r.value.tool)).toContain('Bash');
  });

  it('has() returns true for active lease, false for unknown', () => {
    mgr.grant('skill-x', [rule('skill', 'Glob')]);
    expect(mgr.has('skill-x')).toBe(true);
    expect(mgr.has('skill-y')).toBe(false);
  });

  it('clear() removes all leases', () => {
    mgr.grant('skill-a', [rule('skill', 'Read')]);
    mgr.grant('skill-b', [rule('skill', 'Edit')]);
    mgr.clear();
    expect(mgr.active()).toEqual([]);
    expect(mgr.has('skill-a')).toBe(false);
    expect(mgr.has('skill-b')).toBe(false);
  });

  it('grant with empty rules array is valid', () => {
    mgr.grant('empty-skill', []);
    expect(mgr.has('empty-skill')).toBe(true);
    expect(mgr.active()).toEqual([]);
  });

  it('revoke after re-grant returns the NEW rules', () => {
    mgr.grant('skill', [rule('skill', 'Old')]);
    mgr.grant('skill', [rule('skill', 'New')]);
    const returned = mgr.revoke('skill');
    expect(returned).toEqual([rule('skill', 'New')]);
  });
});
