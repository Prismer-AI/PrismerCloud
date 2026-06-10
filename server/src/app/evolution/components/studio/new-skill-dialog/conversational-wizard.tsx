'use client';

/**
 * ConversationalWizard — release201/24 §Phase1b (Path B).
 *
 * The "+ New skill" surface, rebuilt as a full inline conversational wizard.
 * Instead of a static form, the agent (a lightweight cloud authoring-chat
 * endpoint) ASKS BACK — clarifying slug / triggers / IO / source / acceptance
 * up-front via free text + structured decision cards — and converges an
 * `AuthoringSpec`. Only when the spec is `ready` does the wizard fire ONE
 * `skill-authoring` task through the existing `/authoring-requests` dispatch.
 *
 * Path B (release201/24 §3): clarification is front-loaded here, so we never
 * touch the daemon / wire protocol (no mid-task pause/resume — that's Path A,
 * deferred). After dispatch the right panel tracks the real draft (matched by
 * the agreed slug) + its eval run via poll + SSE, reusing the lifecycle
 * preview components.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, CheckCircle2, Loader2, Plus, Send, Sparkles, User } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/contexts/i18n-context';
import { springSoft } from '@/app/workspace/lib/design';
import {
  type AuthoringChatDecision,
  type AuthoringSpec,
  type EvalRunStatus,
  type SkillDetail,
  type SkillDraftDetail,
  type SourceKind,
  authoringChat,
  fetchDraftDetail,
  fetchDrafts,
  fetchEvalRun,
  fetchSkillDetail,
  requestAuthoring,
} from '../types';
import type { DraftInputMode } from './helpers';
import { ManifestTree } from './manifest-tree';
import { SkillEvalProgress } from '../lifecycle/skill-eval-progress';
import { SkillSuccessRateCurve } from '../lifecycle/skill-success-rate-curve';

export interface ConversationalWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  workspaceId: string | null;
  initialMode?: DraftInputMode;
  initialIntent?: string;
  initialSource?: SourceKind;
  onSubmitted: (result: { taskId: string; agentId: string; agentOnline: boolean }) => void;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  decisions?: AuthoringChatDecision[];
}

// Seed the first user turn with the chip the user clicked on the source bench.
const MODE_SEED: Record<DraftInputMode, string> = {
  plain: '',
  script: 'I want to turn an existing script into a skill.',
  api: 'I want to make a skill from an API doc / OpenAPI URL.',
  doc: 'I want to make a skill from a document.',
};

export function ConversationalWizard({
  open,
  onOpenChange,
  isDark,
  workspaceId,
  initialMode = 'plain',
  initialIntent,
  onSubmitted,
}: ConversationalWizardProps) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [spec, setSpec] = useState<AuthoringSpec>({});
  const [input, setInput] = useState(initialIntent ?? MODE_SEED[initialMode] ?? '');
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  // Tracking phase (post-dispatch): match the real draft by agreed slug.
  const [phase, setPhase] = useState<'gathering' | 'tracking'>('gathering');
  const [dispatchedSlug, setDispatchedSlug] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftDetail, setDraftDetail] = useState<SkillDraftDetail | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [evalRun, setEvalRun] = useState<EvalRunStatus | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Greeting on open; reset everything on close.
  useEffect(() => {
    if (open) {
      setMessages([{ role: 'assistant', content: t('evolution.studio.newSkill.wizard.greeting') }]);
    } else {
      setMessages([]);
      setSpec({});
      setReady(false);
      setError(null);
      setPhase('gathering');
      setDispatchedSlug(null);
      setDraftId(null);
      setDraftDetail(null);
      setSkillDetail(null);
      setEvalRun(null);
      setInput(initialIntent ?? MODE_SEED[initialMode] ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    // scrollTo is absent in jsdom and some embedded webviews — guard it.
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, pending]);

  const sendTurn = useCallback(
    async (userText: string) => {
      if (!userText.trim() || pending) return;
      setError(null);
      const nextMessages: ChatMsg[] = [...messages, { role: 'user', content: userText.trim() }];
      setMessages(nextMessages);
      setInput('');
      setPending(true);
      const res = await authoringChat({
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        workspaceId: workspaceId ?? '',
        specSoFar: spec,
      });
      setPending(false);
      if (!res.ok) {
        setError(res.message ?? res.error);
        return;
      }
      setSpec(res.turn.spec);
      setReady(res.turn.ready);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.turn.reply, decisions: res.turn.decisions },
      ]);
    },
    [messages, pending, spec, workspaceId],
  );

  // Click a decision option → answer in natural language so the model keeps
  // the conversation coherent (one intent, one affordance).
  const answerDecision = useCallback(
    (decision: AuthoringChatDecision, value: string, label: string) => {
      void sendTurn(`${decision.label} → ${label} (${value})`);
    },
    [sendTurn],
  );

  const handleDispatch = useCallback(async () => {
    if (!workspaceId) {
      setError(t('evolution.studio.newSkill.noWorkspace'));
      return;
    }
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const intent =
      spec.name && spec.outputs ? `${spec.name} — ${spec.outputs}` : spec.name || firstUser || 'New skill';
    setDispatching(true);
    setError(null);
    const result = await requestAuthoring({
      intent: intent.length >= 8 ? intent : `${intent} skill`,
      sourceKind: spec.sourceKind ?? 'inline-spec',
      sourceRefs: spec.sourceRefs ?? [],
      sampleTask: spec.sampleTasks?.[0]?.input ?? null,
      workspaceId,
      spec,
    });
    setDispatching(false);
    if (!result.ok) {
      setError(result.message ?? result.error);
      return;
    }
    onSubmitted({ taskId: result.taskId, agentId: result.agentId, agentOnline: result.agentOnline });
    setDispatchedSlug(spec.slug ?? null);
    setPhase('tracking');
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: result.agentOnline
          ? t('evolution.studio.newSkill.wizard.dispatchedOnline')
          : t('evolution.studio.newSkill.wizard.dispatchedQueued'),
      },
    ]);
  }, [messages, spec, workspaceId, onSubmitted, t]);

  // Tracking: poll for the draft (matched by slug) + its eval run; SSE nudges
  // an immediate refresh. Reuses the lifecycle-view SSE pattern.
  useEffect(() => {
    if (phase !== 'tracking' || !dispatchedSlug || !workspaceId) return;
    let cancelled = false;

    const refresh = async () => {
      let id = draftId;
      if (!id) {
        const rows = await fetchDrafts(workspaceId);
        const match = rows.find((r) => r.slug === dispatchedSlug);
        if (match) {
          id = match.id;
          if (!cancelled) setDraftId(match.id);
        }
      }
      if (!id) return;
      const [d, sd] = await Promise.all([fetchDraftDetail(id), fetchSkillDetail(id)]);
      if (cancelled) return;
      if (d) setDraftDetail(d);
      if (sd) {
        setSkillDetail(sd);
        const runId = sd.metadata?.activeEvalRunId;
        if (runId) {
          const run = await fetchEvalRun(id, runId);
          if (!cancelled && run) setEvalRun(run);
        }
      }
    };

    void refresh();
    const interval = setInterval(() => void refresh(), 3000);

    let es: EventSource | null = null;
    const token = readToken();
    if (token) {
      try {
        es = new EventSource(`/api/im/sync/stream?token=${encodeURIComponent(token)}`);
        es.addEventListener('message', (ev: MessageEvent) => {
          try {
            const payload = JSON.parse(ev.data);
            const type: string | undefined = payload?.type ?? payload?.event;
            if (type && (type.startsWith('skill.authoring.') || type.startsWith('skill.eval.'))) {
              void refresh();
            }
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* SSE optional — polling covers correctness */
      }
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      es?.close();
    };
  }, [phase, dispatchedSlug, workspaceId, draftId]);

  const latestDecisions = useMemo(() => {
    const last = messages[messages.length - 1];
    return last?.role === 'assistant' ? last.decisions ?? [] : [];
  }, [messages]);

  const bubbleBase = isDark ? 'bg-zinc-900/60 border-white/[0.08]' : 'bg-white border-zinc-200';
  const inputClass = isDark
    ? 'w-full resize-none bg-white/[0.04] text-zinc-100 placeholder-zinc-500 border border-white/[0.06] rounded-lg px-3 py-2 text-sm outline-none focus:border-violet-400'
    : 'w-full resize-none bg-white text-zinc-900 placeholder-zinc-400 border border-zinc-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-violet-500';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[7vh] flex max-h-[86vh] translate-y-0 flex-col overflow-hidden border-zinc-200 bg-white p-0 shadow-2xl dark:border-white/10 dark:bg-zinc-950 sm:max-w-4xl"
        data-testid="studio-new-skill-dialog"
        onInteractOutside={(e) => {
          if (pending || dispatching) e.preventDefault();
        }}
      >
        <DialogHeader className="border-b px-6 py-4 dark:border-white/[0.06]">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className={isDark ? 'h-4 w-4 text-violet-300' : 'h-4 w-4 text-violet-600'} />
            {t('evolution.studio.newSkill.wizard.title')}
          </DialogTitle>
          <DialogDescription>{t('evolution.studio.newSkill.wizard.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* ── Left: conversation ── */}
          <div className="flex min-h-0 flex-col border-r dark:border-white/[0.06]">
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4" data-testid="wizard-conversation">
              {messages.map((m, i) => (
                <ChatBubble key={i} msg={m} isDark={isDark} bubbleBase={bubbleBase} />
              ))}

              {/* Structured decision cards from the latest assistant turn */}
              {!pending && latestDecisions.length > 0 && (
                <div className="space-y-2" data-testid="wizard-decisions">
                  {latestDecisions.map((d) => (
                    <DecisionCard key={d.key} decision={d} isDark={isDark} onPick={answerDecision} />
                  ))}
                </div>
              )}

              {pending && (
                <div className="flex items-center gap-2 text-xs text-zinc-500" data-testid="wizard-typing">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('evolution.studio.newSkill.wizard.thinking')}
                </div>
              )}

              {error && (
                <p className={`text-xs ${isDark ? 'text-rose-400' : 'text-rose-600'}`} role="alert">
                  {error}
                </p>
              )}
            </div>

            {/* Composer + ready/dispatch action */}
            <div className={`border-t px-4 py-3 dark:border-white/[0.06] ${isDark ? 'bg-zinc-950/80' : 'bg-white/90'}`}>
              {ready && phase === 'gathering' && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={springSoft}
                  className={`mb-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                    isDark ? 'border-emerald-400/20 bg-emerald-500/[0.08]' : 'border-emerald-300 bg-emerald-50'
                  }`}
                  data-testid="wizard-ready-banner"
                >
                  <span className={`text-[11px] ${isDark ? 'text-emerald-200' : 'text-emerald-800'}`}>
                    {t('evolution.studio.newSkill.wizard.readyHint')}
                  </span>
                  <Button size="sm" onClick={() => void handleDispatch()} disabled={dispatching} data-testid="wizard-dispatch">
                    {dispatching ? <Loader2 className="animate-spin" /> : <Plus />}
                    {t('evolution.studio.newSkill.wizard.create')}
                  </Button>
                </motion.div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendTurn(input);
                    }
                  }}
                  rows={2}
                  disabled={phase === 'tracking'}
                  placeholder={
                    phase === 'tracking'
                      ? t('evolution.studio.newSkill.wizard.trackingPlaceholder')
                      : t('evolution.studio.newSkill.wizard.composerPlaceholder')
                  }
                  className={inputClass}
                  data-testid="wizard-composer"
                  autoFocus
                />
                <Button
                  size="icon"
                  onClick={() => void sendTurn(input)}
                  disabled={pending || !input.trim() || phase === 'tracking'}
                  data-testid="wizard-send"
                  aria-label={t('evolution.studio.newSkill.wizard.send')}
                >
                  <Send />
                </Button>
              </div>
            </div>
          </div>

          {/* ── Right: live preview ── */}
          <PreviewPanel
            isDark={isDark}
            phase={phase}
            spec={spec}
            draftDetail={draftDetail}
            skillDetail={skillDetail}
            evalRun={evalRun}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChatBubble({ msg, isDark, bubbleBase }: { msg: ChatMsg; isDark: boolean; bubbleBase: string }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`} data-role={msg.role}>
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          isUser
            ? isDark
              ? 'bg-violet-500/20 text-violet-300'
              : 'bg-violet-100 text-violet-700'
            : isDark
              ? 'bg-white/[0.06] text-zinc-300'
              : 'bg-zinc-100 text-zinc-600'
        }`}
      >
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </span>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl border px-3 py-2 text-[13px] leading-relaxed ${bubbleBase} ${
          isDark ? 'text-zinc-200' : 'text-zinc-800'
        }`}
      >
        {msg.content}
      </div>
    </div>
  );
}

function DecisionCard({
  decision,
  isDark,
  onPick,
}: {
  decision: AuthoringChatDecision;
  isDark: boolean;
  onPick: (decision: AuthoringChatDecision, value: string, label: string) => void;
}) {
  return (
    <div
      className={`rounded-xl border p-2.5 ${isDark ? 'border-white/[0.08] bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'}`}
      data-decision-key={decision.key}
    >
      <p className={`mb-1.5 text-[11px] font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{decision.label}</p>
      <div className="flex flex-wrap gap-1.5">
        {decision.options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onPick(decision, o.value, o.label)}
            data-decision-option={o.value}
            className={`rounded-lg border px-2.5 py-1 text-left text-[11px] transition-colors ${
              isDark
                ? 'border-white/[0.06] bg-white/[0.03] text-zinc-200 hover:bg-white/[0.08]'
                : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-100'
            }`}
            title={o.hint}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PreviewPanel({
  isDark,
  phase,
  spec,
  draftDetail,
  skillDetail,
  evalRun,
}: {
  isDark: boolean;
  phase: 'gathering' | 'tracking';
  spec: AuthoringSpec;
  draftDetail: SkillDraftDetail | null;
  skillDetail: SkillDetail | null;
  evalRun: EvalRunStatus | null;
}) {
  const { t } = useI18n();
  const label = `text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`;
  const history = skillDetail?.metadata?.authoring?.draftRevisionHistory ?? null;
  return (
    <aside
      className={`hidden min-h-0 flex-col overflow-y-auto px-4 py-4 lg:flex ${isDark ? 'bg-white/[0.01]' : 'bg-zinc-50/60'}`}
      data-testid="wizard-preview"
      data-phase={phase}
    >
      <p className={`mb-3 ${label}`}>{t('evolution.studio.newSkill.wizard.previewTitle')}</p>

      {/* Spec-so-far card (always visible — grows as the conversation converges) */}
      <div
        className={`space-y-2 rounded-xl border p-3 ${isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'}`}
      >
        <SpecRow label="slug" value={spec.slug} isDark={isDark} mono />
        <SpecRow label={t('evolution.studio.newSkill.wizard.specName')} value={spec.name} isDark={isDark} />
        {spec.triggers?.length ? (
          <div>
            <p className={label}>{t('evolution.studio.newSkill.wizard.specTriggers')}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {spec.triggers.map((tr) => (
                <Badge key={tr} variant="outline" className="font-normal">
                  {tr}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        <SpecRow label={t('evolution.studio.newSkill.wizard.specSource')} value={spec.sourceKind} isDark={isDark} />
        <SpecRow label={t('evolution.studio.newSkill.wizard.specScope')} value={spec.scope} isDark={isDark} />
        {(() => {
          const ac = spec.acceptanceCriteria ?? spec.sampleTasks?.flatMap((s) => s.acceptanceCriteria) ?? [];
          return ac.length ? (
            <div>
              <p className={label}>{t('evolution.studio.newSkill.wizard.specAcceptance')}</p>
              <ul className={`mt-1 space-y-0.5 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {ac.slice(0, 6).map((c, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500/70" />
                    <span className="font-mono">{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className={`text-[11px] italic ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              {t('evolution.studio.newSkill.wizard.specEmpty')}
            </p>
          );
        })()}
      </div>

      {/* Post-dispatch: real draft tracking */}
      {phase === 'tracking' && (
        <div className="mt-4 space-y-3">
          <div>
            <p className={`mb-1.5 ${label}`}>{t('evolution.studio.newSkill.wizard.manifestTitle')}</p>
            {draftDetail?.files?.length ? (
              <ManifestTree isDark={isDark} files={draftDetail.files} />
            ) : (
              <p className={`flex items-center gap-1.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('evolution.studio.newSkill.wizard.waitingDraft')}
              </p>
            )}
          </div>
          {evalRun && <SkillEvalProgress isDark={isDark} run={evalRun} />}
          {history && history.length > 0 && <SkillSuccessRateCurve isDark={isDark} history={history} />}
        </div>
      )}
    </aside>
  );
}

function SpecRow({
  label,
  value,
  isDark,
  mono,
}: {
  label: string;
  value?: string | null;
  isDark: boolean;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {label}
      </span>
      <span className={`text-[12px] ${mono ? 'font-mono' : ''} ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
        {value}
      </span>
    </div>
  );
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const auth = JSON.parse(localStorage.getItem('prismer_auth') ?? '{}');
    if (auth?.token) return auth.token as string;
  } catch {
    /* fall through */
  }
  return localStorage.getItem('prismer_active_api_key');
}
