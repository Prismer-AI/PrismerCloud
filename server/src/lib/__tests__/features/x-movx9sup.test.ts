/**
 * X-movx9sup Feature Tests
 * MVP M3/M4 Smoke Test Verification
 */

import { describe, it, expect } from 'vitest';
import { executeXmovx9sup, verifyM4OK } from '@/lib/features/x-movx9sup';

describe('X-movx9sup Smoke Test', () => {
  it('should execute smoke test and return completed result', () => {
    const result = executeXmovx9sup();

    expect(result.tag).toBe('movx9sup');
    expect(result.status).toBe('completed');
    expect(result.mode).toBe('engineer-token-complete-agent-run');
    expect(result.output).toContain('M4OK-movx9sup');
  });

  it('should verify M4OK token in output', () => {
    const validOutput = 'M4OK-movx9sup: Engineer completed the deterministic M4 smoke run.';
    const invalidOutput = 'Some other output without token';

    expect(verifyM4OK(validOutput)).toBe(true);
    expect(verifyM4OK(invalidOutput)).toBe(false);
  });

  it('should match expected M4 smoke run format', () => {
    const result = executeXmovx9sup();

    expect(result.output).toMatch(/^M4OK-movx9sup:/);
  });
});
