// Hermes adapter — memory tool spec in OpenAI-style function calling shape.
//
// Hermes (the local-running agent framework) historically exposes tools via
// an OpenAI-compatible function-calling format because it bridges between
// OpenAI- and Anthropic-shaped LLMs. Per dispatcher reference
// `agent/memory_provider.py:42`, Hermes also has a memory provider ABC; the
// memory_search / memory_load tools layer above that abstraction.
//
// The Python provider shell mirrors this list and forwards calls to the
// Runtime loopback server. Keep this list honest: a name belongs here only
// when plugins/memory/prismer/__init__.py registers and handles it.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  PKF_MINT_SIDS_TOOL,
  PKF_VALIDATE_TOOL,
  PKF_OUTLINE_TOOL,
  PKF_SEARCH_TOOL,
  PKF_READ_TOOL,
  PKF_BUNDLE_COMMIT_TOOL,
  PKF_SVG_CHECK_TOOL,
  PKF_REPLY_INLINE_TOOL,
  type SharedToolSpec,
} from '../../memory-tools.js';

export interface HermesFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

function toHermesFunctionTool(spec: SharedToolSpec): HermesFunctionTool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  };
}

export const HERMES_MEMORY_TOOLS: HermesFunctionTool[] = [
  toHermesFunctionTool(MEMORY_SEARCH_TOOL),
  toHermesFunctionTool(MEMORY_LOAD_TOOL),
  toHermesFunctionTool(PKF_MINT_SIDS_TOOL),
  toHermesFunctionTool(PKF_VALIDATE_TOOL),
  toHermesFunctionTool(PKF_OUTLINE_TOOL),
  toHermesFunctionTool(PKF_SEARCH_TOOL),
  toHermesFunctionTool(PKF_READ_TOOL),
  toHermesFunctionTool(PKF_BUNDLE_COMMIT_TOOL),
  // pkf209/07 §5 — the controlled-svg check loop (write → check → fix).
  // NOT required for PKF runtime capability; offered when the runtime has it.
  toHermesFunctionTool(PKF_SVG_CHECK_TOOL),
  // pkf209 — mechanical inline-PKF delivery (path-only; the daemon validates
  // + the dispatch terminal state attaches the contentBlock). Also optional,
  // not in REQUIRED_PKF_NATIVE_TOOLS.
  toHermesFunctionTool(PKF_REPLY_INLINE_TOOL),
];

export { buildMemoryToolImpls } from '../../memory-tools.js';
