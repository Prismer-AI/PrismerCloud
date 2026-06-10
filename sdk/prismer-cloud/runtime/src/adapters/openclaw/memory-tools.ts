// OpenClaw adapter — memory tool spec in OpenClaw extension shape.
//
// OpenClaw extensions (per dispatcher reference `extensions/memory-lancedb
// /index.ts:491`) register tools through OpenClaw's extension manifest.
// The shape is close to the shared spec — name, description, input schema
// — so the wrapper is mostly identity. The daemon spawns OpenClaw as a TS
// worker (1.9.5+) so registration could be in-process via OpenClaw's
// programmatic extension API.
//
// Daemon-side wiring (calling OpenClaw's extension registration API at
// service ensure-time so tools land in the agent's tool list) is **adapter
// integration owner work** and is NOT shipped in phase-0. This file only
// freezes the format.

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  type SharedToolSpec,
} from '../memory-tools.js';

export interface OpenclawTool {
  name: string;
  description: string;
  inputSchema: object;
}

function toOpenclawTool(spec: SharedToolSpec): OpenclawTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  };
}

export const OPENCLAW_MEMORY_TOOLS: OpenclawTool[] = [
  toOpenclawTool(MEMORY_SEARCH_TOOL),
  toOpenclawTool(MEMORY_LOAD_TOOL),
];

export { buildMemoryToolImpls } from '../memory-tools.js';
