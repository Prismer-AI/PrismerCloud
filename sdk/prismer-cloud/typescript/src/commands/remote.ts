/**
 * Prismer Remote Control — Cloud SDK CLI bindings (v1.9.0)
 *
 * This CLI exposes the raw HTTP contract of `/api/im/remote/*`. The pairing
 * commands (`pair show` / `pair bind`) are DAEMON-side operations that need
 * daemon-generated keypairs; we therefore accept the full request body via
 * `--body <json>` rather than inventing fake values. For mobile-side flows
 * (`pair confirm`, `approve`, `reject`, `fs.*`) the CLI accepts concrete
 * arguments that map to the request body directly.
 */

import fs from 'fs';
import { Command } from 'commander';
import { PrismerClient } from '../index';
import type {
  ApiKeyBindRequest,
  QrInitRequest,
  RemoteCommandStatus,
} from '../remote';

type ClientFactory = () => PrismerClient;
/** Kept for signature parity with other `register(...)` command modules. */
type ApiClientFactory = () => unknown;

function parseBody(input: string): Record<string, unknown> {
  const str = input.startsWith('@') ? fs.readFileSync(input.slice(1), 'utf8') : input;
  try {
    return JSON.parse(str);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${(err as Error).message}`);
  }
}

function parseEnvelope(raw: string): Record<string, unknown> | string {
  // Accept either a JSON object (`{...}`) or a raw base64/legacy string.
  const t = raw.trim();
  if (t.startsWith('{') || t.startsWith('[')) return parseBody(t);
  return t;
}

function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function writeJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function writeLine(line: string): void {
  process.stdout.write(line);
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient?: ApiClientFactory): void {
  void _getAPIClient; // reserved — remote commands currently only need the IM client
  const remote = parent.command('remote').description('Remote control and desktop binding management (v1.9.0)');

  // ─── bindings (nested) ─────────────────────────────────────────
  // v1.9.0: previously this was three `.command('bindings ...')` siblings
  // which commander rejects with "already have command 'bindings'" since it
  // only uses the first word as the command name. We now mount them as a
  // proper subcommand group (mirrors the `fs` tree below).

  const bindings = remote.command('bindings').description('Desktop binding management');

  bindings
    .command('list')
    .description('List desktop bindings for current user')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.listBindings();
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      const items = res.data ?? [];
      if (opts.json) {
        writeJson(items);
        return;
      }
      if (items.length === 0) {
        writeLine('No desktop bindings found.\n');
        return;
      }
      process.stdout.write('Desktop Bindings:\n\n');
      for (const b of items) {
        process.stdout.write(
          `  ID:         ${b.id}\n` +
            `  Device:     ${b.deviceName ?? '(unnamed)'}\n` +
            `  Daemon ID:  ${b.daemonId}\n` +
            `  Method:     ${b.bindingMethod}\n` +
            `  Online:     ${b.isOnline ? 'yes' : 'no'}\n` +
            `  Last seq:   ${b.lastSeq}\n` +
            `  Created:    ${b.createdAt}\n` +
            `  Candidates: ${b.candidates ? b.candidates.length : 0}\n\n`,
        );
      }
    });

  bindings
    .command('delete <id>')
    .description('Revoke a desktop binding')
    .option('--json', 'Output raw JSON response')
    .action(async (id: string, opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.deleteBinding(id);
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write(`Binding ${id} deleted.\n`);
    });

  bindings
    .command('candidates <id>')
    .description('Republish LAN/relay candidates for a binding (daemon-side)')
    .requiredOption('--body <json>', 'Candidate list as JSON (array) or `@file.json`')
    .option('--json', 'Output raw JSON response')
    .action(async (id: string, opts: { body: string; json: boolean }) => {
      const parsed = parseBody(opts.body);
      const candidates = Array.isArray(parsed) ? parsed : (parsed.candidates as unknown[]);
      if (!Array.isArray(candidates)) die('body must be a JSON array or `{candidates: [...]}`');
      const client = getIMClient();
      const res = await client.remote.patchBindingCandidates(id, candidates as Parameters<typeof client.remote.patchBindingCandidates>[1]);
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data ?? { success: true });
      process.stdout.write(`Binding ${id} candidates updated.\n`);
    });

  // ─── pairing (daemon + mobile) — nested ────────────────────────

  const pair = remote.command('pair').description('QR + API-key pairing between daemon and mobile');

  pair
    .command('init')
    .description('Daemon: create a QR pairing offer (requires daemon keypair + offerBlob)')
    .requiredOption('--body <json>', 'QrInitRequest JSON or `@file.json`')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { body: string; json: boolean }) => {
      const body = parseBody(opts.body) as unknown as QrInitRequest;
      const client = getIMClient();
      const res = await client.remote.pair.qrInit(body);
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      const d = res.data!;
      process.stdout.write(`Pairing offer created:\n`);
      process.stdout.write(`  Offer ID:   ${d.offerId}\n`);
      process.stdout.write(`  Expires at: ${d.expiresAt}\n`);
    });

  pair
    .command('confirm <offerId> <clientPubKey>')
    .description('Mobile: confirm a scanned QR offer')
    .option('--device <name>', 'Consumer device name (e.g. "iPhone 16 Pro")')
    .option('--json', 'Output raw JSON response')
    .action(async (offerId: string, clientPubKey: string, opts: { device?: string; json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.pair.qrConfirm({ offerId, clientPubKey, consumerDevice: opts.device });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write('Pairing confirmed.\n');
      process.stdout.write(`  Binding ID: ${res.data?.bindingId}\n`);
      process.stdout.write(`  Daemon ID:  ${res.data?.daemonId}\n`);
    });

  pair
    .command('bind')
    .description('Daemon: API-key bind (requires daemon keypair in body)')
    .requiredOption('--body <json>', 'ApiKeyBindRequest JSON or `@file.json`')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { body: string; json: boolean }) => {
      const body = parseBody(opts.body) as unknown as ApiKeyBindRequest;
      const client = getIMClient();
      const res = await client.remote.pair.apiKeyBind(body);
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write('API-key binding created.\n');
      process.stdout.write(`  Binding ID: ${res.data?.bindingId}\n`);
    });

  // ─── commands — nested ─────────────────────────────────────────

  const commandCmd = remote.command('command').description('Remote command send + status poll');

  commandCmd
    .command('send <bindingId> <type>')
    .description('Mobile: send a remote command with an envelope payload')
    .requiredOption('--envelope <json|string>', 'Opaque envelope forwarded to the daemon')
    .option('--ttl <ms>', 'Command TTL in milliseconds')
    .option('--json', 'Output raw JSON response')
    .action(async (bindingId: string, type: string, opts: { envelope: string; ttl?: string; json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.sendCommand({
        bindingId,
        type,
        envelope: parseEnvelope(opts.envelope),
        ttlMs: opts.ttl ? parseInt(opts.ttl, 10) : undefined,
      });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write(`Command sent:\n`);
      process.stdout.write(`  Command ID: ${res.data?.commandId}\n`);
      process.stdout.write(`  Status:     ${res.data?.status as RemoteCommandStatus}\n`);
    });

  commandCmd
    .command('status <id>')
    .description('Poll status of a remote command')
    .option('--json', 'Output raw JSON response')
    .action(async (id: string, opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.getCommand(id);
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      const d = res.data!;
      process.stdout.write(`Command status:\n`);
      process.stdout.write(`  ID:         ${d.id}\n`);
      process.stdout.write(`  Type:       ${d.type}\n`);
      process.stdout.write(`  Status:     ${d.status}\n`);
      process.stdout.write(`  Created:    ${d.createdAt}\n`);
      if (d.completedAt) process.stdout.write(`  Completed:  ${d.completedAt}\n`);
    });

  remote
    .command('approve <bindingId>')
    .description('Mobile quick-approve: creates a tool_approve command with envelope')
    .requiredOption('--envelope <json|string>', 'Approval envelope (object or string)')
    .option('--task <taskId>', 'Also transition this task to `completed`')
    .option('--json', 'Output raw JSON response')
    .action(async (bindingId: string, opts: { envelope: string; task?: string; json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.approve({
        bindingId,
        envelope: parseEnvelope(opts.envelope),
        taskId: opts.task,
      });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write(`Approved (commandId=${res.data?.commandId}).\n`);
    });

  remote
    .command('reject <bindingId>')
    .description('Mobile quick-reject: creates a tool_reject command with envelope')
    .requiredOption('--envelope <json|string>', 'Rejection envelope (object or string)')
    .option('--task <taskId>', 'Also transition this task to `failed`')
    .option('--json', 'Output raw JSON response')
    .action(async (bindingId: string, opts: { envelope: string; task?: string; json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.reject({
        bindingId,
        envelope: parseEnvelope(opts.envelope),
        taskId: opts.task,
      });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write(`Rejected (commandId=${res.data?.commandId}).\n`);
    });

  // ─── push tokens — nested ──────────────────────────────────────

  const push = remote.command('push').description('APNs / FCM push-token registration');

  push
    .command('register <token>')
    .description('Register APNs / FCM push token')
    .option('--platform <platform>', 'apns|fcm', 'apns')
    .option('--device-id <id>', 'Stable device identifier')
    .option('--json', 'Output raw JSON response')
    .action(async (token: string, opts: { platform?: string; deviceId?: string; json: boolean }) => {
      const platform = (opts.platform ?? 'apns') as 'apns' | 'fcm';
      if (platform !== 'apns' && platform !== 'fcm') die('--platform must be apns or fcm');
      const client = getIMClient();
      const res = await client.remote.registerPushToken({ platform, token, deviceId: opts.deviceId });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write('Push token registered.\n');
    });

  push
    .command('list')
    .description("List the current user's registered push tokens")
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.listPushTokens();
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) {
        writeJson(res.data);
        return;
      }
      const tokens = res.data?.tokens ?? [];
      if (tokens.length === 0) {
        writeLine('No push tokens registered.\n');
        return;
      }
      for (const t of tokens) {
        process.stdout.write(`  ${t.id}  ${t.platform}  ${t.deviceId ?? '(no device id)'}  created=${t.createdAt}\n`);
      }
    });

  push
    .command('delete <tokenId>')
    .description('Revoke a push token by ID')
    .option('--json', 'Output raw JSON response')
    .action(async (tokenId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.deletePushToken(tokenId);
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write(`Push token ${tokenId} deleted.\n`);
    });

  // ─── fs relay (mobile → daemon) ────────────────────────────────

  const fsCmd = remote.command('fs').description('Mobile → daemon FS relay (sandbox-bounded)');

  fsCmd
    .command('read <bindingId> <path>')
    .option('--encoding <enc>', 'utf-8|base64', 'utf-8')
    .option('--json', 'Output raw JSON response')
    .action(async (bindingId: string, p: string, opts: { encoding?: string; json: boolean }) => {
      const encoding = (opts.encoding ?? 'utf-8') as 'utf-8' | 'base64';
      const client = getIMClient();
      const res = await client.remote.fs(bindingId).read({ path: p, encoding });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      process.stdout.write(res.data?.content ?? '');
    });

  fsCmd
    .command('list <bindingId> <path>')
    .option('-r, --recursive', 'Recurse into subdirectories')
    .option('--json', 'Output raw JSON response')
    .action(async (bindingId: string, p: string, opts: { recursive?: boolean; json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.fs(bindingId).list({ path: p, recursive: opts.recursive });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      for (const e of res.data?.entries ?? []) {
        process.stdout.write(`  ${e.type.padEnd(7)} ${e.size ?? ''}\t${e.name}\n`);
      }
    });

  fsCmd
    .command('search <bindingId> <path> <pattern>')
    .option('--glob <glob>', 'File-name glob (e.g. "*.ts")')
    .option('--json', 'Output raw JSON response')
    .action(async (bindingId: string, p: string, pattern: string, opts: { glob?: string; json: boolean }) => {
      const client = getIMClient();
      const res = await client.remote.fs(bindingId).search({ path: p, pattern, glob: opts.glob });
      if (!res.ok) die(res.error?.message ?? JSON.stringify(res.error));
      if (opts.json) return writeJson(res.data);
      for (const m of res.data?.matches ?? []) {
        process.stdout.write(`  ${m.path}:${m.line}  ${m.preview}\n`);
      }
    });
}
