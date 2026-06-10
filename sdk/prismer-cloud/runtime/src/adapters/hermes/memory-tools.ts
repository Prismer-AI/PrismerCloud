// Hermes adapter — memory tool spec in OpenAI-style function calling shape.
//
// Hermes (the local-running agent framework) historically exposes tools via
// an OpenAI-compatible function-calling format because it bridges between
// OpenAI- and Anthropic-shaped LLMs. Per dispatcher reference
// `agent/memory_provider.py:42`, Hermes also has a memory provider ABC; the
// memory_search / memory_load tools layer above that abstraction.
//
// Daemon-side wiring (registering the tool with the running Hermes gateway
// so the LLM's emitted tool_calls are dispatched here) is **adapter
// integration owner work** and is NOT shipped in phase-0. This file only
// freezes the format.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  type SharedToolSpec,
} from '../memory-tools.js';

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
];

export { buildMemoryToolImpls } from '../memory-tools.js';
