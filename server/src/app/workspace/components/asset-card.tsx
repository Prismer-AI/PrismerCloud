'use client';

/**
 * Asset card — list + grid layouts for the Library files panel.
 *
 * Owns its own per-card chrome (thumbnail, status badges, action buttons,
 * inline menu) but does NOT own filtering/grouping/drag-target logic — the
 * panel keeps those.
 *
 * Drag-as-source (asset → folder, asset → composer) is wired via callbacks
 * the caller hands down; the card root attaches `draggable` so the native
 * HTML5 drag flow stays intact.
 */

import { type DragEvent, type ReactNode } from 'react';
import {
  Archive,
  Check,
  CheckCircle2,
  CloudDownload,
  Edit3,
  Eye,
  FileCode2,
  FileText,
  ImageIcon,
  Loader2,
  MoreVertical,
  Table2,
  Trash2,
} from 'lucide-react';

import { radius, surface } from '../lib/design';
import { isPrivateAssetUrl, usePrivateImage } from '../lib/use-private-image';
import { useI18n } from '@/contexts/i18n-context';
import type { TranslationKey } from '@/lib/i18n';
import type { AssetDTO, WorkspaceFileDTO } from '../lib/types';
import type { CardLayoutMode } from './card-shelf';

// ─── Pure asset utilities (also used by panel filter logic) ──────────────

export function isImageAsset(asset: AssetDTO): boolean {
  return (asset.mime ?? '').startsWith('image/');
}

export function isDocAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return mime.includes('pdf') || mime.includes('text') || asset.kind.includes('document');
}

export function isCodeAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return (
    mime.includes('javascript') || mime.includes('typescript') || mime.includes('python') || asset.kind.includes('code')
  );
}

export function isDataAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  return mime.includes('json') || mime.includes('csv') || asset.kind.includes('dataset');
}

export function assetTitle(asset: AssetDTO, file?: WorkspaceFileDTO) {
  if (asset.filename) return asset.filename;
  const title = asset.metadata?.title;
  if (typeof title === 'string' && title.trim()) return title;
  if (file?.path) return file.path;
  return asset.contentHash.slice(0, 16);
}

export function assetMeta(asset: AssetDTO) {
  const derived = asset.derivationKind ? `${asset.derivationKind}` : null;
  const parts = [derived ?? asset.kind, asset.mime ?? 'unknown', formatBytes(asset.sizeBytes)];
  return parts.join(' · ');
}

export function formatBytes(bytes: number | null) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Classification + time helpers (shared with the panel grouping) ──────

/**
 * Human-readable type label — replaces the raw mime (e.g.
 * `application/vnd.openxmlformats-...wordprocessingml.document` → "Word
 * document") so the card meta line is legible.
 */
export function friendlyType(asset: AssetDTO): string {
  const mime = (asset.mime ?? '').toLowerCase();
  const name = (asset.filename ?? '').toLowerCase();
  const ext = (suffix: string) => name.endsWith(suffix);
  if (mime.startsWith('image/')) {
    const sub = mime.slice(6).split('+')[0].toUpperCase();
    return sub ? `${sub} image` : 'Image';
  }
  if (mime === 'application/pdf' || ext('.pdf')) return 'PDF';
  if (mime.includes('wordprocessingml') || ext('.docx') || ext('.doc')) return 'Word document';
  if (mime.includes('spreadsheetml') || ext('.xlsx') || ext('.xls')) return 'Excel spreadsheet';
  if (mime.includes('presentationml') || ext('.pptx') || ext('.ppt')) return 'PowerPoint';
  if (mime === 'text/markdown' || ext('.md') || ext('.markdown')) return 'Markdown';
  if (mime.includes('csv') || ext('.csv')) return 'CSV';
  if (mime.includes('tab-separated') || ext('.tsv')) return 'TSV';
  if (mime.includes('parquet') || ext('.parquet')) return 'Parquet';
  if (mime.includes('json') || ext('.json')) return 'JSON';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) return 'Archive';
  if (isCodeAsset(asset)) return 'Code';
  if (mime.startsWith('text/') || ext('.txt')) return 'Text';
  return asset.kind || 'File';
}

