// product209/15 PKF-H5 §7.6.2 — path-only lifecycle tool specs.
import { describe, expect, it } from 'vitest';
import {
  PKF_CHECKOUT_TOOL,
  PKF_COMMIT_TOOL,
  PKF_NORMALIZE_TOOL,
  PKF_STATUS_TOOL,
} from '../src/adapters/memory-tools.js';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/persistence/hermes/memory-tools.js';

describe('path-only lifecycle tool specs (not advertised before real provider wiring)', () => {
  it('keeps the four specs available but does not falsely register them in Hermes', () => {
    for (const t of [PKF_CHECKOUT_TOOL, PKF_STATUS_TOOL, PKF_COMMIT_TOOL, PKF_NORMALIZE_TOOL]) {
      expect(HERMES_MEMORY_TOOLS.some((h) => h.function.name === t.name)).toBe(false);
    }
  });

  it('NEVER accepts document bytes as an argument (path-only contract)', () => {
    for (const t of [PKF_CHECKOUT_TOOL, PKF_STATUS_TOOL, PKF_COMMIT_TOOL, PKF_NORMALIZE_TOOL]) {
      const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props)).not.toContain('source');
      expect(Object.keys(props)).not.toContain('content');
      expect(Object.keys(props)).toContain('workspaceRelativePath');
    }
  });
});
