'use client';

import { ReactNode } from 'react';

interface GradientCardProps {
  children: ReactNode;
  gradientFrom: string;
  gradientTo: string;
  className?: string;
  disabled?: boolean;
  isDark?: boolean;
}

export function GradientCard({ 
  children, 
  gradientFrom, 
  gradientTo, 
  className = '',
  disabled = false,
  isDark = true 
}: GradientCardProps) {
  return (
    <div className={`group relative ${className}`}>
      {/* Skewed gradient panels */}
      <span
        className={`absolute top-0 left-[20px] w-[50%] h-full rounded-2xl sm:rounded-3xl transform skew-x-[10deg] transition-all duration-500 ease-out group-hover:skew-x-0 group-hover:left-[8px] group-hover:w-[calc(100%-32px)] ${
          disabled ? 'opacity-30 group-hover:opacity-40' : 'opacity-60 group-hover:opacity-80'
        }`}
        style={{ background: `linear-gradient(135deg, ${gradientFrom}, ${gradientTo})` }}
      />
      <span
        className={`absolute top-0 left-[20px] w-[50%] h-full rounded-2xl sm:rounded-3xl transform skew-x-[10deg] blur-[30px] transition-all duration-500 ease-out group-hover:skew-x-0 group-hover:left-[8px] group-hover:w-[calc(100%-32px)] ${
          disabled ? 'opacity-15 group-hover:opacity-20' : 'opacity-25 group-hover:opacity-40'
        }`}
        style={{ background: `linear-gradient(135deg, ${gradientFrom}, ${gradientTo})` }}
      />
      
      {/* Animated corner blurs */}
      <span className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl sm:rounded-3xl">
        <span className="absolute -top-6 -left-6 w-0 h-0 rounded-full opacity-0 bg-violet-500/20 backdrop-blur-md transition-all duration-500 group-hover:w-16 group-hover:h-16 group-hover:opacity-100" />
        <span className="absolute -bottom-6 -right-6 w-0 h-0 rounded-full opacity-0 bg-cyan-500/20 backdrop-blur-md transition-all duration-700 delay-100 group-hover:w-20 group-hover:h-20 group-hover:opacity-100" />
      </span>

      {/* Content */}
      {children}
    </div>
  );
}




