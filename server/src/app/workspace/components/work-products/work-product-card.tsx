'use client';

import { ArrowUp, ExternalLink, FileText } from 'lucide-react';
import type { AssetDTO } from '../../lib/types';
import { AssetViewer, type PreviewableAsset } from '../asset-viewer';

export interface WorkProductCardProps {
  asset: PreviewableAsset;
  isDark: boolean;
  onOpen?: (assetId: string) => void;
  /**
   * release201/09 §9.4a.4 — "Promote ↑": move this task-bound asset to
   * workspace-file scope so it surfaces in Library Root. Optional; the
   * task drawer Artifacts tab wires this, other call-sites (e.g.
   * task-card preview list) leave it undefined.
   */
  onPromote?: (assetId: string) => void;
  /** Tag rendered next to the size — 'task-bound' / 'workspace-file' chip. */
  showBoundKindChip?: boolean;
  compact?: boolean;
}

export function WorkProductCard({
  asset,
  isDark,
  onOpen,
  onPromote,
  showBoundKindChip = false,
  compact = false,
}: WorkProductCardProps) {
  const title = assetTitle(asset);
  const revision = typeof asset.revision === 'number' ? asset.revision : null;
  const thumbAsset =
    asset.thumbnailUrl && !hasPreviewUrls(asset) ? { ...asset, previewUrls: { medium: asset.thumbnailUrl } } : asset;
  // 2026-05-24 — Previously only the tiny ExternalLink icon button at the
  // top-right was clickable. Users naturally clicked the filename / thumbnail
  // and got nothing back. Make the entire card the activation target; the
  // icon stays as a visual affordance hint. Internal interactive elements
  // (CDN link, the icon button itself) stop propagation so they keep
  // working independently.
  const activate = onOpen ? () => onOpen(asset.id) : null;
  return (
    <article
      data-testid={`work-product-card-${asset.id}`}
      role={activate ? 'button' : undefined}
      tabIndex={activate ? 0 : undefined}
      onClick={activate ?? undefined}
      onKeyDown={
        activate
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }
          : undefined
      }
      className={`grid min-w-0 gap-2 rounded-xl border p-2 transition-colors ${
        compact ? 'grid-cols-[72px_minmax(0,1fr)]' : ''
      } ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-white/75'} ${
        activate
          ? `cursor-pointer ${isDark ? 'hover:bg-white/[0.06] hover:border-white/[0.14]' : 'hover:bg-white hover:border-zinc-300'}`
          : ''
      }`}
    >
      <AssetViewer asset={thumbAsset} isDark={isDark} compact className={compact ? 'h-[60px]' : undefined} />
      <div className="flex min-w-0 items-start gap-2">
        <FileText className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[12px] font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`} title={title}>
            {title}
          </p>
          <div
            className={`mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          >
            <span className="truncate">{asset.mime ?? asset.kind}</span>
            {asset.sizeBytes ? <span>{formatBytes(asset.sizeBytes)}</span> : null}
            {revision !== null ? <span>rev {revision}</span> : null}
            {showBoundKindChip && asset.boundKind ? (
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                  asset.boundKind === 'task-bound'
                    ? isDark
                      ? 'bg-violet-500/15 text-violet-200'
                      : 'bg-violet-50 text-violet-700'
                    : isDark
                      ? 'bg-sky-500/15 text-sky-200'
                      : 'bg-sky-50 text-sky-700'
                }`}
                title={`boundKind: ${asset.boundKind}`}
              >
                {asset.boundKind}
              </span>
            ) : null}
          </div>
        </div>
        {onPromote ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPromote(asset.id);
            }}
            title="Promote to workspace file"
            data-testid={`work-product-promote-${asset.id}`}
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
              isDark
                ? 'text-zinc-300 hover:bg-violet-500/15 hover:text-violet-100'
                : 'text-zinc-600 hover:bg-violet-50 hover:text-violet-700'
            }`}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen?.(asset.id);
          }}
          disabled={!onOpen}
          title="Open work product"
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-default disabled:opacity-50 ${
            isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      {asset.cdnUrl ? (
        <a
          href={asset.cdnUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className={`truncate text-[10px] ${compact ? 'col-span-2' : ''} ${
            isDark ? 'text-violet-200 hover:text-violet-100' : 'text-violet-700 hover:text-violet-900'
          }`}
        >
          CDN
        </a>
      ) : null}
    </article>
  );
}

function hasPreviewUrls(asset: PreviewableAsset): boolean {
  const previewUrls = asset.previewUrls as PreviewableAsset['previewUrls'] | string[] | null | undefined;
  if (Array.isArray(previewUrls)) return previewUrls.some((url) => typeof url === 'string' && url.trim().length > 0);
  if (!previewUrls || typeof previewUrls !== 'object') return false;
  return ['small', 'medium', 'large'].some((key) => {
    const value = previewUrls[key as keyof typeof previewUrls];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function assetTitle(asset: AssetDTO): string {
  const metaTitle = asset.metadata?.title;
  if (typeof metaTitle === 'string' && metaTitle.trim()) return metaTitle;
  if (asset.filename?.trim()) return asset.filename;
  return asset.id.slice(-12);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
