/**
 * /admin/sandbox — daemon-first cold-start metrics console.
 *
 * RBAC gate: NextAuth session ➜ email ➜ isSandboxAdmin allowlist.
 * Returns notFound() (404) for non-admins, deliberately not 403, so the
 * existence of the admin endpoint is not leaked to unauthenticated probes.
 *
 * The actual data (container status, run logs, cold-start latency) is
 * fetched client-side from /api/sandboxes/_admin/sandbox-metrics, which
 * does its own RBAC check — both gates exist so the page is safe even if
 * the route handler is bypassed.
 *
 * History: pre-W2 this page polled the now-deleted warm-pool route and
 * rendered warm pool stats. Warm pool was removed in W1-W8 (commits
 * `43956559..c10ea7cb`) because daemon-first runtime starts in seconds;
 * cold-start is now the only scheduling path so the dashboard pivoted to
 * cold-start latency + run-log activity.
 */

import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { AdminSandboxClient } from './admin-sandbox-client';

export default async function AdminSandboxPage() {
  const session = await auth();
  if (!isSandboxAdmin(session?.user?.email)) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Sandbox SRE Console</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Daemon-first cold-start metrics — containers, runs, and latency.
          </p>
        </header>
        <AdminSandboxClient />
      </div>
    </div>
  );
}
