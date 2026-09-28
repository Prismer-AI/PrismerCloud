// product209/15 PKF-H2 — runtime native bounded query tools (offline).
import { describe, expect, it } from 'vitest';
import {
  PKF_OUTLINE_TOOL,
  PKF_READ_TOOL,
  PKF_SEARCH_TOOL,
  runPkfOutlineLocal,
  runPkfReadLocal,
  runPkfSearchLocal,
} from '../src/adapters/memory-tools.js';

const SOURCE = `<script type="application/prismer+json">{"type":"note","pkfVersion":"1.1"}</script>
<h2 id="deploy">Deploy</h2><p>blue-green rollout</p>
<h2 id="rollback">Rollback</h2><p>instant revert path</p>`;

describe('pkf query native tools', () => {
  it('registers outline/search/read tool specs', () => {
    expect(PKF_OUTLINE_TOOL.name).toBe('pkf_outline');
    expect(PKF_SEARCH_TOOL.name).toBe('pkf_search');
    expect(PKF_READ_TOOL.name).toBe('pkf_read');
  });

  it('outlines sections in-process (same results as Cloud core)', () => {
    const out = runPkfOutlineLocal({ source: SOURCE, documentUri: 'u', revisionId: 'r' });
    expect(out.ok).toBe(true);
    expect(out.sections).toHaveLength(2);
    expect(out.complete).toBe(true);
    expect(out.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('searches bounded snippets without regex', () => {
    const out = runPkfSearchLocal({ source: SOURCE, query: 'blue-green' });
    expect(out.matches).toHaveLength(1);
    expect((out.matches as Array<{ snippet: string }>)[0].snippet).toContain('blue-green');
  });

  it('reads one section bounded', () => {
    const out = runPkfReadLocal({ source: SOURCE, anchorSlug: 'rollback' });
    expect(out.ok).toBe(true);
    expect(out.content).toContain('instant revert path');
  });
});
