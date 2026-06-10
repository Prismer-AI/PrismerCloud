'use client';

import { useEffect, useState } from 'react';
import { FileText, ImageIcon, Music, Video } from 'lucide-react';
import {
  assetTitle,
  classifyAssetViewer,
  selectAssetPreviewSource,
  type AssetViewerKind,
} from '@prismer/asset-viewers';
import { getWorkspaceToken } from '../../lib/im-api';
import type { AssetDTO } from '../../lib/types';

export type PreviewableAsset = AssetDTO;
export { firstPreviewUrl } from '@prismer/asset-viewers';

export interface AssetViewerProps {
  asset: PreviewableAsset;
  isDark: boolean;
  className?: string;
  compact?: boolean;
}

export function AssetViewer({ asset, isDark, className, compact = false }: AssetViewerProps) {
  const previewSource = selectAssetPreviewSource(asset, { allowPrivateImage: true });
  const viewerKind = classifyAssetViewer(asset);
  const title = assetTitle(asset);
  const authenticatedPreviewUrl = useAuthenticatedImagePreviewUrl(
    previewSource?.needsAuth ? previewSource.url : null,
    asset,
  );
  const previewUrl = authenticatedPreviewUrl ?? (previewSource?.needsAuth ? null : (previewSource?.url ?? null));
  const baseClass = [
    'relative flex min-w-0 items-center justify-center overflow-hidden rounded-lg border',
    compact ? 'h-20' : 'min-h-[220px]',
    isDark ? 'border-white/[0.08] bg-black/20' : 'border-zinc-200 bg-zinc-50',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (previewUrl && viewerKind === 'image') {
    return (
      <div
        className={baseClass}
        data-testid={previewSource?.kind === 'private-asset' ? 'asset-viewer-private-image' : 'asset-viewer-image'}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- viewer previews remote workspace asset URLs without Next image loader config. */}
        <img src={previewUrl} alt={title} className="h-full w-full object-cover" loading="lazy" />
      </div>
    );
  }

  if (previewUrl && viewerKind === 'video') {
    return (
      <div className={baseClass} data-testid="asset-viewer-video">
        <video
          src={previewUrl}
          controls={!compact}
          muted={compact}
          preload="metadata"
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  if (previewUrl && viewerKind === 'audio') {
    return (
      <div className={`${baseClass} px-3`} data-testid="asset-viewer-audio">
        <div className="w-full space-y-2">
          <Music className={`h-5 w-5 ${isDark ? 'text-violet-200' : 'text-violet-700'}`} />
          <audio src={previewUrl} controls preload="metadata" className="w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className={`${baseClass} px-4 py-5 text-center`} data-testid="asset-viewer-fallback">
      <div className="min-w-0">
        <FallbackIcon asset={asset} isDark={isDark} />
        <p className={`mt-2 truncate text-xs font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{title}</p>
        <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {asset.previewUrls === null ? 'Preview is not available for this document yet.' : 'No preview available.'}
        </p>
      </div>
    </div>
  );
}

function useAuthenticatedImagePreviewUrl(url: string | null, asset: PreviewableAsset): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    setObjectUrl(null);
    if (!url) return;

    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    let nextObjectUrl: string | null = null;
    let activeObjectUrl: string | null = null;

    void (async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const blobMime = blob.type || asset.mime || '';
        if (!blobMime.startsWith('image/')) return;
        nextObjectUrl = URL.createObjectURL(blob);
        if (!controller.signal.aborted) {
          activeObjectUrl = nextObjectUrl;
          setObjectUrl(nextObjectUrl);
          nextObjectUrl = null;
        }
      } catch {
        /* Non-fatal: keep the icon fallback. */
      } finally {
        if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
      }
    })();

    return () => {
      controller.abort();
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
      if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    };
  }, [asset.contentHash, asset.mime, asset.sizeBytes, url]);

  return objectUrl;
}

function FallbackIcon({ asset, isDark }: { asset: PreviewableAsset; isDark: boolean }) {
  const cls = `mx-auto h-5 w-5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`;
  const viewerKind = classifyAssetViewer(asset) as AssetViewerKind;
  if (viewerKind === 'image') return <ImageIcon className={cls} />;
  if (viewerKind === 'video') return <Video className={cls} />;
  if (viewerKind === 'audio') return <Music className={cls} />;
  return <FileText className={cls} />;
}
