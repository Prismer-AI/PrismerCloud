'use client';

/**
 * MessageAssetCard — mime-based unified renderer for attachments inside an
 * IM message bubble.
 *
 * Owns ALL per-attachment chrome inside a chat bubble: image thumbnail,
 * audio/video inline players, PDF preview tiles, generic file rows, "file
 * too large" fallback, and the bookkeeping for downloading the
 * authenticated `/api/im/assets/{id}` bytes as a blob URL when the inline
 * media needs them.
 *
 * Source of truth for shape is the cloud-side `AssetAttachment` Phase 1
 * pipeline (doc release201/30): `{ assetId, contentHash, mime, sizeBytes,
 * filename, cdnUrl?, thumbnailUrl?, previewUrls? }`. The card also accepts
 * a `legacyFileUrl` slot so the caller can synthesise a card from the old
 * `metadata.fileUrl` / `metadata.uploadId` shape (messages from SDK
 * versions that did not dual-write `attachments[]`).
 *
 * Click on any card calls `onPreview(asset)`; the parent typically routes
 * that into `MessageAssetViewerModal` (mime-driven preview) or the
 * existing workspace inspector dialog.
 *
 * The 20 MB inline-image cap below mirrors the Phase 1 decision recorded
 * in release201/30 §3 — anything bigger renders as a download-only chip
 * so we never block the chat scroll on a 200 MB image fetch.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { thumbHashToDataURL } from 'thumbhash';
import {
  AlertTriangle,
  Archive,
  CloudDownload,
  File as FileIcon,
  FileText,
  ImageIcon,
  Loader2,
  Music,
  Play,
  Video,
} from 'lucide-react';

import { getWorkspaceToken } from '../lib/im-api';
import { useI18n } from '@/contexts/i18n-context';
import { subscribeAssetChanged } from '../lib/asset-event-bus';
import { deriveDeliveryProgress, type DeliveryProgress } from '../lib/delivery-progress';

export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * The minimal shape a `MessageAssetCard` needs. All optional except `id`
 * (used as the dom test-id and as the lookup key when the caller opens
 * the inspector).
 *
 * Why this exists alongside `AssetDTO`: a message attachment surface
 * does NOT have the full Library asset row (no `workspaceId`, no
 * `ingestStatus`, no derived assets). And legacy `metadata.fileUrl`
 * messages have *neither* an IMAsset row nor a hash. Decoupling lets
 * both paths render through one component.
 */
export interface MessageAsset {
  id: string;
  mime?: string | null;
  sizeBytes?: number | null;
  filename?: string | null;
  cdnUrl?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
  /**
   * release202/13 §3b① — base64 thumbHash for an instant (~0-network) blurred
   * placeholder rendered behind the real <img>, which fades in on load.
   * Decoded client-side via `thumbHashToDataURL`. Null → spinner fallback.
   */
  blurHash?: string | null;
  /**
   * release202/13 §L1 — short text excerpt (≤~280 chars) for small md/txt cards
   * so they render text immediately without a byte fetch. Full content still
   * loads via the existing path when opened.
   */
  previewText?: string | null;
  /**
   * `attachment` is a normal file. `legacy-file-url` flags that the card
   * was synthesised from `metadata.fileUrl` (no IMAsset row). The viewer
   * uses this to short-circuit the `/api/im/assets/{id}` bytes fetch
   * (the id is not a real asset id) and go straight to `cdnUrl`.
   */
  source?: 'attachment' | 'legacy-file-url';
  /** Optional context for the "missing" fallback. */
  traceId?: string | null;
}

export type MimeBucket = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';

export function bucketForMime(mime: string | null | undefined): MimeBucket {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || m.endsWith('/pdf')) return 'pdf';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface MessageAssetCardProps {
  asset: MessageAsset;
  isDark: boolean;
  /** True when the card sits inside the user's own (right-aligned) bubble. */
  inOwnBubble?: boolean;
  /** Invoked on click — host typically opens MessageAssetViewerModal. */
  onPreview?: (asset: MessageAsset) => void;
  /** Invoked when the user hits the explicit download icon (oversize fallback). */
  onDownload?: (asset: MessageAsset) => void;
}

/**
 * Resolve the best URL to feed an inline `<img/video/audio>` element.
 * Returns null when the bytes need to be fetched with a Bearer token
 * (i.e. the asset is a real `/api/im/assets/{id}` route); the caller's
 * fetch effect then writes the resulting object URL into state.
 */
