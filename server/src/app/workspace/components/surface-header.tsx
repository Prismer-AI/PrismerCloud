'use client';

/**
 * Canonical workspace surface header.
 *
 * Single-row layout with three slots:
 *   [Title / Subtitle]  ←  [Status (read-only)]  →  [Actions (interactive)]
 *
 * - Title + Subtitle: identity, far left, fixed font/color across surfaces.
 * - Status: read-only badges, counts, progress — NEVER clickable. Hidden on
 *   < md breakpoints to keep narrow viewports clean.
 * - Actions: all interactive controls (buttons, toggles, dropdowns, inputs),
 *   pushed to the far right by `ml-auto` so the header stays balanced even
 *   when the status slot is empty.
 *
 * The legacy `children` prop is retained as an escape hatch for one-off
 * surfaces that genuinely need a second row, but standardized surfaces
 * (Task / Contacts / Assets / Devices) should not use it.
 */

import type { ReactNode } from 'react';

interface SurfaceHeaderProps {
  isDark: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Read-only status indicators (counts, badges, progress). Not clickable. */
  status?: ReactNode;
  /** Interactive controls — buttons, toggles, dropdowns, inputs. */
  actions?: ReactNode;
  /** @deprecated Standardized surfaces should not stack a second row. */
  children?: ReactNode;
  className?: string;
}

/**
 * release201 S12 — surface header is now per-surface only. The project
 * scope chip moved to the workspace TopBar (project switching is a
 * workspace-level concern, not a per-surface one), so there is no
 * `projectChip` slot here anymore.
 */
export function SurfaceHeader({
  isDark,
  title,
  subtitle,
  status,
  actions,
  children,
  className = '',
}: SurfaceHeaderProps) {
  return (
    <header
      className={`shrink-0 border-b px-5 py-4 ${isDark ? 'border-white/[0.05]' : 'border-zinc-200/70'} ${className}`}
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="min-w-0 shrink-0">
          <h2 className={`truncate text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>{title}</h2>
          {subtitle ? (
            <p className={`mt-0.5 truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{subtitle}</p>
          ) : null}
        </div>
        {status ? (
          <div className="hidden min-w-0 flex-1 items-center justify-center gap-2 md:flex">{status}</div>
        ) : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </header>
  );
}
