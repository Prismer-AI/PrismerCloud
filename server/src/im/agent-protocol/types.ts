/**
 * Prismer IM — Agent Protocol Types
 *
 * Inspired by Google A2A protocol and MCP (Model Context Protocol).
 * Defines the communication contract between agents and the IM server.
 */

import type { AgentType, AgentCapability, AgentStatus } from '../types/index';

// ─── Protocol Version ────────────────────────────────────────
export const AGENT_PROTOCOL_VERSION = '1.0.0';

// ─── Agent Registration ──────────────────────────────────────

export interface AgentRegistrationRequest {
  /** Agent display name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Agent classification */
  agentType: AgentType;
  /** List of capabilities this agent provides */
  capabilities: AgentCapability[];
  /** Optional HTTP endpoint for direct invocation */
  endpoint?: string;
  /** Protocol version this agent supports */
  protocolVersion: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface AgentRegistrationResponse {
  agentId: string;
  userId: string;
  token: string;
  protocolVersion: string;
  serverCapabilities: string[];
}

// ─── Agent Discovery ─────────────────────────────────────────

export interface AgentDiscoveryQuery {
  /** Filter by agent type */
  agentType?: AgentType;
  /** Filter by capability name */
  capability?: string;
  /** Only online agents */
  onlineOnly?: boolean;
}

export interface AgentInfo {
  agentId: string;
  userId: string;
  name: string;
  description: string;
  agentType: AgentType;
  capabilities: AgentCapability[];
  status: AgentStatus;
  load: number;
  endpoint?: string;
  did?: string; // AIP: did:key:z6Mk...
  didDocumentUrl?: string; // AIP: /.well-known/did/agents/:id/did.json
}

// ─── Tool Call Protocol ──────────────────────────────────────

/**
 * A tool call message sent by one agent to another (or from human to agent).
 * Format is aligned with OpenAI function calling convention.
 */
export interface AgentToolCallMessage {
  /** Unique ID for this call (for correlation) */
  callId: string;
  /** The tool/function being invoked */
  toolName: string;
  /** Arguments as a JSON object */
  arguments: Record<string, unknown>;
  /** Optional: which agent should handle this */
  targetAgentId?: string;
  /** Optional: timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result of a tool call.
 */
export interface AgentToolResultMessage {
  /** Correlates with the original callId */
  callId: string;
  /** Tool name (for logging/debugging) */
  toolName: string;
  /** The result data */
  result: unknown;
  /** Whether the call errored */
  isError: boolean;
  /** Error message if isError is true */
  errorMessage?: string;
  /** Processing time in ms */
  durationMs?: number;
}

// ─── Agent-to-Agent Messaging ────────────────────────────────

/**
 * Envelope for agent-to-agent communication.
 * Supports both synchronous (request-response) and async patterns.
 */
export interface A2AMessage {
  /** Protocol identifier */
  protocol: 'prismer-a2a';
  /** Protocol version */
  version: string;
  /** Message type */
  type: 'request' | 'response' | 'notification' | 'error';
  /** Source agent */
  from: string;
  /** Destination agent (or broadcast) */
  to: string | '*';
  /** Correlation ID for request-response pairs */
  correlationId: string;
  /** Message payload */
  payload: unknown;
  /** When the message was created */
  timestamp: number;
  /** Optional TTL in ms */
  ttlMs?: number;
}

// ─── Agent Task ──────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTask {
  taskId: string;
  agentId: string;
  conversationId: string;
  description: string;
  status: TaskStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

// ─── Thinking ────────────────────────────────────────────────

export interface ThinkingMessage {
  /** Which thinking step this is (1, 2, 3...) */
  step: number;
  /** The thinking content */
  content: string;
  /** Whether this is the final thinking step */
  isFinal: boolean;
  /** Duration of this thinking step in ms */
  durationMs?: number;
}
