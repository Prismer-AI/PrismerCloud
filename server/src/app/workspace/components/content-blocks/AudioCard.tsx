'use client';

import { useEffect, useState } from 'react';
import { Music } from 'lucide-react';

import { getWorkspaceToken } from '../../lib/im-api';
import type { ContentBlockAudio } from './types';

/**
 * Inline audio player for `kind='audio'` ContentBlock — fetches the bytes
 * with the workspace Bearer token, mints a blob URL, hands it to native
 * `<audio controls>` so the browser owns play/seek/scrub.
 *
 * Duration label (computed from `block.durationMs`) sits beside the music
 * glyph. Falls back to "loading / failed" copy if the auth fetch errors.
 */
function formatDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function AudioCard({
  block,
  isOwn = false,
  isDark = false,
}: {
  block: ContentBlockAudio;
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
      data-testid="content-block-audio"
      data-content-kind="audio"
      data-asset-id={block.assetId}
      className={`flex max-w-[320px] flex-col gap-1.5 rounded-2xl border px-3 py-2 ${
        isOwn
          ? 'border-white/20 bg-white/15'
          : isDark
            ? 'border-white/[0.08] bg-white/[0.04]'
            : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <div className={`flex items-center gap-2 ${isOwn ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
        <Music className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{block.mediaType || 'audio'}</span>
        {durationLabel ? (
          <span
            className={`shrink-0 text-[10px] ${
              isOwn ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
            }`}
          >
            {durationLabel}
          </span>
        ) : null}
      </div>
      {objectUrl ? (
        <audio
          data-testid="content-block-audio-player"
          src={objectUrl}
          controls
          preload="metadata"
          className="w-full"
        />
      ) : (
        <span className={`text-[10px] ${isOwn ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {loadError ? `audio · ${loadError}` : 'loading audio…'}
        </span>
      )}
    </div>
  );
}
