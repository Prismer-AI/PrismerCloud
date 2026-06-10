'use client';

/**
 * SurfaceWithPreviewDock — hosts the active workspace surface plus an
 * optional asset preview, and decides how the preview sits relative to it:
 *
 *   layout='split'  the preview docks as an in-flow panel on the right; the
 *                   surface (chat / library / …) shrinks via flex but stays
 *                   fully interactive — no overlay, no backdrop.
 *   layout='full'   the preview overlays the whole content area
 *                   (absolute inset-0), the surface sits underneath.
 *
 * It also measures its own width and reports whether there's room to split,
 * so the page can default narrow viewports straight to full screen. The
 * preview node is mode-aware (it switches its own root between in-flow and
 * absolute via its `layout` prop), so we just place it in the right slot.
 */

import { motion } from 'framer-motion';
import { useEffect, useRef, type ReactNode } from 'react';

import { springHeavy } from '../lib/design';

/** Below this content width there isn't enough room for a useful split. */
export const SPLIT_MIN_WIDTH = 900;

export function SurfaceWithPreviewDock({
  layout,
  preview,
  onMeasureWide,
  children,
}: {
  layout: 'split' | 'full';
  preview: ReactNode | null;
  onMeasureWide: (wide: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasureWide(el.clientWidth >= SPLIT_MIN_WIDTH);
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasureWide]);

  return (
    <div ref={ref} className="relative flex min-w-0 flex-1 gap-2 overflow-hidden">
      <div className="flex min-w-0 flex-1 overflow-hidden">{children}</div>
      {preview && layout === 'split' ? (
        <motion.aside
          data-testid="asset-preview-dock"
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={springHeavy}
          className="relative flex min-h-0 shrink-0 overflow-hidden"
          style={{ width: 'clamp(420px, 46%, 760px)' }}
        >
          {preview}
        </motion.aside>
      ) : null}
      {preview && layout === 'full' ? preview : null}
    </div>
  );
}
