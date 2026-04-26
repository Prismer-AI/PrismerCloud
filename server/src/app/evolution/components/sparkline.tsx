'use client';

import { useId } from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Force stroke color override */
  strokeOverride?: string;
}

export function Sparkline({ data, width = 100, height = 32, className = '', strokeOverride }: SparklineProps) {
  const id = useId();
  if (data.length < 2) return <div style={{ width, height }} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const padding = 2;

  const points = data.map((v, i) => ({
    x: padding + (i / (data.length - 1)) * (width - padding * 2),
    y: padding + (1 - (v - min) / range) * (height - padding * 2),
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;

  // Trend detection: compare last value to first
  const last = data[data.length - 1];
  const first = data[0];
  const delta = last - first;
  const isUp = delta > 0;
  const isFlat = Math.abs(delta) / range < 0.1;

  // Stroke: up=emerald, flat=zinc, down=red
  const strokeColor = strokeOverride ? strokeOverride : isFlat ? '#a1a1aa' : isUp ? '#34d399' : '#f87171';

  // Gradient fill always uses emerald tones
  const gradientFrom = '#10b981'; // emerald-500
  const gradientTo = '#10b981';
  const gradId = `spark-fill-${id.replace(/:/g, '')}`;

  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={gradientFrom} stopOpacity={0.25} />
          <stop offset="60%" stopColor={gradientTo} stopOpacity={0.08} />
          <stop offset="100%" stopColor={gradientTo} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* End dot */}
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2} fill={strokeColor} />
    </svg>
  );
}
