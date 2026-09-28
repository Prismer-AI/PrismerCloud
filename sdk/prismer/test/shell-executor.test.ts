import { describe, expect, it } from 'vitest';
import {
  executeShellDispatch,
  isShellDispatch,
  resolveShellConfig,
} from '../src/daemon/shell-executor.js';
import type { TaskDispatchProgressPayload, TaskDispatchRequestPayload } from '../src/types/im-events.js';

function payload(command: string): TaskDispatchRequestPayload {
  return {
    taskId: `task-${Date.now()}`,
    targetDaemonId: 'daemon-1',
    profileId: '',
    capability: 'shell',
    prompt: command,
    runtimeRoute: 'shell',
    metadata: {
      execution: {
        kind: 'shell',
        command,
      },
    },
    timeoutMs: 5_000,
  };
}

describe('shell executor', () => {
  it('detects shell dispatches', () => {
    expect(isShellDispatch(payload('echo ok'))).toBe(true);
    expect(isShellDispatch({ ...payload('echo ok'), runtimeRoute: 'agent', metadata: {} })).toBe(false);
  });

  it('rejects when disabled', async () => {
    const reply = await executeShellDispatch(payload('echo ok'), {
      config: resolveShellConfig({ enabled: false }),
      workspaceId: 'ws-1',
      onProgress: () => {},
    });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('shell_disabled');
  });

  it('streams stdout and completes', async () => {
    const progress: TaskDispatchProgressPayload[] = [];
    const reply = await executeShellDispatch(payload('printf shell-ok'), {
      config: resolveShellConfig({ enabled: true, defaultCwd: process.cwd(), maxTimeoutMs: 5_000 }),
      workspaceId: 'ws-1',
      onProgress: (p) => progress.push(p),
    });
    expect(reply.ok).toBe(true);
    expect(reply.output).toContain('shell-ok');
    expect(progress.some((p) => p.detail?.stream === 'stdout' && String(p.detail?.chunk).includes('shell-ok'))).toBe(true);
  });

  it('reports non-zero exit', async () => {
    const reply = await executeShellDispatch(payload('echo bad >&2; exit 7'), {
      config: resolveShellConfig({ enabled: true, defaultCwd: process.cwd(), maxTimeoutMs: 5_000 }),
      workspaceId: 'ws-1',
      onProgress: () => {},
    });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('shell_exit_nonzero');
    expect(reply.output).toContain('exitCode: 7');
    expect(reply.output).toContain('bad');
  });
});
