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

  test('isVersionInRange soft-passes unknown detected version', () => {
    expect(isVersionInRange('unknown', '1.0.0')).toBe(true);
  });

  test('isVersionInRange soft-passes 0.0.0 placeholder floor', () => {
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
    expect(parseVersionFromStdout('opencode 1.14.46')).toBe('1.14.46');
  });

  test('parseVersionFromStdout returns unknown when no semver found', () => {
    expect(parseVersionFromStdout('no version here')).toBe('unknown');
    expect(parseVersionFromStdout('')).toBe('unknown');
  });

  test('ADAPTER_KNOWN_VERSIONS shape', () => {
    const required = ['hermes', 'codex', 'claude-code'];
    for (const name of required) {
      const v = ADAPTER_KNOWN_VERSIONS[name];
      expect(v, `missing pin for ${name}`).toBeTruthy();
      expect(v!.minVersion, `${name}.minVersion`).toBeTruthy();
      expect(v!.knownGood, `${name}.knownGood`).toBeTruthy();
    }
  });

  test('claude-code pins the claude-agent-sdk control-protocol floor', () => {
    // release203/08: minVersion/knownGood track the @anthropic-ai/claude-agent-sdk
    // control protocol (0.2.x), NOT the CLI binary 2.x (the CLI lives in
    // image-pin.yaml binaries.claude). Floor asserts the sdk-protocol baseline.
    const v = ADAPTER_KNOWN_VERSIONS['claude-code']!;
    expect(compareSemver(v.minVersion, '0.2.0')).toBeGreaterThanOrEqual(0);
  });

  test('claude-code carries an exact CLI binaryPin (M2-1 D1)', () => {
    const v = ADAPTER_KNOWN_VERSIONS['claude-code']!;
    expect(v.binaryPin).toBeTruthy();
    // the CLI binary line is 2.x — distinct from the 0.2.x sdk protocol pin
    expect(compareSemver(v.binaryPin!, '2.0.0')).toBeGreaterThanOrEqual(0);
  });
});
