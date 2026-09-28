import { Command } from 'commander';
import { PrismerClient } from '../index';
import { detectDeliverProxy, proxyDeliver } from './deliver-proxy';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const file = parent
    .command('file')
    .description('File upload, transfer, quota, and type management');

  // ---------------------------------------------------------------------------
  // file upload <path>
  // ---------------------------------------------------------------------------
  file
    .command('upload <path>')
    .description(
      'Upload bytes only → returns an upload ID + CDN URL. NOT a delivery: nothing reaches the user. ' +
        'To deliver an artifact use `cloud deliver <path>`.',
    )
    .option('--mime <type>', 'Override MIME type (e.g. image/png)')
    .option('--json', 'Output raw JSON response')
    .action(async (filePath: string, opts: { mime?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const uploadOpts: { mimeType?: string } = {};
        if (opts.mime) uploadOpts.mimeType = opts.mime;
        const res = await client.im.files.upload(filePath, Object.keys(uploadOpts).length ? uploadOpts : undefined);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Uploaded: ${res.fileName}\n`);
        process.stdout.write(`Upload ID: ${res.uploadId}\n`);
        process.stdout.write(`CDN URL:   ${res.cdnUrl}\n`);
        process.stdout.write(`Size:      ${res.fileSize} bytes\n`);
        process.stdout.write(`MIME:      ${res.mimeType}\n`);
        // Guard against the common mistake of treating `upload` as delivery —
        // it only stages bytes; nothing is attached/sent until you deliver.
        process.stdout.write(
          'Note: this only uploaded bytes — nothing was delivered to the user. ' +
            'To deliver an artifact, run `cloud deliver <abs-path>`.\n',
        );
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // file send <conversation-id> <path>
  // ---------------------------------------------------------------------------
  file
    .command('send <conversation-id> <path>')
    .description(
      'Send a file as its OWN standalone message (ad-hoc sharing). For a final ' +
        'deliverable use `cloud deliver` instead — do not run both on the same file (double-delivery).',
    )
    .option('-c, --content <text>', 'Optional text caption to accompany the file')
    .option('--mime <type>', 'Override MIME type')
    // release202/09 P5#1 — hermes has no per-dispatch env; the agent copies the
    // ids out of <execution_context> and passes them as flags so the daemon
    // proxy activates. On `file send` the convId already arrives as the
    // positional <conversation-id> (hermes passes it today), so the proxy's
    // send-mode target is covered; --run-id / --daemon-port are what newly
    // activate the proxy on hermes. --conversation-id is accepted as an
    // alternative source and overrides the positional only when the positional
    // is omitted (commander keeps the positional required for back-compat).
    // Spawn adapters (claude-code / codex) set the env and need no flags.
    .option('--run-id <id>', 'dispatch run/task id (from <execution_context>; env fallback PRISMER_TASK_ID/RUN_ID)')
    .option('--conversation-id <id>', 'conversation id (alternative source; positional <conversation-id> takes precedence)')
    .option('--daemon-port <port>', 'daemon local-server port (env fallback PRISMER_DAEMON_PORT, default 3210)')
    .option('--json', 'Output raw JSON response')
    .action(async (
      conversationIdArg: string,
      filePath: string,
      opts: { content?: string; mime?: string; json: boolean; runId?: string; conversationId?: string; daemonPort?: string },
    ) => {
      // Positional <conversation-id> wins for back-compat; --conversation-id is
      // an alternative source used only when the positional is absent.
      const conversationId = conversationIdArg || opts.conversationId || '';
      // release202/09 P2 — when running in-container under a daemon dispatch,
      // proxy to the daemon local-server (动作 B / mode:'send'). The agent has
      // no usable IM credential; only the daemon can author the message. Falls
      // through to the direct IM-API path for non-container callers
      // (`prismer pair` users on their own machine).
      const proxy = detectDeliverProxy({
        runId: opts.runId,
        conversationId,
        daemonPort: opts.daemonPort,
      });
      if (proxy) {
        const result = await proxyDeliver(proxy, filePath, 'send', conversationId);
        if (!result.ok) {
          process.stderr.write(`Error: ${result.error ?? 'delivery failed'}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(`File sent to conversation ${conversationId} (assetId: ${result.assetId ?? '-'})\n`);
        return;
      }
      const client = getIMClient();
      try {
        const sendOpts: { content?: string; mimeType?: string } = {};
        if (opts.content) sendOpts.content = opts.content;
        if (opts.mime) sendOpts.mimeType = opts.mime;
        const res = await client.im.files.sendFile(
          conversationId,
          filePath,
          Object.keys(sendOpts).length ? sendOpts : undefined,
        );
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }
        process.stdout.write(`File sent (messageId: ${res.message?.id || res.message?.messageId || '-'})\n`);
        process.stdout.write(`Upload ID: ${res.upload?.uploadId || '-'}\n`);
        process.stdout.write(`CDN URL:   ${res.upload?.cdnUrl || '-'}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // file quota
  // ---------------------------------------------------------------------------
  file
    .command('quota')
    .description('Show file storage quota and usage')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.im.files.quota();
      if (!res.ok) {
        process.stderr.write(`Error: ${JSON.stringify(res)}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
        return;
      }
      const d = res.data;
      process.stdout.write(`Tier:       ${d?.tier || '-'}\n`);
      process.stdout.write(`Used:       ${d?.used ?? '-'} bytes\n`);
      process.stdout.write(`Limit:      ${d?.limit ?? '-'} bytes\n`);
      process.stdout.write(`File Count: ${d?.fileCount ?? '-'}\n`);
    });

  // ---------------------------------------------------------------------------
  // file delete <upload-id>
  // ---------------------------------------------------------------------------
  file
    .command('delete <upload-id>')
    .description('Delete an uploaded file by its upload ID')
    .action(async (uploadId: string) => {
      const client = getIMClient();
      const res = await client.im.files.delete(uploadId);
      if (!res.ok) {
        process.stderr.write(`Error: ${JSON.stringify(res)}\n`);
        process.exit(1);
      }
      process.stdout.write(`File ${uploadId} deleted.\n`);
    });

  // ---------------------------------------------------------------------------
  // file types
  // ---------------------------------------------------------------------------
  file
    .command('types')
    .description('List allowed MIME types for file uploads')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      const res = await client.im.files.types();
      if (!res.ok) {
        process.stderr.write(`Error: ${JSON.stringify(res)}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
        return;
      }
      const types = res.data?.allowedMimeTypes || [];
      if (types.length === 0) {
        process.stdout.write('No allowed MIME types returned.\n');
        return;
      }
      process.stdout.write('Allowed MIME types:\n');
      for (const t of types) {
        process.stdout.write(`  ${t}\n`);
      }
    });
}
