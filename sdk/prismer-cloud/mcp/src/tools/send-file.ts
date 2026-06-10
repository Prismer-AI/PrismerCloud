import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { getApiKey, getBaseUrl } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Minimal extension → mime lookup. Covers the common cases an LLM is
 * likely to send (text, code, images, archives, common docs). Anything
 * not in this map falls back to application/octet-stream — cloud accepts
 * that and the chat surface treats it as a generic file row.
 */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  js: 'application/javascript',
  ts: 'application/typescript',
  py: 'text/x-python',
  go: 'text/x-go',
  rs: 'text/x-rust',
  sh: 'application/x-sh',
  pdf: 'application/pdf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

function detectMime(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Phase B (Wave-9) — explicit asset attachment tool for agents.
 *
 * Path-A capture (auto-collect from `${PRISMER_ARTIFACTS_DIR}` via daemon's
 * ArtifactsWatcher) handles the common case where the LLM writes files
 * during execution. This tool covers the explicit case: the LLM has
 * already produced a file (or wants to expose one from the workspace)
 * and wants it attached to its reply RIGHT NOW.
 *
 * Behavior:
 *   1. Read the file at `path` (must be absolute or readable from cwd).
 *   2. Multipart POST to `/api/im/assets` with kind=agent-output.
 *   3. **Move/copy the uploaded file into `$PRISMER_ARTIFACTS_DIR`** (or the
 *      legacy `$PRISMER_OUTBOX_DIR` alias) as a side-effect when the env var
 *      is set. Why: dispatch.ts drains ArtifactsWatcher.flushPending() at
 *      reply time and that's how assetIds flow into
 *      task.dispatch.reply.assetIds. Direct upload from the tool gets the
 *      asset row created on cloud, but unless it also lands in the artifacts
 *      dir the daemon's flush won't see it.
 *      Copying (not moving) keeps the original path stable for the
 *      adapter's other tools. The watcher dedupes on
 *      path:mtime:size, so the second-pass scan won't re-upload.
 *
 * The tool returns the `assetId` so the LLM can reference it in its
 * textual reply ("uploaded as asset abc123…") if useful, but the
 * primary effect is that the daemon will surface the file as a chat
 * attachment when the dispatch closes.
 */
export function registerSendFile(server: McpServer) {
  server.tool(
    'prismer.message.sendFile',
    [
      'Attach a file as a chat attachment in the user-visible reply.',
      'Use this when the user asks you to send/share/deliver/attach a file, image,',
      'document, archive, report, or any artifact. The file will appear as a',
      'thumbnail/preview in the chat alongside your text reply.',
      '',
      'Prefer writing the file under $PRISMER_ARTIFACTS_DIR — those are auto-attached.',
      'Use this tool only when you need to attach a file that already exists',
      'somewhere else on disk, or when you want explicit control over the',
      'attachment metadata (title).',
    ].join(' '),
    {
      path: z
        .string()
        .min(1)
        .describe(
          'Absolute (or cwd-relative) path to the local file to attach. Must be readable.',
        ),
      title: z
        .string()
        .optional()
        .describe(
          'Optional human-readable title for the attachment. Defaults to the file basename.',
        ),
      workspaceId: z
        .string()
        .optional()
        .describe(
          'Workspace to upload into. If omitted, uses PRISMER_WORKSPACE_ID env (set by daemon).',
        ),
      mime: z
        .string()
        .optional()
        .describe(
          'Override the auto-detected MIME type. Usually omit; the tool inspects the path.',
        ),
    },
    async ({ path: filePath, title, workspaceId, mime }) => {
      try {
        const apiKey = getApiKey();
        if (!apiKey) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: PRISMER_API_KEY not configured. Run `npx prismer setup`.',
              },
            ],
          };
        }
        const ws = workspaceId || process.env.PRISMER_WORKSPACE_ID || '';
        if (!ws) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: workspaceId not provided and PRISMER_WORKSPACE_ID env is unset.',
              },
            ],
          };
        }
        const abs = path.resolve(filePath);
        let bytes: Buffer;
        try {
          bytes = await fs.readFile(abs);
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error reading file ${abs}: ${(err as Error).message}`,
              },
            ],
          };
        }
        const fileName = path.basename(abs);
        const detectedMime = mime || detectMime(fileName);

        // Side-effect: copy into the artifacts dir so the daemon's watcher
        // picks it up and includes the resulting assetId in reply.assetIds.
        // This is the load-bearing piece — without it, direct upload creates
        // an orphan asset row that the user never sees.
        //
        // Backward-compat (release202/04 §3.1): prefer the new
        // PRISMER_ARTIFACTS_DIR; fall back to the legacy PRISMER_OUTBOX_DIR so
        // a stale daemon that only sets the old env still works.
        const outboxDir = process.env.PRISMER_ARTIFACTS_DIR ?? process.env.PRISMER_OUTBOX_DIR;
        if (outboxDir) {
          try {
            await fs.mkdir(outboxDir, { recursive: true });
            const outboxTarget = path.join(outboxDir, fileName);
            // Copy (not move) so the source path stays stable for any
            // downstream tool the LLM may invoke after this.
            await fs.copyFile(abs, outboxTarget);
            // Surface the outbox path back to the LLM so it knows the
            // attachment is in flight.
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Queued ${fileName} for attachment.\n` +
                    `Path: ${outboxTarget}\n` +
                    `Detected MIME: ${detectedMime}\n` +
                    `Title: ${title ?? fileName}\n` +
                    `Size: ${bytes.length} bytes\n` +
                    'It will be auto-uploaded and shown in the chat as an attachment when the task replies.',
                },
              ],
            };
          } catch (err) {
            // Outbox copy failed — fall through to direct upload as a
            // best-effort fallback. User may not see it in reply unless
            // the daemon picks it up via another mechanism.
            process.stderr.write(
              `[prismer.message.sendFile] outbox copy failed: ${(err as Error).message}; falling back to direct upload\n`,
            );
          }
        }

        // Fallback / no-outbox path: upload directly. Asset row is
        // created in cloud; LLM gets the assetId. May not appear in
        // chat unless caller wires it manually.
        const baseUrl = getBaseUrl();
        const url = new URL('/api/im/assets', baseUrl);
        const blob = new Blob([new Uint8Array(bytes)], { type: detectedMime });
        const form = new FormData();
        form.append('workspaceId', ws);
        form.append('kind', 'agent-output');
        form.append('file', blob, fileName);
        const meta: Record<string, unknown> = {};
        if (title) meta.title = title;
        if (Object.keys(meta).length > 0) {
          form.append('metadata', JSON.stringify(meta));
        }
        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Upload failed: ${res.status} ${text.slice(0, 200)}`,
              },
            ],
          };
        }
        const body = (await res.json()) as { ok?: boolean; data?: { id?: string } };
        const assetId = body?.data?.id ?? '(unknown)';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Uploaded ${fileName} as asset ${assetId}.\n` +
                `Note: PRISMER_ARTIFACTS_DIR was not set, so this asset is created but may not auto-attach to the chat reply. ` +
                `Mention assetId=${assetId} in your text reply if you want the user to see a reference.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `prismer.message.sendFile failed: ${(err as Error).message}`,
            },
          ],
        };
      }
    },
  );
}
