// Shared WEB tool spec — sibling of memory-tools.ts (same FROZEN-spec role,
// different domain: these are workspace-CONTEXT tools, not memory verbs).
//
// release203 web-capability fix (user ruling: "we ARE the search backend"):
//   - Tool names: `workspace_web_search` and `web_load` (FROZEN). The search
//     tool CANNOT be named `web_search`: Hermes v0.17 guards provider tools
//     that shadow reserved CORE tool names even when the core tool itself is
//     check_fn-dropped ("shadows a reserved core tool name; registration
//     ignored. Core tools always win" — live-hit 2026-07-03). The event-stream
//     mapper (persistence/hermes/tool-call-mapper.ts SEARCH_TOOLS) maps
//     `workspace_web_search` onto the same first-class `web_search` search
//     row, so the UI surface is unchanged. `web_load` has no core counterpart
//     and keeps the plain name.
//   - Implementation calls daemon RPC `/local/web/search` and
//     `/local/web/load` (daemon/web/rpc.ts), which FORWARD to the cloud Load
//     API `POST /api/context/load` (search + cache + compress + deposit, Exa
//     server-side) with the daemon's own sk-prismer credential. No
//     third-party search keys/packages ever enter the pod.
//   - Registration seam: the Hermes provider shell
//     (plugins/memory/prismer/__init__.py get_tool_schemas) — the established
//     daemon-backed tool-registration path.
//
// Output contract: the daemon passes the Load API payload through with every
// text field (hqcc / raw / text / content / snippet) bounded to ~8k chars
// (`<field>Truncated: true` marks a clip) so one tool result can't blow the
// model context.

export interface WebSearchInput {
  /** Web search query (Load API query mode: `{ input: query }`). */
  query: string;
  /** Max ranked results to return (1–10, default 5 → Load API `return.topK`). */
  limit?: number;
}

export interface WebSearchOutput {
  ok: boolean;
  mode?: 'query';
  /** Ranked results; `hqcc` is the compressed page content (bounded). */
  results?: Array<{
    rank?: number;
    url: string;
    title?: string | null;
    hqcc?: string | null;
    hqccTruncated?: boolean;
    cached?: boolean;
    meta?: unknown;
  }>;
  summary?: { query: string; searched: number; cacheHits: number; compressed: number; returned: number };
  error?: string;
  message?: string;
}

export interface WebLoadInput {
  /**
   * Single URI — http(s) web page OR a workspace `prismer://` URI
   * (memory203/20 §2.2 / 19 B9: `prismer://<owner>/asset/<sha>`,
   * `prismer://.../file/...` — the cloud Load API resolves these natively, so
   * agents load assets/files the memory wiki points at instead of re-reading
   * raw sources).
   */
  url?: string;
  /** Batch of http(s)/prismer:// URIs (max 5). Exactly one of `url` / `urls` required. */
  urls?: string[];
}

export interface WebLoadOutput {
  ok: boolean;
  mode?: 'single_url' | 'batch_urls' | 'prismer_uri';
  /** Single-URL mode result. */
  result?: { url: string; title?: string | null; hqcc?: string | null; hqccTruncated?: boolean; cached?: boolean };
  /** Batch mode results. */
  results?: Array<{ url: string; title?: string | null; hqcc?: string | null; hqccTruncated?: boolean; cached?: boolean }>;
  /** `invalid_url` (scheme not http(s)/prismer://), `too_many_urls`, `cloud_not_wired`, …. */
  error?: string;
  message?: string;
}
