'use client';

import { useCallback } from 'react';
import { Archive, Download, FileText } from 'lucide-react';

import { getWorkspaceToken } from '../../lib/im-api';
import type { ContentBlockFile } from './types';

/**
 * Generic file ContentBlock (`kind='file'`) — icon + filename + size?
 * Click triggers an auth-fetched download via blob URL (the asset bytes
 * endpoint is Bearer-token-gated, so a plain `<a href>` would not work).
 *
 * PDFs get the `FileText` glyph; everything else gets `Archive`.
 */
function isPdf(mediaType: string | undefined): boolean {
  if (!mediaType) return false;
  const m = mediaType.toLowerCase();
  return m === 'application/pdf' || m.endsWith('/pdf');
}

export function FileCard({
  block,
  isOwn = false,
  isDark = false,
}: {
  block: ContentBlockFile;
  isOwn?: boolean;
  isDark?: boolean;
}) {
  const Icon = isPdf(block.mediaType) ? FileText : Archive;
  const subline = `${block.mediaType || 'unknown mime'}`;

  const onDownload = useCallback(async () => {
    const token = getWorkspaceToken();
    if (!token) {
      window.alert('No auth token; please sign in again.');
      return;
    }
    try {
      const res = await fetch(`/api/im/assets/${encodeURIComponent(block.assetId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = block.filename || `download-${block.assetId}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 1_500);
    } catch (err) {
      window.alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [block.assetId, block.filename]);

  return (
    <button
      type="button"
      onClick={onDownload}
      title={block.filename}
      data-testid="content-block-file"
      data-content-kind="file"
      data-asset-id={block.assetId}
      className={`flex w-full max-w-[360px] items-center gap-2 rounded-2xl border px-3 py-2 text-left transition ${
        isOwn
          ? 'border-white/20 bg-white/15 hover:bg-white/20'
          : isDark
            ? 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.07]'
            : 'border-zinc-200 bg-zinc-50 hover:bg-zinc-100'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          isOwn
            ? 'bg-white/15 text-white'
            : isDark
              ? 'bg-violet-500/15 text-violet-200'
              : 'bg-violet-100 text-violet-700'
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] font-semibold ${
            isOwn ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
          }`}
        >
          {block.filename || `[file ${block.assetId.slice(0, 8)}]`}
        </span>
        <span
          className={`block truncate text-[10px] ${
            isOwn ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          {subline}
        </span>
      </span>
      <Download
        className={`h-3.5 w-3.5 shrink-0 ${
          isOwn ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
        }`}
      />
    </button>
  );
}
