// MemoryIntegration — the five-verb memory contract shared across host
// adapters (Desktop-202 doc 18 §3a).
//
// Every adapter's memory behaviour collapses to five verbs. This module is the
// adapter-agnostic *contract* plus the concrete **hermes** binding. The other
// three adapters (claude-code / codex / openclaw) get only their interface
// position here per dispatcher decision D7 (doc 18 §3b/§15) — they are NOT
// implemented in this scope, so a future Phase can bind them without
// re-deriving the vocabulary.
//
// ## The five verbs (doc 18 §3a)
//
//   1. core-inject   — bounded curated core auto-injected into the system
//                       prompt (≤1,800 chars). Identity / preferences / hard
//                       constraints — NOT retrieval results. Hermes carrier:
//                       the MEMORY.md managed section (hermes-memory-bridge).
//   2. recall-tools  — agent-driven archive recall (MAIN PATH, P0). The agent
//                       calls `memory_search` / `memory_load`; the impls hit
//                       the daemon's local FTS5 store (zero cross-net RTT). The
//                       agent decides *when*. Hermes carrier: tool schemas
//                       registered with the running agent (via the provider /
//                       MCP surface) + `buildMemoryToolImpls` as the executor.
//   3. extract       — post-turn automatic capture. Provider terminal signals
//                       enter the Runtime-owned durable job ledger; hooks are an
//                       optional signal source, never the retry boundary.
//   4. native-bridge — adapter-native memory file (MEMORY.md) curated content
//                       mirrored INTO the substrate (one-way up); the substrate
//                       only ever writes the managed section back (= the
//                       core-inject carrier) and NEVER clobbers curated text.
//   5. session-map   — adapter session id ↔ (conversationId, agentImUserId) so
//                       recall/extract land in the right scope.
//
// This module is pure composition over existing primitives — it owns no SQLite
// handle and spawns no process; it returns the schemas + bound callables an
// adapter needs and the file-bridge helpers for the hermes MEMORY.md.

import {
  HERMES_MEMORY_TOOLS,
  type HermesFunctionTool,
} from '../persistence/hermes/memory-tools.js';
import {
  CLAUDE_CODE_MEMORY_TOOLS,
  type ClaudeCodeTool,
} from '../coding/claude-code/memory-tools.js';
import {
  CODEX_MEMORY_TOOLS,
  type CodexMcpTool,
} from '../coding/codex/memory-tools.js';
import {
  buildMemoryToolImpls,
  type MemorySearchInput,
  type MemorySearchOutput,
  type MemoryLoadInput,
  type MemoryLoadOutput,
} from '../memory-tools.js';
import {
  writeManagedSection,
  extractCurated,
  readHermesMemory,
  DEFAULT_CHAR_BUDGET,
  type HermesMemory,
} from '../../daemon/memory/hermes-memory-bridge.js';
import { getRecallStats } from '../../daemon/memory/recall-stats.js';

/** The five verb identifiers — exported so adapters/observability speak one vocabulary. */
export type MemoryVerb =
  | 'core-inject'
  | 'recall-tools'
  | 'extract'
  | 'native-bridge'
  | 'session-map';

export const MEMORY_VERBS: readonly MemoryVerb[] = [
  'core-inject',
  'recall-tools',
  'extract',
  'native-bridge',
  'session-map',
] as const;

/** Default daemon port for local-loopback memory RPC (doc 18 §4c). */
const DEFAULT_DAEMON_PORT = '3210';

/** Resolve the daemon local base URL the memory tools target. */
export function resolveDaemonUrl(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, '');
  const port = (process.env.PRISMER_DAEMON_PORT ?? DEFAULT_DAEMON_PORT).trim() || DEFAULT_DAEMON_PORT;
  return `http://127.0.0.1:${port}`;
}

