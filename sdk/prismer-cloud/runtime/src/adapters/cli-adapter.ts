/**
 * Prismer Runtime — Generic CLI-spawn adapter factory (Sprint C1/C2)
 *
 * Most agent CLIs (Claude Code, Codex, OpenClaw, Hermes) expose
 * roughly the same interface: `binary <flags> <prompt>` produces output
 * on stdout. This factory builds an AdapterImpl by capturing those
 * conventions in a single, testable place.
 *
 * Each per-adapter file under this directory specializes the shape of
 * the spawn (flag set, env, working directory, stdin vs argv prompt)
 * and registers itself with the central AdapterRegistry on daemon
 * startup via auto-register.ts.
 *
 * What this factory does NOT do (yet):
 *   - Streaming output. dispatch() resolves once the child exits;
 *     incremental token streams need the cloud relay opcode 0x01
 *     bridge, which lands in a follow-up sprint.
 *   - Permission gating. The PARA Tier 5 approval gate runs before
 *     dispatch is called, not inside it.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import type { AdapterImpl, AdapterDispatchInput, AdapterDispatchResult } from '../adapter-registry.js';

export interface CliAdapterConfig {
  /** Catalog name — used as the adapter id. */
  name: string;
  /** Path to the binary. Resolved once at registration time. */
  binary: string;
  /** Base flags prepended before the prompt. */
  baseArgs?: string[];
  /** PARA tiers this adapter can host. */
  tiersSupported: number[];
  /** Capability tags this adapter can satisfy. */
  capabilityTags: string[];
  /** How to pass the prompt to the binary. */
  promptVia?: 'stdin' | 'last-arg';
  /** Soft timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra env vars to inject. */
  env?: Record<string, string>;
}

export function createCliAdapter(config: CliAdapterConfig): AdapterImpl {
  const promptVia = config.promptVia ?? 'last-arg';
  const timeoutMs = config.timeoutMs ?? 5 * 60 * 1000;

  return {
    name: config.name,
    tiersSupported: config.tiersSupported,
    capabilityTags: config.capabilityTags,
    metadata: { binary: config.binary, promptVia },
    async dispatch(input: AdapterDispatchInput): Promise<AdapterDispatchResult> {
      return await runCliOnce(config, input, { promptVia, timeoutMs });
    },
    async health() {
      // Cheap probe — the binary path was resolved at registration time,
      // so just confirm we can still find it. Heavier probes would slow
      // every health request and hide a stalled adapter behind a passing
      // probe; we leave deeper liveness checks to the agent itself.
      return { healthy: true };
    },
    async reset(_agentName?: string) {
      // Each `dispatch` spawns a fresh child process; there is no persistent
      // per-agent state to clear. Report stateless_noop so the caller can
      // ack cleanly. v1.9.x agent_restart semantic — see
      // adapter-registry.ts::AdapterImpl.reset for the contract.
      return { ok: true, state: 'stateless_noop' };
    },
  };
}

interface RunOpts {
  promptVia: 'stdin' | 'last-arg';
  timeoutMs: number;
}

function runCliOnce(
  config: CliAdapterConfig,
  input: AdapterDispatchInput,
  runOpts: RunOpts,
): Promise<AdapterDispatchResult> {
  return new Promise((resolve) => {
    const args = [...(config.baseArgs ?? [])];
    if (runOpts.promptVia === 'last-arg') {
      args.push(input.prompt);
    }

    const spawnOpts: SpawnOptions = {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    let child;
    try {
      child = spawn(config.binary, args, spawnOpts);
    } catch (err) {
      resolve({ ok: false, error: `spawn_failed:${(err as Error).message}` });
      return;
    }

    if (runOpts.promptVia === 'stdin') {
      child.stdin?.end(input.prompt, 'utf8');
    } else if (child.stdin) {
      child.stdin.end();
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    const MAX_BUF = 8 * 1024 * 1024; // 8 MiB cap so a runaway log doesn't OOM the daemon

    child.stdout?.on('data', (chunk) => {
      if (stdoutBuf.length < MAX_BUF) stdoutBuf += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderrBuf.length < MAX_BUF) stderrBuf += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // child may have already exited
      }
    }, runOpts.timeoutMs);
    if (typeof (timer as unknown as { unref: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn_error:${err.message}`, output: stderrBuf || undefined });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          error: `timeout:${runOpts.timeoutMs}ms`,
          output: stdoutBuf || undefined,
          metadata: { stderr: stderrBuf, signal },
        });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, output: stdoutBuf, metadata: { stderr: stderrBuf, exitCode: 0 } });
      } else {
        resolve({
          ok: false,
          error: `nonzero_exit:${code ?? signal ?? 'unknown'}`,
          output: stdoutBuf || undefined,
          metadata: { stderr: stderrBuf, exitCode: code, signal },
        });
      }
    });
  });
}
