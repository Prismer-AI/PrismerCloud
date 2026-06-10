// Shared memory tool spec — locked across all 4 host adapters (Claude Code,
// Hermes, OpenClaw, Codex) so an LLM running in any of them sees the same
// tool surface and the same daemon RPC under the hood.
//
// Per Line C plan §C5:
//   - Tool names: `memory_search` and `memory_load` (FROZEN)
//   - JSONSchema input shapes: locked here; per-adapter wrappers translate
//     this into the adapter's expected tool definition format
//   - Implementation calls daemon RPC `/local/memory/search` and
//     `/local/memory/load` (phase-0 routes from C1)
//
// Per dispatcher decision: `recall_pull` event emission is **NOT** wired in
// phase-0. It ships in phase-1 alongside C3+C4 hooks (preload + auto-inject)
// because all three observability event types (recall_preload / recall_inject
// / recall_pull) share the same emission code path in the daemon. Until then
// the tool implementations only produce search/load results; tool-use is
// observable via the daemon access log.

export interface MemorySearchInput {
  query: string;
  limit?: number;
  pageType?: Array<'hub' | 'leaf' | 'decision' | 'glossary' | 'archive'>;
}

export interface MemorySearchOutput {
  query: string;
  results: Array<{
    pageId: string;
    path: string;
    title: string | null;
    snippet: string;
    score: number;
    tokenCount: number;
  }>;
}

export interface MemoryLoadInput {
  /** Either `uri` (prismer://workspace/<id>/memory/<path>) or `workspaceId` + `path`. */
  uri?: string;
  workspaceId?: string;
  path?: string;
}

export interface MemoryLoadOutput {
  page: {
    id: string;
    path: string;
    title: string | null;
    pageType: string;
    version: number;
    contentHash: string;
  };
  content: string | null;
}

/** Locked human-readable description used in every adapter's tool definition.
 *
 * Selective wording (doc 25 §3 支柱 1, M-A): the description steers the LLM
 * to call this only when a specific question genuinely warrants prior memory,
 * not as a habit. Empty results are normal — the agent should proceed without
 * memory rather than padding the prompt with low-relevance hits. */
export const MEMORY_SEARCH_DESCRIPTION =
  'Search workspace memory (prior decisions, user preferences, knowledge pages). ' +
  'Use this only when you have a specific question that you believe past memory ' +
  'would answer — not on every turn. Most queries do not need this. ' +
  'Returns 0–N ranked snippets with prismer:// URIs; empty results are normal.';

export const MEMORY_LOAD_DESCRIPTION =
  'Load a specific memory page by URI (prismer://workspace/<workspaceId>/memory/<path>) ' +
  'or by (workspaceId + path). Returns the full page content plus metadata.';

/**
 * Adapter-agnostic JSONSchema for memory_search input. Per-adapter wrappers
 * (claude-code, hermes, etc.) re-shape this into their host's tool schema
 * (Anthropic SDK tool, Hermes plugin tool, OpenClaw extension tool, Codex
 * MCP tool) but the field names and constraints are FROZEN here.
 */
export const MEMORY_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Free-text search query. Whitespace-separated terms are ANDed.',
      minLength: 1,
    },
    limit: {
      type: 'integer',
      description: 'Max number of results (default 5, max 20).',
      minimum: 1,
      maximum: 20,
      default: 5,
    },
    pageType: {
      type: 'array',
      description: 'Optional filter on page kind.',
      items: {
        type: 'string',
        enum: ['hub', 'leaf', 'decision', 'glossary', 'archive'],
      },
    },
  },
  required: ['query'],
} as const;

export const MEMORY_LOAD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    uri: {
      type: 'string',
      description: 'Full prismer:// URI (preferred). Mutually exclusive with workspaceId+path.',
      pattern: '^prismer://',
    },
    workspaceId: {
      type: 'string',
      description: 'Workspace identifier (used with `path`).',
    },
    path: {
      type: 'string',
      description: 'Workspace-relative memory file path (used with `workspaceId`).',
    },
  },
} as const;

/**
 * Generic tool spec carrier — adapter wrappers re-export this in their host's
 * preferred shape. The 4 adapter integrations only need to map these three
 * fields into their tool registration surface.
 */
export interface SharedToolSpec {
  name: 'memory_search' | 'memory_load';
  description: string;
  inputSchema: object;
}

export const MEMORY_SEARCH_TOOL: SharedToolSpec = {
  name: 'memory_search',
  description: MEMORY_SEARCH_DESCRIPTION,
  inputSchema: MEMORY_SEARCH_INPUT_SCHEMA,
};

export const MEMORY_LOAD_TOOL: SharedToolSpec = {
  name: 'memory_load',
  description: MEMORY_LOAD_DESCRIPTION,
  inputSchema: MEMORY_LOAD_INPUT_SCHEMA,
};

/**
 * Implementation factory. Returns two callables (`search`, `load`) bound to
 * a daemon URL + workspace context. Each callable hits the daemon's
 * `/local/memory/*` routes via plain HTTP and parses the JSON response.
 *
 * Created once per agent process boot (or per task — adapter's choice).
 * Workspace context is captured at construction so tool calls don't need to
 * pass it on each invocation; the LLM only sees the user-facing input shape.
 */
export interface MemoryToolBindings {
  daemonUrl: string;
  workspaceId: string;
}

export function buildMemoryToolImpls(bindings: MemoryToolBindings): {
  search(input: MemorySearchInput): Promise<MemorySearchOutput>;
  load(input: MemoryLoadInput): Promise<MemoryLoadOutput>;
} {
  const base = bindings.daemonUrl.replace(/\/$/, '');
  return {
    async search(input: MemorySearchInput): Promise<MemorySearchOutput> {
      const params = new URLSearchParams({
        workspaceId: bindings.workspaceId,
        q: input.query,
      });
      if (input.limit !== undefined) params.set('topK', String(input.limit));
      if (input.pageType && input.pageType.length > 0) {
        // Daemon's /local/memory/search accepts a single pageType per query
        // string param; multi-value support is phase-1. Phase-0: take first.
        params.set('pageType', input.pageType[0]!);
      }
      const url = `${base}/local/memory/search?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`memory_search: daemon returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as MemorySearchOutput;
      return body;
    },

    async load(input: MemoryLoadInput): Promise<MemoryLoadOutput> {
      const params = new URLSearchParams();
      if (input.uri) {
        params.set('uri', input.uri);
      } else if (input.workspaceId && input.path) {
        params.set('workspaceId', input.workspaceId);
        params.set('path', input.path);
      } else {
        throw new Error('memory_load: requires either `uri` or `workspaceId`+`path`');
      }
      const url = `${base}/local/memory/load?${params.toString()}`;
      const res = await fetch(url);
      if (res.status === 404) {
        throw new Error(`memory_load: page not found`);
      }
      if (!res.ok) {
        throw new Error(`memory_load: daemon returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as MemoryLoadOutput;
      return body;
    },
  };
}
