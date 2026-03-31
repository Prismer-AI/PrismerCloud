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
  if (!token) { console.error('No IM token. Run "prismer setup --agent" or "prismer register <username>" first.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  return new PrismerClient({ apiKey: token, environment: env as any, ...(baseUrl ? { baseUrl } : {}) });
}

export function getAPIClient(): PrismerClient {
  const cfg = readConfig();
  const apiKey = cfg?.default?.api_key;
  if (!apiKey) { console.error('No API key. Run "prismer setup" to sign in and get your key.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  return new PrismerClient({ apiKey, environment: env as any, ...(baseUrl ? { baseUrl } : {}) });
}

// ============================================================================
// CLI program
// ============================================================================

const program = new Command();
program.name('prismer').description('Prismer Cloud SDK CLI').version(cliVersion);

// ============================================================================
// Utility commands: setup, init (alias), register, status, config, token
// ============================================================================

// ============================================================================
// Shared helpers for setup flows
// ============================================================================

async function verifyAndSaveKey(config: PrismerCLIConfig, apiKey: string): Promise<void> {
  if (!apiKey) {
    console.error('No key provided.');
    process.exit(1);
  }
  if (!apiKey.startsWith('sk-prismer-')) {
    console.error('Invalid key format. API keys start with sk-prismer-');
    console.error('Get your key at: https://prismer.cloud/setup');
    process.exit(1);
  }

  const baseUrl = config.default?.base_url || 'https://prismer.cloud';
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) {
      console.error('API key is invalid or expired.');
      console.error('Get a new key at: https://prismer.cloud/setup');
      process.exit(1);
    }
    console.log('API key verified ✓');
  } catch (err: any) {
    console.warn(`Could not verify key (${err.message}). Saving anyway.`);
  }

  if (!config.default) config.default = {};
  config.default.api_key = apiKey;
  if (!config.default.environment) config.default.environment = 'production';
  writeConfig(config);
  console.log('');
  console.log('Saved to ~/.prismer/config.toml');
  console.log('You can now use: CLI commands, MCP tools, Claude Code plugin, and all SDKs.');
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
    console.log(`Already configured: ${masked}`);
    console.log('');
    console.log('To reconfigure, run: prismer setup --force');
    console.log('To check status:     prismer status');
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
      console.log('Already registered as agent (IM token exists).');
      console.log('For API key access, run: prismer setup');
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

      console.log('Agent registered with free credits ✓');
      console.log(`  Username: ${config.auth.im_username}`);
      console.log(`  User ID:  ${config.auth.im_user_id}`);
      console.log('');
      console.log('For full API access, sign in: prismer setup');
    } catch (err: any) {
      console.error(`Agent registration failed: ${err.message}`);
      console.error('Try signing in instead: prismer setup');
      process.exit(1);
    }
    return;
  }

  // ── Path 3: Manual mode — open browser + paste key ──
  if (opts.manual) {
    const setupUrl = `${baseUrl}/setup?utm_source=cli&utm_medium=manual`;
    console.log('Opening browser to sign in...');
    console.log(`  ${setupUrl}`);
    console.log('');
    openBrowser(setupUrl);

    console.log('After signing in, copy the API key from the page and paste it below.');
    console.log('');

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Paste your API key: ', (key: string) => {
      rl.close();
      verifyAndSaveKey(config, key.trim()).catch((err: Error) => {
        console.error(`Setup failed: ${err.message}`);
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

    console.log('Opening browser to sign in...');
    console.log('');

    openBrowser(setupUrl);

    console.log('Waiting for authentication...');
    console.log('(If the browser didn\'t open, visit this URL manually:)');
    console.log(`  ${setupUrl}`);
    console.log('');

    setTimeout(() => {
      if (!resolved) {
        console.error('Timed out waiting for authentication (5 min).');
        console.error('');
        console.error('Alternatives:');
        console.error('  prismer setup --manual    Paste key manually');
        console.error('  prismer setup --agent     Register as agent (free credits, no browser)');
        server.close();
        process.exit(1);
      }
    }, 5 * 60 * 1000);
  });
}

