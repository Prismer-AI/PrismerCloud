'use client';

/**
 * ClearWorkspaceDialog — hard-delete a workspace with full child cascade.
 *
 * Three phases inside the modal:
 *   1. Preview — fetch GET /workspaces/:id/clear-preflight and show counts
 *      of agents, conversations, messages, tasks, sandboxes, etc., so the
 *      user sees the actual blast radius.
 *   2. Confirm — user types workspace name to enable the destructive button.
 *   3. Execute — DELETE /workspaces/:id?confirmName=... opens an SSE stream
 *      of ClearProgressEvent rows; UI renders them as a checklist with each
 *      step turning green on completion or red on failure.
 *
 * On success, navigate to /workspace (which auto-creates a new Personal ws
 * via /api/im/me bootstrap if the deleted one was the user's only/default).
 *
 * Uses fetch + ReadableStream to consume SSE rather than EventSource — the
 * latter doesn't support custom Authorization headers needed by IM auth.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { imFetch, getWorkspaceToken } from '@/app/workspace/lib/im-api';
import { useI18n } from '@/contexts/i18n-context';
import type { TranslationKey } from '@/lib/i18n';

interface PreviewCounts {
  agents: number;
  conversations: number;
  messages: number;
  tasks: number;
  taskRuns: number;
  containers: number;
  runningContainers: number;
  assets: number;
  memoryFiles: number;
  workspaceFiles: number;
  channels: number;
  members: number;
}

interface PreviewResponse {
  workspaceId: string;
  name: string;
  ownerImUserId: string;
  counts: PreviewCounts;
}

type StepStatus = 'pending' | 'in_progress' | 'completed' | 'error';

interface StepRecord {
  step: string;
  labelKey: TranslationKey;
  status: StepStatus;
  count?: number;
  error?: string;
}

const STEP_ORDER: { key: string; labelKey: TranslationKey }[] = [
  { key: 'authorize', labelKey: 'wsSettings.clear.step.authorize' },
  { key: 'collect-ids', labelKey: 'wsSettings.clear.step.collectIds' },
  { key: 'k8s-pods-teardown', labelKey: 'wsSettings.clear.step.k8sPods' },
  { key: 'messaging', labelKey: 'wsSettings.clear.step.messaging' },
  { key: 'tasks', labelKey: 'wsSettings.clear.step.tasks' },
  { key: 'containers', labelKey: 'wsSettings.clear.step.containers' },
  { key: 'assets', labelKey: 'wsSettings.clear.step.assets' },
  { key: 'agents', labelKey: 'wsSettings.clear.step.agents' },
  { key: 'memory-knowledge', labelKey: 'wsSettings.clear.step.memoryKnowledge' },
  { key: 'evolution-graph', labelKey: 'wsSettings.clear.step.evolutionGraph' },
  { key: 'community-files-channels', labelKey: 'wsSettings.clear.step.communityFilesChannels' },
  { key: 'misc-tables', labelKey: 'wsSettings.clear.step.miscTables' },
  { key: 'agent-imusers', labelKey: 'wsSettings.clear.step.agentImusers' },
  { key: 'workspace-row', labelKey: 'wsSettings.clear.step.workspaceRow' },
];

export function ClearWorkspaceDialog({
  workspaceId,
  onClose,
  onDone,
  isDark,
}: {
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
  isDark: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [phase, setPhase] = useState<'preview' | 'running' | 'done' | 'failed'>('preview');
  const [steps, setSteps] = useState<StepRecord[]>(
    STEP_ORDER.map((s) => ({ step: s.key, labelKey: s.labelKey, status: 'pending' })),
  );
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await imFetch<PreviewResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/clear-preflight`,
      );
      if (cancelled) return;
      if (!res.ok) {
        setPreviewError(res.message ?? t('wsSettings.clear.loadPreviewFailed'));
        return;
      }
      setPreview(res.data);
    })();
    return () => {
      cancelled = true;
    };
    // `t` only used for an error-fallback string; load preview once per workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const matches = preview && confirmText.trim() === preview.name;
  const canDelete = phase === 'preview' && !!matches;

  const updateStep = useCallback((step: string, status: StepStatus, count?: number, error?: string) => {
    setSteps((prev) =>
      prev.map((s) =>
        s.step === step ? { ...s, status, count: count ?? s.count, error: error ?? s.error } : s,
      ),
    );
  }, []);

  const runDelete = useCallback(async () => {
    if (!preview) return;
    setPhase('running');
    setStreamError(null);

    const token = getWorkspaceToken();
    const url = `/api/im/workspaces/${encodeURIComponent(workspaceId)}?confirmName=${encodeURIComponent(preview.name)}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'DELETE',
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
      return;
    }
    if (!resp.ok || !resp.body) {
      setStreamError(`HTTP ${resp.status}`);
      setPhase('failed');
      return;
    }

    // Parse SSE manually: each event is `event: <name>\ndata: <json>\n\n`.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawComplete = false;
    let sawError = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventName = 'message';
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine);
          } catch {
            continue;
          }
          if (eventName === 'progress') {
            const stepKey = String(payload.step ?? '');
            const status = String(payload.status ?? '') as StepStatus;
            const count = typeof payload.count === 'number' ? payload.count : undefined;
            const error = typeof payload.error === 'string' ? payload.error : undefined;
            updateStep(stepKey, status, count, error);
          } else if (eventName === 'error') {
            setStreamError(String(payload.error ?? 'unknown'));
            sawError = true;
          } else if (eventName === 'complete') {
            sawComplete = true;
          }
        }
      }
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : String(err));
      sawError = true;
    }

    if (sawComplete) {
      setPhase('done');
      // Brief pause so the user sees the final checkmark, then close.
      setTimeout(onDone, 800);
    } else if (sawError) {
      setPhase('failed');
    } else {
      setPhase('failed');
      setStreamError((prev) => prev ?? t('wsSettings.clear.streamEndedNoComplete'));
    }
  }, [preview, workspaceId, updateStep, onDone, t]);

  const surface = isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-zinc-200';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const danger = 'bg-red-600 hover:bg-red-700 text-white disabled:bg-red-900 disabled:opacity-50';

  const totalRowsApprox = useMemo(() => {
    if (!preview) return 0;
    const c = preview.counts;
    return c.agents + c.conversations + c.messages + c.tasks + c.taskRuns + c.containers + c.assets + c.memoryFiles + c.workspaceFiles + c.channels + c.members;
  }, [preview]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className={`w-full max-w-lg rounded-xl border shadow-xl ${surface} max-h-[90vh] overflow-y-auto`}>
        <header className="border-b border-zinc-200 dark:border-zinc-800 p-5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <h2 className={`text-base font-semibold ${textPrimary}`}>
              {t('wsSettings.clear.title')}
            </h2>
          </div>
          <p className={`mt-2 text-xs ${textMuted}`}>
            {t('wsSettings.clear.warning')}
          </p>
        </header>

        <div className="p-5 space-y-4">
          {previewError ? (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {previewError}
            </div>
          ) : !preview ? (
            <div className={`flex items-center gap-2 text-sm ${textMuted}`}>
              <Loader2 className="h-4 w-4 animate-spin" /> {t('wsSettings.clear.loadingPreview')}
            </div>
          ) : (
            <>
              <div className={`rounded border border-zinc-200 dark:border-zinc-700 p-3 text-xs ${textMuted}`}>
                <p className="mb-2">
                  {t('wsSettings.clear.aboutToDelete', {
                    name: preview.name,
                    rows: totalRowsApprox.toLocaleString(),
                  })}
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
                  <span>{t('wsSettings.clear.rowAgents')}: {preview.counts.agents}</span>
                  <span>{t('wsSettings.clear.rowConversations')}: {preview.counts.conversations}</span>
                  <span>{t('wsSettings.clear.rowMessages')}: {preview.counts.messages}</span>
                  <span>{t('wsSettings.clear.rowTasks')}: {preview.counts.tasks}</span>
                  <span>{t('wsSettings.clear.rowTaskRuns')}: {preview.counts.taskRuns}</span>
                  <span>{t('wsSettings.clear.rowContainers')}: {preview.counts.containers}</span>
                  <span>{t('wsSettings.clear.rowRunningPods')}: {preview.counts.runningContainers}</span>
                  <span>{t('wsSettings.clear.rowAssets')}: {preview.counts.assets}</span>
                  <span>{t('wsSettings.clear.rowMemoryFiles')}: {preview.counts.memoryFiles}</span>
                  <span>{t('wsSettings.clear.rowFiles')}: {preview.counts.workspaceFiles}</span>
                  <span>{t('wsSettings.clear.rowChannels')}: {preview.counts.channels}</span>
                  <span>{t('wsSettings.clear.rowMembers')}: {preview.counts.members}</span>
                </div>
              </div>

              {phase === 'preview' && (
                <>
                  <div>
                    <label className={`block text-xs ${textMuted} mb-1`}>
                      {t('wsSettings.clear.typeToConfirm', { name: preview.name })}
                    </label>
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      autoFocus
                      placeholder={preview.name}
                      className={`w-full rounded border px-3 py-1.5 text-sm font-mono ${
                        isDark
                          ? 'border-zinc-700 bg-zinc-950 text-zinc-100'
                          : 'border-zinc-300 bg-white text-zinc-900'
                      }`}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className={`px-3 py-1.5 rounded text-sm ${
                        isDark
                          ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                          : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                      }`}
                    >
                      {t('wsSettings.clear.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runDelete()}
                      disabled={!canDelete}
                      className={`px-3 py-1.5 rounded text-sm font-semibold ${danger}`}
                    >
                      {t('wsSettings.clear.deleteWorkspace')}
                    </button>
                  </div>
                </>
              )}

              {(phase === 'running' || phase === 'done' || phase === 'failed') && (
                <>
                  <ol className="space-y-1.5">
                    {steps.map((s) => (
                      <li key={s.step} className="flex items-start gap-2 text-xs">
                        <StepIcon status={s.status} />
                        <span className={s.status === 'completed' ? textMuted : textPrimary}>
                          {t(s.labelKey)}
                          {s.count != null && s.status === 'completed' && (
                            <span className={`ml-1 font-mono ${textMuted}`}>· {s.count}</span>
                          )}
                          {s.error && <span className="ml-1 text-red-500">· {s.error}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {streamError && (
                    <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                      {streamError}
                    </div>
                  )}
                  {phase === 'done' && (
                    <div className="text-xs text-emerald-500 font-medium">
                      {t('wsSettings.clear.cleared')}
                    </div>
                  )}
                  {phase === 'failed' && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={onClose}
                        className={`px-3 py-1.5 rounded text-sm ${
                          isDark
                            ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                            : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                        }`}
                      >
                        {t('wsSettings.clear.close')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }): React.JSX.Element {
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />;
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />;
  if (status === 'in_progress') return <Loader2 className="h-4 w-4 text-blue-500 shrink-0 mt-0.5 animate-spin" />;
  return <Circle className="h-4 w-4 text-zinc-400 shrink-0 mt-0.5" />;
}
