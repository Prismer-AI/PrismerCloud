'use client';

/**
 * Studio · Session memory — release201/26 Phase 3 admin drawer.
 *
 * Operator-only surface for inspecting + repairing the L2 conversational
 * memory layer of a single conversation:
 *
 *   - Load by conversation id → GET /api/im/conversations/:id/memory
 *   - Render each compressed segment (seq, kind, time window, summary markdown,
 *     salient facts, token count, producer model/version, superseded marker)
 *   - Per-segment "Regenerate" (AlertDialog-confirmed) →
 *     POST .../memory/segments/:seq/regenerate, then refetch
 *   - Identifier index (secondary, collapsible)
 *
 * RBAC is enforced server-side (`user.role === 'admin'`); the frontend `User`
 * type carries no role, so admin gating here is "attempt the fetch, surface a
 * 403 state gracefully" rather than hiding the trigger. Loading / empty /
 * not-found / forbidden / error states are all surfaced.
 *
 * Visual contract: shadcn Sheet / Button / Badge / AlertDialog primitives +
 * evolution `glass()` + MarkdownRenderer (same vocabulary as the lifecycle
 * EvidencePanel and the metrics view).
 */

import { useCallback, useState } from 'react';
import { Brain, ChevronDown, Loader2, RefreshCw, Search } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { useI18n } from '@/contexts/i18n-context';
import { useApp } from '@/contexts/app-context';
import { glass } from '../helpers';
import {
  type ConversationMemory,
  type MemoryFetchResult,
  type MemorySegment,
  fetchConversationMemory,
  regenerateMemorySegment,
} from './types';

interface SessionMemoryDrawerProps {
  isDark: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: ConversationMemory }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'error' };

