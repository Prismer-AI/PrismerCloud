import {
  EaasClientError,
  newIdempotencyKey,
  type EaasApiEnvelope,
  type EnvironmentStatus,
} from './environment-contract';
import type {
  EnvironmentCreateSpec,
  EnvironmentListPage,
  EaasExecView,
  EaasExecReadView,
  EaasLifecycleResult,
  EaasFileGetResult,
  EaasFilePutView,
} from './environment-contract';
/** Narrow transport port avoids importing the public client barrel back into its facade. */
interface SandboxTransport {
  create(
    spec: EnvironmentCreateSpec,
    options?: { idempotencyKey?: string },
  ): Promise<EaasApiEnvelope<EnvironmentStatus>>;
  get(id: string): Promise<EaasApiEnvelope<EnvironmentStatus>>;
  list(options?: { cursor?: string; limit?: number }): Promise<EaasApiEnvelope<EnvironmentListPage>>;
  delete(id: string): Promise<EaasApiEnvelope<EaasLifecycleResult>>;
  exec(id: string, command: { command: string[]; timeoutMs?: number }): Promise<EaasApiEnvelope<EaasExecView>>;
  getExec(id: string, execId: string, options?: { cursor?: number }): Promise<EaasApiEnvelope<EaasExecReadView>>;
  getFile(id: string, path: string): Promise<EaasFileGetResult>;
  putFile(id: string, path: string, bytes: Uint8Array): Promise<EaasApiEnvelope<EaasFilePutView>>;
}
import { retryAfterMs } from './eaas-response-meta';

export interface SandboxCreateOptions {
  template?: string;
  ttlSeconds?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
}
export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
/** Carries recovery coordinates; timeout never implies the resource was deleted. */
export class SandboxError extends EaasClientError {
  constructor(
    code: string,
    message: string,
    public environmentId?: string,
    public requestId?: string,
    public idempotencyKey?: string,
  ) {
    super(code, message);
    this.name = 'SandboxError';
  }
}
function deadline(timeoutMs = 120_000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new SandboxError('invalid_request', 'timeoutMs must be positive and finite');
  return Date.now() + timeoutMs;
}
async function bounded<T>(request: () => Promise<T>, until: number, id?: string, key?: string): Promise<T> {
  const remaining = until - Date.now();
  if (remaining <= 0)
    throw new SandboxError(
      'timeout',
      'Sandbox operation timed out; query the resource before retrying',
      id,
      undefined,
      key,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SandboxError(
                'timeout',
                'Sandbox operation timed out; query the resource before retrying',
                id,
                undefined,
                key,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function unwrap<T>(result: EaasApiEnvelope<T>, id?: string, key?: string): T {
  if (!result.success) throw new SandboxError(result.error.code, result.error.message, id, result.requestId, key);
  return result.data;
}
async function pause(until: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(1000, until - Date.now()))));
}
async function read<T>(request: () => Promise<EaasApiEnvelope<T>>, until: number, id: string): Promise<T> {
  for (;;) {
    const response = await bounded(request, until, id);
    const delay = !response.success && response.error.code === 'rate_limited' ? retryAfterMs(response) : undefined;
    if (delay === undefined) return unwrap(response, id);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(delay, until - Date.now()))));
  }
}
async function ready(low: SandboxTransport, id: string, until: number): Promise<void> {
  for (;;) {
    const state = await read(() => low.get(id), until, id);
    if (['errored', 'stopped', 'stopping', 'paused'].includes(state.state))
      throw new SandboxError('state_conflict', `Environment is ${state.state}`, id);
    if (state.readiness.sandbox && state.readiness.services) return;
    await pause(until);
  }
}

