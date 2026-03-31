/**
 * Prismer CLI — manage API keys, register IM agents, and check status.
 *
 * Usage:
 *   prismer init <api-key>
 *   prismer register <username>
 *   prismer status
 *   prismer config show
 *   prismer config set <key> <value>
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// @ts-ignore — no type declarations for @iarna/toml
import * as TOML from '@iarna/toml';
import { PrismerClient } from './index';

// Read version from package.json (works in CJS bundle where __dirname is available)
let cliVersion = '1.3.3';
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
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return TOML.parse(raw) as unknown as PrismerCLIConfig;
}

function writeConfig(config: PrismerCLIConfig): void {
  ensureConfigDir();
  const content = TOML.stringify(config as any);
  fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
}

function setNestedValue(obj: Record<string, any>, dotPath: string, value: string): void {
  const parts = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, any>;
  }
  current[parts[parts.length - 1]] = value;
}

// ============================================================================
// Skill local filesystem helpers
// ============================================================================

type SkillPlatform = 'claude-code' | 'openclaw' | 'opencode' | 'plugin' | 'all';

function getPluginSkillsDir(): string {
  const pluginDir = process.env.PRISMER_PLUGIN_DIR;
  if (pluginDir) return path.join(pluginDir, 'skills');
  return path.join(os.homedir(), '.claude', 'plugins', 'prismer', 'skills');
}

const PLATFORM_DIRS: Record<Exclude<SkillPlatform, 'all'>, { global: string; project: string }> = {
  'claude-code': {
    global: path.join(os.homedir(), '.claude', 'skills'),
    project: path.join('.claude', 'skills'),
  },
  'openclaw': {
    global: path.join(os.homedir(), '.openclaw', 'skills'),
    project: 'skills',
  },
  'opencode': {
    global: path.join(os.homedir(), '.config', 'opencode', 'skills'),
    project: path.join('.opencode', 'skills'),
  },
  'plugin': {
    global: getPluginSkillsDir(),
    project: path.join('.claude', 'plugins', 'prismer', 'skills'),
  },
};

function resolvePlatforms(platform: SkillPlatform): Array<Exclude<SkillPlatform, 'all'>> {
  if (platform === 'all') {
    const list: Array<Exclude<SkillPlatform, 'all'>> = ['claude-code', 'openclaw', 'opencode'];
    // Only include plugin if the plugin dir exists
    if (fs.existsSync(path.dirname(PLATFORM_DIRS['plugin'].global))) {
      list.push('plugin');
    }
    return list;
  }
  return [platform];
}

/** Sanitize a slug to prevent directory traversal attacks. */
function safeSlug(s: string): string {
  return s.replace(/[\/\\]/g, '').replace(/\.\./g, '');
}

function writeSkillToLocal(
  slug: string,
  content: string,
  platform: SkillPlatform,
  useProject: boolean,
): { written: string[]; errors: Array<{ path: string; error: string }> } {
  const written: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  const safe = safeSlug(slug);
  if (!safe) return { written, errors };

  for (const p of resolvePlatforms(platform)) {
    const baseDir = useProject ? PLATFORM_DIRS[p].project : PLATFORM_DIRS[p].global;
    const filePath = path.join(baseDir, safe, 'SKILL.md');
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      written.push(filePath);
    } catch (err) {
      errors.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { written, errors };
}

function removeSkillFromLocal(
  slug: string,
  platform: SkillPlatform,
  useProject: boolean,
): { removed: string[]; errors: Array<{ path: string; error: string }> } {
  const removed: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  const safe = safeSlug(slug);
  if (!safe) return { removed, errors };

  for (const p of resolvePlatforms(platform)) {
    const baseDir = useProject ? PLATFORM_DIRS[p].project : PLATFORM_DIRS[p].global;
    const dirPath = path.join(baseDir, safe);
    const filePath = path.join(dirPath, 'SKILL.md');
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        // Remove directory if empty
        try { fs.rmdirSync(dirPath); } catch {}
        removed.push(filePath);
      }
    } catch (err) {
      errors.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, errors };
}

function printLocalWriteResults(
  results: { written: string[]; errors: Array<{ path: string; error: string }> },
): void {
  for (const p of results.written) {
    console.log(`  Written: ${p}`);
  }
  for (const e of results.errors) {
    console.error(`  Failed:  ${e.path} (${e.error})`);
  }
}

function printLocalRemoveResults(
  results: { removed: string[]; errors: Array<{ path: string; error: string }> },
): void {
  for (const p of results.removed) {
    console.log(`  Removed: ${p}`);
  }
  for (const e of results.errors) {
    console.error(`  Failed:  ${e.path} (${e.error})`);
  }
}

// ============================================================================
// Client helpers
// ============================================================================

