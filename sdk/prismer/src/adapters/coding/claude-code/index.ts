// D21: CLI fallback — DELETE this path once the engine-backed adapter is stable in prod.
//
// Claude Code adapter — interactive print-mode invocation per task.
//
// Spawns `claude --print --model <m> [--system-prompt <s>] <prompt>` per
// dispatch. Cancellation = SIGTERM. See docs/refactor/05-adapter-contract.md
// §Claude Code adapter.
//
// Wave-4 (2026-05): updated for claude CLI 2.x — `--headless` was renamed to
// `--print`, `--cwd` was removed (use child_process.spawn cwd option), and
// `--max-turns` is no longer recognised in non-interactive mode. The prompt
// is now positional. Older 1.x flags would fail with `unknown option`.

import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import type {
  AdapterDef,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from '../../contract.js';
import { categorizeDispatchError, withCancellation } from '../../contract.js';
import { parseHeadlessOutput } from './output-parser.js';
import { applyPrismerScopeEnv, resolveSpawnScratchCwd } from '../../prismer-env.js';
import { createExternalProcessEnv } from '../shared/shims/paseo-env.js';
import { isVersionInRange, parseVersionFromStdout } from '../../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../../known-versions.js';
import {
  resolveLocalProvider,
  claudeCodeSupportsLocalType,
} from '../../shared/local-provider.js';

/**
 * Tested-good claude CLI binary version range (Release 201 v2.0.7 P1).
 *
 * Wave-4 (2026-05) required claude CLI 2.x for the renamed flag set
 * (`--print` instead of `--headless`, `--cwd` removed, `--max-turns`
 * dropped from non-interactive mode). MIN reflects that 2.0.0 floor;
 * `health()` warns when the detected version drifts below it or away
 * from KNOWN_GOOD. Update both pins (and `known-versions.ts`) when a
 * new upstream rev is exercised by the cookbook + CI smoke pass.
 */
const CLAUDE_CODE_MIN_VERSION = ADAPTER_KNOWN_VERSIONS['claude-code']!.minVersion;
const CLAUDE_CODE_KNOWN_GOOD = ADAPTER_KNOWN_VERSIONS['claude-code']!.knownGood;

const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const CCConfigSchema = z.object({
  cwd: z.string().min(1),
  // claude 2.x accepts aliases ('sonnet', 'haiku', 'opus') and full ids
  // (e.g. 'claude-sonnet-4-6'). The 1.x default 'claude-3-5-sonnet' is no
  // longer a valid model id under the current CLI.
  model: z.string().default('sonnet'),
  systemPrompt: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  mcpServers: z.array(McpServerSchema).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().default(20),
  // External-model route (1.9.x extension — optional, no breaking change)
  baseURL: z.string().url().optional(),
  apiKeyRef: z.string().regex(/^(env|keychain):[A-Za-z0-9_][A-Za-z0-9_.\-]*$/).optional(),
  // release203/06 §3.1a — dispatch DOES branch on this now: 'prismer' (or a
  // set `proxyProvider`) routes CC through our cloud gateway. 'omniroute' stays
  // informational (no behavior yet).
  route: z.enum(['default', 'prismer', 'omniroute']).default('default'),

  /**
   * release203/06 §3.1a — route Claude Code through our cloud gateway instead
   * of the official Anthropic endpoint. When set (or `route:'prismer'`), the
   * adapter injects `ANTHROPIC_BASE_URL=<PRISMER_BASE_URL>/api/v1[/proxy/<chain>]`
   * + `ANTHROPIC_AUTH_TOKEN=sk-prismer-*` so CC's Anthropic wire (`/api/v1/messages`)
   * hits the gateway and walks the selected provider chain (release202/07).
   * Unlike codex/openclaw, CC needs NO local config file write and NO responses
   * bridge — it speaks the Anthropic wire natively. Undefined + route!='prismer'
   * = official Anthropic endpoint (backwards-compatible; old daemons that don't
   * read this field just don't branch).
   *   newapi/default → /api/v1
   *   other chain    → /api/v1/proxy/<chain>
   */
  proxyProvider: z.string().min(1).optional(),

  /** Env var holding the sk-prismer-* key (default PRISMER_API_KEY). */
  prismerApiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default('PRISMER_API_KEY'),

  /**
   * product205/03 §3.4 (M6) — runtime action-governance mode. `auto` (default):
   * `--dangerously-skip-permissions` on (pod is the isolation boundary, zero
   * regression for personal workspaces). `gated`: bypass flag OFF → the SDK's
   * `canUseTool: handlePermissionRequest` callback fires per tool; destructive
   * tools (Ring 1) park via the daemon async-park path (deny + §3.5 bundle →
   * awaiting_human_approval → cloud `runtime_action` approval → redispatch with
   * comment). Decoupled from forceAutonomous (§1.1): prompt stays autonomous.
   */
  runtimeApprovalMode: z.enum(['auto', 'gated']).optional().default('auto'),
});

export type ClaudeCodeConfig = z.infer<typeof CCConfigSchema>;

// ---------------------------------------------------------------------------
// release203/06 §3.0 / P0 — `--output-format stream-json` line parser
// ---------------------------------------------------------------------------

/**
 * release203/06 §3.0 — one normalized step recorder action derived from a
 * single `claude --print --output-format stream-json --verbose` NDJSON line.
 * Pure (no recorder dependency) so it is unit-testable; the dispatch loop
 * applies the returned action(s) against `task.recorder` and accumulates the
 * final reply.
 *
 * stream-json event shape (claude CLI 2.1.x, verified 2026-06-17):
 *   {"type":"system","subtype":"init",...}                                  ← start
 *   {"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"}]}}  ← reasoning
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…","name":"Bash","input":{…}}]}}  ← tool call
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}  ← assistant text (reply)
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"…","is_error":false}]}}  ← tool result
 *   {"type":"result","subtype":"success","result":"…",…}                    ← final
 *
 * A single assistant message may carry MULTIPLE content blocks, so this
 * returns an array (possibly empty). Reply text blocks surface as `reply`
 * actions; the dispatch loop concatenates them (or prefers the `result` line's
 * `result` field when present).
 */
export type CCStepAction =
  | { kind: 'tool_call'; toolName: string; input: unknown; toolCallId: string }
  | { kind: 'tool_result'; toolCallId: string; output: unknown }
  | { kind: 'reasoning_chunk'; text: string }
  | { kind: 'reply'; text: string }
  | { kind: 'result'; text: string };

export function claudeStreamJsonToSteps(line: string): CCStepAction[] {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return [];
  let obj: {
    type?: string;
    subtype?: string;
    result?: string;
    message?: {
      content?: Array<{
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>;
    };
  };
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }

  // Final result line carries the authoritative reply text.
  if (obj.type === 'result') {
    const text = typeof obj.result === 'string' ? obj.result : '';
    return text ? [{ kind: 'result', text }] : [];
  }

  // Assistant / user envelopes carry an array of content blocks.
  if ((obj.type === 'assistant' || obj.type === 'user') && Array.isArray(obj.message?.content)) {
    const out: CCStepAction[] = [];
    for (const block of obj.message!.content!) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'thinking': {
          const text = typeof block.thinking === 'string' ? block.thinking : '';
          if (text) out.push({ kind: 'reasoning_chunk', text });
          break;
        }
        case 'tool_use': {
          const toolName = typeof block.name === 'string' ? block.name : 'tool';
          const toolCallId = typeof block.id === 'string' ? block.id : toolName;
          out.push({ kind: 'tool_call', toolName, input: block.input ?? {}, toolCallId });
          break;
        }
        case 'tool_result': {
          const toolCallId =
            typeof block.tool_use_id === 'string' ? block.tool_use_id : 'tool';
          out.push({
            kind: 'tool_result',
            toolCallId,
            output: { content: block.content, isError: block.is_error === true },
          });
          break;
        }
        case 'text': {
          const text = typeof block.text === 'string' ? block.text : '';
          if (text) out.push({ kind: 'reply', text });
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  return [];
}

// ---------------------------------------------------------------------------
// release203/06 §3.1a — Prismer gateway routing (CC provider override)
// ---------------------------------------------------------------------------

export interface CCPrismerProvider {
  baseUrl: string; // ANTHROPIC_BASE_URL root, e.g. https://test.docbrew.cn/api
  apiKey: string; // sk-prismer-* (cloud) | sk-ant-* (local BYOK)
  /**
   * desktop202/12 §2 — WHICH env var the key must be injected as. The two paths
   * authenticate differently and the wrong header is a hard 401:
   *   - 'auth-token' (default, cloud gateway) → ANTHROPIC_AUTH_TOKEN, i.e.
   *     `Authorization: Bearer sk-prismer-*` (what our gateway validates).
   *   - 'api-key' (daemon-local BYOK anthropic profile) → ANTHROPIC_API_KEY, i.e.
   *     `x-api-key: sk-ant-*` (what api.anthropic.com validates; a real Anthropic
   *     API key sent as a Bearer token is rejected).
   */
  authMode: 'auth-token' | 'api-key';
  /** True when this came from a daemon-local `[[providers]]` profile (BYOK direct-connect). */
  local?: boolean;
}

/**
 * Resolve the cloud-gateway base + key from env, mirroring the codex adapter's
 * `resolveCodexPrismerProvider` (but for CC's Anthropic wire — no responses
 * bridge / local-provider responses-only quirk). Returns null when routing is
 * NOT requested (route!='prismer' && no proxyProvider) or when the required env
 * is missing (degrade to the official Anthropic endpoint).
 *
 * IMPORTANT (release203/06 §7, in-pod verified 2026-06-17): the Anthropic CLI
 * client appends `/v1/messages` to ANTHROPIC_BASE_URL. Our gateway endpoint is
 * `<base>/api/v1/messages`, so ANTHROPIC_BASE_URL must be `<base>/api` (NOT
 * `<base>/api/v1` — that produced `/api/v1/v1/messages` → 404). The gateway's
 * `/api/v1/messages` route already translates Anthropic wire → chat for curated
 * models (us-kimi-k2.6 → HTTP 200 verified), so model selection is via `--model`,
 * not a per-chain URL path (there is no Anthropic-wire proxy-chain route).
 */
export function resolveClaudeCodePrismerProvider(
  config: ClaudeCodeConfig,
): CCPrismerProvider | null {
  const wantsRoute = config.route === 'prismer' || !!config.proxyProvider;
  if (!wantsRoute) return null;
  // desktop202/12 §2 (doc 21 §2.5) — daemon-local provider profile (BYOK) is the
  // MIDDLE resolution layer, exactly as in the codex adapter. When `proxyProvider`
  // names a configured `[[providers]]` id with a resolvable key, CC direct-connects
  // to the profile's base_url instead of the cloud gateway. No profiles configured
  // (CLI / K8s / web) → null → the cloud-chain path below, byte-for-byte unchanged.
  const local = resolveLocalProvider(config.proxyProvider);
  if (local) {
    if (!claudeCodeSupportsLocalType(local.type)) {
      // Anthropic-wire only (claudeCodeSupportsLocalType). An OpenAI-wire endpoint
      // (ollama / openai / deepseek / openai-compatible) would receive an Anthropic
      // body at `<base>/v1/messages` and fail at runtime — so DECLINE rather than
      // mis-wire, and fall through to the cloud chain (which does the translation).
      process.stderr.write(
        `[claude-code] local provider '${local.profileId}' (type=${local.type}) is not claude-code-compatible ` +
          `(claude-code speaks the Anthropic Messages wire only); falling back to the cloud chain. ` +
          `Use the hermes adapter for this provider, or an 'anthropic' profile for claude-code.\n`,
      );
    } else {
      // Anthropic serves the Messages API at its base_url verbatim (the client
      // appends `/v1/messages`), and authenticates a BYOK key via x-api-key —
      // hence authMode='api-key' (NOT the gateway's Bearer).
      return {
        baseUrl: local.baseUrl,
        apiKey: local.apiKey ?? '',
        authMode: 'api-key',
        local: true,
      };
    }
  }
  const base = process.env.PRISMER_BASE_URL?.replace(/\/+$/, '');
  const apiKey = process.env[config.prismerApiKeyEnv] || process.env.PRISMER_API_KEY || '';
  if (!base || !apiKey) {
    process.stderr.write(
      `[claude-code] route=prismer/proxyProvider set but missing PRISMER_BASE_URL or ${config.prismerApiKeyEnv}; falling back to official Anthropic endpoint\n`,
    );
    return null;
  }
  // CC speaks Anthropic wire: client adds `/v1/messages`, so base ends at `/api`.
  // proxyProvider/chain routing for CC happens via the model field at newapi, not
  // a URL path (no `/api/v1/proxy/<chain>/v1/messages` route exists).
  return { baseUrl: `${base}/api`, apiKey, authMode: 'auth-token' };
}

/**
 * product209/19 WP3 — exported pure composer for the effective
 * `--system-prompt` (identity lines + persona). Extracted from the dispatch
 * args build below so prompt fixtures can assert that the daemon-composed
 * directive text (memory + PKF report, shipped on `metadata.systemPrompt`)
 * survives the claude-code assembly VERBATIM.
 *
 * v2.0 (A3) — daemon's dispatch.ts composes profile persona + operating
 * principles into `metadata.systemPrompt`. Prefer that; fall back to
 * `config.systemPrompt` when called outside the daemon (e.g. test harnesses
 * that invoke the adapter directly).
 */
export function composeClaudeCodeSystemPrompt(
  task: TaskInput,
  fallbackSystemPrompt: string | undefined,
): string | undefined {
  const metadataSystemPrompt =
    typeof task.metadata?.systemPrompt === 'string' ? task.metadata.systemPrompt : undefined;
  const personaPrompt = metadataSystemPrompt ?? fallbackSystemPrompt;
  // release203/11 §2.2 (Slice A) — prepend the canonical IDENTITY/USER/scope
  // lines (shipped separately on metadata.identityContext so SOUL.md stays
  // persona-only) ahead of the persona portion. Without this the legacy CLI
  // fallback would lose the agent's name now that systemPrompt is persona-only.
  const idCtx = task.metadata?.identityContext as
    | { identity?: unknown; user?: unknown; scope?: unknown; sections?: unknown }
    | undefined;
  const identityLines = idCtx
    ? [idCtx.identity, idCtx.user, idCtx.scope].filter(
        (line): line is string => typeof line === 'string' && line.trim().length > 0,
      )
    : [];
  // product204/07 Phase C — named identityContext sections (分段注册制),
  // pre-rendered by dispatch.ts to ordered content strings; joined AFTER the
  // identity triple into the same --system-prompt slot.
  const identitySections = Array.isArray(idCtx?.sections)
    ? idCtx.sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const effectiveSystemPrompt = [...identityLines, ...identitySections, ...(personaPrompt ? [personaPrompt] : [])]
    .join('\n\n');
  return effectiveSystemPrompt.length > 0 ? effectiveSystemPrompt : undefined;
}

export const claudeCodeAdapter: AdapterDef = {
  name: 'claude-code',
  kind: 'interactive',
  capabilities: ['shell', 'code', 'mcp', 'edit'],
  workspaceSchema: CCConfigSchema,

  validate(config: unknown): ValidationResult {
    const r = CCConfigSchema.safeParse(config);
    if (r.success) return { ok: true };
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  },

  async dispatch(profile, task: TaskInput): Promise<TaskResult> {
    const config = CCConfigSchema.parse(profile.config);

    // claude 2.x: --print = non-interactive, prompt is positional, cwd
    // controlled via spawn(); --max-turns / --cwd flags removed.
    //
    // release203/06 §3.0 / P0 — request streaming NDJSON so we can emit a real
    // timeline into task.recorder (tool_call / tool_result / reasoning_chunk)
    // instead of only parsing the final text. stream-json REQUIRES --verbose in
    // print mode (claude CLI 2.1.x). The non-stream `--print` text path is kept
    // as the fallback parser (parseHeadlessOutput) when no `result` line is
    // produced (older CLI / stream-json unavailable).
    const args: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];
    // product205/03 §3.4 (M6) — `--dangerously-skip-permissions` is now
    // conditional on `runtimeApprovalMode`. `auto` (personal workspace default):
    // bypass on — pod is the isolation boundary, zero regression. `gated` (team
    // workspace default): bypass OFF → `canUseTool: handlePermissionRequest`
    // fires per tool; destructive tools (Ring 1) route to the daemon async-park
    // path (§3.6) instead of hanging the non-interactive pod 300s. Decoupled
    // from forceAutonomous (§1.1) — only the runtime floor toggles.
    if (config.runtimeApprovalMode !== 'gated') {
      args.push('--dangerously-skip-permissions');
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.allowedTools && config.allowedTools.length > 0) {
      args.push('--allowed-tools', config.allowedTools.join(','));
    }
    const effectiveSystemPrompt = composeClaudeCodeSystemPrompt(task, config.systemPrompt);
    if (effectiveSystemPrompt) {
      args.push('--system-prompt', effectiveSystemPrompt);
    }
    args.push(task.prompt);

    const startedAt = Date.now();
    // apc/17 §8.1 W2.1′ — route the inherited slice through the SAME allowlist
    // chokepoint the CodeAgentDriver path uses. Before this, `claude-code-cli`
    // (the D21 fallback adapter, runner.ts) spawned `claude` with a verbatim
    // `{...process.env}`, so the daemon's whole credential set was one `env |
    // grep` away — the driver path being filtered was not enough while this
    // one existed. `config.envVars` stays an OVERLAY (merged after the filter),
    // so operator-set values are never stripped.
    const env: NodeJS.ProcessEnv = createExternalProcessEnv(process.env, config.envVars ?? {});
    if (config.baseURL) {
      // release203/06 §3.1a — G4 fix: the claude CLI reads ANTHROPIC_BASE_URL,
      // NOT ANTHROPIC_API_BASE (that's the legacy Python SDK var the CLI
      // ignores). Set the correct one; keep the old name too for any tooling
      // that still consults it (harmless compat).
      env.ANTHROPIC_BASE_URL = config.baseURL;
      env.ANTHROPIC_API_BASE = config.baseURL;
    }
    // release203/06 §3.1a — route CC through our cloud gateway (Anthropic wire,
    // /api/v1/messages) when route:'prismer' or proxyProvider is set. CC 2.x
    // uses ANTHROPIC_AUTH_TOKEN for the Bearer (distinct from ANTHROPIC_API_KEY).
    // Unlike codex/openclaw there's NO local config file to write and NO
    // responses bridge — pure env injection. Takes precedence over config.baseURL.
    const prismerProvider = resolveClaudeCodePrismerProvider(config);
    if (prismerProvider) {
      env.ANTHROPIC_BASE_URL = prismerProvider.baseUrl;
      env.ANTHROPIC_API_BASE = prismerProvider.baseUrl;
      if (prismerProvider.authMode === 'api-key') {
        // desktop202/12 — daemon-local BYOK anthropic profile: the key is a real
        // sk-ant-* which api.anthropic.com validates via x-api-key (ANTHROPIC_API_KEY).
        // Drop any inherited AUTH_TOKEN so a stale gateway Bearer isn't sent alongside.
        env.ANTHROPIC_API_KEY = prismerProvider.apiKey;
        delete env.ANTHROPIC_AUTH_TOKEN;
      } else {
        env.ANTHROPIC_AUTH_TOKEN = prismerProvider.apiKey;
      }
    }
    // Wave-9 / release202/04 — Per-task artifacts dir: dispatch.ts provisions
    // a directory and surfaces it to spawn-style adapters via task.metadata.
    // Injected as PRISMER_ARTIFACTS_DIR (the only agent-facing name;
    // PRISMER_OUTBOX_DIR is dead) so any tool the adapter exposes (Bash, Write)
    // can resolve the path even if the LLM doesn't reread the prompt instruction.
    // release201/09 §9.9 — also mirrors PRISMER_WORKSPACE_ID /
    // PRISMER_ACTIVE_PROJECT_ID / PRISMER_AGENT_ID / PRISMER_TASK_ID /
    // PRISMER_DAEMON_ID + PRISMER_SCRATCH_DIR (+ legacy PRISMER_WORKDIR) via
    // the shared helper.
    applyPrismerScopeEnv(env as Record<string, string | undefined>, task.metadata as Record<string, unknown> | undefined);
    if (config.apiKeyRef) {
      // Resolve reference to a literal value at dispatch time. Plaintext key never
      // touches AgentProfile.config or cloud storage.
      const resolved = resolveKeyRef(config.apiKeyRef);
      if (resolved) {
        env.ANTHROPIC_API_KEY = resolved;
      } else {
        const platformHint =
          config.apiKeyRef.startsWith('keychain:') && process.platform !== 'darwin'
            ? ' (keychain: scheme requires darwin)'
            : '';
        process.stderr.write(
          `[claude-code] warning: apiKeyRef "${config.apiKeyRef}" could not be resolved${platformHint}; ANTHROPIC_API_KEY will not be injected\n`,
        );
      }
    }
    // release202/04 §3.2 — spawn-style adapter: a FRESH child runs per
    // dispatch, so we point its cwd at this dispatch's per-task scratch dir
    // (task.metadata.prismerScratchDir, legacy fallback prismerWorkDir). Any
    // relative-path write the LLM emits then lands in the task sandbox instead
    // of /tmp or the daemon cwd. Falls back to config.cwd when dispatch didn't
    // provision a scratch dir (e.g. adapter invoked outside the daemon, or
    // workspace/paths unresolved). TERMINAL_CWD is set to match so any tool
    // that honors it over process.cwd() resolves to the same sandbox.
    const spawnCwd = resolveSpawnScratchCwd(task.metadata as Record<string, unknown> | undefined) ?? config.cwd;
    if (env.TERMINAL_CWD == null) {
      env.TERMINAL_CWD = spawnCwd;
    }
    // stdio[0]='ignore' explicitly closes child stdin. claude ≥ 2.1.128
    // exits with the warning "no stdin data received in 3s, proceeding
    // without it. ... < /dev/null to skip" when stdin is left open in
    // non-interactive mode — Wave-7 ζ daemon e2e regression. The prompt
    // is already passed positionally (args.push(task.prompt) above), so
    // no stdin is ever needed.
    const child = spawn('claude', args, {
      cwd: spawnCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    // release203/06 §3.0 / P0 — incremental stream-json parsing. We still
    // accumulate the full stdout for the fallback parser; on top of that we
    // split off complete NDJSON lines as they arrive and feed task.recorder
    // (tool_call / tool_result / reasoning_chunk). `lineBuf` holds the partial
    // trailing line between chunks. `replyParts` accumulates assistant text
    // blocks; `resultText` is the authoritative final reply from the `result`
    // line (preferred over replyParts when present).
    let lineBuf = '';
    const replyParts: string[] = [];
    let resultText: string | null = null;
    let sawStreamJson = false;
    // Gateway-proxied non-native-Claude upstreams re-stream the same tool_use
    // block across multiple partial assistant envelopes, re-sending an identical
    // toolCallId. The stream-json contract says one complete block per event, but
    // real runs violate it — dedupe by toolCallId so we record each call once.
    const seenToolCalls = new Set<string>();
    const consumeLine = (line: string): void => {
      const steps = claudeStreamJsonToSteps(line);
      if (steps.length > 0) sawStreamJson = true;
      for (const step of steps) {
        switch (step.kind) {
          case 'tool_call':
            if (step.toolCallId) {
              if (seenToolCalls.has(step.toolCallId)) break;
              seenToolCalls.add(step.toolCallId);
            }
            task.recorder?.recordToolCall(step.toolName, step.input, step.toolCallId);
            break;
          case 'tool_result':
            task.recorder?.recordToolResult(step.toolCallId, step.output);
            break;
          case 'reasoning_chunk':
            task.recorder?.recordReasoningChunk(step.text);
            break;
          case 'reply':
            replyParts.push(step.text);
            break;
          case 'result':
            resultText = step.text;
            break;
        }
      }
    };
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      lineBuf += text;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        consumeLine(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
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
      return categorizeDispatchError(null, task.signal);
    }

    if (exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: exitCode === null ? 'adapter_dispatch_failed' : 'adapter_dispatch_failed',
          message: `claude exit ${exitCode}: ${stderr.slice(0, 1024) || '<no stderr>'}`,
        },
        metrics: { durationMs },
      };
    }

    // Drain any trailing partial line.
    if (lineBuf.trim()) consumeLine(lineBuf);

    // release203/06 §3.0 / P0 — prefer the stream-json reply (result line, else
    // concatenated assistant text blocks). Fall back to the legacy text-mode
    // parser when no stream-json frames were seen (older CLI / stream-json
    // unavailable) so behavior degrades gracefully instead of returning empty.
    let output: string;
    if (sawStreamJson) {
      output = (resultText ?? replyParts.join('')).trim();
    } else {
      output = parseHeadlessOutput(stdout).output;
    }
    return {
      ok: true,
      output,
      metrics: { durationMs },
    };
  },

  async health(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      const proc = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('exit', (code) => {
        if (code !== 0) {
          resolve({
            available: false,
            reason: 'claude CLI not in PATH',
            hint: 'npm install -g @anthropic-ai/claude-code',
          });
          return;
        }
        const detected = parseVersionFromStdout(stdout);
        if (!isVersionInRange(detected, CLAUDE_CODE_MIN_VERSION)) {
          process.stderr.write(
            `[claude-code-adapter] detected claude ${detected} below MIN ${CLAUDE_CODE_MIN_VERSION}; behavior is unverified (Wave-4 flag set requires 2.x)\n`,
          );
        } else if (detected !== CLAUDE_CODE_KNOWN_GOOD && CLAUDE_CODE_KNOWN_GOOD !== 'unknown') {
          process.stderr.write(
            `[claude-code-adapter] detected claude ${detected}, known-good ${CLAUDE_CODE_KNOWN_GOOD}; minor drift OK if smoke passes\n`,
          );
        }
        resolve({ available: true });
      });
      proc.on('error', () =>
        resolve({
          available: false,
          reason: 'claude CLI not found',
          hint: 'npm install -g @anthropic-ai/claude-code',
        }),
      );
    });
  },
};

function resolveKeyRef(ref: string): string | undefined {
  const idx = ref.indexOf(':');
  if (idx < 0) return undefined;
  const scheme = ref.slice(0, idx);
  const name = ref.slice(idx + 1);
  if (scheme === 'env') return process.env[name];
  if (scheme === 'keychain') {
    if (process.platform !== 'darwin') return undefined;
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', name, '-w'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (r.status === 0) return (r.stdout as string).trim();
    } catch {
      /* fall through */
    }
    return undefined;
  }
  return undefined;
}