function pickPublicUrl(asset: MessageAsset, bucket: MimeBucket): string | null {
  if (bucket === 'image') {
    if (asset.previewUrls?.medium) return asset.previewUrls.medium;
    if (asset.thumbnailUrl) return asset.thumbnailUrl;
  }
  if (asset.source === 'legacy-file-url' && asset.cdnUrl) return asset.cdnUrl;
  return null;
}

/**
 * release202/13 §3b① — decode a base64 thumbHash into a tiny PNG data URL for
 * an instant (~0-network) blurred placeholder. Returns null when absent or
 * malformed (→ caller falls back to the existing spinner). Memoised by caller.
 */
export function thumbHashDataUrl(blurHash: string | null | undefined): string | null {
  if (!blurHash) return null;
  try {
    const binary = atob(blurHash);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}

/**
 * Hook that downloads an authenticated workspace asset and exposes an
 * object URL for inline rendering. Skips fetching when the caller can
 * use a public CDN URL directly (legacy fileUrl path).
 */
function useAuthenticatedBytes(
  asset: MessageAsset,
  want: boolean,
): {
  objectUrl: string | null;
  error: string | null;
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!want) {
      setObjectUrl(null);
      setError(null);
      return;
    }
    if (asset.source === 'legacy-file-url' && asset.cdnUrl) {
      // Legacy path — cdnUrl is already a public URL.
      setObjectUrl(asset.cdnUrl);
      setError(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
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
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset.id, asset.cdnUrl, asset.source, want]);
  return { objectUrl, error };
}

/**
 * Resolve a thumbnail/derivative URL into something an <img> can actually load.
 *
 * Derivative URLs come back as `/api/im/assets/<derivativeAssetId>` — a route
 * that REQUIRES a Bearer token (401 to an unauthenticated browser <img> GET, as
 * in dev/filesystem mode). A raw `<img src="/api/im/assets/...">` therefore
 * renders a BROKEN image. So: same-origin `/api/im/assets/*` URLs are fetched
 * WITH the workspace token and turned into a blob object URL; already-public
 * URLs (absolute CDN/S3 presigned, blob:, data:) pass straight through.
 */
function useAuthedAssetSrc(url: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setResolved(null);
      return;
    }
    const needsAuth = url.startsWith('/api/im/assets/');
    if (!needsAuth) {
      setResolved(url);
      return;
    }
    let cancelled = false;
    let made: string | null = null;
    const token = getWorkspaceToken();
    if (!token) {
      setResolved(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setResolved(made);
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url]);
  return resolved;
}

/**
 * Pull a thumbnail (small/medium) URL straight off the message-payload shape.
 * Returns null when the payload has no derivative URL yet — the caller then
 * falls back to a `/:id/detail` fetch (where the derivative may already exist
 * on the asset row even though the message attachment dropped it).
 */
function thumbnailFromPayload(asset: MessageAsset): string | null {
  if (asset.previewUrls?.small) return asset.previewUrls.small;
  if (asset.previewUrls?.medium) return asset.previewUrls.medium;
  if (asset.thumbnailUrl) return asset.thumbnailUrl;
  return null;
}

/** Whether this mime can ever have a first-page / raster thumbnail derivative. */
function canHaveThumbnail(asset: MessageAsset): boolean {
  const bucket = bucketForMime(asset.mime);
  return bucket === 'image' || bucket === 'pdf';
}

/**
 * Self-contained per-asset thumbnail resolver for a chat-attachment card.
 *
 * Resolution order:
 *   1. Thumbnail URL already carried on the message attachment payload
 *      (drag-attach + upload paths thread `thumbnailUrl`/`previewUrls`).
 *   2. Otherwise, for IMAsset-backed attachments (not legacy fileUrl), fetch
 *      `GET /api/im/assets/:id/detail` and read `thumbnailUrl`/`previewUrls`
 *      off the row. Agent/cli-delivered files drop these at the message
 *      boundary, but the asset row itself carries them once the in-process
 *      derivative pipeline lands — so the card resolves them on its own,
 *      WITHOUT depending on the workspace asset list being pre-loaded.
 *
 * Reactivity: subscribes to `asset.changed` for THIS asset id via the
 * per-asset bus. When the server emits `asset.changed` (derivative landed),
 * it re-fetches `/detail` so the thumbnail appears in place — no page-level
 * `invalidate('assets')` / whole-list reload.
 *
 * `generating` is true while we expect a thumbnail (image/pdf, IMAsset-backed,
 * no URL yet, ingest not failed) — drives a "generating preview…" state in the
 * card instead of a hard error.
 */