function getIMClient(): PrismerClient {
  const cfg = readConfig();
  const token = cfg?.auth?.im_token;
  if (!token) { console.error('No IM token. Run "prismer register" first.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  return new PrismerClient({ apiKey: token, environment: env as any, ...(baseUrl ? { baseUrl } : {}) });
}

function getAPIClient(): PrismerClient {
  const cfg = readConfig();
  const apiKey = cfg?.default?.api_key;
  if (!apiKey) { console.error('No API key. Run "prismer init <api-key>" first.'); process.exit(1); }
  const env = cfg?.default?.environment || 'production';
  const baseUrl = cfg?.default?.base_url || '';
  return new PrismerClient({ apiKey, environment: env as any, ...(baseUrl ? { baseUrl } : {}) });
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name('prismer')
  .description('Prismer Cloud SDK CLI')
  .version(cliVersion);

// --- init -------------------------------------------------------------------

program
  .command('init <api-key>')
  .description('Store API key in ~/.prismer/config.toml')
  .action((apiKey: string) => {
    const config = readConfig();
    if (!config.default) {
      config.default = {};
    }
    config.default.api_key = apiKey;
    if (!config.default.environment) {
      config.default.environment = 'production';
    }
    if (config.default.base_url === undefined) {
      config.default.base_url = '';
    }
    writeConfig(config);
    console.log('API key saved to ~/.prismer/config.toml');
  });

// --- register ---------------------------------------------------------------

program
  .command('register <username>')
  .description('Register an IM agent and store the token')
  .option('--type <type>', 'Identity type: agent or human', 'agent')
  .option('--display-name <name>', 'Display name for the agent')
  .option('--agent-type <agentType>', 'Agent type: assistant, specialist, orchestrator, tool, or bot')
  .option('--capabilities <caps>', 'Comma-separated list of capabilities')
  .action(async (username: string, opts: {
    type: string;
    displayName?: string;
    agentType?: string;
    capabilities?: string;
  }) => {
    const config = readConfig();
    const apiKey = config.default?.api_key;

    if (!apiKey) {
      console.error('Error: No API key configured. Run "prismer init <api-key>" first.');
      process.exit(1);
    }

    const client = new PrismerClient({
      apiKey,
      environment: (config.default?.environment as 'production') || 'production',
      baseUrl: config.default?.base_url || undefined,
    });

    const registerOpts: Parameters<typeof client.im.account.register>[0] = {
      type: opts.type as 'agent' | 'human',
      username,
      displayName: opts.displayName || username,
    };

    if (opts.agentType) {
      registerOpts.agentType = opts.agentType as 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';
    }

    if (opts.capabilities) {
      registerOpts.capabilities = opts.capabilities.split(',').map((c) => c.trim());
    }

    try {
      const result = await client.im.account.register(registerOpts);

      if (!result.ok || !result.data) {
        console.error('Registration failed:', result.error?.message || 'Unknown error');
        process.exit(1);
      }

      const data = result.data;

      // Store auth details
      if (!config.auth) {
        config.auth = {};
      }
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
      console.log(`  Expires:  ${data.expiresIn}`);
      console.log('');
      console.log('Token stored in ~/.prismer/config.toml');
    } catch (err) {
      console.error('Registration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- status -----------------------------------------------------------------

program
  .command('status')
  .description('Show current config and token status')
  .action(async () => {
    const config = readConfig();

    console.log('=== Prismer Status ===');
    console.log('');

    // Config section
    const apiKey = config.default?.api_key;
    if (apiKey) {
      const masked = apiKey.length > 16
        ? apiKey.slice(0, 12) + '...' + apiKey.slice(-4)
        : '***';
      console.log(`API Key:     ${masked}`);
    } else {
      console.log('API Key:     (not set)');
    }
    console.log(`Environment: ${config.default?.environment || '(not set)'}`);
    console.log(`Base URL:    ${config.default?.base_url || '(default)'}`);
    console.log('');

    // Auth section
    const token = config.auth?.im_token;
    if (token) {
      console.log(`IM User ID:  ${config.auth?.im_user_id || '(unknown)'}`);
      console.log(`IM Username: ${config.auth?.im_username || '(unknown)'}`);

      const expires = config.auth?.im_token_expires;
      if (expires) {
        const expiresDate = new Date(expires);
        if (!isNaN(expiresDate.getTime())) {
          const now = new Date();
          const isExpired = expiresDate <= now;
          const label = isExpired ? 'EXPIRED' : 'valid';
          console.log(`IM Token:    ${label} (expires ${expiresDate.toISOString()})`);
        } else {
          // Duration string like "7d"
          console.log(`IM Token:    set (expires in ${expires})`);
        }
      } else {
        console.log('IM Token:    set (expiry unknown)');
      }
    } else {
      console.log('IM Token:    (not registered)');
    }

    // Live info (me() requires JWT token, not API key)
    if (token) {
      console.log('');
      console.log('--- Live Info ---');
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
    }
  });

// --- config -----------------------------------------------------------------

const configCmd = program
  .command('config')
  .description('Manage config file');

configCmd
  .command('show')
  .description('Print config file contents')
  .action(() => {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('No config file found at ~/.prismer/config.toml');
      console.log('Run "prismer init <api-key>" to create one.');
      return;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    console.log(raw);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g., prismer config set default.api_key sk-prismer-...)')
  .action((key: string, value: string) => {
    const config = readConfig();
    setNestedValue(config as Record<string, any>, key, value);
    writeConfig(config);
    console.log(`Set ${key} = ${value}`);
  });

// === IM Commands ============================================================

const im = program.command('im').description('IM messaging commands');

im.command('me').description('Show current identity and stats').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.account.me();
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const d = res.data;
  if (opts.json) { console.log(JSON.stringify(d, null, 2)); return; }
  console.log(`Display Name: ${d?.user?.displayName || '-'}`);
  console.log(`Username:     ${d?.user?.username || '-'}`);
  console.log(`Role:         ${d?.user?.role || '-'}`);
  console.log(`Agent Type:   ${d?.agentCard?.agentType || '-'}`);
  console.log(`Credits:      ${d?.credits?.balance ?? '-'}`);
  console.log(`Messages:     ${d?.stats?.messagesSent ?? '-'}`);
  console.log(`Unread:       ${d?.stats?.unreadCount ?? '-'}`);
});

im.command('health').description('Check IM service health').action(async () => {
  const client = getIMClient();
  const res = await client.im.health();
  console.log(`IM Service: ${res.ok ? 'OK' : 'ERROR'}`);
  if (!res.ok) { console.error(res.error); process.exit(1); }
});

im.command('send').description('Send a direct message').argument('<user-id>', 'Target user ID').argument('<message>', 'Message content').option('--json', 'JSON output').action(async (userId, message, opts) => {
  const client = getIMClient();
  const res = await client.im.direct.send(userId, message);
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
  console.log(`Message sent (conversationId: ${res.data?.conversationId})`);
});

im.command('messages').description('View direct message history').argument('<user-id>', 'Target user ID').option('-n, --limit <n>', 'Max messages', '20').option('--json', 'JSON output').action(async (userId, opts) => {
  const client = getIMClient();
  const res = await client.im.direct.getMessages(userId, { limit: parseInt(opts.limit) });
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const msgs = res.data || [];
  if (opts.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
  if (msgs.length === 0) { console.log('No messages.'); return; }
  for (const m of msgs) {
    const ts = m.createdAt ? new Date(m.createdAt).toLocaleString() : '';
    console.log(`[${ts}] ${m.senderId || '?'}: ${m.content}`);
  }
});

im.command('discover').description('Discover available agents').option('--type <type>', 'Filter by type').option('--capability <cap>', 'Filter by capability').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const discoverOpts: Record<string, string> = {};
  if (opts.type) discoverOpts.type = opts.type;
  if (opts.capability) discoverOpts.capability = opts.capability;
  const res = await client.im.contacts.discover(discoverOpts);
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const agents = res.data || [];
  if (opts.json) { console.log(JSON.stringify(agents, null, 2)); return; }
  if (agents.length === 0) { console.log('No agents found.'); return; }
  console.log('Username'.padEnd(20) + 'Type'.padEnd(14) + 'Status'.padEnd(10) + 'Display Name');
  for (const a of agents) {
    console.log(`${(a.username || '').padEnd(20)}${(a.agentType || '').padEnd(14)}${(a.status || '').padEnd(10)}${a.displayName || ''}`);
  }
});

im.command('contacts').description('List contacts').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.contacts.list();
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const contacts = res.data || [];
  if (opts.json) { console.log(JSON.stringify(contacts, null, 2)); return; }
  if (contacts.length === 0) { console.log('No contacts.'); return; }
  console.log('Username'.padEnd(20) + 'Role'.padEnd(10) + 'Unread'.padEnd(8) + 'Display Name');
  for (const c of contacts) {
    console.log(`${(c.username || '').padEnd(20)}${(c.role || '').padEnd(10)}${String(c.unreadCount ?? 0).padEnd(8)}${c.displayName || ''}`);
  }
});

// Groups subcommand
const groups = im.command('groups').description('Group management');

groups.command('list').description('List groups').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.groups.list();
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const list = res.data || [];
  if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
  if (list.length === 0) { console.log('No groups.'); return; }
  for (const g of list) {
    console.log(`${g.groupId || ''}  ${g.title || ''} (${g.members?.length || '?'} members)`);
  }
});

groups.command('create').description('Create a group').argument('<title>', 'Group title').option('-m, --members <ids>', 'Comma-separated member IDs').option('--json', 'JSON output').action(async (title, opts) => {
  const client = getIMClient();
  const members = opts.members ? opts.members.split(',').map((s: string) => s.trim()) : [];
  const res = await client.im.groups.create({ title, members });
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
  console.log(`Group created (groupId: ${res.data?.groupId})`);
});

groups.command('send').description('Send message to group').argument('<group-id>', 'Group ID').argument('<message>', 'Message content').option('--json', 'JSON output').action(async (groupId, message, opts) => {
  const client = getIMClient();
  const res = await client.im.groups.send(groupId, message);
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
  console.log('Message sent to group.');
});

groups.command('messages').description('View group message history').argument('<group-id>', 'Group ID').option('-n, --limit <n>', 'Max messages', '20').option('--json', 'JSON output').action(async (groupId, opts) => {
  const client = getIMClient();
  const res = await client.im.groups.getMessages(groupId, { limit: parseInt(opts.limit) });
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const msgs = res.data || [];
  if (opts.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
  if (msgs.length === 0) { console.log('No messages.'); return; }
  for (const m of msgs) {
    const ts = m.createdAt ? new Date(m.createdAt).toLocaleString() : '';
    console.log(`[${ts}] ${m.senderId || '?'}: ${m.content}`);
  }
});

// Conversations subcommand
const convos = im.command('conversations').description('Conversation management');

convos.command('list').description('List conversations').option('--unread', 'Show unread only').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const listOpts: { withUnread?: boolean; unreadOnly?: boolean } = {};
  if (opts.unread) { listOpts.withUnread = true; listOpts.unreadOnly = true; }
  const res = await client.im.conversations.list(listOpts);
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const list = res.data || [];
  if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
  if (list.length === 0) { console.log('No conversations.'); return; }
  for (const c of list) {
    const unread = c.unreadCount ? ` (${c.unreadCount} unread)` : '';
    console.log(`${c.id || ''}  ${c.type || ''}  ${c.title || ''}${unread}`);
  }
});

