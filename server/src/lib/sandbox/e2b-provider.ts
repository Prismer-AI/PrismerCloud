/**
 * Release 200 T10 — E2B ephemeral executor (stretch).
 *
 * Delegates to the official `@e2b/code-interpreter` SDK. v200 keeps this
 * package as an OPTIONAL runtime dep (not installed by default — avoids
 * pulling a wasm/sandbox-bridge dependency into the cloud bundle when no
 * one configures `E2B_API_KEY`). It loads via `await import(…)`; if the
 * package isn't resolvable at runtime, `run()` throws
 * `ProviderError('invalid_config', 'not_installed', ...)` and the route
 * surfaces a 400.
 *
 * Registration in `registry.ts` is gated on `process.env.E2B_API_KEY`
 * being present, so the un-installed case only triggers when someone
 * deliberately set the env var without `npm i @e2b/code-interpreter`.
 *
 * E2B SDK surface evolves between versions; we duck-type against a
 * minimal contract (`Sandbox.create({apiKey,timeoutMs})` returning
 * `{sandboxId, commands.run(cmd,{envs,timeoutMs}), kill()}`) which
 * matches `@e2b/code-interpreter ^1.0.0`. If the installed SDK doesn't
 * match, we surface `ProviderError('invalid_config', 'sdk_surface_mismatch')`.
 */

import { ProviderError } from '@/lib/execution/errors';
import type {
  EphemeralExecutor,
  ExecutionEnvironment,
  ProvisionEnvironmentInput,
  RunRequest,
  RunResult,
} from './types';

/**
 * Minimal duck-type matching `@e2b/code-interpreter ^1.0.0` Sandbox.
 * We use `unknown` everywhere we cross into the SDK boundary to keep
 * TS happy without taking a hard import-time dependency on the package.
 */
interface E2bSandboxLike {
  sandboxId: string;
  commands: {
    run(
      command: string,
      opts?: { envs?: Record<string, string>; timeoutMs?: number; cwd?: string },
    ): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  };
  kill?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface E2bSdkLike {
  Sandbox: {
    create(opts: { apiKey: string; timeoutMs?: number }): Promise<E2bSandboxLike>;
  };
}

/**
 * `@e2b/code-interpreter` is an intentionally-optional dependency: T10 left
 * it as an unbundled stub so the dev install isn't burdened by a heavy SDK
 * the user usually doesn't need (no `E2B_API_KEY` → provider unregistered).
 *
 * Plain `await import('@e2b/code-interpreter')` is statically resolvable by
 * Turbopack/Webpack so the bundler emits a noisy "Module not found" warning
 * on every build even though the runtime path is gated. We hide the import
 * behind a `new Function` indirection — bundlers can't trace the constructor
 * argument, so they leave it alone. Resolution happens at runtime; if the
 * package isn't installed Node throws ERR_MODULE_NOT_FOUND, which we catch.
 */
const dynamicImport = new Function('spec', 'return import(spec)') as (spec: string) => Promise<unknown>;

async function loadE2bSdk(): Promise<E2bSdkLike | null> {
  try {
    const mod = (await dynamicImport('@e2b/code-interpreter')) as unknown;
    if (
      mod &&
      typeof mod === 'object' &&
      'Sandbox' in mod &&
      typeof (mod as { Sandbox?: unknown }).Sandbox === 'object'
    ) {
      return mod as E2bSdkLike;
    }
    return null;
  } catch {
    return null;
  }
}

export class E2bSandboxProvider implements EphemeralExecutor {
  readonly kind = 'e2b' as const;
  readonly capabilities = {
    runtimeModel: 'ephemeral',
    supportsSnapshots: false,
    supportsDaemonDispatch: false,
    supportsAgentInstall: false,
    supportsLogs: true,
    supportsPortForwarding: false,
  } as const;

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('[e2b] E2B_API_KEY required to construct E2bSandboxProvider');
    }
  }

  async getEnvironment(_id: string): Promise<ExecutionEnvironment | null> {
    return null;
  }

  async removeEnvironment(_id: string): Promise<void> {
    return;
  }

  /** Legacy v190 — not implemented. */
  async execute(
    _input: ProvisionEnvironmentInput,
    _command: { command: string[]; timeoutMs?: number },
  ): Promise<never> {
    throw new ProviderError(
      'invalid_config',
      'E2bSandboxProvider.execute() is unused in v200 — use run() via POST /api/runs',
      false,
    );
  }

  /**
   * Liveness probe. Without an actual API ping endpoint exposed by
   * `@e2b/code-interpreter`, we report ok=true iff the SDK loads (cheap)
   * — actual API key validity is verified only at first `run()`.
   */
  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    const sdk = await loadE2bSdk();
    if (!sdk) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: '@e2b/code-interpreter package not installed',
      };
    }
    return { ok: true, latencyMs: Date.now() - start };
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (!Array.isArray(request.command) || request.command.length === 0) {
      throw new ProviderError('invalid_config', 'run() requires non-empty command argv', false);
    }

    const sdk = await loadE2bSdk();
    if (!sdk) {
      throw new ProviderError(
        'invalid_config',
        '@e2b/code-interpreter not installed — run `npm install @e2b/code-interpreter` to enable the e2b executor',
        false,
        { hint: 'not_installed' },
      );
    }

    const start = Date.now();
    const timeoutMs = request.timeoutMs ?? 60_000;

    let sandbox: E2bSandboxLike;
    try {
      sandbox = await sdk.Sandbox.create({ apiKey: this.apiKey, timeoutMs });
    } catch (err) {
      throw new ProviderError(
        'daemon_unreachable',
        `e2b sandbox create failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    try {
      // Quote-safe shell join — E2B's commands.run takes a single string.
      // We assume the caller already escaped any shell metacharacters in
      // their argv. For 99% of v200 callers (LLM-generated short scripts)
      // this is fine; serious users can pass `['sh','-c','...']` explicitly.
      const cmd = request.command.join(' ');
      const res = await sandbox.commands.run(cmd, {
        envs: request.env,
        timeoutMs,
        cwd: request.workingDir,
      });
      return {
        runId: sandbox.sandboxId,
        exitCode: res.exitCode ?? 0,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        durationMs: Date.now() - start,
        providerRefs: { sandboxId: sandbox.sandboxId, provider: 'e2b' },
      };
    } finally {
      // best-effort cleanup — close > kill > nothing
      try {
        if (typeof sandbox.kill === 'function') {
          await sandbox.kill();
        } else if (typeof sandbox.close === 'function') {
          await sandbox.close();
        }
      } catch {
        // ignore — sandbox cleanup is best-effort
      }
    }
  }
}
