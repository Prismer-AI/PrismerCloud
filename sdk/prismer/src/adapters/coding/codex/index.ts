// D21: CLI fallback — DELETE this path once the engine-backed adapter is stable in prod.
//
// Codex adapter — interactive (spawn-per-task) invocation via `codex exec`.
//
// INVOCATION PATTERN (Codex CLI as of 2026-05, source: developers.openai.com/codex):
//   codex exec --model <model> --cd <cwd> --sandbox <level> --ephemeral --json "<prompt>"
//
// MANUAL TEST:
//   1. Install: npm install -g @openai/codex
//   2. Set env:  export OPENAI_API_KEY="sk-..."
//   3. Create an AgentProfile with adapterName='codex' and config:
//        { "cwd": "/tmp/sandbox", "model": "codex-mini-latest", "sandbox": "workspace-write" }
//   4. Mention the Codex agent in a group chat — daemon should reply with code output.
//      Or: prismer task create --agent <codex-agent-imUserId> --prompt "Write hello.py"
//
// UNCERTAINTY LOG (verify empirically when wiring this into a real run):
//   U1: --json JSONL schema. OpenAI docs say Codex streams progress to stderr and
//       prints only the final agent message to stdout. The --json flag produces JSONL
//       on stdout; assumed shape is {"type":"message","content":"..."} but
//       parseCodexOutput() falls back to raw stdout if no matching line is found —
//       the adapter never returns empty output from a successful run. Verify with:
//         codex exec --json --ephemeral "echo hello"
//   U2: --cd flag availability. Confirmed in CLI reference; spawn() also passes
//       { cwd } so the working directory is correct on versions predating --cd.
//   U3: --sandbox default. workspace-write is the practical pick for code-gen;
//       operators can downgrade to read-only or escalate to danger-full-access via
//       profile config. danger-full-access is for daemons running inside containers.
//   U4: System prompt. Codex `exec` has no documented --system-prompt flag (2026-05).
//       We prepend the system prompt to the user prompt as a newline-separated
//       preamble. Replace with a flag once upstream adds one.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AdapterDef,
  AgentProfile,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from '../../contract.js';
import { categorizeDispatchError, withCancellation } from '../../contract.js';
import { isVersionInRange, parseVersionFromStdout } from '../../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../../known-versions.js';

/**
 * Tested-good codex binary version range (Release 201 v2.0.7 P1).
 *
 * `health()` probes `codex --version`, parses the result, and warns when
 * the detected version drifts below MIN_VERSION or away from KNOWN_GOOD.
 * Update both pins (and `known-versions.ts`) when a new upstream rev is
 * exercised by the cookbook + CI smoke pass.
 */
const CODEX_MIN_VERSION = ADAPTER_KNOWN_VERSIONS.codex!.minVersion;
const CODEX_KNOWN_GOOD = ADAPTER_KNOWN_VERSIONS.codex!.knownGood;
import { applyPrismerScopeEnv, resolveSpawnScratchCwd } from '../../prismer-env.js';
import { createExternalProcessEnv } from '../shared/shims/paseo-env.js';
import { getProviderSessionMapper } from '../../../daemon/provider-session-mapper.js';
import {
  resolveLocalProvider,
  isLocalProviderSelector,
  codexSupportsLocalType,
} from '../../shared/local-provider.js';

// ---------------------------------------------------------------------------
// Profile config schema
// ---------------------------------------------------------------------------

