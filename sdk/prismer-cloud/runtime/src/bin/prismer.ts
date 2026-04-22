import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Command } from 'commander';
import { UI, applyCommonFlags } from '../cli/ui.js';
import { runBrowserOAuth, openBrowser } from '../cli/browser-oauth.js';
import { Keychain, KeychainAccessDeniedError, NoKeychainBackendError } from '../keychain.js';
import { migrateSecrets } from '../commands/migrate-secrets.js';
import type { MigrateStep } from '../commands/migrate-secrets.js';
import { createCliContext } from '../cli/context.js';
import { installAgent } from '../agents/install-agent.js';
import { listAgents } from '../agents/list-agent.js';
import { doctorAgent } from '../agents/doctor-agent.js';
import { uninstallAgent, UninstallCancelledError } from '../agents/uninstall-agent.js';
import { publishAgent, unpublishAgent } from '../agents/publish-agent.js';
import { resolveDaemonIdentity, daemonStart, daemonStop, daemonRestart, daemonStatus, daemonLogs } from '../commands/daemon.js';
import { statusCommand } from '../commands/status.js';
import { startDaemonRunner } from '../daemon/runner.js';
import { pairShow, pairList, pairRevoke } from '../commands/pair.js';
import { migrateCommand } from '../commands/migrate.js';
import { registerTaskCommands } from '../commands/task.js';
import { registerMemoryCommands } from '../commands/memory.js';
import { registerMemoryKeyCommands } from '../commands/memory-key.js';
import { registerEvolutionCommands } from '../commands/evolution.js';
import { isValidSessionId } from '../trace-writer.js';
import { loadConfig, writeConfig } from '../config.js';

// v1.9.0 A.1 — SDK CLI commands mount via runtime resolution so developers
// can run `tsc --noEmit` or `vitest` inside the runtime package even when
// @prismer/sdk is not linked locally. At prod install time install.sh pulls
// both @prismer/runtime and @prismer/sdk to global node_modules, so the
// require resolves by the time the bin actually executes.
type SdkCliRegister = (program: Command, opts?: { skipConflicting?: boolean }) => void;

function loadSdkCliRegister(): SdkCliRegister | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@prismer/sdk/cli') as { registerSdkCliCommands?: SdkCliRegister };
    return mod.registerSdkCliCommands ?? null;
  } catch {
    return null;
  }
}

const DEFAULT_DAEMON_PORT = 3210;

interface HttpResult {
  status: number;
  body: string;
}

/** Standard Prismer API envelope (see docs/API.md). */
interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
  requestId?: string;
  processingTime?: number;
}

async function httpGet(url: string, timeoutMs = 3000, headers?: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  return { status: res.status, body };
}

function httpPost(url: string, body?: unknown, timeoutMs = 3000, headers?: Record<string, string>): Promise<HttpResult> {
  // Localhost-only path (kept because reprobe hits 127.0.0.1 via http.request,
  // and switching to fetch would need an IPv6 fallback we don't need yet).
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? '' : JSON.stringify(body);
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload).toString(),
            ...(headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  // Remote path — use global fetch so https:// works without pulling in node:https.
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => ({ status: res.status, body: await res.text() }));
}

/**
 * Parse an HttpResult into the standard Prismer API envelope. On malformed
 * JSON, returns a synthesized `{ success: false, error }` envelope so the
 * caller's .success / .error pattern still works.
 */
function parseApiEnvelope<T = unknown>(res: HttpResult): ApiEnvelope<T> {
  try {
    const parsed = JSON.parse(res.body) as ApiEnvelope<T>;
    if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
      return parsed;
    }
    return { success: false, error: { message: `Unexpected response shape (status ${res.status})` } };
  } catch {
    return {
      success: false,
      error: { message: `Invalid JSON response (status ${res.status}): ${res.body.slice(0, 120)}` },
    };
  }
}

// ============================================================
// Parse global flags before commander takes over
// ============================================================

const { mode, color, restArgv } = applyCommonFlags(process.argv.slice(2));
const ui = new UI({ mode, color });

// Re-construct argv with the program name for commander
const commanderArgv = [process.argv[0], process.argv[1], ...restArgv];

// ============================================================
// Program
// ============================================================

const program = new Command();

program
  .name('prismer')
  .description('Prismer Cloud runtime CLI')
  .version('1.9.0');

program
  .command('banner')
  .description('Show the Prismer runtime CLI banner')
  .option('--compact', 'Show the compact terminal banner')
  .action((cmdOpts: { compact?: boolean }) => {
    ui.banner('Runtime CLI v1.9.0', { full: !cmdOpts.compact });
  });

// ============================================================
// setup — helpers
// ============================================================

async function persistApiKey(apiKey: string): Promise<void> {
  const existing = await loadConfig({ resolvePlaceholders: false }).catch(() => ({}));
  const nextConfig = {
    ...(existing as Record<string, unknown>),
    default: {
      ...((existing as { default?: Record<string, unknown> }).default ?? {}),
      api_key: apiKey,
      environment: (existing as { default?: { environment?: string } }).default?.environment ?? 'production',
      base_url: (existing as { default?: { base_url?: string } }).default?.base_url ?? 'https://prismer.cloud',
    },
  };
  await writeConfig(nextConfig);
}

