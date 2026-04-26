'use client';

import { useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { spring } from './shared';

interface PersonalitySliderProps {
  label: string;
  value: number; // 0-100
  onChange?: (value: number) => void;
  isDark: boolean;
}

export function PersonalitySlider({ label, value, onChange, isDark }: PersonalitySliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localValue, setLocalValue] = useState(value);

  const displayValue = dragging ? localValue : value;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const track = trackRef.current;
      if (!track) return;

      const updateValue = (clientX: number) => {
        const rect = track.getBoundingClientRect();
        const pct = Math.round(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
        setLocalValue(pct);
      };

      updateValue(e.clientX);

      const onMove = (ev: PointerEvent) => updateValue(ev.clientX);
      const onUp = (ev: PointerEvent) => {
        updateValue(ev.clientX);
        const rect = track.getBoundingClientRect();
        const pct = Math.round(Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100)));
        onChange?.(pct);
        setDragging(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onChange],
  );

  return (
    <div className="flex items-center gap-4">
      <span className={`text-xs font-medium w-28 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{label}</span>

      {/* Track */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        className={`flex-1 h-2 rounded-full cursor-pointer relative ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-100'}`}
      >
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-400"
          animate={{ width: `${displayValue}%` }}
          transition={dragging ? { duration: 0 } : spring}
        />
        <motion.div
          className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 shadow-sm ${
            isDark ? 'bg-zinc-900 border-violet-400' : 'bg-white border-violet-500'
          } ${dragging ? 'scale-125' : ''}`}
          animate={{ left: `calc(${displayValue}% - 8px)` }}
          transition={dragging ? { duration: 0 } : spring}
          style={{ transition: dragging ? 'transform 0.1s' : undefined }}
        />
      </div>

      {/* Value */}
      <span className={`text-sm font-bold tabular-nums w-10 text-right ${isDark ? 'text-white' : 'text-zinc-900'}`}>
        {displayValue}%
      </span>
    </div>
  );
}