function useAssetThumbnail(asset: MessageAsset): {
  thumbnailUrl: string | null;
  generating: boolean;
  /**
   * Terminal: the derivative will never arrive — `ingestStatus` flipped to
   * 'failed', or the bounded poll schedule elapsed with no URL (a server-side
   * skip that never flips ingestStatus). Lets the unified delivery affordance
   * surface a clear FAILED state instead of stalling on a spinner.
   */
  derivativeFailed: boolean;
} {
  const payloadUrl = thumbnailFromPayload(asset);
  const eligible = canHaveThumbnail(asset);
  // Legacy fileUrl attachments have no real IMAsset row to /detail-fetch.
  const detailFetchable = asset.source !== 'legacy-file-url';

  const [detailUrl, setDetailUrl] = useState<string | null>(null);
  const [ingestFailed, setIngestFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // True once the bounded poll schedule has fully elapsed without a thumbnail.
  // A derivative can be SKIPPED server-side (sharp/sips unavailable, undecodable
  // raster, storage write fail) without flipping ingestStatus to 'failed' — the
  // parent stays 'asset-only' and the URL never lands. Without this escape,
  // `generating` would stay true forever and the image card would never fall
  // back to fetching the (servable) full-res bytes. Reset per asset id below.
  const [pollExhausted, setPollExhausted] = useState(false);

  // Re-fetch trigger: the asset's `asset.changed` arrives (derivative landed).
  useEffect(() => {
    if (!detailFetchable || !eligible) return;
    return subscribeAssetChanged(asset.id, () => setReloadNonce((n) => n + 1));
  }, [asset.id, detailFetchable, eligible]);

  // Fresh asset → fresh poll window; clear any prior exhaustion.
  useEffect(() => {
    setPollExhausted(false);
  }, [asset.id]);

  const resolvedSoFar = payloadUrl ?? detailUrl;
  // Bounded re-poll while a thumbnail is still expected. The server renders the
  // derivative fire-and-forget on a separate path, so the `asset.changed` /
  // `message.new` nudge can race ahead of the rendered PNG. A few spaced polls
  // close that window deterministically (and stop the moment the URL lands or
  // ingest fails). This is a fallback — the event nudge above is the fast path.
  // After the LAST delay fires with still no URL, mark the poll exhausted so the
  // UI stops claiming "generating" forever (a late thumbnail can still arrive
  // via `asset.changed` → reloadNonce → resolvedSoFar, which renders regardless).
  useEffect(() => {
    if (!detailFetchable || !eligible) return;
    if (resolvedSoFar || ingestFailed) return;
    const delays = [1500, 3500, 7000];
    const timers = delays.map((ms) => setTimeout(() => setReloadNonce((n) => n + 1), ms));
    // Exhaust just after the final poll has had a chance to resolve.
    const lastDelay = delays[delays.length - 1];
    const exhaustTimer = setTimeout(() => setPollExhausted(true), lastDelay + 1000);
    return () => {
      for (const t of timers) clearTimeout(t);
      clearTimeout(exhaustTimer);
    };
  }, [asset.id, detailFetchable, eligible, resolvedSoFar, ingestFailed]);

  useEffect(() => {
    // Skip the detail fetch entirely when the payload already gave us a URL,
    // or this mime can never produce a thumbnail, or there is no real asset
    // row to query.
    if (payloadUrl || !eligible || !detailFetchable) return;
    let cancelled = false;
    const token = getWorkspaceToken();
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}/detail`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return; // 404/410 → no thumbnail; card keeps placeholder
        const body = (await res.json()) as {
          data?: {
            thumbnailUrl?: string | null;
            previewUrls?: { small?: string; medium?: string } | null;
            ingestStatus?: string | null;
          };
        };
        if (cancelled) return;
        const d = body.data ?? {};
        const url = d.previewUrls?.small ?? d.previewUrls?.medium ?? d.thumbnailUrl ?? null;
        if (url) setDetailUrl(url);
        // 'failed' ingest → stop showing "generating…" (derivative will never come).
        if (typeof d.ingestStatus === 'string' && d.ingestStatus === 'failed') {
          setIngestFailed(true);
        }
      } catch {
        // best-effort — card keeps its file-type placeholder, never errors hard
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset.id, payloadUrl, eligible, detailFetchable, reloadNonce]);

  const generating = eligible && detailFetchable && !resolvedSoFar && !ingestFailed && !pollExhausted;
  // Terminal DELIVERY failure = ingest reported 'failed' ONLY. A poll window that
  // elapsed with no derivative (`pollExhausted`) is NOT a delivery failure — the
  // asset is stored + openable, it just has no inline preview (e.g. the pod lacks
  // a PDF rasterizer, or the derivative was skipped). Counting that as failed was
  // why a perfectly-openable PDF showed a red "Delivery failed" pill. `generating`
  // already clears on pollExhausted, so the spinner stops and the generic file
  // icon shows; we just must not flip the card into a failed state.
  const derivativeFailed = eligible && detailFetchable && !resolvedSoFar && ingestFailed;
  return { thumbnailUrl: resolvedSoFar, generating, derivativeFailed };
}

// ─── Unified delivery-progress affordance ───────────────────────────

/**
 * One calm inline status that advances through the agent-file-delivery
 * chain (Delivering → Preparing preview → Ready / Delivery failed) and is
 * driven entirely by `deriveDeliveryProgress` off the EXISTING thumbnail /
 * ingest signals — no new polling. Settled stages (`ready`) render nothing
 * (the real attachment card IS the resolved state); the in-flight / failed
 * stages render a subtle pill that matches the card's `isDark` vocabulary
 * and the StatusBadge colour language (amber = working, red = failed).
 *
 * Shared by the message bubble (ImageCard / GenericFileCard placeholders)
 * and the right-rail asset thumb so both surfaces read off ONE state.
 */
export function DeliveryProgressIndicator({
  progress,
  isDark,
  inOwnBubble = false,
  compact = false,
}: {
  progress: DeliveryProgress;
  isDark: boolean;
  inOwnBubble?: boolean;
  compact?: boolean;
}): ReactNode {
  if (progress.settled && progress.stage === 'ready') return null;
  const failed = progress.stage === 'failed';
  const tone = failed
    ? inOwnBubble
      ? 'border-white/25 bg-white/10 text-white'
      : isDark
        ? 'border-red-400/20 bg-red-500/10 text-red-200'
        : 'border-red-200 bg-red-50 text-red-700'
    : inOwnBubble
      ? 'border-white/20 bg-white/10 text-white/90'
      : isDark
        ? 'border-amber-400/20 bg-amber-500/10 text-amber-100'
        : 'border-amber-200 bg-amber-50 text-amber-700';
  return (
    <span
      data-testid="delivery-progress"
      data-stage={progress.stage}
      role="status"
      aria-live="polite"
      title={progress.label}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium ${
        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      } ${tone}`}
    >
      {failed ? (
        <AlertTriangle className={compact ? 'h-2.5 w-2.5 shrink-0' : 'h-3 w-3 shrink-0'} aria-hidden="true" />
      ) : (
        <Loader2 className={`${compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} shrink-0 animate-spin`} aria-hidden="true" />
      )}
      <span className="truncate">{progress.label}</span>
    </span>
  );
}

