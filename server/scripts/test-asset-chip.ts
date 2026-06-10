#!/usr/bin/env tsx
/**
 * Local asset-chain smoke for release200/07.
 *
 * Requires an already-running `npm run dev:full` (default
 * http://127.0.0.1:3000). The script exercises the closeable local loop:
 *
 *   upload xlsx with SHA-256 -> create workspace file -> send chat message
 *   with root attachments + prismer:// URI -> fetch history -> open the
 *   deep-linked spreadsheet preview in Playwright.
 *
 * Required env:
 *   PRISMER_ASSET_SMOKE_TOKEN or PRISMER_JWT
 *   PRISMER_WORKSPACE_ID
 *   PRISMER_CONVERSATION_ID
 *
 * Optional env:
 *   PRISMER_BASE_URL (default http://127.0.0.1:3000)
 *   PRISMER_ASSET_SMOKE_BROWSER=0 to skip Playwright
 *   PRISMER_ASSET_SMOKE_ALLOW_LEGACY_METADATA=1 to continue when an
 *     unrestarted dev singleton still returns attachments=null but metadata
 *     contains the assetIds bridge.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import * as XLSX from 'xlsx';

interface ApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string | { code?: string; message?: string };
  message?: string;
}

interface AssetDTO {
  id: string;
  contentHash: string;
  mime: string | null;
  kind: string;
  sizeBytes: number | null;
  filename?: string | null;
  revision?: number | null;
}

interface MessageDTO {
  id: string;
  conversationId?: string;
  content: string;
  metadata?: string | Record<string, unknown> | null;
  attachments?: Array<{ assetId?: string; id?: string }> | null;
}

interface SyncEventDTO {
  seq: number;
  type: string;
  data?: MessageDTO;
}

const baseUrl = (process.env.PRISMER_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = process.env.PRISMER_ASSET_SMOKE_TOKEN ?? process.env.PRISMER_JWT ?? '';
const workspaceId = process.env.PRISMER_WORKSPACE_ID ?? '';
const conversationId = process.env.PRISMER_CONVERSATION_ID ?? '';
const runBrowser = process.env.PRISMER_ASSET_SMOKE_BROWSER !== '0';
const allowLegacyMetadata = process.env.PRISMER_ASSET_SMOKE_ALLOW_LEGACY_METADATA === '1';

function required(name: string, value: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['release', 'case', 'status'],
    ['v2.0', 'asset upload', 'ok'],
    ['v2.0', 'xlsx preview', 'ok'],
    ['v2.0', 'chat attachment', 'ok'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Smoke');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function api<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || body?.ok === false) {
    const err = body?.error;
    const code = typeof err === 'string' ? err : err?.code;
    const message = typeof err === 'string' ? err : (err?.message ?? body?.message ?? `HTTP ${res.status}`);
    throw new Error(`${code ?? 'request_failed'}: ${message}`);
  }
  return body?.data as T;
}

async function uploadAsset(bytes: Buffer, filename: string, digest: string): Promise<AssetDTO> {
  const form = new FormData();
  form.set('workspaceId', workspaceId);
  form.set('kind', 'file');
  form.set('contentSha256', digest);
  form.set(
    'metadata',
    JSON.stringify({
      title: filename,
      conversationId,
      smoke: 'release200-asset-chain',
    }),
  );
  form.set(
    'file',
    new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    filename,
  );
  return api<AssetDTO>('/api/im/assets', {
    method: 'POST',
    headers: { 'X-Content-Sha256': digest },
    body: form,
  });
}

async function createWorkspaceFile(asset: AssetDTO, filename: string): Promise<void> {
  await api(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/files`, {
    method: 'POST',
    body: JSON.stringify({
      path: `release200-smoke/${filename}`,
      assetId: asset.id,
    }),
  });
}

async function sendAttachmentMessage(asset: AssetDTO, filename: string): Promise<MessageDTO> {
  const prismerUri = `prismer://workspace/${workspaceId}/asset/${asset.contentHash}`;
  const sent = await api<{ message: MessageDTO }>(`/api/im/messages/${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'markdown',
      content: `Asset smoke ${filename}\n\n${prismerUri}`,
      metadata: {
        kind: 'workspace_asset_attachment',
        assetIds: [asset.id],
        asset: {
          id: asset.id,
          assetId: asset.id,
          title: filename,
          kind: 'file',
          mime: asset.mime,
          sizeBytes: asset.sizeBytes,
          contentHash: asset.contentHash,
        },
      },
      attachments: [
        {
          kind: 'file',
          assetId: asset.id,
          title: filename,
          filename,
          mime: asset.mime,
          sizeBytes: asset.sizeBytes,
          contentHash: asset.contentHash,
          revision: asset.revision ?? 1,
          role: 'attachment',
        },
      ],
    }),
  });
  return sent.message;
}

async function currentSyncCursor(): Promise<number> {
  let cursor = 0;
  for (let page = 0; page < 50; page += 1) {
    const data = await api<{ cursor?: number; hasMore?: boolean }>(`/api/im/sync?since=${cursor}&limit=500`);
    cursor = typeof data.cursor === 'number' ? data.cursor : cursor;
    if (!data.hasMore) return cursor;
  }
  return cursor;
}

async function assertAttachmentSyncEvent(since: number, messageId: string, assetId: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let cursor = since;
  let lastMatches: SyncEventDTO[] = [];

  while (Date.now() < deadline) {
    const data = await api<{ events?: SyncEventDTO[]; cursor?: number; hasMore?: boolean }>(
      `/api/im/sync?since=${cursor}&limit=100`,
    );
    const events = data.events ?? [];
    lastMatches = events.filter((event) => event.data?.id === messageId);
    const hit = lastMatches.find((event) =>
      (event.data?.attachments ?? []).some((item) => item.assetId === assetId || item.id === assetId),
    );
    if (hit) return hit.type;
    cursor = typeof data.cursor === 'number' ? data.cursor : cursor;
    if (!data.hasMore) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `message ${messageId} is missing attachment sync event for ${assetId}: ${JSON.stringify(lastMatches)}`,
  );
}

async function assertHistory(messageId: string, assetId: string): Promise<'root-attachments' | 'legacy-metadata'> {
  const data = await api<{ messages?: MessageDTO[] } | MessageDTO[]>(
    `/api/im/messages/${encodeURIComponent(conversationId)}?limit=20`,
  );
  const messages = Array.isArray(data) ? data : (data.messages ?? []);
  const message = messages.find((item) => item.id === messageId);
  if (!message) throw new Error(`message ${messageId} not found in history`);
  const hasRootAttachment = (message.attachments ?? []).some((item) => item.assetId === assetId || item.id === assetId);
  if (hasRootAttachment) return 'root-attachments';
  if (allowLegacyMetadata && messageMetadataHasAsset(message.metadata, assetId)) return 'legacy-metadata';
  throw new Error(`message ${messageId} is missing root attachment ${assetId}`);
}

function messageMetadataHasAsset(metadata: MessageDTO['metadata'], assetId: string): boolean {
  let meta: Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      meta = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  } else if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    meta = metadata;
  } else {
    return false;
  }
  const ids = meta.assetIds;
  if (Array.isArray(ids) && ids.includes(assetId)) return true;
  const asset = meta.asset;
  return Boolean(
    asset &&
    typeof asset === 'object' &&
    !Array.isArray(asset) &&
    ((asset as { id?: unknown }).id === assetId || (asset as { assetId?: unknown }).assetId === assetId),
  );
}

async function assertBrowserPreview(assetId: string): Promise<string> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const browserUser = browserUserFromJwt(token);
  await context.addInitScript(
    ({ jwt, user }: { jwt: string; user: ReturnType<typeof browserUserFromJwt> }) => {
      localStorage.setItem(
        'prismer_auth',
        JSON.stringify({
          token: jwt,
          user,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        }),
      );
    },
    { jwt: token, user: browserUser },
  );
  const page = await context.newPage();
  await page.goto(`${baseUrl}/workspace?asset=${encodeURIComponent(assetId)}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-asset-inspector-panel').waitFor({ timeout: 30_000 });
  await page.getByTestId('asset-preview-spreadsheet').waitFor({ timeout: 30_000 });
  const badZip = page.getByText('Unsupported ZIP Compression method', { exact: false });
  if ((await badZip.count()) > 0) throw new Error('spreadsheet preview showed Unsupported ZIP Compression method');
  const screenshot = path.join('/tmp', `prismer-asset-smoke-${assetId}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await browser.close();
  return screenshot;
}

function browserUserFromJwt(jwt: string) {
  let payload: { numericId?: unknown; email?: unknown } = {};
  try {
    payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    payload = {};
  }
  return {
    id: typeof payload.numericId === 'number' ? payload.numericId : 0,
    email: typeof payload.email === 'string' ? payload.email : 'asset-smoke@local.test',
    avatar: '',
    is_active: true,
    email_verified: true,
    last_login_at: '',
    google_id: '',
    github_id: '',
    created_at: '',
    updated_at: '',
    deleted_at: null,
  };
}

async function main() {
  required('PRISMER_ASSET_SMOKE_TOKEN or PRISMER_JWT', token);
  required('PRISMER_WORKSPACE_ID', workspaceId);
  required('PRISMER_CONVERSATION_ID', conversationId);

  const bytes = makeWorkbook();
  const digest = sha256(bytes);
  const filename = `release200-asset-smoke-${Date.now()}.xlsx`;
  const asset = await uploadAsset(bytes, filename, digest);
  if (asset.contentHash !== digest) {
    throw new Error(`uploaded contentHash mismatch: expected ${digest}, got ${asset.contentHash}`);
  }
  await createWorkspaceFile(asset, filename);
  const syncCursor = await currentSyncCursor();
  const message = await sendAttachmentMessage(asset, filename);
  const historyMode = await assertHistory(message.id, asset.id);
  const syncEventType = await assertAttachmentSyncEvent(syncCursor, message.id, asset.id);
  const screenshot = runBrowser ? await assertBrowserPreview(asset.id) : null;

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        workspaceId,
        conversationId,
        assetId: asset.id,
        contentHash: asset.contentHash,
        messageId: message.id,
        historyMode,
        syncEventType,
        screenshot,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
