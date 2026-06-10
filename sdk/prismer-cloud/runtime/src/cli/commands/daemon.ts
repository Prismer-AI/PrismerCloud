// `prismer daemon (start|stop|restart|status|logs)` — process lifecycle.
//
// LaunchAgent friendliness: when invoked from launchd (KeepAlive=true) before
// the user has run `prismer setup`, exiting non-zero would put us in a tight
// restart loop. Instead, poll for ~/.prismer/config.toml every 5s and start
// the runner only once it appears. The user sets up whenever they want, and
// the daemon snaps to attention.

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { configExists, resolvePaths } from '../../config.js';
import { Runner } from '../../daemon/runner.js';
import { clearPidFile, exitWithError, pidAlive, printJson, readPidFile, writePidFile } from '../util.js';
import { getUI } from '../ui.js';

export function buildDaemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage the prismer daemon process');

  cmd
    .command('start')
    .description('Start the daemon in the background (use --foreground for Docker/systemd)')
    .option('--port <port>', 'Local server port (default 3210)', (v) => Number.parseInt(v, 10))
    .option('--no-local-server', 'Skip starting the local 127.0.0.1 server')
    .option('--foreground', 'Run in the foreground instead of daemonizing')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { port?: number; localServer?: boolean; foreground?: boolean; json?: boolean }) => {
      if (!opts.foreground) {
        await startBackground(opts);
        return;
      }
      await runForeground(opts);
    });

  cmd
    .command('run')
    .description('Internal foreground daemon worker')
    .option('--port <port>', 'Local server port (default 3210)', (v) => Number.parseInt(v, 10))
    .option('--no-local-server', 'Skip starting the local 127.0.0.1 server')
    .option('--json', 'Accept --json for global flag compatibility')
    .action(async (opts: { port?: number; localServer?: boolean }) => {
      await runForeground(opts);
    });

  async function runForeground(opts: { port?: number; localServer?: boolean }): Promise<void> {
      const paths = resolvePaths();
      const existingPid = readPidFile(paths);
      if (existingPid && pidAlive(existingPid)) {
        exitWithError(`Daemon already running (pid ${existingPid}). Use \`prismer daemon stop\` first.`);
      }
      writePidFile(paths, process.pid);

      let runner: Runner | undefined;
      let stopRequested = false;

      const shutdown = async (sig: NodeJS.Signals) => {
        process.stderr.write(`[daemon] received ${sig}, shutting down…\n`);
        stopRequested = true;
        try {
          if (runner) {
            process.stderr.write(`[daemon] calling runner.stop()\n`);
            await runner.stop();
            process.stderr.write(`[daemon] runner.stop() returned\n`);
          }
        } catch (err) {
          process.stderr.write(`[daemon] shutdown error: ${(err as Error).message}\n`);
        }
        clearPidFile(paths);
        process.stderr.write(`[daemon] active handles=${(process as any)._getActiveHandles?.().length} requests=${(process as any)._getActiveRequests?.().length}\n`);
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));

      // Wait for config.toml to appear (set by `prismer setup`). Without this,
      // LaunchAgent KeepAlive=true would re-spawn us in a tight loop on every
      // exit. Polling keeps the process alive cheaply until first setup.
      while (!configExists(paths)) {
        if (stopRequested) return;
        getUI().info(`[daemon] waiting for ${paths.configFile} — run \`prismer setup\` to create it`);
        await sleep(5_000);
      }

      runner = new Runner({
        startLocalServer: opts.localServer !== false,
        localPort: opts.port,
      });

      // Surface auth failures from the WS layer (or application AUTH_FAILED)
      // as a hard daemon exit so launchd/k8s/CI sees a clear non-zero status
      // and the operator gets a readable message — without this the daemon
      // would keep the pid file but do nothing useful.
      runner.on('auth-failed', () => {
        process.stderr.write(`[daemon] auth failed — stop and run \`prismer setup --force\` with a valid account\n`);
        void (async () => {
          try {
            if (runner) await runner.stop();
          } catch {
            /* best-effort */
          }
          clearPidFile(paths);
          process.exit(2);
        })();
      });

      try {
        await runner.start();
        getUI().info(`[daemon] started, pid ${process.pid}, ws connecting…`);
      } catch (err) {
        clearPidFile(paths);
        exitWithError(`failed to start: ${(err as Error).message}`);
      }
  }

  async function startBackground(opts: { port?: number; localServer?: boolean; json?: boolean }): Promise<void> {
    const paths = resolvePaths();
    const existingPid = readPidFile(paths);
    if (existingPid && pidAlive(existingPid)) {
      exitWithError(`Daemon already running (pid ${existingPid}). Use \`prismer daemon stop\` first.`);
    }
    if (!existsSync(paths.logsDir)) mkdirSync(paths.logsDir, { recursive: true });
    const logFile = join(paths.logsDir, 'daemon.log');
    const fd = openSync(logFile, 'a');
    const args = [process.argv[1]!, 'daemon', 'run'];
    if (opts.port) args.push('--port', String(opts.port));
    if (opts.localServer === false) args.push('--no-local-server');
    const child = spawn(process.execPath, args, {
      env: { ...process.env, PRISMER_HOME: paths.root },
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    child.unref();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await sleep(200);
      const pid = readPidFile(paths);
      if (pid && pidAlive(pid)) {
        if (opts.json) printJson({ ok: true, pid, logFile });
        else getUI().ok('Daemon started', `pid ${pid} · logs ${logFile}`);
        return;
      }
    }
    if (opts.json) printJson({ ok: false, error: 'daemon_start_timeout', logFile });
    else process.stderr.write(`Daemon did not write a live pid within 5s. Check logs: ${logFile}\n`);
    process.exit(2);
  }

  cmd
    .command('stop')
    .description('Send SIGTERM to the running daemon')
    .option('--timeout <ms>', 'Time to wait for graceful exit (default 5000)', (v) => Number.parseInt(v, 10))
    .option('--json', 'Accept --json for global flag compatibility (no JSON body produced)')
    .action(async (opts: { timeout?: number }) => {
      const paths = resolvePaths();
      const pid = readPidFile(paths);
      if (!pid) exitWithError('No daemon.pid found — daemon does not appear to be running.');
      if (!pidAlive(pid!)) {
        clearPidFile(paths);
        getUI().warn('Daemon was not alive', `pid ${pid}; cleared stale pid file`);
        return;
      }
      try {
        process.kill(pid!, 'SIGTERM');
      } catch (err) {
        exitWithError(`SIGTERM failed: ${(err as Error).message}`);
      }
      const deadline = Date.now() + (opts.timeout ?? 5_000);
      while (Date.now() < deadline) {
        if (!pidAlive(pid!)) {
          clearPidFile(paths);
          getUI().ok('Daemon stopped', `pid ${pid}`);
          return;
        }
        await sleep(200);
      }
      process.stderr.write(`Daemon did not exit within timeout; pid ${pid} may still be alive.\n`);
      process.exit(2);
    });

  cmd
    .command('restart')
    .description('Stop then start')
    .option('--port <port>', 'Local server port (default 3210)', (v) => Number.parseInt(v, 10))
    .option('--no-local-server', 'Skip starting the local 127.0.0.1 server')
    .option('--foreground', 'Restart into foreground mode')
    .option('--json', 'Accept --json for global flag compatibility')
    .action(async (opts: { port?: number; localServer?: boolean; foreground?: boolean }) => {
      const stop = cmd.commands.find((c) => c.name() === 'stop');
      const start = cmd.commands.find((c) => c.name() === 'start');
      if (!stop || !start) exitWithError('internal: subcommands missing');
      await stop!.parseAsync(['stop'], { from: 'user' });
      const startArgs: string[] = ['start'];
      if (opts.foreground) startArgs.push('--foreground');
      if (opts.port) startArgs.push('--port', String(opts.port));
      if (opts.localServer === false) startArgs.push('--no-local-server');
      await start!.parseAsync(startArgs, { from: 'user' });
    });

  cmd
    .command('status')
    .description('Show daemon process + WS state')
    .option('--json', 'Output JSON (default)')
    .action(async () => {
      const paths = resolvePaths();
      const pid = readPidFile(paths);
      const alive = pid ? pidAlive(pid) : false;
      if (!pid || !alive) {
        printJson({ running: false, pid: pid ?? null, paths: { config: paths.configFile } });
        return;
      }
      // Try local server /healthz for richer info.
      let local: unknown = null;
      try {
        const res = await fetch('http://127.0.0.1:3210/healthz', {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) local = await res.json();
      } catch {
        /* daemon may not have local server; that's OK */
      }
      printJson({ running: true, pid, paths: { config: paths.configFile }, local });
    });

  cmd
    .command('logs')
    .description('Show daemon logs')
    .option('--tail <n>', 'Number of lines to show', (v) => Number.parseInt(v, 10), 80)
    .option('--follow', 'Follow log output')
    .option('--json', 'Accept --json for global flag compatibility (raw log bytes are streamed)')
    .action(async (opts: { tail: number; follow?: boolean }) => {
      const paths = resolvePaths();
      const logFile = join(paths.logsDir, 'daemon.log');
      if (!existsSync(logFile)) {
        exitWithError(`No daemon log found at ${logFile}. Start the daemon with \`prismer daemon start\`.`);
      }
      // Stream the tail in O(tail) memory rather than reading the entire log
      // — daemon.log on long-lived hosts can be tens of MB and a full-file
      // read would block the event loop and pin RSS unnecessarily.
      const lines = Math.max(1, opts.tail);
      process.stdout.write(await tailFromEnd(logFile, lines));
      if (!opts.follow) return;
      await followFile(logFile);
    });

  return cmd;
}

/**
 * Read the last `lines` newline-separated entries from a file by seeking from
 * the end and reading 64KB chunks until enough newlines are accumulated. Falls
 * back to a full read for files smaller than the chunk size.
 */
async function tailFromEnd(path: string, lines: number): Promise<string> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    let size = stat.size;
    if (size === 0) return '';
    const chunkSize = Math.min(size, 64 * 1024);
    let buf = Buffer.alloc(0);
    let newlines = 0;
    let pos = size;
    // Read chunks from the end until we either have enough newlines or hit
    // the start of the file.
    while (pos > 0 && newlines <= lines) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, pos);
      buf = Buffer.concat([chunk, buf]);
      // Count newlines (subtract 1 to skip a trailing newline if present).
      newlines = 0;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x0a) newlines += 1;
      }
    }
    const text = buf.toString('utf8');
    const parts = text.split(/\r?\n/);
    const slice = parts.slice(Math.max(0, parts.length - lines - 1));
    return slice.join('\n') + (slice.length > 0 && slice[slice.length - 1] !== '' ? '\n' : '');
  } finally {
    await handle.close();
  }
}

async function followFile(path: string): Promise<void> {
  let offset = statSync(path).size;
  for (;;) {
    await sleep(1_000);
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const stream = createReadStream(path, { start: offset, end: size - 1, encoding: 'utf8' });
    for await (const chunk of stream) process.stdout.write(chunk);
    offset = size;
  }
}
