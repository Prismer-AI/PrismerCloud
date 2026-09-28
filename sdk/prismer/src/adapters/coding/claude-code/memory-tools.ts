// Claude Code adapter — memory tool spec in Anthropic SDK shape.
//
// The Anthropic Messages API expects tools as:
//   { name, description, input_schema: { type, properties, required } }
//
// Our shared spec is already Anthropic-shaped; this file just exposes the
// snake_case `input_schema` field name (vs the camelCase `inputSchema` used
// by the shared spec / MCP / Codex).
//
// ── memory203/10 §56 DECISION: code agents use the CLI, NOT a native tool ──
// The native tool-call surface (registering memory_search/load with the running
// agent + dispatching its emitted tool_calls back) is implemented ONLY for the
// Hermes adapter, which has a programmatic `MemoryProvider` ABC (Python) to
// inject schemas and route `handle_tool_call` → daemon RPC. Claude Code runs as
// a filesystem CLI subprocess with no such in-process injection seam, so its
// memory path is the **`prismer memory` CLI + the `memory` built-in skill**
// (`runtime/src/cli/commands/memory.ts` → daemon `/local/memory/*`, the SAME
// RPC these impls hit). The `memory` skill (scope: common) is seeded into every
// coding workdir's `.claude/skills/` via `CODING_COMMON_ALLOWLIST`, and the
// AGENTS.md/CLAUDE.md preamble points the agent at `prismer memory`. So recall,
// read, write and curate are all available to this agent out-of-the-box —
// through the CLI, not these schemas.
//
// These schemas remain unsuitable for direct CLI subprocess injection. The
// shared fallback integration exposes them to an adapter-owned registry
// boundary, which may attach skills/tools without inventing a CLI protocol.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  PKF_VALIDATE_TOOL,
  type SharedToolSpec,
} from '../../memory-tools.js';

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
  toAnthropicTool(PKF_VALIDATE_TOOL),
];

// Re-export shared impls so the integration owner has one import for both
// the tool definition and the runtime implementation.
export { buildMemoryToolImpls } from '../../memory-tools.js';
