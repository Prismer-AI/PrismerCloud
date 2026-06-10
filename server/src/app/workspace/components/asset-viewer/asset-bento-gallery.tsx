'use client';

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, ImageIcon, X, ZoomIn } from 'lucide-react';

import { getWorkspaceToken } from '../../lib/im-api';

export interface BentoGalleryCandidate {
  asset: {
    id: string;
    contentHash: string;
    mime?: string | null;
    sizeBytes?: number | null;
  };
  title: string;
  previewUrl: string;
  needsAuth: boolean;
}

export interface AssetBentoGalleryProps {
  candidates: BentoGalleryCandidate[];
  isDark: boolean;
  hasQuery?: boolean;
  emptyLabel?: string;
}

export function bentoSpanForIndex(index: number, hasQuery: boolean): string {
  if (!hasQuery && index === 0) return 'sm:col-span-2 sm:row-span-2';
  if (index > 0 && index % 7 === 3) return 'lg:col-span-2';
  if (index > 0 && index % 7 === 5) return 'lg:row-span-2';
  return '';
}

export function AssetBentoGallery({
  candidates,
  isDark,
  hasQuery = false,
  emptyLabel = 'No images match this search.',
}: AssetBentoGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  if (candidates.length === 0) {
    return (
      <div
        className={`flex h-full min-h-[180px] items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <>
      <DraggableGallery>
        <div
          className="grid auto-rows-[150px] grid-cols-2 gap-3 sm:auto-rows-[170px] lg:grid-cols-4"
          data-testid="asset-bento-gallery"
        >
          {candidates.map((candidate, index) => (
            <BentoGalleryTile
              key={candidate.asset.id}
              candidate={candidate}
              isDark={isDark}
              span={bentoSpanForIndex(index, hasQuery)}
              onOpen={() => setSelectedIndex(index)}
            />
          ))}
        </div>
      </DraggableGallery>
      <AnimatePresence>
        {selectedIndex != null && candidates[selectedIndex] ? (
          <BentoGalleryLightbox
            key={candidates[selectedIndex].asset.id}
            candidates={candidates}
            selectedIndex={selectedIndex}
            isDark={isDark}
            onClose={() => setSelectedIndex(null)}
            onSelect={setSelectedIndex}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

function DraggableGallery({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ dragging: false, startX: 0, scrollLeft: 0, moved: false });

  return (
    <div
      ref={containerRef}
      className="overflow-x-auto"
      onMouseDown={(event) => {
        const container = containerRef.current;
        if (!container) return;
        dragRef.current = {
          dragging: true,
          startX: event.pageX - container.offsetLeft,
          scrollLeft: container.scrollLeft,
          moved: false,
        };
      }}
      onMouseMove={(event) => {
        const container = containerRef.current;
        if (!container || !dragRef.current.dragging) return;
        const x = event.pageX - container.offsetLeft;
        const walk = (x - dragRef.current.startX) * 1.5;
        if (Math.abs(walk) > 4) dragRef.current.moved = true;
        container.scrollLeft = dragRef.current.scrollLeft - walk;
      }}
      onMouseUp={() => {
        dragRef.current.dragging = false;
      }}
      onMouseLeave={() => {
        dragRef.current.dragging = false;
      }}
      onClickCapture={(event) => {
        if (!dragRef.current.moved) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current.moved = false;
      }}
    >
      {children}
    </div>
  );
}

function BentoGalleryTile({
  candidate,
  isDark,
  span,
  onOpen,
}: {
  candidate: BentoGalleryCandidate;
  isDark: boolean;
  span: string;
  onOpen: () => void;
}) {
  const src = useResolvedImageUrl(candidate);
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      className={`group relative overflow-hidden rounded-lg border text-left ${span} ${
        isDark ? 'border-white/[0.08] bg-zinc-900' : 'border-zinc-200 bg-zinc-100'
      }`}
      whileHover={{ scale: 1.01 }}
      transition={{ duration: 0.18 }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- workspace asset previews may be private blob URLs or CDN URLs.
        <img
          src={src}
          alt={candidate.title}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          draggable={false}
          loading="lazy"
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <ImageIcon className={isDark ? 'h-6 w-6 text-zinc-600' : 'h-6 w-6 text-zinc-400'} />
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-80" />
      <div className="absolute inset-x-0 bottom-0 p-3">
        <p className="truncate text-xs font-semibold text-white">{candidate.title}</p>
        <p className="mt-0.5 truncate text-[11px] text-white/70">{formatBytes(candidate.asset.sizeBytes ?? null)}</p>
      </div>
      <div className="absolute right-3 top-3 rounded-full bg-black/45 p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <ZoomIn className="h-4 w-4 text-white" />
      </div>
    </motion.button>
  );
}

function BentoGalleryLightbox({
  candidates,
  selectedIndex,
  isDark,
  onClose,
  onSelect,
}: {
  candidates: BentoGalleryCandidate[];
  selectedIndex: number;
  isDark: boolean;
  onClose: () => void;
  onSelect: (index: number) => void;
}) {
  const selected = candidates[selectedIndex];
  const src = useResolvedImageUrl(selected);
  const canPrev = selectedIndex > 0;
  const canNext = selectedIndex < candidates.length - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && canPrev) onSelect(selectedIndex - 1);
      if (event.key === 'ArrowRight' && canNext) onSelect(selectedIndex + 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canNext, canPrev, onClose, onSelect, selectedIndex]);

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/92 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0 } }}
      onClick={onClose}
      data-testid="asset-image-gallery-lightbox"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        aria-label="Close gallery"
      >
        <X className="h-5 w-5" />
      </button>
      {canPrev ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(selectedIndex - 1);
          }}
          className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label="Previous image"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      ) : null}
      {canNext ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(selectedIndex + 1);
          }}
          className="absolute right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label="Next image"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      ) : null}
      <motion.div
        key={selected.asset.id}
        className="relative max-h-[86vh] max-w-[92vw]"
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0, transition: { duration: 0 } }}
        onClick={(event) => event.stopPropagation()}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- workspace asset previews may be private blob URLs or CDN URLs.
          <img
            src={src}
            alt={selected.title}
            className="max-h-[86vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
          />
        ) : (
          <div className="flex h-[60vh] w-[70vw] items-center justify-center rounded-lg bg-zinc-950">
            <ImageIcon className="h-8 w-8 text-zinc-600" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 rounded-b-lg bg-gradient-to-t from-black/80 to-transparent p-4">
          <p className="truncate text-sm font-semibold text-white">{selected.title}</p>
          <p className="mt-0.5 text-[11px] text-white/70">
            {selectedIndex + 1} / {candidates.length} · {formatBytes(selected.asset.sizeBytes ?? null)}
          </p>
        </div>
      </motion.div>
      <div
        className={`absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1 rounded-full px-2 py-1 ${isDark ? 'bg-white/10' : 'bg-black/35'}`}
      >
        {candidates.map((candidate, index) => (
          <button
            key={candidate.asset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(index);
            }}
            className={`h-2 rounded-full transition-all ${index === selectedIndex ? 'w-6 bg-white' : 'w-2 bg-white/45'}`}
            aria-label={`Open image ${index + 1}`}
          />
        ))}
      </div>
    </motion.div>
  );
}

function useResolvedImageUrl(candidate: BentoGalleryCandidate | undefined): string | null {
  const [objectUrlState, setObjectUrlState] = useState<{ sourceUrl: string; objectUrl: string } | null>(null);
  const url = candidate?.previewUrl ?? null;
  const needsAuth = candidate?.needsAuth ?? false;

  useEffect(() => {
    if (!url || !needsAuth) return;

    const token = getWorkspaceToken();
    if (!token) return;
    const controller = new AbortController();
    let createdUrl: string | null = null;

    void (async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!(blob.type || candidate?.asset.mime || '').startsWith('image/')) return;
        createdUrl = URL.createObjectURL(blob);
        if (!controller.signal.aborted) setObjectUrlState({ sourceUrl: url, objectUrl: createdUrl });
      } catch {
        /* Non-fatal: keep tile fallback. */
      }
    })();

    return () => {
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [candidate?.asset.contentHash, candidate?.asset.mime, needsAuth, url]);

  if (!url) return null;
  return needsAuth && objectUrlState?.sourceUrl === url ? objectUrlState.objectUrl : needsAuth ? null : url;
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
