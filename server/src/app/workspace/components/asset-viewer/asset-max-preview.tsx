'use client';

/**
 * AssetMaxPreview — full-size (modal-scale) mime-branched preview.
 *
 * **Single source of truth** for "open attachment in a big preview"
 * surfaces. Chat-side `MessageAssetViewerModal` MUST delegate here — do
 * not re-implement <img>/<video>/<audio>/<pre>/react-pdf branches
 * elsewhere. Concrete sibling viewers in this folder do the real
 * rendering; this file routes per mime:
 *
 *   image/*         → inline <img object-contain>     (canonical max image)
 *   application/pdf → PdfAssetPreview                 (sibling)
 *   video/*  HLS    → HlsVideoPlayer                  (sibling, video.js)
 *   video/*  other  → inline <video controls>         (canonical max video)
 *   audio/*         → inline <audio controls>         (canonical max audio)
 *   csv/tsv/parquet → DuckDBTablePreview              (sibling, duckdb-wasm)
 *   text/markdown   → PlateMarkdownEditor             (sibling, plate)
 *   text/*          → inline <pre> first 4 KB         (canonical max text)
 *   other           → friendly fallback + Download
 *
 * Input shape is the lighter `MessageAsset` (chat attachment) — does not
 * require the full Library `AssetDTO`. Authenticated bytes are fetched
 * via `useAuthenticatedAssetBlobUrl` for IMAsset-backed paths; legacy
 * `metadata.fileUrl` attachments short-circuit to their public CDN URL.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileWarning } from 'lucide-react';

import { getWorkspaceToken } from '../../lib/im-api';
import type { AssetDTO } from '../../lib/types';

import { bucketForMime, thumbHashDataUrl, type MessageAsset, type MimeBucket } from '../message-asset-card';
import { AssetLoadingIndicator } from './asset-loading-indicator';

const PdfAssetPreview = dynamic(() => import('./pdf-asset-preview').then((m) => m.PdfAssetPreview), {
  ssr: false,
  loading: () => <LoadingBlock isDark={false} />,
});
const HlsVideoPlayer = dynamic(() => import('./hls-video-player').then((m) => m.HlsVideoPlayer), {
  ssr: false,
  loading: () => <LoadingBlock isDark={false} />,
});
const DuckDBTablePreview = dynamic(() => import('./duckdb-table-preview').then((m) => m.DuckDBTablePreview), {
  ssr: false,
  loading: () => <LoadingBlock isDark={false} />,
});
const PlateMarkdownEditor = dynamic(() => import('./plate-markdown-editor').then((m) => m.PlateMarkdownEditor), {
  ssr: false,
  loading: () => <LoadingBlock isDark={false} />,
});

const TEXT_PREVIEW_BYTES = 4 * 1024;

export interface AssetMaxPreviewProps {
  asset: MessageAsset;
  isDark?: boolean;
}

export function AssetMaxPreview({ asset, isDark = false }: AssetMaxPreviewProps) {
  const bucket: MimeBucket = bucketForMime(asset.mime ?? null);
  if (bucket === 'image') return <MaxImageBody asset={asset} isDark={isDark} />;
  if (bucket === 'pdf') return <MaxPdfBody asset={asset} isDark={isDark} />;
  if (bucket === 'video') return <MaxVideoBody asset={asset} isDark={isDark} />;
  if (bucket === 'audio') return <MaxAudioBody asset={asset} isDark={isDark} />;

  // tabular (csv/tsv/parquet) is encoded as bucket='other' or 'text' by
  // bucketForMime — sniff before delegating to the generic text/other branch.
  if (isTabular(asset)) return <MaxTabularBody asset={asset} isDark={isDark} />;

  if (bucket === 'text') {
    if (isMarkdown(asset)) return <MaxMarkdownBody asset={asset} isDark={isDark} />;
    return <MaxTextBody asset={asset} isDark={isDark} />;
  }
  return (
    <FallbackBlock
      isDark={isDark}
      message={`Preview not available for ${asset.mime ?? 'this file type'}. Download to open locally.`}
    />
  );
}

function MaxImageBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  const { url, error } = useAuthenticatedAssetBlobUrl(asset);
  // release202/13 §3b① — instant blurred thumbHash placeholder behind the full
  // image; the real <img> fades in on load. No network for the placeholder.
  const blurUrl = useMemo(() => thumbHashDataUrl(asset.blurHash), [asset.blurHash]);
  const [imgLoaded, setImgLoaded] = useState(false);
  return (
    <div
      className={`relative flex h-full items-center justify-center overflow-hidden rounded-xl border ${
        isDark ? 'border-white/[0.06] bg-black/30' : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      {url ? (
        <>
          {blurUrl && !imgLoaded ? (
            // eslint-disable-next-line @next/next/no-img-element -- decoded thumbHash data URL (no network).
            <img
              src={blurUrl}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-contain blur-xl"
            />
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- chat attachment bytes; Next image loader not configured for IM-served URLs. */}
          <img
            src={url}
            alt={asset.filename ?? 'image'}
            onLoad={() => setImgLoaded(true)}
            className={`relative max-h-full w-auto max-w-full object-contain transition-opacity duration-300 ${
              blurUrl && !imgLoaded ? 'opacity-0' : 'opacity-100'
            }`}
          />
        </>
      ) : error ? (
        <FallbackBlock message={`Failed to load image — ${error}`} isDark={isDark} />
      ) : blurUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- decoded thumbHash data URL (no network).
        <img src={blurUrl} alt="" aria-hidden="true" className="h-full w-full object-contain blur-xl" />
      ) : (
        <LoadingBlock isDark={isDark} />
      )}
    </div>
  );
}

function MaxPdfBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  // release202/13 §3b④ — range streaming: hand pdfjs the asset URL + auth
  // header directly instead of pre-fetching the whole PDF as a blob. pdfjs then
  // issues `Range`/206 requests page-by-page (first page renders fast, later
  // pages stream on scroll). Legacy CDN attachments use their public URL (no
  // header); IMAsset-backed attachments use the byte route + Bearer.
  const range = usePdfRangeSource(asset);
  if (range.error) return <FallbackBlock message={`Failed to load PDF — ${range.error}`} isDark={isDark} />;
  if (!range.source) return <LoadingBlock isDark={isDark} />;
  return (
    <div className="h-full overflow-hidden rounded-xl border border-zinc-200 dark:border-white/[0.06]">
      <PdfAssetPreview
        bytes={null}
        objectUrl={null}
        rangeSource={range.source}
        title={asset.filename ?? 'preview'}
        isDark={isDark}
      />
    </div>
  );
}

/**
 * Resolve the pdfjs range-streaming source for an asset: a `{ url, httpHeaders }`
 * pointing at a `Range`-capable endpoint. Legacy `metadata.fileUrl` attachments
 * resolve to their public CDN URL (no auth header); IMAsset-backed attachments
 * resolve to `/api/im/assets/:id` carrying the workspace Bearer token. No bytes
 * are fetched here — pdfjs does the (range) fetching itself.
 */
function usePdfRangeSource(asset: MessageAsset): {
  source: { url: string; httpHeaders?: Record<string, string> } | null;
  error: string | null;
} {
  return useMemo(() => {
    if (asset.source === 'legacy-file-url') {
      if (asset.cdnUrl) return { source: { url: asset.cdnUrl }, error: null };
      return { source: null, error: 'missing file url' };
    }
    const token = getWorkspaceToken();
    if (!token) return { source: null, error: 'no auth token' };
    return {
      source: {
        url: `/api/im/assets/${encodeURIComponent(asset.id)}`,
        httpHeaders: { Authorization: `Bearer ${token}` },
      },
      error: null,
    };
  }, [asset.id, asset.source, asset.cdnUrl]);
}

function MaxVideoBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  const { url, error } = useAuthenticatedAssetBlobUrl(asset);
  if (error) return <FallbackBlock message={`Failed to load video — ${error}`} isDark={isDark} />;
  if (!url) return <LoadingBlock isDark={isDark} />;
  // HLS (.m3u8) → video.js sibling. Native containers (mp4/mov/webm) →
  // native <video> — browser decoder handles codec.
  if (isHls(asset)) {
    return (
      <div className="h-full overflow-hidden rounded-xl border border-zinc-200 dark:border-white/[0.06]">
        <HlsVideoPlayer src={url} title={asset.filename ?? 'video'} isDark={isDark} />
      </div>
    );
  }
  return (
    <div
      className={`flex h-full items-center justify-center overflow-hidden rounded-xl border ${
        isDark ? 'border-white/[0.06] bg-black/30' : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <video src={url} controls preload="metadata" className="max-h-full max-w-full">
        <track kind="captions" />
      </video>
    </div>
  );
}

function MaxAudioBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  const { url, error } = useAuthenticatedAssetBlobUrl(asset);
  if (error) return <FallbackBlock message={`Failed to load audio — ${error}`} isDark={isDark} />;
  if (!url) return <LoadingBlock isDark={isDark} />;
  return (
    <div
      className={`flex h-full items-center justify-center overflow-hidden rounded-xl border px-6 ${
        isDark ? 'border-white/[0.06] bg-black/30' : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <audio src={url} controls preload="metadata" className="w-full max-w-[640px]" />
    </div>
  );
}

function MaxTabularBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  // DuckDBTablePreview expects AssetDTO. Chat MessageAsset is a subset —
  // synthesise a minimal AssetDTO with placeholder workspace fields; the
  // preview only reads id/mime/filename/sizeBytes/storageUri and fetches
  // bytes via /api/im/assets/${id}.
  const synthetic = useMemo<AssetDTO>(
    () => ({
      id: asset.id,
      workspaceId: '',
      ownerImUserId: '',
      contentHash: '',
      storageUri: '',
      sizeBytes: asset.sizeBytes ?? null,
      mime: asset.mime ?? null,
      kind: 'attachment',
      sourceAgentImUserId: null,
      sourceTaskId: null,
      metadata: {},
      filename: asset.filename ?? null,
      createdAt: '',
    }),
    [asset.id, asset.mime, asset.sizeBytes, asset.filename],
  );
  return (
    <div className="h-full overflow-hidden rounded-xl border border-zinc-200 dark:border-white/[0.06]">
      <DuckDBTablePreview asset={synthetic} title={asset.filename ?? 'table'} isDark={isDark} signedUrl={null} />
    </div>
  );
}

function MaxMarkdownBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  const { text, error, reload } = useAuthenticatedAssetText(asset, null);
  // Only IMAsset-backed attachments can persist a new revision. Legacy
  // `metadata.fileUrl` (public CDN) attachments have no writable backend, so
  // they stay read-only (no onSave → component renders without the Save UI).
  const saveContent = useSaveAssetMarkdownRevision(asset);
  const onSave = asset.source === 'legacy-file-url' ? undefined : saveContent;
  const handleSave = useCallback(
    async (content: string) => {
      if (!onSave) return;
      await onSave(content);
      // Re-fetch the canonical bytes so the editor baseline re-syncs to what
      // the server now serves for /api/im/assets/:id (current revision).
      reload();
    },
    [onSave, reload],
  );
  if (error) return <FallbackBlock message={`Failed to load markdown — ${error}`} isDark={isDark} />;
  // release202/13 §L1 — show the inline excerpt immediately while the full
  // bytes load (no spinner gap). The editor takes over once `text` resolves.
  if (text == null) {
    if (asset.previewText) {
      return (
        <pre
          className={`h-full overflow-auto whitespace-pre-wrap rounded-xl border p-3 font-mono text-xs leading-relaxed ${
            isDark ? 'border-white/[0.06] bg-black/30 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-600'
          }`}
        >
          {asset.previewText}
        </pre>
      );
    }
    return <LoadingBlock isDark={isDark} />;
  }
  return (
    <div className="h-full overflow-auto rounded-xl border border-zinc-200 dark:border-white/[0.06]">
      <PlateMarkdownEditor
        markdown={text}
        title={asset.filename ?? 'markdown'}
        isDark={isDark}
        onSave={onSave ? handleSave : undefined}
      />
    </div>
  );
}

/**
 * Returns a callback that writes edited markdown back to the asset as a new
 * revision via `POST /api/im/assets/:id/revisions`. Throws on non-2xx so the
 * editor can surface the error state.
 */
function useSaveAssetMarkdownRevision(asset: MessageAsset): (content: string) => Promise<void> {
  return useCallback(
    async (content: string) => {
      const token = getWorkspaceToken();
      if (!token) throw new Error('no auth token');
      const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}/revisions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === 'string') message = body.error;
          else if (body.error && typeof body.error === 'object' && 'message' in body.error) {
            message = String((body.error as { message: unknown }).message);
          }
        } catch {
          /* keep HTTP status */
        }
        throw new Error(message);
      }
    },
    [asset.id],
  );
}

