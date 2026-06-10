/**
 * /admin/sandbox — daemon-first cold-start metrics console.
 *
 * RBAC gate: NextAuth session ➜ email ➜ isSandboxAdmin allowlist when a
 * server session exists. JWT-only browser sessions are checked by the client
 * data route because the server component cannot read localStorage tokens.
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
import { FleetTable } from './fleet-table';
import { OrphanVacuumSection } from './orphan-vacuum-section';

export default async function AdminSandboxPage() {
  const session = await auth();
  if (session?.user?.email && !isSandboxAdmin(session.user.email)) {
    notFound();
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Sandbox Fleet</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Daemon-first cold-start metrics + cross-workspace fleet management.
        </p>
      </header>
      <AdminSandboxClient />
      <section className="space-y-2 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <header>
          <h2 className="text-xl font-semibold">Fleet management</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Cross-workspace inventory with K8s live state · drift detection · batch force-delete / stop / reconcile · orphan pod cleanup.
          </p>
        </header>
        <FleetTable />
      </section>

      <section className="space-y-2 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <OrphanVacuumSection />
      </section>
    </div>
  );
}
