// `prismer setup` — canonical runtime onboarding.
//
// Interactive users run `prismer setup` with no secret on the command line:
// the CLI opens the cloud setup page, receives a one-shot API key through a
// loopback callback, writes config.toml, and can start the daemon. Direct
// key/token paths remain for tests, CI, and release harnesses.

import { Command } from 'commander';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { configExists, loadConfig, resolvePaths, saveConfig } from '../../config.js';
import { newDaemonId } from '../../daemon-id.js';
import { pair } from '../../pair.js';
import {
  DEFAULT_CLOUD_BASE_URL,
  exitWithError,
  normalizeCloudUrl,
  ok,
  printBanner,
  printJson,
  runAction,
  tip,
  warn,
} from '../util.js';
import { getUI } from '../ui.js';

interface SetupOptions {
  cloud?: string;
  deviceName?: string;
  force?: boolean;
  pair?: boolean;
  browser?: boolean;
  token?: string;
  asUser?: string;
  start?: boolean;
  check?: boolean;
  json?: boolean;
}

export function buildSetupCommand(): Command {
  return new Command('setup')
    .description('Set up this local runtime and bind it to Prismer Cloud')
    .argument('[api-key]', 'Prismer daemon API key; primarily for manual recovery and automation')
    .option(
      '--cloud <url>',
      `Cloud base URL (default: ${DEFAULT_CLOUD_BASE_URL}; bare host:port is auto-prefixed http://)`,
      (v) => v,
    )
    .option('--device-name <name>', 'Friendly daemon/device name')
    .option('--force', 'Overwrite existing config.toml')
    .option('--pair', 'Legacy QR approval setup path; prefer plain `prismer setup`')
    .option('--no-browser', 'Do not open browser when no API key/token is supplied')
    .option('--token <jwt>', 'Automation/test only: user JWT; setup will mint a daemon API key from /api/keys')
    .option('--as-user <email>', 'LOCAL_ONLY legacy QR bypass user (requires --pair and LOCAL_ONLY=1)')
    .option('--start', 'Start daemon after setup (default)')
    .option('--no-start', 'Do not start daemon after setup')
    .option('--check', 'Validate inputs and print what would happen without writing config.toml')
    .option('--json', 'Output JSON only')
    .action(runAction<[string | undefined, SetupOptions]>(async (apiKeyArg, opts) => {
      const paths = resolvePaths();
      const rawCloud = opts.cloud ?? process.env.PRISMER_BASE_URL ?? DEFAULT_CLOUD_BASE_URL;
      let cloudBaseUrl: string;
      try {
        cloudBaseUrl = normalizeCloudUrl(rawCloud);
      } catch (err) {
        exitWithError((err as Error).message, { code: 'invalid_cloud_url' });
      }
      // `--force` without a positional key means "re-bind interactively".
      // Do not silently consume a stale shell PRISMER_API_KEY and skip the
      // browser login flow the user explicitly asked to redo.
      let apiKey = apiKeyArg ?? (opts.force ? undefined : process.env.PRISMER_API_KEY);
      const authToken = opts.token ?? process.env.PRISMER_AUTH_TOKEN;

      if (!opts.json) {
        printBanner({ compact: true });
        getUI().header(opts.check ? 'Setup (check)' : 'Setup');
        getUI().blank();
      }
      const shouldStart = opts.start !== false;

      if (opts.pair || opts.asUser) {
        if (!opts.json) warn('Legacy pair setup path', 'plain `prismer setup --start` is the canonical runtime binding flow');
        if (opts.asUser && process.env.LOCAL_ONLY !== '1') {
          exitWithError('--as-user requires LOCAL_ONLY=1.', { code: 'local_only_required' });
        }
        if (opts.check) {
          if (opts.json) {
            printJson({ ok: true, check: true, mode: 'pair', cloud: cloudBaseUrl, config: paths.configFile });
          } else {
            ok('Would pair via QR/LOCAL_ONLY flow', `cloud=${cloudBaseUrl}`);
            ok('Would write', paths.configFile);
          }
          return;
        }
        const result = await pair({
          cloudBaseUrl,
          deviceName: opts.deviceName ?? hostname(),
          force: opts.force,
          paths,
          asUserEmail: opts.asUser,
        });
        if (opts.json) {
          printJson({ ok: true, paired: true, cloud: cloudBaseUrl, config: paths.configFile, daemonId: result.config.daemon_id });
        } else {
          ok('Paired', paths.configFile);
          ok('Cloud', cloudBaseUrl);
          ok('Daemon id', result.config.daemon_id);
        }
      } else {
        if (!apiKey && authToken && !opts.check) {
          apiKey = await mintDaemonApiKey({
            cloudBaseUrl,
            token: authToken,
            deviceName: opts.deviceName ?? hostname(),
          });
        }
        if (!apiKey && !authToken && !opts.check && opts.browser !== false) {
          apiKey = await runBrowserSetup({
            cloudBaseUrl,
            deviceName: opts.deviceName ?? hostname(),
            json: Boolean(opts.json),
          });
        }
        if (!apiKey && !opts.check) {
          exitWithError(
            'No API key supplied. Use plain `prismer setup` for browser login, `prismer setup sk-...`, or automation-only `prismer setup --token <jwt>`.',
            { code: 'api_key_required' },
          );
        }
        if (apiKey && !/^sk-prismer-/.test(apiKey)) {
          exitWithError('Invalid API key format. Expected key starting with sk-prismer-.', {
            code: 'invalid_api_key_format',
          });
        }
        if (opts.check) {
          if (opts.json) {
            printJson({
              ok: true,
              check: true,
              mode: apiKey ? 'apikey' : authToken ? 'token-mint' : opts.browser === false ? 'apikey-required' : 'browser',
              cloud: cloudBaseUrl,
              config: paths.configFile,
              willStartDaemon: shouldStart,
              wouldOverwrite: configExists(paths),
              hasApiKey: Boolean(apiKey),
              hasAuthToken: Boolean(authToken),
            });
          } else {
            ok('Cloud', cloudBaseUrl);
            ok('Config target', paths.configFile);
            if (configExists(paths)) warn('Existing config will be overwritten', '(use without --check to apply)');
            ok('API key', apiKey ? 'provided (would be saved)' : authToken ? 'will be minted from --token' : opts.browser === false ? 'missing — would fail' : 'will be created through browser login');
          }
          return;
        }
        if (configExists(paths) && !opts.force) {
          const cfg = loadConfig(paths);
          if (opts.json) {
            printJson({ ok: true, alreadyConfigured: true, config: paths.configFile, daemonId: cfg.daemon_id, daemonStartRequested: shouldStart });
          } else {
            warn('Already configured', paths.configFile);
            // Daemon may have stopped since last setup; user ran `setup` to get
            // the runtime running, so start it regardless of config existence.
            if (shouldStart) {
              startDaemonDetached(paths.root);
              ok('Daemon start requested');
            }
            tip('prismer setup --force <api-key>', 'overwrite config');
          }
          return;
        }
        const previousConfig = configExists(paths) ? loadConfig(paths) : null;
        // F14 (2026-05-20) — pass apiKey to make daemonId stable per
        // (hostname, apiKey). Re-running `prismer setup --force` with the
        // same key now yields the SAME daemonId, so the cloud-side
        // host.declare upsert keys (podName=`daemon:${id.slice(-30)}`)
        // dedupe instead of accumulating IMContainer rows.
        const daemonId =
          previousConfig && previousConfig.api_key === apiKey && previousConfig.cloud_api_base === cloudBaseUrl
            ? previousConfig.daemon_id
            : newDaemonId({ apiKey: apiKey ?? undefined });
        const config = {
          api_key: apiKey!,
          cloud_api_base: cloudBaseUrl,
          daemon_id: daemonId,
        };
        if (previousConfig && shouldArchiveLocalDb(previousConfig, config)) {
          archiveLocalDb(paths.localDb);
        }
        saveConfig(config, paths);
        if (opts.json) {
          printJson({ ok: true, configured: true, cloud: cloudBaseUrl, config: paths.configFile, daemonId: config.daemon_id, daemonStartRequested: shouldStart });
        } else {
          ok('API key saved', paths.configFile);
          ok('Cloud', cloudBaseUrl);
          ok('Daemon id', config.daemon_id);
        }
      }

      if (shouldStart && !opts.check) {
        startDaemonDetached(paths.root);
        if (!opts.json) ok('Daemon start requested');
      }

      if (!opts.json) {
        getUI().blank();
        getUI().header('Next steps');
        tip('prismer status', 'verify setup + cloud reachability');
        tip('prismer adapter list', 'verify claude-code/codex/openclaw/hermes availability');
        tip('prismer agent register --adapter claude-code --display-name "Claude Code"');
        tip('prismer profile create --agent <imUserId> --name default --adapter claude-code --config \'{"cwd":"."}\'');
        tip('prismer task create --agent <imUserId> --prompt "Reply with OK"');
      }
    }, { code: 'setup_failed' }));
}

