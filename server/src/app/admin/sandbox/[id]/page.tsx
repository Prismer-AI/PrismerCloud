/**
 * /admin/sandbox/[id] — single-container deep-dive page.
 *
 * Release 200 §08 §7.1 — minimal scope per S7 charter:
 *   1. Container metadata card
 *   2. Resource sample time-series chart (RTT + memory)
 *   3. Recent runs table
 *
 * Out of scope (§08 §3):
 *   - logs (use /admin/sandbox SSE if needed; not surfaced here)
 *   - runCmd / interactive shell
 *
 * RBAC:
 *   - Page-level: deny only an explicit non-admin NextAuth session. JWT-only
 *     browser sessions are checked by the client data routes because the
 *     server component cannot read localStorage tokens.
 *   - API-level: both /api/sandboxes/[id]/resources and
 *     /api/sandboxes/_admin/sandbox-metrics re-check admin status.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { AdminSandboxDetailClient } from './client';

export default async function AdminSandboxDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (session?.user?.email && !isSandboxAdmin(session.user.email)) {
    notFound();
  }

  const { id } = await params;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-start justify-between">
          <div>
            <Link href="/admin/sandbox" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
              ← back to SRE console
            </Link>
            <h1 className="text-2xl font-semibold mt-1">Sandbox Detail</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 font-mono">{id}</p>
          </div>
          <Link href="/admin/analytics" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            fleet overview →
          </Link>
        </header>
        <AdminSandboxDetailClient containerId={id} />
      </div>
    </div>
  );
}
