'use client';

/**
 * Top tab nav shared across all /admin/* routes. Uses usePathname to mark
 * the active section. Each tab is a real Next.js <Link> so deep-links work
 * (back button, bookmarking, copy-paste URLs).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Tab {
  href: string;
  label: string;
  /** Pathname prefix match — `/admin/sandbox/[id]` should still highlight Sandbox. */
  matchPrefix: string;
  description?: string;
}

const TABS: Tab[] = [
  { href: '/admin', label: 'Overview', matchPrefix: '/admin' },
  { href: '/admin/sandbox', label: 'Sandbox Fleet', matchPrefix: '/admin/sandbox' },
  { href: '/admin/skills', label: 'Skills', matchPrefix: '/admin/skills' },
  { href: '/admin/analytics', label: 'Analytics', matchPrefix: '/admin/analytics' },
  { href: '/admin/credits', label: 'Credits', matchPrefix: '/admin/credits' },
  { href: '/admin/moderation', label: 'Moderation', matchPrefix: '/admin/moderation' },
];

export function AdminNav(): React.JSX.Element {
  const pathname = usePathname() ?? '/admin';

  // Pick the longest matching prefix so /admin/sandbox/abc highlights
  // 'Sandbox Fleet' rather than 'Overview'.
  const active =
    TABS.slice()
      .sort((a, b) => b.matchPrefix.length - a.matchPrefix.length)
      .find((t) => pathname === t.matchPrefix || pathname.startsWith(`${t.matchPrefix}/`))?.matchPrefix ??
    '/admin';

  return (
    <nav className="flex items-center gap-1 text-sm">
      {TABS.map((t) => {
        const isActive = t.matchPrefix === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              isActive
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