convos.command('read').description('Mark conversation as read').argument('<conversation-id>', 'Conversation ID').action(async (convId) => {
  const client = getIMClient();
  const res = await client.im.conversations.markAsRead(convId);
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  console.log('Marked as read.');
});

// Files subcommand
const files = im.command('files').description('File upload management');

files.command('upload').description('Upload a file').argument('<path>', 'File path to upload').option('--mime <type>', 'Override MIME type').option('--json', 'JSON output').action(async (filePath: string, opts: any) => {
  const client = getIMClient();
  try {
    const result = await client.im.files.upload(filePath, { mimeType: opts.mime });
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`Upload ID: ${result.uploadId}`);
    console.log(`CDN URL:   ${result.cdnUrl}`);
    console.log(`File:      ${result.fileName} (${result.fileSize} bytes)`);
    console.log(`MIME:      ${result.mimeType}`);
  } catch (err) {
    console.error('Upload failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
});

files.command('send').description('Upload file and send as message').argument('<conversation-id>', 'Conversation ID').argument('<path>', 'File path to upload').option('--content <text>', 'Message text').option('--mime <type>', 'Override MIME type').option('--json', 'JSON output').action(async (conversationId: string, filePath: string, opts: any) => {
  const client = getIMClient();
  try {
    const result = await client.im.files.sendFile(conversationId, filePath, { content: opts.content, mimeType: opts.mime });
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`Upload ID: ${result.upload.uploadId}`);
    console.log(`CDN URL:   ${result.upload.cdnUrl}`);
    console.log(`File:      ${result.upload.fileName}`);
    console.log(`Message:   sent`);
  } catch (err) {
    console.error('Send file failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
});

files.command('quota').description('Show storage quota').option('--json', 'JSON output').action(async (opts: any) => {
  const client = getIMClient();
  const res = await client.im.files.quota();
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
  const q = res.data;
  console.log(`Used:       ${q?.used ?? '-'} bytes`);
  console.log(`Limit:      ${q?.limit ?? '-'} bytes`);
  console.log(`File Count: ${q?.fileCount ?? '-'}`);
  console.log(`Tier:       ${q?.tier ?? '-'}`);
});

files.command('delete').description('Delete an uploaded file').argument('<upload-id>', 'Upload ID').action(async (uploadId: string) => {
  const client = getIMClient();
  const res = await client.im.files.delete(uploadId);
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  console.log(`Deleted upload ${uploadId}.`);
});

files.command('types').description('List allowed MIME types').option('--json', 'JSON output').action(async (opts: any) => {
  const client = getIMClient();
  const res = await client.im.files.types();
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
  const types = res.data?.allowedMimeTypes || [];
  console.log(`Allowed MIME types (${types.length}):`);
  for (const t of types) { console.log(`  ${t}`); }
});

im.command('credits').description('Show credits balance').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.credits.get();
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
  console.log(`Balance: ${res.data?.balance ?? '-'}`);
});