function isDaemonAlive(): boolean {
  const pidFile = path.join(os.homedir(), '.prismer', 'daemon.pid');
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    // Signal 0 probes liveness without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

program
  .command('setup [api-key]')
  .description('Run first-run setup: sign in via browser (or accept key arg / PRISMER_API_KEY env), banner, daemon startup, agent scan, and next steps')
  .option('--postinstall', 'Run in npm postinstall mode')
  .option('--no-daemon', 'Skip daemon startup')
  .option('--skip-agent-scan', 'Skip the agent detection pass')
  .option('--force', 'Re-run OAuth even if ~/.prismer/config.toml already has a valid key')
  .option('--manual', 'Open browser but paste the key manually instead of running a localhost callback server')
  .action(async (apiKeyArg: string | undefined, cmdOpts: { postinstall?: boolean; daemon?: boolean; skipAgentScan?: boolean; force?: boolean; manual?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });

    if (cmdOpts.postinstall) {
      const skip = process.env['PRISMER_SKIP_POSTINSTALL'] === '1';
      const force = process.env['PRISMER_FORCE_POSTINSTALL'] === '1';
      const isGlobalInstall = process.env['npm_config_global'] === 'true';
      if (skip || (!isGlobalInstall && !force)) {
        return;
      }
    }

    ctx.ui.banner('Runtime CLI v1.9.0');
    ctx.ui.header('Prismer Runtime Setup');
    ctx.ui.blank();

    // ─── Decide how we obtain the API key ──────────────────────────────────
    // Priority:
    //   (a) explicit arg / PRISMER_API_KEY env → validate + persist
    //   (b) existing key in config (!--force)   → skip OAuth, reuse
    //   (c) TTY + no key                        → browser OAuth (loopback)
    //   (d) non-TTY + no key                    → fatal with actionable hint
    //
    // Track whether this invocation actually wrote a brand-new key so we can
    // warn a pre-existing daemon that it needs a restart.
    const envKey = process.env['PRISMER_API_KEY'];
    const explicitKey = apiKeyArg ?? envKey;
    const existingCfg = await loadConfig({ resolvePlaceholders: false }).catch(() => ({})) as { default?: { api_key?: string; base_url?: string } };
    const existingKey = existingCfg.default?.api_key;
    const baseUrl = existingCfg.default?.base_url ?? 'https://prismer.cloud';
    const wroteNewKey = { value: false };

    const saveKey = async (apiKey: string): Promise<void> => {
      if (!apiKey.startsWith('sk-prismer-')) {
        ctx.ui.error(
          'Invalid API key format',
          'keys start with sk-prismer-',
          'Get your key at https://prismer.cloud/setup',
        );
        process.exit(1);
      }
      try {
        await persistApiKey(apiKey);
        wroteNewKey.value = apiKey !== existingKey;
        ctx.ui.ok('API key saved to ~/.prismer/config.toml', apiKey.slice(0, 12) + '...' + apiKey.slice(-4));
        ctx.ui.blank();
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        ctx.ui.error('Could not persist API key', e.message);
        process.exit(1);
      }
    };

    if (explicitKey !== undefined && explicitKey.length > 0) {
      // Path (a): caller provided a key out-of-band.
      await saveKey(explicitKey);
    } else if (existingKey && existingKey.startsWith('sk-prismer-') && !cmdOpts.force) {
      // Path (b): config already valid — don't nag.
      const masked = existingKey.slice(0, 12) + '...' + existingKey.slice(-4);
      ctx.ui.ok('Already configured', masked);
      ctx.ui.secondary('Re-run with --force to replace the key.');
      ctx.ui.blank();
    } else if (process.stdin.isTTY) {
      // Path (c): interactive — run the loopback OAuth flow.
      if (cmdOpts.manual) {
        const setupUrl = `${baseUrl}/setup?utm_source=cli&utm_medium=manual`;
        ctx.ui.info('Opening browser to sign in...');
        ctx.ui.secondary(setupUrl);
        ctx.ui.blank();
        try { openBrowser(setupUrl); } catch { /* fallback to manual URL */ }
        ctx.ui.info('After signing in, copy the API key from the page and paste it below.');
        ctx.ui.blank();
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const pasted: string = await new Promise((resolveQ) => { rl.question('Paste your API key: ', (key: string) => { rl.close(); resolveQ(key.trim()); }); });
        await saveKey(pasted);
      } else {
        try {
          const apiKey = await runBrowserOAuth({ baseUrl, ui: ctx.ui });
          await saveKey(apiKey);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          ctx.ui.error(
            'Browser sign-in did not complete',
            e.message,
            'Retry with: prismer setup --force (or prismer setup --manual to paste the key)',
          );
          process.exit(1);
        }
      }
    } else {
      // Path (d): non-interactive and no key anywhere — we cannot proceed.
      ctx.ui.error(
        'No API key and no interactive terminal',
        'Cannot open a browser without a TTY, and no PRISMER_API_KEY env / positional arg was given',
        'Re-run with: PRISMER_API_KEY=sk-prismer-... prismer setup  (or pass the key positionally)',
      );
      process.exit(1);
    }

    // If a daemon is already running when we save a NEW key, its in-memory
    // identity still has the OLD key. Since the user just went through setup
    // with the explicit intent of getting into a working state, transparently
    // restart the daemon instead of nagging them to re-run a second command.
    // (A `--no-daemon` user opted out of daemon management entirely — respect
    // that and just warn in that case.)
    const daemonWasAlreadyRunning = isDaemonAlive();
    if (wroteNewKey.value && daemonWasAlreadyRunning) {
      if (cmdOpts.daemon === false) {
        ctx.ui.warn(
          'Daemon is already running with the previous API key',
          'The new key will not be used until you restart it',
        );
        ctx.ui.secondary('Run: prismer daemon restart');
        ctx.ui.blank();
      } else {
        ctx.ui.info('Restarting daemon to pick up the new API key...');
        try {
          await daemonRestart(ctx);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          ctx.ui.warn('Auto-restart failed; run prismer daemon restart manually', e.message);
        }
        ctx.ui.blank();
      }
    } else if (cmdOpts.daemon !== false) {
      try {
        await daemonStart(ctx);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        ctx.ui.error('Daemon setup could not complete', e.message, 'prismer daemon logs');
      }
      ctx.ui.blank();
    }

    if (!cmdOpts.skipAgentScan) {
      ctx.ui.header('Prismer Agent Scan');
      ctx.ui.blank();
      await listAgents(ctx);
    }

    ctx.ui.blank();
    ctx.ui.header('Prismer Next Steps');
    ctx.ui.blank();
    ctx.ui.line('  1. Wire a detected agent:      prismer agent install <agent>');
    ctx.ui.line('  2. Install agent + adapter:    prismer agent install <agent> --install-agent');
    ctx.ui.line('  3. Pair a device:              prismer pair show');
    ctx.ui.line('  4. Check runtime health:       prismer status');
    ctx.ui.blank();
    ctx.ui.tip('prismer agent doctor <agent>');
  });

// ============================================================
// __daemon-worker — hidden internal command used by detached fork
// (not shown in --help; parent `daemon start` spawns this)
// ============================================================

program
  .command('__daemon-worker', { hidden: true })
  .option('--port <n>', 'Port to bind', String(3210))
  .action(async (cmdOpts: { port?: string }) => {
    const port = parseInt(cmdOpts.port ?? '3210', 10);
    try {
      // v1.9.0 B.2 — detached workers load the same identity (api key +
      // derived daemonId/userId) so the parent `prismer daemon start` and
      // the child worker agree on who's authenticating to the cloud.
      const { resolveDaemonIdentity } = await import('../commands/daemon.js');
      const identity = await resolveDaemonIdentity();
      await startDaemonRunner({
        port,
        installSignalHandlers: true,
        apiKey: identity.apiKey,
        daemonId: identity.daemonId,
        userId: identity.userId,
        cloudApiBase: identity.cloudApiBase,
        authBearer: identity.apiKey,
      });
      // Stay alive — DaemonProcess signal handlers will call shutdown() + process.exit
    } catch (err) {
      process.stderr.write(
        '[prismer] daemon worker failed to start: ' +
          (err instanceof Error ? err.message : String(err)) + '\n',
      );
      process.exit(1);
    }
  });

// ============================================================
// status — prismer status (§15.2 quick overview)
// ============================================================

