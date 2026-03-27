'use client';

import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';

interface SiriOrbProps {
  size?: string;
  className?: string;
  colors?: {
    bg?: string;
    c1?: string;
    c2?: string;
    c3?: string;
  };
  animationDuration?: number;
}

export function SiriOrb({
  size = '192px',
  className,
  colors,
  animationDuration = 20,
}: SiriOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Use Prismer brand colors - purple/violet/cyan palette
  const defaultColors = {
    bg: 'transparent',
    c1: '#8b5cf6', // Violet
    c2: '#06b6d4', // Cyan
    c3: '#a855f7', // Purple
  };

  const finalColors = { ...defaultColors, ...colors };
  
  // Convert oklch to hex if needed (simplified - just use the defaults for now)
  const getColor = (color: string): string => {
    if (color.startsWith('oklch')) {
      // Map oklch colors to hex approximations
      if (color.includes('280')) return '#8b5cf6'; // Violet
      if (color.includes('200')) return '#06b6d4'; // Cyan
      if (color.includes('300')) return '#a855f7'; // Purple
      return '#8b5cf6';
    }
    return color;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sizeNum = parseInt(size.replace('px', ''), 10);
    canvas.width = sizeNum * 2; // For retina
    canvas.height = sizeNum * 2;
    canvas.style.width = size;
    canvas.style.height = size;
    
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = canvas.width / 2;
    
    let angle = 0;
    let animationId: number;
    
    const c1 = getColor(finalColors.c1 || defaultColors.c1);
    const c2 = getColor(finalColors.c2 || defaultColors.c2);
    const c3 = getColor(finalColors.c3 || defaultColors.c3);

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Create circular clip
      ctx.save();
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.clip();
      
      // Draw background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Draw multiple rotating gradients
      const gradients = [
        { color: c1, offset: 0, speed: 1.2, x: 0.3, y: 0.65 },
        { color: c2, offset: Math.PI / 3, speed: 0.8, x: 0.7, y: 0.35 },
        { color: c3, offset: Math.PI * 2 / 3, speed: -1.5, x: 0.65, y: 0.75 },
        { color: c2, offset: Math.PI, speed: 2.1, x: 0.25, y: 0.25 },
        { color: c1, offset: Math.PI * 4 / 3, speed: -0.7, x: 0.8, y: 0.8 },
      ];
      
      gradients.forEach(({ color, offset, speed, x, y }) => {
        const currentAngle = angle * speed + offset;
        const gx = centerX + Math.cos(currentAngle) * radius * 0.3 * x;
        const gy = centerY + Math.sin(currentAngle) * radius * 0.3 * y;
        
        const gradient = ctx.createRadialGradient(
          gx, gy, 0,
          gx, gy, radius * 0.8
        );
        gradient.addColorStop(0, color + 'cc');
        gradient.addColorStop(0.5, color + '44');
        gradient.addColorStop(1, 'transparent');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      });
      
      // Add center glow
      const centerGlow = ctx.createRadialGradient(
        centerX, centerY, 0,
        centerX, centerY, radius * 0.6
      );
      centerGlow.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
      centerGlow.addColorStop(0.3, 'rgba(255, 255, 255, 0.05)');
      centerGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = centerGlow;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Apply blur effect by drawing multiple times with offset
      ctx.restore();
      
      angle += (Math.PI * 2) / (animationDuration * 60);
      animationId = requestAnimationFrame(draw);
    };
    
    draw();
    
    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [size, finalColors, animationDuration]);

  return (
    <canvas
      ref={canvasRef}
      className={cn('rounded-full', className)}
      style={{
        width: size,
        height: size,
      }}
    />
  );
}
