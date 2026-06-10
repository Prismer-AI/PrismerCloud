'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Archive,
  CloudDownload,
  CloudUpload,
  Edit3,
  ExternalLink,
  FileCode2,
  FileText,
  Film,
  ImageIcon,
  Laptop,
  Loader2,
  Maximize2,
  Minimize2,
  Music,
  Pause,
  Sparkles,
  Smartphone,
  Table2,
  Trash2,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { sanitizeHtml } from '@/lib/sanitize';
import { ModelPicker } from './model-picker';
import { AssetRevisionSelector, AssetVersionSelector } from './asset-version-selector';
import { AssetImageGallery, HlsVideoPlayer, imageGalleryCandidates } from './asset-viewer';
import { AssetLoadingIndicator, DampedProgressBar } from './asset-viewer/asset-loading-indicator';
import { DuckDBTablePreview, isDuckDBPreviewAsset } from './asset-viewer/duckdb-table-preview';
import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { radius, surface } from '../lib/design';
import { getAgentRoleIcon } from '../lib/agent-role-icon';
import type { AgentLiveStatus } from '../lib/agent-status';
import { AgentAvatar } from './agent-avatar';
import {
  MAX_SPREADSHEET_PREVIEW_BYTES,
  MAX_TABLE_TEXT_PREVIEW_BYTES,
  MAX_TABLE_TEXT_PREVIEW_CHARS,
  MAX_TEXT_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_CHARS,
  MAX_VIRTUAL_TEXT_PREVIEW_BYTES,
  MAX_VIRTUAL_TEXT_PREVIEW_CHARS,
  previewGateLabel,
  previewInlineSizeLimit,
} from '../lib/asset-preview-limits';
import type {
  AgentDTO,
  AgentProfileDTO,
  AssetDTO,
  RuntimeDeviceDTO,
  WorkspaceFileDTO,
  WorkspaceRuntimeDTO,
} from '../lib/types';

const PlateMarkdownEditor = dynamic(
  () => import('./asset-viewer/plate-markdown-editor').then((mod) => mod.PlateMarkdownEditor),
  { ssr: false },
);
const PdfAssetPreview = dynamic(() => import('./asset-viewer/pdf-asset-preview').then((mod) => mod.PdfAssetPreview), {
  ssr: false,
  loading: () => <AssetLoadingIndicator isDark={false} label="Loading PDF preview…" />,
});

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
  /** Task 3 — workspace-wide agent live status map (from page.tsx). */
  agentStatuses?: Map<string, AgentLiveStatus>;
  profiles: AgentProfileDTO[];
  runtime: WorkspaceRuntimeDTO | null;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (agentId: string) => void;
  /**
   * Asset preview only — 'split' docks the panel beside the surface (in-flow),
   * 'full' overlays the whole surface (absolute inset-0). Defaults to 'full'
   * for the agent/device modal paths, which ignore it.
   */
  layout?: 'split' | 'full';
  /** When set, renders a maximize/restore toggle in the asset preview header. */
  onToggleLayout?: () => void;
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
  loadingLabel?: string;
  progress?: AssetPreviewProgress | null;
  error: string | null;
  objectUrl: string | null;
  text: string | null;
  bytes: ArrayBuffer | null;
  detail: AssetDetailDTO | null;
  previewAsset: AssetDTO | null;
}

interface AssetPreviewProgress {
  percent: number | null;
  loadedBytes: number;
  totalBytes: number | null;
}

interface RoleTemplateDTO {
  id: string;
  slug: string;
  displayName?: { en?: string; zh?: string };
  name?: { en?: string; zh?: string };
  taskAuthority?: string;
  approvalPolicy?: string;
}

type TableCellValue = string | number | boolean | Date | null;

interface TableModel {
  rows: string[][];
  colCount: number;
  truncated: { rows: boolean; cols: boolean };
  totalRows: number;
  totalCols: number;
}

interface TableRowModel {
  rowNumber: number;
  cells: string[];
}