program
  .command('status')
  .description('Show daemon, agent, and system status')
  .option('--json', 'Output as JSON')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await statusCommand(ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

// ============================================================
// daemon — lifecycle subcommands
// ============================================================

const daemonCmd = program
  .command('daemon')
  .description('Manage the Prismer daemon process');

daemonCmd
  .command('start')
  .description('Start the daemon in the background (or foreground with --foreground)')
  .option('--port <n>', 'Port to bind', String(DEFAULT_DAEMON_PORT))
  .option('--foreground', 'Run daemon in the foreground (useful for Docker/systemd)')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { port?: string; foreground?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await daemonStart(ctx, {
        port: cmdOpts.port !== undefined ? parseInt(cmdOpts.port, 10) : undefined,
        foreground: cmdOpts.foreground,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'DAEMON_START_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

daemonCmd
  .command('stop')
  .description('Stop the running daemon')
  .option('--json', 'Output as JSON')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await daemonStop(ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'DAEMON_STOP_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

daemonCmd
  .command('restart')
  .description('Restart the daemon (stop then start)')
  .option('--port <n>', 'Port to bind', String(DEFAULT_DAEMON_PORT))
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { port?: string }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await daemonRestart(ctx, {
        port: cmdOpts.port !== undefined ? parseInt(cmdOpts.port, 10) : undefined,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'DAEMON_RESTART_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

daemonCmd
  .command('status')
  .description('Show daemon status')
  .option('--json', 'Output as JSON')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await daemonStatus(ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'DAEMON_STATUS_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

daemonCmd
  .command('logs')
  .description('Show daemon logs')
  .option('--tail <n>', 'Number of lines to show', '50')
  .option('--follow', 'Follow log output (tail -f)')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .action(async (cmdOpts: { tail?: string; follow?: boolean; json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    if (cmdOpts.follow && cmdOpts.json) {
      ctx.ui.json({ ok: false, error: 'INCOMPATIBLE_FLAGS', message: '--follow and --json cannot be combined; use --tail N with --json for batch output' });
      ctx.ui.error('--follow and --json cannot be combined', 'follow mode streams continuously; use --tail N with --json for batch output');
      process.exit(1);
    }
    try {
      await daemonLogs(ctx, {
        tail: cmdOpts.tail !== undefined ? parseInt(cmdOpts.tail, 10) : undefined,
        follow: cmdOpts.follow,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'DAEMON_LOGS_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

daemonCmd
  .command('reprobe')
  .description('Force reprobe all transport paths')
  .option('--json', 'Output as JSON')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const portFile = path.join(os.homedir(), '.prismer', 'daemon.port');
      let port = DEFAULT_DAEMON_PORT;
      try {
        const raw = fs.readFileSync(portFile, 'utf-8').trim();
        port = parseInt(raw, 10);
      } catch {
        // Use default
      }

      const r = await httpPost(`http://127.0.0.1:${port}/api/v1/transport/reprobe`);
      if (r.status === 200) {
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: true, port });
        } else {
          ctx.ui.ok('Reprobe initiated', 'Run "prismer status" to see results');
        }
      } else {
        // Include the daemon response body in the cause so the user can see
        // why the reprobe was rejected without having to open daemon logs.
        const bodySnippet = r.body ? r.body.slice(0, 200).replace(/\s+/g, ' ').trim() : '';
        const cause = bodySnippet
          ? `daemon returned HTTP ${r.status} — ${bodySnippet}`
          : `daemon returned HTTP ${r.status}`;
        const fix = 'prismer daemon restart (or: prismer daemon logs --tail 50)';
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: false, error: 'REPROBE_FAILED', message: `HTTP ${r.status}`, cause, fix });
        } else {
          ctx.ui.error('Failed to initiate reprobe', cause, fix);
        }
        process.exit(1);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'REPROBE_ERROR', message: e.message });
      } else {
        ctx.ui.error('Failed to initiate reprobe', e.message, 'prismer daemon restart (or: prismer daemon logs --tail 50)');
      }
      process.exit(1);
    }
  });

// ============================================================
// agent — T13 implementation
// ============================================================

const agentCmd = program
  .command('agent')
  .description('Manage installed agents');

agentCmd
  .command('list')
  .description('List installed agents and their status')
  .option('--json', 'Output as JSON')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await listAgents(ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

agentCmd
  .command('install <name>')
  .description('Install an agent adapter')
  .option('--non-interactive', 'Skip all prompts (CI mode)')
  .option('--accept-defaults', 'Accept all defaults without prompting')
  .option('--source <source>', 'Install source: cdn | mirror | npm')
  .option('--force', 'Re-install even if the agent is already installed')
  .option('--install-agent', 'Install the upstream agent CLI first when it is missing')
  .option('--skip-verify', 'Skip Ed25519 signature verification (offline / development)')
  .option('--json', 'Output as single-line JSON')
  .action(async (name: string, cmdOpts: {
    nonInteractive?: boolean;
    acceptDefaults?: boolean;
    source?: 'cdn' | 'mirror' | 'npm';
    force?: boolean;
    installAgent?: boolean;
    skipVerify?: boolean;
    json?: boolean;
  }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const result = await installAgent(ctx, {
        name,
        nonInteractive: cmdOpts.nonInteractive,
        acceptDefaults: cmdOpts.acceptDefaults,
        source: cmdOpts.source,
        force: cmdOpts.force,
        installAgentBinary: cmdOpts.installAgent,
        skipVerify: cmdOpts.skipVerify,
      });
      if (cmdOpts.json) {
        ctx.ui.json({ ok: result.ok, agent: result.agent, version: result.version, source: result.source, checks: result.checks, alreadyInstalled: result.alreadyInstalled ?? false, signatureVerified: result.signatureVerified });
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'INSTALL_FAILED', message: e.message });
      if (!e.message.includes('CLI not found on PATH') && !e.message.includes('Incompatible version')) {
        ctx.ui.error(e.message);
      }
      process.exit(1);
    }
  });

agentCmd
  .command('doctor [name]')
  .description('Diagnose agent health and configuration')
  .option('--json', 'Output as JSON')
  .action(async (name: string | undefined) => {
    const ctx = await createCliContext({ argv: process.argv });
    if (!name) {
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'MISSING_AGENT_NAME', message: 'agent doctor requires an agent name' });
      } else {
        ctx.ui.header('Prismer Agent Doctor');
        ctx.ui.blank();
        ctx.ui.line('  Choose an agent to diagnose:');
        ctx.ui.blank();
        ctx.ui.line('    prismer agent doctor claude-code');
        ctx.ui.line('    prismer agent doctor codex');
        ctx.ui.line('    prismer agent doctor hermes');
        ctx.ui.line('    prismer agent doctor openclaw');
        ctx.ui.blank();
        ctx.ui.tip('prismer agent list');
      }
      process.exitCode = 1;
      return;
    }
    try {
      await doctorAgent(ctx, name);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

// Canonical per §15.6 command naming: use `remove`, not `uninstall`.
// `uninstall` is kept as a hidden alias for muscle-memory back-compat and
// should be removed in v2.0 alongside the rest of the Round 1 CLI cleanup.
async function runAgentRemove(name: string, cmdOpts: { yes?: boolean; json?: boolean }): Promise<void> {
  const ctx = await createCliContext({ argv: process.argv });
  try {
    const result = await uninstallAgent(ctx, name, { yes: cmdOpts.yes });
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({
        ok: true,
        agent: result.agent,
        hooksRestored: result.hooksRestored,
        sandboxRemoved: result.sandboxRemoved,
      });
    }
  } catch (err) {
    if (err instanceof UninstallCancelledError) {
      // User declined the prompt — not a failure in pretty mode.
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'CANCELLED', message: 'User declined confirmation' });
        process.exitCode = 1;
        process.exit(1);
      }
      // Pretty mode: cancellation message already printed; exit cleanly.
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    const isConfirmRequired = (e as NodeJS.ErrnoException).code === 'CONFIRMATION_REQUIRED';
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({
        ok: false,
        error: isConfirmRequired ? 'CONFIRMATION_REQUIRED' : 'REMOVE_FAILED',
        message: e.message,
      });
    } else {
      ctx.ui.error(e.message);
    }
    process.exitCode = 1;
    process.exit(1);
  }
}