// ─── Sub-card variants ──────────────────────────────────────────────

function CardShellButton({
  inOwnBubble,
  isDark,
  title,
  testId,
  onClick,
  children,
  className = '',
}: {
  inOwnBubble: boolean;
  isDark: boolean;
  title?: string;
  testId: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={`block max-w-full text-left transition-transform active:scale-[0.98] active:opacity-90 ${className} ${
        inOwnBubble ? 'border-white/20' : isDark ? 'border-white/[0.08]' : 'border-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

function ImageCard({ asset, inOwnBubble, isDark, onPreview }: MessageAssetCardProps) {
  const { t } = useI18n();
  const oversized = typeof asset.sizeBytes === 'number' && asset.sizeBytes > MAX_INLINE_IMAGE_BYTES;
  const publicUrl = pickPublicUrl(asset, 'image');
  // Self-resolve a thumbnail (payload → /detail → asset.changed re-fetch) so an
  // agent-delivered image that dropped its preview URL at the message boundary
  // still gets a lightweight inline render once the derivative lands, instead
  // of always paying for a full-res authenticated bytes fetch.
  const { thumbnailUrl, generating, derivativeFailed } = useAssetThumbnail(asset);
  const preferredUrl = publicUrl ?? thumbnailUrl;
  // Derivative URLs are authed `/api/im/assets/*` routes — resolve to a blob
  // object URL so the <img> doesn't 401 (the whole point of inline thumbnails).
  const resolvedPreferred = useAuthedAssetSrc(preferredUrl);
  // Only fall back to the full-res blob fetch when we have NO public/derivative
  // URL at all and we are not still waiting on a generating derivative.
  const { objectUrl, error } = useAuthenticatedBytes(asset, !oversized && !preferredUrl && !generating);
  const renderSrc = resolvedPreferred ?? objectUrl;
  const altText = asset.filename || 'image';
  // release202/13 §3b① — instant blurred placeholder from the inline thumbHash
  // (~0-network); the real <img> fades in over it on load. Null → spinner.
  const blurUrl = useMemo(() => thumbHashDataUrl(asset.blurHash), [asset.blurHash]);
  const [imgLoaded, setImgLoaded] = useState(false);
  // Unified delivery progress — one ordered stage off the existing thumbnail +
  // ingest signals (no new polling). `ready` once we have anything to render.
  const delivery = deriveDeliveryProgress({
    thumbnailEligible: true,
    hasPreview: Boolean(renderSrc),
    generating,
    // A hard bytes-fetch error is also a terminal delivery failure for an image
    // that has no derivative to fall back on.
    failed: derivativeFailed || (Boolean(error) && !renderSrc),
  });

  if (oversized) {
    return <OversizeImageCard asset={asset} inOwnBubble={Boolean(inOwnBubble)} isDark={isDark} onPreview={onPreview} />;
  }

  const onClick = onPreview ? () => onPreview(asset) : undefined;

  return (
    <CardShellButton
      inOwnBubble={Boolean(inOwnBubble)}
      isDark={isDark}
      title={altText}
      testId={`chat-asset-image-${asset.id}`}
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border sm:max-w-[240px]"
    >
      {renderSrc ? (
        <span className="relative block">
          {/* Instant thumbHash placeholder — 0 network, decoded inline. Sits
              behind the real <img> and is covered as it fades in. */}
          {blurUrl && !imgLoaded ? (
            // eslint-disable-next-line @next/next/no-img-element -- decoded thumbHash data URL (no network).
            <img src={blurUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" />
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- inline preview of an authenticated workspace asset URL; Next/Image loader isn't configured for these. */}
          <img
            src={renderSrc}
            alt={altText}
            loading="lazy"
            decoding="async"
            onLoad={() => setImgLoaded(true)}
            className={`relative h-auto max-h-60 w-full max-w-[240px] object-cover transition-opacity duration-300 ${
              blurUrl && !imgLoaded ? 'opacity-0' : 'opacity-100'
            }`}
          />
        </span>
      ) : blurUrl ? (
        // No real bytes yet but we have a thumbHash → show the blurred
        // placeholder immediately (with the delivery pill overlaid).
        <span className="relative block h-32 w-full min-w-[180px] max-w-[240px]">
          {/* eslint-disable-next-line @next/next/no-img-element -- decoded thumbHash data URL (no network). */}
          <img src={blurUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" />
          {delivery.inFlight || delivery.stage === 'failed' ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <DeliveryProgressIndicator progress={delivery} isDark={isDark} inOwnBubble={Boolean(inOwnBubble)} />
            </span>
          ) : null}
        </span>
      ) : (
        <span
          className={`flex h-32 w-full min-w-[180px] max-w-[240px] items-center justify-center gap-1.5 text-[10px] ${
            inOwnBubble
              ? 'bg-white/10 text-white/70'
              : isDark
                ? 'bg-white/[0.04] text-zinc-500'
                : 'bg-zinc-100 text-zinc-500'
          }`}
        >
          {delivery.inFlight || delivery.stage === 'failed' ? (
            <DeliveryProgressIndicator progress={delivery} isDark={isDark} inOwnBubble={Boolean(inOwnBubble)} />
          ) : (
            t('assetUi.message.loadingImage')
          )}
        </span>
      )}
    </CardShellButton>
  );
}

function OversizeImageCard({
  asset,
  inOwnBubble,
  isDark,
  onPreview,
}: {
  asset: MessageAsset;
  inOwnBubble: boolean;
  isDark: boolean;
  onPreview?: (asset: MessageAsset) => void;
}) {
  const { t } = useI18n();
  const onClick = onPreview ? () => onPreview(asset) : undefined;
  const size = formatBytes(asset.sizeBytes ?? null);
  return (
    <CardShellButton
      inOwnBubble={inOwnBubble}
      isDark={isDark}
      title={asset.filename ?? 'oversize image'}
      testId={`chat-asset-image-oversize-${asset.id}`}
      onClick={onClick}
      className={`flex w-full max-w-[320px] items-center gap-2 rounded-2xl border px-3 py-2 transition ${
        inOwnBubble
          ? 'bg-white/15 hover:bg-white/20'
          : isDark
            ? 'bg-white/[0.04] hover:bg-white/[0.07]'
            : 'bg-zinc-50 hover:bg-zinc-100'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          inOwnBubble
            ? 'bg-white/15 text-white'
            : isDark
              ? 'bg-violet-500/15 text-violet-200'
              : 'bg-violet-100 text-violet-700'
        }`}
      >
        <ImageIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-xs font-semibold ${
            inOwnBubble ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
          }`}
        >
          {asset.filename ?? 'image'}
        </span>
        <span
          className={`block truncate text-[10px] ${
            inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          {t('assetUi.message.oversizeImage', { size })}
        </span>
      </span>
      <CloudDownload
        className={`h-3.5 w-3.5 shrink-0 ${inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      />
    </CardShellButton>
  );
}

function VideoCard({ asset, inOwnBubble, isDark, onPreview }: MessageAssetCardProps) {
  const { t } = useI18n();
  const { objectUrl, error } = useAuthenticatedBytes(asset, true);
  const onClick = onPreview ? () => onPreview(asset) : undefined;
  return (
    <CardShellButton
      inOwnBubble={Boolean(inOwnBubble)}
      isDark={isDark}
      title={asset.filename ?? 'video'}
      testId={`chat-asset-video-${asset.id}`}
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border sm:max-w-[240px]"
    >
      {objectUrl ? (
        <>
          <video
            src={objectUrl}
            preload="metadata"
            muted
            playsInline
            controlsList="nodownload"
            className="h-auto max-h-60 w-full max-w-[240px] object-cover"
          />
          <span
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 transition group-hover:bg-black/45"
            aria-hidden="true"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/85 text-zinc-900 shadow-lg">
              <Play className="h-4 w-4" />
            </span>
          </span>
        </>
      ) : (
        <span
          className={`flex h-32 w-[240px] items-center justify-center gap-2 text-[10px] ${
            inOwnBubble
              ? 'bg-white/10 text-white/70'
              : isDark
                ? 'bg-white/[0.04] text-zinc-500'
                : 'bg-zinc-100 text-zinc-500'
          }`}
        >
          <Video className="h-3 w-3" />
          {error ? `video · ${error}` : t('assetUi.message.loadingVideo')}
        </span>
      )}
    </CardShellButton>
  );
}

function AudioCard({ asset, inOwnBubble, isDark, onPreview }: MessageAssetCardProps) {
  const { t } = useI18n();
  const { objectUrl, error } = useAuthenticatedBytes(asset, true);
  const onClick = onPreview ? () => onPreview(asset) : undefined;
  const title = asset.filename ?? 'audio';
  return (
    <div
      data-testid={`chat-asset-audio-${asset.id}`}
      className={`flex max-w-[280px] flex-col gap-1.5 rounded-2xl border px-3 py-2 ${
        inOwnBubble
          ? 'border-white/20 bg-white/15'
          : isDark
            ? 'border-white/[0.08] bg-white/[0.04]'
            : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-2 text-left ${
          inOwnBubble ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
        }`}
      >
        <Music className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</span>
        {asset.sizeBytes != null ? (
          <span
            className={`shrink-0 text-[10px] ${
              inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
            }`}
          >
            {formatBytes(asset.sizeBytes)}
          </span>
        ) : null}
      </button>
      {objectUrl ? (
        <audio src={objectUrl} controls preload="metadata" className="w-full" />
      ) : (
        <span className={`text-[10px] ${inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {error ? `audio · ${error}` : t('assetUi.message.loadingAudio')}
        </span>
      )}
    </div>
  );
}

function genericIcon(bucket: MimeBucket): ReactNode {
  if (bucket === 'pdf') return <FileText className="h-4 w-4" />;
  if (bucket === 'text') return <FileText className="h-4 w-4" />;
  return <Archive className="h-4 w-4" />;
}

function GenericFileCard({
  asset,
  bucket,
  inOwnBubble,
  isDark,
  onPreview,
}: MessageAssetCardProps & { bucket: MimeBucket }) {
  const onClick = onPreview ? () => onPreview(asset) : undefined;
  const title = asset.filename ?? asset.mime ?? 'file';
  const size = formatBytes(asset.sizeBytes ?? null);
  // PDF gets a first-page thumbnail tile. The hook resolves it from the
  // message payload, falls back to a `/:id/detail` fetch when the attachment
  // dropped the URL (agent/cli-delivered), and re-fetches when `asset.changed`
  // signals the derivative landed — so the tile appears in place once ready.
  const { thumbnailUrl: pdfThumb, generating, derivativeFailed } = useAssetThumbnail(asset);
  const previewUrl = bucket === 'pdf' ? pdfThumb : null;
  // Authed `/api/im/assets/*` derivative → blob object URL (else <img> 401s).
  const resolvedPreview = useAuthedAssetSrc(previewUrl);
  // "resolving" = we have the derivative URL but are still fetching its bytes;
  // show the spinner tile (not the plain icon) so it doesn't flash, then flip.
  const resolving = Boolean(previewUrl) && !resolvedPreview;
  const showGenerating = bucket === 'pdf' && ((!previewUrl && generating) || resolving);
  // Unified delivery progress. Only PDFs have a "previewing" stage; other files
  // are clickable immediately (settle straight to ready). A PDF whose derivative
  // genuinely failed settles too — the row is still a usable download chip, so
  // we surface a soft "Delivery failed" pill rather than blocking the card.
  const delivery = deriveDeliveryProgress({
    thumbnailEligible: bucket === 'pdf',
    hasPreview: Boolean(resolvedPreview),
    generating: showGenerating,
    failed: bucket === 'pdf' && derivativeFailed,
  });
  const subline = [asset.mime ?? 'unknown mime', size].filter(Boolean).join(' · ');

  // PROMINENT preview — a PDF (or any doc) that has a first-page thumbnail
  // renders as a LARGE page preview, like an image, not a tiny file chip. The
  // page image fills the card; a slim footer carries the name/size/download.
  if (resolvedPreview) {
    return (
      <CardShellButton
        inOwnBubble={Boolean(inOwnBubble)}
        isDark={isDark}
        title={title}
        testId={`chat-asset-file-${asset.id}`}
        onClick={onClick}
        className="group relative block w-[240px] max-w-full overflow-hidden rounded-2xl border"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- pdf first-page derivative; Next/Image loader isn't configured for these URLs. */}
        <img
          src={resolvedPreview}
          alt={title}
          loading="lazy"
          decoding="async"
          className="block h-auto w-full bg-white object-contain"
        />
        <span
          className={`flex items-center gap-1.5 px-2.5 py-1.5 ${
            inOwnBubble
              ? 'bg-white/15 text-white'
              : isDark
                ? 'bg-zinc-900/60 text-zinc-200'
                : 'bg-white/85 text-zinc-700'
          }`}
        >
          <span className="shrink-0 opacity-80">{genericIcon(bucket)}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
          <span className={`shrink-0 text-[10px] ${inOwnBubble ? 'text-white/70' : 'text-zinc-500'}`}>{size}</span>
          <CloudDownload
            className={`h-3.5 w-3.5 shrink-0 ${inOwnBubble ? 'text-white/80' : isDark ? 'text-zinc-400' : 'text-zinc-400'}`}
          />
        </span>
      </CardShellButton>
    );
  }

  // Compact row — a file that is still generating its preview, or has no
  // thumbnail (non-image/pdf), or a pdf whose render failed.
  return (
    <CardShellButton
      inOwnBubble={Boolean(inOwnBubble)}
      isDark={isDark}
      title={title}
      testId={`chat-asset-file-${asset.id}`}
      onClick={onClick}
      className={`flex w-full max-w-[320px] items-stretch gap-2 rounded-2xl border px-3 py-2 transition ${
        inOwnBubble
          ? 'bg-white/15 hover:bg-white/20'
          : isDark
            ? 'bg-white/[0.04] hover:bg-white/[0.07]'
            : 'bg-zinc-50 hover:bg-zinc-100'
      }`}
    >
      {showGenerating ? (
        // Derivative still rendering — file-type placeholder + spinner, never a
        // hard error. Flips to the large preview on the next `asset.changed`.
        <span
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl ${
            inOwnBubble
              ? 'bg-white/15 text-white/80'
              : isDark
                ? 'bg-zinc-900/40 text-zinc-500'
                : 'bg-zinc-100 text-zinc-400'
          }`}
        >
          {genericIcon(bucket)}
          <Loader2 className="absolute h-3.5 w-3.5 animate-spin opacity-90" aria-hidden="true" />
        </span>
      ) : (
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
            inOwnBubble
              ? 'bg-white/15 text-white'
              : isDark
                ? 'bg-violet-500/15 text-violet-200'
                : 'bg-violet-100 text-violet-700'
          }`}
        >
          {genericIcon(bucket)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-xs font-semibold ${
            inOwnBubble ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
          }`}
        >
          {title}
        </span>
        {delivery.inFlight || delivery.stage === 'failed' ? (
          // Unified "Delivering / Preparing preview / Delivery failed" pill.
          // The file row is still clickable underneath — this is an additive,
          // calm status, not a blocking state.
          <span className="mt-0.5 flex items-center gap-1.5">
            <DeliveryProgressIndicator progress={delivery} isDark={isDark} inOwnBubble={Boolean(inOwnBubble)} compact />
          </span>
        ) : (
          <span
            className={`block truncate text-[10px] ${
              inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
            }`}
          >
            {subline}
          </span>
        )}
      </span>
      <CloudDownload
        className={`h-3.5 w-3.5 shrink-0 self-center ${
          inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-400'
        }`}
      />
    </CardShellButton>
  );
}

function MissingCard({ asset, inOwnBubble, isDark }: MessageAssetCardProps) {
  const { t } = useI18n();
  // No mime + no cdnUrl + no resolvable bytes — surface a deterministic
  // marker so the user can at least see "an attachment was supposed to
  // be here" instead of a silent gap, and log so we capture the trace.
  useEffect(() => {
    console.warn('[MessageAssetCard] missing asset payload', {
      id: asset.id,
      traceId: asset.traceId ?? null,
      mime: asset.mime ?? null,
    });
  }, [asset.id, asset.traceId, asset.mime]);
  return (
    <div
      data-testid={`chat-asset-missing-${asset.id}`}
      className={`flex max-w-[320px] items-center gap-2 rounded-2xl border border-dashed px-3 py-2 ${
        inOwnBubble
          ? 'border-white/30 text-white/80'
          : isDark
            ? 'border-white/[0.12] bg-white/[0.02] text-zinc-400'
            : 'border-zinc-300 bg-zinc-50 text-zinc-500'
      }`}
    >
      <FileIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate text-[11px]">
        {t('assetUi.message.fileMissing', { trace: asset.traceId ?? 'unknown' })}
      </span>
    </div>
  );
}

// ─── MessageAssetCard (the public component) ────────────────────────

export function MessageAssetCard(props: MessageAssetCardProps): ReactNode {
  const { asset } = props;
  const hasAnyPayload = Boolean(
    asset.cdnUrl || asset.thumbnailUrl || asset.previewUrls || asset.source === 'attachment',
  );
  if (!asset.mime && !hasAnyPayload) {
    return <MissingCard {...props} />;
  }
  const bucket = bucketForMime(asset.mime);
  if (bucket === 'image') return <ImageCard {...props} />;
  if (bucket === 'video') return <VideoCard {...props} />;
  if (bucket === 'audio') return <AudioCard {...props} />;
  return <GenericFileCard {...props} bucket={bucket} />;
}

/**
 * Shape a legacy `metadata.fileUrl` message into the new `MessageAsset`
 * surface so the same card component renders both. Returns null when the
 * metadata does not look like a legacy file payload.
 */
export function legacyFileUrlToAsset(args: { messageId: string; meta: Record<string, unknown> }): MessageAsset | null {
  const { messageId, meta } = args;
  const fileUrl = typeof meta.fileUrl === 'string' ? meta.fileUrl : null;
  if (!fileUrl) return null;
  const fileName = typeof meta.fileName === 'string' ? meta.fileName : null;
  const mime = typeof meta.mimeType === 'string' ? meta.mimeType : typeof meta.mime === 'string' ? meta.mime : null;
  const fileSize = typeof meta.fileSize === 'number' ? meta.fileSize : null;
  const uploadId = typeof meta.uploadId === 'string' ? meta.uploadId : null;
  return {
    id: uploadId ?? `legacy-${messageId}`,
    cdnUrl: fileUrl,
    filename: fileName,
    mime,
    sizeBytes: fileSize,
    source: 'legacy-file-url',
  };
}
