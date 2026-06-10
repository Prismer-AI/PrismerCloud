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
} from '../contract.js';
import { categorizeDispatchError, withCancellation } from '../contract.js';
import { isVersionInRange, parseVersionFromStdout } from '../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../known-versions.js';

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
import { MEMORY_CURATION_SKILL_TEXT } from '../../skills/memory-curation.js';
import { applyPrismerScopeEnv, resolveSpawnScratchCwd } from '../prismer-env.js';
import { getProviderSessionMapper } from '../../daemon/provider-session-mapper.js';

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
  baseUrl: string; // e.g. https://cloud.prismer.dev/api/v1
  apiKey: string; // sk-prismer-*
}

/** Resolve the cloud gateway base + key from env, mirroring the hermes adapter. */
export function resolveCodexPrismerProvider(config: CodexConfig): PrismerProvider | null {
  if (!config.proxyProvider) return null;
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
  const provider = config.proxyProvider;
  const apiPath = !provider || provider === 'newapi' || provider === 'default'
    ? '/api/v1'
    : `/api/v1/proxy/${encodeURIComponent(provider)}`;
  return { baseUrl: `${base}${apiPath}`, apiKey };
}

/**
 * Write a `CODEX_HOME/config.toml` that routes Codex through our gateway.
 * Returns the CODEX_HOME dir to export. `model` is the curated model id.
 *
 * Notes (all empirically verified, release202/03 §1.3a / §3.1):
 *  - `wire_api = "responses"` — Codex >= v0.133 is responses-only.
 *  - `model_reasoning_effort = "none"` — our bridge drops `reasoning` anyway,
 *    but this stops Codex emitting it for models it assumes are reasoning-capable.
 *  - bearer via `experimental_bearer_token` (no auth.json needed).
 */
export function writeCodexPrismerHome(
  homeDir: string,
  model: string,
  provider: PrismerProvider,
): string {
  mkdirSync(homeDir, { recursive: true });
  const toml =
    `model = ${JSON.stringify(model)}\n` +
    `model_provider = "prismer"\n` +
    `model_reasoning_effort = "none"\n` +
    `\n[model_providers.prismer]\n` +
    `name = "Prismer Cloud Gateway"\n` +
    `base_url = ${JSON.stringify(provider.baseUrl)}\n` +
    `wire_api = "responses"\n` +
    `experimental_bearer_token = ${JSON.stringify(provider.apiKey)}\n`;
  writeFileSync(join(homeDir, 'config.toml'), toml, { mode: 0o600 });
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
 *   1. Built-in skills (currently just memory-curation per doc 27 §3)
 *   2. Dispatch-supplied systemPrompt (preferred — composed by daemon's
 *      `dispatch.ts` to include profile persona + operating principles),
 *      falling back to `config.systemPrompt` when invoked without a daemon
 *      (e.g. unit tests that call buildCodexPrompt directly).
 *   3. The actual task prompt
 *
 * Pure function — no I/O, no `process` access, no spawn. Extracted for
 * unit testing of the skill-injection wiring without spawning the codex CLI.
 */
export function buildCodexPrompt(
  config: CodexConfig,
  taskPrompt: string,
  metadataSystemPrompt?: string,
): string {
  // Trim each preamble part — the canonical skill .md ends with a trailing
  // newline, which would otherwise compound with the `\n\n` separator into
  // a `\n\n\n` block before the task prompt.
  const preambleParts: string[] = [MEMORY_CURATION_SKILL_TEXT.trim()];
  const effectiveSystemPrompt = metadataSystemPrompt ?? config.systemPrompt;
  if (effectiveSystemPrompt && effectiveSystemPrompt.trim()) {
    preambleParts.push(effectiveSystemPrompt.trim());
  }
  return `${preambleParts.join('\n\n')}\n\n${taskPrompt}`;
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

/**
 * Build the `codex` argv for a dispatch. Pure (testable) — three shapes:
 *   1. resume:    `exec resume --json --skip-git-repo-check <id> -- <prompt>`
 *                 (codex 0.133.0: --sandbox/--cd are rejected on `resume`;
 *                  sandbox/cwd are inherited from the persisted session.)
 *   2. persisted: `exec --model … --cd … --sandbox … --skip-git-repo-check
 *                  --json -- <prompt>` (no --ephemeral → session kept for resume).
 *   3. ephemeral: same as (2) plus --ephemeral (continuity disabled).
 *
 * The `--` end-of-options separator before the prompt is REQUIRED: the composed
 * prompt begins with the memory-curation skill's YAML frontmatter (`---\nname:…`)
 * and without `--` codex's clap parser treats a positional starting with `--` as
 * an unknown flag → `error: unexpected argument '---…'` (exit 2). Verified
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
    return ['exec', 'resume', '--json', '--skip-git-repo-check', resumeId, '--', prompt];
  }
  const args = ['exec', '--model', model, '--cd', spawnCwd, '--sandbox', sandbox, '--skip-git-repo-check'];
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
    const env: NodeJS.ProcessEnv = { ...process.env, ...(config.envVars ?? {}) };
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
      const codexHome = writeCodexPrismerHome(
        join(codexHomeBase, '.codex-home'),
        config.model,
        prismerProvider,
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
      if (!task.onProgress) return;
      lineBuf += text;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        const ev = codexJsonlToProgress(line);
        if (ev) {
          progress = Math.min(95, progress + 5);
          task.onProgress({ progress, message: ev.message, detail: ev.detail });
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