export function SessionMemoryDrawer({ isDark, open, onOpenChange }: SessionMemoryDrawerProps) {
  const { t } = useI18n();
  const { addToast } = useApp();
  const [convInput, setConvInput] = useState('');
  const [loadedConvId, setLoadedConvId] = useState('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [showIdentifiers, setShowIdentifiers] = useState(false);
  const [regenSeq, setRegenSeq] = useState<number | null>(null);
  const [busySeq, setBusySeq] = useState<number | null>(null);

  const applyResult = useCallback((res: MemoryFetchResult) => {
    if (res.status === 'ok') setState({ kind: 'ready', data: res.data });
    else if (res.status === 'forbidden') setState({ kind: 'forbidden' });
    else if (res.status === 'not-found') setState({ kind: 'not-found' });
    else setState({ kind: 'error' });
  }, []);

  const load = useCallback(
    async (idOverride?: string, supersededOverride?: boolean) => {
      const id = (idOverride ?? convInput).trim();
      if (!id) return;
      const superseded = supersededOverride ?? includeSuperseded;
      setLoadedConvId(id);
      setState({ kind: 'loading' });
      applyResult(await fetchConversationMemory(id, superseded));
    },
    [convInput, includeSuperseded, applyResult],
  );

  const toggleSuperseded = useCallback(() => {
    const next = !includeSuperseded;
    setIncludeSuperseded(next);
    if (loadedConvId) void load(loadedConvId, next);
  }, [includeSuperseded, loadedConvId, load]);

  const confirmRegenerate = useCallback(async () => {
    if (regenSeq == null || !loadedConvId) return;
    const seq = regenSeq;
    setRegenSeq(null);
    setBusySeq(seq);
    const res = await regenerateMemorySegment(loadedConvId, seq);
    setBusySeq(null);
    if (res.status === 'ok') {
      addToast(t('evolution.studio.sessionMemory.regenerateOk'), 'success');
      // Refetch the list so the superseded marker / new content is reflected.
      applyResult(await fetchConversationMemory(loadedConvId, includeSuperseded));
    } else if (res.status === 'forbidden') {
      addToast(t('evolution.studio.sessionMemory.forbidden'), 'error');
    } else {
      addToast(t('evolution.studio.sessionMemory.regenerateFailed'), 'error');
    }
  }, [regenSeq, loadedConvId, includeSuperseded, applyResult, addToast, t]);

  const subtle = isDark ? 'text-zinc-500' : 'text-zinc-500';
  const strong = isDark ? 'text-zinc-100' : 'text-zinc-900';

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-xl"
          data-testid="session-memory-drawer"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Brain className="h-4 w-4" aria-hidden />
              {t('evolution.studio.sessionMemory.title')}
            </SheetTitle>
            <SheetDescription>{t('evolution.studio.sessionMemory.subtitle')}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-4 px-4 pb-6">
            {/* Conversation id + load */}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void load();
              }}
            >
              <label className="sr-only" htmlFor="session-memory-conv-id">
                {t('evolution.studio.sessionMemory.conversationIdLabel')}
              </label>
              <input
                id="session-memory-conv-id"
                data-testid="session-memory-conv-input"
                value={convInput}
                onChange={(e) => setConvInput(e.target.value)}
                placeholder={t('evolution.studio.sessionMemory.conversationIdPlaceholder')}
                className={`min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-xs ${
                  isDark
                    ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100 placeholder:text-zinc-600'
                    : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
                }`}
              />
              <Button type="submit" size="sm" disabled={!convInput.trim() || state.kind === 'loading'}>
                <Search className="h-3.5 w-3.5" />
                {t('evolution.studio.sessionMemory.load')}
              </Button>
            </form>

            <label className={`flex w-fit cursor-pointer items-center gap-2 text-xs ${subtle}`}>
              <input
                type="checkbox"
                data-testid="session-memory-include-superseded"
                checked={includeSuperseded}
                onChange={toggleSuperseded}
                className="h-3.5 w-3.5 rounded"
              />
              {t('evolution.studio.sessionMemory.includeSuperseded')}
            </label>

            {/* Body states */}
            {state.kind === 'idle' && (
              <StatePane isDark={isDark} testid="session-memory-idle">
                {t('evolution.studio.sessionMemory.promptIdle')}
              </StatePane>
            )}

            {state.kind === 'loading' && (
              <div
                data-testid="session-memory-loading"
                className={`flex items-center justify-center gap-2 rounded-2xl px-6 py-10 ${glass(isDark, 'base')}`}
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className={`text-xs ${subtle}`}>{t('evolution.studio.sessionMemory.loading')}</span>
              </div>
            )}

            {state.kind === 'forbidden' && (
              <ErrorPane isDark={isDark} testid="session-memory-forbidden" tone="amber">
                {t('evolution.studio.sessionMemory.forbidden')}
              </ErrorPane>
            )}

            {state.kind === 'not-found' && (
              <ErrorPane isDark={isDark} testid="session-memory-not-found" tone="rose">
                {t('evolution.studio.sessionMemory.notFound')}
              </ErrorPane>
            )}

            {state.kind === 'error' && (
              <ErrorPane isDark={isDark} testid="session-memory-error" tone="rose">
                {t('evolution.studio.sessionMemory.loadError')}
              </ErrorPane>
            )}

            {state.kind === 'ready' && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h3 className={`text-xs font-semibold uppercase tracking-wider ${subtle}`}>
                    {t('evolution.studio.sessionMemory.segmentsHeading')}
                  </h3>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {loadedConvId.slice(0, 10)}
                  </Badge>
                </div>

                {state.data.segments.length === 0 ? (
                  <StatePane isDark={isDark} testid="session-memory-empty">
                    {t('evolution.studio.sessionMemory.empty')}
                  </StatePane>
                ) : (
                  <ul className="flex flex-col gap-3" data-testid="session-memory-segments">
                    {state.data.segments.map((seg) => (
                      <SegmentCard
                        key={`${seg.segmentSeq}-${seg.id ?? ''}-${seg.supersededBy ?? ''}`}
                        isDark={isDark}
                        segment={seg}
                        busy={busySeq === seg.segmentSeq}
                        onRegenerate={() => setRegenSeq(seg.segmentSeq)}
                      />
                    ))}
                  </ul>
                )}

                {/* Identifier index — secondary, collapsible */}
                <div className={`rounded-2xl ${glass(isDark, 'subtle')}`}>
                  <button
                    type="button"
                    data-testid="session-memory-identifiers-toggle"
                    onClick={() => setShowIdentifiers((v) => !v)}
                    className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
                  >
                    <span className={`text-xs font-semibold uppercase tracking-wider ${subtle}`}>
                      {t('evolution.studio.sessionMemory.identifiersHeading')}
                      <span className={`ml-1.5 font-mono ${subtle}`}>({state.data.identifiers.length})</span>
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${showIdentifiers ? 'rotate-180' : ''} ${subtle}`}
                      aria-hidden
                    />
                  </button>
                  {showIdentifiers && (
                    <div className="px-4 pb-3">
                      {state.data.identifiers.length === 0 ? (
                        <p className={`text-xs ${subtle}`}>
                          {t('evolution.studio.sessionMemory.noIdentifiers')}
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-1.5">
                          {state.data.identifiers.map((idn, i) => (
                            <li
                              key={`${idn.canonicalId}-${i}`}
                              className="flex items-center gap-2 text-xs"
                            >
                              <Badge variant="secondary" className="text-[10px]">
                                {idn.identifierKind}
                              </Badge>
                              <span className={strong}>{idn.displayLabel ?? idn.canonicalId}</span>
                              <span className={`truncate font-mono text-[10px] ${subtle}`}>
                                {idn.canonicalId}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={regenSeq != null} onOpenChange={(o) => !o && setRegenSeq(null)}>
        <AlertDialogContent data-testid="session-memory-regenerate-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('evolution.studio.sessionMemory.regenerateConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('evolution.studio.sessionMemory.regenerateConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('evolution.studio.sessionMemory.regenerateCancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRegenerate()}>
              {t('evolution.studio.sessionMemory.regenerateConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Segment card ───────────────────────────────────────────────────────

function SegmentCard({
  isDark,
  segment,
  busy,
  onRegenerate,
}: {
  isDark: boolean;
  segment: MemorySegment;
  busy: boolean;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();
  const subtle = isDark ? 'text-zinc-500' : 'text-zinc-500';
  const strong = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const isSuperseded = !!segment.supersededBy;
  const facts = segment.salientFacts ?? [];

  return (
    <li
      data-testid="session-memory-segment"
      className={`rounded-2xl p-4 ${glass(isDark, 'base')} ${isSuperseded ? 'opacity-60' : ''}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {t('evolution.studio.sessionMemory.segmentSeq')} #{segment.segmentSeq}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {segment.segmentKind}
        </Badge>
        {isSuperseded && (
          <Badge variant="destructive" className="text-[10px]">
            {t('evolution.studio.sessionMemory.superseded')}
          </Badge>
        )}
        {segment.tokenCountCl100k != null && (
          <span className={`ml-auto font-mono text-[10px] ${subtle}`}>
            {segment.tokenCountCl100k.toLocaleString()} {t('evolution.studio.sessionMemory.tokens')}
          </span>
        )}
      </div>

      <p className={`mb-2 text-[11px] ${subtle}`}>
        {t('evolution.studio.sessionMemory.covers')}: {formatWindow(segment)}
      </p>

      {segment.summary ? (
        <div className="prose-sm max-w-none text-sm">
          <MarkdownRenderer content={segment.summary} />
        </div>
      ) : (
        <p className={`text-xs italic ${subtle}`}>—</p>
      )}

      {facts.length > 0 && (
        <div className="mt-3">
          <p className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${subtle}`}>
            {t('evolution.studio.sessionMemory.salientFacts')}
          </p>
          <ul className="flex flex-col gap-1">
            {facts.map((f, i) => (
              <li key={i} className={`flex gap-1.5 text-xs ${strong}`}>
                <span className={subtle} aria-hidden>
                  •
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={`truncate font-mono text-[10px] ${subtle}`}>
          {t('evolution.studio.sessionMemory.producer')}: {segment.producerModel ?? '—'}
          {segment.producerVersion ? ` · ${segment.producerVersion}` : ''}
        </span>
        <Button
          variant="outline"
          size="xs"
          data-testid="session-memory-regenerate"
          disabled={busy}
          onClick={onRegenerate}
        >
          {busy ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('evolution.studio.sessionMemory.regenerating')}
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3" />
              {t('evolution.studio.sessionMemory.regenerate')}
            </>
          )}
        </Button>
      </div>
    </li>
  );
}

function formatWindow(seg: MemorySegment): string {
  const fmt = (ts: string | null) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  };
  return `${fmt(seg.coversFromCreatedAt)} → ${fmt(seg.coversToCreatedAt)}`;
}

// ─── State panes ─────────────────────────────────────────────────────────

function StatePane({
  isDark,
  testid,
  children,
}: {
  isDark: boolean;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testid}
      className={`rounded-2xl px-5 py-8 text-center text-sm ${glass(isDark, 'base')} ${
        isDark ? 'text-zinc-300' : 'text-zinc-600'
      }`}
    >
      {children}
    </div>
  );
}

function ErrorPane({
  isDark,
  testid,
  tone,
  children,
}: {
  isDark: boolean;
  testid: string;
  tone: 'amber' | 'rose';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'amber'
      ? isDark
        ? 'border border-amber-500/20 bg-amber-500/[0.06] text-amber-200'
        : 'border border-amber-200 bg-amber-50 text-amber-700'
      : isDark
        ? 'border border-rose-500/20 bg-rose-500/[0.06] text-rose-300'
        : 'border border-rose-200 bg-rose-50 text-rose-700';
  return (
    <div data-testid={testid} className={`rounded-2xl px-4 py-3 text-xs ${cls}`}>
      {children}
    </div>
  );
}
