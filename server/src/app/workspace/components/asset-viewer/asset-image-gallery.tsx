'use client';

import { useMemo, useState } from 'react';
import { ImageIcon, Search, X } from 'lucide-react';
import {
  DEFAULT_PRIVATE_GALLERY_IMAGE_BYTES,
  assetTitle,
  isGalleryImageAsset,
  selectAssetPreviewSource,
} from '@prismer/asset-viewers';

import type { AssetDTO } from '../../lib/types';
import { AssetBentoGallery } from './asset-bento-gallery';

export interface AssetImageGalleryProps {
  assets: AssetDTO[];
  activeAssetId: string;
  isDark: boolean;
}

export interface ImageGalleryCandidate {
  asset: AssetDTO;
  title: string;
  previewUrl: string;
  needsAuth: boolean;
}

export function filterImageGalleryCandidates(
  candidates: ImageGalleryCandidate[],
  query: string,
): ImageGalleryCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return candidates;
  return candidates.filter((candidate) => {
    const haystack = [
      candidate.title,
      candidate.asset.filename,
      candidate.asset.mime,
      candidate.asset.kind,
      candidate.asset.metadata?.title,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

export function imageGalleryCandidates(assets: AssetDTO[]): ImageGalleryCandidate[] {
  const seen = new Set<string>();
  const candidates: ImageGalleryCandidate[] = [];
  for (const asset of assets) {
    if (!isGalleryImageAsset(asset) || seen.has(asset.id)) continue;
    const preview = imageGalleryPreviewSource(asset);
    if (!preview) continue;
    seen.add(asset.id);
    candidates.push({
      asset,
      title: assetTitle(asset),
      previewUrl: preview.url,
      needsAuth: preview.needsAuth,
    });
  }
  return candidates;
}

export function imageGalleryPreviewUrl(asset: AssetDTO): string | null {
  return imageGalleryPreviewSource(asset)?.url ?? null;
}

function imageGalleryPreviewSource(asset: AssetDTO) {
  return selectAssetPreviewSource(asset, {
    allowPrivateImage: true,
    maxPrivateImageBytes: DEFAULT_PRIVATE_GALLERY_IMAGE_BYTES,
  });
}

export function AssetImageGallery({ assets, activeAssetId, isDark }: AssetImageGalleryProps) {
  const allCandidates = useMemo(() => {
    const all = imageGalleryCandidates(assets);
    const active = all.find((item) => item.asset.id === activeAssetId);
    if (!active) return all;
    return [active, ...all.filter((item) => item.asset.id !== activeAssetId)];
  }, [activeAssetId, assets]);
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => filterImageGalleryCandidates(allCandidates, query), [allCandidates, query]);

  if (allCandidates.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4">
        <ImageIcon className={isDark ? 'h-6 w-6 text-zinc-500' : 'h-6 w-6 text-zinc-400'} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-image-gallery">
      <div
        className={`sticky top-0 z-10 border-b px-3 py-2 ${
          isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
        }`}
      >
        <label
          className={`flex h-9 items-center gap-2 rounded-md border px-3 ${
            isDark ? 'border-white/[0.08] bg-white/[0.04]' : 'border-zinc-200 bg-zinc-50'
          }`}
        >
          <Search className={isDark ? 'h-4 w-4 text-zinc-500' : 'h-4 w-4 text-zinc-400'} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${
              isDark ? 'text-zinc-100 placeholder:text-zinc-600' : 'text-zinc-900 placeholder:text-zinc-400'
            }`}
            placeholder="Search images"
            aria-label="Search images"
          />
          <span className={isDark ? 'text-[11px] text-zinc-500' : 'text-[11px] text-zinc-500'}>
            {candidates.length}/{allCandidates.length}
          </span>
          {query.trim() ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
              }}
              className={isDark ? 'text-zinc-500 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-800'}
              aria-label="Clear image search"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <AssetBentoGallery candidates={candidates} isDark={isDark} hasQuery={Boolean(query.trim())} />
      </div>
    </div>
  );
}