/** Relative timestamp ("just now" / "2h ago"); absolute belongs in `title`. */
export function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export type AssetTypeTone = 'image' | 'doc' | 'pdf' | 'data' | 'code' | 'other';

/** Coarse type bucket — drives the thumbnail swatch colour + type grouping. */
export function assetTypeTone(asset: AssetDTO): AssetTypeTone {
  const mime = (asset.mime ?? '').toLowerCase();
  if (isImageAsset(asset)) return 'image';
  if (mime.includes('pdf')) return 'pdf';
  if (isDataAsset(asset)) return 'data';
  if (isCodeAsset(asset)) return 'code';
  if (isDocAsset(asset)) return 'doc';
  return 'other';
}

const TYPE_SWATCH: Record<AssetTypeTone, { dark: string; light: string }> = {
  image: { dark: 'bg-emerald-500/12 text-emerald-200', light: 'bg-emerald-50 text-emerald-700' },
  doc: { dark: 'bg-sky-500/12 text-sky-200', light: 'bg-sky-50 text-sky-700' },
  pdf: { dark: 'bg-rose-500/12 text-rose-200', light: 'bg-rose-50 text-rose-700' },
  data: { dark: 'bg-amber-500/12 text-amber-100', light: 'bg-amber-50 text-amber-700' },
  code: { dark: 'bg-violet-500/12 text-violet-200', light: 'bg-violet-50 text-violet-700' },
  other: { dark: 'bg-zinc-500/12 text-zinc-300', light: 'bg-zinc-100 text-zinc-600' },
};

export type AssetSourceTone = 'task' | 'agent' | 'upload';

/** Where the asset came from — uploaded by a human, produced by a task, or
 *  emitted by an agent outside a task. */
export function assetSource(asset: AssetDTO): { label: string; tone: AssetSourceTone } {
  if (asset.boundKind === 'task-bound' || asset.sourceTaskId) return { label: 'From task', tone: 'task' };
  if (asset.sourceAgentImUserId) return { label: 'Agent output', tone: 'agent' };
  return { label: 'Uploaded', tone: 'upload' };
}

const SOURCE_TONE_KEY: Record<AssetSourceTone, TranslationKey> = {
  task: 'assetUi.source.fromTask',
  agent: 'assetUi.source.agentOutput',
  upload: 'assetUi.source.uploaded',
};

