/**
 * Prismer IM — Tool Call Protocol
 * 
 * Handles tool invocations between agents, compatible with
 * OpenAI function calling and MCP tool_use patterns.
 */

import { nanoid } from "nanoid";
import type { AgentToolCallMessage, AgentToolResultMessage } from "./types";
import type { MessageMetadata, ToolCallPayload, ToolResultPayload } from "../types/index";

/**
 * Create a tool call message payload.
 */
export function createToolCall(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { targetAgentId?: string; timeoutMs?: number },
): AgentToolCallMessage {
  return {
    callId: nanoid(),
    toolName,
    arguments: args,
    targetAgentId: opts?.targetAgentId,
    timeoutMs: opts?.timeoutMs ?? 30_000,
  };
}

/**
 * Create a tool result message payload.
 */
export function createToolResult(
  callId: string,
  toolName: string,
  result: unknown,
  opts?: { isError?: boolean; errorMessage?: string; durationMs?: number },
): AgentToolResultMessage {
  return {
    callId,
    toolName,
    result,
    isError: opts?.isError ?? false,
    errorMessage: opts?.errorMessage,
    durationMs: opts?.durationMs,
  };
}

/**
 * Convert a tool call to message metadata format.
 */
export function toolCallToMetadata(call: AgentToolCallMessage): MessageMetadata {
  return {
    toolCall: {
      callId: call.callId,
      toolName: call.toolName,
      arguments: call.arguments,
    },
  };
}

/**
 * Convert a tool result to message metadata format.
 */
export function toolResultToMetadata(result: AgentToolResultMessage): MessageMetadata {
  return {
    toolResult: {
      callId: result.callId,
      toolName: result.toolName,
      result: result.result,
      isError: result.isError,
    },
  };
}

/**
 * Pending tool call tracker.
 * Used by agents to track outstanding tool calls.
 */
export class ToolCallTracker {
  private pending = new Map<string, {
    call: AgentToolCallMessage;
    resolve: (result: AgentToolResultMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Register a pending tool call and return a promise for the result.
   */
  waitForResult(call: AgentToolCallMessage): Promise<AgentToolResultMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(call.callId);
        reject(new Error(`Tool call ${call.callId} timed out after ${call.timeoutMs}ms`));
      }, call.timeoutMs ?? 30_000);

      this.pending.set(call.callId, { call, resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending tool call with its result.
   */
  resolveCall(result: AgentToolResultMessage): boolean {
    const pending = this.pending.get(result.callId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(result.callId);
    pending.resolve(result);
    return true;
  }

  /**
   * Cancel all pending calls.
   */
  cancelAll(): void {
    for (const [id, { timer, reject }] of this.pending) {
      clearTimeout(timer);
      reject(new Error("All pending calls cancelled"));
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