export interface MemoryIntegrationOptions {
  /** Workspace the agent is bound to — captured so tool calls omit it. */
  workspaceId: string;
  /**
   * The agent's IM user id. Forwarded into the recall-tool client so the
   * daemon can attribute `recall_pull` observability events to this agent.
   * Omit for anonymous callers (the daemon then skips emission).
   */
  actorImUserId?: string;
  /** Optional daemon base URL override (defaults to 127.0.0.1:$PRISMER_DAEMON_PORT). */
  daemonUrl?: string;
  /** Absolute path to the adapter's native memory file (hermes: MEMORY.md). */
  memoryFilePath?: string;
  /** core-inject char budget; defaults to the bridge's ≤1,800 budget. */
  coreInjectCharBudget?: number;
}

/**
 * recall-tools binding (verb 2, P0). The schemas an adapter registers with the
 * agent + the executor that runs an emitted tool call against the daemon-local
 * store. `schemas` are the hermes OpenAI-style function tools; `impls` are the
 * adapter-agnostic callables.
 */
export interface RecallToolsBinding {
  schemas: HermesFunctionTool[];
  impls: {
    search(input: MemorySearchInput): Promise<MemorySearchOutput>;
    load(input: MemoryLoadInput): Promise<MemoryLoadOutput>;
  };
}

/**
 * The hermes binding of the five-verb contract. Only hermes is implemented in
 * this scope (D7). Each method is a thin, side-effect-narrow operation over an
 * existing primitive.
 */
export interface HermesMemoryIntegration {
  adapter: 'hermes';
  workspaceId: string;
  daemonUrl: string;

  /**
   * verb: recall-tools (P0). Returns the tool schemas to register with the
   * agent + the executor bound to this workspace's daemon-local store.
   */
  recallTools(): RecallToolsBinding;

  /**
   * verb: core-inject. Write the bounded curated core into the MEMORY.md
   * managed section (the agent's curated entries are preserved verbatim). The
   * body is content (identity/preferences/constraints), NOT retrieval results.
   * No-op + warning when no `memoryFilePath` was provided.
   */
  coreInject(body: string): { written: boolean; bytes: number };

  /**
   * verb: native-bridge (read side). Return the agent-curated content of the
   * native MEMORY.md (everything OUTSIDE our managed section) for up-sync into
   * the substrate. Returns '' when no file / no path.
   */
  nativeCurated(): string;

  /** Read both halves of the native MEMORY.md (curated + managed + raw). */
  readNative(): HermesMemory;
}

/**
 * Build the hermes binding of the five-verb memory contract. Pure construction
 * — opens nothing, spawns nothing; callables hit the daemon-local HTTP store
 * lazily on invocation.
 */
export function createHermesMemoryIntegration(
  opts: MemoryIntegrationOptions,
): HermesMemoryIntegration {
  const daemonUrl = resolveDaemonUrl(opts.daemonUrl);
  const charBudget = opts.coreInjectCharBudget ?? DEFAULT_CHAR_BUDGET;

  return {
    adapter: 'hermes',
    workspaceId: opts.workspaceId,
    daemonUrl,

    recallTools(): RecallToolsBinding {
      return {
        schemas: HERMES_MEMORY_TOOLS,
        impls: buildMemoryToolImpls({
          daemonUrl,
          workspaceId: opts.workspaceId,
          actorImUserId: opts.actorImUserId,
          actorKind: 'agent',
        }),
      };
    },

    coreInject(body: string): { written: boolean; bytes: number } {
      if (!opts.memoryFilePath) {
        process.stderr.write(
          '[memory-integration] coreInject skipped: no memoryFilePath provided\n',
        );
        return { written: false, bytes: 0 };
      }
      writeManagedSection(opts.memoryFilePath, body, { charBudget });
      // Report the post-budget byte size actually written into the managed
      // section so recallStats.coreInjectBytes reflects reality.
      const after = readHermesMemory(opts.memoryFilePath);
      const bytes = Buffer.byteLength(after.managed, 'utf8');
      // doc 18 §8 — surface the core-inject budget occupancy + mark the C
      // (core-inject) provider path live.
      getRecallStats().recordCoreInject(bytes);
      return { written: true, bytes };
    },

    nativeCurated(): string {
      if (!opts.memoryFilePath) return '';
      try {
        return extractCurated(opts.memoryFilePath);
      } catch {
        return '';
      }
    },

    readNative(): HermesMemory {
      if (!opts.memoryFilePath) return { curated: '', managed: '', raw: '' };
      return readHermesMemory(opts.memoryFilePath);
    },
  };
}

