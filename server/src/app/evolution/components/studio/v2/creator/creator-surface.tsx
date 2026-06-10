'use client';

/**
 * Skill Creator surface (release201/28 §3) — Evolution Studio hero face.
 *
 * Layout = workshop spatial grammar (conversational-steering variant): left
 * Steering pane (chat thread + source bench + composer), right Live Artifact
 * Canvas (4 info layers: Liveness / Artifact / References / Confidence) + a
 * phase-aware action dock.
 *
 * Data source (CONTRACT §3/§4):
 *   - FF_STUDIO_MOCK (default on) → `simulateAuthoringRun()` drives the canvas;
 *     SKILL.md is typed in locally from the fixture (mock has no preview.delta).
 *   - live → `useAuthoringEvents(draftId, !mock)` folds the SSE bus.
 * Both feed the same pure reducer (`./creator-state`), so the live swap is a
 * 0-UI-change source switch.
 *
 * Five states (CONTRACT §5): empty (breathing ring) / loading / error /
 * **gated** (`queued · no runner` / offline — honest, never fakes progress) /
 * data. Orchestrator resolution (§3.1): the default authoring actor is the
 * workspace orchestrator; with none authorized we render an explicit
 * "authorize orchestrator" CTA instead of silently falling back.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, RefreshCw, Sparkles, UserPlus, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  grammarAccentClasses,
  radius,
  s,
  springSoft,
  springSplat,
} from '@/app/workspace/lib/design';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/app-context';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { useAuthoringEvents, type AuthoringEvent } from '../authoring-events';
import { useStudioContext } from '../data/use-studio-context';
import { STUDIO_MOCK_ENABLED } from '../flags';
import {
  MOCK_EVAL_RUN,
  MOCK_MANIFEST,
  MOCK_SKILL_JSON,
  MOCK_SKILL_MD,
  simulateAuthoringRun,
} from '../mock';
import type { CreatorSourceKind } from '../types';

import { ArtifactCanvas } from './artifact-canvas';
import {
  initialCreatorState,
  publish,
  pushMessage,
  reduceCreator,
  seedEvalCaseNames,
  setTyping,
  type CreatorPhase,
  type CreatorState,
} from './creator-state';
import { SteeringPane, type SteeringMessage } from './steering-pane';

export interface CreatorSurfaceProps {
  agentId: string | null;
  draftId: string | null;
}

// ── reducer actions (thin wrapper so the surface can mix events + local msgs) ──

type CreatorAction =
  | { kind: 'event'; event: AuthoringEvent }
  | { kind: 'userMessage'; text: string }
  | { kind: 'agentMessage'; text: string }
  | { kind: 'typing'; on: boolean }
  | { kind: 'seedEval'; names: string[] }
  | { kind: 'publish' }
  | { kind: 'reset' };

function reducer(state: CreatorState, action: CreatorAction): CreatorState {
  switch (action.kind) {
    case 'event':
      return reduceCreator(state, action.event);
    case 'userMessage':
      return pushMessage(state, 'user', action.text);
    case 'agentMessage':
      return pushMessage(state, 'agent', action.text);
    case 'typing':
      return setTyping(state, action.on);
    case 'seedEval':
      return seedEvalCaseNames(state, action.names);
    case 'publish':
      return publish(state);
    case 'reset':
      return initialCreatorState(MOCK_MANIFEST);
    default:
      return state;
  }
}

// ── phase → action-dock labels ───────────────────────────────────────────────

// Brand violet — amber/yellow is off the current aesthetic system (feedback).
const ACCENT = grammarAccentClasses.violet;

export function CreatorSurface({ agentId, draftId: draftIdProp }: CreatorSurfaceProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const { addToast } = useApp();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  // Workspace + agent roster come from the shared studio context (CONTRACT §6a),
  // not a direct MOCK_OVERVIEW import — real-first, mock-fallback is resolved upstream.
  const { agents } = useStudioContext();

  // Orchestrator resolution (§3.1): explicit agent prop → workspace orchestrator
  // → first agent. With an empty roster we render the explicit gated CTA.
  const authoringAgent = useMemo(() => {
    if (agentId) return agents.find((a) => a.id === agentId) ?? null;
    return agents.find((a) => a.isOrchestrator) ?? agents[0] ?? null;
  }, [agentId, agents]);

  const draftId = draftIdProp ?? 'drf_admin';

  const [state, dispatch] = useReducer(reducer, MOCK_MANIFEST, initialCreatorState);

  // Live mode subscribes to the SSE bus; mock mode drives via the generator.
  const liveEvents = useAuthoringEvents(STUDIO_MOCK_ENABLED ? null : draftId, !STUDIO_MOCK_ENABLED);
  const liveCursor = useRef(0);
  useEffect(() => {
    if (STUDIO_MOCK_ENABLED) return;
    for (let i = liveCursor.current; i < liveEvents.length; i++) {
      dispatch({ kind: 'event', event: liveEvents[i] });
    }
    liveCursor.current = liveEvents.length;
  }, [liveEvents]);

  // ── SKILL.md local typewriter (mock has no preview.delta) ──
  const [skillMd, setSkillMd] = useState('');
  const typerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mdFile = state.files.find((f) => f.path === 'SKILL.md');
  const jsonFile = state.files.find((f) => f.path === 'skill.json');
  // skill.json is a settled artifact — derive it, no effect/setState needed.
  // (Live mode streams only SKILL.md per the AuthoringEvent contract; skill.json
  // content arrives with the written-file fixture once wiring lands.)
  const skillJson = STUDIO_MOCK_ENABLED && jsonFile?.status === 'done' ? MOCK_SKILL_JSON : '';

  useEffect(() => {
    if (!STUDIO_MOCK_ENABLED) return; // live: skillMd comes from preview.delta in the reducer
    if (mdFile?.status === 'writing' && !typerRef.current && skillMd.length === 0) {
      let i = 0;
      const step = reduce ? MOCK_SKILL_MD.length : 6;
      typerRef.current = setInterval(() => {
        i = Math.min(i + step, MOCK_SKILL_MD.length);
        setSkillMd(MOCK_SKILL_MD.slice(0, i));
        if (i >= MOCK_SKILL_MD.length && typerRef.current) {
          clearInterval(typerRef.current);
          typerRef.current = null;
        }
      }, 40);
    }
    return () => {
      if (typerRef.current) {
        clearInterval(typerRef.current);
        typerRef.current = null;
      }
    };
  }, [mdFile?.status, reduce, skillMd.length]);

  // streaming flag: live = reducer's streamingMd; mock = md still typing
  const mdStreaming = STUDIO_MOCK_ENABLED ? skillMd.length > 0 && skillMd.length < MOCK_SKILL_MD.length : state.streamingMd;
  const effectiveMd = STUDIO_MOCK_ENABLED ? skillMd : state.skillMd;

  // Seed eval case names when entering eval (mock events carry only indices).
  useEffect(() => {
    if (STUDIO_MOCK_ENABLED && state.phase === 'evaluating' && state.evalCases.every((c) => c.ms === 0 || !c.name)) {
      dispatch({ kind: 'seedEval', names: MOCK_EVAL_RUN.cases.map((c) => c.name) });
    }
  }, [state.phase, state.evalCases]);

  // ── mock authoring run (kicked off by Start building) ──
  const runCancel = useRef<(() => void) | null>(null);
  const stopRun = useCallback(() => {
    runCancel.current?.();
    runCancel.current = null;
  }, []);
  useEffect(() => () => stopRun(), [stopRun]);

  const startMockRun = useCallback(() => {
    if (!STUDIO_MOCK_ENABLED) return;
    stopRun();
    runCancel.current = simulateAuthoringRun(draftId, (event) => dispatch({ kind: 'event', event }));
  }, [draftId, stopRun]);

  // ── steering interactions ──
  const onSend = useCallback(
    (text: string) => {
      dispatch({ kind: 'userMessage', text });
      if (state.phase === 'idle') {
        dispatch({ kind: 'typing', on: true });
        startMockRun();
      } else {
        dispatch({ kind: 'typing', on: true });
        window.setTimeout(() => {
          dispatch({ kind: 'typing', on: false });
          dispatch({ kind: 'agentMessage', text: t('evolution.studio.v2.creator.greeting') });
        }, 700);
      }
    },
    [state.phase, startMockRun, t],
  );

  const onSource = useCallback(
    (kind: CreatorSourceKind) => {
      dispatch({
        kind: 'userMessage',
        text: t(`evolution.studio.v2.creator.sources.${kind}` as `evolution.${string}`),
      });
      if (state.phase === 'idle') startMockRun();
    },
    [state.phase, startMockRun, t],
  );

  const onQuickReply = useCallback(
    (action: string) => {
      dispatch({ kind: 'userMessage', text: action });
    },
    [],
  );

  // ── action-dock primary button (phase state machine, §3.4) ──
  const primary = primaryFor(state.phase);
  const onPrimary = useCallback(() => {
    switch (state.phase) {
      case 'idle':
      case 'drafting':
        startMockRun();
        break;
      case 'draftReady':
        // Run eval — the mock run streams straight through eval, so re-kick if
        // the run already completed its compose leg without eval (defensive).
        if (state.evalCases.length === 0) startMockRun();
        break;
      case 'evaluated':
        dispatch({ kind: 'publish' });
        dispatch({ kind: 'agentMessage', text: t('evolution.studio.v2.creator.published') });
        addToast(`${t('evolution.studio.v2.creator.published')} · sandbox-admin-debug`, 'success');
        break;
      default:
        break;
    }
  }, [state.phase, state.evalCases.length, startMockRun, addToast, t]);

  // Promote celebration when phase flips to published.
  const published = state.phase === 'published';

  const skillName = state.skillName || 'sandbox-admin-debug';
  const skillSlug = state.skillSlug || 'slug · auto-detected from intent';
  const statusLabel = statusLabelFor(state.phase, state.passRate, t);

  // First-visit greeting (prototype): an agent bubble before any user action.
  // It does NOT mark the canvas started, so the empty-canvas state still shows.
  const greeting: SteeringMessage = {
    id: 'greeting',
    role: 'agent',
    text: t('evolution.studio.v2.creator.greeting'),
  };
  const steeringMessages: SteeringMessage[] =
    state.messages.length === 0 ? [greeting] : state.messages;
  const busy = state.phase === 'building' || state.phase === 'evaluating';

  // ── render ──

  // Gated honesty (§3.5): no orchestrator authorized → explicit CTA, no fallback.
  if (!authoringAgent) {
    return <NoOrchestrator />;
  }

  return (
    // Bounded-height shell content: fill the shell's <main> exactly, never
    // overflow. Padding keeps both rounded panes off the shell edges; the
    // two panes carry the same radius.pane so the whole creator is one
    // consistent rounded-rectangle system.
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(340px,41%)_minmax(0,1fr)]">
      {/* left — steering (header + thread + source bench + composer, all in one pane) */}
      <SteeringPane
        agentHandle={authoringAgent.handle}
        agentType={authoringAgent.type}
        messages={steeringMessages}
        typing={state.typing}
        busy={busy}
        onSend={onSend}
        onSource={onSource}
        onQuickReply={onQuickReply}
      />

      {/* right — canvas + dock (single rounded pane; canvas scrolls, dock pinned) */}
      <div className={cn('flex min-h-0 flex-col overflow-hidden border', radius.pane, s(theme, 'pane'))}>
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {state.started ? (
            <ArtifactCanvas
              phase={state.phase}
              skillName={skillName}
              skillSlug={skillSlug}
              statusLabel={statusLabel}
              files={state.files}
              sources={state.sources}
              skillMd={effectiveMd}
              skillJson={skillJson}
              streaming={mdStreaming}
              evalCases={state.evalCases}
              passRate={state.passRate}
              activity={state.activity}
            />
          ) : (
            <EmptyCanvas />
          )}
        </div>

        {/* action dock — pinned at the pane bottom */}
        <div className={cn('flex shrink-0 items-center gap-2 border-t border-current/[0.06] px-4 py-3', s(theme, 'inset'))}>
          <span className={cn('min-w-0 flex-1 truncate text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
            {dockStatusFor(state.phase, state.passRate, t)}
          </span>
          {(state.phase === 'draftReady' || state.phase === 'evaluated') && !published ? (
            <Button variant="outline" size="sm" onClick={() => addToast(t('evolution.studio.v2.creator.regenerate'), 'info')}>
              <RefreshCw className="size-3.5" aria-hidden />
              {state.phase === 'evaluated'
                ? t('evolution.studio.v2.creator.autoOptimize')
                : t('evolution.studio.v2.creator.regenerate')}
            </Button>
          ) : null}
          <motion.div
            animate={published && !reduce ? { scale: [1, 1.06, 1] } : undefined}
            transition={published ? springSplat : undefined}
          >
            <Button
              onClick={onPrimary}
              disabled={primary.disabled || published}
              size="sm"
              className="bg-[var(--prismer-primary)] text-white hover:bg-[var(--prismer-primary)]/90"
            >
              {t(primary.labelKey)}
              {!published && primary.showArrow ? <ArrowRight className="size-3.5" aria-hidden /> : null}
            </Button>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// ── phase → dock copy + button label ─────────────────────────────────────────

interface PrimarySpec {
  labelKey: `evolution.${string}`;
  disabled: boolean;
  showArrow: boolean;
}

function primaryFor(phase: CreatorPhase): PrimarySpec {
  switch (phase) {
    case 'idle':
    case 'drafting':
      return { labelKey: 'evolution.studio.v2.creator.startBuilding', disabled: false, showArrow: true };
    case 'building':
      return { labelKey: 'evolution.studio.v2.creator.building', disabled: true, showArrow: false };
    case 'draftReady':
      return { labelKey: 'evolution.studio.v2.creator.runEval', disabled: false, showArrow: true };
    case 'evaluating':
      return { labelKey: 'evolution.studio.v2.creator.evaluating', disabled: true, showArrow: false };
    case 'evaluated':
      return { labelKey: 'evolution.studio.v2.creator.promote', disabled: false, showArrow: true };
    case 'published':
      return { labelKey: 'evolution.studio.v2.creator.published', disabled: true, showArrow: false };
    default:
      return { labelKey: 'evolution.studio.v2.creator.startBuilding', disabled: false, showArrow: true };
  }
}

function statusLabelFor(
  phase: CreatorPhase,
  passRate: number | null,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (phase) {
    case 'idle':
    case 'drafting':
      return t('evolution.studio.v2.creator.status.drafting');
    case 'building':
      return t('evolution.studio.v2.creator.status.building');
    case 'draftReady':
      return t('evolution.studio.v2.creator.status.draftReady');
    case 'evaluating':
      return t('evolution.studio.v2.creator.status.evaluating');
    case 'evaluated':
      return passRate != null
        ? t('evolution.studio.v2.creator.status.passRate', { rate: passRate })
        : t('evolution.studio.v2.creator.status.evaluating');
    case 'published':
      return t('evolution.studio.v2.creator.status.published');
    default:
      return t('evolution.studio.v2.creator.status.drafting');
  }
}

function dockStatusFor(
  phase: CreatorPhase,
  passRate: number | null,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (phase) {
    case 'evaluated':
      return passRate != null
        ? t('evolution.studio.v2.creator.status.passRate', { rate: passRate })
        : t('evolution.studio.v2.creator.evalSession');
    case 'evaluating':
      return t('evolution.studio.v2.creator.evalSession');
    case 'published':
      return t('evolution.studio.v2.creator.status.published');
    default:
      return t('evolution.studio.v2.creator.steeringHint');
  }
}

// ── empty / gated states ─────────────────────────────────────────────────────

function EmptyCanvas() {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      {/* breathing ring: dashed accent halo (border inherits accent via text-color) + inner solid glyph */}
      <motion.div
        className={cn('relative flex size-24 items-center justify-center rounded-full border-2 border-dashed border-current/30', ACCENT.text)}
        animate={reduce ? undefined : { scale: [1, 1.06, 1], opacity: [0.85, 1, 0.85] }}
        transition={reduce ? undefined : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      >
        <div className={cn('flex size-14 items-center justify-center rounded-full border', ACCENT.bg)}>
          <Sparkles className={cn('size-7', ACCENT.text)} aria-hidden />
        </div>
      </motion.div>
      <div className="space-y-2">
        <h3 className={cn('text-lg font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
          {t('evolution.studio.v2.creator.emptyCanvasTitle')}
        </h3>
        <p className={cn('max-w-sm text-sm', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
          {t('evolution.studio.v2.creator.emptyCanvasHint')}
        </p>
      </div>
    </div>
  );
}

function NoOrchestrator() {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <motion.div
        initial={reduce ? false : { scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={springSoft}
        className={cn('flex size-20 items-center justify-center border', radius.card, s(theme, 'card'), ACCENT.ring, 'ring-1')}
      >
        <WifiOff className={cn('size-9', ACCENT.text)} aria-hidden />
      </motion.div>
      <p className={cn('max-w-md text-sm', isDark ? 'text-zinc-300' : 'text-zinc-700')}>
        {t('evolution.studio.v2.creator.noOrchestrator')}
      </p>
      <Button className="bg-[var(--prismer-primary)] text-white hover:bg-[var(--prismer-primary)]/90">
        <UserPlus className="size-4" aria-hidden />
        {t('evolution.studio.v2.creator.authorizeOrchestrator')}
      </Button>
    </div>
  );
}
