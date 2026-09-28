import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOUD_BASE_URL } from '../src/cli/util.js';

describe('runtime cloud default', () => {
  it('uses the current production origin when no override is supplied', () => {
    expect(DEFAULT_CLOUD_BASE_URL).toBe('https://prod.docbrew.cn');
  });
});