// ── Interface positions for the other three adapters (D7 — NOT implemented) ──
//
// These exist so a future Phase binds claude-code / codex without
// re-deriving the verb vocabulary. The fallback-binding theorem (doc 18 §3b):
// core-inject + extract can be served purely by the daemon dispatch layer
// (preamble fixed head + post-completion extract) with no adapter-internal
// mechanism — so any new adapter has minimum memory capability day one.
// recall-tools is each adapter's real integration target (no tool surface →
// the agent cannot self-recall archive; this is a capability gap, not a
// fallback). native-bridge is an upside.

export type FallbackAdapter = 'claude-code' | 'codex';

/** The native schema shape is selected by the adapter's existing tool wrapper. */
export type FallbackRecallToolSchema = ClaudeCodeTool | CodexMcpTool;

export interface FallbackRecallToolHandlers {
  search(input: MemorySearchInput): Promise<MemorySearchOutput>;
  load(input: MemoryLoadInput): Promise<MemoryLoadOutput>;
}

/** Adapter-owned skill/tool registries implement this narrow attachment seam. */
export interface FallbackRecallToolsRegistrar {
  registerRecallTools(registration: {
    adapter: FallbackAdapter;
    schemas: readonly FallbackRecallToolSchema[];
    handlers: FallbackRecallToolHandlers;
  }): void;
}

export interface FallbackRecallToolsBinding {
  /** Exactly memory_search + memory_load in the adapter's native schema shape. */
  schemas: readonly FallbackRecallToolSchema[];
  /** Bound daemon-local RPC callables for the registered names. */
  handlers: FallbackRecallToolHandlers;
  /** Deliver schemas and handlers to the adapter's registry boundary. */
  register(registrar: FallbackRecallToolsRegistrar): void;
}

function recallSchemasFor(adapter: FallbackAdapter): readonly FallbackRecallToolSchema[] {
  const schemas = adapter === 'claude-code' ? CLAUDE_CODE_MEMORY_TOOLS : CODEX_MEMORY_TOOLS;
  // Coding wrappers also expose pkf_validate, but this integration owns only
  // the two recall RPC handlers. Never register an unhandled schema.
  return schemas.filter((tool) => tool.name === 'memory_search' || tool.name === 'memory_load');
}

export interface FallbackMemoryIntegration {
  adapter: FallbackAdapter;
  workspaceId: string;
  daemonUrl: string;
  /** verb: recall-tools. Adapter schemas plus local-RPC handlers and registrar. */
  recallTools(): FallbackRecallToolsBinding;
  /** Back-compat alias for older fallback callers that only needed executors. */
  recallToolImpls(): FallbackRecallToolHandlers;
}

/**
 * Fallback coding integration. It exposes a registration-ready recall surface
 * without claiming direct CLI injection: each adapter feeds its own tool or
 * skill registry through `register`, while the handler uses local daemon RPC.
 */
export function createFallbackMemoryIntegration(
  adapter: FallbackAdapter,
  opts: MemoryIntegrationOptions,
): FallbackMemoryIntegration {
  const daemonUrl = resolveDaemonUrl(opts.daemonUrl);
  const handlers = (): FallbackRecallToolHandlers =>
    buildMemoryToolImpls({
      daemonUrl,
      workspaceId: opts.workspaceId,
      actorImUserId: opts.actorImUserId,
      actorKind: 'agent',
    });
  const recallTools = (): FallbackRecallToolsBinding => {
    const schemas = recallSchemasFor(adapter);
    const boundHandlers = handlers();
    return {
      schemas,
      handlers: boundHandlers,
      register(registrar: FallbackRecallToolsRegistrar): void {
        registrar.registerRecallTools({ adapter, schemas, handlers: boundHandlers });
      },
    };
  };
  return {
    adapter,
    workspaceId: opts.workspaceId,
    daemonUrl,
    recallTools,
    recallToolImpls: handlers,
  };
}