export const CodexConfigSchema = z.object({
  /** Working directory for the codex subprocess. */
  cwd: z.string().min(1),

  /**
   * Model identifier passed to --model (e.g. 'codex-mini-latest', 'o4-mini').
   * Default matches the Codex CLI built-in default as of 2026-05.
   */
  model: z.string().default('codex-mini-latest'),

  /**
   * Sandbox level for the codex subprocess.
   *   read-only         — analysis only; code-gen tasks will stall
   *   workspace-write   — write inside cwd, read-only outside (recommended)
   *   danger-full-access — no restrictions; safe only inside isolated containers
   */
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write'),

  /** Optional system prompt prepended to the user prompt as a preamble (see U4). */
  systemPrompt: z.string().optional(),

  /** Extra env vars merged into the codex subprocess environment. */
  envVars: z.record(z.string(), z.string()).optional(),

  /**
   * Name of the env var holding the OpenAI API key. Defaults to
   * 'OPENAI_API_KEY' (Codex CLI default). Override if using a workspace-
   * scoped key under a different name.
   */
  apiKeyEnv: z.string().default('OPENAI_API_KEY'),

  /**
   * release202/03 §3.2 + 07 — route Codex through our cloud gateway instead of
   * the official OpenAI endpoint. When set, the adapter writes a per-dispatch
   * `CODEX_HOME/config.toml` pointing `model_provider=prismer` with
   * `wire_api="responses"` and a `sk-prismer-*` bearer at:
   *   - `newapi` (or default) → `<PRISMER_BASE_URL>/api/v1`        (→ /api/v1/responses)
   *   - any other chain id     → `<PRISMER_BASE_URL>/api/v1/proxy/<chain>`  (→ /api/v1/proxy/<chain>/responses)
   * The cloud bridge translates Responses↔Chat and walks the selected provider
   * chain (07). release202/07 widened this from the old `'newapi'|'deepseek'`
   * enum to ANY configured chain id. Undefined = official OpenAI endpoint.
   */
  proxyProvider: z.string().min(1).optional(),

  /** Env var holding the sk-prismer-* key (default PRISMER_API_KEY). */
  prismerApiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default('PRISMER_API_KEY'),

  /**
   * release202/05 C2 — per-(conversation × agent) session continuity. When true
   * (default), the adapter persists codex session files (drops `--ephemeral`)
   * and, on subsequent turns of the same conversation, resumes the prior
   * codex thread via `codex exec resume <thread_id>` so context carries across
   * turns instead of re-bootstrapping every dispatch.
   *
   * Empirically verified (codex-cli 0.133.0, 2026-06-02): a fresh `codex exec`
   * emits `{"type":"thread.started","thread_id":"<uuid>"}`; `codex exec resume
   * --json --skip-git-repo-check <thread_id> "<prompt>"` reloads that thread and
   * recalls prior context. NOTE: `--sandbox`/`--cd` are NOT accepted on the
   * `resume` subcommand (the help lists them but the parser rejects them when a
   * positional SESSION_ID is present); sandbox is inherited from the persisted
   * session, so resume turns reuse turn-1's sandbox/cwd.
   *
   * Set false to keep the legacy `--ephemeral` one-shot behavior (no session
   * files, no resume).
   */
  sessionContinuity: z.boolean().default(true),
});

export type CodexConfig = z.infer<typeof CodexConfigSchema>;

// ---------------------------------------------------------------------------
// Prismer gateway routing (release202/03 §3.2)
// ---------------------------------------------------------------------------

interface PrismerProvider {
  baseUrl: string; // e.g. https://test.docbrew.cn/api/v1
  apiKey: string; // sk-prismer-*
}

/** Resolve the cloud gateway base + key from env, mirroring the hermes adapter. */
export function resolveCodexPrismerProvider(config: CodexConfig): PrismerProvider | null {
  if (!config.proxyProvider) return null;
  // Desktop-202 Phase 7 (docs/desktop202/12 §2): daemon-local provider profile
  // (BYOK / Ollama) is the MIDDLE resolution layer. When `proxyProvider` names a
  // configured `[[providers]]` id with a resolvable key (Ollama: keyless), codex
  // direct-connects to the profile's base_url. Unset / cloud-chain selector →
  // null → existing cloud-chain path below, byte-for-byte unchanged.
  const local = resolveLocalProvider(config.proxyProvider);
  if (local) {
    // Desktop-202 Phase 7 second wave (docs/desktop202/12 §2): codex is
    // RESPONSES-ONLY (`wire_api = "responses"`, writeCodexPrismerHome). It can
    // only direct-connect to a provider serving the OpenAI Responses API — among
    // the local types that's ONLY the official OpenAI endpoint. Ollama /
    // DeepSeek / openai-compatible serve chat_completions (not responses) and
    // Anthropic a different protocol; writing them as `wire_api=responses` would
    // 404/400 at runtime. So for unsupported types we DECLINE the direct-connect
    // and fall through to the cloud chain (known codex limitation — BYOK on codex
    // is OpenAI-only until a chat_completions↔responses bridge exists; that
    // bridge today IS the cloud gateway). hermes covers the other BYOK types.
    if (!codexSupportsLocalType(local.type)) {
      process.stderr.write(
        `[codex-adapter] local provider '${local.profileId}' (type=${local.type}) is not codex-compatible ` +
          `(codex is responses-only); falling back to the cloud chain. Use the hermes adapter for this provider, ` +
          `or an 'openai'/openai-compatible-responses endpoint for codex.\n`,
      );
    } else {
      // OpenAI exposes the Responses API at its base_url verbatim.
      return { baseUrl: local.baseUrl, apiKey: local.apiKey ?? '' };
    }
  }
  const base = process.env.PRISMER_BASE_URL?.replace(/\/+$/, '');
  const apiKey = process.env[config.prismerApiKeyEnv] || process.env.PRISMER_API_KEY || '';
  if (!base || !apiKey) {
    process.stderr.write(
      `[codex-adapter] proxyProvider set but missing PRISMER_BASE_URL or ${config.prismerApiKeyEnv}; falling back to official OpenAI endpoint\n`,
    );
    return null;
  }
  // release202/07 — honor the chain. Codex appends `/responses` to base_url.
  //   newapi/default → /api/v1            (→ /api/v1/responses)
  //   other chain    → /api/v1/proxy/<chain>  (→ /api/v1/proxy/<chain>/responses)
  // Mirrors the hermes adapter's proxyProvider → base_url resolution so a
  // codex profile with proxyProvider:'deepseek' actually routes to deepseek.
  // A `local:<id>` selector reaching here did NOT resolve (profile absent / key
  // unprovisioned / codex-incompatible type). It names nothing on the cloud, so
  // treating it as a chain would build `/api/v1/proxy/local%3A<id>/responses` →
  // 404 on every call. Land on the aggregator instead, as with no selector.
  const provider = config.proxyProvider;
  const apiPath =
    !provider || provider === 'newapi' || provider === 'default' || isLocalProviderSelector(provider)
      ? '/api/v1'
      : `/api/v1/proxy/${encodeURIComponent(provider)}`;
  return { baseUrl: `${base}${apiPath}`, apiKey };
}

