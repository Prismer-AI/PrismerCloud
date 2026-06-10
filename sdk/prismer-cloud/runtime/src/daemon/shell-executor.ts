import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskDispatchRequestPayload,
} from '../types/im-events.js';

export interface ShellExecutionConfig {
  enabled: boolean;
  defaultCwd: string;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  allowedWorkspaces?: string[];
  shell: 'bash' | 'zsh' | 'sh';
}

export interface ShellExecutorDeps {
  config: ShellExecutionConfig;
  workspaceId: string;
  onProgress: (payload: TaskDispatchProgressPayload) => void;
  signal?: AbortSignal;
}

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT = 60_000;
const HARD_MAX_TIMEOUT = 30 * 60_000;

export function resolveShellConfig(raw: unknown): ShellExecutionConfig {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const shellRaw = cfg.shell;
  const shell = shellRaw === 'zsh' || shellRaw === 'sh' ? shellRaw : 'bash';
  const maxTimeoutMs = clampNumber(cfg.max_timeout_ms ?? cfg.maxTimeoutMs, DEFAULT_TIMEOUT, 1_000, HARD_MAX_TIMEOUT);
  const maxOutputBytes = clampNumber(cfg.max_output_bytes ?? cfg.maxOutputBytes, DEFAULT_OUTPUT_LIMIT, 16 * 1024, 5 * 1024 * 1024);
  const allowedWorkspaces = Array.isArray(cfg.allowed_workspaces ?? cfg.allowedWorkspaces)
    ? ((cfg.allowed_workspaces ?? cfg.allowedWorkspaces) as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  return {
    enabled: cfg.enabled === true || process.env.PRISMER_SHELL_ENABLED === 'true',
    defaultCwd: typeof cfg.default_cwd === 'string' ? cfg.default_cwd : typeof cfg.defaultCwd === 'string' ? cfg.defaultCwd : process.cwd(),
    maxTimeoutMs,
    maxOutputBytes,
    allowedWorkspaces,
    shell,
  };
}

export function isShellDispatch(payload: TaskDispatchRequestPayload): boolean {
  const execution = readExecutionMetadata(payload);
  return payload.runtimeRoute === 'shell' || execution.kind === 'shell';
}

export async function executeShellDispatch(
  payload: TaskDispatchRequestPayload,
  deps: ShellExecutorDeps,
): Promise<TaskDispatchReplyPayload> {
  const startedAt = Date.now();
  if (!deps.config.enabled) {
    return fail(payload.taskId, 'shell_disabled', 'Shell execution is disabled on this daemon');
  }
  if (deps.config.allowedWorkspaces?.length && !deps.config.allowedWorkspaces.includes(deps.workspaceId)) {
    return fail(payload.taskId, 'shell_workspace_not_allowed', `Workspace ${deps.workspaceId || '(unknown)'} is not allowed to run shell commands`);
  }

  const execution = readExecutionMetadata(payload);
  const command = readCommand(payload, execution);
  if (!command.trim()) return fail(payload.taskId, 'shell_command_required', 'Shell command is required');

  const cwd = resolveCwd(execution.cwd, deps.config.defaultCwd);
  if (!existsSync(cwd)) return fail(payload.taskId, 'shell_cwd_missing', `cwd does not exist: ${cwd}`);

  const timeoutMs = Math.min(
    typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0 ? payload.timeoutMs : deps.config.maxTimeoutMs,
    deps.config.maxTimeoutMs,
  );
  const shell = execution.shell === 'zsh' || execution.shell === 'sh' || execution.shell === 'bash' ? execution.shell : deps.config.shell;

  return new Promise((resolveReply) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let seq = 0;
    let settled = false;
    let timedOut = false;

    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: { ...process.env, ...(execution.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2_000).unref();
    }, timeoutMs);
    killTimer.unref();

    const abort = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2_000).unref();
    };
    deps.signal?.addEventListener('abort', abort, { once: true });

    const append = (stream: 'stdout' | 'stderr', buf: Buffer) => {
      const text = buf.toString('utf8');
      const nextBytes = outputBytes + Buffer.byteLength(text);
      const remaining = Math.max(0, deps.config.maxOutputBytes - outputBytes);
      const accepted = remaining > 0 ? text.slice(0, remaining) : '';
      outputBytes = Math.min(nextBytes, deps.config.maxOutputBytes);
      if (stream === 'stdout') stdout += accepted;
      else stderr += accepted;
      deps.onProgress({
        taskId: payload.taskId,
        progress: 0.5,
        message: stream,
        detail: {
          stream,
          chunk: accepted,
          sequence: seq++,
          truncated: nextBytes > deps.config.maxOutputBytes,
        },
      });
    };

    child.stdout?.on('data', (d: Buffer) => append('stdout', d));
    child.stderr?.on('data', (d: Buffer) => append('stderr', d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      deps.signal?.removeEventListener('abort', abort);
      resolveReply(fail(payload.taskId, 'shell_spawn_failed', err.message));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      deps.signal?.removeEventListener('abort', abort);
      const durationMs = Date.now() - startedAt;
      if (deps.signal?.aborted) {
        resolveReply(fail(payload.taskId, 'task_cancelled', 'Shell command cancelled', durationMs));
        return;
      }
      if (timedOut) {
        resolveReply(fail(payload.taskId, 'shell_timeout', `Shell command timed out after ${timeoutMs}ms`, durationMs));
        return;
      }
      const exitCode = code ?? (signal ? 128 : 1);
      const output = formatOutput({ command, cwd, shell, exitCode, stdout, stderr, truncated: outputBytes >= deps.config.maxOutputBytes });
      if (exitCode === 0) {
        resolveReply({ taskId: payload.taskId, ok: true, output, metrics: { durationMs } });
      } else {
        resolveReply({
          taskId: payload.taskId,
          ok: false,
          output,
          error: { code: 'shell_exit_nonzero', message: `Shell exited with code ${exitCode}` },
          metrics: { durationMs },
        });
      }
    });
  });
}

function readExecutionMetadata(payload: TaskDispatchRequestPayload): Record<string, any> {
  const execution = payload.metadata?.execution;
  return execution && typeof execution === 'object' && !Array.isArray(execution) ? (execution as Record<string, any>) : {};
}

function readCommand(payload: TaskDispatchRequestPayload, execution: Record<string, any>): string {
  if (typeof execution.command === 'string') return execution.command;
  if (Array.isArray(execution.command)) return execution.command.map(String).join(' ');
  return payload.prompt;
}

function resolveCwd(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return resolve(fallback);
  return resolve(raw);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function fail(taskId: string, code: string, message: string, durationMs?: number): TaskDispatchReplyPayload {
  return { taskId, ok: false, error: { code, message }, metrics: durationMs ? { durationMs } : undefined };
}

function formatOutput(input: {
  command: string;
  cwd: string;
  shell: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}): string {
  return [
    `$ ${input.command}`,
    `cwd: ${input.cwd}`,
    `shell: ${input.shell}`,
    `exitCode: ${input.exitCode}`,
    input.truncated ? 'output: truncated' : null,
    input.stdout ? `\n[stdout]\n${input.stdout}` : null,
    input.stderr ? `\n[stderr]\n${input.stderr}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
