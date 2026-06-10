'use client';

import { useCallback, useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';

import { usePrivateImage } from '../../lib/use-private-image';
import type { ContentBlockImage } from './types';

/**
 * Inline `<img>` thumbnail for a `kind='image'` ContentBlock — auth-gated
 * via the existing `usePrivateImage` hook (Bearer-token fetch → blob URL).
 *
 * Click anywhere on the thumbnail opens an in-component lightbox overlay
 * (full-viewport black backdrop + ESC / click-to-close). The lightbox uses
 * the same blob URL so no second auth fetch is required.
 *
 * Falls back to a sized placeholder while loading and an `ImageOff` icon
 * if the fetch fails (e.g. assetId stale / permission denied). Composer-
 * side W5 thumbnails follow the same pattern (see `AttachmentPreview`).
 */
export function ImageCard({
  block,
  isOwn = false,
  isDark = false,
}: {
  block: ContentBlockImage;
  isOwn?: boolean;
  isDark?: boolean;
}) {
  const assetUrl = `/api/im/assets/${encodeURIComponent(block.assetId)}`;
  const objectUrl = usePrivateImage(assetUrl);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const close = useCallback(() => setLightboxOpen(false), []);
  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen, close]);

  const alt = block.alt || block.assetId;

  return (
    <>
      <button
        type="button"
        onClick={() => objectUrl && setLightboxOpen(true)}
        title={alt}
        data-testid="content-block-image"
        data-content-kind="image"
        data-asset-id={block.assetId}
        className={`group relative block max-w-full overflow-hidden rounded-2xl border sm:max-w-[280px] ${
          isOwn ? 'border-white/20' : isDark ? 'border-white/[0.08]' : 'border-zinc-200'
        }`}
      >
        {objectUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={objectUrl}
            alt={alt}
            loading="lazy"
            onError={() => setLoadFailed(true)}
            className="h-auto max-h-72 w-full max-w-[280px] object-cover"
          />
        ) : loadFailed ? (
          <span
            className={`flex h-32 w-full min-w-[180px] max-w-[280px] items-center justify-center gap-2 text-[10px] ${
              isOwn ? 'bg-white/10 text-white/70' : isDark ? 'bg-white/[0.04] text-zinc-500' : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            <ImageOff className="h-3 w-3" />
            image · failed
          </span>
        ) : (
          <span
            className={`flex h-32 w-full min-w-[180px] max-w-[280px] items-center justify-center text-[10px] ${
              isOwn ? 'bg-white/10 text-white/70' : isDark ? 'bg-white/[0.04] text-zinc-500' : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            loading image…
          </span>
        )}
      </button>
      {lightboxOpen && objectUrl ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="content-block-image-lightbox"
          onClick={close}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={objectUrl}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
          />
          <button
            type="button"
            onClick={close}
            data-testid="content-block-image-lightbox-close"
            className="absolute right-4 top-4 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white backdrop-blur hover:bg-white/25"
          >
            Close
          </button>
        </div>
      ) : null}
    </>
  );
}
