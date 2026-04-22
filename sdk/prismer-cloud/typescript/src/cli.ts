/**
 * Prismer CLI — library-exported command registrations.
 *
 * As of v1.9.0 this module does NOT ship a `prismer` binary. Instead the
 * runtime package (@prismer/runtime) owns the single `prismer` entry point
 * and calls `registerSdkCliCommands(program, { skipConflicting: true })` to
 * mount these commands onto its own commander tree.
 *
 * Top-level shortcuts: send, load, search, parse, recall, discover, skill
 * Grouped namespaces:  im, context, evolve, task, memory, file, workspace, security, identity
 * Utilities:           init, register, status, config, token
 *
 * `{ skipConflicting: true }` skips setup/init/status/daemon — those names
 * are owned by the runtime CLI; `register` is always included (no runtime
 * collision; covers the IM identity flow).
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// @ts-ignore — no type declarations for @iarna/toml
import * as TOML from '@iarna/toml';
import { PrismerClient } from './index';
import {
  success,
  error as uiError,
  warn as uiWarn,
  info as uiInfo,
  dim,
  withSpinner,
  table,
  keyValue,
} from './ui';
import { register as registerIM } from './commands/im';
import { register as registerContext } from './commands/context';
import { register as registerEvolve } from './commands/evolve';
import { register as registerTask } from './commands/task';
import { register as registerMemory } from './commands/memory';
import { register as registerSkill } from './commands/skill';
import { register as registerFiles } from './commands/files';
import { register as registerWorkspace } from './commands/workspace';
import { register as registerSecurity } from './commands/security';
import { register as registerCommunity } from './commands/community';
import { register as registerRemote } from './commands/remote';
import { startDaemon, stopDaemon, daemonStatus, installDaemonService, uninstallDaemonService } from './daemon';

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

const CONFIG_DIR = path.join(os.homedir(), '.prismer');
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
  return TOML.parse(raw) as unknown as PrismerCLIConfig;
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
  const token = cfg?.auth?.im_token;
  if (!token) { uiError('No IM token. Run "prismer setup --agent" or "prismer register <username>" first.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  return new PrismerClient({ apiKey: token, environment: env as any, ...(baseUrl ? { baseUrl } : {}) });
}

export function getAPIClient(): PrismerClient {
  const cfg = readConfig();
  const apiKey = cfg?.default?.api_key;
  if (!apiKey) { uiError('No API key. Run "prismer setup" to sign in and get your key.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  return new PrismerClient({ apiKey, environment: env as any, ...(baseUrl ? { baseUrl } : {}) });
}

// ============================================================================
// CLI program — library mode
// ============================================================================
//
// Prior to v1.9.0 this file owned a top-level `const program = new Command()`
// and ran `program.parse(process.argv)` at import time. Both are gone: the
// runtime CLI owns program construction + parse.
//
// We keep `cliVersion` as an informational export so consumers can sanity-
// check the mounted SDK version at runtime.

export interface SdkCliOptions {
  /**
   * Skip commands that the runtime CLI already owns (setup, init, status,
   * daemon). `register` is always mounted — runtime does not provide it.
   */
  skipConflicting?: boolean;
}

export { cliVersion };

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

  // v1.9.0: the legacy `npx @prismer/sdk daemon start` launchd/systemd service
  // is retired — the runtime CLI (`prismer daemon start`) owns persistent sync.
  // Users who want auto-start should run `prismer daemon start` (see v1.9.1
  // follow-up for native service install wiring into the runtime bin).
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
// prismer setup — unified initialization (browser auto / agent auto-register / manual / key arg)
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
    dim('  To reconfigure, run: prismer setup --force');
    dim('  To check status:     prismer status');
    return;
  }

  // ── Path 1: Direct key argument (e.g. prismer setup sk-prismer-xxx / prismer init sk-prismer-xxx) ──
  if (apiKey) {
    await verifyAndSaveKey(config, apiKey);
    return;
  }

  // ── Path 2: Agent auto-register (non-interactive, for CI/scripts) ──
  if (opts.agent) {
    if (!opts.force && config.auth?.im_token) {
      success('Already registered as agent (IM token exists).');
      dim('  For API key access, run: prismer setup');
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
      uiInfo('For full API access, sign in: prismer setup');
    } catch (err: any) {
      uiError(`Agent registration failed: ${err.message}`);
      dim('  Try signing in instead: prismer setup');
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
        dim('    prismer setup --manual    Paste key manually');
        dim('    prismer setup --agent     Register as agent (free credits, no browser)');
        server.close();
        process.exit(1);
      }
    }, 5 * 60 * 1000);
  });
}

