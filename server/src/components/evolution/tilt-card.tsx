'use client';

import { type ReactNode, type CSSProperties } from 'react';

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  glowColor?: string;
  maxTilt?: number;
  perspective?: number;
  scale?: number;
  onClick?: () => void;
}

/**
 * Hover card with pure-CSS scale + glow.
 * No onMouseMove / setState — zero interference with click events.
 */
export function TiltCard({
  children,
  className = '',
  style,
  glowColor = 'rgba(139,92,246,0.08)',
  scale = 1.015,
  onClick,
}: TiltCardProps) {
  return (
    <div
      className={`group relative transition-transform duration-200 ease-out ${className}`}
      style={{
        ...style,
        // @ts-expect-error CSS custom properties
        '--hover-scale': scale,
        '--glow-color': glowColor,
      }}
      onClick={onClick}
    >
      {/* Glow overlay — only visible on hover */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        style={{ background: `radial-gradient(ellipse at 50% 50%, ${glowColor}, transparent 70%)` }}
      />
      {/* Content — scale on hover via CSS, no JS re-renders */}
      <div className="relative transition-transform duration-200 ease-out group-hover:scale-[var(--hover-scale)]">
        {children}
      </div>
    </div>
  );
}
