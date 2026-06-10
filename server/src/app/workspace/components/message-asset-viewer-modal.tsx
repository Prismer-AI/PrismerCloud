'use client';

/**
 * MessageAssetViewerModal — chat-side attachment preview dialog.
 *
 * Body rendering is fully delegated to `asset-viewer/AssetMaxPreview` —
 * that file is the single source of truth for mime-branched modal
 * previews (image, pdf, text, video, audio, …). Do not re-implement
 * <img>/<video>/<pre>/react-pdf branches here. This file owns dialog
 * chrome only: title, description, resize affordance, footer + Download.
 */

import { useCallback } from 'react';
import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { getWorkspaceToken } from '../lib/im-api';

import { formatBytes, type MessageAsset } from './message-asset-card';
import { AssetMaxPreview } from './asset-viewer/asset-max-preview';

export interface MessageAssetViewerModalProps {
  asset: MessageAsset | null;
  open: boolean;
  onClose: () => void;
  isDark?: boolean;
}

export function MessageAssetViewerModal({ asset, open, onClose, isDark = false }: MessageAssetViewerModalProps) {
  const title = asset?.filename ?? asset?.mime ?? 'preview';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        // Resizable preview pane — drag the bottom-right corner to expand.
        // `resize` requires `overflow:hidden` on the box; the inner body
        // wrapper owns its own scroll. Width/height start at sensible
        // defaults but bound by min/max so the modal can't escape the
        // viewport.
        className="flex !max-w-[95vw] resize flex-col gap-3 overflow-hidden w-[960px] min-w-[480px] max-h-[92vh] h-[78vh] min-h-[420px]"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>
            {asset
              ? [asset.mime ?? 'unknown mime', formatBytes(asset.sizeBytes ?? null)].filter(Boolean).join(' · ')
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          {asset ? <AssetMaxPreview asset={asset} isDark={isDark} /> : null}
        </div>
        <DialogFooter className="shrink-0 flex items-center justify-between gap-2 sm:justify-between">
          <div className="text-[11px] text-muted-foreground">
            {asset?.id ? `id: ${asset.id.slice(0, 16)}` : ''}
          </div>
          {asset ? <DownloadButton asset={asset} /> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DownloadButton({ asset }: { asset: MessageAsset }) {
  const onClick = useCallback(() => {
    if (asset.source === 'legacy-file-url' && asset.cdnUrl) {
      window.open(asset.cdnUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    void downloadAuthenticated(asset);
  }, [asset]);
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      <Download className="mr-1.5 h-3.5 w-3.5" />
      Download
    </Button>
  );
}

async function downloadAuthenticated(asset: MessageAsset): Promise<void> {
  const token = getWorkspaceToken();
  if (!token) return;
  try {
    const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = asset.filename ?? `asset-${asset.id}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('[MessageAssetViewerModal] download failed', err);
  }
}
