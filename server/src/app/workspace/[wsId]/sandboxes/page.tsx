/**
 * /workspace/[wsId]/sandboxes — user-facing sandbox console.
 *
 * Phase 1 internal MVP: list workspace containers, create new ones, control
 * (start/stop/snapshot/delete), 5s polling refresh. Server Component shell
 * does the initial fetch + workspace existence check; the Client Component
 * handles refresh + actions.
 *
 * Ownership is enforced by the underlying /api/sandboxes/* routes
 * (see src/app/api/sandboxes/_helpers.ts → authorizeWorkspace). This page
 * uses notFound() if the workspace row is missing/soft-deleted, but does
 * NOT do its own RBAC — non-owners will see the page and get 403s on every
 * action. That's acceptable for Phase 1; the API surface is the source of
 * truth for access control.
 */

import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { SandboxesClient } from './sandboxes-client';

export default async function SandboxesPage({ params }: { params: Promise<{ wsId: string }> }) {
  const { wsId } = await params;

  // findFirst (not findUnique) because we filter on deletedAt — IMWorkspace's
  // unique key is (ownerImUserId, slug, deletedAt), not id alone for that purpose.
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: wsId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!ws) notFound();

  interface ContainerSelect {
    id: string;
    podName: string;
    status: string;
    image: string;
    startedAt: Date | null;
  }

  const initialContainers = (await prisma.iMContainer.findMany({
    where: { workspaceId: wsId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      podName: true,
      status: true,
      image: true,
      startedAt: true,
    },
  })) as ContainerSelect[];

  // Serialize Date for the Client Component prop boundary (Server → Client
  // can't transfer Date directly without Next.js handing it as `unknown`).
  const serialized = initialContainers.map((c: ContainerSelect) => ({
    id: c.id,
    podName: c.podName,
    status: c.status,
    image: c.image,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
  }));

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">{ws.name} — Sandboxes</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Cloud 3 / S2 — Phase 1 internal MVP. List + control + snapshot.
          </p>
        </header>
        <SandboxesClient workspaceId={wsId} initialContainers={serialized} />
      </div>
    </div>
  );
}
