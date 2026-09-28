import { describe, expect, it } from 'vitest';

import { isRuntimeTemplateMode } from '../src/daemon/runner.js';

describe('runtime template mode', () => {
  it('is explicit and fail-closed', () => {
    expect(isRuntimeTemplateMode({})).toBe(false);
    expect(isRuntimeTemplateMode({ PRISMER_TEMPLATE_MODE: '1' })).toBe(false);
    expect(isRuntimeTemplateMode({ PRISMER_TEMPLATE_MODE: 'true' })).toBe(true);
  });
});
