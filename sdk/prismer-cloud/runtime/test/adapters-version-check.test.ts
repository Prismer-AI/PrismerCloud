// Release 201 v2.0.7 P1 — adapter binary version pinning regression.

import { describe, test, expect } from 'vitest';
import {
  compareSemver,
  isVersionInRange,
  parseVersionFromStdout,
} from '../src/adapters/version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../src/adapters/known-versions.js';

describe('adapter version check (P1)', () => {
  test('compareSemver basic', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  test('compareSemver treats missing segments as zero', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('2', '1.99.99')).toBe(1);
  });

  test('compareSemver handles four-segment versions', () => {
    expect(compareSemver('2026.4.1.2', '2026.4.1.1')).toBe(1);
    expect(compareSemver('2026.4.0', '2026.4.0.1')).toBe(-1);
  });

  test('isVersionInRange soft-pass for unknown', () => {
    expect(isVersionInRange('unknown', '1.0.0')).toBe(true);
  });

  test('isVersionInRange soft-pass for 0.0.0 floor (unpinned)', () => {
    expect(isVersionInRange('0.9.0', '0.0.0')).toBe(true);
    expect(isVersionInRange('unknown', '0.0.0')).toBe(true);
  });

  test('isVersionInRange strict above min', () => {
    expect(isVersionInRange('1.2.0', '1.0.0')).toBe(true);
    expect(isVersionInRange('0.9.9', '1.0.0')).toBe(false);
  });

  test('isVersionInRange strips pre-release tags', () => {
    expect(isVersionInRange('1.2.3-rc1', '1.0.0')).toBe(true);
    expect(isVersionInRange('2.0.0-rc1', '2.0.0')).toBe(true);
    expect(isVersionInRange('1.9.9-rc1', '2.0.0')).toBe(false);
  });

  test('isVersionInRange strips build metadata', () => {
    expect(isVersionInRange('2.0.0+sha.abc', '2.0.0')).toBe(true);
  });

  test('parseVersionFromStdout common formats', () => {
    expect(parseVersionFromStdout('hermes 1.2.3')).toBe('1.2.3');
    expect(parseVersionFromStdout('codex CLI v0.45.2\n')).toBe('0.45.2');
    expect(parseVersionFromStdout('claude-code 2.0.0-rc1 (build abc123)')).toBe('2.0.0-rc1');
    expect(parseVersionFromStdout('openclaw 2026.4.5')).toBe('2026.4.5');
  });

  test('parseVersionFromStdout returns unknown when no semver found', () => {
    expect(parseVersionFromStdout('no version here')).toBe('unknown');
    expect(parseVersionFromStdout('')).toBe('unknown');
  });

  test('ADAPTER_KNOWN_VERSIONS shape', () => {
    const required = ['hermes', 'codex', 'claude-code', 'openclaw'];
    for (const name of required) {
      const v = ADAPTER_KNOWN_VERSIONS[name];
      expect(v, `missing pin for ${name}`).toBeTruthy();
      expect(v!.minVersion, `${name}.minVersion`).toBeTruthy();
      expect(v!.knownGood, `${name}.knownGood`).toBeTruthy();
    }
  });

  test('openclaw is pinned (real binary CLI we have validated)', () => {
    const v = ADAPTER_KNOWN_VERSIONS.openclaw!;
    expect(v.minVersion).toBe('2026.4.0');
    // knownGood is the rev exercised by the cookbook + CI smoke;
    // keep the assertion loose so a routine bump doesn't break tests.
    expect(v.knownGood.startsWith('2026.4')).toBe(true);
  });

  test('claude-code pins at least the Wave-4 2.x flag-set floor', () => {
    const v = ADAPTER_KNOWN_VERSIONS['claude-code']!;
    expect(compareSemver(v.minVersion, '2.0.0')).toBeGreaterThanOrEqual(0);
  });
});
