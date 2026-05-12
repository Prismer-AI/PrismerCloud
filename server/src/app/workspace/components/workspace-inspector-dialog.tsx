'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { DataGrid, type Column } from 'react-data-grid';
import {
  Archive,
  Bot,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Edit3,
  ExternalLink,
  FileCode2,
  FileText,
  Film,
  ImageIcon,
  Laptop,
  Loader2,
  Music,
  Pause,
  Sparkles,
  Smartphone,
  Table2,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { radius, surface, avatarGradient, avatarInitials } from '../lib/design';
import type {
  AgentDTO,
  AgentProfileDTO,
  AssetDTO,
  RuntimeDeviceDTO,
  WorkspaceFileDTO,
  WorkspaceRuntimeDTO,
} from '../lib/types';

if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjs.version}`;
}

export type WorkspaceInspector =
  | { kind: 'device'; deviceId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'asset'; assetId: string };

interface WorkspaceInspectorDialogProps {
  open: boolean;
  isDark: boolean;
  workspaceName: string;
  inspector: WorkspaceInspector | null;
  agents: AgentDTO[];
  profiles: AgentProfileDTO[];
  runtime: WorkspaceRuntimeDTO | null;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (agentId: string) => void;
  onChanged?: () => Promise<void> | void;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /**
   * Memory Line B / B2 — when the asset has at least one MemoryPagesPanel
   * row, the panel renders a "View as Memory" button per row that delegates
   * back to the workspace page. Page handler typically:
   *   setMemoryJumpPath(path); setActiveSurface('library')
   */
  onOpenMemoryPage?: (path: string) => void;
}

interface AssetDetailDTO extends AssetDTO {
  s3Url?: string | null;
  s3UrlExpiresIn?: number | null;
  photoRefs?: Array<Record<string, unknown>> | null;
}

interface AssetPreviewState {
  loading: boolean;
  error: string | null;
  objectUrl: string | null;
  text: string | null;
  bytes: ArrayBuffer | null;
  detail: AssetDetailDTO | null;
  previewAsset: AssetDTO | null;
}

type SpreadsheetRow = Record<string, string | number>;

export function WorkspaceInspectorDialog({
  open,
  isDark,
  workspaceName,
  inspector,
  agents,
  profiles,
  runtime,
  assets,
  files,
  onOpenChange,
  onSelectAgent,
  onChanged,
  notify,
  onOpenMemoryPage,
}: WorkspaceInspectorDialogProps) {
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [assetPreview, setAssetPreview] = useState<AssetPreviewState>({
    loading: false,
    error: null,
    objectUrl: null,
    text: null,
    bytes: null,
    detail: null,
    previewAsset: null,
  });

  const device = useMemo<RuntimeDeviceDTO | null>(() => {
    if (!inspector || inspector.kind !== 'device') return null;
    return runtime?.devices.find((item) => item.deviceId === inspector.deviceId) ?? null;
  }, [inspector, runtime]);

  const agent = useMemo<AgentDTO | null>(() => {
    if (!inspector || inspector.kind !== 'agent') return null;
    return agents.find((item) => item.userId === inspector.agentId) ?? null;
  }, [inspector, agents]);

  const asset = useMemo<AssetDTO | null>(() => {
    if (!inspector || inspector.kind !== 'asset') return null;
    return assets.find((item) => item.id === inspector.assetId) ?? null;
  }, [inspector, assets]);

  const fileByAssetId = useMemo(() => new Map(files.map((file) => [file.assetId, file])), [files]);
  const assetDisplayTitle = asset ? assetTitle(asset, fileByAssetId.get(asset.id)) : 'Asset';

  const runtimeNode = useMemo(() => {
    if (!agent || !runtime) return null;
    for (const deviceItem of runtime.devices) {
      const node = deviceItem.agents.find((entry) => entry.id === agent.userId);
      if (node) {
        return { device: deviceItem, node };
      }
    }
    return null;
  }, [agent, runtime]);

  const profileList = useMemo(
    () => (agent ? profiles.filter((profile) => profile.agentImUserId === agent.userId) : []),
    [agent, profiles],
  );

  useEffect(() => {
    if (!open || !asset) return;
    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setAssetPreview({
      loading: true,
      error: null,
      objectUrl: null,
      text: null,
      bytes: null,
      detail: null,
      previewAsset: null,
    });

    (async () => {
      try {
        const detailRes = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}/detail`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        let detail: AssetDetailDTO | null = null;
        if (detailRes.ok) {
          const body = (await detailRes.json()) as { data?: AssetDetailDTO };
          detail = body.data ?? null;
        }

        const previewAsset = choosePreviewAsset(asset, detail);
        const mime = previewAsset.mime ?? '';
        const isPdf = mime.includes('pdf');
        const isMedia = mime.startsWith('video/') || mime.startsWith('audio/');
        const isBinaryWithObjectUrl = mime.startsWith('image/') || isPdf || isMedia;
        const isOffice = isOfficeDoc(previewAsset);
        const shouldFetchBytes =
          isBinaryWithObjectUrl ||
          isOffice ||
          isTextPreviewable(previewAsset) ||
          isDataPreviewable(previewAsset) ||
          isCodePreviewable(previewAsset);
        if (!shouldFetchBytes) {
          setAssetPreview({
            loading: false,
            error: null,
            objectUrl: null,
            text: null,
            bytes: null,
            detail,
            previewAsset,
          });
          return;
        }

        const res = await fetch(`/api/im/assets/${encodeURIComponent(previewAsset.id)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const blob = await res.blob();
        if (isBinaryWithObjectUrl) {
          objectUrl = URL.createObjectURL(blob);
          const bytes = isPdf ? await blob.arrayBuffer() : null;
          setAssetPreview({ loading: false, error: null, objectUrl, text: null, bytes, detail, previewAsset });
          return;
        }
        if (isOffice) {
          const bytes = await blob.arrayBuffer();
          setAssetPreview({ loading: false, error: null, objectUrl: null, text: null, bytes, detail, previewAsset });
          return;
        }
        const text = await blob.text();
        setAssetPreview({
          loading: false,
          error: null,
          objectUrl: null,
          text: text.slice(0, 80_000),
          bytes: null,
          detail,
          previewAsset,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setAssetPreview({
          loading: false,
          error: err instanceof Error ? err.message : 'Preview failed',
          objectUrl: null,
          text: null,
          bytes: null,
          detail: null,
          previewAsset: null,
        });
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, open]);

  if (!inspector) return null;

  async function downloadAsset(nextAsset: AssetDTO) {
    const token = getWorkspaceToken();
    if (!token) return;
    setDownloadingAssetId(nextAsset.id);
    try {
      const res = await fetch(`/api/im/assets/${encodeURIComponent(nextAsset.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nextAsset.contentHash || nextAsset.id;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingAssetId(null);
    }
  }

  function toast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    notify?.(message, type);
  }

  async function renameAgent() {
    if (!agent || agentBusy) return;
    const displayName = window.prompt('Rename agent', agent.name)?.trim();
    if (!displayName) return;
    setAgentBusy(true);
    const res = await imFetch(`/agents/${encodeURIComponent(agent.userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    });
    setAgentBusy(false);
    if (!res.ok) {
      toast(`Rename failed: ${res.message}`, 'error');
      return;
    }
    toast('Agent renamed.', 'success');
    await onChanged?.();
  }

  async function deleteAgent() {
    if (!agent || agentBusy) return;
    if (!window.confirm(`Delete agent "${agent.name}"?`)) return;
    setAgentBusy(true);
    const res = await imFetch(`/agents/${encodeURIComponent(agent.userId)}`, { method: 'DELETE' });
    setAgentBusy(false);
    if (!res.ok) {
      toast(`Delete failed: ${res.message}`, 'error');
      return;
    }
    toast('Agent deleted.', 'success');
    await onChanged?.();
    onOpenChange(false);
  }

  async function renameProfile(profile: AgentProfileDTO) {
    const name = window.prompt('Rename profile', profile.name)?.trim();
    if (!name) return;
    setProfileBusyId(profile.id);
    const res = await imFetch<AgentProfileDTO>(`/agent_profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, version: profile.version }),
    });
    setProfileBusyId(null);
    if (!res.ok) {
      toast(`Profile rename failed: ${res.message}`, 'error');
      return;
    }
    toast('Profile renamed.', 'success');
    await onChanged?.();
  }

  async function deleteProfile(profile: AgentProfileDTO) {
    if (!window.confirm(`Delete profile "${profile.name}"?`)) return;
    setProfileBusyId(profile.id);
    const res = await imFetch(`/agent_profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
    setProfileBusyId(null);
    if (!res.ok) {
      toast(`Profile delete failed: ${res.message}`, 'error');
      return;
    }
    toast('Profile deleted.', 'success');
    await onChanged?.();
  }

  if (inspector.kind === 'asset') {
    return (
      <div
        data-testid="workspace-asset-inspector-panel"
        className={`absolute inset-0 z-40 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden ${surface.modal[isDark ? 'dark' : 'light']}`}
      >
        <div
          className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className="truncate text-sm font-semibold">{assetDisplayTitle}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            aria-label="Close asset preview"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 overflow-hidden p-3">
          <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
            <div
              className={`min-h-0 flex-1 overflow-hidden rounded-2xl border ${isDark ? 'border-white/[0.08] bg-zinc-950/45' : 'border-zinc-200 bg-zinc-50'}`}
            >
              <AssetPreview asset={asset} title={assetDisplayTitle} state={assetPreview} isDark={isDark} />
            </div>
            <details
              className={`shrink-0 rounded-2xl border ${
                isDark ? 'border-white/[0.08] bg-zinc-950/88' : 'border-zinc-200 bg-white/95'
              }`}
            >
              <summary
                className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-semibold ${
                  isDark ? 'text-zinc-200' : 'text-zinc-800'
                }`}
              >
                <span>Asset details</span>
                <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>
                  {asset?.kind ?? 'file'} · {formatBytes(asset?.sizeBytes ?? null)}
                </span>
              </summary>
              <div className="max-h-[34vh] min-h-0 space-y-4 overflow-y-auto px-4 pb-4">
                <div
                  className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-12 w-12 items-center justify-center rounded-2xl ${isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'}`}
                    >
                      {renderAssetIcon(asset)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{assetDisplayTitle}</p>
                      <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {asset?.kind ?? 'file'} · {asset?.mime ?? 'unknown mime'}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div
                      className={`rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}
                    >
                      <p
                        className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                      >
                        Size
                      </p>
                      <p className="mt-1 font-medium">{formatBytes(asset?.sizeBytes ?? null)}</p>
                    </div>
                    <div
                      className={`rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}
                    >
                      <p
                        className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                      >
                        Created
                      </p>
                      <p className="mt-1 font-medium">
                        {asset?.createdAt ? new Date(asset.createdAt).toLocaleString() : 'unknown'}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="grid gap-3">
                  <DetailRow label="Asset ID" value={asset?.id ?? '-'} isDark={isDark} />
                  <DetailRow label="Content hash" value={asset?.contentHash ?? '-'} isDark={isDark} />
                  <DetailRow label="Ingest status" value={asset?.ingestStatus ?? 'synced'} isDark={isDark} />
                  <DetailRow label="Derivation" value={asset?.derivationKind ?? 'raw'} isDark={isDark} />
                  <DetailRow label="Asset index seq" value={String(asset?.assetIndexSeq ?? 0)} isDark={isDark} />
                  <DetailRow label="Storage" value={asset?.storageUri ?? '-'} isDark={isDark} />
                  <DetailRow label="Source task" value={asset?.sourceTaskId ?? '-'} isDark={isDark} />
                  <DetailRow label="Source agent" value={asset?.sourceAgentImUserId ?? '-'} isDark={isDark} />
                </div>
                <MemoryPagesPanel
                  isDark={isDark}
                  pages={assetPreview.detail?.memoryPages ?? asset?.memoryPages ?? []}
                  onOpenMemoryPage={
                    onOpenMemoryPage
                      ? (path) => {
                          onOpenMemoryPage(path);
                          onOpenChange(false);
                        }
                      : undefined
                  }
                />
                <DerivedAssetsPanel
                  isDark={isDark}
                  assets={assetPreview.detail?.derivedAssets ?? asset?.derivedAssets ?? []}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => asset && void downloadAsset(asset)}
                    disabled={!asset || downloadingAssetId === asset.id}
                  >
                    {downloadingAssetId === asset?.id ? (
                      <Pause className="mr-2 h-3.5 w-3.5" />
                    ) : (
                      <CloudDownload className="mr-2 h-3.5 w-3.5" />
                    )}
                    Download
                  </Button>
                  {assetPreview.detail?.s3Url ? (
                    <Button asChild variant="secondary" size="sm">
                      <a href={assetPreview.detail.s3Url} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-2 h-3.5 w-3.5" />
                        Open signed URL
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="workspace-inspector"
        className={`max-w-[min(96vw,1280px)] border ${surface.modal[isDark ? 'dark' : 'light']} ${radius.pane}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {inspector.kind === 'device' ? <Smartphone className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
            <span className="truncate">
              {inspector.kind === 'device' ? (device?.name ?? 'Device') : (agent?.name ?? 'Agent')}
            </span>
          </DialogTitle>
        </DialogHeader>

        {inspector.kind === 'device' ? (
          <div className="space-y-4">
            <div
              className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'}`}
                >
                  <Laptop className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{device?.name ?? 'Unknown device'}</p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    {device?.lastSeenAt
                      ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      : 'No heartbeat yet'}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span
                  className={`rounded-full border px-2 py-1 ${isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-700'}`}
                >
                  Workspace: {workspaceName}
                </span>
                <span
                  className={`rounded-full border px-2 py-1 ${isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-700'}`}
                >
                  {device?.agents.length ?? 0} agents
                </span>
              </div>
            </div>

            <section>
              <p
                className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                Runtime agents
              </p>
              <div className="space-y-2">
                {(device?.agents ?? []).map((runtimeAgent) => {
                  const linked = agents.find((item) => item.userId === runtimeAgent.id);
                  const avatar = avatarGradient(runtimeAgent.id);
                  return (
                    <button
                      key={runtimeAgent.id}
                      type="button"
                      onClick={() => onSelectAgent(runtimeAgent.id)}
                      className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-2 text-left transition-colors ${
                        isDark
                          ? 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06]'
                          : 'border-zinc-200 bg-white hover:bg-zinc-50'
                      }`}
                    >
                      <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-xs font-semibold text-white"
                        style={{ background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})` }}
                      >
                        {avatarInitials(linked?.name ?? runtimeAgent.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{linked?.name ?? runtimeAgent.name}</span>
                        <span className={`block truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                          {runtimeAgent.status} · {runtimeAgent.version ?? 'unknown version'}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {(device?.agents ?? []).length === 0 ? (
                  <p
                    className={`rounded-2xl border border-dashed px-3 py-4 text-sm ${isDark ? 'border-white/[0.06] text-zinc-500' : 'border-zinc-200 text-zinc-500'}`}
                  >
                    No agents on this device.
                  </p>
                ) : null}
              </div>
            </section>
          </div>
        ) : inspector.kind === 'agent' ? (
          <div className="space-y-4">
            <div
              className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${isDark ? 'bg-cyan-500/15 text-cyan-200' : 'bg-cyan-50 text-cyan-700'}`}
                >
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{agent?.name ?? 'Unknown agent'}</p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    {agent?.agentType ?? 'adapter unknown'}
                    {agent?.status ? ` · ${agent.status}` : ''}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                {agent?.capabilities?.slice(0, 4).map((cap) => (
                  <span
                    key={cap}
                    className={`rounded-full border px-2 py-1 ${isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-700'}`}
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </div>

            {runtimeNode ? (
              <div
                className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
              >
                <p
                  className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  Device
                </p>
                <p className="mt-1 text-sm font-medium">{runtimeNode.device.name}</p>
                <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {runtimeNode.node.status} · {runtimeNode.node.version ?? 'unknown version'}
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
              >
                <p
                  className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  Profiles
                </p>
                <p className="mt-1 text-sm font-medium">{profileList.length}</p>
              </div>
              <div
                className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
              >
                <p
                  className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  Runtime
                </p>
                <p className="mt-1 text-sm font-medium">{runtimeNode?.node.status ?? 'offline'}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link href={`/u/${encodeURIComponent(agent?.userId ?? '')}`}>Open profile</Link>
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={renameAgent} disabled={!agent || agentBusy}>
                {agentBusy ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Edit3 className="mr-2 h-3.5 w-3.5" />
                )}
                Rename
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={deleteAgent} disabled={!agent || agentBusy}>
                {agentBusy ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                )}
                Delete
              </Button>
            </div>

            <section>
              <p
                className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                Profiles
              </p>
              <div className="space-y-2">
                {profileList.length === 0 ? (
                  <p
                    className={`rounded-2xl border border-dashed px-3 py-4 text-sm ${isDark ? 'border-white/[0.06] text-zinc-500' : 'border-zinc-200 text-zinc-500'}`}
                  >
                    No profiles for this agent.
                  </p>
                ) : (
                  profileList.map((profile) => {
                    const profileModel = (profile.config as Record<string, unknown>)?.model;
                    return (
                      <div
                        key={profile.id}
                        className={`flex items-center gap-3 rounded-2xl border px-3 py-2 ${
                          isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-white'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{profile.name}</p>
                          <p className={`truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                            {profile.adapterName} · v{profile.version}
                            {typeof profileModel === 'string' && profileModel ? (
                              <span> · model: {profileModel}</span>
                            ) : null}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => renameProfile(profile)}
                          disabled={profileBusyId === profile.id}
                        >
                          {profileBusyId === profile.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Edit3 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => deleteProfile(profile)}
                          disabled={profileBusyId === profile.id}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div
              className={`min-h-0 flex-1 overflow-hidden rounded-3xl border ${isDark ? 'border-white/[0.08] bg-zinc-950/45' : 'border-zinc-200 bg-zinc-50'}`}
            >
              <AssetPreview asset={asset} title={assetDisplayTitle} state={assetPreview} isDark={isDark} />
            </div>
            <details
              className={`shrink-0 rounded-2xl border ${
                isDark ? 'border-white/[0.08] bg-zinc-950/88' : 'border-zinc-200 bg-white/95'
              }`}
            >
              <summary
                className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-semibold ${
                  isDark ? 'text-zinc-200' : 'text-zinc-800'
                }`}
              >
                <span>Asset details</span>
                <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>
                  {asset?.kind ?? 'file'} · {formatBytes(asset?.sizeBytes ?? null)}
                </span>
              </summary>
              <div className="max-h-[34vh] min-h-0 space-y-4 overflow-y-auto px-4 pb-4">
                <div
                  className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-12 w-12 items-center justify-center rounded-2xl ${isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'}`}
                    >
                      {renderAssetIcon(asset)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{assetDisplayTitle}</p>
                      <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {asset?.kind ?? 'file'} · {asset?.mime ?? 'unknown mime'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div
                      className={`rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}
                    >
                      <p
                        className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                      >
                        Size
                      </p>
                      <p className="mt-1 font-medium">{formatBytes(asset?.sizeBytes ?? null)}</p>
                    </div>
                    <div
                      className={`rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}
                    >
                      <p
                        className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                      >
                        Created
                      </p>
                      <p className="mt-1 font-medium">
                        {asset?.createdAt ? new Date(asset.createdAt).toLocaleString() : 'unknown'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3">
                  <DetailRow label="Asset ID" value={asset?.id ?? '—'} isDark={isDark} />
                  <DetailRow label="Content hash" value={asset?.contentHash ?? '—'} isDark={isDark} />
                  <DetailRow label="Ingest status" value={asset?.ingestStatus ?? 'synced'} isDark={isDark} />
                  <DetailRow label="Derivation" value={asset?.derivationKind ?? 'raw'} isDark={isDark} />
                  <DetailRow label="Asset index seq" value={String(asset?.assetIndexSeq ?? 0)} isDark={isDark} />
                  <DetailRow label="Storage" value={asset?.storageUri ?? '—'} isDark={isDark} />
                  <DetailRow label="Source task" value={asset?.sourceTaskId ?? '—'} isDark={isDark} />
                  <DetailRow label="Source agent" value={asset?.sourceAgentImUserId ?? '—'} isDark={isDark} />
                </div>

                <MemoryPagesPanel
                  isDark={isDark}
                  pages={assetPreview.detail?.memoryPages ?? asset?.memoryPages ?? []}
                  onOpenMemoryPage={
                    onOpenMemoryPage
                      ? (path) => {
                          onOpenMemoryPage(path);
                          onOpenChange(false);
                        }
                      : undefined
                  }
                />

                <DerivedAssetsPanel
                  isDark={isDark}
                  assets={assetPreview.detail?.derivedAssets ?? asset?.derivedAssets ?? []}
                />

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => asset && void downloadAsset(asset)}
                    disabled={!asset || downloadingAssetId === asset.id}
                  >
                    {downloadingAssetId === asset?.id ? (
                      <Pause className="mr-2 h-3.5 w-3.5" />
                    ) : (
                      <CloudDownload className="mr-2 h-3.5 w-3.5" />
                    )}
                    Download
                  </Button>
                  {assetPreview.detail?.s3Url ? (
                    <Button asChild variant="secondary" size="sm">
                      <a href={assetPreview.detail.s3Url} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-2 h-3.5 w-3.5" />
                        Open signed URL
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>
            </details>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
    >
      <p className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {label}
      </p>
      <p className="mt-1 break-all text-sm">{value}</p>
    </div>
  );
}

function AssetPreview({
  asset,
  title,
  state,
  isDark,
}: {
  asset: AssetDTO | null;
  title: string;
  state: AssetPreviewState;
  isDark: boolean;
}) {
  if (!asset) {
    return <PreviewEmpty isDark={isDark} label="Asset unavailable" />;
  }
  if (state.loading) {
    return <PreviewEmpty isDark={isDark} label="Loading preview..." />;
  }
  if (state.error) {
    return <PreviewEmpty isDark={isDark} label={state.error} />;
  }
  const renderAsset = state.previewAsset ?? asset;
  const mime = renderAsset.mime ?? '';
  if (mime.startsWith('image/') && state.objectUrl) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={state.objectUrl}
          alt={title}
          className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl"
        />
      </div>
    );
  }
  if (mime.includes('pdf') && (state.bytes || state.objectUrl)) {
    return <PdfPreview bytes={state.bytes} objectUrl={state.objectUrl} title={title} isDark={isDark} />;
  }
  if (mime.startsWith('video/') && state.objectUrl) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-black p-2">
        <video
          src={state.objectUrl}
          controls
          preload="metadata"
          className="max-h-full w-full rounded-2xl shadow-2xl"
          data-testid="asset-preview-video"
        >
          <track kind="captions" />
        </video>
      </div>
    );
  }
  if (mime.startsWith('audio/') && state.objectUrl) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-6 text-center">
        <div
          className={`flex h-16 w-16 items-center justify-center rounded-3xl ${isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'}`}
        >
          <Music className="h-7 w-7" />
        </div>
        <p className={`max-w-sm truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {title}
        </p>
        <audio
          src={state.objectUrl}
          controls
          preload="metadata"
          className="w-full max-w-md"
          data-testid="asset-preview-audio"
        />
      </div>
    );
  }
  if (
    (isTextPreviewable(renderAsset) || isCodePreviewable(renderAsset) || isDataPreviewable(renderAsset)) &&
    state.text != null
  ) {
    const language = previewLanguage(renderAsset);
    const shouldRenderMarkdown = isMarkdownPreviewable(renderAsset);
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          className={`flex items-center justify-between border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{language} preview</p>
          </div>
        </div>
        {shouldRenderMarkdown ? (
          <div
            className={`min-h-0 flex-1 overflow-auto p-4 text-sm leading-relaxed ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}
          >
            <MarkdownRenderer content={state.text} />
          </div>
        ) : (
          <pre
            className={`min-h-0 flex-1 overflow-auto p-4 text-xs leading-relaxed ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}
          >
            <code>{state.text}</code>
          </pre>
        )}
      </div>
    );
  }
  if (isSpreadsheetDoc(renderAsset) && state.bytes) {
    return <SpreadsheetPreview key={renderAsset.id} bytes={state.bytes} title={title} isDark={isDark} />;
  }
  if (isPresentationDoc(renderAsset) && state.bytes) {
    return <PresentationPreview key={renderAsset.id} bytes={state.bytes} title={title} isDark={isDark} />;
  }
  if (isWordDoc(renderAsset) && state.bytes) {
    return <WordPreview key={renderAsset.id} bytes={state.bytes} title={title} isDark={isDark} />;
  }
  if (isOfficeDoc(renderAsset) && state.text == null) {
    return <OfficeDocPreview asset={renderAsset} title={title} isDark={isDark} />;
  }
  if (isArchive(renderAsset) && state.text == null) {
    return <ArchivePreview asset={renderAsset} title={title} isDark={isDark} />;
  }
  return (
    <PreviewEmpty
      isDark={isDark}
      label={`${renderAsset.kind || 'Asset'} preview is not available for ${renderAsset.mime ?? 'this file type'}.`}
    />
  );
}

// xlsx parsing is fully synchronous on the main thread. Files past this size
// either OOM the tab or freeze the browser long enough that the OS kills it.
// Refuse to attempt preview and let the user download instead.
const MAX_SPREADSHEET_PREVIEW_BYTES = 20 * 1024 * 1024;
const SPREADSHEET_ROW_CAP = 5000;
const SPREADSHEET_COL_CAP = 64;

interface SheetModel {
  columns: Column<SpreadsheetRow>[];
  rows: SpreadsheetRow[];
  truncated: { rows: boolean; cols: boolean };
  totalRows: number;
}

// Bound the parse range BEFORE `sheet_to_json` so degenerate sheets
// (1M+ used rows) don't blow up. We rewrite `!ref` so xlsx's iterator
// only touches the head of the sheet — single-pass, no post-slice.
function convertSheetModel(
  XLSX: typeof import('xlsx'),
  workbook: ReturnType<typeof import('xlsx').read>,
  index: number,
): SheetModel {
  const name = workbook.SheetNames[index];
  const sheet = workbook.Sheets[name];
  let truncatedRows = false;
  let truncatedCols = false;
  let totalRows = 0;
  if (sheet['!ref']) {
    const ref = XLSX.utils.decode_range(sheet['!ref']);
    totalRows = Math.max(0, ref.e.r - ref.s.r + 1);
    const totalCols = Math.max(0, ref.e.c - ref.s.c + 1);
    truncatedRows = totalRows > SPREADSHEET_ROW_CAP;
    truncatedCols = totalCols > SPREADSHEET_COL_CAP;
    sheet['!ref'] = XLSX.utils.encode_range({
      s: ref.s,
      e: {
        r: ref.s.r + Math.min(SPREADSHEET_ROW_CAP - 1, ref.e.r - ref.s.r),
        c: ref.s.c + Math.min(SPREADSHEET_COL_CAP - 1, ref.e.c - ref.s.c),
      },
    });
  }
  const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
  });
  const values = rows.map((row) => row.map(formatCellValue));
  const maxCols = Math.max(1, ...values.map((row) => row.length));
  const columns: Column<SpreadsheetRow>[] = [
    {
      key: '__rowNumber',
      name: '#',
      width: 56,
      frozen: true,
      renderCell: ({ row }) => row.__rowNumber,
    },
    ...Array.from({ length: maxCols }).map<Column<SpreadsheetRow>>((_, idx) => {
      const key = `c${idx}`;
      return {
        key,
        name: columnName(idx),
        minWidth: 120,
        resizable: true,
        renderCell: ({ row }) => row[key] ?? '',
      };
    }),
  ];
  const gridRows = values.map<SpreadsheetRow>((row, rowIndex) => {
    const item: SpreadsheetRow = { __rowNumber: rowIndex + 1 };
    row.forEach((value, colIndex) => {
      item[`c${colIndex}`] = value;
    });
    return item;
  });
  return { columns, rows: gridRows, truncated: { rows: truncatedRows, cols: truncatedCols }, totalRows };
}

function SpreadsheetPreview({ bytes, title, isDark }: { bytes: ArrayBuffer; title: string; isDark: boolean }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const [meta, setMeta] = useState<{ names: string[] } | null>(null);
  const [sheets, setSheets] = useState<Map<number, SheetModel>>(new Map());
  const [loadingSheetIdx, setLoadingSheetIdx] = useState<number | null>(0);
  const [error, setError] = useState<string | null>(null);
  const workbookRef = useRef<ReturnType<typeof import('xlsx').read> | null>(null);
  const xlsxRef = useRef<typeof import('xlsx') | null>(null);

  // Phase 1: load xlsx + parse workbook structure + first sheet only.
  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setSheets(new Map());
    setActiveSheet(0);
    setError(null);
    workbookRef.current = null;
    xlsxRef.current = null;

    if (bytes.byteLength > MAX_SPREADSHEET_PREVIEW_BYTES) {
      setError(
        `Spreadsheet is ${formatBytes(bytes.byteLength)} — too large for in-browser preview (limit ${formatBytes(MAX_SPREADSHEET_PREVIEW_BYTES)}). Download to view.`,
      );
      setLoadingSheetIdx(null);
      return;
    }

    setLoadingSheetIdx(0);
    import('xlsx')
      .then((XLSX) => {
        if (cancelled) return;
        // Yield once so React commits the loading state before the
        // synchronous parse pegs the main thread.
        setTimeout(() => {
          if (cancelled) return;
          try {
            const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
            xlsxRef.current = XLSX;
            workbookRef.current = wb;
            const firstModel = convertSheetModel(XLSX, wb, 0);
            if (cancelled) return;
            setMeta({ names: wb.SheetNames });
            setSheets(new Map([[0, firstModel]]));
            setLoadingSheetIdx(null);
          } catch (err) {
            if (cancelled) return;
            setError(err instanceof Error ? err.message : 'Spreadsheet preview failed');
            setLoadingSheetIdx(null);
          }
        }, 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Spreadsheet preview failed');
        setLoadingSheetIdx(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  // Phase 2: convert any other sheet on demand when user switches tabs.
  useEffect(() => {
    if (!meta || sheets.has(activeSheet)) return;
    const XLSX = xlsxRef.current;
    const wb = workbookRef.current;
    if (!XLSX || !wb) return;
    let cancelled = false;
    setLoadingSheetIdx(activeSheet);
    const tid = setTimeout(() => {
      if (cancelled) return;
      try {
        const model = convertSheetModel(XLSX, wb, activeSheet);
        if (cancelled) return;
        setSheets((prev) => new Map(prev).set(activeSheet, model));
        setLoadingSheetIdx(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Sheet conversion failed');
        setLoadingSheetIdx(null);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(tid);
    };
  }, [activeSheet, meta, sheets]);

  if (error) return <PreviewEmpty isDark={isDark} label={error} />;
  if (!meta) return <PreviewEmpty isDark={isDark} label="Loading spreadsheet…" />;
  const sheetModel = sheets.get(activeSheet);
  if (!sheetModel) {
    return (
      <PreviewEmpty
        isDark={isDark}
        label={
          loadingSheetIdx === activeSheet ? `Loading ${meta.names[activeSheet] ?? 'sheet'}…` : 'Sheet unavailable.'
        }
      />
    );
  }

  const sheetName = meta.names[activeSheet] ?? meta.names[0] ?? 'Sheet';
  const rows = sheetModel.rows;
  const columns = sheetModel.columns;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-spreadsheet">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {sheetName}
              {sheetModel.truncated.rows
                ? ` · showing first ${SPREADSHEET_ROW_CAP.toLocaleString()} of ${sheetModel.totalRows.toLocaleString()} rows`
                : ''}
              {sheetModel.truncated.cols ? ` · first ${SPREADSHEET_COL_CAP} columns` : ''}
            </p>
          </div>
        </div>
        {meta.names.length > 1 ? (
          <div className="mt-3 flex gap-1 overflow-x-auto">
            {meta.names.map((name, index) => (
              <button
                key={name}
                type="button"
                onClick={() => setActiveSheet(index)}
                className={`shrink-0 rounded-xl border px-2.5 py-1 text-xs font-semibold ${
                  index === activeSheet
                    ? isDark
                      ? 'border-violet-300/30 bg-violet-500/15 text-violet-100'
                      : 'border-violet-200 bg-violet-100 text-violet-900'
                    : isDark
                      ? 'border-white/[0.08] text-zinc-400 hover:bg-white/[0.05]'
                      : 'border-zinc-200 text-zinc-600 hover:bg-white'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <PreviewEmpty isDark={isDark} label="This sheet is empty." />
        ) : (
          <DataGrid
            className={isDark ? 'rdg-dark h-full' : 'rdg-light h-full'}
            columns={columns}
            rows={rows}
            rowHeight={34}
            headerRowHeight={36}
            defaultColumnOptions={{ resizable: true }}
          />
        )}
      </div>
    </div>
  );
}

function PresentationPreview({ bytes, title, isDark }: { bytes: ArrayBuffer; title: string; isDark: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let previewer: { preview: (file: ArrayBuffer) => Promise<unknown>; destroy: () => void } | null = null;
    const host = hostRef.current;
    if (!host) return undefined;
    host.innerHTML = '';
    import('pptx-preview')
      .then(({ init }) => {
        if (cancelled) return undefined;
        previewer = init(host, { width: 960, height: 540, mode: 'list' });
        return previewer.preview(bytes);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Presentation preview failed');
      });
    return () => {
      cancelled = true;
      previewer?.destroy?.();
      host.innerHTML = '';
    };
  }, [bytes]);

  if (error) return <PreviewEmpty isDark={isDark} label={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-presentation">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>PowerPoint preview</p>
      </div>
      <div ref={hostRef} className="asset-pptx-viewer min-h-0 flex-1 overflow-auto bg-zinc-100 p-4" />
    </div>
  );
}

function WordPreview({ bytes, title, isDark }: { bytes: ArrayBuffer; title: string; isDark: boolean }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const body = bodyRef.current;
    const style = styleRef.current;
    if (!body) return undefined;
    body.innerHTML = '';
    if (style) style.innerHTML = '';
    import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(bytes, body, style ?? undefined, {
          className: 'asset-docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        }),
      )
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Word preview failed');
      });
    return () => {
      cancelled = true;
      body.innerHTML = '';
      if (style) style.innerHTML = '';
    };
  }, [bytes]);

  if (error) return <PreviewEmpty isDark={isDark} label={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-word">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Word preview</p>
      </div>
      <div ref={styleRef} />
      <div ref={bodyRef} className="asset-docx-viewer min-h-0 flex-1 overflow-auto bg-zinc-100 p-6" />
    </div>
  );
}

const MAX_PDF_PREVIEW_PAGES = 24;
const PDF_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
};

function PdfPreview({
  bytes,
  objectUrl,
  title,
  isDark,
}: {
  bytes: ArrayBuffer | null;
  objectUrl: string | null;
  title: string;
  isDark: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setHostWidth(width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const pdfFile = useMemo(() => {
    if (objectUrl) return objectUrl;
    if (bytes) return { data: new Uint8Array(bytes) };
    return null;
  }, [bytes, objectUrl]);

  const pageWidth = Math.max(320, Math.min(1100, hostWidth - 32)) * scale;
  const visiblePages = Math.min(numPages, MAX_PDF_PREVIEW_PAGES);

  if (!pdfFile) return <PreviewEmpty isDark={isDark} label="PDF preview data is missing." />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-pdf">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {numPages ? `${numPages} pages` : 'PDF preview'}
              {error ? ` · ${error}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPageNumber((prev) => Math.max(1, prev - 1))}
              disabled={pageNumber <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className={`min-w-16 text-center text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {pageNumber} / {numPages || '?'}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPageNumber((prev) => Math.min(numPages || prev, prev + 1))}
              disabled={!numPages || pageNumber >= numPages}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setScale((prev) => Math.max(0.6, Number((prev - 0.1).toFixed(2))))}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className={`min-w-12 text-center text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {Math.round(scale * 100)}%
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setScale((prev) => Math.min(2, Number((prev + 0.1).toFixed(2))))}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-auto bg-zinc-100 p-4 dark:bg-zinc-950">
        <Document
          file={pdfFile}
          options={PDF_OPTIONS}
          loading={<PreviewEmpty isDark={isDark} label="Loading PDF preview..." />}
          error={<PreviewEmpty isDark={isDark} label="PDF preview failed." />}
          onLoadSuccess={({ numPages: nextPages }) => {
            setError(null);
            setNumPages(nextPages);
            setPageNumber((prev) => Math.min(prev, nextPages));
          }}
          onLoadError={(err) => {
            setError(err.message);
          }}
        >
          <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
            {Array.from({ length: visiblePages }).map((_, index) => {
              const nextPage = index + 1;
              return (
                <div
                  key={nextPage}
                  data-pdf-page={nextPage}
                  className={`overflow-hidden rounded-2xl border bg-white shadow-xl shadow-black/5 ${
                    isDark ? 'border-white/[0.06]' : 'border-zinc-200'
                  }`}
                >
                  <Page
                    pageNumber={nextPage}
                    width={pageWidth}
                    loading={nextPage === pageNumber ? <PreviewEmpty isDark={isDark} label="Loading page..." /> : null}
                    renderAnnotationLayer
                    renderTextLayer
                    onLoadSuccess={() => {
                      if (nextPage === pageNumber) {
                        const element = document.querySelector(`[data-pdf-page="${nextPage}"]`);
                        element?.scrollIntoView({ block: 'nearest' });
                      }
                    }}
                  />
                </div>
              );
            })}
            {numPages > MAX_PDF_PREVIEW_PAGES ? (
              <p className={`pb-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                Preview limited to the first {MAX_PDF_PREVIEW_PAGES} pages.
              </p>
            ) : null}
          </div>
        </Document>
      </div>
    </div>
  );
}

function OfficeDocPreview({ asset, title, isDark }: { asset: AssetDTO; title: string; isDark: boolean }) {
  const flavour = officeFlavour(asset);
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="asset-preview-office"
    >
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-3xl ${isDark ? 'bg-blue-500/15 text-blue-200' : 'bg-blue-50 text-blue-700'}`}
      >
        <FileText className="h-6 w-6" />
      </div>
      <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
      <p className={`max-w-sm text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
        {flavour} document — inline preview is not available. Download to inspect, or open the signed URL externally.
      </p>
      <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {asset.mime ?? 'application/octet-stream'}
      </p>
    </div>
  );
}

function ArchivePreview({ asset, title, isDark }: { asset: AssetDTO; title: string; isDark: boolean }) {
  const sizeLabel = formatBytes(asset.sizeBytes ?? null);
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="asset-preview-archive"
    >
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-3xl ${isDark ? 'bg-amber-500/15 text-amber-200' : 'bg-amber-50 text-amber-700'}`}
      >
        <Archive className="h-6 w-6" />
      </div>
      <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
      <p className={`max-w-sm text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
        Archive ({sizeLabel}) — download to extract on your machine. Inline browsing of archive contents is not
        supported.
      </p>
      <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {asset.mime ?? 'application/octet-stream'}
      </p>
    </div>
  );
}

function PreviewEmpty({ isDark, label }: { isDark: boolean; label: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-3xl ${isDark ? 'bg-white/[0.05] text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}
      >
        <FileText className="h-6 w-6" />
      </div>
      <p className={`mt-3 max-w-sm text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{label}</p>
    </div>
  );
}

function MemoryPagesPanel({
  isDark,
  pages,
  onOpenMemoryPage,
}: {
  isDark: boolean;
  pages: NonNullable<AssetDTO['memoryPages']>;
  onOpenMemoryPage?: (path: string) => void;
}) {
  return (
    <div
      data-testid="asset-memory-pages-panel"
      className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          Memory pages
        </p>
        <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{pages.length}</span>
      </div>
      {pages.length === 0 ? (
        <p className={`mt-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          No workspace memory page has been derived from this asset yet.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {pages.map((page) => (
            <div
              key={page.id}
              data-testid={`asset-memory-page-row-${page.id}`}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
            >
              <div className="min-w-0 flex-1">
                <p className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                  {page.title ?? page.path}
                </p>
                <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {page.path} · v{page.version}
                </p>
              </div>
              {onOpenMemoryPage ? (
                <button
                  type="button"
                  data-testid={`asset-memory-page-open-${page.id}`}
                  onClick={() => onOpenMemoryPage(page.path)}
                  className={`shrink-0 rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors ${
                    isDark
                      ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/25'
                      : 'bg-violet-100 text-violet-800 hover:bg-violet-200'
                  }`}
                >
                  View as Memory
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DerivedAssetsPanel({ isDark, assets }: { isDark: boolean; assets: AssetDTO[] }) {
  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          Derived assets
        </p>
        <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {assets.length}
        </span>
      </div>
      {assets.length === 0 ? (
        <p className={`mt-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          No parsed document, thumbnail, or dataset artifact has been attached yet.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {assets.map((item) => (
            <div
              key={item.id}
              className={`rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
            >
              <p className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                {item.filename ?? item.metadata?.title?.toString() ?? item.id}
              </p>
              <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {item.derivationKind ?? item.kind} · {item.mime ?? 'unknown'} · {formatBytes(item.sizeBytes)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function choosePreviewAsset(asset: AssetDTO, detail: AssetDetailDTO | null): AssetDTO {
  const derived = detail?.derivedAssets ?? asset.derivedAssets ?? [];
  const preview = detail?.previewAsset ?? asset.previewAsset ?? null;
  if (preview) return preview;
  const parsedMd = derived.find(
    (item) => item.derivationKind === 'parsed-md' || (item.mime ?? '').includes('markdown'),
  );
  if (parsedMd) return parsedMd;
  const imagePreview = derived.find(
    (item) => (item.mime ?? '').startsWith('image/') || item.derivationKind === 'thumbnail',
  );
  if (imagePreview) return imagePreview;
  return asset;
}

function assetTitle(asset: AssetDTO, file?: WorkspaceFileDTO) {
  if (file?.path) return file.path;
  if (asset.filename) return asset.filename;
  const title = asset.metadata?.title;
  if (typeof title === 'string' && title.trim()) return title;
  const raw = asset.storageUri
    .split('/')
    .pop()
    ?.replace(/^asset-/, '');
  if (raw) return decodeURIComponent(raw);
  return asset.contentHash.slice(0, 16);
}

function renderAssetIcon(asset: AssetDTO | null) {
  if (!asset) return <Sparkles className="h-5 w-5" />;
  const mime = asset.mime ?? '';
  if (mime.startsWith('image/')) return <ImageIcon className="h-5 w-5" />;
  if (mime.startsWith('video/')) return <Film className="h-5 w-5" />;
  if (mime.startsWith('audio/')) return <Music className="h-5 w-5" />;
  if (isArchive(asset)) return <Archive className="h-5 w-5" />;
  if (isOfficeDoc(asset)) return <FileText className="h-5 w-5" />;
  if (isDataPreviewable(asset)) return <Table2 className="h-5 w-5" />;
  if (isCodePreviewable(asset)) return <FileCode2 className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

function isTextPreviewable(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.startsWith('text/') ||
    mime.includes('markdown') ||
    mime.includes('xml') ||
    // YAML / TOML — render as plain monospace via the existing text branch.
    /^(application|text)\/(x-)?(yaml|toml)$/.test(mime) ||
    /\.(yaml|yml|toml|txt|log|ini|conf|env|properties|rst)$/i.test(name) ||
    (mime === 'application/octet-stream' && /\.(md|markdown|txt|log|ini|conf|env|properties|rst)$/i.test(name))
  );
}

function isCodePreviewable(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('javascript') ||
    mime.includes('typescript') ||
    mime.includes('python') ||
    mime.includes('json') ||
    asset.kind.includes('code') ||
    /\.(js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|css|html|sh|sql|yaml|yml|toml)$/.test(name)
  );
}

function isDataPreviewable(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('json') ||
    mime.includes('csv') ||
    asset.kind.includes('dataset') ||
    /\.(json|csv|tsv|ndjson)$/.test(name)
  );
}

function isOfficeDoc(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('officedocument') ||
    mime.includes('msword') ||
    mime.includes('ms-excel') ||
    mime.includes('ms-powerpoint') ||
    mime === 'application/vnd.oasis.opendocument.text' ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
    mime === 'application/vnd.oasis.opendocument.presentation' ||
    /\.(docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp)$/.test(name)
  );
}

function isSpreadsheetDoc(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('spreadsheetml') ||
    mime.includes('ms-excel') ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
    /\.(xlsx|xls|ods)$/.test(name)
  );
}

function isPresentationDoc(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('presentationml') || /\.pptx$/.test(name);
}

function isWordDoc(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('wordprocessingml') || /\.docx$/.test(name);
}

function officeFlavour(asset: AssetDTO): string {
  const mime = asset.mime ?? '';
  const name = String(asset.metadata?.title ?? asset.storageUri).toLowerCase();
  if (mime.includes('wordprocessingml') || /\.docx?$/.test(name) || mime.includes('msword')) return 'Word';
  if (mime.includes('spreadsheetml') || /\.xlsx?$/.test(name) || mime.includes('ms-excel')) return 'Excel';
  if (mime.includes('presentationml') || /\.pptx?$/.test(name) || mime.includes('ms-powerpoint')) return 'PowerPoint';
  if (/\.odt$/.test(name)) return 'OpenDocument Text';
  if (/\.ods$/.test(name)) return 'OpenDocument Spreadsheet';
  if (/\.odp$/.test(name)) return 'OpenDocument Presentation';
  return 'Office';
}

function isArchive(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = String(asset.metadata?.title ?? asset.storageUri).toLowerCase();
  return (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    mime === 'application/x-bzip2' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/x-rar-compressed' ||
    mime === 'application/vnd.rar' ||
    /\.(zip|tar|tgz|tar\.gz|gz|bz2|xz|7z|rar)$/.test(name)
  );
}

function previewLanguage(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  if (mime.includes('json') || name.endsWith('.json')) return 'JSON';
  if (mime.includes('csv') || name.endsWith('.csv')) return 'CSV';
  if (name.endsWith('.md') || name.endsWith('.markdown') || mime.includes('markdown')) return 'Markdown';
  if (name.endsWith('.txt') || name.endsWith('.log')) return 'Text';
  if (name.endsWith('.tsx')) return 'TSX';
  if (name.endsWith('.ts')) return 'TypeScript';
  if (name.endsWith('.py')) return 'Python';
  if (name.endsWith('.yaml') || name.endsWith('.yml') || mime.includes('yaml')) return 'YAML';
  if (name.endsWith('.toml') || mime.includes('toml')) return 'TOML';
  if (mime.startsWith('text/')) return 'Text';
  return 'File';
}

function isMarkdownPreviewable(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('markdown') || /\.(md|markdown|mdown|mkdn)$/i.test(name);
}

function assetPreviewName(asset: AssetDTO) {
  return String(asset.filename ?? asset.metadata?.title ?? asset.storageUri).toLowerCase();
}

function formatCellValue(value: string | number | boolean | Date | null): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
