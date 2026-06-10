'use client';

/**
 * Workspace Settings — release 200 P4.
 *
 * Minimal first-pass settings page. v1 surfaces only the Chief of Staff
 * (orchestrator) controls; other workspace settings (rename, archive, etc.)
 * remain on their existing entry points and will be migrated here in a
 * follow-up.
 *
 * Route: /workspace/[wsId]/settings
 * Access: any authenticated user. Owner-only actions are gated client-side
 * by the resolved ownerImUserId echoed back from the GET endpoint, and
 * re-enforced server-side.
 */

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertTriangle } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useI18n } from '@/contexts/i18n-context';
import { imFetch } from '../../lib/im-api';
import { ChiefOfStaffSection } from '../../components/chief-of-staff-section';
import { ClearWorkspaceDialog } from './clear-workspace-dialog';
import { MembersSection } from './members-section';

interface WorkspaceSnapshot {
  id: string;
  name: string;
  ownerImUserId: string;
}

interface OrchestratorEnvelope {
  workspace: WorkspaceSnapshot;
  orchestrator: unknown;
}

interface MeResponse {
  user: { id: string };
}

export default function WorkspaceSettingsPage({ params }: { params: Promise<{ wsId: string }> }) {
  const { wsId } = use(params);
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const isDark = theme === 'dark';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [meImUserId, setMeImUserId] = useState<string | null>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // The orchestrator GET endpoint conveniently echoes back the workspace
      // record (id, name, ownerImUserId) which is all the settings page
      // needs to render. Avoids an extra round-trip to /workspaces/:id.
      const [orchRes, meRes] = await Promise.all([
        imFetch<OrchestratorEnvelope>(`/workspaces/${encodeURIComponent(wsId)}/orchestrator`),
        imFetch<MeResponse>('/me'),
      ]);
      if (cancelled) return;
      if (!orchRes.ok) {
        setError(orchRes.message);
        setLoading(false);
        return;
      }
      setWorkspace(orchRes.data.workspace);
      if (meRes.ok) {
        setMeImUserId(meRes.data?.user?.id ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  const bg = isDark ? 'bg-zinc-950' : 'bg-zinc-50';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const isOwner = !!workspace && !!meImUserId && workspace.ownerImUserId === meImUserId;

  return (
    <main className={`min-h-screen ${bg}`}>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <button
          type="button"
          onClick={() => router.push('/workspace')}
          className={`mb-4 inline-flex items-center gap-1 text-sm ${textMuted} hover:underline`}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('wsSettings.backToWorkspace')}
        </button>

        <header className="mb-6">
          <h1 className={`text-xl font-semibold ${textPrimary}`}>{t('wsSettings.title')}</h1>
          {workspace ? (
            <p className={`mt-1 text-sm ${textMuted}`}>
              {workspace.name} <span className="opacity-60">·</span>{' '}
              {isOwner ? t('wsSettings.youAreOwner') : t('wsSettings.readOnly')}
            </p>
          ) : null}
        </header>

        {loading ? (
          <div className={`flex items-center gap-2 text-sm ${textMuted}`}>
            <Loader2 className="h-4 w-4 animate-spin" /> {t('wsSettings.loading')}
          </div>
        ) : error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>
        ) : workspace ? (
          <div className="flex flex-col gap-6">
            <ChiefOfStaffSection workspaceId={workspace.id} isOwner={isOwner} isDark={isDark} />

            <MembersSection workspaceId={workspace.id} isOwner={isOwner} meImUserId={meImUserId} isDark={isDark} />

            {isOwner && (
              <section className={`rounded-lg border border-red-500/30 p-4 ${isDark ? 'bg-red-500/5' : 'bg-red-50'}`}>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h2 className={`text-sm font-semibold ${textPrimary}`}>{t('wsSettings.dangerZone')}</h2>
                    <p className={`mt-1 text-xs ${textMuted}`}>
                      {t('wsSettings.dangerZoneDesc')}
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowClearDialog(true)}
                      className="mt-3 inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                    >
                      {t('wsSettings.clearWorkspace')}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>
        ) : null}
      </div>

      {showClearDialog && workspace && (
        <ClearWorkspaceDialog
          workspaceId={workspace.id}
          isDark={isDark}
          onClose={() => setShowClearDialog(false)}
          onDone={() => {
            setShowClearDialog(false);
            router.push('/workspace');
          }}
        />
      )}
    </main>
  );
}