function SourceBadge({ asset, isDark }: { asset: AssetDTO; isDark: boolean }) {
  const { t } = useI18n();
  const { tone } = assetSource(asset);
  const label = t(SOURCE_TONE_KEY[tone]);
  const cls =
    tone === 'task'
      ? isDark
        ? 'border-violet-400/20 bg-violet-500/10 text-violet-200'
        : 'border-violet-200 bg-violet-50 text-violet-700'
      : tone === 'agent'
        ? isDark
          ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
          : 'border-cyan-200 bg-cyan-50 text-cyan-700'
        : isDark
          ? 'border-white/[0.1] bg-white/[0.04] text-zinc-300'
          : 'border-zinc-200 bg-zinc-50 text-zinc-600';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ─── Small helper components ─────────────────────────────────────────────

function renderAssetIcon(asset: AssetDTO, size: 'sm' | 'md' = 'md'): ReactNode {
  const cls = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6';
  const mime = asset.mime ?? '';
  if (isImageAsset(asset)) return <ImageIcon className={cls} />;
  if (isDataAsset(asset)) return <Table2 className={cls} />;
  if (isCodeAsset(asset)) return <FileCode2 className={cls} />;
  if (mime) return <FileText className={cls} />;
  return <Archive className={cls} />;
}

/**
 * Resolve the best image URL to render as the thumbnail for an asset.
 *
 * The server may attach a derived first-page thumbnail to PDFs (and other
 * non-image MIME types) via `thumbnailUrl` / `previewUrls.medium`. For
 * native image assets we fall back to the asset's own bytes. Anything
 * else returns null and the consumer renders the mime icon.
 */
function pickThumbnailUrl(asset: AssetDTO): string | null {
  if (asset.thumbnailUrl) return asset.thumbnailUrl;
  const medium = asset.previewUrls?.medium;
  if (typeof medium === 'string' && medium) return medium;
  if (isImageAsset(asset)) return asset.cdnUrl ?? null;
  return null;
}

export function AssetThumb({ asset, isDark, size = 'md' }: { asset: AssetDTO; isDark: boolean; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-10 w-10 rounded-xl' : 'h-[60px] w-[60px] rounded-2xl';
  const thumb = pickThumbnailUrl(asset);
  // `/api/im/assets/{id}` requires a Bearer token that `<img>` can't send,
  // so for those URLs we route through `usePrivateImage` to get a blob URL
  // via authenticated fetch. External URLs (CDN/https) bypass the hook.
  const needsPrivate = thumb !== null && isPrivateAssetUrl(thumb);
  const blobUrl = usePrivateImage(needsPrivate ? thumb : null);
  const renderSrc = needsPrivate ? blobUrl : thumb;
  // Image preview path — render the actual bytes filling the box.
  // `object-cover` keeps the aspect ratio without empty bars; the wrapper
  // is `overflow-hidden` to clip the rounded corners cleanly.
  if (renderSrc) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center overflow-hidden ${box} ${
          isDark ? 'bg-zinc-900/40' : 'bg-zinc-100'
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- inline preview of an authenticated workspace asset URL; Next/Image loader isn't configured for these. */}
        <img
          src={renderSrc}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  // Fallback path — type-coloured swatch + mime icon (image=emerald,
  // doc=sky, pdf=rose, data=amber, code=violet, other=zinc) so the file
  // type reads at a glance. Hit while the auth fetch is in flight AND when
  // no thumbnail exists.
  const swatch = TYPE_SWATCH[assetTypeTone(asset)];
  return (
    <span className={`flex shrink-0 items-center justify-center ${box} ${isDark ? swatch.dark : swatch.light}`}>
      {renderAssetIcon(asset, size)}
    </span>
  );
}

function statusLabelKey(status: string): TranslationKey {
  switch (status) {
    case 'memory-ready':
      return 'assetUi.status.memoryReady';
    case 'asset-only':
      return 'assetUi.status.assetOnly';
    case 'pending':
      return 'assetUi.status.pending';
    case 'failed':
      return 'assetUi.status.failed';
    case 'indexed':
      return 'assetUi.status.indexed';
    default:
      return 'assetUi.status.synced';
  }
}

export function StatusBadge({ status, isDark }: { status: string; isDark: boolean }) {
  const { t } = useI18n();
  const normalized = status || 'synced';
  const ready = normalized === 'memory-ready' || normalized === 'indexed' || normalized === 'synced';
  const failed = normalized === 'failed';
  const className = failed
    ? isDark
      ? 'border-red-400/20 bg-red-500/10 text-red-200'
      : 'border-red-200 bg-red-50 text-red-700'
    : ready
      ? isDark
        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : isDark
        ? 'border-amber-400/20 bg-amber-500/10 text-amber-100'
        : 'border-amber-200 bg-amber-50 text-amber-700';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${className}`}
    >
      <CheckCircle2 className="h-3 w-3" />
      {t(statusLabelKey(normalized))}
    </span>
  );
}

function AssetIconButton({
  isDark,
  title,
  disabled,
  onClick,
  children,
  danger,
}: {
  isDark: boolean;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={title}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? isDark
            ? 'text-red-300 hover:bg-red-400/10 hover:text-red-100'
            : 'text-red-500 hover:bg-red-50 hover:text-red-700'
          : isDark
            ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Bulk-selection checkbox — top-left corner affordance. Visible on hover or
 * always when the card is selected (driven by `group-hover` + the `selected`
 * state). Toggling it must not open the asset, so we stop the native click.
 */
function SelectCheckbox({
  isDark,
  selected,
  onToggle,
}: {
  isDark: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={selected ? t('assetUi.card.deselectAsset') : t('assetUi.card.selectAsset')}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={`absolute left-2 top-2 z-20 inline-flex h-5 w-5 items-center justify-center rounded-md border transition-all ${
        selected
          ? isDark
            ? 'border-violet-400 bg-violet-500 text-white opacity-100'
            : 'border-violet-600 bg-violet-600 text-white opacity-100'
          : `opacity-0 group-hover:opacity-100 ${
              isDark
                ? 'border-white/[0.2] bg-zinc-900/80 text-transparent hover:border-violet-400'
                : 'border-zinc-300 bg-white/90 text-transparent hover:border-violet-500'
            }`
      }`}
    >
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </button>
  );
}

function AssetMenuItem({
  isDark,
  danger,
  icon,
  label,
  onClick,
}: {
  isDark: boolean;
  danger?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={`flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs font-medium ${
        danger
          ? isDark
            ? 'text-red-200 hover:bg-red-500/10'
            : 'text-red-700 hover:bg-red-50'
          : isDark
            ? 'text-zinc-200 hover:bg-white/[0.06]'
            : 'text-zinc-700 hover:bg-zinc-100'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function AssetCardMenu({
  isDark,
  position,
  onOpen,
  onRename,
  onDownload,
  onDelete,
}: {
  isDark: boolean;
  position: 'top' | 'bottom';
  onOpen: () => void;
  onRename: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const placement = position === 'bottom' ? 'bottom-12 right-3' : 'right-3 top-12';
  return (
    <div
      className={`absolute ${placement} z-30 w-44 overflow-hidden rounded-2xl border p-1 shadow-2xl ${
        isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <AssetMenuItem isDark={isDark} icon={<Eye className="h-3.5 w-3.5" />} label={t('assetUi.card.open')} onClick={onOpen} />
      <AssetMenuItem isDark={isDark} icon={<Edit3 className="h-3.5 w-3.5" />} label={t('assetUi.card.rename')} onClick={onRename} />
      <AssetMenuItem
        isDark={isDark}
        icon={<CloudDownload className="h-3.5 w-3.5" />}
        label={t('assetUi.card.download')}
        onClick={onDownload}
      />
      <div className={`my-1 h-px ${isDark ? 'bg-white/[0.07]' : 'bg-zinc-100'}`} />
      <AssetMenuItem
        isDark={isDark}
        danger
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label={t('assetUi.card.delete')}
        onClick={onDelete}
      />
    </div>
  );
}

// ─── AssetCard (the public card component) ───────────────────────────────

export interface AssetCardProps {
  isDark: boolean;
  layout: CardLayoutMode;
  asset: AssetDTO;
  file?: WorkspaceFileDTO;
  /** True when this card is the active row in its panel (highlight). */
  busy?: boolean;
  downloading?: boolean;
  menuOpen?: boolean;
  /** Bulk-selection state. When `onToggleSelect` is set, the card renders a
   *  selection checkbox affordance (top-left) and a selected visual state. */
  selected?: boolean;
  onToggleSelect?: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRename: () => void;
  onToggleMenu: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
}

export function AssetCard({
  isDark,
  layout,
  asset,
  file,
  busy = false,
  downloading = false,
  menuOpen = false,
  selected = false,
  onToggleSelect,
  onOpen,
  onDownload,
  onDelete,
  onRename,
  onToggleMenu,
  onDragStart,
  onDragEnd,
}: AssetCardProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const title = assetTitle(asset, file);
  // Legible meta: friendly type + size, with time shown relative ("2h ago")
  // and the absolute timestamp on hover.
  const typeLabel = friendlyType(asset);
  const sizeLabel = formatBytes(asset.sizeBytes);
  const relTime = relativeTime(asset.createdAt);
  const absTime = new Date(asset.createdAt).toLocaleString();
  const memoryPages = asset.memoryPages?.length ?? 0;

  // ── List layout — compact horizontal row ────────────────────────────
  if (layout === 'list') {
    return (
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        data-testid={`asset-card-list-${asset.id}`}
        data-asset-id={asset.id}
        className={`group relative flex cursor-grab items-center gap-3 border p-3 transition-all active:cursor-grabbing ${radius.card} ${surface.card[theme]} ${
          selected
            ? isDark
              ? 'border-violet-400/60 ring-1 ring-violet-400/40'
              : 'border-violet-400 ring-1 ring-violet-300'
            : ''
        } ${isDark ? 'hover:bg-white/[0.055]' : 'hover:bg-white'}`}
      >
        {onToggleSelect ? (
          <SelectCheckbox isDark={isDark} selected={selected} onToggle={onToggleSelect} />
        ) : null}
        <AssetThumb asset={asset} isDark={isDark} size="sm" />
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {typeLabel} · {sizeLabel} · <span title={absTime}>{relTime}</span>
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 md:flex">
            <SourceBadge asset={asset} isDark={isDark} />
            <StatusBadge status={asset.ingestStatus ?? 'synced'} isDark={isDark} />
            {memoryPages > 0 ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${
                  isDark
                    ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                    : 'border-cyan-200 bg-cyan-50 text-cyan-700'
                }`}
              >
                <FileText className="h-3 w-3" />
                {memoryPages}
              </span>
            ) : null}
            <span className={`font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              {asset.contentHash.slice(0, 8)}
            </span>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <AssetIconButton isDark={isDark} title={t('assetUi.card.download')} disabled={downloading || busy} onClick={onDownload}>
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
          </AssetIconButton>
          <AssetIconButton isDark={isDark} title={t('assetUi.card.actions')} disabled={busy} onClick={onToggleMenu}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
          </AssetIconButton>
        </div>
        {menuOpen ? (
          <AssetCardMenu
            isDark={isDark}
            position="top"
            onOpen={() => {
              onToggleMenu();
              onOpen();
            }}
            onRename={onRename}
            onDownload={() => {
              onToggleMenu();
              onDownload();
            }}
            onDelete={onDelete}
          />
        ) : null}
      </div>
    );
  }

  // ── Grid layout — the original full card ───────────────────────────
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-testid={`asset-card-grid-${asset.id}`}
      data-asset-id={asset.id}
      className={`group relative flex min-h-[136px] cursor-grab flex-col justify-between border p-3 transition-all active:cursor-grabbing ${radius.card} ${surface.card[theme]} ${
        selected
          ? isDark
            ? 'border-violet-400/60 ring-1 ring-violet-400/40'
            : 'border-violet-400 ring-1 ring-violet-300'
          : ''
      } ${isDark ? 'hover:bg-white/[0.055]' : 'hover:bg-white'}`}
    >
      {onToggleSelect ? (
        <SelectCheckbox isDark={isDark} selected={selected} onToggle={onToggleSelect} />
      ) : null}
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <AssetThumb asset={asset} isDark={isDark} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {title}
          </span>
          <span className={`mt-0.5 block truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {typeLabel} · {sizeLabel} · <span title={absTime}>{relTime}</span>
          </span>
          {asset.description && asset.description.trim().length > 0 ? (
            <span
              data-testid={`library-files-asset-description-${asset.id}`}
              className={`mt-1 block text-[11px] leading-snug ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {asset.description}
            </span>
          ) : null}
          <span className="mt-2 flex flex-wrap gap-1.5">
            <SourceBadge asset={asset} isDark={isDark} />
            <StatusBadge status={asset.ingestStatus ?? 'synced'} isDark={isDark} />
            {memoryPages > 0 ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${
                  isDark
                    ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                    : 'border-cyan-200 bg-cyan-50 text-cyan-700'
                }`}
              >
                <FileText className="h-3 w-3" />
                {t('assetUi.card.memoryPages', { count: memoryPages })}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={`truncate font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {asset.contentHash.slice(0, 12)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <AssetIconButton isDark={isDark} title={t('assetUi.card.download')} disabled={downloading || busy} onClick={onDownload}>
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
          </AssetIconButton>
          <AssetIconButton isDark={isDark} title={t('assetUi.card.delete')} disabled={busy} danger onClick={onDelete}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </AssetIconButton>
          <AssetIconButton isDark={isDark} title={t('assetUi.card.actions')} disabled={busy} onClick={onToggleMenu}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
          </AssetIconButton>
        </div>
      </div>
      {menuOpen ? (
        <AssetCardMenu
          isDark={isDark}
          position="bottom"
          onOpen={() => {
            onToggleMenu();
            onOpen();
          }}
          onRename={onRename}
          onDownload={() => {
            onToggleMenu();
            onDownload();
          }}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );
}
