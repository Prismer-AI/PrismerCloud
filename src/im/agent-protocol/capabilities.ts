/**
 * Prismer IM — Agent Capability definitions
 * 
 * Standard capabilities that agents can declare.
 * Acts as a shared vocabulary for agent discovery.
 */

import type { AgentCapability } from "../types/index";

/**
 * Well-known capability names.
 * Agents can also declare custom capabilities.
 */
export const WellKnownCapabilities = {
  /** General text conversation */
  CHAT: "chat",
  /** Code generation and analysis */
  CODE: "code",
  /** Text summarization */
  SUMMARIZE: "summarize",
  /** Translation between languages */
  TRANSLATE: "translate",
  /** Image generation */
  IMAGE_GEN: "image_generation",
  /** Image analysis / vision */
  IMAGE_ANALYSIS: "image_analysis",
  /** Web search */
  WEB_SEARCH: "web_search",
  /** File processing */
  FILE_PROCESSING: "file_processing",
  /** Data analysis */
  DATA_ANALYSIS: "data_analysis",
  /** Math and calculations */
  MATH: "math",
  /** Task orchestration */
  ORCHESTRATION: "orchestration",
  /** Tool execution (MCP-compatible) */
  TOOL_EXECUTION: "tool_execution",
  /** RAG / knowledge retrieval */
  KNOWLEDGE_RETRIEVAL: "knowledge_retrieval",
} as const;

/**
 * Validate that a capability declaration is well-formed.
 */
export function validateCapability(cap: AgentCapability): string[] {
  const errors: string[] = [];

  if (!cap.name || cap.name.trim().length === 0) {
    errors.push("Capability name is required");
  }
  if (cap.name && cap.name.length > 128) {
    errors.push("Capability name must be <= 128 characters");
  }
  if (!cap.description || cap.description.trim().length === 0) {
    errors.push("Capability description is required");
  }
  if (cap.inputSchema && typeof cap.inputSchema !== "object") {
    errors.push("inputSchema must be an object (JSON Schema)");
  }
  if (cap.outputSchema && typeof cap.outputSchema !== "object") {
    errors.push("outputSchema must be an object (JSON Schema)");
  }

  return errors;
}

/**
 * Create a standard capability declaration.
 */
export function makeCapability(
  name: string,
  description: string,
  opts?: {
    version?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  },
): AgentCapability {
  return {
    name,
    description,
    version: opts?.version ?? "1.0",
    inputSchema: opts?.inputSchema,
    outputSchema: opts?.outputSchema,
  };
}
