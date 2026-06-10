#!/usr/bin/env tsx
/**
 * Release200/07 asset -> agent readability smoke.
 *
 * Requires an already-running `npm run dev:full` (default
 * http://127.0.0.1:3000). This script verifies the cloud-side path that makes
 * a chat attachment readable by an agent:
 *
 *   upload text asset with SHA-256 -> send @agent message with root
 *   attachments -> mention dispatch creates task_run -> task_run metadata
 *   contains assets.aggregatedAssetIds -> dispatch observability requested the
 *   asset ref for the daemon.
 *
 * If a local daemon is running on PRISMER_DAEMON_URL, the script also verifies
 * `/local/asset/read` can fetch and read the attached asset bytes from the
 * daemon cache/index.
 *
 * Required env:
 *   PRISMER_ASSET_AGENT_TOKEN or PRISMER_JWT
 *   PRISMER_WORKSPACE_ID
 *   PRISMER_CONVERSATION_ID
 *
 * Optional env:
 *   PRISMER_BASE_URL (default http://127.0.0.1:3000)
 *   PRISMER_ASSET_AGENT_USERNAME (default ceo)
 *   PRISMER_DAEMON_URL (default http://127.0.0.1:3210)
 *   PRISMER_ASSET_AGENT_REQUIRE_DAEMON=1 to fail when daemon read is absent
 *   PRISMER_ASSET_AGENT_EXPECT_REPLY=1 to wait for an agent reply containing
 *     the marker (requires an online, working agent runtime).
 */

import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';

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
  senderId?: string;
  content: string;
  metadata?: unknown;
  attachments?: Array<{ assetId?: string; id?: string }> | null;
  createdAt?: string;
}

interface TaskRunDTO {
  id: string;
  triggerMessageId?: string | null;
  status: string;
  runtimeRoute?: string | null;
  assigneeId?: string | null;
  metadata?: Record<string, unknown> | null;
}