export function WorkspaceInspectorDialog({
  open,
  isDark,
  workspaceName,
  inspector,
  agents,
  agentStatuses,
  profiles,
  runtime,
  assets,
  files,
  onOpenChange,
  onSelectAgent,
  layout = 'full',
  onToggleLayout,
  onChanged,
  notify,
  onOpenMemoryPage,
}: WorkspaceInspectorDialogProps) {
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentLifecycleBusy, setAgentLifecycleBusy] = useState<'snapshot' | 'publish' | null>(null);
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [profileModelDrafts, setProfileModelDrafts] = useState<Record<string, string>>({});
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplateDTO[]>([]);
  const [selectedRoleTemplate, setSelectedRoleTemplate] = useState('');
  const [roleTemplateBusy, setRoleTemplateBusy] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedAssetDetail, setSelectedAssetDetail] = useState<AssetDetailDTO | null>(null);
  // When the inspector is opened by id for an asset that isn't in the in-memory
  // `assets` list (e.g. a freshly-created task-artifact PDF, or a chat opened
  // from a session-scoped surface), fetch its detail by id so the preview never
  // dead-ends on "Asset unavailable". (release202 — PDF preview fix.)
  const [baseAssetDetail, setBaseAssetDetail] = useState<AssetDetailDTO | null>(null);
  // True while the by-id `/detail` fallback is in flight (asset opened from a
  // session / freshly created, not yet in the in-memory `assets` list). Drives
  // the loader so the preview shows the damped animation instead of a static
  // "Asset unavailable" during that resolve window.
  const [baseDetailResolving, setBaseDetailResolving] = useState(false);
  const [selectedAssetRevision, setSelectedAssetRevision] = useState<number | null>(null);
  const [selectedRevisionDetail, setSelectedRevisionDetail] = useState<AssetDetailDTO | null>(null);
  const [assetPreview, setAssetPreview] = useState<AssetPreviewState>({
    loading: false,
    loadingLabel: undefined,
    progress: null,
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

  const inspectorAssetId = inspector?.kind === 'asset' ? inspector.assetId : null;

  const baseAsset = useMemo<AssetDTO | null>(() => {
    if (!inspector || inspector.kind !== 'asset') return null;
    return assets.find((item) => item.id === inspector.assetId) ?? null;
  }, [inspector, assets]);

  const fileByAssetId = useMemo(() => new Map(files.map((file) => [file.assetId, file])), [files]);
  const selectedAssetFromList = useMemo<AssetDTO | null>(() => {
    if (!selectedAssetId) return null;
    return assets.find((item) => item.id === selectedAssetId) ?? null;
  }, [assets, selectedAssetId]);
  const activeRevisionBaseAsset = selectedAssetId
    ? (selectedAssetFromList ?? selectedAssetDetail)
    : (baseAsset ?? baseAssetDetail);
  const asset = selectedAssetRevision ? selectedRevisionDetail : activeRevisionBaseAsset;
  const currentWorkspaceFile = baseAsset ? (fileByAssetId.get(baseAsset.id) ?? null) : null;
  const selectedWorkspaceFile = asset ? (fileByAssetId.get(asset.id) ?? null) : null;
  const assetDisplayTitle = asset
    ? assetTitle(asset, selectedWorkspaceFile ?? currentWorkspaceFile ?? undefined)
    : 'Asset';

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
    setSelectedAssetId(null);
    setSelectedAssetDetail(null);
    setSelectedAssetRevision(null);
    setSelectedRevisionDetail(null);
    setBaseAssetDetail(null);
  }, [inspectorAssetId, open]);

  // Base-asset detail fallback: when opened by id and the asset is NOT in the
  // passed `assets` list, fetch /detail so `asset` resolves (otherwise the
  // preview renders "Asset unavailable" even though the bytes are serveable).
  useEffect(() => {
    if (!open || !inspectorAssetId || baseAsset) {
      setBaseDetailResolving(false);
      return;
    }
    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    setBaseDetailResolving(true);
    void (async () => {
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(inspectorAssetId)}/detail`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Asset detail failed (${res.status})`);
        const body = (await res.json()) as { data?: AssetDetailDTO };
        if (!controller.signal.aborted) setBaseAssetDetail(body.data ?? null);
      } catch {
        if (!controller.signal.aborted) setBaseAssetDetail(null);
      } finally {
        if (!controller.signal.aborted) setBaseDetailResolving(false);
      }
    })();
    return () => controller.abort();
  }, [open, inspectorAssetId, baseAsset]);

  useEffect(() => {
    if (!open || !selectedAssetId || selectedAssetFromList) {
      if (!selectedAssetId || selectedAssetFromList) setSelectedAssetDetail(null);
      return;
    }
    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    setAssetPreview({
      loading: true,
      loadingLabel: 'Loading asset detail...',
      progress: null,
      error: null,
      objectUrl: null,
      text: null,
      bytes: null,
      detail: null,
      previewAsset: null,
    });
    void (async () => {
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(selectedAssetId)}/detail`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Asset detail failed (${res.status})`);
        const body = (await res.json()) as { data?: AssetDetailDTO };
        if (!controller.signal.aborted) setSelectedAssetDetail(body.data ?? null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setAssetPreview({
          loading: false,
          loadingLabel: undefined,
          progress: null,
          error: err instanceof Error ? err.message : 'Asset detail failed',
          objectUrl: null,
          text: null,
          bytes: null,
          detail: null,
          previewAsset: null,
        });
      }
    })();
    return () => controller.abort();
  }, [open, selectedAssetId, selectedAssetFromList]);

  useEffect(() => {
    setSelectedAssetRevision(null);
    setSelectedRevisionDetail(null);
  }, [selectedAssetId]);

  useEffect(() => {
    if (!open || !activeRevisionBaseAsset || selectedAssetRevision === null) {
      if (selectedAssetRevision === null) setSelectedRevisionDetail(null);
      return;
    }
    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/im/assets/${encodeURIComponent(activeRevisionBaseAsset.id)}/detail?revision=${encodeURIComponent(
            selectedAssetRevision,
          )}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        );
        if (!res.ok) throw new Error(`Asset revision detail failed (${res.status})`);
        const body = (await res.json()) as { data?: AssetDetailDTO };
        if (!controller.signal.aborted) setSelectedRevisionDetail(body.data ?? null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setSelectedRevisionDetail(null);
        setAssetPreview({
          loading: false,
          loadingLabel: undefined,
          progress: null,
          error: err instanceof Error ? err.message : 'Asset revision detail failed',
          objectUrl: null,
          text: null,
          bytes: null,
          detail: null,
          previewAsset: null,
        });
      }
    })();
    return () => controller.abort();
  }, [activeRevisionBaseAsset, open, selectedAssetRevision]);

  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    void (async () => {
      const res = await imFetch<RoleTemplateDTO[]>('/role-templates');
      if (!cancelled && res.ok) setRoleTemplates(res.data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agent]);

  useEffect(() => {
    if (!open || !asset) return;
    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setAssetPreview({
      loading: true,
      loadingLabel: 'Loading preview metadata...',
      progress: null,
      error: null,
      objectUrl: null,
      text: null,
      bytes: null,
      detail: null,
      previewAsset: null,
    });

    (async () => {
      try {
        const detailRevisionQuery =
          selectedAssetRevision && activeRevisionBaseAsset?.id === asset.id
            ? `?revision=${encodeURIComponent(selectedAssetRevision)}`
            : '';
        const detailRes = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}/detail${detailRevisionQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        let detail: AssetDetailDTO | null = null;
        if (detailRes.ok) {
          const body = (await detailRes.json()) as { data?: AssetDetailDTO };
          detail = body.data ?? null;
        }

        const previewAsset = choosePreviewAsset(asset, detail);
        const previewContract = previewContractFor(previewAsset, asset, detail);
        const mime = previewAsset.mime ?? '';
        const isPdf = mime.includes('pdf');
        const isMedia = mime.startsWith('video/') || mime.startsWith('audio/');
        const isBinaryWithObjectUrl = mime.startsWith('image/') || isPdf || isMedia;
        const isOffice = isOfficeDoc(previewAsset);
        const usesDuckDB = isDuckDBPreviewAsset(previewAsset);
        const isTabularPreview = isTabularPreviewAsset(previewAsset);
        const shouldFetchText =
          !usesDuckDB &&
          !isOffice &&
          !isPdf &&
          (isTextPreviewable(previewAsset) || isDataPreviewable(previewAsset) || isCodePreviewable(previewAsset));
        const shouldFetchBytes = isBinaryWithObjectUrl || isOffice || shouldFetchText;
        if (
          !usesDuckDB &&
          !isOffice &&
          !isPdf &&
          (previewContract?.inlinePolicy === 'download-only' || previewContract?.status === 'unsupported')
        ) {
          setAssetPreview({
            loading: false,
            loadingLabel: undefined,
            progress: null,
            error: null,
            objectUrl: null,
            text: null,
            bytes: null,
            detail,
            previewAsset,
          });
          return;
        }

        const isLargeTextCandidate = isVirtualTextAsset(previewAsset);
        const textPreviewLimit = isDelimitedTextAsset(previewAsset)
          ? MAX_TABLE_TEXT_PREVIEW_BYTES
          : isLargeTextCandidate
            ? MAX_VIRTUAL_TEXT_PREVIEW_BYTES
            : MAX_TEXT_PREVIEW_BYTES;
        const contractInlineLimit =
          isTabularPreview || isLargeTextCandidate || isOffice || isPdf || usesDuckDB
            ? null
            : previewContract?.maxInlineBytes;
        const localInlineLimit = previewInlineSizeLimit({
          isTabular: isTabularPreview,
          isPdf,
          isOffice,
          shouldFetchText,
          usesDuckDB,
          textPreviewLimit,
        });
        const maxInlineBytes = Math.min(contractInlineLimit ?? localInlineLimit, localInlineLimit);
        if (
          (shouldFetchText || isOffice || isPdf || usesDuckDB || previewContract?.inlinePolicy === 'metadata-only') &&
          previewAsset.sizeBytes != null &&
          previewAsset.sizeBytes > maxInlineBytes
        ) {
          setAssetPreview({
            loading: false,
            loadingLabel: undefined,
            progress: null,
            error: `${previewSizeLabel(previewContract, previewAsset, {
              isTabular: isTabularPreview,
              isPdf,
              isOffice,
              usesDuckDB,
            })} is ${formatBytes(previewAsset.sizeBytes)} — too large for in-browser preview (limit ${formatBytes(maxInlineBytes)}). Download to inspect.`,
            objectUrl: null,
            text: null,
            bytes: null,
            detail,
            previewAsset,
          });
          return;
        }
        if (!shouldFetchBytes) {
          setAssetPreview({
            loading: false,
            loadingLabel: undefined,
            progress: null,
            error: null,
            objectUrl: null,
            text: null,
            bytes: null,
            detail,
            previewAsset,
          });
          return;
        }

        const bytesRevisionQuery =
          selectedAssetRevision && previewAsset.id === asset.id
            ? `?revision=${encodeURIComponent(selectedAssetRevision)}`
            : '';
        setAssetPreview({
          loading: true,
          loadingLabel: `Downloading ${previewSizeLabel(previewContract, previewAsset, {
            isTabular: isTabularPreview,
            isPdf,
            isOffice,
            usesDuckDB,
          }).toLowerCase()}...`,
          progress: null,
          error: null,
          objectUrl: null,
          text: null,
          bytes: null,
          detail,
          previewAsset,
        });
        const res = await fetch(`/api/im/assets/${encodeURIComponent(previewAsset.id)}${bytesRevisionQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const blob = await readPreviewBlobWithProgress(res, previewAsset.sizeBytes ?? null, (progress) => {
          if (controller.signal.aborted) return;
          setAssetPreview((prev) => (prev.loading ? { ...prev, progress } : prev));
        });
        if (isBinaryWithObjectUrl) {
          objectUrl = URL.createObjectURL(blob);
          const bytes = isPdf ? await blob.arrayBuffer() : null;
          setAssetPreview({
            loading: false,
            loadingLabel: undefined,
            progress: null,
            error: null,
            objectUrl,
            text: null,
            bytes,
            detail,
            previewAsset,
          });
          return;
        }
        if (isOffice) {
          const bytes = await blob.arrayBuffer();
          setAssetPreview({
            loading: false,
            loadingLabel: undefined,
            progress: null,
            error: null,
            objectUrl: null,
            text: null,
            bytes,
            detail,
            previewAsset,
          });
          return;
        }
        const text = await blob.text();
        const textCharLimit = isDelimitedTextAsset(previewAsset)
          ? MAX_TABLE_TEXT_PREVIEW_CHARS
          : isLargeTextCandidate
            ? MAX_VIRTUAL_TEXT_PREVIEW_CHARS
            : MAX_TEXT_PREVIEW_CHARS;
        setAssetPreview({
          loading: false,
          loadingLabel: undefined,
          progress: null,
          error: null,
          objectUrl: null,
          text: text.slice(0, textCharLimit),
          bytes: null,
          detail,
          previewAsset,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setAssetPreview({
          loading: false,
          loadingLabel: undefined,
          progress: null,
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
  }, [activeRevisionBaseAsset?.id, asset, open, selectedAssetRevision]);

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

  async function snapshotAgent() {
    if (!agent || agentLifecycleBusy) return;
    const label = window.prompt('Snapshot label', `${agent.name} snapshot`)?.trim();
    if (label === undefined) return;
    setAgentLifecycleBusy('snapshot');
    const res = await imFetch<{ id?: string }>(`/agents/${encodeURIComponent(agent.userId)}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ includeMemory: true, label: label || undefined }),
    });
    setAgentLifecycleBusy(null);
    if (!res.ok) {
      toast(`Snapshot failed: ${res.message}`, 'error');
      return;
    }
    toast(`Snapshot created${res.data?.id ? `: ${res.data.id}` : ''}.`, 'success');
  }

  async function publishAgent() {
    if (!agent || agentLifecycleBusy) return;
    const fallbackSlug = agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const slug = window.prompt('Agent Pack slug', fallbackSlug || agent.userId)?.trim();
    if (!slug) return;
    setAgentLifecycleBusy('publish');
    const res = await imFetch<{ id?: string; slug?: string; version?: string }>(
      `/agents/${encodeURIComponent(agent.userId)}/publish`,
      {
        method: 'POST',
        body: JSON.stringify({
          slug,
          version: '1.0.0',
          stripMemory: true,
          metadata: { title: agent.name, description: agent.description },
        }),
      },
    );
    setAgentLifecycleBusy(null);
    if (!res.ok) {
      toast(`Publish failed: ${res.message}`, 'error');
      return;
    }
    toast(`Agent Pack published: ${res.data?.slug ?? slug}@${res.data?.version ?? '1.0.0'}.`, 'success');
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

  async function updateProfileModel(profile: AgentProfileDTO, model: string) {
    const nextModel = model.trim();
    if (!nextModel || profileBusyId === profile.id) return;
    const currentModel = typeof profile.config?.model === 'string' ? profile.config.model : '';
    if (nextModel === currentModel) return;

    setProfileBusyId(profile.id);
    const res = await imFetch<AgentProfileDTO>(`/agent_profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        config: { ...profile.config, model: nextModel },
        version: profile.version,
      }),
    });
    setProfileBusyId(null);
    if (!res.ok) {
      toast(`Model update failed: ${res.message}`, 'error');
      return;
    }
    setProfileModelDrafts((prev) => {
      const next = { ...prev };
      delete next[profile.id];
      return next;
    });
    toast('Profile model updated. New runs will use it.', 'success');
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

  async function applyRoleTemplate() {
    if (!agent || !selectedRoleTemplate || roleTemplateBusy) return;
    setRoleTemplateBusy(true);
    const res = await imFetch(`/role-templates/${encodeURIComponent(selectedRoleTemplate)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ agentId: agent.userId, workspaceId: profileList[0]?.workspaceId }),
    });
    setRoleTemplateBusy(false);
    if (!res.ok) {
      toast(`Role template apply failed: ${res.message}`, 'error');
      return;
    }
    toast('Role template applied.', 'success');
    await onChanged?.();
  }

  function selectVersionAsset(assetId: string) {
    setSelectedAssetRevision(null);
    setSelectedRevisionDetail(null);
    setSelectedAssetId(assetId === baseAsset?.id ? null : assetId);
  }

  if (inspector.kind === 'asset') {
    return (
      <div
        data-testid="workspace-asset-inspector-panel"
        data-preview-layout={layout}
        className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden ${surface.modal[isDark ? 'dark' : 'light']} ${
          layout === 'split'
            ? `h-full w-full border ${radius.pane} ${isDark ? 'border-white/[0.08]' : 'border-zinc-200/80'}`
            : 'absolute inset-0 z-40'
        }`}
      >
        <div
          className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className="truncate text-sm font-semibold">{assetDisplayTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onToggleLayout ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onToggleLayout}
                aria-label={layout === 'full' ? 'Exit full screen' : 'Full screen'}
                title={layout === 'full' ? 'Exit full screen' : 'Full screen'}
              >
                {layout === 'full' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            ) : null}
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
        </div>
        <div className="min-h-0 overflow-hidden p-3">
          <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
            <div
              className={`min-h-0 flex-1 overflow-hidden rounded-2xl border ${isDark ? 'border-white/[0.08] bg-zinc-950/45' : 'border-zinc-200 bg-zinc-50'}`}
            >
              <AssetPreview
                asset={asset}
                title={assetDisplayTitle}
                state={assetPreview}
                isDark={isDark}
                galleryAssets={assets}
                resolving={!asset && baseDetailResolving}
              />
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
                <AssetVersionSelector
                  currentAsset={baseAsset}
                  currentFile={currentWorkspaceFile}
                  selectedAssetId={asset?.id ?? null}
                  isDark={isDark}
                  onSelectAsset={selectVersionAsset}
                />
                <AssetRevisionSelector
                  currentAsset={activeRevisionBaseAsset}
                  selectedRevision={selectedAssetRevision}
                  isDark={isDark}
                  onSelectRevision={setSelectedAssetRevision}
                />
                <div className="grid gap-3">
                  <DetailRow label="Asset ID" value={asset?.id ?? '-'} isDark={isDark} />
                  <DetailRow label="Content hash" value={asset?.contentHash ?? '-'} isDark={isDark} />
                  <DetailRow label="Asset revision" value={`v${asset?.revision ?? 1}`} isDark={isDark} />
                  <DetailRow
                    label="Workspace file version"
                    value={selectedWorkspaceFile?.version ? `v${selectedWorkspaceFile.version}` : '-'}
                    isDark={isDark}
                  />
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
        className={`flex max-h-[90vh] max-w-[min(96vw,1280px)] flex-col overflow-hidden border ${surface.modal[isDark ? 'dark' : 'light']} ${radius.pane}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {inspector.kind === 'device' ? (
              <Smartphone className="h-4 w-4" />
            ) : (
              (() => {
                const RoleIcon = getAgentRoleIcon(agent?.agentType ?? null);
                return <RoleIcon className="h-4 w-4" />;
              })()
            )}
            <span className="truncate">
              {inspector.kind === 'device' ? (device?.name ?? 'Device') : (agent?.name ?? 'Agent')}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* v2.0 — wrapper for scrollable body. DialogContent is now flex-col
            with max-h-[90vh], so this child grows to fill + scrolls when
            content exceeds the viewport. */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
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
                      <AgentAvatar
                        agent={
                          linked ?? {
                            agentId: runtimeAgent.id,
                            userId: runtimeAgent.id,
                            name: runtimeAgent.name,
                            agentType: null,
                          }
                        }
                        status={agentStatuses?.get(runtimeAgent.id) ?? null}
                        size="md"
                        isDark={isDark}
                        disablePopover
                      />
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
                {agent ? (
                  <AgentAvatar
                    agent={agent}
                    status={agentStatuses?.get(agent.userId) ?? null}
                    size="lg"
                    isDark={isDark}
                  />
                ) : (
                  <div
                    className={`flex h-12 w-12 items-center justify-center rounded-2xl ${isDark ? 'bg-cyan-500/15 text-cyan-200' : 'bg-cyan-50 text-cyan-700'}`}
                  >
                    <span className="text-sm font-bold">?</span>
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{agent?.name ?? 'Unknown agent'}</p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    {agent?.agentType ?? 'unknown type'}
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
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={snapshotAgent}
                disabled={!agent || agentLifecycleBusy !== null}
              >
                {agentLifecycleBusy === 'snapshot' ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Archive className="mr-2 h-3.5 w-3.5" />
                )}
                Snapshot
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={publishAgent}
                disabled={!agent || agentLifecycleBusy !== null}
              >
                {agentLifecycleBusy === 'publish' ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="mr-2 h-3.5 w-3.5" />
                )}
                Publish
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
                    const savedModel = typeof profileModel === 'string' && profileModel ? profileModel : 'us-kimi-k2.6';
                    const draftModel = profileModelDrafts[profile.id] ?? savedModel;
                    const canSaveModel =
                      draftModel.trim().length > 0 && draftModel.trim() !== savedModel && profileBusyId !== profile.id;
                    return (
                      <div
                        key={profile.id}
                        className={`grid gap-3 rounded-2xl border px-3 py-3 ${
                          isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{profile.name}</p>
                            <p className={`truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                              {profile.adapterName} · v{profile.version}
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
                        <div className="grid gap-1">
                          <span
                            className={`text-[10px] font-bold uppercase ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                          >
                            Model
                          </span>
                          <div className="flex items-start gap-2">
                            <ModelPicker
                              value={draftModel}
                              onChange={(nextModel) =>
                                setProfileModelDrafts((prev) => ({ ...prev, [profile.id]: nextModel }))
                              }
                              allowCustom
                              disabled={profileBusyId === profile.id}
                              className={
                                isDark ? 'bg-zinc-950 text-zinc-100 border-white/[0.08]' : 'bg-white text-zinc-900'
                              }
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => updateProfileModel(profile, draftModel)}
                              disabled={!canSaveModel}
                            >
                              {profileBusyId === profile.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section>
              <p
                className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                Role template
              </p>
              <div
                className={`flex flex-col gap-2 rounded-2xl border px-3 py-3 ${
                  isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-white'
                }`}
              >
                <select
                  value={selectedRoleTemplate}
                  onChange={(event) => setSelectedRoleTemplate(event.target.value)}
                  className={`h-9 rounded-md border px-2 text-sm ${
                    isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
                  }`}
                >
                  <option value="">Select a template</option>
                  {roleTemplates.map((template) => {
                    const label =
                      template.displayName?.en ||
                      template.displayName?.zh ||
                      template.name?.en ||
                      template.name?.zh ||
                      template.slug;
                    return (
                      <option key={template.id} value={template.slug}>
                        {label} · {template.taskAuthority ?? 'executor'} · {template.approvalPolicy ?? 'auto-low-risk'}
                      </option>
                    );
                  })}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={applyRoleTemplate}
                  disabled={!selectedRoleTemplate || roleTemplateBusy || profileList.length === 0}
                >
                  {roleTemplateBusy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  Apply template
                </Button>
              </div>
            </section>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div
              className={`min-h-0 flex-1 overflow-hidden rounded-3xl border ${isDark ? 'border-white/[0.08] bg-zinc-950/45' : 'border-zinc-200 bg-zinc-50'}`}
            >
              <AssetPreview
                asset={asset}
                title={assetDisplayTitle}
                state={assetPreview}
                isDark={isDark}
                galleryAssets={assets}
                resolving={!asset && baseDetailResolving}
              />
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

                <AssetVersionSelector
                  currentAsset={baseAsset}
                  currentFile={currentWorkspaceFile}
                  selectedAssetId={asset?.id ?? null}
                  isDark={isDark}
                  onSelectAsset={selectVersionAsset}
                />
                <AssetRevisionSelector
                  currentAsset={activeRevisionBaseAsset}
                  selectedRevision={selectedAssetRevision}
                  isDark={isDark}
                  onSelectRevision={setSelectedAssetRevision}
                />

                <div className="grid gap-3">
                  <DetailRow label="Asset ID" value={asset?.id ?? '—'} isDark={isDark} />
                  <DetailRow label="Content hash" value={asset?.contentHash ?? '—'} isDark={isDark} />
                  <DetailRow label="Asset revision" value={`v${asset?.revision ?? 1}`} isDark={isDark} />
                  <DetailRow
                    label="Workspace file version"
                    value={selectedWorkspaceFile?.version ? `v${selectedWorkspaceFile.version}` : '—'}
                    isDark={isDark}
                  />
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
        </div>
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

async function readPreviewBlobWithProgress(
  response: Response,
  fallbackTotalBytes: number | null,
  onProgress: (progress: AssetPreviewProgress | null) => void,
): Promise<Blob> {
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const totalBytes = parseContentLength(response.headers.get('content-length')) ?? fallbackTotalBytes;
  const reader = response.body?.getReader();
  if (!reader) {
    onProgress(null);
    return response.blob();
  }

  const chunks: BlobPart[] = [];
  let loadedBytes = 0;
  onProgress(progressSnapshot(loadedBytes, totalBytes));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = new Uint8Array(value.byteLength);
    chunk.set(value);
    chunks.push(chunk);
    loadedBytes += value.byteLength;
    onProgress(progressSnapshot(loadedBytes, totalBytes));
  }

  onProgress(progressSnapshot(loadedBytes, totalBytes));
  return new Blob(chunks, { type: contentType });
}

function progressSnapshot(loadedBytes: number, totalBytes: number | null): AssetPreviewProgress {
  return {
    loadedBytes,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : null,
  };
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function AssetPreview({
  asset,
  title,
  state,
  isDark,
  galleryAssets,
  resolving = false,
}: {
  asset: AssetDTO | null;
  title: string;
  state: AssetPreviewState;
  isDark: boolean;
  galleryAssets: AssetDTO[];
  resolving?: boolean;
}) {
  if (!asset) {
    // Still resolving the asset by id (opened from a session before it's in the
    // in-memory list) — show the loader, not a dead "unavailable".
    if (resolving) return <PreviewEmpty isDark={isDark} label="Loading preview…" loading />;
    return <PreviewEmpty isDark={isDark} label="Asset unavailable" />;
  }
  if (state.loading) {
    return (
      <PreviewEmpty
        isDark={isDark}
        label={state.loadingLabel ?? 'Loading preview...'}
        loading
        progress={state.progress}
      />
    );
  }
  if (state.error) {
    return <PreviewEmpty isDark={isDark} label={state.error} />;
  }
  const renderAsset = state.previewAsset ?? asset;
  const mime = renderAsset.mime ?? '';
  // Drop `kind='preview'` rows before they hit the image gallery — those
  // are server-minted derivative thumbnails (e.g. PDF first-page WebP)
  // attached to a parent asset via its `thumbnailUrl`. They're internal
  // plumbing and shouldn't appear as standalone images in the carousel.
  const visibleGalleryAssets = galleryAssets.filter((a) => a.kind !== 'preview');
  const galleryCandidates = imageGalleryCandidates(visibleGalleryAssets.length > 0 ? visibleGalleryAssets : [asset]);
  const hlsManifestUrl = hlsManifestUrlForPreview(renderAsset, asset, state);
  if (hlsManifestUrl) {
    if (isAuthenticatedAssetUrl(hlsManifestUrl)) {
      return <PreviewEmpty isDark={isDark} label="HLS preview is private and requires a CDN callback URL." />;
    }
    return (
      <HlsVideoPlayer
        src={hlsManifestUrl}
        title={title}
        isDark={isDark}
        poster={state.detail?.thumbnailUrl ?? asset.thumbnailUrl ?? null}
      />
    );
  }
  if (isImageAssetForGallery(asset) && galleryCandidates.length > 1) {
    return (
      <AssetImageGallery
        key={asset.id}
        assets={visibleGalleryAssets.length > 0 ? visibleGalleryAssets : [asset]}
        activeAssetId={asset.id}
        isDark={isDark}
      />
    );
  }
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
    return <PdfAssetPreview bytes={state.bytes} objectUrl={state.objectUrl} title={title} isDark={isDark} />;
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
  if (isDuckDBPreviewAsset(renderAsset)) {
    return (
      <DuckDBTablePreview
        key={renderAsset.id}
        asset={renderAsset}
        title={title}
        isDark={isDark}
        signedUrl={state.detail?.s3Url ?? null}
      />
    );
  }
  if (
    (isTextPreviewable(renderAsset) || isCodePreviewable(renderAsset) || isDataPreviewable(renderAsset)) &&
    state.text != null
  ) {
    if (isDelimitedTextAsset(renderAsset)) {
      return <DelimitedTextPreview text={state.text} asset={renderAsset} title={title} isDark={isDark} />;
    }
    if (isHtmlPreviewable(renderAsset)) {
      return <HtmlPreview html={state.text} title={title} isDark={isDark} />;
    }
    const language = previewLanguage(renderAsset);
    const shouldRenderMarkdown = isMarkdownPreviewable(renderAsset);
    if (shouldRenderMarkdown) {
      return <PlateMarkdownEditor markdown={state.text} title={title} isDark={isDark} />;
    }
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
        {shouldUseVirtualTextPreview(renderAsset, state.text) ? (
          <VirtualTextPreview text={state.text} title={title} language={language} isDark={isDark} />
        ) : (
          <AssetCodePreview code={state.text} language={monacoLanguage(renderAsset)} isDark={isDark} />
        )}
      </div>
    );
  }
  if (isSpreadsheetDoc(renderAsset) && state.bytes) {
    return <SpreadsheetPreview key={renderAsset.id} bytes={state.bytes} title={title} isDark={isDark} />;
  }
  if (isPresentationDoc(renderAsset) && state.bytes) {
    return <PresentationPreview key={renderAsset.id} bytes={state.bytes} isDark={isDark} />;
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

// Text previews still parse on the browser main thread (`blob.text()` plus
// editor/rendering), so avoid loading unbounded logs, CSVs, or HTML pages.
const VIRTUAL_TEXT_LINE_THRESHOLD = 2_000;
const VIRTUAL_TEXT_CHAR_THRESHOLD = 160_000;
const VIRTUAL_TEXT_ROW_HEIGHT = 22;
const CODEMIRROR_EDITOR_CHAR_LIMIT = 500_000;

// XLSX parsing is synchronous in SheetJS CE, but rendering must not be.
// Parse a bounded sample, then virtualize rows so multi-thousand row sheets
// are usable instead of freezing the inspector.
const TABLE_ROW_CAP = 50_000;
const TABLE_COL_CAP = 128;
const TABLE_ROW_HEIGHT = 34;
const TABLE_HEADER_HEIGHT = 36;

function convertSheetModel(
  XLSX: typeof import('xlsx'),
  workbook: ReturnType<typeof import('xlsx').read>,
  index: number,
): TableModel {
  const name = workbook.SheetNames[index];
  if (!name) {
    return {
      rows: [],
      colCount: 1,
      truncated: { rows: false, cols: false },
      totalRows: 0,
      totalCols: 0,
    };
  }
  const sheet = workbook.Sheets[name];
  let truncatedRows = false;
  let truncatedCols = false;
  let totalRows = 0;
  let totalCols = 0;
  let range: { s: { r: number; c: number }; e: { r: number; c: number } } | undefined;
  if (sheet['!ref']) {
    const ref = XLSX.utils.decode_range(sheet['!ref']);
    totalRows = Math.max(0, ref.e.r - ref.s.r + 1);
    totalCols = Math.max(0, ref.e.c - ref.s.c + 1);
    truncatedRows = totalRows > TABLE_ROW_CAP;
    truncatedCols = totalCols > TABLE_COL_CAP;
    range = {
      s: ref.s,
      e: {
        r: ref.s.r + Math.min(TABLE_ROW_CAP - 1, ref.e.r - ref.s.r),
        c: ref.s.c + Math.min(TABLE_COL_CAP - 1, ref.e.c - ref.s.c),
      },
    };
  }
  const rawRows = XLSX.utils.sheet_to_json<TableCellValue[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
    ...(range ? { range } : {}),
  });
  const rows = rawRows.map((row) => row.slice(0, TABLE_COL_CAP).map(formatCellValue));
  const observedCols = Math.max(1, ...rows.map((row) => row.length));
  return {
    rows,
    colCount: Math.max(1, Math.min(TABLE_COL_CAP, totalCols || observedCols)),
    truncated: { rows: truncatedRows, cols: truncatedCols },
    totalRows: totalRows || rows.length,
    totalCols: totalCols || observedCols,
  };
}

function SpreadsheetPreview({ bytes, title, isDark }: { bytes: ArrayBuffer; title: string; isDark: boolean }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const [meta, setMeta] = useState<{ names: string[] } | null>(null);
  const [sheets, setSheets] = useState<Map<number, TableModel>>(new Map());
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
            const wb = XLSX.read(new Uint8Array(bytes), { type: 'array', cellDates: true, WTF: false });
            if (wb.SheetNames.length === 0) {
              throw new Error('Spreadsheet has no sheets.');
            }
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
  if (!meta) return <PreviewEmpty isDark={isDark} label="Loading spreadsheet..." loading />;
  const sheetModel = sheets.get(activeSheet);
  if (!sheetModel) {
    return (
      <PreviewEmpty
        isDark={isDark}
        label={
          loadingSheetIdx === activeSheet ? `Loading ${meta.names[activeSheet] ?? 'sheet'}...` : 'Sheet unavailable.'
        }
        loading={loadingSheetIdx === activeSheet}
      />
    );
  }

  const sheetName = meta.names[activeSheet] ?? meta.names[0] ?? 'Sheet';
  const subtitle = [
    sheetName,
    sheetModel.truncated.rows
      ? `showing first ${TABLE_ROW_CAP.toLocaleString()} of ${sheetModel.totalRows.toLocaleString()} rows`
      : `${sheetModel.totalRows.toLocaleString()} rows`,
    sheetModel.truncated.cols
      ? `first ${TABLE_COL_CAP} of ${sheetModel.totalCols.toLocaleString()} columns`
      : `${sheetModel.totalCols.toLocaleString()} columns`,
  ].join(' · ');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-spreadsheet">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{subtitle}</p>
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
      <VirtualTableBody model={sheetModel} isDark={isDark} emptyLabel="This sheet is empty." />
    </div>
  );
}

function DelimitedTextPreview({
  text,
  asset,
  title,
  isDark,
}: {
  text: string;
  asset: AssetDTO;
  title: string;
  isDark: boolean;
}) {
  const delimiter = delimiterForAsset(asset);
  const model = useMemo(() => parseDelimitedText(text, delimiter), [delimiter, text]);
  const kind = delimiter === '\t' ? 'TSV' : 'CSV';
  const subtitle = [
    kind,
    model.truncated.rows
      ? `showing first ${TABLE_ROW_CAP.toLocaleString()} rows`
      : `${model.totalRows.toLocaleString()} rows`,
    model.truncated.cols ? `first ${TABLE_COL_CAP} columns` : `${model.totalCols.toLocaleString()} columns`,
  ].join(' · ');
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-delimited">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{subtitle}</p>
      </div>
      <VirtualTableBody model={model} isDark={isDark} emptyLabel="This table is empty." />
    </div>
  );
}

function VirtualTextPreview({
  text,
  title,
  language,
  isDark,
}: {
  text: string;
  title: string;
  language: string;
  isDark: boolean;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => text.split(/\r\n|\n|\r/), [text]);
  const lineNumberWidth = `${Math.max(4, String(lines.length).length) + 2}ch`;
  // TanStack Virtual is the intended renderer here; the React Compiler warning is expected for this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => VIRTUAL_TEXT_ROW_HEIGHT,
    overscan: 32,
  });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-virtual-text">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {language} preview · {lines.length.toLocaleString()} lines
        </p>
      </div>
      <div ref={parentRef} className={`min-h-0 flex-1 overflow-auto ${isDark ? 'bg-zinc-950' : 'bg-white'}`}>
        <div
          className="relative font-mono text-[12px] leading-5"
          style={{ height: rowVirtualizer.getTotalSize(), minWidth: '100%' }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const line = lines[virtualRow.index] ?? '';
            return (
              <div
                key={virtualRow.key}
                className={`absolute left-0 grid min-w-full border-b ${
                  isDark ? 'border-white/[0.03] text-zinc-200' : 'border-zinc-100 text-zinc-800'
                }`}
                style={{
                  gridTemplateColumns: `${lineNumberWidth} minmax(max-content, 1fr)`,
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  className={`select-none border-r px-3 text-right text-[11px] ${
                    isDark
                      ? 'border-white/[0.06] bg-white/[0.02] text-zinc-600'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-400'
                  }`}
                >
                  {virtualRow.index + 1}
                </div>
                <div className="whitespace-pre px-3">{line || ' '}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VirtualTableBody({ model, isDark, emptyLabel }: { model: TableModel; isDark: boolean; emptyLabel: string }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const data = useMemo<TableRowModel[]>(
    () => model.rows.map((cells, index) => ({ rowNumber: index + 1, cells })),
    [model.rows],
  );
  const columns = useMemo<ColumnDef<TableRowModel>[]>(
    () => [
      {
        id: '__rowNumber',
        header: '#',
        cell: ({ row }) => row.original.rowNumber.toLocaleString(),
      },
      ...Array.from(
        { length: model.colCount },
        (_, index): ColumnDef<TableRowModel> => ({
          id: `col_${index}`,
          header: columnName(index),
          accessorFn: (row: TableRowModel) => row.cells[index] ?? '',
          cell: (info) => String(info.getValue() ?? ''),
        }),
      ),
    ],
    [model.colCount],
  );
  // TanStack Table exposes imperative helpers internally; keep it scoped to this non-memoized renderer.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TABLE_ROW_HEIGHT,
    overscan: 16,
  });

  if (tableRows.length === 0) return <PreviewEmpty isDark={isDark} label={emptyLabel} />;

  const minWidth = 56 + model.colCount * 150;
  const gridTemplateColumns = `56px repeat(${model.colCount}, minmax(140px, 1fr))`;
  const cellBorder = isDark ? 'border-white/[0.06]' : 'border-zinc-200';
  const headerBg = isDark ? 'bg-zinc-950 text-zinc-400' : 'bg-zinc-50 text-zinc-600';
  const rowText = isDark ? 'text-zinc-200' : 'text-zinc-800';
  const headerGroup = table.getHeaderGroups()[0];

  return (
    <div ref={parentRef} className={`min-h-0 flex-1 overflow-auto ${isDark ? 'bg-zinc-950' : 'bg-white'}`}>
      <div
        className="relative"
        style={{
          height: rowVirtualizer.getTotalSize() + TABLE_HEADER_HEIGHT,
          minWidth,
        }}
      >
        <div
          className={`sticky top-0 z-10 grid border-b text-[11px] font-semibold ${headerBg} ${cellBorder}`}
          style={{ gridTemplateColumns, height: TABLE_HEADER_HEIGHT, minWidth }}
        >
          {headerGroup?.headers.map((header) => (
            <div key={header.id} className={`flex items-center border-r px-3 ${cellBorder}`}>
              {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const tableRow = tableRows[virtualRow.index];
          if (!tableRow) return null;
          const cells = tableRow.getVisibleCells().slice(1);
          return (
            <div
              key={virtualRow.key}
              className={`absolute left-0 grid border-b text-xs ${rowText} ${cellBorder}`}
              style={{
                gridTemplateColumns,
                height: virtualRow.size,
                minWidth,
                transform: `translateY(${virtualRow.start + TABLE_HEADER_HEIGHT}px)`,
              }}
            >
              <div
                className={`flex items-center border-r px-3 font-mono text-[11px] ${
                  isDark ? 'bg-white/[0.02] text-zinc-500' : 'bg-zinc-50 text-zinc-500'
                } ${cellBorder}`}
              >
                {tableRow.original.rowNumber.toLocaleString()}
              </div>
              {cells.map((cell) => {
                const value = String(cell.getValue() ?? '');
                return (
                  <div key={cell.id} className={`truncate border-r px-3 py-2 ${cellBorder}`} title={value}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function parseDelimitedText(text: string, delimiter: ',' | '\t'): TableModel {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let totalRows = 0;
  let totalCols = 0;
  let truncatedRows = false;
  let truncatedCols = false;

  const pushCell = () => {
    if (row.length < TABLE_COL_CAP) {
      row.push(cell);
    } else {
      truncatedCols = true;
    }
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    totalRows += 1;
    totalCols = Math.max(totalCols, row.length);
    if (rows.length < TABLE_ROW_CAP) {
      rows.push(row);
    } else {
      truncatedRows = true;
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      pushCell();
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
      if (truncatedRows) break;
      continue;
    }
    cell += ch;
  }
  if (!truncatedRows && (cell.length > 0 || row.length > 0)) pushRow();

  return {
    rows,
    colCount: Math.max(1, Math.min(TABLE_COL_CAP, totalCols || rows[0]?.length || 1)),
    truncated: { rows: truncatedRows, cols: truncatedCols },
    totalRows,
    totalCols: totalCols || rows[0]?.length || 0,
  };
}

const PPTX_BASE_WIDTH = 960;
const PPTX_BASE_HEIGHT = 540;
const PPTX_ASPECT_RATIO = PPTX_BASE_WIDTH / PPTX_BASE_HEIGHT;
const PPTX_VIEWPORT_PADDING = 16;

function pptxFitSize(width: number, height: number): { width: number; height: number; scale: number } | null {
  const availableWidth = Math.max(0, width - PPTX_VIEWPORT_PADDING);
  const availableHeight = Math.max(0, height - PPTX_VIEWPORT_PADDING);
  if (availableWidth < 1 || availableHeight < 1) return null;

  let fittedWidth = Math.min(availableWidth, availableHeight * PPTX_ASPECT_RATIO);
  let fittedHeight = fittedWidth / PPTX_ASPECT_RATIO;
  if (fittedHeight > availableHeight) {
    fittedHeight = availableHeight;
    fittedWidth = fittedHeight * PPTX_ASPECT_RATIO;
  }
  const scale = fittedWidth / PPTX_BASE_WIDTH;
  return {
    width: Math.max(1, Math.round(fittedWidth)),
    height: Math.max(1, Math.round(fittedHeight)),
    scale,
  };
}

function PresentationPreview({ bytes, isDark }: { bytes: ArrayBuffer; isDark: boolean }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [renderSize, setRenderSize] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [hasRenderedSlides, setHasRenderedSlides] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    let frame = 0;
    const updateSize = () => {
      const next = pptxFitSize(viewport.clientWidth, viewport.clientHeight);
      setRenderSize((prev) => {
        if (!next) return prev;
        if (prev && Math.abs(prev.width - next.width) < 8 && Math.abs(prev.height - next.height) < 8) return prev;
        return next;
      });
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateSize);
    });
    observer.observe(viewport);
    updateSize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let previewer: { preview: (file: ArrayBuffer) => Promise<unknown>; destroy: () => void } | null = null;
    const host = hostRef.current;
    if (!host) return undefined;
    host.innerHTML = '';
    setHasRenderedSlides(false);
    setError(null);
    setIsLoading(true);
    const observer = new MutationObserver(() => {
      if (pptxHasRenderedContent(host)) {
        setHasRenderedSlides(true);
      }
    });
    observer.observe(host, { childList: true, subtree: true });
    import('pptx-preview')
      .then(({ init }) => {
        if (cancelled) return undefined;
        previewer = init(host, { width: PPTX_BASE_WIDTH, height: PPTX_BASE_HEIGHT, mode: 'list' });
        return previewer.preview(bytes.slice(0));
      })
      .then(() => {
        if (!cancelled) {
          setHasRenderedSlides(pptxHasRenderedContent(host));
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Presentation preview failed');
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
      observer.disconnect();
      previewer?.destroy?.();
      host.innerHTML = '';
    };
  }, [bytes]);

  if (error) return <PreviewEmpty isDark={isDark} label={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-presentation">
      <div
        ref={viewportRef}
        className="asset-pptx-viewport relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-100 p-4"
      >
        {isLoading || !hasRenderedSlides ? (
          <div className="absolute inset-0">
            <PreviewEmpty
              isDark={isDark}
              label={isLoading ? 'Parsing PowerPoint preview...' : 'Rendering PowerPoint slides...'}
              loading
            />
          </div>
        ) : null}
        <div
          // Slide stack top-aligns inside the viewport so the first slide is
          // immediately visible. `pptxFitSize` preserves 16:9 aspect; any
          // remaining vertical room becomes the natural scroll area for
          // additional slides instead of dead space above/below.
          className="mx-auto flex w-fit flex-col items-center justify-start overflow-hidden"
          style={renderSize ? { width: renderSize.width } : undefined}
        >
          <div
            ref={hostRef}
            className="asset-pptx-viewer"
            style={
              renderSize
                ? ({
                    width: renderSize.width,
                    height: renderSize.height,
                    '--pptx-scale': String(renderSize.scale),
                  } as CSSProperties & { '--pptx-scale': string })
                : undefined
            }
          />
        </div>
        <style>{`
          .asset-pptx-viewport .pptx-preview-wrapper {
            background: transparent !important;
            margin: 0 !important;
            max-width: none !important;
            transform: scale(var(--pptx-scale, 1));
            transform-origin: 0 0;
          }
          .asset-pptx-viewport .pptx-preview-slide-wrapper {
            box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
            margin: 0 auto 16px !important;
          }
        `}</style>
      </div>
    </div>
  );
}

function pptxHasRenderedContent(host: HTMLElement): boolean {
  return Boolean(host.querySelector('.pptx-preview-slide-wrapper, .slide-wrapper'));
}

type WordPreviewMode = 'loading' | 'docx-preview' | 'mammoth';

function WordPreview({ bytes, title, isDark }: { bytes: ArrayBuffer; title: string; isDark: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<WordPreviewMode>('loading');
  const [result, setResult] = useState<{ html: string; warnings: string[]; primaryError: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sanitized = useMemo(() => sanitizeHtml(result?.html ?? ''), [result?.html]);
  const srcDoc = useMemo(
    () => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 32px;
      font: 14px/1.7 ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
      color: #18181b;
      background: #ffffff;
    }
    p { margin: 0 0 0.85em; }
    h1, h2, h3, h4, h5, h6 { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.25; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; width: max-content; max-width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #d4d4d8; padding: 6px 8px; vertical-align: top; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    pre { overflow: auto; background: #f4f4f5; padding: 12px; border-radius: 8px; }
    a { color: #4f46e5; }
  </style>
</head>
<body>${sanitized}</body>
</html>`,
    [sanitized],
  );

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;
    host.innerHTML = '';
    setMode('loading');
    setResult(null);
    setError(null);

    const runMammothFallback = async (primaryError: string | null) => {
      const mammoth = await import('mammoth');
      const next = await mammoth.convertToHtml(
        { arrayBuffer: bytes },
        {
          includeDefaultStyleMap: true,
          convertImage: mammoth.images.imgElement((image) =>
            image.read('base64').then((imageBuffer) => ({
              src: `data:${image.contentType};base64,${imageBuffer}`,
            })),
          ),
        },
      );
      if (cancelled) return;
      setMode('mammoth');
      setResult({
        html: next.value,
        warnings: next.messages.map((message) => message.message).filter(Boolean),
        primaryError,
      });
    };

    import('docx-preview')
      .then(async ({ renderAsync }) => {
        if (cancelled) return;
        await renderAsync(new Blob([bytes]), host, host, {
          inWrapper: true,
          className: 'asset-docx-wrapper',
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderAltChunks: false,
          renderComments: true,
          renderChanges: true,
          useBase64URL: true,
        });
        if (cancelled) return;
        setMode('docx-preview');
      })
      .catch((err) => {
        host.innerHTML = '';
        runMammothFallback(err instanceof Error ? err.message : 'docx-preview failed').catch((fallbackErr) => {
          if (!cancelled) setError(fallbackErr instanceof Error ? fallbackErr.message : 'Word preview failed');
        });
      });
    return () => {
      cancelled = true;
      host.innerHTML = '';
    };
  }, [bytes]);

  if (error) return <PreviewEmpty isDark={isDark} label={error} />;
  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-word">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p className={`truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {mode === 'docx-preview' ? 'Word preview via docx-preview' : 'Word fallback via mammoth'}
          {result?.primaryError ? ` · primary renderer failed: ${result.primaryError.slice(0, 160)}` : ''}
          {result?.warnings.length
            ? ` · ${result.warnings.length} conversion warning${result.warnings.length === 1 ? '' : 's'}`
            : ''}
        </p>
      </div>
      <div className={`relative min-h-0 flex-1 ${isDark ? 'bg-zinc-950' : 'bg-zinc-100'}`}>
        {isLoading ? <PreviewEmpty isDark={isDark} label="Loading Word preview..." loading /> : null}
        <div
          ref={hostRef}
          className={`asset-docx-preview h-full overflow-auto p-4 ${mode === 'docx-preview' ? 'block' : 'hidden'}`}
        />
        {mode === 'mammoth' && result ? (
          <iframe
            title={`${title} Word preview`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            className="h-full min-h-0 w-full bg-white"
          />
        ) : null}
        <style>{`
          .asset-docx-preview .docx-wrapper {
            background: transparent;
            padding: 0;
          }
          .asset-docx-preview .asset-docx-wrapper {
            margin: 0 auto 16px;
            box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
          }
          .asset-docx-preview section.docx {
            margin: 0 auto 16px;
          }
        `}</style>
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

function PreviewEmpty({
  isDark,
  label,
  loading = false,
  progress = null,
}: {
  isDark: boolean;
  label: string;
  loading?: boolean;
  progress?: AssetPreviewProgress | null;
}) {
  const normalizedProgress =
    typeof progress?.percent === 'number' && Number.isFinite(progress.percent)
      ? Math.min(100, Math.max(0, progress.percent))
      : null;
  const progressLabel = progress ? previewProgressLabel(progress) : null;
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-3xl ${isDark ? 'bg-white/[0.05] text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}
      >
        {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <FileText className="h-6 w-6" />}
      </div>
      <p className={`mt-3 max-w-sm text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{label}</p>
      {progressLabel ? (
        <p className={`mt-1 text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{progressLabel}</p>
      ) : null}
      {loading ? (
        <div className="mt-4 w-full max-w-[260px]">
          <DampedProgressBar isDark={isDark} percent={normalizedProgress} />
        </div>
      ) : null}
    </div>
  );
}

function previewProgressLabel(progress: AssetPreviewProgress): string {
  const loaded = formatBytes(progress.loadedBytes);
  if (progress.totalBytes) {
    return `${progress.percent ?? 0}% · ${loaded} / ${formatBytes(progress.totalBytes)}`;
  }
  return `${loaded} downloaded`;
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
  const originalMime = asset.mime ?? '';
  if (
    originalMime.includes('pdf') ||
    originalMime.startsWith('image/') ||
    originalMime.startsWith('video/') ||
    originalMime.startsWith('audio/')
  ) {
    return asset;
  }
  const imagePreview = derived.find(
    (item) => (item.mime ?? '').startsWith('image/') || item.derivationKind === 'thumbnail',
  );
  if (imagePreview) return imagePreview;
  return asset;
}

function previewContractFor(renderAsset: AssetDTO, originalAsset: AssetDTO, detail: AssetDetailDTO | null) {
  if (detail?.preview && detail.id === renderAsset.id) return detail.preview;
  if (renderAsset.preview) return renderAsset.preview;
  if (detail?.preview && originalAsset.id === renderAsset.id) return detail.preview;
  return null;
}

function previewLabel(contract: AssetDTO['preview'] | null | undefined, asset: AssetDTO) {
  if (contract?.kind === 'html') return 'HTML preview';
  if (contract?.kind === 'table') return 'Table preview';
  if (contract?.kind === 'code') return 'Code preview';
  if (contract?.kind === 'text') return 'Text preview';
  return `${asset.kind || 'Asset'} preview`;
}

function previewSizeLabel(
  contract: AssetDTO['preview'] | null | undefined,
  asset: AssetDTO,
  flags: { isTabular: boolean; isPdf: boolean; isOffice: boolean; usesDuckDB: boolean },
) {
  return previewGateLabel({
    isTabular: flags.isTabular,
    isPdf: flags.isPdf,
    isOffice: flags.isOffice,
    usesDuckDB: flags.usesDuckDB,
    baseLabel: previewLabel(contract, asset),
    officeLabel: `${officeFlavour(asset)} preview`,
  });
}

function hlsManifestUrlForPreview(
  renderAsset: AssetDTO,
  originalAsset: AssetDTO,
  state: AssetPreviewState,
): string | null {
  if (renderAsset.derivationKind === 'hls-manifest') {
    return nonEmptyString(renderAsset.cdnUrl) ?? `/api/im/assets/${encodeURIComponent(renderAsset.id)}`;
  }
  const derivatives = [
    ...(state.detail?.preview?.derivatives ?? []),
    ...(renderAsset.preview?.derivatives ?? []),
    ...(originalAsset.preview?.derivatives ?? []),
  ];
  const hls = derivatives.find((item) => item.type === 'hls_manifest');
  if (!hls) return null;
  return nonEmptyString(hls.url) ?? nonEmptyString(hls.endpoint);
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAuthenticatedAssetUrl(url: string): boolean {
  return url.startsWith('/api/im/assets/');
}

function isImageAssetForGallery(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
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

function isVirtualTextAsset(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    !isDelimitedTextAsset(asset) &&
    !isHtmlPreviewable(asset) &&
    !isMarkdownPreviewable(asset) &&
    !isCodePreviewable(asset) &&
    (mime === 'text/plain' ||
      /\.(txt|log|rst|ini|conf|env|properties)$/i.test(name) ||
      (mime === 'application/octet-stream' && /\.(txt|log|rst|ini|conf|env|properties)$/i.test(name)))
  );
}

function shouldUseVirtualTextPreview(asset: AssetDTO, text: string) {
  return (
    isVirtualTextAsset(asset) &&
    (text.length > VIRTUAL_TEXT_CHAR_THRESHOLD || hasLineCountAtLeast(text, VIRTUAL_TEXT_LINE_THRESHOLD))
  );
}

function hasLineCountAtLeast(text: string, threshold: number) {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch !== '\n' && ch !== '\r') continue;
    lines += 1;
    if (ch === '\r' && text[index + 1] === '\n') index += 1;
    if (lines >= threshold) return true;
  }
  return false;
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
    mime.includes('parquet') ||
    asset.kind.includes('dataset') ||
    /\.(json|csv|tsv|ndjson|parquet)$/.test(name)
  );
}

function isDelimitedTextAsset(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('csv') || mime.includes('tab-separated-values') || /\.(csv|tsv)$/.test(name);
}

function isTabularPreviewAsset(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    isSpreadsheetDoc(asset) || isDelimitedTextAsset(asset) || mime.includes('parquet') || /\.(parquet)$/.test(name)
  );
}

