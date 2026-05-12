'use client';

import type { ReactNode } from 'react';

interface SurfaceHeaderProps {
  isDark: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function SurfaceHeader({ isDark, title, subtitle, actions, children, className = '' }: SurfaceHeaderProps) {
  return (
    <header
      className={`shrink-0 border-b px-5 py-4 ${isDark ? 'border-white/[0.05]' : 'border-zinc-200/70'} ${className}`}
    >
      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <h2 className={`truncate text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>{title}</h2>
          {subtitle ? (
            <p className={`mt-0.5 truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">{actions}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </header>
  );
}