agentCmd
  .command('remove <name>')
  .description('Remove an agent adapter and restore previous hook config')
  .option('--yes', 'Skip confirmation prompt')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .action(runAgentRemove);

agentCmd
  .command('publish <name>')
  .description('Publish an installed agent to cloud (visible from mobile)')
  .option('--json', 'Output as JSON')
  .action(async (name: string, cmdOpts: { json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const identity = await resolveDaemonIdentity();
      const result = await publishAgent(name, {
        apiKey: identity.apiKey,
        daemonId: identity.daemonId,
        cloudApiBase: identity.cloudApiBase,
      });
      if (cmdOpts.json) {
        ctx.ui.json(result);
      } else if (result.ok) {
        ctx.ui.ok(
          result.alreadyPublished ? 'Re-published' : 'Published',
          `${name} → cloud agent ${result.cloudAgentId}`,
        );
      } else {
        ctx.ui.fail('Publish failed', result.error);
        process.exit(1);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'PUBLISH_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

agentCmd
  .command('unpublish <name>')
  .description('Stop publishing an agent (cloud sees it offline within 90s)')
  .option('--json', 'Output as JSON')
  .action(async (name: string, cmdOpts: { json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const identity = await resolveDaemonIdentity();
      const result = await unpublishAgent(name, {
        apiKey: identity.apiKey,
        daemonId: identity.daemonId,
        cloudApiBase: identity.cloudApiBase,
      });
      if (cmdOpts.json) {
        ctx.ui.json(result);
      } else if (result.ok) {
        if (result.cloudAgentId === null) {
          ctx.ui.ok('Not published', `${name} was not in the published registry — nothing to do`);
        } else {
          ctx.ui.ok(
            'Unpublished',
            result.cloudDeleteOk
              ? `${name} (cloud DELETE ok)`
              : `${name} (cloud DELETE failed; sweep job will mark offline within 90s)`,
          );
        }
      } else {
        ctx.ui.fail('Unpublish failed', result.error);
        process.exit(1);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'UNPUBLISH_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

agentCmd
  .command('uninstall <name>', { hidden: true })
  .description('[deprecated alias] use `prismer agent remove`')
  .option('--yes', 'Skip confirmation prompt')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .action(async (name: string, cmdOpts: { yes?: boolean; json?: boolean }) => {
    // Emit deprecation notice to stderr so scripts piping stdout aren't broken.
    if (!process.argv.includes('--json') && !process.argv.includes('--quiet')) {
      process.stderr.write('Note: `agent uninstall` is deprecated; use `agent remove`.\n');
    }
    await runAgentRemove(name, cmdOpts);
  });

agentCmd
  .command('update <name>')
  .description('Update an installed agent adapter (runs install with --force)')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .option('--source <source>', 'Pack source: cdn | mirror | npm')
  .option('--skip-verify', 'Skip Ed25519 signature verification (development)')
  .action(async (name: string, cmdOpts: { source?: string; skipVerify?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const result = await installAgent(ctx, {
        name,
        force: true, // key difference: update replaces regardless of current version
        nonInteractive: true,
        acceptDefaults: true,
        source: cmdOpts.source as 'cdn' | 'mirror' | 'npm' | undefined,
        skipVerify: cmdOpts.skipVerify,
      });
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({
          ok: true,
          agent: result.agent,
          version: result.version,
          source: result.source,
          checks: result.checks,
          signatureVerified: result.signatureVerified,
          updated: true,
        });
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'UPDATE_FAILED', message: e.message });
      } else {
        ctx.ui.error(e.message);
      }
      process.exitCode = 1;
      process.exit(1);
    }
  });

agentCmd
  .command('repair <name>')
  .description('Repair agent installation or configuration')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .action(async (name: string) => {
    const ctx = await createCliContext({ argv: process.argv });
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, agent: name, repairsApplied: [] });
    } else {
      ctx.ui.secondary('(repair implementation pending T14)');
    }
  });

agentCmd
  .command('pack')
  .description('Manage release packs from packs.prismer.cloud')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, note: 'Use prismer agent pack list/search to interact with pack registry' });
    } else {
      ctx.ui.line('Pack Registry v0.1.0 (npm mirror mode)');
      ctx.ui.line('');
      ctx.ui.line('Commands:');
      ctx.ui.line('  prismer agent pack list      List available packs');
      ctx.ui.line('  prismer agent pack search    Search packs by keyword');
      ctx.ui.line('  prismer agent pack verify    Verify pack signature');
      ctx.ui.tip('Full packs.prismer.cloud infrastructure coming in v1.9.1');
    }
  });

const packCmd = program
  .command('pack')
  .description('Manage release packs from packs.prismer.cloud');

