'use client';

/**
 * AvatarCropper — zero-dependency square avatar crop editor.
 *
 * Loads a picked image into a square viewport, lets the user zoom (slider /
 * wheel) and pan (drag), then renders the visible square to a 256×256 canvas
 * and hands back a JPEG `Blob`. Used by the Settings 个人资料 upload flow so the
 * user crops before the asset is uploaded (avoids storing oversized / off-center
 * images). Self-contained on purpose — no react-easy-crop dependency.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

const VIEWPORT = 280; // on-screen square (CSS px)
const OUTPUT = 256; // exported avatar dimension (px)

export function AvatarCropper({
  file,
  isDark,
  busy = false,
  onConfirm,
  onCancel,
}: {
  file: File;
  isDark: boolean;
  busy?: boolean;
  /** Receives the cropped 256×256 JPEG blob. */
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = cover the viewport
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // pan, in viewport px
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Load the picked file into an object URL + read natural size.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // base scale: COVER the viewport (the smaller dimension fills it).
  const baseScale = nat ? Math.max(VIEWPORT / nat.w, VIEWPORT / nat.h) : 1;
  const scale = baseScale * zoom;
  const drawW = nat ? nat.w * scale : 0;
  const drawH = nat ? nat.h * scale : 0;

  // Clamp pan so the image always covers the viewport (no empty edges).
  const clamp = useCallback(
    (x: number, y: number) => {
      const minX = VIEWPORT - drawW;
      const minY = VIEWPORT - drawH;
      return {
        x: Math.min(0, Math.max(minX, x)),
        y: Math.min(0, Math.max(minY, y)),
      };
    },
    [drawW, drawH],
  );

  // Re-center on load / zoom change.
  useEffect(() => {
    if (!nat) return;
    setOffset((o) => clamp((VIEWPORT - drawW) / 2 || o.x, (VIEWPORT - drawH) / 2 || o.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat, zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clamp(d.ox + (e.clientX - d.x), d.oy + (e.clientY - d.y)));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const confirm = useCallback(() => {
    const img = imgRef.current;
    if (!img || !nat) return;
    // Map the viewport square back to source-image pixels.
    const sx = -offset.x / scale;
    const sy = -offset.y / scale;
    const sSize = VIEWPORT / scale;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
    canvas.toBlob(
      (blob) => {
        if (blob) onConfirm(blob);
      },
      'image/jpeg',
      0.9,
    );
  }, [nat, offset, scale, onConfirm]);

  const surface = isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200';
  const muted = isDark ? 'text-zinc-400' : 'text-zinc-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className={`w-full max-w-sm rounded-2xl border p-5 shadow-xl ${surface}`}>
        <p className={`mb-3 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>裁切头像</p>

        <div
          className="relative mx-auto overflow-hidden rounded-full border touch-none select-none"
          style={{ width: VIEWPORT, height: VIEWPORT, borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={{
                position: 'absolute',
                left: offset.x,
                top: offset.y,
                width: drawW || undefined,
                height: drawH || undefined,
                maxWidth: 'none',
                cursor: 'grab',
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className={`text-[11px] ${muted}`}>缩放</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer accent-violet-500"
            aria-label="缩放"
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button size="sm" onClick={confirm} disabled={busy || !nat}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            使用
          </Button>
        </div>
      </div>
    </div>
  );
}
