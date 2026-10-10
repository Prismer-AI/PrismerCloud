import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { NodeExecutionEnv, ExecutionError, err, ok, type ShellExecOptions } from '@earendil-works/pi-agent-core/node';

// Keep the process-group leader alive after the command returns. Otherwise a
// background child outlives the shell and its recycled PID is no longer safe to
// signal. The supervisor owns no separate process group inside this group.
const SUPERVISOR = `
const {spawn} = require('node:child_process');
process.on('disconnect', () => { process.kill(-process.pid, 'SIGKILL'); });
process.once('message', ({command, shell, env}) => {
  const child = spawn(shell, ['-c', command], {env, stdio:['ignore','pipe','pipe']});
  const send = message => process.send(message, () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => send({stdout:data.toString()}));
  child.stderr.on('data', data => send({stderr:data.toString()}));
  child.on('error', () => send({error:true}));
  child.on('close', code => send({code:code ?? 1}));
});
`;

/** POSIX shell ownership for the entire Pi session, including completed tools. */
export class OwnedExecutionEnv extends NodeExecutionEnv {
  private readonly owners = new Map<ChildProcess, Promise<void>>();
  private readonly killSent = new WeakSet<ChildProcess>();
  private ownershipLost = false;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly config: { cwd: string; shellEnv?: NodeJS.ProcessEnv; shellPath?: string }) {
    super(config);
  }

  override async exec(command: string, options: ShellExecOptions = {}): ReturnType<NodeExecutionEnv['exec']> {
    if (this.closed || options.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'));
    // Windows does not have POSIX process groups. Retain the upstream platform implementation.
    if (process.platform === 'win32') return super.exec(command, options);
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
      return err(new ExecutionError('unknown', 'invalid shell timeout'));
    const child = spawn(process.execPath, ['-e', SUPERVISOR], {
      cwd: options.cwd ? resolve(this.cwd, options.cwd) : this.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Never carry Node loader/debug flags into this plain JS supervisor.
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const exited = new Promise<void>((done) => {
      child.once('exit', () => {
        if (!this.killSent.has(child)) this.ownershipLost = true;
        done();
      });
      child.once('error', () => done());
    });
    this.owners.set(child, exited);
    return new Promise<Awaited<ReturnType<NodeExecutionEnv['exec']>>>((done) => {
      let stdout = '', stderr = '', settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: Awaited<ReturnType<NodeExecutionEnv['exec']>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', abort);
        done(result);
      };
      const stop = (kind: 'aborted' | 'timeout' | 'callback_error') => {
        try { this.killOwned(child); }
        catch { settle(err(new ExecutionError('unknown', 'owned shell cleanup failed'))); return; }
        settle(err(new ExecutionError(kind, kind)));
      };
      const abort = () => stop('aborted');
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        stdout += chunk;
        try { options.onStdout?.(chunk); } catch { stop('callback_error'); }
      });
      child.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
        try { options.onStderr?.(chunk); } catch { stop('callback_error'); }
      });
      child.on('message', (message: { code?: number; error?: boolean; stdout?: string; stderr?: string }) => {
        try {
          if (typeof message.stdout === 'string') { stdout += message.stdout; options.onStdout?.(message.stdout); }
          if (typeof message.stderr === 'string') { stderr += message.stderr; options.onStderr?.(message.stderr); }
        } catch { stop('callback_error'); return; }
        if (message.error) settle(err(new ExecutionError('spawn_error', 'shell could not start')));
        else if (typeof message.code === 'number') settle(ok({ stdout, stderr, exitCode: message.code }));
      });
      child.once('error', () => settle(err(new ExecutionError('spawn_error', 'shell supervisor could not start'))));
      child.once('exit', () => settle(err(new ExecutionError('aborted', 'shell supervisor exited'))));
      child.once('spawn', () => child.send({ command, shell: this.config.shellPath ?? '/bin/bash',
        env: { ...(options.inheritEnv === false ? {} : (this.config.shellEnv ?? process.env)), ...options.env },
      }, (error) => { if (error) settle(err(new ExecutionError('spawn_error', 'shell supervisor disconnected'))); }));
      options.abortSignal?.addEventListener('abort', abort, { once: true });
      if (options.timeout !== undefined) timer = setTimeout(() => stop('timeout'), options.timeout * 1000);
      if (this.closed || options.abortSignal?.aborted) abort();
    });
  }

  private killOwned(child: ChildProcess) {
    if (this.killSent.has(child) || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); this.killSent.add(child); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  override cleanup(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.owners].map(async ([child, exited]) => {
        this.killOwned(child);
        await exited;
      }));
      await super.cleanup();
      if (this.ownershipLost) throw new Error('shell supervisor ownership lost');
      if (results.some(result => result.status === 'rejected')) throw new Error('owned shell cleanup failed');
      this.owners.clear();
    })();
  }
}