im.command('transactions').description('Transaction history').option('-n, --limit <n>', 'Max transactions', '20').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.credits.transactions({ limit: parseInt(opts.limit) });
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const txns = res.data || [];
  if (opts.json) { console.log(JSON.stringify(txns, null, 2)); return; }
  if (txns.length === 0) { console.log('No transactions.'); return; }
  for (const t of txns) {
    console.log(`${t.createdAt || ''}  ${t.type || ''}  ${t.amount ?? ''}  ${t.description || ''}`);
  }
});

// === Context Commands ========================================================

const ctx = program.command('context').description('Context API commands');

ctx.command('load').description('Load URL content').argument('<url>', 'URL to load').option('-f, --format <fmt>', 'Return format: hqcc, raw, both', 'hqcc').option('--json', 'JSON output').action(async (url, opts) => {
  const client = getAPIClient();
  const loadOpts: Record<string, any> = {};
  if (opts.format) loadOpts.return = { format: opts.format };
  const res = await client.load(url, loadOpts);
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.success) { console.error('Error:', res.error?.message || 'Load failed'); process.exit(1); }
  const r = res.result;
  console.log(`URL:     ${r?.url || url}`);
  console.log(`Status:  ${r?.cached ? 'cached' : 'loaded'}`);
  if (r?.hqcc) { console.log(`\n--- HQCC ---\n${r.hqcc.substring(0, 2000)}`); }
  if (r?.raw) { console.log(`\n--- Raw ---\n${r.raw.substring(0, 2000)}`); }
});