export function registerSdkCliCommands(
  program: Command,
  opts: SdkCliOptions = {},
): void {
  const skipConflicting = opts.skipConflicting === true;

  if (!skipConflicting) {
    // ── prismer setup ──
    program
      .command('setup [api-key]')
      .description('Set up Prismer — sign in via browser, register as agent, or provide your API key')
      .option('--manual', 'Paste API key manually instead of browser auto-flow')
      .option('--agent', 'Register as agent with free credits (no browser, for CI/scripts)')
      .option('--force', 'Reconfigure even if already set up')
      .action(async (apiKey: string | undefined, cmdOpts: { manual?: boolean; agent?: boolean; force?: boolean }) => {
        await runSetup(cmdOpts, apiKey);
      });

    // ── prismer init — backward-compatible alias for setup ──
    program
      .command('init [api-key]')
      .description('Alias for "prismer setup" (deprecated, use setup instead)')
      .option('--manual', 'Paste API key manually')
      .option('--agent', 'Register as agent with free credits')
      .option('--force', 'Reconfigure even if already set up')
      .action(async (apiKey: string | undefined, cmdOpts: { manual?: boolean; agent?: boolean; force?: boolean }) => {
        uiWarn('"prismer init" is deprecated. Use "prismer setup" instead.');
        console.log('');
        await runSetup(cmdOpts, apiKey);
      });
  }

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
    if (!apiKey) { uiError('No API key. Run "prismer setup" first.'); process.exit(1); }

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

if (!skipConflicting) {
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
}

// --- config ---
const configCmd = program.command('config').description('Manage config file');

// Secret field names we always redact. `$KEYRING:...` values are already safe
// references so we leave those intact — redacting them would lose information
// the user needs to debug keychain issues.
const SECRET_FIELD_PATTERN = /(api_key|_secret|_token|password)$/i;

function isKeyringPlaceholder(value: string): boolean {
  return value.startsWith('$KEYRING:');
}

function redactSecretValue(value: string): string {
  if (isKeyringPlaceholder(value)) return value;
  if (value.length <= 16) return '***';
  return value.slice(0, 12) + '...' + value.slice(-4);
}

// Walk the parsed TOML tree and redact any field whose key matches
// SECRET_FIELD_PATTERN. Non-string values pass through unchanged.
function redactSecrets(node: any): any {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((n) => redactSecrets(n));
  if (typeof node !== 'object') return node;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && SECRET_FIELD_PATTERN.test(k)) {
      out[k] = redactSecretValue(v);
    } else if (v && typeof v === 'object') {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

configCmd
  .command('show')
  .description('Print config file (secrets redacted by default)')
  .option('--show-secrets', 'Print secret values in full (API keys, tokens, passwords)')
  .option('--json', 'JSON output')
  .action((opts: { showSecrets?: boolean; json?: boolean }) => {
    if (!fs.existsSync(CONFIG_PATH)) {
      uiWarn('No config file. Run "prismer setup" to create one.');
      return;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    if (opts.showSecrets) {
      if (opts.json) {
        try {
          console.log(JSON.stringify(TOML.parse(raw), null, 2));
        } catch {
          console.log(raw);
        }
        return;
      }
      console.log(raw);
      return;
    }
    let parsed: any;
    try {
      parsed = TOML.parse(raw);
    } catch {
      // Fall back to regex-based redaction on the raw text when TOML parse
      // fails, so malformed configs still don't leak secrets.
      const redactedRaw = raw.replace(
        /^(\s*)(\w*(?:api_key|_secret|_token|password)\w*)\s*=\s*"([^"]*)"/gim,
        (_m, indent: string, key: string, val: string) =>
          `${indent}${key} = "${isKeyringPlaceholder(val) ? val : redactSecretValue(val)}"`,
      );
      console.log(redactedRaw);
      return;
    }
    const redacted = redactSecrets(parsed);
    if (opts.json) {
      console.log(JSON.stringify(redacted, null, 2));
      return;
    }
    try {
      console.log(TOML.stringify(redacted));
    } catch {
      console.log(JSON.stringify(redacted, null, 2));
    }
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

// v1.9.0 A.1: each SDK register* helper is isolated with try/catch so a single
// module's commander-level issue (e.g. legacy space-separated subcommands that
// collide on second registration) degrades to a noticed warning rather than
// taking down the entire `prismer` CLI. Runtime-owned names (`task`, `memory`)
// are skipped outright when skipConflicting=true.
const registrars: Array<[string, () => void]> = [
  ['im', () => registerIM(program, getIMClient, getAPIClient)],
  ['context', () => registerContext(program, getIMClient, getAPIClient)],
  ['evolve', () => registerEvolve(program, getIMClient, getAPIClient)],
];
if (!skipConflicting) {
  registrars.push(['task', () => registerTask(program, getIMClient, getAPIClient)]);
  registrars.push(['memory', () => registerMemory(program, getIMClient, getAPIClient)]);
}
registrars.push(
  ['skill', () => registerSkill(program, getIMClient, getAPIClient)],
  ['file', () => registerFiles(program, getIMClient, getAPIClient)],
  ['workspace', () => registerWorkspace(program, getIMClient, getAPIClient)],
  ['security', () => registerSecurity(program, getIMClient, getAPIClient)],
  ['community', () => registerCommunity(program, getIMClient, getAPIClient)],
  ['remote', () => registerRemote(program, getIMClient, getAPIClient)],
);
for (const [name, fn] of registrars) {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[prismer] warning: SDK '${name}' commands skipped (${msg})\n`);
  }
}

// ============================================================================
// Top-level shortcuts (zero-nesting for high-frequency ops)
// ============================================================================

// prismer send <user-id> "message"
program
  .command('send')
  .description('Send a direct message (shortcut for: im send)')
  .argument('<user-id>', 'Target user/agent ID')
  .argument('<message>', 'Message content')
  .option('-t, --type <type>', 'Message type: text, markdown, code, etc.', 'text')
  .option('--reply-to <id>', 'Reply to a message ID')
  .option('--json', 'JSON output')
  .action(async (userId: string, message: string, opts: any) => {
    const client = getIMClient();
    const sendOpts: Record<string, any> = {};
    if (opts.type && opts.type !== 'text') sendOpts.type = opts.type;
    if (opts.replyTo) sendOpts.parentId = opts.replyTo;
    const res = await withSpinner('Sending message', async () => {
      return client.im.direct.send(userId, message, sendOpts);
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { uiError(`Send failed: ${JSON.stringify(res.error)}`); process.exit(1); }
    success(`Message sent (conversation: ${res.data?.conversationId})`);
  });

// prismer load <url...>
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

// prismer search <query>
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

// prismer parse <url>
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
      dim(`  Check: prismer parse-status ${res.taskId}`);
    } else if (res.document) {
      success('Parse complete');
      const content = res.document.markdown || res.document.text || JSON.stringify(res.document, null, 2);
      console.log(content.substring(0, 5000));
    }
  });

// prismer parse status / result (sub-commands under parse)
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

// prismer recall <query>
program
  .command('recall')
  .description('Search across memory, cache, and evolution (shortcut for: memory recall)')
  .argument('<query>', 'Search query')
  .option('--scope <scope>', 'Scope: all, memory, cache, evolution', 'all')
  .option('-n, --limit <n>', 'Max results', '10')
  .option('--json', 'JSON output')
  .action(async (query: string, opts: any) => {
    const client = getIMClient();
    const params: Record<string, string> = { q: query };
    if (opts.scope) params.scope = opts.scope;
    if (opts.limit) params.limit = opts.limit;
    // recall uses raw request since not all SDKs expose it as a method
    const res = await withSpinner(`Recalling: ${query}`, async () => {
      return (client.im as any).memory._r('GET', '/api/im/recall', undefined, params);
    });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { uiError(`Recall failed: ${JSON.stringify(res.error)}`); process.exit(1); }
    const data = res.data || [];
    if (data.length === 0) { uiWarn(`No results for "${query}".`); return; }
    const rows = (data as any[]).map((item: any) => [
      (item.source || '').toUpperCase(),
      item.title || '?',
      (item.score || 0).toFixed(2),
    ]);
    table(['Source', 'Title', 'Score'], rows);
    // Show snippets
    for (const item of data as any[]) {
      if (item.snippet) {
        dim(`  ${item.snippet.substring(0, 200)}`);
      }
    }
  });

// prismer discover
program
  .command('discover')
  .description('Discover available agents (shortcut for: im discover)')
  .option('--type <type>', 'Filter by agent type')
  .option('--capability <cap>', 'Filter by capability')
  .option('--json', 'JSON output')
  .action(async (opts: any) => {
    const client = getIMClient();
    const discoverOpts: Record<string, string> = {};
    if (opts.type) discoverOpts.type = opts.type;
    if (opts.capability) discoverOpts.capability = opts.capability;
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
// Daemon command (runtime owns this namespace; SDK path retained for
// back-compat when registerSdkCliCommands is called with skipConflicting=false)
// ============================================================================

if (!skipConflicting) {
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
}

// End of registerSdkCliCommands
}
