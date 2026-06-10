// Claude Code adapter — memory tool spec in Anthropic SDK shape.
//
// The Anthropic Messages API expects tools as:
//   { name, description, input_schema: { type, properties, required } }
//
// Our shared spec is already Anthropic-shaped; this file just exposes the
// snake_case `input_schema` field name (vs the camelCase `inputSchema` used
// by the shared spec / MCP / Codex). Daemon-side dispatch (claude --headless
// subprocess spawn) is responsible for injecting these tools into the API
// request body — that wiring is **adapter integration owner work** and is
// NOT shipped in phase-0. This file only freezes the format so the
// integration owner can drop-in import it.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  type SharedToolSpec,
} from '../memory-tools.js';

export interface ClaudeCodeTool {
  name: string;
  description: string;
  input_schema: object; // Anthropic uses snake_case here
}

function toAnthropicTool(spec: SharedToolSpec): ClaudeCodeTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
  };
}

export const CLAUDE_CODE_MEMORY_TOOLS: ClaudeCodeTool[] = [
  toAnthropicTool(MEMORY_SEARCH_TOOL),
  toAnthropicTool(MEMORY_LOAD_TOOL),
];

// Re-export shared impls so the integration owner has one import for both
// the tool definition and the runtime implementation.
export { buildMemoryToolImpls } from '../memory-tools.js';
