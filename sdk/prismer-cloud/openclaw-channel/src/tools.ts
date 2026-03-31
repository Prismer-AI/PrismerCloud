import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { prismerFetch } from "./api-client.js";
// signal-patterns.ts is available for tools that need signal detection;
// currently the inbound handler does detection automatically.

/**
 * Create agent tools for Prismer context loading and document parsing.
 * These give OpenClaw agents web knowledge and document understanding.
 *
 * @param apiKey - Prismer API key
 * @param baseUrl - Prismer base URL
 * @param defaultScope - Default evolution scope from account config (falls back to agentName)
 */
export function createPrismerAgentTools(apiKey: string, baseUrl: string, defaultScope?: string): ChannelAgentTool[] {
  return [
    {
      name: "prismer_load",
      label: "Prismer Load",
      description:
        "Load web knowledge from URLs or search queries. Returns compressed, AI-ready context from web pages. Use this to fetch and understand web content.",
      parameters: Type.Object({
        input: Type.String({
          description: "URL, comma-separated URLs, or a search query",
        }),
        format: Type.Optional(
          Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
            description: "Output format (default: markdown)",
          }),
        ),
        maxResults: Type.Optional(
          Type.Number({
            description: "Max results for search queries (default: 5)",
          }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { input, format, maxResults } = args as {
          input: string;
          format?: string;
          maxResults?: number;
        };
        const body: Record<string, unknown> = { input };
        if (format) body.format = format;
        if (maxResults) body.maxResults = maxResults;

        try {
          const result = (await prismerFetch(apiKey, "/api/context/load", {
            method: "POST",
            body,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.success) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: ${(result.error as Record<string, string>)?.message || "Load failed"}`,
              }],
              details: {},
            };
          }

          const results = (result.results || [result.result]) as Record<string, unknown>[];
          const texts = results.map((r) => {
            const title = r.title || r.url || "Untitled";
            const content = r.content || r.text || "";
            return `## ${title}\n\n${content}`;
          });

          return {
            content: [{ type: "text" as const, text: texts.join("\n\n---\n\n") }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_evolve_analyze",
      label: "Prismer Evolve Analyze",
      description:
        "Analyze task context signals and get evolution advice — which Gene (strategy) to apply based on the agent's memory graph.",
      parameters: Type.Object({
        task_status: Type.Optional(
          Type.String({ description: 'Task status: "completed" or "failed"' }),
        ),
        task_capability: Type.Optional(
          Type.String({ description: 'Task capability (e.g. "search", "translate")' }),
        ),
        error: Type.Optional(
          Type.String({ description: "Error message if task failed" }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), { description: "Context tags" }),
        ),
        signals: Type.Optional(
          Type.Array(Type.String(), { description: "Direct signal list (overrides extraction)" }),
        ),
        provider: Type.Optional(
          Type.String({ description: 'Service provider context (e.g. "openai", "stripe") — v0.3.0 SignalTag' }),
        ),
        stage: Type.Optional(
          Type.String({ description: 'Pipeline stage (e.g. "fetch", "compress", "deploy") — v0.3.0 SignalTag' }),
        ),
        severity: Type.Optional(
          Type.String({ description: 'Issue severity: "low", "medium", "high", "critical" — v0.3.0 SignalTag' }),
        ),
        scope: Type.Optional(
          Type.String({ description: 'Evolution scope to partition gene pools (e.g. "project-x", "team-backend")' }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { task_status, task_capability, error, tags, signals, provider, stage, severity, scope } = args as {
          task_status?: string;
          task_capability?: string;
          error?: string;
          tags?: string[];
          signals?: string[];
          provider?: string;
          stage?: string;
          severity?: string;
          scope?: string;
        };

        try {
          const query: Record<string, string> = {};
          const resolvedScope = scope || defaultScope;
          if (resolvedScope) query.scope = resolvedScope;
          const result = (await prismerFetch(apiKey, "/api/im/evolution/analyze", {
            method: "POST",
            body: { task_status, task_capability, error, tags, signals, provider, stage, severity },
            baseUrl,
            query,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: ${(result.error as string) || "Analysis failed"}`,
              }],
              details: {},
            };
          }

          const data = result.data as Record<string, unknown>;
          let text = `Action: ${data.action}, Confidence: ${data.confidence}`;
          if (data.gene_id) text += `, Gene: ${data.gene_id}`;
          if (data.reason) text += `, Reason: ${data.reason}`;

          return {
            content: [{ type: "text" as const, text }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_evolve_record",
      label: "Prismer Evolve Record",
      description:
        "Record the outcome of a Gene execution. Updates the agent's evolution memory graph and personality.",
      parameters: Type.Object({
        gene_id: Type.String({ description: "ID of the Gene that was executed" }),
        signals: Type.Array(Type.String(), { description: "Signals that triggered execution" }),
        outcome: Type.Union([Type.Literal("success"), Type.Literal("failed")], {
          description: 'Execution outcome: "success" or "failed"',
        }),
        score: Type.Optional(
          Type.Number({ description: "Quality score 0-1" }),
        ),
        summary: Type.String({ description: "Brief summary of what happened" }),
        cost_credits: Type.Optional(
          Type.Number({ description: "Credits consumed" }),
        ),
        scope: Type.Optional(
          Type.String({ description: 'Evolution scope to partition gene pools (e.g. "project-x", "team-backend")' }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { gene_id, signals, outcome, score, summary, cost_credits, scope } = args as {
          gene_id: string;
          signals: string[];
          outcome: string;
          score?: number;
          summary: string;
          cost_credits?: number;
          scope?: string;
        };

        try {
          const query: Record<string, string> = {};
          const resolvedScope = scope || defaultScope;
          if (resolvedScope) query.scope = resolvedScope;
          const result = (await prismerFetch(apiKey, "/api/im/evolution/record", {
            method: "POST",
            body: { gene_id, signals, outcome, score, summary, cost_credits },
            baseUrl,
            query,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: ${(result.error as string) || "Record failed"}`,
              }],
              details: {},
            };
          }

          const data = result.data as Record<string, unknown>;
          return {
            content: [{
              type: "text" as const,
              text: `Recorded: edge_updated=${data.edge_updated}, personality_adjusted=${data.personality_adjusted}, distill_triggered=${data.distill_triggered}`,
            }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_evolve_report",
      label: "Prismer Evolve Report",
      description:
        "Submit raw execution context for async LLM-based evolution analysis. Returns a trace_id for status checking.",
      parameters: Type.Object({
        rawContext: Type.String({ description: "Raw context/error/log from the execution" }),
        outcome: Type.Union([Type.Literal("success"), Type.Literal("failed")], {
          description: 'Overall outcome: "success" or "failed"',
        }),
        taskContext: Type.Optional(
          Type.String({ description: "Task description or context" }),
        ),
        scope: Type.Optional(
          Type.String({ description: 'Evolution scope to partition gene pools (e.g. "project-x", "team-backend")' }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { rawContext, outcome, taskContext, scope } = args as {
          rawContext: string;
          outcome: string;
          taskContext?: string;
          scope?: string;
        };
        try {
          const body: Record<string, unknown> = { raw_context: rawContext, outcome };
          if (taskContext) body.task_context = taskContext;
          const query: Record<string, string> = {};
          const resolvedScope = scope || defaultScope;
          if (resolvedScope) query.scope = resolvedScope;

          const result = (await prismerFetch(apiKey, "/api/im/evolution/report", {
            method: "POST",
            body,
            baseUrl,
            query,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Report failed"}` }],
              details: {},
            };
          }
          const data = result.data as Record<string, unknown>;
          return {
            content: [{ type: "text" as const, text: `Report submitted: trace_id=${data.trace_id}, status=${data.status || "queued"}` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_gene_create",
      label: "Prismer Gene Create",
      description:
        "Create a new evolution Gene (reusable strategy pattern) for the agent.",
      parameters: Type.Object({
        category: Type.Union(
          [Type.Literal("repair"), Type.Literal("optimize"), Type.Literal("innovate"), Type.Literal("diagnostic")],
          { description: 'Gene category: "repair", "optimize", "innovate", or "diagnostic"' },
        ),
        signals_match: Type.Array(Type.String(), {
          description: "Signals this gene responds to",
        }),
        strategy: Type.Array(Type.String(), {
          description: "Strategy steps (actionable instructions)",
        }),
        title: Type.Optional(
          Type.String({ description: "Human-readable gene title (auto-generated if omitted)" }),
        ),
        preconditions: Type.Optional(
          Type.Array(Type.String(), { description: "Optional preconditions" }),
        ),
        constraints: Type.Optional(
          Type.Object({
            max_retries: Type.Optional(Type.Number()),
            max_credits_per_run: Type.Optional(Type.Number()),
            max_execution_time: Type.Optional(Type.Number()),
          }, { description: "Execution constraints (circuit breaker limits)" }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { category, signals_match, strategy, title, preconditions, constraints } = args as {
          category: string;
          signals_match: string[];
          strategy: string[];
          title?: string;
          preconditions?: string[];
          constraints?: Record<string, unknown>;
        };

        try {
          const result = (await prismerFetch(apiKey, "/api/im/evolution/genes", {
            method: "POST",
            body: { category, signals_match, strategy, title, preconditions, constraints },
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: ${(result.error as string) || "Gene creation failed"}`,
              }],
              details: {},
            };
          }

          const gene = result.data as Record<string, unknown>;
          return {
            content: [{
              type: "text" as const,
              text: `Gene created: ${gene.id} (${gene.category})`,
            }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_parse",
      label: "Prismer Parse",
      description:
        "Parse documents (PDF, images) using OCR. Extracts text content from document URLs.",
      parameters: Type.Object({
        url: Type.String({ description: "URL of the document to parse" }),
        mode: Type.Optional(
          Type.Union([Type.Literal("fast"), Type.Literal("hires")], {
            description: "Parse mode: fast (default) or hires (better quality)",
          }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { url, mode } = args as { url: string; mode?: string };
        const body: Record<string, unknown> = { url };
        if (mode) body.mode = mode;

        try {
          const result = (await prismerFetch(apiKey, "/api/parse", {
            method: "POST",
            body,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.success) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: ${(result.error as Record<string, string>)?.message || "Parse failed"}`,
              }],
              details: {},
            };
          }

          const data = result.result as Record<string, unknown> | undefined;
          const content = data?.content || data?.text || "";
          return {
            content: [{ type: "text" as const, text: String(content) }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {},
          };
        }
      },
    },
    // ─── Memory Tools ────────────────────────────────────────

    {
      name: "prismer_memory_write",
      label: "Prismer Memory Write",
      description:
        "Write to persistent memory. Upserts by (scope, path) — creates if not exists, updates if exists. Use to save patterns, preferences, and knowledge across sessions.",
      parameters: Type.Object({
        path: Type.String({
          description: 'Memory file path (e.g., "MEMORY.md", "patterns.md")',
        }),
        content: Type.String({ description: "Markdown content to write" }),
        scope: Type.Optional(
          Type.String({ description: 'Memory scope (default: "global")' }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { path, content, scope } = args as {
          path: string;
          content: string;
          scope?: string;
        };
        try {
          const result = (await prismerFetch(apiKey, "/api/im/memory/files", {
            method: "POST",
            body: { path, content, scope: scope || "global" },
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Memory write failed"}` }],
              details: {},
            };
          }
          const data = result.data as Record<string, unknown>;
          return {
            content: [{ type: "text" as const, text: `Memory written: ${path} (v${data.version || 1})` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_memory_read",
      label: "Prismer Memory Read",
      description:
        "Read persistent memory (MEMORY.md by default). Returns memory content, metadata, and compaction template for session context.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({ description: 'Memory scope (default: "global")' }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { scope } = args as { scope?: string };
        try {
          const query: Record<string, string> = {};
          if (scope) query.scope = scope;

          const result = (await prismerFetch(apiKey, "/api/im/memory/load", {
            query,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Memory read failed"}` }],
              details: {},
            };
          }
          const data = result.data as Record<string, unknown>;
          const content = data.content || "(empty)";
          const meta = data.metadata as Record<string, unknown> | undefined;
          let text = String(content);
          if (meta?.version) text += `\n\n---\nVersion: ${meta.version}`;
          return {
            content: [{ type: "text" as const, text }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ─── Social Tools ─────────────────────────────────────────

    {
      name: "prismer_discover",
      label: "Prismer Discover",
      description:
        "Discover available agents by capability or status. Find agents that can help with specific tasks.",
      parameters: Type.Object({
        capability: Type.Optional(
          Type.String({ description: "Filter by capability (e.g., 'search', 'translate')" }),
        ),
        status: Type.Optional(
          Type.Union([Type.Literal("online"), Type.Literal("offline"), Type.Literal("all")], {
            description: "Filter by agent status (default: all)",
          }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { capability, status } = args as {
          capability?: string;
          status?: string;
        };
        try {
          const query: Record<string, string> = {};
          if (capability) query.capability = capability;
          if (status === "online") query.onlineOnly = "true";

          const result = (await prismerFetch(apiKey, "/api/im/agents", {
            query,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Discovery failed"}` }],
              details: {},
            };
          }
          const agents = (result.data as Record<string, unknown>[]) || [];
          if (agents.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No agents found matching the criteria." }],
              details: result,
            };
          }
          const lines = agents.map((a: Record<string, unknown>) => {
            const caps = Array.isArray(a.capabilities) ? (a.capabilities as string[]).join(", ") : "";
            return `- **${a.name || a.username}** (${a.status || "unknown"}) — ${caps || "no capabilities listed"}`;
          });
          return {
            content: [{ type: "text" as const, text: `Found ${agents.length} agent(s):\n\n${lines.join("\n")}` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_send",
      label: "Prismer Send",
      description:
        "Send a direct message to another agent. Use prismer_discover first to find the agent's ID.",
      parameters: Type.Object({
        to: Type.String({ description: "Target agent user ID (from prismer_discover)" }),
        message: Type.String({ description: "Message content" }),
        type: Type.Optional(
          Type.Union([Type.Literal("text"), Type.Literal("markdown")], {
            description: 'Message type (default: "text")',
          }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { to, message, type } = args as {
          to: string;
          message: string;
          type?: string;
        };
        try {
          const result = (await prismerFetch(apiKey, `/api/im/direct/${encodeURIComponent(to)}/messages`, {
            method: "POST",
            body: { content: message, type: type || "text" },
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Send failed"}` }],
              details: {},
            };
          }
          return {
            content: [{ type: "text" as const, text: `Message sent to ${to}` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ─── Evolution Lifecycle Tools ─────────────────────────────

    {
      name: "prismer_evolve_distill",
      label: "Prismer Evolve Distill",
      description:
        "Trigger gene distillation — synthesize a new Gene from successful execution patterns using LLM. Use dry_run to check readiness first.",
      parameters: Type.Object({
        dry_run: Type.Optional(
          Type.Boolean({ description: "If true, only check readiness without triggering LLM (default: false)" }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { dry_run } = args as { dry_run?: boolean };
        try {
          const query: Record<string, string> = {};
          if (dry_run) query.dry_run = "true";
          const result = (await prismerFetch(apiKey, "/api/im/evolution/distill", {
            method: "POST",
            body: {},
            query,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Distillation failed"}` }],
              details: {},
            };
          }
          const data = result.data as Record<string, unknown>;
          if (data.ready === false) {
            return {
              content: [{ type: "text" as const, text: `Not ready: ${data.message} (${data.success_capsules}/${data.min_required} capsules)` }],
              details: result,
            };
          }
          const gene = data.gene as Record<string, unknown> | undefined;
          const text = gene
            ? `Gene distilled: ${gene.id} (${gene.category})`
            : `Ready for distillation. ${data.message || ""}`;
          return {
            content: [{ type: "text" as const, text }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_evolve_browse",
      label: "Prismer Evolve Browse",
      description:
        "Browse public evolution genes. Search by category, keyword, or sort by popularity. Find genes to import or fork.",
      parameters: Type.Object({
        category: Type.Optional(
          Type.Union(
            [Type.Literal("repair"), Type.Literal("optimize"), Type.Literal("innovate"), Type.Literal("diagnostic")],
            { description: "Filter by gene category" },
          ),
        ),
        search: Type.Optional(
          Type.String({ description: "Search keyword (matches title, signals, strategy)" }),
        ),
        sort: Type.Optional(
          Type.Union(
            [Type.Literal("newest"), Type.Literal("most_used"), Type.Literal("highest_success")],
            { description: "Sort order (default: newest)" },
          ),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 10, max: 50)" }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { category, search, sort, limit } = args as {
          category?: string;
          search?: string;
          sort?: string;
          limit?: number;
        };
        try {
          const query: Record<string, string> = {};
          if (category) query.category = category;
          if (search) query.search = search;
          if (sort) query.sort = sort;
          if (limit) query.limit = String(limit);

          const result = (await prismerFetch(apiKey, "/api/im/evolution/public/genes", {
            query,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Browse failed"}` }],
              details: {},
            };
          }
          const genes = (result.data || []) as Record<string, unknown>[];
          if (genes.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No genes found matching the criteria." }],
              details: result,
            };
          }
          const lines = genes.map((g: Record<string, unknown>) => {
            const rate = typeof g.success_rate === "number" ? `${(g.success_rate * 100).toFixed(0)}%` : "?";
            return `- **${g.title || g.id}** [${g.category}] — ${rate} success, ${g.total_executions || 0} runs (ID: ${g.id})`;
          });
          return {
            content: [{ type: "text" as const, text: `Found ${genes.length} gene(s):\n\n${lines.join("\n")}` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
    {
      name: "prismer_evolve_import",
      label: "Prismer Evolve Import",
      description:
        "Import or fork a public gene into your own agent. Use prismer_evolve_browse to find gene IDs first.",
      parameters: Type.Object({
        gene_id: Type.String({ description: "ID of the public gene to import/fork" }),
        fork: Type.Optional(
          Type.Boolean({ description: "If true, creates a modifiable copy (fork) instead of a direct import (default: false)" }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { gene_id, fork } = args as { gene_id: string; fork?: boolean };
        try {
          const endpoint = fork
            ? "/api/im/evolution/genes/fork"
            : "/api/im/evolution/genes/import";
          const result = (await prismerFetch(apiKey, endpoint, {
            method: "POST",
            body: { gene_id },
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Import failed"}` }],
              details: {},
            };
          }
          const gene = result.data as Record<string, unknown>;
          const action = fork ? "Forked" : "Imported";
          return {
            content: [{ type: "text" as const, text: `${action}: ${gene.id} (${gene.category})` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ─── Recall Tool ──────────────────────────────────────────

    {
      name: "prismer_recall",
      label: "Prismer Recall",
      description:
        "Search across all knowledge layers — memory files, cached contexts, and evolution history. Returns the most relevant matches for your query.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query (keyword or phrase)" }),
        scope: Type.Optional(
          Type.Union([Type.Literal("all"), Type.Literal("memory"), Type.Literal("cache"), Type.Literal("evolution")], {
            description: 'Search scope: "all" (default), "memory", "cache", or "evolution"',
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 10)" }),
        ),
      }),
      execute: async (_toolCallId, args) => {
        const { query, scope, limit } = args as {
          query: string;
          scope?: string;
          limit?: number;
        };
        try {
          const queryParams: Record<string, string> = { q: query };
          if (scope) queryParams.scope = scope;
          if (limit) queryParams.limit = String(limit);

          const result = (await prismerFetch(apiKey, "/api/im/recall", {
            query: queryParams,
            baseUrl,
          })) as Record<string, unknown>;

          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Error: ${(result.error as string) || "Recall failed"}` }],
              details: {},
            };
          }
          const items = (result.data as Record<string, unknown>[]) || [];
          if (items.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No results found for "${query}".` }],
              details: result,
            };
          }
          const lines = items.map((item: Record<string, unknown>, i: number) => {
            const snippet = String(item.snippet || item.content || "").slice(0, 200);
            return `### ${i + 1}. [${item.source}] ${item.title || item.path || ""}\n${snippet}${snippet.length >= 200 ? "..." : ""}`;
          });
          return {
            content: [{ type: "text" as const, text: `Found ${items.length} result(s) for "${query}":\n\n${lines.join("\n\n")}` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}
