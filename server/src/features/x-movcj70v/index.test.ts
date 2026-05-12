/**
 * X-movcj70v Feature Tests
 * MVP M3/M4 Smoke Test Verification
 */

import { describe, it, expect } from 'vitest';
import { executeMovcj70v, verifyMovcj70v, X_MOVCJ70V_VERSION, X_MOVCJ70V_TAG } from './index';

describe('X-movcj70v Smoke Test', () => {
  it('should have correct version and tag constants', () => {
    expect(X_MOVCJ70V_VERSION).toBe('1.0.0');
    expect(X_MOVCJ70V_TAG).toBe('movcj70v');
  });

  it('should execute smoke test with valid config', () => {
    const config = {
      id: 'cmovcjy0w01a9xzly24tnklix',
      targetDaemonId: 'daemon-f82bbcda-24df-48e4-8e8b-2234b55a8fa8',
      mode: 'm4-active' as const,
      executedAt: new Date('2026-05-07T10:32:03.585Z'),
    };

    const result = executeMovcj70v(config);

    expect(result.success).toBe(true);
    expect(result.token).toBe('M4OK-movcj70v');
    expect(result.metadata.version).toBe('1.0.0');
    expect(result.metadata.tag).toBe('movcj70v');
    expect(result.metadata.mode).toBe('m4-active');
    expect(result.metadata.timestamp).toBe('2026-05-07T10:32:03.585Z');
  });

  it('should execute smoke test with m3-fallback mode', () => {
    const config = {
      id: 'test-m3-fallback',
      targetDaemonId: 'daemon-test-123',
      mode: 'm3-fallback' as const,
      executedAt: new Date(),
    };

    const result = executeMovcj70v(config);

    expect(result.success).toBe(true);
    expect(result.token).toBe('M4OK-movcj70v');
    expect(result.metadata.mode).toBe('m3-fallback');
  });

  it('should throw error for invalid config', () => {
    expect(() => {
      executeMovcj70v({
        id: '',
        targetDaemonId: '',
        mode: 'm4-active' as const,
        executedAt: new Date(),
      });
    }).toThrow('X-movcj70v: Invalid configuration');
  });

  it('should verify valid result', () => {
    const validResult = {
      success: true,
      token: 'M4OK-movcj70v',
      metadata: {
        version: '1.0.0',
        tag: 'movcj70v',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovcj70v(validResult)).toBe(true);
  });

  it('should reject result with wrong token', () => {
    const invalidResult = {
      success: true,
      token: 'M4OK-wrong-tag',
      metadata: {
        version: '1.0.0',
        tag: 'movcj70v',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovcj70v(invalidResult)).toBe(false);
  });

  it('should reject result with wrong tag in metadata', () => {
    const invalidResult = {
      success: true,
      token: 'M4OK-movcj70v',
      metadata: {
        version: '1.0.0',
        tag: 'wrong-tag',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovcj70v(invalidResult)).toBe(false);
  });

  it('should reject result with success=false', () => {
    const failedResult = {
      success: false,
      token: 'M4OK-movcj70v',
      metadata: {
        version: '1.0.0',
        tag: 'movcj70v',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovcj70v(failedResult)).toBe(false);
  });
});
