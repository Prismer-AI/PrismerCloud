/**
 * Release 200 T10 — Docker-host ephemeral executor.
 *
 * Spawns a one-shot `docker run --rm` container per request and captures
 * stdout / stderr / exitCode. Used by `POST /api/runs` as the v200 default
 * ephemeral path (no external dependencies — only requires a local docker
 * daemon, which is the same dev-stack prerequisite as kind).
 *
 * Out of scope for v200:
 *   - `inputs` / `outputs` file streaming (cp into / out of the container)
 *   - Streaming logs (`runStream`) — fold into `run()` for now
 *   - Resource limits (cpu/mem) — caller must trust the image
 *
 * Anything in `RunRequest` we don't support throws `ProviderError('invalid_config')`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProviderError } from '@/lib/execution/errors';
import type {
  EphemeralExecutor,
  ExecutionEnvironment,
  ProvisionEnvironmentInput,
  RunRequest,
  RunResult,
} from './types';

function makeRunId(): string {
  // 24-char alphanum — fits `varchar(30)` columns. `randomUUID()` is 36 chars
  // including dashes; stripping dashes and slicing to 24 keeps ~96 bits of
  // entropy which is plenty for in-flight run-id uniqueness.
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

export class DockerHostSandboxProvider implements EphemeralExecutor {
  readonly kind = 'docker-host' as const;
  readonly capabilities = {
    runtimeModel: 'ephemeral',
    supportsSnapshots: false,
    supportsDaemonDispatch: false,
    supportsAgentInstall: false,
    supportsLogs: true,
    supportsPortForwarding: false,
  } as const;

  async getEnvironment(_id: string): Promise<ExecutionEnvironment | null> {
    return null;
  }

  async removeEnvironment(_id: string): Promise<void> {
    return;
  }

  /** Legacy v190 — not implemented for ephemeral docker-host. Use `run()`. */
  async execute(
    _input: ProvisionEnvironmentInput,
    _command: { command: string[]; timeoutMs?: number },
  ): Promise<never> {
    throw new ProviderError(
      'invalid_config',
      'DockerHostSandboxProvider.execute() is unused in v200 — use run() via POST /api/runs',
      false,
    );
  }

  /**
   * Health check — `docker info` succeeds iff the local daemon is reachable.
   * Returns ok=false (NOT throws) on failure so the registry can keep this
   * executor registered without taking down the route.
   */
  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return new Promise<{ ok: boolean; latencyMs: number; error?: string }>((resolve) => {
      const start = Date.now();
      const child = spawn('docker', ['info'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      child.on('exit', (code) => {
        if (code === 0) {
          resolve({ ok: true, latencyMs: Date.now() - start });
        } else {
          resolve({
            ok: false,
            latencyMs: Date.now() - start,
            error: `docker info exit ${code}: ${stderr.slice(0, 200)}`,
          });
        }
      });
      child.on('error', (err) => {
        resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
      });
    });
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (!Array.isArray(request.command) || request.command.length === 0) {
      throw new ProviderError('invalid_config', 'run() requires non-empty command argv', false);
    }

    const runId = makeRunId();
    const start = Date.now();
    const image = request.image ?? 'alpine:latest';
    const timeoutMs = request.timeoutMs ?? 60_000;
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const containerName = `prismer-ephemeral-${runId}`;

    const envArgs = Object.entries(request.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const workdirArgs = request.workingDir ? ['-w', request.workingDir] : [];

    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      containerName,
      '--label',
      'prismer.runtime=ephemeral',
      '--label',
      `prismer.runId=${runId}`,
      '--stop-timeout',
      String(timeoutSec),
      ...envArgs,
      ...workdirArgs,
      image,
      ...request.command,
    ];

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
      });

      if (typeof request.stdin === 'string' && request.stdin.length > 0) {
        try {
          child.stdin.write(request.stdin);
        } catch {
          // best-effort — if the container exits before we can write, ignore
        }
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }

      const timer = setTimeout(() => {
        timedOut = true;
        // best-effort stop; docker handles SIGTERM → SIGKILL escalation
        const killer = spawn('docker', ['stop', '-t', '1', containerName], { stdio: 'ignore' });
        killer.on('error', () => {
          // ignore — best-effort
        });
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        // `docker` binary missing / not on PATH → treat as daemon_unreachable
        reject(new ProviderError('daemon_unreachable', `docker spawn failed: ${err.message}`, true, { containerName }));
      });

      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            runId,
            exitCode: exitCode ?? -1,
            stdout,
            stderr: stderr + `\n[docker-host] killed by timeout after ${timeoutMs}ms`,
            durationMs: Date.now() - start,
            providerRefs: { containerName, image, timedOut: true },
          });
          return;
        }
        resolve({
          runId,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          providerRefs: { containerName, image },
        });
      });
    });
  }
}
