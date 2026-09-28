// WS-B (PP-1) — minimal type shim for Paseo's agent-manager.
//
// The full AgentManager (session lifecycle registry + persistence + broadcast)
// is the B2 "most complex shim" — it adapts onto our daemon local SQLite +
// outbox and is intentionally NOT ported in this PURE-PORT step. The lifted
// orchestration files (agent-response-loop, timeline-projection) reference
// AgentManager / AgentTimelineRow ONLY as types, so this provides just the
// structural surface they consume. The concrete manager arrives with the
// CodeAgentDriver bridge (B2).
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.6 ⑤, §7.7 WS-B.
import type {
  AgentSessionConfig,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentProvider,
} from "./agent-sdk-types.js";

export type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export interface ManagedAgent {
  id: string;
  [key: string]: unknown;
}

export interface ProviderAvailability {
  available: boolean;
  error?: string | null;
  [key: string]: unknown;
}

/**
 * Structural surface consumed by the lifted orchestration files. The real
 * implementation (B2) is far wider; only the members referenced by the engine
 * port are declared here so the port type-checks without dragging the full
 * manager (and its daemon persistence coupling) into B1.
 */
export interface AgentManager {
  createAgent(
    config: AgentSessionConfig,
    agentId?: string,
    options?: {
      labels?: Record<string, string>;
      initialPrompt?: string;
      env?: Record<string, string>;
      persistSession?: boolean;
      initialTitle?: string | null;
      workspaceId?: string;
    },
  ): Promise<ManagedAgent>;
  runAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
  closeAgent(agentId: string): Promise<void>;
  getProviderAvailability(provider: AgentProvider): Promise<ProviderAvailability>;
}
