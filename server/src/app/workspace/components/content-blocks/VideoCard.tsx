'use client';

import { useEffect, useState } from 'react';
import { Video as VideoIcon } from 'lucide-react';

import { getWorkspaceToken } from '../../lib/im-api';
import type { ContentBlockVideo } from './types';

/**
 * Inline video player for `kind='video'` ContentBlock — auth-fetches the
 * bytes, mints a blob URL, feeds native `<video controls>`. Poster
 * thumbnail uses `block.thumbnailUrl` when provided (already public via
 * IMAsset previewUrls.medium, see 14b §4.1).
 *
 * Duration label same pattern as AudioCard. We don't try to seek-fetch
 * incrementally — at v2.0 IMAsset uploads cap below the size where streaming
 * matters (see 14b §6.3 ">1 GB clip" decision).
 */
function formatDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function VideoCard({
  block,
  isOwn = false,
  isDark = false,
}: {
  block: ContentBlockVideo;
  isOwn?: boolean;
  isDark?: boolean;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const token = getWorkspaceToken();
    if (!token) {
      setLoadError('No auth token');
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(block.assetId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [block.assetId]);

  const durationLabel = formatDuration(block.durationMs);

  return (
    <div
      data-testid="content-block-video"
      data-content-kind="video"
      data-asset-id={block.assetId}
      className={`flex max-w-[320px] flex-col gap-1 overflow-hidden rounded-2xl border ${
        isOwn
          ? 'border-white/20 bg-white/15'
          : isDark
            ? 'border-white/[0.08] bg-white/[0.04]'
            : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      {objectUrl ? (
        <video
          data-testid="content-block-video-player"
          src={objectUrl}
          poster={block.thumbnailUrl ?? undefined}
          controls
          preload="metadata"
          playsInline
          className="h-auto max-h-72 w-full max-w-[320px] object-contain"
        />
      ) : (
        <span
          className={`flex h-32 w-full max-w-[320px] items-center justify-center gap-2 text-[10px] ${
            isOwn ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          <VideoIcon className="h-3 w-3" />
          {loadError ? `video · ${loadError}` : 'loading video…'}
        </span>
      )}
      {durationLabel ? (
        <span
          className={`px-3 pb-1.5 text-[10px] ${
            isOwn ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          {durationLabel}
        </span>
      ) : null}
    </div>
  );
}