// ── prismer setup ──
program
  .command('setup [api-key]')
  .description('Set up Prismer — sign in via browser, register as agent, or provide your API key')
  .option('--manual', 'Paste API key manually instead of browser auto-flow')
  .option('--agent', 'Register as agent with free credits (no browser, for CI/scripts)')
  .option('--force', 'Reconfigure even if already set up')
  .action(async (apiKey: string | undefined, opts: { manual?: boolean; agent?: boolean; force?: boolean }) => {
    await runSetup(opts, apiKey);
  });

// ── prismer init — backward-compatible alias for setup ──
program
  .command('init [api-key]')
  .description('Alias for "prismer setup" (deprecated, use setup instead)')
  .option('--manual', 'Paste API key manually')
  .option('--agent', 'Register as agent with free credits')
  .option('--force', 'Reconfigure even if already set up')
  .action(async (apiKey: string | undefined, opts: { manual?: boolean; agent?: boolean; force?: boolean }) => {
    console.log('Note: "prismer init" is deprecated. Use "prismer setup" instead.');
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
    if (!apiKey) { console.error('No API key. Run "prismer setup" first.'); process.exit(1); }

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
        console.error('Registration failed:', result.error?.message || 'Unknown error');
        process.exit(1);
      }
      const data = result.data;
      if (!config.auth) config.auth = {};
      config.auth.im_token = data.token;
      config.auth.im_user_id = data.imUserId;
      config.auth.im_username = data.username;
      config.auth.im_token_expires = data.expiresIn;
      writeConfig(config);
      console.log('Registration successful!');
      console.log(`  User ID:  ${data.imUserId}`);
      console.log(`  Username: ${data.username}`);
      console.log(`  Display:  ${data.displayName}`);
      console.log(`  Role:     ${data.role}`);
      console.log(`  New:      ${data.isNew}`);
      console.log('Token stored in ~/.prismer/config.toml');
    } catch (err) {
      console.error('Registration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current config and live info')
  .action(async () => {
    const config = readConfig();
    console.log('=== Prismer Status ===\n');
    const apiKey = config.default?.api_key;
    if (apiKey) {
      const masked = apiKey.length > 16 ? apiKey.slice(0, 12) + '...' + apiKey.slice(-4) : '***';
      console.log(`API Key:     ${masked}`);
    } else {
      console.log('API Key:     (not set)');
    }
    console.log(`Environment: ${config.default?.environment || '(not set)'}`);
    console.log(`Base URL:    ${config.default?.base_url || '(default)'}\n`);

    const token = config.auth?.im_token;
    if (token) {
      console.log(`IM User ID:  ${config.auth?.im_user_id || '(unknown)'}`);
      console.log(`IM Username: ${config.auth?.im_username || '(unknown)'}`);
      const expires = config.auth?.im_token_expires;
      if (expires) {
        const expiresDate = new Date(expires);
        if (!isNaN(expiresDate.getTime())) {
          const label = expiresDate <= new Date() ? 'EXPIRED' : 'valid';
          console.log(`IM Token:    ${label} (expires ${expiresDate.toISOString()})`);
        } else {
          console.log(`IM Token:    set (expires in ${expires})`);
        }
      } else {
        console.log('IM Token:    set (expiry unknown)');
      }

      // Live info
      console.log('\n--- Live Info ---');
      try {
        const client = new PrismerClient({
          apiKey: token,
          environment: (config.default?.environment as 'production') || 'production',
          baseUrl: config.default?.base_url || undefined,
        });
        const me = await client.im.account.me();
        if (me.ok && me.data) {
          console.log(`Display:     ${me.data.user.displayName}`);
          console.log(`Role:        ${me.data.user.role}`);
          console.log(`Credits:     ${me.data.credits.balance}`);
          console.log(`Messages:    ${me.data.stats.messagesSent}`);
          console.log(`Unread:      ${me.data.stats.unreadCount}`);
        } else {
          console.log(`Could not fetch live info: ${me.error?.message || 'unknown error'}`);
        }
      } catch (err) {
        console.log(`Could not fetch live info: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log('IM Token:    (not registered)');
    }
  });

// --- config ---
const configCmd = program.command('config').description('Manage config file');

configCmd.command('show').description('Print config file').action(() => {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('No config file. Run "prismer setup" to create one.');
    return;
  }
  console.log(fs.readFileSync(CONFIG_PATH, 'utf-8'));
});

configCmd.command('set <key> <value>').description('Set a config value (e.g. default.base_url)').action((key: string, value: string) => {
  const config = readConfig();
  setNestedValue(config as Record<string, any>, key, value);
  writeConfig(config);
  console.log(`Set ${key} = ${value}`);
});

// --- token ---
const tokenCmd = program.command('token').description('Token management');

tokenCmd.command('refresh').description('Refresh IM JWT token').option('--json', 'JSON output').action(async (opts: any) => {
  const client = getIMClient();
  const res = await client.im.account.refreshToken();
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const data = res.data as any;
  // Update stored token
  const config = readConfig();
  if (!config.auth) config.auth = {};
  if (data?.token) {
    config.auth.im_token = data.token;
    if (data.expiresIn) config.auth.im_token_expires = data.expiresIn;
    writeConfig(config);
    console.log('Token refreshed and saved.');
  } else {
    console.log('Token refreshed (no new token in response).');
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
import { register as registerFiles } from './commands/files';
import { register as registerWorkspace } from './commands/workspace';
import { register as registerSecurity } from './commands/security';

registerIM(program, getIMClient, getAPIClient);
registerContext(program, getIMClient, getAPIClient);
registerEvolve(program, getIMClient, getAPIClient);
registerTask(program, getIMClient, getAPIClient);
registerMemory(program, getIMClient, getAPIClient);
registerSkill(program, getIMClient, getAPIClient);
registerFiles(program, getIMClient, getAPIClient);
registerWorkspace(program, getIMClient, getAPIClient);
registerSecurity(program, getIMClient, getAPIClient);

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
    const res = await client.im.direct.send(userId, message, sendOpts);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    console.log(`Message sent (conversation: ${res.data?.conversationId})`);
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
    const res = await client.load(input as any, loadOpts);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { console.error('Error:', res.error?.message || 'Load failed'); process.exit(1); }
    const results = res.results || (res.result ? [res.result] : []);
    for (const r of results) {
      console.log(`URL:    ${r.url || '?'}`);
      console.log(`Status: ${r.cached ? 'cached' : 'loaded'}`);
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
    const res = await client.search(query, { topK: parseInt(opts.topK || '5') });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { console.error('Error:', res.error?.message || 'Search failed'); process.exit(1); }
    const results = res.results || [];
    if (results.length === 0) { console.log('No results.'); return; }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`${i + 1}. ${r.url || '(no url)'}  score: ${r.ranking?.score ?? '-'}`);
      if (r.hqcc) console.log(`   ${r.hqcc.substring(0, 200)}`);
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
    const res = await client.parsePdf(url, opts.mode);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.success) { console.error('Error:', res.error?.message || 'Parse failed'); process.exit(1); }
    if (res.taskId) {
      console.log(`Task ID: ${res.taskId}`);
      console.log(`Status:  ${res.status || 'processing'}`);
      console.log(`\nCheck: prismer parse status ${res.taskId}`);
    } else if (res.document) {
      console.log('Status: complete');
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
    console.log(`Task:   ${taskId}`);
    console.log(`Status: ${res.status || (res.success ? 'complete' : 'unknown')}`);
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
    if (!res.success) { console.error('Error:', res.error?.message || 'Not ready'); process.exit(1); }
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
    const res = await (client.im as any).memory._r('GET', '/api/im/recall', undefined, params);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    const data = res.data || [];
    if (data.length === 0) { console.log(`No results for "${query}".`); return; }
    for (const item of data as any[]) {
      console.log(`[${(item.source || '').toUpperCase()}] ${item.title || '?'}  (score: ${(item.score || 0).toFixed(2)})`);
      if (item.snippet) console.log(`  ${item.snippet.substring(0, 200)}`);
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
    const res = await client.im.contacts.discover(discoverOpts);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    const agents = res.data || [];
    if (agents.length === 0) { console.log('No agents found.'); return; }
    console.log('Username'.padEnd(20) + 'Type'.padEnd(14) + 'Status'.padEnd(10) + 'Display Name');
    for (const a of agents) {
      console.log(`${(a.username || '').padEnd(20)}${(a.agentType || '').padEnd(14)}${(a.status || '').padEnd(10)}${a.displayName || ''}`);
    }
  });

// ============================================================================
// Parse and run
// ============================================================================

program.parse(process.argv);
