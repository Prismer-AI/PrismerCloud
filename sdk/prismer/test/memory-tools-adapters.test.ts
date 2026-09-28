// Smoke test for the 3 host adapter wrappers — guards against drift from
// the shared tool spec. Tool names and input schema MUST stay locked across
// all hosts so an LLM running in any of them sees the same surface.

import { describe, expect, it } from 'vitest';
import {
  MEMORY_SEARCH_INPUT_SCHEMA,
  MEMORY_LOAD_INPUT_SCHEMA,
  MEMORY_SEARCH_DESCRIPTION,
  MEMORY_LOAD_DESCRIPTION,
} from '../src/adapters/memory-tools.js';
import { CLAUDE_CODE_MEMORY_TOOLS } from '../src/adapters/coding/claude-code/memory-tools.js';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/persistence/hermes/memory-tools.js';
import { CODEX_MEMORY_TOOLS } from '../src/adapters/coding/codex/memory-tools.js';

describe('host-adapter memory tool wrappers', () => {
  it('Claude Code wrappers preserve name + description + schema (Anthropic snake_case)', () => {
    const [search, load] = CLAUDE_CODE_MEMORY_TOOLS;
    expect(search?.name).toBe('memory_search');
    expect(load?.name).toBe('memory_load');
    expect(search?.description).toBe(MEMORY_SEARCH_DESCRIPTION);
    expect(load?.description).toBe(MEMORY_LOAD_DESCRIPTION);
    expect(search?.input_schema).toBe(MEMORY_SEARCH_INPUT_SCHEMA);
    expect(load?.input_schema).toBe(MEMORY_LOAD_INPUT_SCHEMA);
  });

  it('Hermes wrappers preserve name + description + schema (OpenAI function-calling shape)', () => {
    const [search, load] = HERMES_MEMORY_TOOLS;
    expect(search?.type).toBe('function');
    expect(search?.function.name).toBe('memory_search');
    expect(load?.function.name).toBe('memory_load');
    expect(search?.function.description).toBe(MEMORY_SEARCH_DESCRIPTION);
    expect(search?.function.parameters).toBe(MEMORY_SEARCH_INPUT_SCHEMA);
  });

  it('Codex wrappers preserve name + description + schema (MCP camelCase)', () => {
    const [search, load] = CODEX_MEMORY_TOOLS;
    expect(search?.name).toBe('memory_search');
    expect(load?.name).toBe('memory_load');
    expect(search?.inputSchema).toBe(MEMORY_SEARCH_INPUT_SCHEMA);
    expect(load?.inputSchema).toBe(MEMORY_LOAD_INPUT_SCHEMA);
  });

  it('tool-name surface is FROZEN per adapter class (coding 3 · hermes 10)', () => {
    const names = (tools: ReadonlyArray<{ name?: string; function?: { name: string } }>): string[] =>
      tools.map((t) => t.name ?? t.function?.name ?? '');
    // product209/15 PKF-D3：pkf_validate 进三个 host 的共享面（3 工具）。
    // Hermes additionally exposes bounded PKF outline/search/read and, since
    // pkf209/07 §5, the pkf_svg_check authoring loop plus, since pkf209, the
    // pkf_reply_inline mechanical delivery tool (both optional — not in
    // REQUIRED_PKF_NATIVE_TOOLS). File lifecycle remains the Cloud CLI lane;
    // it is not falsely advertised as a native Hermes function tool.
    expect(names(CLAUDE_CODE_MEMORY_TOOLS).sort()).toEqual(['memory_load', 'memory_search', 'pkf_validate']);
    expect(names(CODEX_MEMORY_TOOLS).sort()).toEqual(['memory_load', 'memory_search', 'pkf_validate']);
    expect(names(HERMES_MEMORY_TOOLS).sort()).toEqual([
      'memory_load',
      'memory_search',
      'pkf_bundle_commit',
      'pkf_mint_sids',
      'pkf_outline',
      'pkf_read',
      'pkf_reply_inline',
      'pkf_search',
      'pkf_svg_check',
      'pkf_validate',
    ]);
  });
});
