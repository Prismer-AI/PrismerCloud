'use client';

/**
 * TracePath — release201/13 §3.7 (Metrics control-tower) + doc 20 §9.2 V3.
 *
 * Animates an SVG `<path>` "drawing" itself on mount via the
 * `animate-trace-draw` keyframe (globals.css §899-§923). Path length is
 * measured at render via `getTotalLength()` and written to the `--len`
 * CSS var so the keyframe can stroke-dash from full-length to 0.
 *
 * Reduced-motion fallback:
 *   `.animate-trace-draw` is overridden in globals.css §988-§992 to
 *   `animation: none; stroke-dashoffset: 0;` — i.e. the path renders
 *   fully drawn with no motion. No JS branch needed.
 *
 * Usage:
 *   <svg viewBox="0 0 100 24"><TracePath d="M0,12 L20,5 L50,18 L100,3" ... /></svg>
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

export interface TracePathProps {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  className?: string;
}

export function TracePath({ d, stroke = 'currentColor', strokeWidth = 1.5, fill = 'none', className }: TracePathProps) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const [len, setLen] = useState<number | null>(null);

  useEffect(() => {
    const node = pathRef.current;
    if (!node) return;
    try {
      const measured = node.getTotalLength();
      if (Number.isFinite(measured) && measured > 0) setLen(measured);
    } catch {
      // jsdom and older browsers may throw — fall through to the --len default.
    }
  }, [d]);

  const style: CSSProperties = len != null ? ({ ['--len' as string]: String(len) } as CSSProperties) : {};

  const cls = ['animate-trace-draw', className].filter(Boolean).join(' ');

  return (
    <path
      ref={pathRef}
      d={d}
      stroke={stroke}
      strokeWidth={strokeWidth}
      fill={fill}
      className={cls}
      style={style}
      data-testid="trace-path"
    />
  );
}