const baseUrl = (process.env.PRISMER_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const daemonUrl = (process.env.PRISMER_DAEMON_URL ?? 'http://127.0.0.1:3210').replace(/\/+$/, '');
const token = process.env.PRISMER_ASSET_AGENT_TOKEN ?? process.env.PRISMER_JWT ?? '';
const workspaceId = process.env.PRISMER_WORKSPACE_ID ?? '';
const conversationId = process.env.PRISMER_CONVERSATION_ID ?? '';
const agentUsername = (process.env.PRISMER_ASSET_AGENT_USERNAME ?? 'ceo').replace(/^@/, '');
const requireDaemon = process.env.PRISMER_ASSET_AGENT_REQUIRE_DAEMON === '1';
const expectReply = process.env.PRISMER_ASSET_AGENT_EXPECT_REPLY === '1';

function required(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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

async function uploadMarkerAsset(marker: string): Promise<AssetDTO> {
  const filename = `release200-agent-read-${Date.now()}.txt`;
  const bytes = Buffer.from(
    [
      'release200 asset agent read smoke',
      `marker=${marker}`,
      'The marker must only be available through this attachment.',
      '',
    ].join('\n'),
    'utf8',
  );
  const digest = sha256(bytes);
  const form = new FormData();
  form.set('workspaceId', workspaceId);
  form.set('kind', 'file');
  form.set('contentSha256', digest);
  form.set('metadata', JSON.stringify({ title: filename, conversationId, smoke: 'release200-asset-agent-read' }));
  form.set('file', new Blob([bytes], { type: 'text/plain' }), filename);

  const asset = await api<AssetDTO>('/api/im/assets', {
    method: 'POST',
    headers: { 'X-Content-Sha256': digest },
    body: form,
  });
  if (asset.contentHash !== digest) {
    throw new Error(`uploaded contentHash mismatch: expected ${digest}, got ${asset.contentHash}`);
  }
  return asset;
}

async function sendAgentAttachmentMessage(asset: AssetDTO): Promise<MessageDTO> {
  const filename = asset.filename ?? `asset-${asset.id}.txt`;
  const prismerUri = `prismer://workspace/${workspaceId}/asset/${asset.contentHash}`;
  const sent = await api<{ message: MessageDTO }>(`/api/im/messages/${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'markdown',
      content: `@${agentUsername} read the attached file and reply with the marker value only.\n\n${prismerUri}`,
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

async function createWorkspaceFile(asset: AssetDTO): Promise<void> {
  const filename = asset.filename ?? `asset-${asset.id}.txt`;
  await api(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/files`, {
    method: 'POST',
    body: JSON.stringify({
      path: `release200-agent-read/${filename}`,
      assetId: asset.id,
    }),
  });
}

async function waitForAgentRun(messageId: string, assetId: string): Promise<TaskRunDTO> {
  const deadline = Date.now() + 10_000;
  let lastRuns: TaskRunDTO[] = [];
  let lastRun: TaskRunDTO | undefined;
  let lastError = '';
  while (Date.now() < deadline) {
    const runs = await api<TaskRunDTO[]>(
      `/api/im/tasks?view=runs&workspaceId=${encodeURIComponent(workspaceId)}&conversationId=${encodeURIComponent(
        conversationId,
      )}&sourceKind=chat_mention&limit=20`,
    );
    lastRuns = runs;
    const run = runs.find((item) => item.triggerMessageId === messageId);
    if (run) {
      lastRun = run;
      try {
        assertRunCarriesAsset(run, assetId);
        return run;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (lastRun) {
    throw new Error(`task_run ${lastRun.id} did not converge asset dispatch metadata: ${lastError}`);
  }
  throw new Error(`no chat_mention task_run found for message ${messageId}; recent runs=${JSON.stringify(lastRuns)}`);
}

function assertRunCarriesAsset(run: TaskRunDTO, assetId: string): void {
  const metadata = run.metadata ?? {};
  const assets = readRecord(metadata.assets);
  const aggregated = assets.aggregatedAssetIds;
  if (!Array.isArray(aggregated) || !aggregated.includes(assetId)) {
    throw new Error(`task_run ${run.id} missing metadata.assets.aggregatedAssetIds ${assetId}`);
  }

  const observability = readRecord(metadata.observability);
  const observedAssets = readRecord(observability.assets);
  const requestedRefs = observedAssets.requestedRefs;
  if (!Array.isArray(requestedRefs)) {
    throw new Error(`task_run ${run.id} missing observability.assets.requestedRefs`);
  }
  const requested = requestedRefs.some((item) => readRecord(item).assetId === assetId);
  if (!requested) {
    throw new Error(`task_run ${run.id} observability did not request asset ${assetId}`);
  }
}

async function tryDaemonRead(assetId: string, marker: string): Promise<{ status: string; detail?: unknown }> {
  const deadline = Date.now() + 12_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${daemonUrl}/local/asset/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, assetId, length: 4096 }),
      });
      const body = (await res.json().catch(() => null)) as {
        content?: unknown;
        error?: string;
        message?: string;
      } | null;
      if (!res.ok) {
        lastError = body?.message ?? body?.error ?? `HTTP ${res.status}`;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (typeof body?.content !== 'string' || !body.content.includes(marker)) {
        throw new Error('daemon read succeeded but marker was missing from returned content');
      }
      return { status: 'ok' };
    } catch (err) {
      lastError = (err as Error).message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (requireDaemon) throw new Error(lastError || 'daemon read timed out');
  return { status: 'skipped', detail: lastError || 'daemon read timed out' };
}

async function waitForMarkerReply(messageId: string, marker: string): Promise<MessageDTO | null> {
  if (!expectReply) return null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const data = await api<{ messages?: MessageDTO[] } | MessageDTO[]>(
      `/api/im/messages/${encodeURIComponent(conversationId)}?limit=40`,
    );
    const messages = Array.isArray(data) ? data : (data.messages ?? []);
    const triggerIndex = messages.findIndex((item) => item.id === messageId);
    const newer = triggerIndex >= 0 ? messages.slice(0, triggerIndex) : messages;
    const hit = newer.find((item) => item.content.includes(marker));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`no agent reply containing marker ${marker} within 120s`);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function main() {
  required('PRISMER_ASSET_AGENT_TOKEN or PRISMER_JWT', token);
  required('PRISMER_WORKSPACE_ID', workspaceId);
  required('PRISMER_CONVERSATION_ID', conversationId);

  const marker = `asset-agent-read-${randomUUID()}`;
  const asset = await uploadMarkerAsset(marker);
  await createWorkspaceFile(asset);
  const message = await sendAgentAttachmentMessage(asset);
  const run = await waitForAgentRun(message.id, asset.id);
  const daemonRead = await tryDaemonRead(asset.id, marker);
  const reply = await waitForMarkerReply(message.id, marker);

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        workspaceId,
        conversationId,
        agentUsername,
        assetId: asset.id,
        contentHash: asset.contentHash,
        messageId: message.id,
        taskRunId: run.id,
        taskRunStatus: run.status,
        daemonRead,
        replyId: reply?.id ?? null,
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
