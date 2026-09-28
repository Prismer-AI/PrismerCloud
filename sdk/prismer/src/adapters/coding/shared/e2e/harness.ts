// WS-B3 — real-e2e harness. Drives the lifted Paseo engine through OUR stack
// (makeCodeAgentAdapter → ensureService → CodeAgentDriver.dispatch) against REAL agent
// binaries. Local-only; gated on binary availability.
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.7 WS-B (B3),
// §7.6 ② capability matrix + the 鉴权铁律 callout.
//
// 🔴 鉴权铁律: code agents do NOT use official claude/codex login. They
// authenticate through OUR cloud LLM gateway proxy (prod agent-rt pods have no
// interactive login). This harness sets route:'prismer' on the profile so
// provider-proxy-env injects the gateway base_url + sk-prismer token. We point
// PRISMER_BASE_URL at the LOCAL :3000 stack.
//
// Gateway facts (local :3000, curl-verified): /api/v1/messages routes the
// Anthropic wire for model us-kimi-k2.6; /api/v1/chat/completions + /api/v1/responses
// route gemini-3.1-flash-lite-preview. Code agents are model-agnostic via the
// gateway, so claude is pointed at a gateway channel (kimi), not an Anthropic model.
//
// Supply PRISMER_API_KEY explicitly for the local gateway; credentials never
// belong in the SDK source or its public mirror.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import type { Logger } from "pino";

import { makeCodeAgentAdapter } from "../make-code-agent-adapter.js";
import type { CodeAgentDriver } from "../code-agent-driver.js";
import type { AgentClient } from "../agent-sdk-types.js";
import type {
  AgentProfile,
  StepRecorderHandle,
  TaskHeartbeatHandle,
  TaskInput,
  TaskResult,
} from "../../../contract.js";
import { ClaudeAgentClient } from "../../claude-code/agent.js";
import { CodexAppServerAgentClient } from "../../codex/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../../opencode/opencode-agent.js";

const execFileAsync = promisify(execFile);

export const logger: Logger = pino({ level: process.env.PASEO_E2E_LOG ?? "silent" });

// ── Cloud gateway proxy config (LOCAL :3000 stack) ──────────────────────────
// Credentials are supplied by the caller for this local-only harness.
export const GATEWAY_BASE = "http://127.0.0.1:3000";

// Only these models route on the LOCAL gateway (no claude channel locally).
export const GATEWAY_MODELS = {
  // Anthropic wire (/api/v1/messages) translates → kimi. claude is model-agnostic
  // via our gateway, so claude-code points at a gateway channel, not a claude model.
  claude: "us-kimi-k2.6",
  // Responses wire (/api/v1/responses) routes gemini.
  codex: "gemini-3.1-flash-lite-preview",
  // OpenAI chat-completions wire via a CUSTOM opencode provider (WS-B2.6).
  // provider-proxy-env emits an opencode.json declaring provider `prismer`
  // (@ai-sdk/openai-compatible → our gateway) listing this model, so opencode
  // accepts the id and routes through OUR gateway. parseModel splits on '/'.
  opencode: "prismer/gemini-3.1-flash-lite-preview",
} as const;

// Inject the gateway base + key into process.env so the SHARED resolvers
// (resolveClaudeCodePrismerProvider / resolveCodexPrismerProvider) — driven by
// provider-proxy-env — resolve to our local gateway. PRISMER_BASE_URL=<base>
// → claude ANTHROPIC_BASE_URL=<base>/api; codex base_url=<base>/api/v1.
process.env.PRISMER_BASE_URL = process.env.PRISMER_BASE_URL ?? GATEWAY_BASE;