async function runBrowserSetup(input: {
  cloudBaseUrl: string;
  deviceName: string;
  json: boolean;
}): Promise<string> {
  const state = randomBytes(18).toString('base64url');
  const server = createServer();
  const apiKeyPromise = waitForSetupCallback(server, state);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    closeServer(server);
    throw new Error('setup: failed to allocate loopback callback port');
  }

  const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
  const setupUrl = new URL('/setup', input.cloudBaseUrl.replace(/\/$/, ''));
  setupUrl.searchParams.set('utm_source', 'runtime_setup');
  setupUrl.searchParams.set('device', input.deviceName);
  setupUrl.searchParams.set('callback', callbackUrl);
  setupUrl.searchParams.set('state', state);

  if (!input.json) {
    ok('Opening browser for login', setupUrl.toString());
    tip('If the browser did not open, paste the URL above into your browser.');
  }
  openBrowser(setupUrl.toString());

  try {
    return await withTimeout(apiKeyPromise, 5 * 60_000, 'setup: timed out waiting for browser login');
  } finally {
    closeServer(server);
  }
}

function waitForSetupCallback(server: Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const state = url.searchParams.get('state');
        const key = url.searchParams.get('key');
        const PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prismer Setup</title><style>body{background:#0a0a0a;color:#e5e5e5;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}div{max-width:480px;padding:40px}h1{font-size:28px;margin-bottom:16px}p{font-size:15px;color:#888;line-height:1.6}.check{color:#4ade80;font-size:48px;margin-bottom:16px}.cross{color:#ef4444;font-size:48px;margin-bottom:16px}</style></head><body><div>';
        if (state !== expectedState || !key || !/^sk-prismer-/.test(key)) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`${PAGE}<div class="cross">&#10007;</div><h1>Prismer setup failed</h1><p>Invalid setup callback. You can close this tab and retry.</p></div></body></html>`);
          reject(new Error('setup: invalid browser callback'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`${PAGE}<div class="check">&#10003;</div><h1>Prismer setup complete</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`);
        resolve(key);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // The URL has already been printed. Some minimal Linux shells simply lack
    // xdg-open; terminal paste remains a valid path.
  });
  child.unref();
}

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {
    /* ignore */
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function startDaemonDetached(home: string): void {
  const child = spawn(process.execPath, [process.argv[1]!, 'daemon', 'start'], {
    env: { ...process.env, PRISMER_HOME: home },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

function shouldArchiveLocalDb(previous: { api_key: string; cloud_api_base: string; daemon_id: string }, next: { api_key: string; cloud_api_base: string; daemon_id: string }): boolean {
  return previous.api_key !== next.api_key || previous.cloud_api_base !== next.cloud_api_base || previous.daemon_id !== next.daemon_id;
}

function archiveLocalDb(localDbPath: string): void {
  if (!existsSync(localDbPath)) return;
  const archived = `${localDbPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  renameSync(localDbPath, archived);
}

async function mintDaemonApiKey(input: {
  cloudBaseUrl: string;
  token: string;
  deviceName: string;
}): Promise<string> {
  const label = `Daemon: ${input.deviceName} ${new Date().toISOString().slice(0, 10)}`;
  const res = await fetch(`${input.cloudBaseUrl.replace(/\/$/, '')}/api/keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label }),
  });
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: { key?: string }; error?: { message?: string } }
    | null;
  if (!res.ok || !body?.success || !body.data?.key) {
    throw new Error(body?.error?.message ?? `API key mint failed (${res.status})`);
  }
  return body.data.key;
}