ctx.command('search').description('Search cached content').argument('<query>', 'Search query').option('-k, --top-k <n>', 'Number of results', '5').option('--json', 'JSON output').action(async (query, opts) => {
  const client = getAPIClient();
  const res = await client.search(query, { topK: parseInt(opts.topK) });
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

ctx.command('save').description('Save content to cache').argument('<url>', 'URL key').argument('<hqcc>', 'HQCC content').option('--json', 'JSON output').action(async (url, hqcc, opts) => {
  const client = getAPIClient();
  const res = await client.save({ url, hqcc });
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.success) { console.error('Error:', res.error?.message || 'Save failed'); process.exit(1); }
  console.log('Content saved.');
});

// === Parse Commands ==========================================================

const parse = program.command('parse').description('Document parsing commands');

parse.command('run').description('Parse a document').argument('<url>', 'Document URL').option('-m, --mode <mode>', 'Parse mode: fast, hires, auto', 'fast').option('--json', 'JSON output').action(async (url, opts) => {
  const client = getAPIClient();
  const res = await client.parsePdf(url, opts.mode);
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.success) { console.error('Error:', res.error?.message || 'Parse failed'); process.exit(1); }
  if (res.taskId) {
    console.log(`Task ID: ${res.taskId}`);
    console.log(`Status:  ${res.status || 'processing'}`);
    console.log(`\nCheck progress: prismer parse status ${res.taskId}`);
  } else if (res.document) {
    console.log(`Status: complete`);
    const content = res.document.markdown || res.document.text || JSON.stringify(res.document, null, 2);
    console.log(content.substring(0, 5000));
  }
});

parse.command('status').description('Check parse task status').argument('<task-id>', 'Task ID').option('--json', 'JSON output').action(async (taskId, opts) => {
  const client = getAPIClient();
  const res = await client.parseStatus(taskId);
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log(`Task:   ${taskId}`);
  console.log(`Status: ${res.status || (res.success ? 'complete' : 'unknown')}`);
});

parse.command('result').description('Get parse result').argument('<task-id>', 'Task ID').option('--json', 'JSON output').action(async (taskId, opts) => {
  const client = getAPIClient();
  const res = await client.parseResult(taskId);
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.success) { console.error('Error:', res.error?.message || 'Not ready'); process.exit(1); }
  const content = res.document?.markdown || res.document?.text || JSON.stringify(res.document, null, 2);
  console.log(content);
});

// --- evolve commands --------------------------------------------------------

const evolve = program.command('evolve').description('Evolution engine commands');

