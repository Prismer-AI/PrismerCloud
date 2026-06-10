// Smoke test for the 4 host adapter wrappers — guards against drift from
// the shared tool spec. Tool names and input schema MUST stay locked across
// all 4 hosts so an LLM running in any of them sees the same surface.

import { describe, expect, it } from 'vitest';
import {
  MEMORY_SEARCH_INPUT_SCHEMA,
  MEMORY_LOAD_INPUT_SCHEMA,
  MEMORY_SEARCH_DESCRIPTION,
  MEMORY_LOAD_DESCRIPTION,
} from '../src/adapters/memory-tools.js';
import { CLAUDE_CODE_MEMORY_TOOLS } from '../src/adapters/claude-code/memory-tools.js';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/hermes/memory-tools.js';
import { OPENCLAW_MEMORY_TOOLS } from '../src/adapters/openclaw/memory-tools.js';
import { CODEX_MEMORY_TOOLS } from '../src/adapters/codex/memory-tools.js';

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

  it('OpenClaw wrappers preserve name + description + schema (camelCase inputSchema)', () => {
    const [search, load] = OPENCLAW_MEMORY_TOOLS;
    expect(search?.name).toBe('memory_search');
    expect(load?.name).toBe('memory_load');
    expect(search?.inputSchema).toBe(MEMORY_SEARCH_INPUT_SCHEMA);
    expect(load?.inputSchema).toBe(MEMORY_LOAD_INPUT_SCHEMA);
  });

  it('Codex wrappers preserve name + description + schema (MCP camelCase)', () => {
    const [search, load] = CODEX_MEMORY_TOOLS;
    expect(search?.name).toBe('memory_search');
    expect(load?.name).toBe('memory_load');
    expect(search?.inputSchema).toBe(MEMORY_SEARCH_INPUT_SCHEMA);
    expect(load?.inputSchema).toBe(MEMORY_LOAD_INPUT_SCHEMA);
  });

  it('all 4 adapters surface the same set of tool names', () => {
    const names = (tools: ReadonlyArray<{ name?: string; function?: { name: string } }>): string[] =>
      tools.map((t) => t.name ?? t.function?.name ?? '');
    const cc = names(CLAUDE_CODE_MEMORY_TOOLS).sort();
    const oc = names(OPENCLAW_MEMORY_TOOLS).sort();
    const cx = names(CODEX_MEMORY_TOOLS).sort();
    const hm = names(HERMES_MEMORY_TOOLS).sort();
    expect(cc).toEqual(['memory_load', 'memory_search']);
    expect(oc).toEqual(cc);
    expect(cx).toEqual(cc);
    expect(hm).toEqual(cc);
  });
});