/**
 * Write a `CODEX_HOME/config.toml` that routes Codex through our gateway.
 * Returns the CODEX_HOME dir to export. `model` is the curated model id.
 *
 * Notes (all empirically verified):
 *  - `wire_api = "responses"` — Codex >= v0.133 is responses-only.
 *  - `model_reasoning_effort = "none"` — our bridge drops `reasoning` anyway,
 *    but this stops Codex emitting it for models it assumes are reasoning-capable.
 *  - `disable_response_storage = true` — REQUIRED for non-OpenAI Responses
 *    providers (e.g. our gateway → DeepSeek/Gemini chains). Without it codex
 *    tries to use OpenAI server-side response storage and the turn FAILS.
 *    PROVEN 2026-06-18: codex completed a turn (PONG, 9822 tokens) via the
 *    gateway DeepSeek source only with this flag set.
 *  - auth via BOTH `experimental_bearer_token` (config.toml) AND an `auth.json`
 *    holding `{ "OPENAI_API_KEY": "<sk-prismer>" }`. Codex reads the bearer for
 *    the custom provider from auth.json's OPENAI_API_KEY when
 *    `requires_openai_auth = true`; the config-level bearer is kept for older
 *    revs. Both point at the same sk-prismer token, so it can't drift.
 */
export function writeCodexPrismerHome(
  homeDir: string,
  model: string,
  provider: PrismerProvider,
  httpHeaders?: Record<string, string>,
): string {
  mkdirSync(homeDir, { recursive: true });
  // desktop202/20 — codex ModelProviderInfo supports a static `http_headers`
  // table (codex-rs/model-provider-info). We stamp `x-prismer-task-run-id` here
  // so every codex LLM call carries the dispatch run id and the cloud proxy can
  // record fallback/vision-filter routing keyed by it.
  const headerEntries = Object.entries(httpHeaders ?? {});
  const headersToml = headerEntries.length
    ? `\n[model_providers.prismer.http_headers]\n` +
      headerEntries.map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}\n`).join('')
    : '';
  const toml =
    `model = ${JSON.stringify(model)}\n` +
    `model_provider = "prismer"\n` +
    `model_reasoning_effort = "none"\n` +
    `disable_response_storage = true\n` +
    `\n[model_providers.prismer]\n` +
    `name = "Prismer Cloud Gateway"\n` +
    `base_url = ${JSON.stringify(provider.baseUrl)}\n` +
    `wire_api = "responses"\n` +
    `requires_openai_auth = true\n` +
    `experimental_bearer_token = ${JSON.stringify(provider.apiKey)}\n` +
    headersToml;
  writeFileSync(join(homeDir, 'config.toml'), toml, { mode: 0o600 });
  // auth.json: codex reads the API key for a `requires_openai_auth` provider
  // from CODEX_HOME/auth.json's OPENAI_API_KEY. PROVEN-required config.
  writeFileSync(
    join(homeDir, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: provider.apiKey }) + '\n',
    { mode: 0o600 },
  );
  return homeDir;
}

/** Hosts to bypass system/HTTP proxy for (Codex/reqwest honors system proxy → 502 on localhost). */
export function buildCodexNoProxy(baseUrl: string): string {
  const hosts = new Set(['localhost', '127.0.0.1']);
  try {
    hosts.add(new URL(baseUrl).hostname);
  } catch {
    /* ignore unparseable */
  }
  return [...hosts].join(',');
}

// ---------------------------------------------------------------------------
// Prompt assembly (system-prompt preamble + workspace prompt + task prompt)
// ---------------------------------------------------------------------------

/**
 * Build the prompt string passed to `codex exec`. Codex has no native skill
 * framework (U4 — no `--system-prompt` flag) so we inject everything via
 * one combined prompt. Order:
 *
 *   1. Dispatch-supplied systemPrompt (preferred — composed by daemon's
 *      `dispatch.ts` to include profile persona + operating principles),
 *      falling back to `config.systemPrompt` when invoked without a daemon
 *      (e.g. unit tests that call buildCodexPrompt directly).
 *   2. The actual task prompt
 *
 * product209/15 PKF-C2: the old full-text `memory-curation` skill preamble was
 * REMOVED — Codex discovers skill text through the standard skill delivery
 * (remote → verified LKG → bundled fallback) like every other adapter. No
 * adapter-specific PKF/curation grammar copy lives here anymore.
 *
 * Pure function — no I/O, no `process` access, no spawn. Extracted for
 * unit testing of the skill-injection wiring without spawning the codex CLI.
 */
export function buildCodexPrompt(
  config: CodexConfig,
  taskPrompt: string,
  metadataSystemPrompt?: string,
): string {
  const effectiveSystemPrompt = metadataSystemPrompt ?? config.systemPrompt;
  if (effectiveSystemPrompt && effectiveSystemPrompt.trim()) {
    return `${effectiveSystemPrompt.trim()}\n\n${taskPrompt}`;
  }
  return taskPrompt;
}

// ---------------------------------------------------------------------------
// JSONL output parser
// ---------------------------------------------------------------------------

/** Cap retained output to bound memory on runaway responses. */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Parse `codex exec --json` stdout. The CLI emits newline-delimited JSON
 * lines on stdout; we look for the final-message line and extract its
 * content. Tolerant: any parse failure falls back to raw stdout.
 */
export function parseCodexOutput(stdout: string): string {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        content?: string;
        message?: string;
        text?: string;
        item?: { type?: string; text?: string; content?: string };
      };
      // Codex v0.133 schema: final answer is
      //   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
      // (verified 2026-06-02 via `codex exec --json`). Prefer this; keep the
      // older flat shapes as fallback for version drift.
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        const text = obj.item.text ?? obj.item.content ?? '';
        if (text) {
          return text.length > MAX_OUTPUT_CHARS
            ? text.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]'
            : text;
        }
      }
      if (obj.type === 'message' || obj.type === 'assistant' || obj.type === 'output') {
        const text = obj.content ?? obj.message ?? obj.text ?? '';
        if (text) {
          return text.length > MAX_OUTPUT_CHARS
            ? text.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]'
            : text;
        }
      }
    } catch {
      // Not JSON — skip.
    }
  }
  const raw = stdout.trim();
  return raw.length > MAX_OUTPUT_CHARS
    ? raw.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]'
    : raw;
}

// ---------------------------------------------------------------------------
// C2 — session id extraction
// ---------------------------------------------------------------------------

/**
 * release202/05 C2 — extract the resumable codex thread/session id from
 * `codex exec --json` stdout. Empirically (codex-cli 0.133.0) the very first
 * JSONL line is `{"type":"thread.started","thread_id":"<uuid>"}`; that
 * `thread_id` is exactly what `codex exec resume <id>` accepts (the
 * human-readable `session id:` banner is NOT printed in --json mode).
 *
 * Returns null when no thread.started line is present (e.g. an --ephemeral run,
 * or a failure before the session was created). Pure — unit-tested.
 */
export function parseCodexSessionId(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !line.startsWith('{') || !line.includes('thread.started')) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; thread_id?: string };
      if (obj.type === 'thread.started' && typeof obj.thread_id === 'string' && obj.thread_id) {
        return obj.thread_id;
      }
    } catch {
      // Not JSON — skip.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C1 — incremental progress from streaming JSONL
// ---------------------------------------------------------------------------

export interface CodexProgressEvent {
  message: string;
  detail: Record<string, unknown>;
}

/**
 * release202/05 C1 — map a single `codex exec --json` JSONL line to a
 * user-facing progress event, or null when the line carries no actionable
 * progress (thread.started / turn.* / reasoning / parse failures).
 *
 * Recognized (empirically, codex-cli 0.133.0):
 *   item.started   command_execution → "running: <command>"
 *   item.completed command_execution → "ran (exit N): <command>"
 *   item.completed agent_message     → "message" (truncated)
 *
 * Pure — unit-tested.
 */
export function codexJsonlToProgress(line: string): CodexProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj: {
    type?: string;
    item?: {
      type?: string;
      command?: string;
      exit_code?: number | null;
      status?: string;
      text?: string;
      content?: string;
    };
  };
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const item = obj.item;
  if (!item || (obj.type !== 'item.started' && obj.type !== 'item.completed')) return null;

  if (item.type === 'command_execution' && typeof item.command === 'string') {
    const cmd = item.command.length > 160 ? item.command.slice(0, 160) + '…' : item.command;
    if (obj.type === 'item.started') {
      return {
        message: `running: ${cmd}`,
        detail: { kind: 'command_execution', phase: 'started', command: item.command },
      };
    }
    // item.completed
    const exit = typeof item.exit_code === 'number' ? item.exit_code : '?';
    return {
      message: `ran (exit ${exit}): ${cmd}`,
      detail: {
        kind: 'command_execution',
        phase: 'completed',
        command: item.command,
        exitCode: item.exit_code ?? null,
      },
    };
  }

  if (item.type === 'agent_message' && obj.type === 'item.completed') {
    const text = (item.text ?? item.content ?? '').trim();
    if (!text) return null;
    const msg = text.length > 200 ? text.slice(0, 200) + '…' : text;
    return { message: msg, detail: { kind: 'agent_message' } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// release203/06 §3.0 / P0 — JSONL → normalized StepRecorder frame
// ---------------------------------------------------------------------------

/**
 * release203/06 §3.0 — map a single `codex exec --json` JSONL line to one
 * normalized step recorder action, so the unified AgentMessage component
 * shows a real timeline (tool rows + reasoning) for Codex instead of just
 * received→done. Pure (no recorder dependency) so it is unit-testable: the
 * caller applies the returned action against `task.recorder`.
 *
 * Mapping (codex-cli 0.133.0 `exec --json` schema, verified by the existing
 * parseCodexOutput / codexJsonlToProgress comments + cookbook):
 *   item.started   command_execution → tool_call   (toolCallId = item.id)
 *   item.completed command_execution → tool_result (toolCallId = item.id)
 *   item.completed agent_message     → reply        (final text)
 *   item.completed reasoning         → reasoning_chunk
 *
 * `command_execution` is keyed by codex's own `item.id` so the started/completed
 * pair correlates (started and completed carry the same id). When absent we fall
 * back to a stable per-command key so the pairing still works in older revs.
 */
export type CodexStepAction =
  | { kind: 'tool_call'; toolName: string; input: unknown; toolCallId: string }
  | { kind: 'tool_result'; toolCallId: string; output: unknown }
  | { kind: 'reasoning_chunk'; text: string }
  | { kind: 'reply'; text: string };

export function codexJsonlToStep(line: string): CodexStepAction | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj: {
    type?: string;
    item?: {
      id?: string;
      type?: string;
      command?: string;
      exit_code?: number | null;
      aggregated_output?: string;
      status?: string;
      text?: string;
      content?: string;
    };
  };
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const item = obj.item;
  if (!item || (obj.type !== 'item.started' && obj.type !== 'item.completed')) return null;

  if (item.type === 'command_execution' && typeof item.command === 'string') {
    const toolCallId = item.id ?? `cmd:${item.command}`;
    if (obj.type === 'item.started') {
      return {
        kind: 'tool_call',
        toolName: 'shell',
        input: { command: item.command },
        toolCallId,
      };
    }
    // item.completed
    return {
      kind: 'tool_result',
      toolCallId,
      output: {
        exitCode: item.exit_code ?? null,
        output: item.aggregated_output ?? item.text ?? item.content ?? '',
      },
    };
  }

  if (obj.type === 'item.completed' && item.type === 'reasoning') {
    const text = (item.text ?? item.content ?? '').trim();
    if (!text) return null;
    return { kind: 'reasoning_chunk', text };
  }

  if (obj.type === 'item.completed' && item.type === 'agent_message') {
    const text = (item.text ?? item.content ?? '').trim();
    if (!text) return null;
    return { kind: 'reply', text };
  }

  return null;
}

/**
 * Build the `codex` argv for a dispatch. Pure (testable) — three shapes:
 *   1. resume:    `exec resume --json --skip-git-repo-check <id> -- <prompt>`
 *                 (codex 0.133.0: --sandbox/--cd are rejected on `resume`;
 *                  sandbox/cwd are inherited from the persisted session.)
 *   2. persisted: `exec --model … --cd … --sandbox … --skip-git-repo-check
 *                  --json -- <prompt>` (no --ephemeral → session kept for resume).
 *   3. ephemeral: same as (2) plus --ephemeral (continuity disabled).
 *
 * The `--` end-of-options separator before the prompt is REQUIRED: composed
 * system prompts may begin with YAML frontmatter (`---\nname:…`) and without
 * `--` codex's clap parser treats a positional starting with `--` as an
 * unknown flag → `error: unexpected argument '---…'` (exit 2). Verified
 * codex 0.133.0, 2026-06-02 (regression: web @-mention of a codex agent).
 */
export function buildCodexArgs(opts: {
  resumeId: string | null;
  model: string;
  spawnCwd: string;
  sandbox: string;
  sessionContinuity: boolean;
  prompt: string;
}): string[] {
  const { resumeId, model, spawnCwd, sandbox, sessionContinuity, prompt } = opts;
  if (resumeId) {
    // `resume` rejects --sandbox/--cd and inherits the persisted session's
    // approval/sandbox policy (turn-1 launched with the bypass flag below), so
    // the resumed turn stays autonomous without re-passing the flag.
    return ['exec', 'resume', '--json', '--skip-git-repo-check', resumeId, '--', prompt];
  }
  // Daemon-side FORCE: agent-rt pods are non-interactive — no approval prompt can
  // ever be answered. `--dangerously-bypass-approvals-and-sandbox` is the codex
  // CLI autonomous launch (it supersedes --sandbox: approvals=never, no sandbox).
  // The pod itself is the isolation boundary, so this is safe here.
  void sandbox;
  const args = [
    'exec',
    '--model',
    model,
    '--cd',
    spawnCwd,
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
  ];
  if (!sessionContinuity) args.push('--ephemeral');
  args.push('--json', '--', prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Adapter definition
// ---------------------------------------------------------------------------

export const codexAdapter: AdapterDef = {
  name: 'codex',
  kind: 'interactive',
  capabilities: ['code', 'shell', 'openai'],
  workspaceSchema: CodexConfigSchema,

  validate(config: unknown): ValidationResult {
    const r = CodexConfigSchema.safeParse(config);
    if (r.success) return { ok: true };
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  },

  async dispatch(profile: AgentProfile, task: TaskInput): Promise<TaskResult> {
    const config = CodexConfigSchema.parse(profile.config);
    // v2.0 (A3) — read dispatch-composed systemPrompt (profile persona +
    // operating principles) and fall back to profile config when absent.
    const metadataSystemPrompt =
      typeof task.metadata?.systemPrompt === 'string' ? task.metadata.systemPrompt : undefined;
    const effectivePrompt = buildCodexPrompt(config, task.prompt, metadataSystemPrompt);

    // release202/04 §3.2 — spawn-style adapter: a FRESH `codex exec` runs per
    // dispatch, so point both --cd and spawn cwd at this dispatch's per-task
    // scratch dir (task.metadata.prismerScratchDir, legacy fallback
    // prismerWorkDir). Relative-path writes then land in the task sandbox
    // instead of /tmp or the daemon cwd. Falls back to config.cwd when
    // dispatch didn't provision one (adapter invoked outside the daemon).
    const spawnCwd = resolveSpawnScratchCwd(task.metadata as Record<string, unknown> | undefined) ?? config.cwd;

    // release202/05 C2 — session continuity. When enabled and we have the
    // (conversation × agent) key, look up the prior codex thread id so we can
    // `resume` it. The mapper is null in unit tests / standalone runs → degrade
    // gracefully to a fresh session.
    const conversationId =
      typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : undefined;
    const agentImUserId =
      typeof task.metadata?.agentImUserId === 'string' ? task.metadata.agentImUserId : undefined;
    const resumeId =
      config.sessionContinuity && conversationId && agentImUserId
        ? getProviderSessionMapper()?.get(conversationId, agentImUserId, 'codex') ?? null
        : null;

    const args = buildCodexArgs({
      resumeId,
      model: config.model,
      spawnCwd,
      sandbox: config.sandbox,
      sessionContinuity: config.sessionContinuity,
      prompt: effectivePrompt,
    });

    const startedAt = Date.now();
    // apc/17 §8.1 W2.1′ — same allowlist chokepoint as the CodeAgentDriver path.
    // `codex-cli` (the D21 fallback adapter) previously inherited the daemon's
    // env verbatim. `config.envVars` remains an OVERLAY (merged post-filter).
    const env: NodeJS.ProcessEnv = createExternalProcessEnv(process.env, config.envVars ?? {});
    // Pin TERMINAL_CWD to the same sandbox so tools that honor it resolve there.
    if (env.TERMINAL_CWD == null) {
      env.TERMINAL_CWD = spawnCwd;
    }
    // Wave-9 / release202/04 — surface per-task artifacts dir to codex so its
    // shell sandbox can resolve $PRISMER_ARTIFACTS_DIR (the only agent-facing
    // name; PRISMER_OUTBOX_DIR is dead). dispatch.ts provisions the dir.
    // release201/09 §9.9 — also injects PRISMER_WORKSPACE_ID /
    // PRISMER_ACTIVE_PROJECT_ID / PRISMER_AGENT_ID / PRISMER_TASK_ID /
    // PRISMER_DAEMON_ID + PRISMER_SCRATCH_DIR (+ legacy PRISMER_WORKDIR) via
    // the shared helper.
    applyPrismerScopeEnv(env as Record<string, string | undefined>, task.metadata as Record<string, unknown> | undefined);

    // release202/03 §3.2 — route Codex through our cloud gateway (responses
    // bridge) when proxyProvider is set. Write a per-dispatch CODEX_HOME with a
    // config.toml pointing model_provider=prismer at <base>/api/v1.
    const prismerProvider = resolveCodexPrismerProvider(config);
    if (prismerProvider) {
      // CODEX_HOME holds codex's rollout/session files. For cross-turn `resume`
      // (C2) it MUST be stable per conversation — NOT per task. The per-task
      // scratch (spawnCwd) changes every turn, so turn-2's `codex exec resume
      // <thread_id>` can't find turn-1's rollout → "no rollout found for thread
      // id" (release202/05). Prefer the session-level dir (prismerSessionDir,
      // cross-turn retained, doc 04 §3.1) so all turns share one CODEX_HOME;
      // fall back to task scratch when there's no session (one-shot task).
      const sessionDir =
        typeof task.metadata?.prismerSessionDir === 'string' ? task.metadata.prismerSessionDir : null;
      const codexHomeBase = config.sessionContinuity && sessionDir ? sessionDir : spawnCwd;
      // desktop202/20 — stamp the dispatch run id so the cloud proxy can record
      // this run's routing outcome (fallback / vision-filter) keyed by it.
      const runId =
        typeof task.metadata?.prismerDispatchId === 'string' ? task.metadata.prismerDispatchId : undefined;
      const codexHome = writeCodexPrismerHome(
        join(codexHomeBase, '.codex-home'),
        config.model,
        prismerProvider,
        runId ? { 'x-prismer-task-run-id': runId } : undefined,
      );
      env.CODEX_HOME = codexHome;
    }

    // release202/05 — ALWAYS bypass the (macOS system / HTTP_PROXY) proxy for
    // localhost + the gateway host. Codex/reqwest honors the macOS system proxy
    // (`scutil --proxy`), so a localhost gateway call silently routes through it
    // and HANGS until the idle timeout → the daemon reaper aborts at 5min "no
    // progress" (root cause of the reaper kill on a fresh codex agent). This is
    // unconditional (not gated on prismerProvider) because the bypass is correct
    // whenever codex dials our gateway, and a stale resolve must not strand it.
    const noProxy = buildCodexNoProxy(prismerProvider?.baseUrl ?? 'http://localhost');
    env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${noProxy}` : noProxy;
    env.no_proxy = env.no_proxy ? `${env.no_proxy},${noProxy}` : noProxy;

    // stdio: stdin MUST be 'ignore' (→ /dev/null, immediate EOF). `codex exec`
    // prints "Reading additional input from stdin..." and BLOCKS reading stdin
    // when it's an open pipe; spawn()'s default ['pipe','pipe','pipe'] leaves
    // stdin open (we never write/close it) → codex hangs forever before making
    // any HTTP call → the daemon reaper aborts at 5min "no progress". The prompt
    // is already passed via argv (after `--`), so no stdin input is needed.
    // (release202/05 — root cause of the codex reaper kill on real dispatch;
    // standalone shell runs worked only because the shell gave codex EOF stdin.)
    const child = spawn('codex', args, { cwd: spawnCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    // release202/05 C1 — incremental progress. We still accumulate the full
    // stdout for the final parseCodexOutput; on top of that we split off
    // complete JSONL lines as they arrive and emit task.onProgress() for
    // command_execution / agent_message items. `lineBuf` holds the partial
    // trailing line between chunks. `progress` is a simple monotonic estimate
    // bumped per emitted event and capped below 100 (the dispatcher owns 100%).
    let lineBuf = '';
    let progress = 5;
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // release203/06 §3.0 — also feed the step recorder (normalized timeline)
      // even when there's no onProgress consumer.
      if (!task.onProgress && !task.recorder) return;
      lineBuf += text;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (task.onProgress) {
          const ev = codexJsonlToProgress(line);
          if (ev) {
            progress = Math.min(95, progress + 5);
            task.onProgress({ progress, message: ev.message, detail: ev.detail });
          }
        }
        // release203/06 §3.0 / P0 — emit the same JSONL line as a normalized
        // recorder frame (tool_call / tool_result / reasoning_chunk) so the
        // unified AgentMessage timeline is populated for Codex. The final
        // agent_message reply is carried separately via TaskResult.output
        // (parseCodexOutput), so we don't double-emit it as a step.
        if (task.recorder) {
          const step = codexJsonlToStep(line);
          if (step) {
            switch (step.kind) {
              case 'tool_call':
                task.recorder.recordToolCall(step.toolName, step.input, step.toolCallId);
                break;
              case 'tool_result':
                task.recorder.recordToolResult(step.toolCallId, step.output);
                break;
              case 'reasoning_chunk':
                task.recorder.recordReasoningChunk(step.text);
                break;
              case 'reply':
                // final reply → TaskResult.output, not a step frame.
                break;
            }
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // v2.0 (A6) — cancellation + timeout boilerplate moved to contract.ts.
    const teardown = withCancellation(task, child);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(-1));
    });
    teardown();

    const durationMs = Date.now() - startedAt;

    if (task.signal?.aborted) {
      const cancelled = categorizeDispatchError(null, task.signal);
      return { ...cancelled, metrics: { durationMs } };
    }

    if (exitCode !== 0) {
      // C2 self-heal: a resume that fails because the rollout is gone ("no
      // rollout found for thread id" / "thread/resume failed") must not loop —
      // forget the stale mapping so the daemon's retry (and future turns) start
      // a fresh codex session instead of re-resuming a dead thread id.
      if (resumeId && /no rollout found|thread\/resume failed/i.test(stderr) && conversationId && agentImUserId) {
        getProviderSessionMapper()?.clear(conversationId, agentImUserId, 'codex');
        process.stderr.write(
          `[codex-adapter] cleared stale codex session for conv=${conversationId} (resume rollout missing) — next dispatch starts fresh\n`,
        );
      }
      return {
        ok: false,
        error: {
          code: 'adapter_dispatch_failed',
          message: `codex exit ${exitCode ?? '?'}: ${stderr.slice(0, 1024) || '<no stderr>'}`,
        },
        metrics: { durationMs },
      };
    }

    // release202/05 C2 — on success, persist the codex thread id so the next
    // turn of this (conversation × agent) resumes it. The id appears as the
    // thread.started line; on a resume run the same id is re-emitted, so a
    // successful resume re-affirms the mapping (and refreshes created_at).
    const result: TaskResult = {
      ok: true,
      output: parseCodexOutput(stdout),
      metrics: { durationMs },
    };
    if (config.sessionContinuity) {
      const sessionId = parseCodexSessionId(stdout);
      if (sessionId) {
        result.metadata = { ...result.metadata, providerSessionId: sessionId };
        if (conversationId && agentImUserId) {
          getProviderSessionMapper()?.put(conversationId, agentImUserId, 'codex', sessionId, {
            taskId: typeof task.metadata?.taskId === 'string' ? task.metadata.taskId : undefined,
            workspaceId:
              typeof task.metadata?.workspaceId === 'string' ? task.metadata.workspaceId : undefined,
          });
        }
      }
    }
    return result;
  },

  async health(): Promise<HealthStatus> {
    // Probe `codex --version`. Soft failure: daemon starts fine even if
    // the binary isn't installed; the error surfaces only at first
    // dispatch (mirrors hermes/claude-code health pattern). Release 201
    // P1 also parses the version string and warns on drift from the
    // KNOWN_GOOD pin tracked in known-versions.ts.
    return new Promise((resolve) => {
      const proc = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('exit', (code) => {
        if (code !== 0) {
          resolve({
            available: false,
            reason: 'codex CLI not in PATH or returned non-zero for --version',
            hint: 'npm install -g @openai/codex',
          });
          return;
        }
        const detected = parseVersionFromStdout(stdout);
        if (!isVersionInRange(detected, CODEX_MIN_VERSION)) {
          process.stderr.write(
            `[codex-adapter] detected codex ${detected} below MIN ${CODEX_MIN_VERSION}; behavior is unverified\n`,
          );
        } else if (detected !== CODEX_KNOWN_GOOD && CODEX_KNOWN_GOOD !== 'unknown') {
          process.stderr.write(
            `[codex-adapter] detected codex ${detected}, known-good ${CODEX_KNOWN_GOOD}; minor drift OK if smoke passes\n`,
          );
        }
        resolve({ available: true });
      });
      proc.on('error', () =>
        resolve({
          available: false,
          reason: 'codex CLI not found',
          hint: 'npm install -g @openai/codex',
        }),
      );
    });
  },
};
