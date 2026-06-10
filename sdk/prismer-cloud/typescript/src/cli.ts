/**
 * Prismer CLI — modular CLI for Prismer Cloud SDK.
 *
 * Top-level shortcuts: send, load, search, parse, recall, discover, skill
 * Grouped namespaces:  im, context, evolve, task, memory, file, workspace, security, identity
 * Utilities:           init, register, status, config, token
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// @ts-ignore — no type declarations for @iarna/toml
import * as TOML from '@iarna/toml';
import { PrismerClient } from './index';
// CLI UI helpers are mirrored from `@prismer/runtime` (bin `prismer`) so the
// `cloud` CLI shares the same icons, colors, banner, table layout, and
// spinner. See sdk/prismer-cloud/typescript/src/cli-ui.ts for the sync
// contract. The legacy `./ui` module remains for un-migrated callsites
// (clack-based prompts, QR rendering) — `selectAgent`, `confirm`, `renderQR`
// stay there because they have no runtime equivalent.
import {
  displayBanner,
  success,
  errorLine as uiError,
  warn as uiWarn,
  info as uiInfo,
  dim,
  withSpinner,
  table,
  keyValue,
} from './cli-ui';

// Read version from package.json
let cliVersion = '1.7.2';
try {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  cliVersion = pkg.version || cliVersion;
} catch {}

// ============================================================================
// Config helpers
// ============================================================================

// PRISMER_HOME — parity with @prismer/runtime (`sdk/prismer-cloud/runtime/
// src/config.ts:63`). The env var is the **prismer root** itself, NOT a fake
// home with `.prismer` appended; that way `prismer setup` and `cloud setup`
// write to the same file (`$PRISMER_HOME/config.toml` or
// `$HOME/.prismer/config.toml` by default) and the two CLIs share auth state.
const CONFIG_DIR = process.env.PRISMER_HOME
  ? path.resolve(process.env.PRISMER_HOME)
  : path.join(os.homedir(), '.prismer');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml');

interface PrismerCLIConfig {
  default?: {
    api_key?: string;
    environment?: string;
    base_url?: string;
  };
  auth?: {
    im_token?: string;
    im_user_id?: string;
    im_username?: string;
    im_token_expires?: string;
  };
  [key: string]: unknown;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig(): PrismerCLIConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = TOML.parse(raw) as unknown as PrismerCLIConfig & {
    api_key?: string;
    cloud_api_base?: string;
    base_url?: string;
    environment?: string;
  };
  // Tolerate @prismer/runtime's flat-key schema (`prismer setup` writes
  // `api_key = "..."` + `cloud_api_base = "..."` at the top level). Promote
  // them into the SDK's `[default]` section so a single `prismer setup` is
  // enough to authenticate both CLIs. SDK's own `cloud setup` continues to
  // write `[default]` directly — coexists in the same TOML file.
  const flatApiKey = parsed.api_key;
  const flatBaseUrl = parsed.cloud_api_base ?? parsed.base_url;
  const flatEnv = parsed.environment;
  if (flatApiKey || flatBaseUrl || flatEnv) {
    parsed.default = {
      ...(parsed.default ?? {}),
      // Explicit [default].api_key wins; flat is the fallback (runtime-written).
      api_key: parsed.default?.api_key ?? flatApiKey,
      base_url: parsed.default?.base_url ?? flatBaseUrl,
      environment: parsed.default?.environment ?? flatEnv,
    };
  }
  return parsed;
}

function writeConfig(config: PrismerCLIConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, TOML.stringify(config as any), { encoding: 'utf-8', mode: 0o600 });
}

function setNestedValue(obj: Record<string, any>, dotPath: string, value: string): void {
  const parts = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === undefined || typeof current[key] !== 'object') current[key] = {};
    current = current[key] as Record<string, any>;
  }
  current[parts[parts.length - 1]] = value;
}

// ============================================================================
// Client factories (shared with command modules)
// ============================================================================

export function getIMClient(): PrismerClient {
  const cfg = readConfig();
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  // 2026-05-29 — agent identity injection.
  //
  // The agent identity is established at adapter-service-spawn time. A
  // runtime hosts N agents, each backed by its own per-agent service:
  // hermes spawns `hermes -p <profile> gateway run` per agent (one
  // process, one port); openclaw the same; any future adapter follows
  // the same per-profile model. When the daemon spawns the service it
  // injects PRISMER_AGENT_USERNAME / PRISMER_AGENT_IM_USER_ID into the
  // service's env, and that env propagates to every tool the service
  // launches — including the `cloud` CLI invocations the LLM emits.
  //
  // So at CLI startup we just read process.env. No cwd walking, no
  // per-task marker file, no global daemon env mixing identities. If
  // the var is absent we fall back to caller-key identity (legacy
  // behavior, also correct for human users running `cloud` directly).
  const agentUsername = process.env.PRISMER_AGENT_USERNAME;
  const imAgentOpt = agentUsername ? { imAgent: agentUsername } : {};
  // release202/09 §3.6 B — defense-in-depth workspace hint. The daemon injects
  // PRISMER_WORKSPACE_ID into the agent service env alongside
  // PRISMER_AGENT_USERNAME; sending it as X-IM-Workspace lets the cloud
  // agent-proxy reach its workspace-scoped fallback when the owner
  // userId↔numericId bridge can't resolve the agent. Absent → no header →
  // unchanged behavior (same opt-in shape as imAgent).
  const workspaceId = process.env.PRISMER_WORKSPACE_ID;
  const imWorkspaceOpt = workspaceId ? { imWorkspace: workspaceId } : {};
  // Prefer IM-JWT when present (issued by `cloud register` / `cloud setup --agent`).
  // Fall back to API key — verified 2026-05-19 that the cloud accepts API-key
  // bearer for `/api/im/*` routes (the regression run did a direct curl POST
  // /api/im/tasks with `sk-prismer-live-…` and got back a real task cuid).
  // Without this fallback the SDK CLI required dual-credential setup just to
  // make a task, which contradicted both the SKILL.md flow and the cookbook.
  const imToken = cfg?.auth?.im_token;
  if (imToken) {
    return new PrismerClient({
      apiKey: imToken,
      environment: env as any,
      ...(baseUrl ? { baseUrl } : {}),
      ...imAgentOpt,
      ...imWorkspaceOpt,
    });
  }
  const apiKey = cfg?.default?.api_key;
  if (!apiKey) {
    uiError('No credentials. Run "cloud setup" first (or "cloud setup --agent" / "cloud register <username>" for IM-JWT path).');
    process.exit(1);
  }
  return new PrismerClient({
    apiKey,
    environment: env as any,
    ...(baseUrl ? { baseUrl } : {}),
    ...imAgentOpt,
    ...imWorkspaceOpt,
  });
}

export function getAPIClient(): PrismerClient {
  const cfg = readConfig();
  const apiKey = cfg?.default?.api_key;
  if (!apiKey) { uiError('No API key. Run "cloud setup" to sign in and get your key.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  // 2026-05-29 — same X-IM-Agent injection as getIMClient. Commands wired
  // via getAPIClient (cloud task, cloud memory, cloud workspace, ...) hit
  // /api/im/* too — middleware splits senderId by header, so when an
  // agent shells out from its sandbox the action is properly authored by
  // the agent rather than the API-key owner. Human users running `cloud`
  // directly have no PRISMER_AGENT_USERNAME → no header → legacy behavior.
  const agentUsername = process.env.PRISMER_AGENT_USERNAME;
  const imAgentOpt = agentUsername ? { imAgent: agentUsername } : {};
  // release202/09 §3.6 B — same optional X-IM-Workspace hint as getIMClient.
  const workspaceId = process.env.PRISMER_WORKSPACE_ID;
  const imWorkspaceOpt = workspaceId ? { imWorkspace: workspaceId } : {};
  return new PrismerClient({ apiKey, environment: env as any, ...(baseUrl ? { baseUrl } : {}), ...imAgentOpt, ...imWorkspaceOpt });
}

// ============================================================================
// CLI program
// ============================================================================

const program = new Command();
program.name('cloud').description('Prismer Cloud SDK CLI').version(cliVersion);

// ============================================================================
// Utility commands: setup, init (alias), register, status, config, token
// ============================================================================

// ============================================================================
// Shared helpers for setup flows
// ============================================================================

async function verifyAndSaveKey(config: PrismerCLIConfig, apiKey: string): Promise<void> {
  if (!apiKey) {
    uiError('No key provided.');
    process.exit(1);
  }
  if (!apiKey.startsWith('sk-prismer-')) {
    uiError('Invalid key format. API keys start with sk-prismer-');
    dim('  Get your key at: https://prismer.cloud/setup');
    process.exit(1);
  }

  const baseUrl = config.default?.base_url || 'https://prismer.cloud';
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) {
      uiError('API key is invalid or expired.');
      dim('  Get a new key at: https://prismer.cloud/setup');
      process.exit(1);
    }
    success('API key verified');
  } catch (err: any) {
    uiWarn(`Could not verify key (${err.message}). Saving anyway.`);
  }

  if (!config.default) config.default = {};
  config.default.api_key = apiKey;
  if (!config.default.environment) config.default.environment = 'production';
  writeConfig(config);
  console.log('');
  success('Saved to ~/.prismer/config.toml');
  uiInfo('You can now use: CLI commands, MCP tools, Claude Code plugin, and all SDKs.');

  // Auto-install daemon service so evolution sync runs persistently
  try {
    installDaemonService();
  } catch {
    dim('Daemon auto-start setup skipped. Run manually: cloud daemon install');
  }
}

function openBrowser(url: string): void {
  const { execFile } = require('child_process');
  if (process.platform === 'darwin') {
    execFile('open', [url], (err: Error | null) => { if (err) console.warn('Could not open browser. Please open the URL above manually.'); });
  } else if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], (err: Error | null) => { if (err) console.warn('Could not open browser. Please open the URL above manually.'); });
  } else {
    execFile('xdg-open', [url], (err: Error | null) => { if (err) console.warn('Could not open browser. Please open the URL above manually.'); });
  }
}

// ============================================================================
// cloud setup — unified initialization (browser auto / agent auto-register / manual / key arg)
// ============================================================================

async function runSetup(opts: { manual?: boolean; agent?: boolean; force?: boolean }, apiKey?: string): Promise<void> {
  const config = readConfig();
  if (!config.default) config.default = {};
  const baseUrl = config.default.base_url || 'https://prismer.cloud';

  // ── Already configured check ──
  if (!opts.force && config.default.api_key?.startsWith('sk-prismer-')) {
    const masked = config.default.api_key.slice(0, 12) + '...' + config.default.api_key.slice(-4);
    success(`Already configured: ${masked}`);
    console.log('');
    dim('  To reconfigure, run: cloud setup --force');
    dim('  To check status:     cloud status');
    return;
  }

  // ── Path 1: Direct key argument (e.g. cloud setup sk-prismer-xxx / cloud init sk-prismer-xxx) ──
  if (apiKey) {
    await verifyAndSaveKey(config, apiKey);
    return;
  }

  // ── Path 2: Agent auto-register (non-interactive, for CI/scripts) ──
  if (opts.agent) {
    if (!opts.force && config.auth?.im_token) {
      success('Already registered as agent (IM token exists).');
      dim('  For API key access, run: cloud setup');
      return;
    }

    const username = `agent-${Date.now().toString(36)}`;
    try {
      const res = await fetch(`${baseUrl}/api/im/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName: username, type: 'agent' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Registration failed');

      if (!config.auth) config.auth = {};
      config.auth.im_token = data.data?.token;
      config.auth.im_user_id = data.data?.imUserId || data.data?.userId;
      config.auth.im_username = data.data?.username || username;
      writeConfig(config);

      success('Agent registered with free credits');
      keyValue({
        'Username': config.auth.im_username || '',
        'User ID': config.auth.im_user_id || '',
      });
      console.log('');
      uiInfo('For full API access, sign in: cloud setup');
    } catch (err: any) {
      uiError(`Agent registration failed: ${err.message}`);
      dim('  Try signing in instead: cloud setup');
      process.exit(1);
    }
    return;
  }

  // ── Path 3: Manual mode — open browser + paste key ──
  if (opts.manual) {
    const setupUrl = `${baseUrl}/setup?utm_source=cli&utm_medium=manual`;
    uiInfo('Opening browser to sign in...');
    dim(`  ${setupUrl}`);
    console.log('');
    openBrowser(setupUrl);

    uiInfo('After signing in, copy the API key from the page and paste it below.');
    console.log('');

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Paste your API key: ', (key: string) => {
      rl.close();
      verifyAndSaveKey(config, key.trim()).catch((err: Error) => {
        uiError(`Setup failed: ${err.message}`);
        process.exit(1);
      });
    });
    return;
  }

  // ── Path 4: Auto mode (default) — localhost callback server ──
  const http = require('http');
  const crypto = require('crypto');

  const state = crypto.randomBytes(16).toString('hex');
  let resolved = false;

  const server = http.createServer((req: any, res: any) => {
    const url = new URL(req.url, `http://localhost`);

    if (url.pathname === '/callback') {
      const key = url.searchParams.get('key');
      const returnedState = url.searchParams.get('state');

      res.writeHead(200, { 'Content-Type': 'text/html' });

      if (!key || !returnedState || returnedState !== state) {
        res.end('<html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Setup failed</h2><p>Invalid or missing parameters. Please try again.</p></body></html>');
        return;
      }

      if (!key.startsWith('sk-prismer-')) {
        res.end('<html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Invalid key</h2><p>The key format is unexpected. Please try again.</p></body></html>');
        return;
      }

      res.end('<html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Done!</h2><p>API key received. You can close this tab.</p></body></html>');

      resolved = true;
      verifyAndSaveKey(config, key)
        .then(() => { server.close(); process.exit(0); })
        .catch((err: Error) => { console.error(`Setup failed: ${err.message}`); server.close(); process.exit(1); });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const callbackUrl = `http://127.0.0.1:${port}/callback`;
    const setupUrl = `${baseUrl}/setup?callback=${encodeURIComponent(callbackUrl)}&state=${state}&utm_source=cli&utm_medium=auto`;

    uiInfo('Opening browser to sign in...');
    console.log('');

    openBrowser(setupUrl);

    uiInfo('Waiting for authentication...');
    dim('  (If the browser didn\'t open, visit this URL manually:)');
    dim(`  ${setupUrl}`);
    console.log('');

    setTimeout(() => {
      if (!resolved) {
        uiError('Timed out waiting for authentication (5 min).');
        console.log('');
        dim('  Alternatives:');
        dim('    cloud setup --manual    Paste key manually');
        dim('    cloud setup --agent     Register as agent (free credits, no browser)');
        server.close();
        process.exit(1);
      }
    }, 5 * 60 * 1000);
  });
}

// ── cloud setup ──
program
  .command('setup [api-key]')
  .description('Set up Prismer — sign in via browser, register as agent, or provide your API key')
  .option('--manual', 'Paste API key manually instead of browser auto-flow')
  .option('--agent', 'Register as agent with free credits (no browser, for CI/scripts)')
  .option('--force', 'Reconfigure even if already set up')
  .action(async (apiKey: string | undefined, opts: { manual?: boolean; agent?: boolean; force?: boolean }) => {
    await runSetup(opts, apiKey);
  });

// ── cloud init — backward-compatible alias for setup ──
program
  .command('init [api-key]')
  .description('Alias for "cloud setup" (deprecated, use setup instead)')
  .option('--manual', 'Paste API key manually')
  .option('--agent', 'Register as agent with free credits')
  .option('--force', 'Reconfigure even if already set up')
  .action(async (apiKey: string | undefined, opts: { manual?: boolean; agent?: boolean; force?: boolean }) => {
    uiWarn('"cloud init" is deprecated. Use "cloud setup" instead.');
    console.log('');
    await runSetup(opts, apiKey);
  });

program
  .command('register <username>')
  .description('Register an IM identity and store the token')
  .option('--type <type>', 'Identity type: agent or human', 'agent')
  .option('--display-name <name>', 'Display name')
  .option('--agent-type <agentType>', 'Agent type: assistant, specialist, orchestrator, tool, bot')
  .option('--capabilities <caps>', 'Comma-separated capabilities')
  .option('--endpoint <url>', 'Webhook endpoint URL')
  .option('--webhook-secret <secret>', 'Webhook HMAC secret')
  .action(async (username: string, opts: any) => {
    const config = readConfig();
    const apiKey = config.default?.api_key;
    if (!apiKey) { uiError('No API key. Run "cloud setup" first.'); process.exit(1); }

    const client = new PrismerClient({
      apiKey,
      environment: (config.default?.environment as 'production') || 'production',
      baseUrl: config.default?.base_url || undefined,
    });

    const registerOpts: Record<string, any> = {
      type: opts.type as 'agent' | 'human',
      username,
      displayName: opts.displayName || username,
    };
    if (opts.agentType) registerOpts.agentType = opts.agentType;
    if (opts.capabilities) registerOpts.capabilities = opts.capabilities.split(',').map((c: string) => c.trim());
    if (opts.endpoint) registerOpts.endpoint = opts.endpoint;
    if (opts.webhookSecret) registerOpts.webhookSecret = opts.webhookSecret;

    try {
      const result = await client.im.account.register(registerOpts as any);
      if (!result.ok || !result.data) {
        uiError(`Registration failed: ${result.error?.message || 'Unknown error'}`);
        process.exit(1);
      }
      const data = result.data;
      if (!config.auth) config.auth = {};
      config.auth.im_token = data.token;
      config.auth.im_user_id = data.imUserId;
      config.auth.im_username = data.username;
      config.auth.im_token_expires = data.expiresIn;
      writeConfig(config);
      success('Registration successful!');
      keyValue({
        'User ID': data.imUserId,
        'Username': data.username,
        'Display': data.displayName,
        'Role': data.role,
        'New': String(data.isNew),
      });
      dim('  Token stored in ~/.prismer/config.toml');
    } catch (err) {
      uiError(`Registration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current config and live info')
  .action(async () => {
    const config = readConfig();
    uiInfo('Prismer Status');
    console.log('');

    const apiKey = config.default?.api_key;
    const maskedKey = apiKey
      ? (apiKey.length > 16 ? apiKey.slice(0, 12) + '...' + apiKey.slice(-4) : '***')
      : '(not set)';

    keyValue({
      'API Key': maskedKey,
      'Environment': config.default?.environment || '(not set)',
      'Base URL': config.default?.base_url || '(default)',
    });
    console.log('');

    const token = config.auth?.im_token;
    if (token) {
      let tokenStatus = 'set (expiry unknown)';
      const expires = config.auth?.im_token_expires;
      if (expires) {
        const expiresDate = new Date(expires);
        if (!isNaN(expiresDate.getTime())) {
          tokenStatus = expiresDate <= new Date() ? 'EXPIRED' : `valid (expires ${expiresDate.toISOString()})`;
        } else {
          tokenStatus = `set (expires in ${expires})`;
        }
      }

      keyValue({
        'IM User ID': config.auth?.im_user_id || '(unknown)',
        'IM Username': config.auth?.im_username || '(unknown)',
        'IM Token': tokenStatus,
      });

      // Live info
      console.log('');
      const me = await withSpinner('Fetching live info', async () => {
        const client = new PrismerClient({
          apiKey: token,
          environment: (config.default?.environment as 'production') || 'production',
          baseUrl: config.default?.base_url || undefined,
        });
        return client.im.account.me();
      }).catch((err) => {
        uiWarn(`Could not fetch live info: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      if (me && me.ok && me.data) {
        keyValue({
          'Display': me.data.user.displayName,
          'Role': me.data.user.role,
          'Credits': String(me.data.credits.balance),
          'Messages': String(me.data.stats.messagesSent),
          'Unread': String(me.data.stats.unreadCount),
        });
      } else if (me) {
        uiWarn(`Could not fetch live info: ${me.error?.message || 'unknown error'}`);
      }
    } else {
      dim('  IM Token: (not registered)');
    }
  });

// --- config ---
const configCmd = program.command('config').description('Manage config file');

configCmd.command('show').description('Print config file').action(() => {
  if (!fs.existsSync(CONFIG_PATH)) {
    uiWarn('No config file. Run "cloud setup" to create one.');
    return;
  }
  console.log(fs.readFileSync(CONFIG_PATH, 'utf-8'));
});

configCmd.command('set <key> <value>').description('Set a config value (e.g. default.base_url)').action((key: string, value: string) => {
  const config = readConfig();
  setNestedValue(config as Record<string, any>, key, value);
  writeConfig(config);
  success(`Set ${key} = ${value}`);
});

// --- token ---
const tokenCmd = program.command('token').description('Token management');

tokenCmd.command('refresh').description('Refresh IM JWT token').option('--json', 'JSON output').action(async (opts: any) => {
  const client = getIMClient();
  const res = await client.im.account.refreshToken();
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.ok) { uiError(`Token refresh failed: ${JSON.stringify(res.error)}`); process.exit(1); }
  const data = res.data as any;
  // Update stored token
  const config = readConfig();
  if (!config.auth) config.auth = {};
  if (data?.token) {
    config.auth.im_token = data.token;
    if (data.expiresIn) config.auth.im_token_expires = data.expiresIn;
    writeConfig(config);
    success('Token refreshed and saved.');
  } else {
    uiInfo('Token refreshed (no new token in response).');
  }
});

// ============================================================================
// Register grouped command modules
// ============================================================================

import { register as registerIM } from './commands/im';
import { register as registerContext } from './commands/context';
import { register as registerEvolve } from './commands/evolve';
import { register as registerTask } from './commands/task';
import { register as registerMemory } from './commands/memory';
import { register as registerSkill } from './commands/skill';
import { register as registerSkillDraft } from './commands/skill-draft';
import { register as registerCodeGrep } from './commands/code-grep';
import { register as registerServiceIntrospect } from './commands/service-introspect';
import { register as registerFiles } from './commands/files';
import { register as registerWorkspace } from './commands/workspace';
import { register as registerProject } from './commands/project';
import { register as registerSecurity } from './commands/security';
import { register as registerCommunity } from './commands/community';
import { register as registerAsset } from './commands/asset';
import { register as registerApproval } from './commands/approval';
import { register as registerAgent } from './commands/agent';
import { register as registerMetric, runEmit as runMetricEmit } from './commands/metric';
import { startDaemon, stopDaemon, daemonStatus, installDaemonService, uninstallDaemonService } from './daemon';
import { detectDeliverProxy, proxyDeliver } from './commands/deliver-proxy';

registerIM(program, getIMClient, getAPIClient);
registerContext(program, getIMClient, getAPIClient);
registerEvolve(program, getIMClient, getAPIClient);
registerTask(program, getIMClient, getAPIClient);
registerMemory(program, getIMClient, getAPIClient);
registerSkill(program, getIMClient, getAPIClient);
// release201/07 skill-authoring engine: `cloud skill draft *` lives under the
// `skill` command registered above; registerSkillDraft attaches subcommands.
registerSkillDraft(program, getIMClient, getAPIClient);
registerCodeGrep(program, getIMClient, getAPIClient);
registerServiceIntrospect(program, getIMClient, getAPIClient);
registerFiles(program, getIMClient, getAPIClient);
registerWorkspace(program, getIMClient, getAPIClient);
registerProject(program, getIMClient, getAPIClient);
registerSecurity(program, getIMClient, getAPIClient);
registerCommunity(program, getIMClient, getAPIClient);
registerAsset(program, getIMClient, getAPIClient);
registerApproval(program, getIMClient, getAPIClient);
registerAgent(program, getIMClient, getAPIClient);
registerMetric(program, getIMClient, getAPIClient);

// ============================================================================
// Top-level shortcuts (zero-nesting for high-frequency ops)
// ============================================================================

// cloud send <user-id> "message"
program
  .command('send')
  .description('Send a direct message (shortcut for: im send)')
  .argument('<user-id-or-username>', 'Target user/agent IM user ID (or username with --by-username)')
  .argument('<message>', 'Message content')
  .option('-t, --type <type>', 'Message type: text, markdown, code, etc.', 'text')
  .option('--reply-to <id>', 'Reply to a message ID')
  .option('--conversation-id <id>', 'Pin message to a specific conversation/session')
  .option('--asset-id <id>', 'Attach a previously uploaded asset (treats type as file)')
  .option('--by-username', 'Treat the first argument as a username; resolve to imUserId first')
  .option('--json', 'JSON output')
  .action(async (target: string, message: string, opts: any) => {
    const client = getIMClient();
    let userId = target;
    if (opts.byUsername) {
      // Resolve username → imUserId via /api/im/discover
      const discoverRes = await client.im.contacts.discover();
      if (!discoverRes.ok || !Array.isArray(discoverRes.data)) {
        uiError(`Could not resolve username "${target}" — discover failed.`);
        process.exit(1);
      }
      const needle = target.trim().toLowerCase().replace(/^@/, '');
      const match = (discoverRes.data as any[]).find((u: any) => {
        const vals = [u.username, u.displayName, u.userId].map((v) =>
          typeof v === 'string' ? v.trim().toLowerCase() : '',
        );
        return vals.includes(needle);
      });
      if (!match?.userId) {
        uiError(`Could not resolve username "${target}" to an IM user.`);
        process.exit(1);
      }
      userId = match.userId;
    }

    const sendOpts: Record<string, any> = {};
    if (opts.type && opts.type !== 'text') sendOpts.type = opts.type;
    if (opts.replyTo) sendOpts.parentId = opts.replyTo;
    if (opts.assetId) {
      // Default to file kind, allow override via --type
      if (!opts.type || opts.type === 'text') sendOpts.type = 'file';
      sendOpts.attachments = [{ kind: 'asset', assetId: opts.assetId, role: 'attachment' }];
    }
    if (opts.conversationId) {
      sendOpts.metadata = { ...(sendOpts.metadata ?? {}), conversationId: opts.conversationId };
    }
    const res = await withSpinner('Sending message', async () => {
      // When --conversation-id is provided, route via the conversation message
      // endpoint so the server pins to that conversation rather than the
      // implicit direct one between sender + userId.
      if (opts.conversationId) {
        return client.im.messages.send(opts.conversationId, message, sendOpts);
      }
      return client.im.direct.send(userId, message, sendOpts);
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { uiError(`Send failed: ${JSON.stringify(res.error)}`); process.exit(1); }
    success(`Message sent (conversation: ${res.data?.conversationId})`);
  });

// cloud deliver <path>  (release202/09 P2 — 动作 A: attach a file to THIS reply)
//
// Explicit file delivery: after writing a deliverable into the dispatch
// artifacts dir, the agent runs `cloud deliver <abs-path>` to attach it to its
// own reply. The in-container agent proxies to the daemon local-server
// `POST /local/deliver` (mode:'attach'), which uploads with the daemon's
// credential and records the assetId so dispatch-end flushPending rides it on
// `reply.assetIds` (chat attachment + kanban card). Replaces the (now
// gated-off) artifacts-watcher directory auto-scan.
program
  .command('deliver <path>')
  .description('Attach a file you wrote to your current reply (in-container explicit delivery)')
  // release202/09 P5#1 — hermes has no per-dispatch env; the agent copies the
  // ids out of <execution_context> and passes them as flags so the daemon proxy
  // activates. Spawn adapters (claude-code / codex) set the env and need no flags.
  .option('--run-id <id>', 'dispatch run/task id (from <execution_context>; env fallback PRISMER_TASK_ID/RUN_ID)')
  .option('--conversation-id <id>', 'conversation id (from <execution_context>; env fallback PRISMER_CONVERSATION_ID)')
  .option('--daemon-port <port>', 'daemon local-server port (env fallback PRISMER_DAEMON_PORT, default 3210)')
  .option('--json', 'JSON output')
  .action(async (filePath: string, opts: { json?: boolean; runId?: string; conversationId?: string; daemonPort?: string }) => {
    const proxy = detectDeliverProxy({
      runId: opts.runId,
      conversationId: opts.conversationId,
      daemonPort: opts.daemonPort,
    });
    if (!proxy) {
      uiError(
        'cloud deliver only works inside a daemon dispatch (no PRISMER_TASK_ID/PRISMER_RUN_ID, and no --run-id flag). ' +
          'On hermes, pass --run-id <id> (and --conversation-id <id>) copied from <execution_context>. ' +
          'Outside a dispatch, use `cloud file send <conversationId> <path>`.',
      );
      process.exit(1);
    }
    const result = await proxyDeliver(proxy, filePath, 'attach');
    if (!result.ok) {
      uiError(`Delivery failed: ${result.error ?? `daemon returned ${result.status}`}`);
      process.exit(1);
    }
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
    success(`Attached to your reply (assetId: ${result.assetId ?? '-'})`);
  });

// cloud attach <messageId> <path>  (release202/09 P5#3 — 动作 A2: attach a file
// to an ALREADY-SENT message)
//
// Complements `cloud deliver` (A1, which rides the reply that doesn't exist
// yet). Use case: the agent already replied — `cloud send` / `cloud file send`
// returned a messageId — then it produced a file it wants on THAT message. The
// in-container agent proxies to the daemon local-server `POST /local/deliver`
// (mode:'message-attach'), which uploads with the daemon's credential and calls
// the cloud attach route to append the asset to the existing message. The
// conversationId is required (the attach route is conversation-scoped): it comes
// from PRISMER_CONVERSATION_ID (spawn adapters) or `--conversation-id` copied
// from <execution_context> (hermes).
program
  .command('attach <messageId> <path>')
  .description("Attach a file to a message you ALREADY sent (by its messageId)")
  // release202/09 P5#1 parity — hermes has no per-dispatch env; the agent copies
  // the ids out of <execution_context> and passes them as flags so the daemon
  // proxy activates. Spawn adapters (claude-code / codex) set the env and need
  // no flags.
  .option('--run-id <id>', 'dispatch run/task id (from <execution_context>; env fallback PRISMER_TASK_ID/RUN_ID)')
  .option('--conversation-id <id>', 'conversation id of the target message (from <execution_context>; env fallback PRISMER_CONVERSATION_ID)')
  .option('--daemon-port <port>', 'daemon local-server port (env fallback PRISMER_DAEMON_PORT, default 3210)')
  .option('--json', 'JSON output')
  .action(async (
    messageId: string,
    filePath: string,
    opts: { json?: boolean; runId?: string; conversationId?: string; daemonPort?: string },
  ) => {
    const proxy = detectDeliverProxy({
      runId: opts.runId,
      conversationId: opts.conversationId,
      daemonPort: opts.daemonPort,
    });
    if (!proxy) {
      uiError(
        'cloud attach only works inside a daemon dispatch (no PRISMER_TASK_ID/PRISMER_RUN_ID, and no --run-id flag). ' +
          'On hermes, pass --run-id <id> and --conversation-id <id> copied from <execution_context>.',
      );
      process.exit(1);
    }
    const conversationId = (opts.conversationId || proxy.conversationId || '').trim();
    if (!conversationId) {
      uiError(
        'cloud attach needs the conversation id of the target message. ' +
          'Set PRISMER_CONVERSATION_ID or pass --conversation-id <id> (copy it from <execution_context>).',
      );
      process.exit(1);
    }
    const result = await proxyDeliver(proxy, filePath, 'message-attach', conversationId, messageId);
    if (!result.ok) {
      uiError(`Attach failed: ${result.error ?? `daemon returned ${result.status}`}`);
      process.exit(1);
    }
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
    success(`Attached to message ${messageId} (assetId: ${result.assetId ?? '-'})`);
  });

// cloud emit <namespace.name>  (shortcut for: metric emit)
//
// release201/11 §6.2 — short form for SKILL.md authors. Same options as
// `cloud metric emit`.
program
  .command('emit <namespace.name>')
  .description('Emit a metric event (shortcut for: metric emit)')
  .option('--value <value>', 'metric value (number or string)')
  .option('--dim <k=v>', 'dimension (repeatable; workspaceId is required)', (val: string, prev: string[] = []) => {
    prev.push(val);
    return prev;
  })
  .option('--ts <iso>', 'business timestamp in ISO 8601 (defaults to now)')
  .option('--json', 'output raw JSON response')
  .action(async (fqName: string, opts: any) => {
    try {
      await runMetricEmit(fqName, opts, getIMClient);
    } catch (err) {
      uiError(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// cloud load <url...>
program
  .command('load')
  .description('Load URL(s) → compressed HQCC (shortcut for: context load)')
  .argument('<urls...>', 'One or more URLs')
  .option('-f, --format <fmt>', 'Return format: hqcc, raw, both', 'hqcc')
  .option('--json', 'JSON output')
  .action(async (urls: string[], opts: any) => {
    const client = getAPIClient();
    const input = urls.length === 1 ? urls[0] : urls;
    const loadOpts: Record<string, any> = {};
    if (opts.format) loadOpts.return = { format: opts.format };
    const res = await withSpinner(`Loading ${urls.length} URL(s)`, async () => {
      return client.load(input as any, loadOpts);
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { uiError(res.error?.message || 'Load failed'); process.exit(1); }
    const results = res.results || (res.result ? [res.result] : []);
    for (const r of results) {
      keyValue({
        'URL': r.url || '?',
        'Status': r.cached ? 'cached' : 'loaded',
      });
      if (r.hqcc) console.log(`\n--- HQCC ---\n${r.hqcc.substring(0, 2000)}`);
      if (r.raw) console.log(`\n--- Raw ---\n${r.raw.substring(0, 2000)}`);
      console.log('');
    }
  });

// cloud search <query>
program
  .command('search')
  .description('Search web content (shortcut for: context search)')
  .argument('<query>', 'Search query')
  .option('-k, --top-k <n>', 'Number of results', '5')
  .option('--json', 'JSON output')
  .action(async (query: string, opts: any) => {
    const client = getAPIClient();
    const res = await withSpinner(`Searching: ${query}`, async () => {
      return client.search(query, { topK: parseInt(opts.topK || '5') });
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { uiError(res.error?.message || 'Search failed'); process.exit(1); }
    const results = res.results || [];
    if (results.length === 0) { uiWarn('No results.'); return; }
    const rows = results.map((r: any, i: number) => [
      String(i + 1),
      r.url || '(no url)',
      String(r.ranking?.score ?? '-'),
    ]);
    table(['#', 'URL', 'Score'], rows);
    // Show snippets after the table
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.hqcc) {
        console.log('');
        dim(`  ${i + 1}. ${r.hqcc.substring(0, 200)}`);
      }
    }
  });

// cloud parse <url>
program
  .command('parse')
  .description('Parse a document via OCR (shortcut for: parse run)')
  .argument('<url>', 'Document URL')
  .option('-m, --mode <mode>', 'Parse mode: fast, hires, auto', 'fast')
  .option('--async', 'Async mode (returns task ID)')
  .option('--json', 'JSON output')
  .action(async (url: string, opts: any) => {
    const client = getAPIClient();
    const res = await withSpinner(`Parsing: ${url}`, async () => {
      return client.parsePdf(url, opts.mode);
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { uiError(res.error?.message || 'Parse failed'); process.exit(1); }
    if (res.taskId) {
      keyValue({
        'Task ID': res.taskId,
        'Status': res.status || 'processing',
      });
      console.log('');
      dim(`  Check: cloud parse-status ${res.taskId}`);
    } else if (res.document) {
      success('Parse complete');
      const content = res.document.markdown || res.document.text || JSON.stringify(res.document, null, 2);
      console.log(content.substring(0, 5000));
    }
  });

// cloud parse status / result (sub-commands under parse)
const parseCmd = program.commands.find(c => c.name() === 'parse');
if (parseCmd) {
  // We need parse as both a top-level command AND a group. Commander doesn't support that,
  // so we add status/result as separate top-level commands prefixed.
}

// Add parse status and parse result as standalone because parse is already a command with arguments
program
  .command('parse-status')
  .description('Check parse task status')
  .argument('<task-id>', 'Task ID')
  .option('--json', 'JSON output')
  .action(async (taskId: string, opts: any) => {
    const client = getAPIClient();
    const res = await client.parseStatus(taskId);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    keyValue({
      'Task': taskId,
      'Status': res.status || (res.success ? 'complete' : 'unknown'),
    });
  });

program
  .command('parse-result')
  .description('Get parse result')
  .argument('<task-id>', 'Task ID')
  .option('--json', 'JSON output')
  .action(async (taskId: string, opts: any) => {
    const client = getAPIClient();
    const res = await client.parseResult(taskId);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { uiError(res.error?.message || 'Not ready'); process.exit(1); }
    success('Parse result ready');
    const content = res.document?.markdown || res.document?.text || JSON.stringify(res.document, null, 2);
    console.log(content);
  });

// cloud recall <query>
program
  .command('recall')
  .description('Search across memory, cache, and evolution (shortcut for: memory recall)')
  .argument('<query>', 'Search query')
  .option('--scope <scope>', 'Scope: all, memory, cache, evolution', 'all')
  .option('--layer <layer>', 'Alias for --scope (memory | cache | evolution | all)')
  .option('--strategy <strategy>', 'Recall strategy: keyword | llm | hybrid (uses POST /recall when set)')
  .option('-n, --limit <n>', 'Max results', '10')
  .option('--json', 'JSON output')
  .action(async (query: string, opts: any) => {
    const client = getIMClient();
    // Normalize layer → scope (alias). Map `context` → `cache` for cookbook
    // parity (the cloud endpoint exposes the cache layer under `scope=cache`).
    let scope = opts.layer || opts.scope || 'all';
    if (scope === 'context') scope = 'cache';
    const validStrategies = ['keyword', 'llm', 'hybrid'];
    if (opts.strategy && !validStrategies.includes(opts.strategy)) {
      uiError(`Invalid --strategy "${opts.strategy}". Use one of: ${validStrategies.join(', ')}.`);
      process.exit(1);
    }
    const res = await withSpinner(`Recalling: ${query}`, async () => {
      // When a strategy is specified, use POST /recall — it is the only route
      // that honours `strategy` (GET /recall only filters by scope/limit).
      if (opts.strategy) {
        return client.im.request<{ ok: boolean; data?: unknown[]; error?: { message?: string } }>(
          'POST',
          '/api/im/recall',
          {
            query,
            strategy: opts.strategy,
            scope,
            maxResults: opts.limit ? parseInt(opts.limit, 10) : undefined,
          },
        );
      }
      const params: Record<string, string> = { q: query, scope };
      if (opts.limit) params.limit = String(opts.limit);
      return client.im.request<{ ok: boolean; data?: unknown[]; error?: { message?: string } }>(
        'GET',
        '/api/im/recall',
        undefined,
        params,
      );
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { uiError(`Recall failed: ${JSON.stringify(res.error)}`); process.exit(1); }
    const data = res.data || [];
    if (data.length === 0) { uiWarn(`No results for "${query}".`); return; }
    const rows = (data as any[]).map((item: any) => [
      (item.source || item.memoryType || '').toUpperCase(),
      item.title || item.path || '?',
      (item.score || 0).toFixed(2),
    ]);
    table(['Source', 'Title', 'Score'], rows);
    // Show snippets
    for (const item of data as any[]) {
      const snippet = item.snippet || item.content;
      if (snippet) {
        dim(`  ${String(snippet).substring(0, 200)}`);
      }
    }
  });

// cloud discover
program
  .command('discover')
  .description('Discover available agents (shortcut for: im discover)')
  .option('--type <type>', 'Filter by agent type')
  .option('--capability <cap>', 'Filter by capability')
  .option('--online-only', 'Only return agents currently online')
  .option('--json', 'JSON output')
  .action(async (opts: any) => {
    const client = getIMClient();
    const discoverOpts: Record<string, string> = {};
    if (opts.type) discoverOpts.type = opts.type;
    if (opts.capability) discoverOpts.capability = opts.capability;
    // GET /api/im/discover supports both `status=online` (contacts router) and
    // `onlineOnly=true` (agents router). Send both for forward compatibility.
    if (opts.onlineOnly) {
      discoverOpts.status = 'online';
      discoverOpts.onlineOnly = 'true';
    }
    const res = await withSpinner('Discovering agents', async () => {
      return client.im.contacts.discover(discoverOpts);
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { uiError(`Discovery failed: ${JSON.stringify(res.error)}`); process.exit(1); }
    const agents = res.data || [];
    if (agents.length === 0) { uiWarn('No agents found.'); return; }
    const rows = agents.map((a: any) => [
      a.username || '',
      a.agentType || '',
      a.status || '',
      a.displayName || '',
    ]);
    table(['Username', 'Type', 'Status', 'Display Name'], rows);
  });

// ============================================================================
// Daemon command
// ============================================================================

program
  .command('daemon <action>')
  .description('Manage background sync daemon (start|stop|status|install|uninstall)')
  .action(async (action: string) => {
    switch (action) {
      case 'start':
        await startDaemon();
        break;
      case 'stop':
        stopDaemon();
        break;
      case 'status':
        daemonStatus();
        break;
      case 'install':
        installDaemonService();
        break;
      case 'uninstall':
        uninstallDaemonService();
        break;
      default:
        uiError(`Unknown daemon action: ${action}. Use: start, stop, status, install, uninstall`);
        process.exit(1);
    }
  });

// ============================================================================
// Parse and run
// ============================================================================

// Mirror runtime's argv preprocessing — strip --json / --quiet / --no-color /
// --color before commander sees them, and configure the shared UI singleton.
// This gives the `cloud` CLI the same global-flag behaviour as `prismer`.
import { applyCommonFlags, setUI, UI } from './cli-ui';

const _head = process.argv.slice(0, 2);
const _tail = process.argv.slice(2);
const { mode: _mode, color: _color, restArgv: _restArgv } = applyCommonFlags(_tail);
setUI(new UI({ mode: _mode, color: _color }));

// Banner only in pretty mode — getUI() suppresses internally for json/quiet,
// but skip the call in those modes anyway so we don't trigger asset I/O.
if (_mode === 'pretty') {
  displayBanner();
}

program.parse([..._head, ..._restArgv]);
