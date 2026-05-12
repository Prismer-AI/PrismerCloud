/**
 * X-movcg8io Smoke Test Suite
 *
 * Tests for MVP M3/M4 work_item dispatch verification
 */

import { describe, it, expect } from 'vitest';
import {
  executeMovcg8io,
  verifyMovcg8io,
  X_MOVCG8IO_VERSION,
  X_MOVCG8IO_TAG,
  type Movcg8ioConfig,
} from '@/features/x-movcg8io';

describe('X-movcg8io Smoke Test', () => {
  const mockConfig: Movcg8ioConfig = {
    id: 'cmovch6js015uxzlyzgh2qtq4',
    targetDaemonId: 'daemon-0867f8f4-2b63-40b6-ab55-575c44c54a42',
    mode: 'm4-active',
    executedAt: new Date('2026-05-07T10:29:54.818Z'),
  };

  describe('Configuration Constants', () => {
    it('should have correct version', () => {
      expect(X_MOVCG8IO_VERSION).toBe('1.0.0');
    });

    it('should have correct tag', () => {
      expect(X_MOVCG8IO_TAG).toBe('movcg8io');
    });
  });

  describe('executeMovcg8io', () => {
    it('should execute successfully with valid config', () => {
      const result = executeMovcg8io(mockConfig);

      expect(result.success).toBe(true);
      expect(result.token).toBe('M4OK-movcg8io');
      expect(result.metadata.version).toBe(X_MOVCG8IO_VERSION);
      expect(result.metadata.tag).toBe(X_MOVCG8IO_TAG);
      expect(result.metadata.mode).toBe('m4-active');
    });

    it('should throw error with invalid config', () => {
      const invalidConfig = { ...mockConfig, id: '' };
      expect(() => executeMovcg8io(invalidConfig)).toThrow('X-movcg8io: Invalid configuration');
    });

    it('should throw error with missing targetDaemonId', () => {
      const invalidConfig = { ...mockConfig, targetDaemonId: '' };
      expect(() => executeMovcg8io(invalidConfig)).toThrow('X-movcg8io: Invalid configuration');
    });

    it('should work with m3-fallback mode', () => {
      const fallbackConfig = { ...mockConfig, mode: 'm3-fallback' as const };
      const result = executeMovcg8io(fallbackConfig);

      expect(result.success).toBe(true);
      expect(result.metadata.mode).toBe('m3-fallback');
    });
  });

  describe('verifyMovcg8io', () => {
    it('should return true for valid result', () => {
      const result = executeMovcg8io(mockConfig);
      expect(verifyMovcg8io(result)).toBe(true);
    });

    it('should return false for failed result', () => {
      const failedResult = {
        success: false,
        token: 'M4OK-movcg8io',
        metadata: {
          version: X_MOVCG8IO_VERSION,
          tag: X_MOVCG8IO_TAG,
          mode: 'm4-active',
          timestamp: new Date().toISOString(),
        },
      };
      expect(verifyMovcg8io(failedResult)).toBe(false);
    });

    it('should return false for invalid token', () => {
      const invalidResult = {
        success: true,
        token: 'INVALID-token',
        metadata: {
          version: X_MOVCG8IO_VERSION,
          tag: X_MOVCG8IO_TAG,
          mode: 'm4-active',
          timestamp: new Date().toISOString(),
        },
      };
      expect(verifyMovcg8io(invalidResult)).toBe(false);
    });

    it('should return false for invalid tag', () => {
      const invalidResult = {
        success: true,
        token: 'M4OK-movcg8io',
        metadata: {
          version: X_MOVCG8IO_VERSION,
          tag: 'wrong-tag',
          mode: 'm4-active',
          timestamp: new Date().toISOString(),
        },
      };
      expect(verifyMovcg8io(invalidResult)).toBe(false);
    });
  });

  describe('M4OK-movcg8io Token Verification', () => {
    it('should always include M4OK-movcg8io in successful execution', () => {
      const result = executeMovcg8io(mockConfig);
      expect(result.token).toContain('M4OK-movcg8io');
    });
  });
});