function MaxTextBody({ asset, isDark }: { asset: MessageAsset; isDark: boolean }) {
  const { text, error } = useAuthenticatedAssetText(asset, TEXT_PREVIEW_BYTES);
  if (error) return <FallbackBlock message={`Failed to load text — ${error}`} isDark={isDark} />;
  // release202/13 §L1 — render the inline excerpt immediately; swap to the full
  // (first 4 KB) bytes once they load.
  const body = text ?? asset.previewText ?? null;
  if (body == null) return <LoadingBlock isDark={isDark} />;
  return (
    <pre
      className={`h-full overflow-auto rounded-xl border p-3 font-mono text-xs leading-relaxed ${
        isDark ? 'border-white/[0.06] bg-black/30 text-zinc-200' : 'border-zinc-200 bg-zinc-50 text-zinc-800'
      }`}
    >
      {body}
    </pre>
  );
}

/**
 * Fetch authenticated workspace asset bytes as a blob: URL. Legacy
 * `metadata.fileUrl` attachments use their public CDN URL directly.
 *
 * Exported because chat surfaces outside the modal (download fallback,
 * derived previews) need the same auth-aware URL contract.
 */
export function useAuthenticatedAssetBlobUrl(asset: MessageAsset): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (asset.source === 'legacy-file-url' && asset.cdnUrl) {
      setUrl(asset.cdnUrl);
      setError(null);
      return;
    }
    let cancelled = false;
    let local: string | null = null;
    const token = getWorkspaceToken();
    if (!token) {
      setError('no auth token');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        local = URL.createObjectURL(blob);
        setUrl(local);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
      if (local && asset.source !== 'legacy-file-url') URL.revokeObjectURL(local);
    };
  }, [asset.id, asset.source, asset.cdnUrl]);
  return { url, error };
}

function useAuthenticatedAssetText(
  asset: MessageAsset,
  maxBytes: number | null,
): { text: string | null; error: string | null; reload: () => void } {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (asset.source !== 'legacy-file-url') {
          const token = getWorkspaceToken();
          if (!token) {
            setError('no auth token');
            return;
          }
          headers.Authorization = `Bearer ${token}`;
        }
        const target =
          asset.source === 'legacy-file-url' && asset.cdnUrl
            ? asset.cdnUrl
            : `/api/im/assets/${encodeURIComponent(asset.id)}`;
        const res = await fetch(target, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const slice = maxBytes != null ? blob.slice(0, maxBytes) : blob;
        const decoded = await slice.text();
        if (cancelled) return;
        setText(decoded);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.source, asset.cdnUrl, maxBytes, reloadNonce]);
  return { text, error, reload };
}

function isHls(asset: MessageAsset): boolean {
  const mime = (asset.mime ?? '').toLowerCase();
  if (mime === 'application/vnd.apple.mpegurl' || mime === 'application/x-mpegurl') return true;
  return /\.m3u8$/i.test(asset.filename ?? '');
}

function isMarkdown(asset: MessageAsset): boolean {
  const mime = (asset.mime ?? '').toLowerCase();
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return true;
  return /\.(md|markdown|mdx)$/i.test(asset.filename ?? '');
}

function isTabular(asset: MessageAsset): boolean {
  const mime = (asset.mime ?? '').toLowerCase();
  const name = (asset.filename ?? '').toLowerCase();
  if (mime.includes('csv') || mime.includes('tab-separated-values') || mime.includes('parquet')) return true;
  return /\.(csv|tsv|parquet)$/i.test(name);
}

function FallbackBlock({ message, isDark }: { message: string; isDark: boolean }) {
  return (
    <div
      className={`flex h-full min-h-[200px] items-center justify-center rounded-xl border px-6 py-8 text-center text-xs ${
        isDark ? 'border-white/[0.06] bg-black/30 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-600'
      }`}
    >
      <div className="flex max-w-[320px] flex-col items-center gap-2">
        <FileWarning className="h-5 w-5 opacity-70" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function LoadingBlock({ isDark }: { isDark: boolean }) {
  return <AssetLoadingIndicator isDark={isDark} label="Loading…" />;
}
