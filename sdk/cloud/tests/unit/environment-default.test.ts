import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '../../src/types';

describe('cloud SDK environment defaults', () => {
  it('uses the current production origin', () => {
    expect(ENVIRONMENTS.production).toBe('https://prod.docbrew.cn');
  });
});
