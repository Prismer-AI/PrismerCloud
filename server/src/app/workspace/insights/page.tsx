'use client';

/**
 * release201 S12 — /workspace/insights is now a compatibility redirect.
 *
 * Insights used to live in this standalone route (bootstrapped its own
 * workspace, owned its own header, etc.). Per the S12 unification:
 *   - Insights is now a peer surface inside `/workspace` (chats / insights /
 *     tasks / library / runtime).
 *   - ProjectSwitcher lives in the workspace TopBar, not a per-surface chip.
 *
 * This page is retained for one release cycle as a deep-link shim: any
 * existing `/workspace/insights?view=…&projectId=…&agentId=…&range=…` link
 * (shared chats, push notifications, bookmarks) lands here and is
 * `router.replace`'d to `/workspace?surface=insights&…`. The host page
 * parses those params on mount and pre-scopes the in-shell surface.
 *
 * Follow-up: delete this file once telemetry shows no traffic on the legacy
 * path (target: end of the v2.0.7 release cycle).
 */

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { useTheme } from '@/contexts/theme-context';
import { imFetch, getWorkspaceToken } from '../lib/im-api';

function InsightsLoader() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  return (
    <div
      className={`flex h-screen items-center justify-center ${
        isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Opening Insights…</span>
      </div>
    </div>
  );
}

/**
 * Inner component that actually reads `useSearchParams()`. Must live inside
 * a `<Suspense>` boundary so Next.js 15+ prerender doesn't bail out — the
 * App Router renders this boundary into a static shell at build time and
 * hydrates the client side once the browser knows the URL. Without the
 * boundary the `npm run build` step explicitly fails (release201 S13 P0-1).
 */
function RedirectInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    // release201 S18 (Post-merge ops) — telemetry: fire-and-forget metric so we
    // can observe legacy /workspace/insights deep-link traffic and know when
    // it's safe to delete this redirect shim (target: end of v2.0.7 cycle).
    // soft-fail: any auth / network error is silently swallowed; the redirect
    // is the user-facing contract.
    const view = params.get('view') ?? '';
    const projectId = params.get('projectId') ?? '';
    const agentId = params.get('agentId') ?? '';
    try {
      const token = getWorkspaceToken();
      if (token) {
        void imFetch('/metrics/emit', {
          method: 'POST',
          body: JSON.stringify({
            namespace: 'legacy_route_hits',
            name: 'workspace_insights',
            value: 1,
            dims: {
              ...(view ? { view } : {}),
              ...(projectId ? { projectId } : {}),
              ...(agentId ? { agentId } : {}),
              referrer: typeof document !== 'undefined' ? document.referrer.slice(0, 200) : '',
            },
          }),
        }).catch(() => {
          /* swallow; redirect is the contract, telemetry is best-effort */
        });
      }
    } catch {
      /* silent */
    }

    const sp = new URLSearchParams(params.toString());
    sp.set('surface', 'insights');
    router.replace(`/workspace?${sp.toString()}`);
  }, [params, router]);

  return <InsightsLoader />;
}

export default function WorkspaceInsightsRedirectPage() {
  return (
    <Suspense fallback={<InsightsLoader />}>
      <RedirectInner />
    </Suspense>
  );
}