packCmd
  .command('list')
  .description('List available packs from pack registry')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const { fetchPackIndex } = await import('../agents/pack-registry.js');
      const index = await fetchPackIndex(fetch);

      if (cmdOpts.json) {
        ctx.ui.json(index);
      } else {
        ctx.ui.header(`Pack Registry (${index.packs.length} packs)`);
        ctx.ui.blank();
        for (const pack of index.packs) {
          ctx.ui.line(`${pack.displayName} ${pack.version}`);
          ctx.ui.secondary(`  Adapter: ${pack.adapter}`);
          ctx.ui.secondary(`  Tiers: ${pack.tiersSupported.map(t => `L${t}`).join(', ')}`);
          ctx.ui.secondary(`  Size: ${pack.size}`);
          ctx.ui.line('');
        }
        ctx.ui.success(`Fetched ${index.packs.length} packs from registry`);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

packCmd
  .command('search <query>')
  .description('Search packs by keyword')
  .option('--json', 'Output as JSON')
  .action(async (query: string, cmdOpts: { json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const { searchPacks } = await import('../agents/pack-registry.js');
      const results = await searchPacks(query, fetch);

      if (cmdOpts.json) {
        ctx.ui.json({ query, results });
      } else {
        ctx.ui.header(`Search results for "${query}" (${results.length} packs)`);
        ctx.ui.blank();
        if (results.length === 0) {
          ctx.ui.secondary('No packs found. Try: claude-code, codex, openclaw, hermes');
        } else {
          for (const pack of results) {
            ctx.ui.line(`${pack.displayName} ${pack.version}`);
            ctx.ui.secondary(`  ${pack.description}`);
            ctx.ui.secondary(`  Tiers: ${pack.tiersSupported.map(t => `L${t}`).join(', ')}`);
            ctx.ui.line('');
          }
          ctx.ui.success(`Found ${results.length} packs`);
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

packCmd
  .command('verify <name> <signature>')
  .description('Verify pack signature')
  .option('--json', 'Output as JSON')
  .action(async (name: string, signature: string, cmdOpts: { json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const { verifyPackByName } = await import('../agents/pack-registry.js');
      const result = await verifyPackByName(name, signature, fetch);

      if (cmdOpts.json) {
        ctx.ui.json(result);
      } else if (result.valid) {
        ctx.ui.success(`Signature verified for ${name}`);
        if (result.pack) {
          ctx.ui.secondary(`  Version: ${result.pack.version}`);
          ctx.ui.secondary(`  Adapter: ${result.pack.adapter}`);
        }
      } else {
        ctx.ui.fail(`Signature verification failed for ${name}`);
        ctx.ui.secondary('This may indicate a tampered pack or incorrect signature');
        ctx.ui.tip('Report: https://github.com/Prismer-AI/PrismerCloud/security/advisories');
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

// ============================================================
// migrate-secrets subcommand
// ============================================================

program
  .command('migrate-secrets')
  .description('Scan config.toml for plaintext secrets and migrate them to the keychain')
  .option('--dry-run', 'Preview changes without modifying files or keychain', false)
  .option('--config <path>', 'Path to config.toml (default: ~/.prismer/config.toml)')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .action(async (cmdOpts: { dryRun: boolean; config?: string }) => {
    const isJson = ui.mode === 'json';

    if (!isJson) {
      ui.header('Prismer Migrate Secrets');
      ui.blank();
    }

    let keychain: Keychain;
    try {
      keychain = new Keychain();
      await keychain.backend();
    } catch (err) {
      if (err instanceof NoKeychainBackendError) {
        if (isJson) {
          ui.json({ ok: false, error: 'NO_KEYCHAIN_BACKEND', message: 'no system keychain or PRISMER_MASTER_PASSPHRASE configured' });
        } else {
          ui.error(
            'No keychain backend available',
            'no system keychain or PRISMER_MASTER_PASSPHRASE configured',
            'Set PRISMER_MASTER_PASSPHRASE to enable the encrypted-file backend',
          );
        }
        process.exitCode = 1;
        process.exit(1);
      }
      if (err instanceof KeychainAccessDeniedError) {
        if (isJson) {
          ui.json({
            ok: false,
            error: 'KEYCHAIN_ACCESS_DENIED',
            backend: err.backend,
            message: err.message,
          });
        } else {
          ui.error(
            'Keychain access denied',
            'macOS Keychain requires user approval for "Prismer Runtime"',
            'Open System Settings → Privacy → Keychain, grant access to Prismer',
          );
          ui.secondary('Alt: PRISMER_MASTER_PASSPHRASE=<your-passphrase> prismer migrate-secrets');
        }
        process.exitCode = 1;
        process.exit(1);
      }
      throw err;
    }

    const steps: MigrateStep[] = [];

    const result = await migrateSecrets({
      configPath: cmdOpts.config,
      keychain,
      dryRun: cmdOpts.dryRun,
      onStep: (step) => {
        steps.push(step);
        if (!isJson) {
          switch (step.level) {
            case 'ok':
              ui.ok(step.message);
              break;
            case 'warn':
              ui.pending(step.message);
              break;
            case 'error':
              ui.fail(step.message);
              break;
            default:
              if (step.message.startsWith('Skipping')) {
                ui.notInstalled(step.message);
              }
              break;
          }
        }
      },
    });

    if (isJson) {
      if (result.errors.length > 0) {
        ui.json({
          ok: false,
          error: 'MIGRATE_ERRORS',
          message: `${result.errors.length} error(s) during migration`,
          migrated: result.migrated.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          details: result,
        });
        process.exitCode = 1;
      } else {
        ui.json({
          ok: true,
          migrated: result.migrated.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          details: result,
        });
      }
      return;
    }

    ui.blank();

    const summary = `Done. ${result.migrated.length} migrated, ${result.skipped.length} skipped, ${result.errors.length} errors.`;
    ui.line(summary);

    if (cmdOpts.dryRun) {
      ui.secondary('(dry-run — no changes made)');
    }

    if (result.errors.length > 0) {
      process.exit(1);
    }
  });

// ============================================================
// pair — T16 device pairing subcommands
// ============================================================

const pairCmd = program
  .command('pair')
  .description('Manage device pairing');

pairCmd
  .command('show')
  .alias('generate') // Alias for clarity: prismer pair generate = prismer pair show
  .description('Generate a pairing QR code (5-minute TTL)')
  .option('--ttl <seconds>', 'Pairing code TTL in seconds', '300')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { ttl?: string }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await pairShow(ctx, {
        ttlSec: cmdOpts.ttl !== undefined ? parseInt(cmdOpts.ttl, 10) : undefined,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });


pairCmd
  .command('list')
  .alias('devices') // Alias for clarity: prismer pair devices = prismer pair list
  .description('List all paired devices')
  .option('--json', 'Output as JSON')
  .action(async () => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await pairList(ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'COMMAND_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

pairCmd
  .command('revoke <deviceId>')
  .description('Revoke a paired device by ID')
  .option('--yes', 'Skip confirmation prompt')
  .option('--json', 'emit machine-readable single-line JSON instead of pretty output')
  .action(async (deviceId: string) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await pairRevoke(ctx, deviceId);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'REVOKE_FAILED', message: e.message });
      } else {
        ctx.ui.error(e.message);
      }
      process.exitCode = 1;
      process.exit(1);
    }
  });

// ============================================================
// migrate — T16 v1.8 → v1.9 upgrade flow
// ============================================================

const migrateCmd = program
  .command('migrate')
  .description('Migrate v1.8.x installation to v1.9.0 (API key → keychain, hooks → daemon)')
  .option('--dry-run', 'Preview changes without modifying files or keychain')
  .option('--yes', 'Skip all confirmation prompts (non-interactive)')
  .option('--json', 'Output result as single-line JSON')
  .action(async (cmdOpts: { dryRun?: boolean; yes?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      await migrateCommand(ctx, {
        dryRun: cmdOpts.dryRun,
        yes: cmdOpts.yes,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'MIGRATE_FAILED', message: e.message });
      ctx.ui.error(e.message);
      process.exit(1);
    }
  });

migrateCmd
  .command('luminclaw-memory')
  .description('Import luminclaw local memory to Memory Gateway')
  .option('--workspace <path>', 'Workspace directory (default: current directory)')
  .option('--dry-run', 'Preview migration without importing')
  .option('--force', 'Force migration even if MIGRATED.md exists')
  .option('--json', 'Output result as single-line JSON')
  .action(async (cmdOpts: { workspace?: string; dryRun?: boolean; force?: boolean; json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });
    try {
      const { migrateLuminclawMemoryCommand } = await import('../commands/migrate-luminclaw-memory.js');
      const exitCode = await migrateLuminclawMemoryCommand(ctx, {
        workspace: cmdOpts.workspace,
        dryRun: cmdOpts.dryRun,
        force: cmdOpts.force,
      });
      if (cmdOpts.json) {
        ctx.ui.json({ exitCode });
      }
      process.exit(exitCode);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'MIGRATE_FAILED', message: e.message });
      ctx.ui.error(e.message, e.stack);
      process.exit(1);
    }
  });

// ============================================================
// task — Task Router CLI (v1.9.0)
// ============================================================

registerTaskCommands(program, ui);

// ============================================================
// memory — Memory Gateway CLI (v1.9.0)
// ============================================================

registerMemoryCommands(program, ui);

// ============================================================
// memory key-backup / key-recover / key-fingerprint — Shamir recovery (v1.9.0)
// Mounts as subcommands of `memory` (must run AFTER registerMemoryCommands)
// ============================================================

registerMemoryKeyCommands(program, ui);

// ============================================================
// evolution — Evolution Gateway CLI (v1.9.0)
// ============================================================

registerEvolutionCommands(program, ui);

// ============================================================
// session — PARA L8 session trace operations (v1.9.0)
// ============================================================

const sessionCmd = program
  .command('session')
  .description('Session trace operations (PARA L8)');

sessionCmd
  .command('export <sessionId>')
  .description('Export a session trace (copies ~/.prismer/trace/<id>.jsonl.zst)')
  .option('--out <path>', 'Destination path (default: ./<sessionId>.jsonl.zst)')
  .option('--data-dir <path>', 'Override daemon data dir (default: ~/.prismer)')
  .action(async (sessionId: string, cmdOpts: { out?: string; dataDir?: string }) => {
    // --json is a global flag consumed by applyCommonFlags (strips it from argv
    // before commander sees it). Read it via ctx.ui.mode, not via a subcommand
    // .option('--json') — that option would never fire.
    const ctx = await createCliContext({ argv: process.argv });
    const isJson = ctx.ui.mode === 'json';
    try {
      // Sanitize sessionId before letting it touch any path. The core TraceWriter
      // enforces SESSION_ID_PATTERN; the CLI must enforce the SAME policy so
      // `session export ../../etc/passwd` can't walk out of the trace dir via
      // the default `--out` placeholder or the sourcePath join.
      if (!isValidSessionId(sessionId)) {
        const detail = "must match /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/ and cannot contain '..'";
        if (isJson) {
          ctx.ui.json({ ok: false, error: 'INVALID_SESSION_ID', sessionId, detail });
        } else {
          ctx.ui.error(`Invalid sessionId: ${sessionId}`, detail);
        }
        process.exitCode = 1;
        return;
      }

      const dataDir = cmdOpts.dataDir ?? path.join(os.homedir(), '.prismer');
      const sourcePath = path.join(dataDir, 'trace', `${sessionId}.jsonl.zst`);
      // --out is explicitly chosen by the user — we don't rewrite that. But
      // the default path DOES interpolate sessionId, so it needed the check above.
      const destPath = cmdOpts.out ?? path.join(process.cwd(), `${sessionId}.jsonl.zst`);

      if (!fs.existsSync(sourcePath)) {
        if (isJson) {
          ctx.ui.json({ ok: false, error: 'NO_TRACE', message: `No trace found for session ${sessionId}`, sourcePath });
        } else {
          ctx.ui.error(
            `No trace found for session ${sessionId}`,
            sourcePath,
            'Adapters must emit agent.session.started/ended with sessionId; verify the daemon is running and the adapter is at L8.',
          );
        }
        process.exitCode = 1;
        return;
      }

      if (fs.existsSync(destPath)) {
        if (isJson) {
          ctx.ui.json({ ok: false, error: 'DEST_EXISTS', message: `Destination exists: ${destPath}` });
        } else {
          ctx.ui.error(
            `Destination exists: ${destPath}`,
            undefined,
            `Remove it first: rm ${destPath}`,
          );
        }
        process.exitCode = 1;
        return;
      }

      fs.copyFileSync(sourcePath, destPath);
      const { size } = fs.statSync(destPath);

      if (isJson) {
        ctx.ui.json({ ok: true, sessionId, source: sourcePath, destination: destPath, bytes: size });
      } else {
        ctx.ui.ok(`Exported trace for session ${sessionId}`, `${destPath} (${size} bytes, zstd)`);
        ctx.ui.secondary(`Source: ${sourcePath}`);
        ctx.ui.tip('Decompress with: zstd -d <file>.jsonl.zst (each line is one JSON event envelope)');
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (isJson) {
        ctx.ui.json({ ok: false, error: 'EXPORT_FAILED', message: e.message });
      } else {
        ctx.ui.error(e.message);
      }
      process.exitCode = 1;
    }
  });

// ============================================================
// para-events — PARA Events CLI (v1.9.0)
// ============================================================

program
  .command('events')
  .description('Inspect PARA events from adapters')
  .option('--agent-id <id>', 'Filter by agent ID')
  .option('--session-id <id>', 'Filter by session ID')
  .option('--family <family>', 'Filter by event family (lifecycle|turn_llm|message_io|tool|permission|task|memory_context|environment|notification|skill)')
  .option('--type <type>', 'Filter by specific event type (e.g., agent.turn.step)')
  .option('--limit <n>', 'Limit number of results (default: 100)')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: {
    agentId?: string;
    sessionId?: string;
    family?: string;
    type?: string;
    limit?: string;
    json?: boolean;
  }) => {
    const ctx = await createCliContext({ argv: process.argv });

    try {
      // Call PARA events API
      const apiBase = process.env['PRISMER_API_BASE'] || 'https://prismer.cloud/api/im';
      const url = `${apiBase}/para/events${buildQueryString({
        agentId: cmdOpts.agentId,
        sessionId: cmdOpts.sessionId,
        eventFamily: cmdOpts.family,
        eventType: cmdOpts.type,
        limit: cmdOpts.limit ?? '100',
      })}`;

      const eventsConfig = await loadConfig().catch(() => ({} as { apiKey?: string }));
      const eventsHeaders: Record<string, string> = {};
      if (eventsConfig.apiKey) eventsHeaders['Authorization'] = `Bearer ${eventsConfig.apiKey}`;

      const raw = await httpGet(url, 3000, eventsHeaders);

      // v1.9.0: cloud `/api/im/para/events` is scheduled for v1.9.1 (see
      // Release-190.md). A 404 here is expected — emit a clean envelope
      // pointing at the local events.jsonl stream instead of the generic
      // "Invalid JSON response" parse error.
      if (raw.status === 404) {
        if (cmdOpts.json) {
          ctx.ui.json({
            ok: false,
            error: 'EVENTS_ENDPOINT_NOT_AVAILABLE',
            message: 'PARA events endpoint not yet available',
            cause: 'cloud returns 404 (scheduled for v1.9.1)',
            fix: 'Inspect the local stream directly: tail -f ~/.prismer/para/events.jsonl',
          });
        } else {
          ctx.ui.error(
            'PARA events endpoint not yet available',
            'cloud returns 404 (scheduled for v1.9.1)',
            'Inspect the local stream directly: tail -f ~/.prismer/para/events.jsonl',
          );
        }
        process.exitCode = 1;
        return;
      }

      const response = parseApiEnvelope<
        Array<{ timestamp: string; type: string; eventFamily: string; agentId: string; sessionId: string }>
      >(raw);

      if (cmdOpts.json) {
        ctx.ui.json(response);
      } else {
        if (response.success && response.data) {
          ctx.ui.line('PARA Events:');
          for (const event of response.data) {
            ctx.ui.secondary(`  [${event.timestamp}] ${event.type} (${event.eventFamily})`);
            ctx.ui.line(`    Agent: ${event.agentId}, Session: ${event.sessionId}`);
            ctx.ui.blank();
          }
          ctx.ui.success(`Total: ${response.data.length} events`);
        } else {
          ctx.ui.error(response.error?.message || 'Unknown error');
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.error(e.message);
      process.exitCode = 1;
      process.exit(1);
    }
  });

program
  .command('events:stats')
  .description('Get PARA event statistics')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { json?: boolean }) => {
    const ctx = await createCliContext({ argv: process.argv });

    try {
      const apiBase = process.env['PRISMER_API_BASE'] || 'https://prismer.cloud/api/im';
      const url = `${apiBase}/para/events/stats`;

      const statsConfig = await loadConfig().catch(() => ({} as { apiKey?: string }));
      const statsHeaders: Record<string, string> = {};
      if (statsConfig.apiKey) statsHeaders['Authorization'] = `Bearer ${statsConfig.apiKey}`;

      const raw = await httpGet(url, 3000, statsHeaders);

      if (raw.status === 404) {
        if (cmdOpts.json) {
          ctx.ui.json({
            ok: false,
            error: 'EVENTS_ENDPOINT_NOT_AVAILABLE',
            message: 'PARA events endpoint not yet available',
            cause: 'cloud returns 404 (scheduled for v1.9.1)',
            fix: 'Inspect the local stream directly: tail -f ~/.prismer/para/events.jsonl',
          });
        } else {
          ctx.ui.error(
            'PARA events endpoint not yet available',
            'cloud returns 404 (scheduled for v1.9.1)',
            'Inspect the local stream directly: tail -f ~/.prismer/para/events.jsonl',
          );
        }
        process.exitCode = 1;
        return;
      }

      const response = parseApiEnvelope<{ byFamily: Record<string, number>; total: number }>(raw);

      if (cmdOpts.json) {
        ctx.ui.json(response);
      } else {
        if (response.success && response.data) {
          ctx.ui.line('PARA Event Statistics:');
          ctx.ui.line('By Family:');
          for (const [family, count] of Object.entries(response.data.byFamily)) {
            ctx.ui.secondary(`  ${family}: ${count} events`);
          }
          ctx.ui.line(`Total: ${response.data.total} events`);
        } else {
          ctx.ui.error(response.error?.message || 'Unknown error');
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.error(e.message);
      process.exitCode = 1;
      process.exit(1);
    }
  });

// ============================================================
// permissions-debug — Permission Debug CLI (v1.9.0)
// ============================================================

program
  .command('permissions:test')
  .description('Test permission evaluation with mock operations')
  .option('--agent-id <id>', 'Agent ID to test (default: self)')
  .option('--capability <cap>', 'Specific capability to test')
  .option('--tier <n>', 'Tier level to simulate (1-7)')
  .option('--verbose', 'Show detailed evaluation steps')
  .action(async (cmdOpts: {
    agentId?: string;
    capability?: string;
    tier?: string;
    verbose?: boolean;
  }) => {
    const ctx = await createCliContext({ argv: process.argv });

    try {
      const testAgentId = cmdOpts.agentId || 'self';
      const testTier = cmdOpts.tier ? parseInt(cmdOpts.tier) : 1;

      ctx.ui.line('Permission Debug Test');
      ctx.ui.secondary(`Agent: ${testAgentId}, Tier: L${testTier}`);
      if (cmdOpts.capability) {
        ctx.ui.secondary(`Capability: ${cmdOpts.capability}`);
      }

      // Define test operations based on tier
      const operations: { capability: string; riskLevel: number; allowed: boolean }[] = [];

      // L1: Read-only operations
      if (testTier === 1) {
        operations.push({ capability: 'shell.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'fs.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'message.read', riskLevel: 10, allowed: true });
      }
      // L2: Add Message I/O
      else if (testTier === 2) {
        operations.push({ capability: 'shell.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'fs.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'message.write', riskLevel: 25, allowed: true });
        operations.push({ capability: 'message.read', riskLevel: 10, allowed: true });
      }
      // L3: Add Tool execution
      else if (testTier === 3) {
        operations.push({ capability: 'shell.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'fs.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'shell.execute', riskLevel: 50, allowed: true });
        operations.push({ capability: 'fs.write', riskLevel: 25, allowed: true });
        operations.push({ capability: 'message.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'message.write', riskLevel: 25, allowed: true });
      }
      // L4+: All operations allowed
      else {
        operations.push({ capability: 'shell.read', riskLevel: 10, allowed: true });
        operations.push({ capability: 'shell.execute', riskLevel: 50, allowed: true });
        operations.push({ capability: 'fs.write', riskLevel: 25, allowed: true });
        operations.push({ capability: 'fs.delete', riskLevel: 50, allowed: true });
        operations.push({ capability: 'message.write', riskLevel: 25, allowed: true });
      }

      // Filter by specific capability if requested
      const testOps = cmdOpts.capability
        ? operations.filter(op => op.capability === cmdOpts.capability)
        : operations;

      if (cmdOpts.verbose) {
        ctx.ui.blank();
        ctx.ui.line('Permission Evaluation:');
        for (const op of testOps) {
          const status = op.allowed ? '✅ ALLOWED' : '❌ BLOCKED';
          const riskLevel = op.riskLevel < 25 ? 'LOW' : op.riskLevel < 50 ? 'MEDIUM' : 'HIGH';
          ctx.ui.secondary(`  ${op.capability} (Risk: ${riskLevel}): ${status}`);
        }
      } else {
        const allowedCount = testOps.filter(op => op.allowed).length;
        const blockedCount = testOps.filter(op => !op.allowed).length;
        ctx.ui.line(`Results: ${allowedCount} allowed, ${blockedCount} blocked`);
      }

      ctx.ui.blank();
      ctx.ui.line('Legend:');
      ctx.ui.secondary('  L1: Read-only (no shell.execute, fs.write, fs.delete)');
      ctx.ui.secondary('  L2: Read + Message I/O');
      ctx.ui.secondary('  L3: Read + Tool execution');
      ctx.ui.secondary('  L4+: All operations allowed');
      ctx.ui.blank();
      ctx.ui.success('Permission debug test completed');
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.error(e.message);
      process.exitCode = 1;
      process.exit(1);
    }
  });

// ============================================================
// tier-set — Tier Management CLI (v1.9.0)
// ============================================================

// Classify a tier API failure (bare 401, missing auth header, etc.) into the
// standard { title, cause, fix } envelope so callers get the same shape as
// `agent install` / `pair show`. Without this, the old handler shows the raw
// cloud response verbatim (e.g. "Authorization header is required"), which is
// accurate but gives the user nothing actionable.
function classifyTierError(status: number, rawMessage: string | undefined): { cause: string; fix: string } {
  const msg = rawMessage && rawMessage.trim().length > 0 ? rawMessage : `HTTP ${status}`;
  if (status === 401 || status === 403 || /unauthorized|authorization/i.test(msg)) {
    return {
      cause: `cloud returned ${status} (${msg})`,
      fix: 'Re-run prismer setup, or check that ~/.prismer/config.toml contains a valid api_key',
    };
  }
  if (status === 404) {
    return {
      cause: `cloud returned 404 (${msg})`,
      fix: 'Verify the agent ID with: prismer agent list',
    };
  }
  return {
    cause: `cloud returned ${status} — ${msg}`,
    fix: 'Check cloud status, or run: prismer daemon logs --tail 50',
  };
}

program
  .command('tier:set <agent-id> <tier>')
  .description('Set agent tier level (1-7)')
  .action(async (agentId: string, tier: string) => {
    const ctx = await createCliContext({ argv: process.argv });

    try {
      const tierNum = parseInt(tier);
      if (isNaN(tierNum) || tierNum < 1 || tierNum > 7) {
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: false, error: 'INVALID_TIER', message: 'tier must be 1-7' });
        } else {
          ctx.ui.error('Invalid tier level', `got "${tier}"`, 'Tier must be an integer 1-7');
        }
        process.exitCode = 1;
        process.exit(1);
      }

      const apiBase = process.env['PRISMER_API_BASE'] || 'https://prismer.cloud/api/im';
      const url = `${apiBase}/agents/${agentId}/tier`;

      const cfg = await loadConfig().catch(() => ({} as { apiKey?: string }));
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

      const raw = await httpPost(url, { tier: tierNum }, 5000, headers);
      const response = parseApiEnvelope(raw);

      if (response.success) {
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: true, agentId, tier: tierNum });
        } else {
          ctx.ui.success(`Agent ${agentId} tier updated to L${tierNum}`);
        }
      } else {
        const envelope = classifyTierError(raw.status, response.error?.message);
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: false, error: 'TIER_SET_FAILED', message: response.error?.message ?? `HTTP ${raw.status}`, cause: envelope.cause, fix: envelope.fix });
        } else {
          ctx.ui.error('Failed to update tier', envelope.cause, envelope.fix);
        }
        process.exit(1);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'TIER_SET_ERROR', message: e.message });
      } else {
        ctx.ui.error('Failed to update tier', e.message, 'Check network connectivity and cloud base URL (PRISMER_API_BASE)');
      }
      process.exitCode = 1;
      process.exit(1);
    }
  });

