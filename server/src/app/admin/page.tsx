/**
 * /admin — unified admin console landing. Three section cards link to the
 * sub-tabs (Sandbox Fleet · Analytics · Moderation). RBAC mirrors the
 * sub-routes: non-admins see notFound (404) so the existence of admin is
 * not leaked to anonymous probes.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth/nextauth';
import { isSandboxAdmin } from '@/lib/admin-rbac';

export default async function AdminLanding() {
  const session = await auth();
  // Server session is optional — JWT-only browsers fall through and rely
  // on per-section RBAC. Block here only when a real session exists AND
  // the email isn't admin (anonymous probes hit each sub-page's notFound).
  if (session?.user?.email && !isSandboxAdmin(session.user.email)) {
    notFound();
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Admin Console</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Operational surface for platform staff. Pick a section above.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SectionCard
          href="/admin/sandbox"
          title="Sandbox Fleet"
          description="K8s pod inventory · drift detection · batch force-delete / stop / reconcile · orphan pod cleanup · cold-start SLO."
        />
        <SectionCard
          href="/admin/analytics"
          title="Analytics"
          description="Platform usage · credits · top users · token spend · sandbox observability widget."
        />
        <SectionCard
          href="/admin/credits"
          title="Credit Management"
          description="Look up a user by id · view balance + transactions · manually add / subtract credits (audited). Interim top-up lever paired with the proxy balance gate."
        />
        <SectionCard
          href="/admin/moderation"
          title="Moderation"
          description="Report queue · user ban/unban · content takedowns · violation history."
        />
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold mb-2">RBAC + access</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Admin access is gated by <code>isSandboxAdmin(email)</code> in <code>src/lib/admin-rbac.ts</code>. The
          allowlist is sourced from the <code>ADMIN_EMAILS</code> env var (Nacos namespace per environment) with a
          hardcoded fallback. Each sub-section + its API route does its own check; this landing only renders chrome.
        </p>
      </section>
    </div>
  );
}

function SectionCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-400 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
    >
      <h3 className="font-semibold text-base group-hover:text-zinc-900 dark:group-hover:text-zinc-100">
        {title} <span className="text-zinc-400">→</span>
      </h3>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">{description}</p>
    </Link>
  );
}
