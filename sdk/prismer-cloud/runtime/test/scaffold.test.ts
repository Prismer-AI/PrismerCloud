import { describe, it, expect } from 'vitest';
import { RUNTIME_VERSION } from '../src/index.js';

describe('runtime scaffold', () => {
  it('exports RUNTIME_VERSION', () => {
    expect(RUNTIME_VERSION).toBe('1.9.0');
  });
});