export function tmpCwd(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function rmCwd(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
}

export function compact(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/** Is a binary resolvable on PATH? */
export async function binaryAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

// ── Recorder + heartbeat doubles that capture the forwarded bridge events ──

// WS-C — opts shape carried alongside the legacy positional args.
export interface RecordedStepOpts {
  detail?: unknown;
  status?: "running" | "completed" | "failed" | "canceled";
  altitude?: "milestone" | "action";
}
export interface RecordedToolCall {
  toolName: string;
  input: unknown;
  toolCallId?: string;
  opts?: RecordedStepOpts;
}
export interface RecordedToolResult {
  toolCallId: string;
  output: unknown;
  opts?: RecordedStepOpts;
}

export class CapturingRecorder implements StepRecorderHandle {
  toolCalls: RecordedToolCall[] = [];
  toolResults: RecordedToolResult[] = [];
  reasoning: string[] = [];
  errors: Array<{ message: string; payload?: Record<string, unknown> }> = [];
  phaseChanges: string[] = [];
  // WS-C captures:
  todos: Array<{ text: string; completed: boolean }[]> = [];
  usages: Array<Record<string, number | undefined>> = [];

  recordPhaseChange(phase: string): void {
    this.phaseChanges.push(phase);
  }
  recordToolCall(
    toolName: string,
    input: unknown,
    toolCallId?: string,
    opts?: RecordedStepOpts,
  ): void {
    this.toolCalls.push({ toolName, input, toolCallId, opts });
  }
  recordToolResult(toolCallId: string, output: unknown, opts?: RecordedStepOpts): void {
    this.toolResults.push({ toolCallId, output, opts });
  }
  recordReasoningChunk(text: string): void {
    this.reasoning.push(text);
  }
  recordError(message: string, payload?: Record<string, unknown>): void {
    this.errors.push({ message, payload });
  }
  recordTodo(items: { text: string; completed: boolean }[]): void {
    this.todos.push(items);
  }
  recordUsage(usage: Record<string, number | undefined>): void {
    this.usages.push(usage);
  }
}

export class CapturingHeartbeat implements TaskHeartbeatHandle {
  phases: string[] = [];
  stepTouches = 0;
  setPhase(phase: string): void {
    this.phases.push(phase);
  }
  touchStep(): void {
    this.stepTouches += 1;
  }
}

export interface DispatchHandle {
  recorder: CapturingRecorder;
  heartbeat: CapturingHeartbeat;
  controller: AbortController;
  task: TaskInput;
}

/** Build a minimal real TaskInput wired with capturing doubles. */
export function makeTaskInput(params: {
  prompt: string;
  taskId?: string;
}): DispatchHandle {
  const recorder = new CapturingRecorder();
  const heartbeat = new CapturingHeartbeat();
  const controller = new AbortController();
  const taskId = params.taskId ?? `run_${Math.random().toString(36).slice(2, 10)}`;
  const task: TaskInput = {
    taskId,
    kind: "run",
    runId: taskId,
    prompt: params.prompt,
    metadata: { conversationId: "e2e-conv", agentImUserId: "e2e-agent" },
    recorder,
    heartbeat,
    signal: controller.signal,
  };
  return { recorder, heartbeat, controller, task };
}

export type ProviderName = "claude" | "codex" | "opencode";

export function makeClient(provider: ProviderName): AgentClient {
  switch (provider) {
    case "claude":
      return new ClaudeAgentClient({ logger });
    case "codex":
      return new CodexAppServerAgentClient(logger);
    case "opencode":
      return new OpenCodeAgentClient(logger);
  }
}

/**
 * Construct a CodeAgentDriver THROUGH the bridge: makeCodeAgentAdapter(client) →
 * ensureService(profile). This is the WS-B contract surface, not the raw
 * provider — so the bridge is what's exercised.
 */
export async function makeService(
  provider: ProviderName,
  cwd: string,
  extra?: { model?: string; modeId?: string; proxyProvider?: string },
): Promise<CodeAgentDriver> {
  if (!process.env.PRISMER_API_KEY?.trim()) {
    throw new Error("PRISMER_API_KEY must be explicitly supplied for local real-e2e tests");
  }
  const client = makeClient(provider);
  const adapter = makeCodeAgentAdapter(client);
  // Default each provider to the model that routes on the LOCAL gateway.
  const model = extra?.model ?? GATEWAY_MODELS[provider];
  // 🔴 鉴权铁律: route through OUR gateway, never official login.
  //  - claude: resolveClaudeCodePrismerProvider honors route:'prismer' alone.
  //  - codex/opencode: resolveCodexPrismerProvider REQUIRES proxyProvider —
  //    'default' → base_url=<base>/api/v1 (no chain proxy path).
  const profile: AgentProfile = {
    id: "e2e-profile",
    workspaceId: "e2e-ws",
    agentImUserId: "e2e-agent",
    adapterName: provider,
    name: `e2e-${provider}`,
    config: {
      cwd,
      model,
      modeId: extra?.modeId,
      route: "prismer",
      proxyProvider: extra?.proxyProvider ?? "default",
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (!adapter.ensureService) {
    throw new Error("makeCodeAgentAdapter must provide ensureService");
  }
  const service = (await adapter.ensureService(profile)) as CodeAgentDriver;
  return service;
}

export type { TaskResult };
