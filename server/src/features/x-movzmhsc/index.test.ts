/**
 * X-movzmhsc Feature Tests
 * MVP M3/M4 Smoke Test Verification
 */

import { describe, it, expect } from 'vitest';
import { executeMovzmhsc, verifyMovzmhsc, X_MOVZMHSC_VERSION, X_MOVZMHSC_TAG } from './index';

describe('X-movzmhsc Smoke Test', () => {
  it('should have correct version and tag constants', () => {
    expect(X_MOVZMHSC_VERSION).toBe('1.0.0');
    expect(X_MOVZMHSC_TAG).toBe('movzmhsc');
  });

  it('should execute smoke test with valid config', () => {
    const config = {
      id: 'cmovznc0o000nxzviz1jdv9j3',
      targetDaemonId: 'daemon-movzmhsc-test',
      mode: 'm4-active' as const,
      executedAt: new Date('2026-05-07T21:18:32.856Z'),
    };

    const result = executeMovzmhsc(config);

    expect(result.success).toBe(true);
    expect(result.token).toBe('M4OK-movzmhsc');
    expect(result.metadata.version).toBe('1.0.0');
    expect(result.metadata.tag).toBe('movzmhsc');
    expect(result.metadata.mode).toBe('m4-active');
    expect(result.metadata.timestamp).toBe('2026-05-07T21:18:32.856Z');
  });

  it('should execute smoke test with m3-fallback mode', () => {
    const config = {
      id: 'test-m3-fallback',
      targetDaemonId: 'daemon-test-123',
      mode: 'm3-fallback' as const,
      executedAt: new Date(),
    };

    const result = executeMovzmhsc(config);

    expect(result.success).toBe(true);
    expect(result.token).toBe('M4OK-movzmhsc');
    expect(result.metadata.mode).toBe('m3-fallback');
  });

  it('should throw error for invalid config', () => {
    expect(() => {
      executeMovzmhsc({
        id: '',
        targetDaemonId: '',
        mode: 'm4-active' as const,
        executedAt: new Date(),
      });
    }).toThrow('X-movzmhsc: Invalid configuration');
  });

  it('should verify valid result', () => {
    const validResult = {
      success: true,
      token: 'M4OK-movzmhsc',
      metadata: {
        version: '1.0.0',
        tag: 'movzmhsc',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovzmhsc(validResult)).toBe(true);
  });

  it('should reject result with wrong token', () => {
    const invalidResult = {
      success: true,
      token: 'M4OK-wrong-tag',
      metadata: {
        version: '1.0.0',
        tag: 'movzmhsc',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovzmhsc(invalidResult)).toBe(false);
  });

  it('should reject result with wrong tag in metadata', () => {
    const invalidResult = {
      success: true,
      token: 'M4OK-movzmhsc',
      metadata: {
        version: '1.0.0',
        tag: 'wrong-tag',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovzmhsc(invalidResult)).toBe(false);
  });

  it('should reject result with success=false', () => {
    const failedResult = {
      success: false,
      token: 'M4OK-movzmhsc',
      metadata: {
        version: '1.0.0',
        tag: 'movzmhsc',
        mode: 'm4-active',
        timestamp: new Date().toISOString(),
      },
    };

    expect(verifyMovzmhsc(failedResult)).toBe(false);
  });
});
