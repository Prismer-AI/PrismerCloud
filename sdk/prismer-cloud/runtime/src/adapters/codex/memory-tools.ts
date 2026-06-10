// Codex adapter — memory tool spec in MCP shape.
//
// Codex CLI consumes tools via the MCP (Model Context Protocol) standard,
// which uses the camelCase `inputSchema` field name (matches the shared
// spec). Codex's tool registration happens through its config file
// (`.codexrc` / `codex config tools add` etc.); daemon-side automatic
// registration would shell out to Codex CLI or write the config directly.
//
// Daemon-side wiring (writing Codex config + ensuring `codex` is restarted
// to pick up the new tools) is **adapter integration owner work** and is
// NOT shipped in phase-0. This file only freezes the format.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  type SharedToolSpec,
} from '../memory-tools.js';

export interface CodexMcpTool {
  name: string;
  description: string;
  inputSchema: object;
}

function toCodexMcpTool(spec: SharedToolSpec): CodexMcpTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  };
}

export const CODEX_MEMORY_TOOLS: CodexMcpTool[] = [
  toCodexMcpTool(MEMORY_SEARCH_TOOL),
  toCodexMcpTool(MEMORY_LOAD_TOOL),
];

export { buildMemoryToolImpls } from '../memory-tools.js';
