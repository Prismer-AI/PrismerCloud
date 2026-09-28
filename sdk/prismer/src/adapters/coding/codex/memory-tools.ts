// Codex adapter — memory tool spec in MCP shape.
//
// Codex CLI consumes tools via the MCP (Model Context Protocol) standard,
// which uses the camelCase `inputSchema` field name (matches the shared spec).
//
// ── memory203/10 §56 DECISION: code agents use the CLI, NOT a native tool ──
// Same as the Claude Code adapter: the native tool surface is implemented ONLY
// for Hermes (which has a programmatic MemoryProvider ABC). Codex runs as a
// filesystem CLI subprocess, so its memory path is the **`prismer memory` CLI +
// the `memory` built-in skill** (`runtime/src/cli/commands/memory.ts` → daemon
// `/local/memory/*`, the SAME RPC `buildMemoryToolImpls` hits). The `memory`
// skill (scope: common) is seeded into every coding workdir via
// `CODING_COMMON_ALLOWLIST`, and the AGENTS.md/CLAUDE.md preamble points the
// agent at `prismer memory` — so recall/read/write/curate are available out of
// the box through the CLI.
//
// These schemas remain unsuitable for direct CLI config injection. The shared
// fallback integration exposes them to an adapter-owned registry boundary,
// which may attach skills/tools without inventing a CLI protocol.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  PKF_VALIDATE_TOOL,
  type SharedToolSpec,
} from '../../memory-tools.js';

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
  toCodexMcpTool(PKF_VALIDATE_TOOL),
];

export { buildMemoryToolImpls } from '../../memory-tools.js';