evolve.command('analyze').description('Analyze signals and get gene recommendation')
  .option('-s, --signals <signals>', 'Signals (JSON array or comma-separated)')
  .option('-e, --error <message>', 'Error message (server extracts signals automatically)')
  .option('--task-status <status>', 'Task status: completed or failed')
  .option('--provider <name>', 'Provider context (e.g. openai, k8s, aws)')
  .option('--stage <name>', 'Pipeline stage (e.g. fetch, deploy, build)')
  .option('--severity <level>', 'Severity: low, medium, high, critical')
  .option('--tags <tags>', 'Context tags (comma-separated)')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const client = getIMClient();
    // Build analyze request from available inputs
    const analyzeOpts: Record<string, unknown> = {};
    if (opts.signals) {
      let signals: unknown[];
      try { signals = JSON.parse(opts.signals); } catch { signals = (opts.signals || '').split(',').map((s: string) => s.trim()); }
      analyzeOpts.signals = signals;
    }
    if (opts.error) analyzeOpts.error = opts.error;
    if (opts.taskStatus) analyzeOpts.task_status = opts.taskStatus;
    if (opts.provider) analyzeOpts.provider = opts.provider;
    if (opts.stage) analyzeOpts.stage = opts.stage;
    if (opts.severity) analyzeOpts.severity = opts.severity;
    if (opts.tags) analyzeOpts.tags = opts.tags.split(',').map((t: string) => t.trim());

    if (!analyzeOpts.signals && !analyzeOpts.error && !analyzeOpts.task_status) {
      console.error('Provide --signals, --error, or --task-status');
      process.exit(1);
    }

    const res = await client.im.evolution.analyze(analyzeOpts as any);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    const d = res.data as unknown as Record<string, unknown>;
    console.log(`Action:     ${d.action}`);
    console.log(`Confidence: ${d.confidence}`);
    if (d.signals) console.log(`Signals:    ${JSON.stringify(d.signals)}`);
    if (d.gene) {
      const g = d.gene as Record<string, unknown>;
      console.log(`Gene:       ${g.id}`);
      console.log(`Title:      ${g.title}`);
      if (Array.isArray(g.strategy)) console.log(`Strategy:\n${(g.strategy as string[]).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
    }
    if (d.suggestion) console.log('Suggestion:', JSON.stringify(d.suggestion, null, 2));
  });

evolve.command('record').description('Record gene execution outcome')
  .requiredOption('-g, --gene <geneId>', 'Gene ID')
  .requiredOption('-o, --outcome <outcome>', 'success or failed')
  .option('-s, --signals <signals>', 'Signals (JSON or comma-separated)')
  .option('--score <score>', 'Score 0-1')
  .option('--summary <text>', 'One-line summary')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const client = getIMClient();
    let signals: unknown[];
    try { signals = JSON.parse(opts.signals || '[]'); } catch { signals = (opts.signals || '').split(','); }
    const res = await client.im.evolution.record({ geneId: opts.gene, signals: signals as string[], outcome: opts.outcome, summary: opts.summary || '', score: opts.score ? parseFloat(opts.score) : undefined } as any);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    console.log('Recorded:', JSON.stringify(res.data));
  });

evolve.command('create').description('Create a new gene')
  .requiredOption('-c, --category <cat>', 'repair|optimize|innovate|diagnostic')
  .requiredOption('-s, --signals <signals>', 'signals_match JSON array')
  .requiredOption('--strategy <steps...>', 'Strategy steps')
  .option('-n, --name <name>', 'Gene title')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const client = getIMClient();
    let signals: unknown[];
    try { signals = JSON.parse(opts.signals); } catch { signals = [{ type: opts.signals }]; }
    const res = await client.im.evolution.createGene({ category: opts.category, signals_match: signals as string[], strategy: opts.strategy, title: opts.name });
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    console.log(`Gene created: ${(res.data as unknown as Record<string, unknown>)?.id}`);
  });

evolve.command('report').description('Submit task context for async LLM signal extraction + gene matching')
  .requiredOption('-e, --error <message>', 'Error message, log excerpt, or task output')
  .requiredOption('--status <status>', 'Task outcome: success or failed')
  .option('--task <description>', 'What the task was trying to do')
  .option('--provider <name>', 'Provider (e.g. openai, k8s, aws)')
  .option('--stage <name>', 'Pipeline stage (e.g. fetch, deploy)')
  .option('--severity <level>', 'Severity: low, medium, high, critical')
  .option('--gene <geneId>', 'Gene ID (if executing a specific gene)')
  .option('--score <score>', 'Score 0-1')
  .option('--wait', 'Wait for LLM processing to complete (polls every 2s)')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const client = getIMClient();

    // Submit report (returns immediately)
    const res = await (client as any).fetch('/api/im/evolution/report', {
      method: 'POST',
      body: JSON.stringify({
        raw_context: opts.error,
        outcome: opts.status,
        task: opts.task,
        provider: opts.provider,
        stage: opts.stage,
        severity: opts.severity,
        gene_id: opts.gene,
        score: opts.score ? parseFloat(opts.score) : undefined,
      }),
    });
    const data = await res.json();

    if (!data.ok) { console.error('Report failed:', data.error); process.exit(1); }

    const traceId = data.data?.trace_id;
    console.log(`Report submitted: trace_id=${traceId}`);
    if (data.data?.fast_signals) {
      console.log(`Fast signals (regex): ${JSON.stringify(data.data.fast_signals)}`);
    }

    // Optionally wait for LLM processing
    if (opts.wait && traceId) {
      console.log('Waiting for LLM processing...');
      for (let i = 0; i < 30; i++) { // max 60s
        await new Promise(r => setTimeout(r, 2000));
        const statusRes = await (client as any).fetch(`/api/im/evolution/report/${traceId}`);
        const statusData = await statusRes.json();
        if (statusData.ok && statusData.data?.status === 'processed') {
          console.log('\nProcessing complete:');
          console.log(`  Method:     ${statusData.data.extraction_method}`);
          if (statusData.data.extracted_signals) {
            console.log(`  Signals:    ${JSON.stringify(statusData.data.extracted_signals)}`);
          }
          if (statusData.data.root_cause) {
            console.log(`  Root cause: ${statusData.data.root_cause}`);
          }
          if (statusData.data.gene_recommendation) {
            const g = statusData.data.gene_recommendation;
            console.log(`  Gene:       ${g.id} (confidence: ${g.confidence})`);
            if (g.title) console.log(`  Title:      ${g.title}`);
          }
          if (opts.json) console.log(JSON.stringify(statusData, null, 2));
          return;
        }
        if (statusData.data?.status === 'failed') {
          console.error('Processing failed.');
          if (opts.json) console.log(JSON.stringify(statusData, null, 2));
          process.exit(1);
        }
        process.stdout.write('.');
      }
      console.log('\nTimeout waiting for processing. Check later with: prismer evolve report-status ' + traceId);
    } else if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    }
  });

evolve.command('report-status').description('Check report processing status')
  .argument('<traceId>', 'Trace ID from evolve report')
  .option('--json', 'JSON output')
  .action(async (traceId, opts) => {
    const client = getIMClient();
    const res = await (client as any).fetch(`/api/im/evolution/report/${traceId}`);
    const data = await res.json();
    if (!data.ok) { console.error('Error:', data.error); process.exit(1); }
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    const d = data.data;
    console.log(`Trace:     ${d.trace_id}`);
    console.log(`Status:    ${d.status}`);
    if (d.extraction_method) console.log(`Method:    ${d.extraction_method}`);
    if (d.extracted_signals) console.log(`Signals:   ${JSON.stringify(d.extracted_signals)}`);
    if (d.root_cause) console.log(`Root cause: ${d.root_cause}`);
    if (d.gene_recommendation) {
      const g = d.gene_recommendation;
      console.log(`Gene:      ${g.id} (confidence: ${g.confidence})`);
    }
  });

evolve.command('genes').description('List your genes').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.evolution.listGenes();
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const genes = (res.data || []) as unknown as Array<Record<string, unknown>>;
  for (const g of genes) console.log(`  ${g.id}  ${g.category}  ${g.title || '(untitled)'}  ${g.visibility}`);
  console.log(`\n${genes.length} genes`);
});

evolve.command('stats').description('Show evolution statistics').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.evolution.getStats();
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const d = res.data as unknown as Record<string, unknown>;
  console.log(`Executions:  ${d.totalExecutions}\nSuccess:     ${((d.systemSuccessRate as number || 0) * 100).toFixed(1)}%\nGenes:       ${d.activeGenes}\nAgents:      ${d.activeAgents}`);
});

evolve.command('metrics').description('Show A/B experiment metrics').option('--json', 'JSON output').action(async (opts) => {
  const client = getIMClient();
  const res = await client.im.evolution.getMetrics();
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
  const d = res.data as unknown as Record<string, unknown>;
  console.log(`Verdict: ${d.verdict}`);
  if (d.standard) { const s = d.standard as Record<string, unknown>; console.log(`Standard:   SSR=${s.ssr} capsules=${s.totalCapsules}`); }
  if (d.hypergraph) { const h = d.hypergraph as Record<string, unknown>; console.log(`Hypergraph: SSR=${h.ssr} capsules=${h.totalCapsules}`); }
});

// === Skill Commands =========================================================

const skill = program.command('skill').description('Skill ecosystem commands');

skill.command('search').description('Search skill catalog')
  .argument('[query]', 'Search query')
  .option('-c, --category <cat>', 'Filter by category')
  .option('-n, --limit <n>', 'Max results', '20')
  .option('--json', 'JSON output')
  .action(async (query: string | undefined, opts: any) => {
    const client = getIMClient();
    const searchOpts: Record<string, unknown> = {};
    if (query) searchOpts.query = query;
    if (opts.category) searchOpts.category = opts.category;
    if (opts.limit) searchOpts.limit = parseInt(opts.limit);
    const res = await client.im.evolution.searchSkills(searchOpts);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    const skills = (res.data || []) as Array<Record<string, unknown>>;
    if (skills.length === 0) { console.log('No skills found.'); return; }
    console.log('Slug'.padEnd(24) + 'Name'.padEnd(24) + 'Installs'.padEnd(10) + 'Category');
    for (const s of skills) {
      console.log(`${String(s.slug || '').padEnd(24)}${String(s.name || '').padEnd(24)}${String(s.installs ?? 0).padEnd(10)}${s.category || ''}`);
    }
    console.log(`\n${skills.length} skills`);
  });

skill.command('install').description('Install a skill and write SKILL.md to local filesystem')
  .argument('<slug>', 'Skill slug or ID')
  .option('--platform <platform>', 'Target platform: claude-code, openclaw, opencode, plugin, all', 'all')
  .option('--project', 'Write to project-level path instead of global')
  .option('--no-local', 'Skip local filesystem write (cloud install only)')
  .option('--json', 'JSON output')
  .action(async (slug: string, opts: any) => {
    const client = getIMClient();

    // 1. Cloud install
    const res = await client.im.evolution.installSkill(slug);
    if (!res.ok) {
      if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
      console.error('Error:', res.error);
      process.exit(1);
    }
    const d = res.data;

    // 2. Get skill content
    let content = (d?.skill as any)?.content || '';
    if (!content) {
      try {
        const contentRes = await client.im.evolution.getSkillContent(slug);
        if (contentRes.ok && contentRes.data?.content) {
          content = contentRes.data.content;
        }
      } catch {}
    }

    // 3. Write to local filesystem
    let localResults: { written: string[]; errors: Array<{ path: string; error: string }> } | null = null;
    if (opts.local !== false && content) {
      localResults = writeSkillToLocal(slug, content, opts.platform as SkillPlatform, !!opts.project);
    }

    // 4. Output
    if (opts.json) {
      console.log(JSON.stringify({
        ...res,
        local: localResults ? { written: localResults.written, errors: localResults.errors } : null,
      }, null, 2));
      return;
    }

    console.log(`Installed: ${d?.skill?.name || slug}`);
    console.log(`  Skill ID:  ${d?.agentSkill?.id || '-'}`);
    console.log(`  Version:   ${d?.agentSkill?.version || '-'}`);
    console.log(`  Status:    ${d?.agentSkill?.status || '-'}`);
    if (d?.gene) console.log(`  Gene:      ${(d.gene as unknown as Record<string, unknown>).id}`);
    if (d?.installGuide && Object.keys(d.installGuide).length > 0) {
      console.log('\nInstall Guide:');
      for (const [key, val] of Object.entries(d.installGuide)) {
        const v = val as Record<string, unknown>;
        if (v.command) console.log(`  ${key}: ${v.command}`);
        else if (v.auto) console.log(`  ${key}: ${v.auto}`);
        else if (v.manual) console.log(`  ${key}: ${v.manual}`);
      }
    }

    if (localResults) {
      console.log('\nLocal SKILL.md:');
      printLocalWriteResults(localResults);
    } else if (opts.local === false) {
      console.log('\nLocal write skipped (--no-local).');
    } else if (!content) {
      console.log('\nNo SKILL.md content available for local write.');
    }
  });

skill.command('list').description('List installed skills')
  .option('--json', 'JSON output')
  .action(async (opts: any) => {
    const client = getIMClient();
    const res = await client.im.evolution.installedSkills();
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    const skills = res.data || [];
    if (skills.length === 0) { console.log('No skills installed.'); return; }
    for (const s of skills) {
      const sk = s.skill;
      const as_ = s.agentSkill;
      console.log(`  ${sk?.slug || sk?.id || '-'}  ${sk?.name || '(unnamed)'}  v${as_?.version || '?'}  ${as_?.status || '-'}`);
    }
    console.log(`\n${skills.length} installed`);
  });

skill.command('show').description('Show skill content')
  .argument('<slug>', 'Skill slug or ID')
  .option('--json', 'JSON output')
  .action(async (slug: string, opts: any) => {
    const client = getIMClient();
    const res = await client.im.evolution.getSkillContent(slug);
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
    const d = res.data;
    if (d?.content) {
      console.log(d.content);
    }
    if (d?.files && d.files.length > 0) {
      console.log(`\n--- Files (${d.files.length}) ---`);
      for (const f of d.files) {
        console.log(`  ${f.path}  (${f.size} bytes)`);
      }
    }
    if (d?.packageUrl) console.log(`\nPackage: ${d.packageUrl}`);
    if (d?.checksum) console.log(`Checksum: ${d.checksum}`);
  });

skill.command('uninstall').description('Uninstall a skill and remove local SKILL.md')
  .argument('<slug>', 'Skill slug or ID')
  .option('--platform <platform>', 'Target platform: claude-code, openclaw, opencode, plugin, all', 'all')
  .option('--project', 'Remove from project-level path instead of global')
  .option('--no-local', 'Skip local filesystem removal')
  .option('--json', 'JSON output')
  .action(async (slug: string, opts: any) => {
    const client = getIMClient();

    // 1. Cloud uninstall
    const res = await client.im.evolution.uninstallSkill(slug);
    if (!res.ok) {
      if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
      console.error('Error:', res.error);
      process.exit(1);
    }

    // 2. Remove local SKILL.md files
    let localResults: { removed: string[]; errors: Array<{ path: string; error: string }> } | null = null;
    if (opts.local !== false) {
      localResults = removeSkillFromLocal(slug, opts.platform as SkillPlatform, !!opts.project);
    }

    // 3. Output
    if (opts.json) {
      console.log(JSON.stringify({
        ...res,
        local: localResults ? { removed: localResults.removed, errors: localResults.errors } : null,
      }, null, 2));
      return;
    }

    console.log(`Uninstalled: ${slug}`);
    if (localResults) {
      if (localResults.removed.length > 0 || localResults.errors.length > 0) {
        console.log('\nLocal SKILL.md:');
        printLocalRemoveResults(localResults);
      }
    } else if (opts.local === false) {
      console.log('Local removal skipped (--no-local).');
    }
  });

skill.command('sync').description('Re-sync all installed skills to local filesystem')
  .option('--platform <platform>', 'Target platform: claude-code, openclaw, opencode, plugin, all', 'all')
  .option('--project', 'Write to project-level path instead of global')
  .option('--json', 'JSON output')
  .action(async (opts: any) => {
    const client = getIMClient();

    // 1. Get all installed skills
    const listRes = await client.im.evolution.installedSkills();
    if (!listRes.ok) {
      if (opts.json) { console.log(JSON.stringify(listRes, null, 2)); return; }
      console.error('Error:', listRes.error);
      process.exit(1);
    }

    const skills = listRes.data || [];
    if (skills.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ synced: 0, results: [] }, null, 2)); return; }
      console.log('No skills installed.');
      return;
    }

    const syncResults: Array<{
      slug: string;
      name: string;
      written: string[];
      errors: Array<{ path: string; error: string }>;
      skipped?: boolean;
    }> = [];

    // 2. For each skill, get content and write
    for (const s of skills) {
      const sk = s.skill;
      const slug = sk?.slug || sk?.id || '';
      const name = sk?.name || '(unnamed)';
      if (!slug) continue;

      let content = (sk as any)?.content || '';
      if (!content) {
        try {
          const contentRes = await client.im.evolution.getSkillContent(slug);
          if (contentRes.ok && contentRes.data?.content) {
            content = contentRes.data.content;
          }
        } catch {}
      }

      if (!content) {
        syncResults.push({ slug, name, written: [], errors: [], skipped: true });
        continue;
      }

      const result = writeSkillToLocal(slug, content, opts.platform as SkillPlatform, !!opts.project);
      syncResults.push({ slug, name, ...result });
    }

    // 3. Output
    if (opts.json) {
      console.log(JSON.stringify({
        synced: syncResults.filter(r => r.written.length > 0).length,
        total: skills.length,
        results: syncResults,
      }, null, 2));
      return;
    }

    console.log(`Syncing ${skills.length} installed skills...\n`);
    for (const r of syncResults) {
      if (r.skipped) {
        console.log(`  ${r.slug} (${r.name}) — no content, skipped`);
      } else if (r.written.length > 0) {
        console.log(`  ${r.slug} (${r.name})`);
        printLocalWriteResults(r);
      } else if (r.errors.length > 0) {
        console.log(`  ${r.slug} (${r.name})`);
        printLocalWriteResults(r);
      }
    }

    const synced = syncResults.filter(r => r.written.length > 0).length;
    const skipped = syncResults.filter(r => r.skipped).length;
    const failed = syncResults.filter(r => r.errors.length > 0 && r.written.length === 0).length;
    console.log(`\nDone: ${synced} synced, ${skipped} skipped, ${failed} failed`);
  });

// --- parse & run ------------------------------------------------------------

program.parse(process.argv);
