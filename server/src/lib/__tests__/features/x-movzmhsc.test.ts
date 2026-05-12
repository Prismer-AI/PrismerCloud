/**
 * X-movzmhsc Feature Tests
 * MVP M3/M4 Smoke Test Verification
 */

import { describe, it, expect, vi } from 'vitest';
import { executeXmovzmhsc, verifyM4OK, XmovzmhscResult } from '@/lib/features/x-movzmhsc';

describe('X-movzmhsc Smoke Test', () => {
  it('should execute smoke test and return correct result', () => {
    const result: XmovzmhscResult = executeXmovzmhsc();

    expect(result.tag).toBe('movzmhsc');
    expect(result.status).toBe('completed');
    expect(result.mode).toBe('engineer-token-complete-agent-run');
    expect(result.output).toBe('M4OK-movzmhsc: Engineer completed the deterministic M4 smoke run.');
  });

  it('should verify M4OK token in output', () => {
    const result = executeXmovzmhsc();

    expect(verifyM4OK(result.output)).toBe(true);
  });

  it('should reject invalid token', () => {
    expect(verifyM4OK('M4OK-wrong-tag')).toBe(false);
    expect(verifyM4OK('')).toBe(false);
    expect(verifyM4OK('some random text')).toBe(false);
  });

  it('should accept token anywhere in output string', () => {
    expect(verifyM4OK('Prefix M4OK-movzmhsc Suffix')).toBe(true);
    expect(verifyM4OK('M4OK-movzmhsc at beginning')).toBe(true);
    expect(verifyM4OK('at end M4OK-movzmhsc')).toBe(true);
  });

  it('should have correct tag constant', () => {
    const result = executeXmovzmhsc();
    expect(result.tag).toBe('movzmhsc');
  });

  it('should log execution message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    executeXmovzmhsc();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[X-movzmhsc] Smoke test executed:',
      'M4OK-movzmhsc: Engineer completed the deterministic M4 smoke run.',
    );

    consoleSpy.mockRestore();
  });
});