program
  .command('tier:get <agent-id>')
  .description('Get agent current tier level')
  .action(async (agentId: string) => {
    const ctx = await createCliContext({ argv: process.argv });

    try {
      const apiBase = process.env['PRISMER_API_BASE'] || 'https://prismer.cloud/api/im';
      const url = `${apiBase}/agents/${agentId}/tier`;

      const cfg = await loadConfig().catch(() => ({} as { apiKey?: string }));
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

      const raw = await httpGet(url, 5000, headers);
      const response = parseApiEnvelope<{ tier: number; tiersSupported?: number[] }>(raw);

      if (response.success && response.data) {
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: true, agentId, tier: response.data.tier, tiersSupported: response.data.tiersSupported ?? null });
        } else {
          ctx.ui.success(`Agent ${agentId} current tier: L${response.data.tier}`);
          ctx.ui.secondary(`Supported: ${response.data.tiersSupported?.join(', ') || 'N/A'}`);
        }
      } else {
        const envelope = classifyTierError(raw.status, response.error?.message);
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: false, error: 'TIER_GET_FAILED', message: response.error?.message ?? `HTTP ${raw.status}`, cause: envelope.cause, fix: envelope.fix });
        } else {
          ctx.ui.error('Failed to get tier', envelope.cause, envelope.fix);
        }
        process.exit(1);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'TIER_GET_ERROR', message: e.message });
      } else {
        ctx.ui.error('Failed to get tier', e.message, 'Check network connectivity and cloud base URL (PRISMER_API_BASE)');
      }
      process.exitCode = 1;
      process.exit(1);
    }
  });

// Helper function to build query string
function buildQueryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (entries.length === 0) return '';
  return '?' + entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

// ============================================================
// SDK CLI commands (v1.9.0 A.1 merge) — `register`, `config`, `token`,
// IM/context/evolve/task/memory/skill/files/workspace/security/community/remote,
// and the top-level shortcuts (send/load/search/parse/recall/discover).
// skipConflicting=true drops the SDK's own setup/init/status/daemon because
// those names live on the runtime program above.
// ============================================================
const sdkCliRegister = loadSdkCliRegister();
if (sdkCliRegister) {
  try {
    sdkCliRegister(program, { skipConflicting: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prismer] warning: SDK commands failed to register (${msg})\n`);
  }
} else {
  // Best-effort path — only log when the user asked for it so default runs
  // stay quiet on machines where only @prismer/runtime is installed.
  if (process.env['PRISMER_DEBUG_SDK_LOAD'] === '1') {
    process.stderr.write('[prismer] debug: @prismer/sdk/cli not resolvable from runtime node_modules\n');
  }
}

program.parseAsync(commanderArgv);
