import { Command } from 'commander';
import { PrismerClient } from '../index';

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
    .description('Upload a file and get its upload ID and CDN URL')
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
    .description('Upload a file and send it as a message in a conversation')
    .option('-c, --content <text>', 'Optional text caption to accompany the file')
    .option('--mime <type>', 'Override MIME type')
    .option('--json', 'Output raw JSON response')
    .action(async (conversationId: string, filePath: string, opts: { content?: string; mime?: string; json: boolean }) => {
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
