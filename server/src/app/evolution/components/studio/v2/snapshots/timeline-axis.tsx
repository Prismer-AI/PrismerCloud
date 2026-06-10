'use client';

/**
 * Snapshots — horizontal time axis with a draggable scrubber (release201/28 §4.5).
 *
 * Restore points are dots laid out evenly along an SVG axis (mirrors the Genes
 * sparkline SVG approach). A scrubber handle drags along the axis (springDrag
 * follow) and snaps to the nearest point on release (springSnap). Keyboard:
 * ← / → step between points (DnD keyboard补送, 12 §8.8.6.4).
 *
 * Sky accent (vault grammar). All copy is passed in by the caller — this
 * component renders dates/labels it receives, no bare UI strings.
 */

import { useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { grammarAccentClasses, s, springDrag, springSnap } from '@/app/workspace/lib/design';
import { cn } from '@/lib/utils';

const ACCENT = grammarAccentClasses.sky;

interface TimelineAxisProps {
  isDark: boolean;
  labels: string[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export function TimelineAxis({ isDark, labels, selectedIndex, onSelect }: TimelineAxisProps) {
  const reduce = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const count = labels.length;
  const theme = isDark ? 'dark' : 'light';

  // Fractional position 0..1 of each dot (centred between padding).
  const posOf = (i: number) => (count <= 1 ? 0.5 : i / (count - 1));

  const handleDragEnd = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const nearest = Math.round(frac * (count - 1));
    onSelect(Math.min(count - 1, Math.max(0, nearest)));
  };

  return (
    <div className="px-2 pt-2 pb-1">
      <div ref={trackRef} className="relative h-12">
        {/* Axis line — neutral hairline from the inset surface border token */}
        <div className={cn('absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 border-t', s(theme, 'inset'))} />

        {/* Dots */}
        {labels.map((label, i) => {
          const selected = i === selectedIndex;
          return (
            <button
              key={label + i}
              type="button"
              onClick={() => onSelect(i)}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer p-2"
              style={{ left: `${posOf(i) * 100}%` }}
              aria-label={label}
              aria-current={selected}
            >
              <motion.span
                className={cn(
                  'block rounded-full border',
                  selected ? cn(ACCENT.dot, 'border-transparent') : s(theme, 'inset'),
                )}
                animate={reduce ? undefined : { scale: selected ? 1.25 : 1 }}
                transition={springSnap}
                style={{ width: 12, height: 12 }}
              />
            </button>
          );
        })}

        {/* Scrubber handle (draggable along the axis) */}
        <motion.div
          className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none active:cursor-grabbing"
          style={{ left: `${posOf(selectedIndex) * 100}%` }}
          drag={reduce ? false : 'x'}
          dragConstraints={trackRef}
          dragElastic={0}
          dragMomentum={false}
          onDragEnd={(_e, info) => handleDragEnd(info.point.x)}
          whileDrag={{ scale: 1.15 }}
          transition={springDrag}
          tabIndex={0}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={count - 1}
          aria-valuenow={selectedIndex}
          aria-label={labels[selectedIndex]}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onSelect(Math.max(0, selectedIndex - 1));
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              onSelect(Math.min(count - 1, selectedIndex + 1));
            }
          }}
        >
          <span
            className={cn('block size-5 rounded-full ring-4', ACCENT.dot)}
            style={{ boxShadow: `0 0 16px 2px ${ACCENT.glow}` }}
          />
        </motion.div>
      </div>

      {/* Date labels under each dot */}
      <div className="relative mt-1 h-4">
        {labels.map((label, i) => (
          <span
            key={label + i}
            className={cn('absolute -translate-x-1/2 text-[10px] tabular-nums', i === selectedIndex ? ACCENT.text : isDark ? 'text-zinc-500' : 'text-zinc-400')}
            style={{ left: `${posOf(i) * 100}%` }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