function delimiterForAsset(asset: AssetDTO): ',' | '\t' {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('tab-separated-values') || name.endsWith('.tsv') ? '\t' : ',';
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

function isHtmlPreviewable(asset: AssetDTO) {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('html') || /\.(html|htm|xhtml)$/i.test(name);
}

function monacoLanguage(asset: AssetDTO): string {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  if (mime.includes('json') || name.endsWith('.json') || name.endsWith('.ndjson')) return 'json';
  if (name.endsWith('.py') || mime.includes('python')) return 'python';
  if (name.endsWith('.tsx')) return 'typescript';
  if (name.endsWith('.ts')) return 'typescript';
  if (name.endsWith('.jsx')) return 'javascript';
  if (name.endsWith('.js') || mime.includes('javascript')) return 'javascript';
  if (name.endsWith('.css')) return 'css';
  if (name.endsWith('.html') || mime.includes('html')) return 'html';
  if (name.endsWith('.sql')) return 'sql';
  if (name.endsWith('.yaml') || name.endsWith('.yml') || mime.includes('yaml')) return 'yaml';
  if (name.endsWith('.toml')) return 'ini';
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell';
  if (name.endsWith('.rs')) return 'rust';
  if (name.endsWith('.go')) return 'go';
  if (name.endsWith('.java')) return 'java';
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
  return 'plaintext';
}

function HtmlPreview({ html, title, isDark }: { html: string; title: string; isDark: boolean }) {
  const [mode, setMode] = useState<'render' | 'source'>('render');
  const sanitized = useMemo(() => sanitizeHtml(html), [html]);
  const srcDoc = useMemo(
    () => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 24px;
      font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #18181b;
      background: #ffffff;
    }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; width: max-content; max-width: 100%; }
    th, td { border: 1px solid #d4d4d8; padding: 6px 8px; vertical-align: top; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    pre { overflow: auto; background: #f4f4f5; padding: 12px; border-radius: 8px; }
    a { color: #4f46e5; }
  </style>
</head>
<body>${sanitized}</body>
</html>`,
    [sanitized],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-html">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              HTML preview {mode === 'render' ? '(sanitized)' : '(source)'}
            </p>
          </div>
          <div
            className={`flex shrink-0 rounded-lg border p-0.5 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}
          >
            {(['render', 'source'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  mode === item
                    ? isDark
                      ? 'bg-violet-500/20 text-violet-100'
                      : 'bg-violet-100 text-violet-900'
                    : isDark
                      ? 'text-zinc-400 hover:bg-white/[0.05]'
                      : 'text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                {item === 'render' ? 'Render' : 'Source'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === 'render' ? (
        <iframe
          title={`${title} HTML preview`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className={`min-h-0 flex-1 w-full ${isDark ? 'bg-white' : 'bg-white'}`}
        />
      ) : (
        <AssetCodePreview code={html} language="html" isDark={isDark} />
      )}
    </div>
  );
}

type AssetCodeMode = 'highlight' | 'editor' | 'full';

function AssetCodePreview({ code, language, isDark }: { code: string; language: string; isDark: boolean }) {
  const [mode, setMode] = useState<AssetCodeMode>('highlight');
  const [highlightHtml, setHighlightHtml] = useState<string | null>(null);
  const [highlightError, setHighlightError] = useState<string | null>(null);
  const editorMode: Exclude<AssetCodeMode, 'highlight'> =
    code.length > CODEMIRROR_EDITOR_CHAR_LIMIT ? 'full' : 'editor';
  const activeMode: AssetCodeMode = mode === 'highlight' ? 'highlight' : editorMode;

  useEffect(() => {
    if (mode !== 'highlight') return undefined;
    let cancelled = false;
    setHighlightHtml(null);
    setHighlightError(null);
    import('shiki')
      .then(async ({ codeToHtml }) => {
        const lang = shikiLanguage(language);
        try {
          return await codeToHtml(code, {
            lang,
            theme: isDark ? 'github-dark' : 'github-light',
          });
        } catch {
          return codeToHtml(code, {
            lang: 'text',
            theme: isDark ? 'github-dark' : 'github-light',
          });
        }
      })
      .then((html) => {
        if (!cancelled) setHighlightHtml(html);
      })
      .catch((err) => {
        if (!cancelled) setHighlightError(err instanceof Error ? err.message : 'Code preview failed');
      });
    return () => {
      cancelled = true;
    };
  }, [code, isDark, language, mode]);

  useEffect(() => {
    if (mode !== activeMode) setMode(activeMode);
  }, [activeMode, mode]);

  const modeButtons: Array<{ id: AssetCodeMode; label: string }> = [
    { id: 'highlight', label: 'Preview' },
    { id: editorMode, label: editorMode === 'editor' ? 'Edit' : 'Full editor' },
  ];

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden ${isDark ? 'bg-zinc-950' : 'bg-white'}`}
      data-testid="asset-preview-code"
    >
      <div
        className={`flex items-center justify-end border-b px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
      >
        <div className={`flex rounded-lg border p-0.5 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}>
          {modeButtons.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMode(item.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                activeMode === item.id
                  ? isDark
                    ? 'bg-violet-500/20 text-violet-100'
                    : 'bg-violet-100 text-violet-900'
                  : isDark
                    ? 'text-zinc-400 hover:bg-white/[0.05]'
                    : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {activeMode === 'editor' ? (
        <CodeMirrorEditor code={code} language={language} isDark={isDark} />
      ) : activeMode === 'full' ? (
        <MonacoReadOnlyEditor code={code} language={language} isDark={isDark} />
      ) : highlightHtml ? (
        <div
          className="min-h-0 flex-1 overflow-auto text-[13px] [&_pre]:m-0 [&_pre]:min-h-full [&_pre]:p-4"
          dangerouslySetInnerHTML={{ __html: highlightHtml }}
        />
      ) : (
        <PreviewEmpty isDark={isDark} label={highlightError ?? 'Loading code preview...'} loading={!highlightError} />
      )}
    </div>
  );
}

function CodeMirrorEditor({ code, language, isDark }: { code: string; language: string; isDark: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<{ destroy: () => void } | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;
    setFailed(false);
    setLoading(true);
    host.innerHTML = '';

    (async () => {
      try {
        const [{ EditorView, basicSetup }, { EditorState }, languageExtension] = await Promise.all([
          import('codemirror'),
          import('@codemirror/state'),
          loadCodeMirrorLanguage(language),
        ]);
        if (cancelled || !hostRef.current) return;
        const theme = EditorView.theme(
          {
            '&': {
              height: '100%',
              backgroundColor: isDark ? '#09090b' : '#ffffff',
              color: isDark ? '#e4e4e7' : '#27272a',
            },
            '.cm-scroller': {
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: '13px',
              lineHeight: '1.5',
            },
            '.cm-content': {
              padding: '16px 0',
            },
            '.cm-line': {
              padding: '0 16px',
            },
            '.cm-gutters': {
              backgroundColor: isDark ? '#09090b' : '#fafafa',
              borderRightColor: isDark ? 'rgba(255,255,255,0.08)' : '#e4e4e7',
              color: isDark ? '#71717a' : '#a1a1aa',
            },
            '.cm-activeLine, .cm-activeLineGutter': {
              backgroundColor: isDark ? 'rgba(139,92,246,0.12)' : 'rgba(139,92,246,0.08)',
            },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
              backgroundColor: isDark ? 'rgba(139,92,246,0.35)' : 'rgba(139,92,246,0.22)',
            },
            '&.cm-focused': {
              outline: 'none',
            },
          },
          { dark: isDark },
        );
        const extensions = languageExtension ? [basicSetup, theme, languageExtension] : [basicSetup, theme];
        const state = EditorState.create({ doc: code, extensions });
        const view = new EditorView({ state, parent: hostRef.current });
        viewRef.current = view;
        setLoading(false);
      } catch {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      host.innerHTML = '';
    };
  }, [code, isDark, language]);

  if (failed) return <MonacoReadOnlyEditor code={code} language={language} isDark={isDark} />;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {loading ? (
        <div className="absolute inset-0 z-10">
          <PreviewEmpty isDark={isDark} label="Loading editor..." loading />
        </div>
      ) : null}
      <div ref={hostRef} className="h-full" />
    </div>
  );
}

async function loadCodeMirrorLanguage(language: string) {
  if (language === 'javascript') {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ jsx: true });
  }
  if (language === 'typescript') {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ jsx: true, typescript: true });
  }
  if (language === 'json') {
    const { json } = await import('@codemirror/lang-json');
    return json();
  }
  if (language === 'python') {
    const { python } = await import('@codemirror/lang-python');
    return python();
  }
  if (language === 'css') {
    const { css } = await import('@codemirror/lang-css');
    return css();
  }
  if (language === 'html') {
    const { html } = await import('@codemirror/lang-html');
    return html();
  }
  if (language === 'sql') {
    const { sql } = await import('@codemirror/lang-sql');
    return sql();
  }
  if (language === 'yaml') {
    const { yaml } = await import('@codemirror/lang-yaml');
    return yaml();
  }
  if (language === 'markdown') {
    const { markdown } = await import('@codemirror/lang-markdown');
    return markdown();
  }
  return null;
}

function MonacoReadOnlyEditor({ code, language, isDark }: { code: string; language: string; isDark: boolean }) {
  const [EditorComponent, setEditorComponent] = useState<null | typeof import('@monaco-editor/react').default>(null);

  useEffect(() => {
    let cancelled = false;
    import('@monaco-editor/react').then((mod) => {
      if (!cancelled) setEditorComponent(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!EditorComponent) return <PreviewEmpty isDark={isDark} label="Loading full editor..." loading />;

  return (
    <EditorComponent
      height="100%"
      language={language}
      value={code}
      theme={isDark ? 'vs-dark' : 'light'}
      options={{
        readOnly: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        lineNumbers: 'on',
        folding: true,
        automaticLayout: true,
        fontSize: 13,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        renderLineHighlight: 'line',
        bracketPairColorization: { enabled: true },
        guides: { indentation: true, bracketPairs: true },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}

function shikiLanguage(language: string) {
  if (language === 'plaintext') return 'text';
  if (language === 'shell') return 'bash';
  if (language === 'typescript') return 'ts';
  if (language === 'javascript') return 'js';
  return language;
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