/** Server-side convenience API. Reuses the exact same project credential as environments. */
export class SandboxesClient {
  constructor(private readonly low: SandboxTransport) {}
  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const until = deadline(options.timeoutMs);
    const key = options.idempotencyKey ?? newIdempotencyKey();
    const spec = {
      ...(options.template === undefined ? {} : { template: options.template }),
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    };
    const created = unwrap(
      await bounded(() => this.low.create(spec, { idempotencyKey: key }), until, undefined, key),
      undefined,
      key,
    );
    await ready(this.low, created.environmentId, until);
    return new SandboxHandle(this.low, created.environmentId);
  }
  async connect(environmentId: string, options: { timeoutMs?: number } = {}): Promise<SandboxHandle> {
    if (!environmentId.trim()) throw new SandboxError('invalid_request', 'environmentId is required');
    await ready(this.low, environmentId, deadline(options.timeoutMs));
    return new SandboxHandle(this.low, environmentId);
  }
  async list(options?: { cursor?: string; limit?: number }) {
    return unwrap(await this.low.list(options));
  }
}

export class SandboxHandle {
  constructor(
    private readonly low: SandboxTransport,
    public readonly id: string,
  ) {}
  readonly commands = {
    run: async (command: string, options: { timeoutMs?: number } = {}): Promise<SandboxCommandResult> => {
      const until = deadline(options.timeoutMs);
      if (!command.trim()) throw new SandboxError('invalid_request', 'command is required', this.id);
      const result = unwrap(
        await bounded(
          () =>
            this.low.exec(this.id, {
              command: ['/bin/sh', '-lc', command],
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            }),
          until,
          this.id,
        ),
        this.id,
      );
      if (result.status === 'exited')
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      // Poll from zero until terminal: running output is a replaceable snapshot.
      // Once terminal, follow the opaque server cursor rather than calculating byte offsets.
      for (;;) {
        let page = await read(() => this.low.getExec(this.id, result.execId, { cursor: 0 }), until, this.id);
        if (page.status === 'failed')
          throw new SandboxError('runtime_unavailable', page.error ?? 'Command failed', this.id);
        if (page.status !== 'exited') {
          await pause(until);
          continue;
        }
        let stdout = page.stdout;
        const stderr = page.stderr;
        const exitCode = page.exitCode;
        if (exitCode === null)
          throw new SandboxError('runtime_unavailable', 'Exited command has no exit code', this.id);
        const seen = new Set<number>();
        while (page.nextCursor !== null) {
          const cursor = page.nextCursor;
          if (seen.has(cursor)) throw new SandboxError('runtime_unavailable', 'Exec cursor did not advance', this.id);
          seen.add(cursor);
          page = await read(() => this.low.getExec(this.id, result.execId, { cursor }), until, this.id);
          stdout += page.stdout;
        }
        return { stdout, stderr, exitCode };
      }
    },
  };
  /** UTF-8 files relative to /home/agent/workspace, matching the server file boundary. */
  readonly files = {
    read: async (path: string): Promise<string> => {
      validateFilePath(path);
      const result = await bounded(() => this.low.getFile(this.id, path), deadline(), this.id);
      if (!result.success) throw new SandboxError(result.error.code, result.error.message, this.id, result.requestId);
      return new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
    },
    write: async (path: string, content: string): Promise<void> => {
      validateFilePath(path);
      unwrap(
        await bounded(() => this.low.putFile(this.id, path, new TextEncoder().encode(content)), deadline(), this.id),
        this.id,
      );
    },
  };
  async kill(options: { timeoutMs?: number } = {}): Promise<void> {
    const until = deadline(options.timeoutMs);
    const result = unwrap(await bounded(() => this.low.delete(this.id), until, this.id), this.id);
    let state: EnvironmentStatus['state'] = result.state;
    while (state !== 'stopped') {
      // DELETE is replayable for owned tombstones; GET deliberately hides them.
      await pause(until);
      const response = await read(() => this.low.delete(this.id), until, this.id);
      // Still require confirmed stopped, never infer completion from a 404.
      state = response.state;
      if (state === 'errored') throw new SandboxError('state_conflict', 'Environment deletion failed', this.id);

    }
  }
}

function validateFilePath(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    throw new SandboxError('invalid_request', 'File paths must be relative to /home/agent/workspace');
}
