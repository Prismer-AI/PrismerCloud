/**
 * Admin shell layout — unified top nav across all admin sub-routes so the
 * pre-fix split (`/admin/sandbox` vs `/admin/analytics` vs `/admin/moderation`
 * each feeling like a separate app) is consolidated into one console. URLs
 * stay sub-routed for deep-linking (back button, bookmark, paste-in-Slack);
 * the layout-level nav makes them visually + cognitively one place.
 *
 * RBAC: this layout intentionally does NOT gate — each sub-route runs its
 * own `isSandboxAdmin` (notFound) / API-level check. Layout is just chrome.
 */

import Link from 'next/link';
import { AdminNav } from './admin-nav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
          <Link href="/admin" className="font-semibold text-sm tracking-tight">
            Prismer · Admin Console
          </Link>
          <AdminNav />
          <span className="grow" />
          <Link
            href="/workspace"
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            ← Back to workspace
          </Link>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
