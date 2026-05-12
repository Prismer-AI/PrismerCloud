/**
 * X-movcg8io Feature Tests
 * MVP M3/M4 Smoke Test Verification
 */

import { describe, it, expect } from 'vitest';
import { executeXmovcg8io, verifyM4OK } from '@/lib/features/x-movcg8io';

describe('X-movcg8io Smoke Test', () => {
  it('should execute smoke test and return completed result', () => {
    const result = executeXmovcg8io();

    expect(result.tag).toBe('movcg8io');
    expect(result.status).toBe('completed');
    expect(result.mode).toBe('engineer-token-complete-agent-run');
    expect(result.output).toContain('M4OK-movcg8io');
  });

  it('should verify M4OK token in output', () => {
    const validOutput = 'M4OK-movcg8io: Engineer completed the deterministic M4 smoke run.';
    const invalidOutput = 'Some other output without token';

    expect(verifyM4OK(validOutput)).toBe(true);
    expect(verifyM4OK(invalidOutput)).toBe(false);
  });

  it('should match expected M4 smoke run format', () => {
    const result = executeXmovcg8io();

    expect(result.output).toMatch(/^M4OK-movcg8io:/);
  });
});
