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
} from '../contract.js';
import { categorizeDispatchError, withCancellation } from '../contract.js';
import { parseHeadlessOutput } from './output-parser.js';
import { applyPrismerScopeEnv, resolveSpawnScratchCwd } from '../prismer-env.js';
import { isVersionInRange, parseVersionFromStdout } from '../version-check.js';
import { ADAPTER_KNOWN_VERSIONS } from '../known-versions.js';

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
  // informational tag — dispatch does not branch on this value yet
  route: z.enum(['default', 'prismer', 'omniroute']).default('default'),
});

export type ClaudeCodeConfig = z.infer<typeof CCConfigSchema>;

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
    const args: string[] = ['--print'];
    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.allowedTools && config.allowedTools.length > 0) {
      args.push('--allowed-tools', config.allowedTools.join(','));
    }
    // v2.0 (A3) — daemon's dispatch.ts composes profile persona + operating
    // principles into `metadata.systemPrompt`. Prefer that; fall back to
    // `config.systemPrompt` when called outside the daemon (e.g. test
    // harnesses that invoke the adapter directly).
    const metadataSystemPrompt =
      typeof task.metadata?.systemPrompt === 'string' ? task.metadata.systemPrompt : undefined;
    const effectiveSystemPrompt = metadataSystemPrompt ?? config.systemPrompt;
    if (effectiveSystemPrompt) {
      args.push('--system-prompt', effectiveSystemPrompt);
    }
    args.push(task.prompt);

    const startedAt = Date.now();
    const env = { ...process.env, ...(config.envVars ?? {}) };
    if (config.baseURL) {
      env.ANTHROPIC_API_BASE = config.baseURL;
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
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
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

    const parsed = parseHeadlessOutput(stdout);
    return {
      ok: true,
      output: parsed.output,
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
