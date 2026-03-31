'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Check, Circle, FlaskConical, Dna, Sparkles, ExternalLink, GitFork, AlertCircle } from 'lucide-react';
import { glass, CAT_COLORS } from './helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DistillationLabProps {
  isDark: boolean;
  isAuthenticated: boolean;
}

type Phase = 'brewing' | 'ready' | 'processing' | 'complete';

interface DistillStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  description?: string;
}

interface ReadinessCheck {
  ready: boolean;
  capsule_count?: number;
  required_count?: number;
  success_rate?: number;
  cooldown_remaining_ms?: number;
  eligible_capsules?: CapsuleEntry[];
}

interface CapsuleEntry {
  id: string;
  gene_id?: string;
  signal?: string;
  summary?: string;
  outcome?: string;
  score?: number;
  created_at?: string;
}

interface DistillResult {
  ok?: boolean;
  data?: {
    gene?: {
      id?: string;
      gene_id?: string;
      title?: string;
      category?: string;
      signals?: string[];
      signals_match?: Array<string | { type: string }>;
      strategy?: { steps?: string[] } | string[];
    };
    quality?: {
      capsule_count?: number;
      signal_coverage?: number;
      confidence?: number;
    };
    critique?: string;
  };
  error?: string;
}

interface HistoryEntry {
  gene_title: string;
  category: string;
  created_at: string;
  status: 'success' | 'failed';
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token || null;
  } catch {
    return null;
  }
}

/** Cancellable delay — rejects if abortSignal fires */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function updateStep(
  steps: DistillStep[],
  id: string,
  status: DistillStep['status'],
  description?: string,
): DistillStep[] {
  return steps.map((s) => (s.id === id ? { ...s, status, description: description ?? s.description } : s));
}

function formatCooldown(ms: number): string {
  if (ms <= 0) return 'Ready';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m remaining`;
  return `${mins}m remaining`;
}

function getResultSignals(gene: DistillResult['data']): string[] {
  const g = gene?.gene;
  if (!g) return [];
  if (g.signals && Array.isArray(g.signals)) return g.signals;
  if (g.signals_match) {
    return g.signals_match.map((s) => (typeof s === 'string' ? s : s?.type || '')).filter(Boolean);
  }
  return [];
}

function getResultSteps(gene: DistillResult['data']): string[] {
  const g = gene?.gene;
  if (!g) return [];
  if (Array.isArray(g.strategy)) return g.strategy as string[];
  if (g.strategy && typeof g.strategy === 'object' && Array.isArray(g.strategy.steps)) return g.strategy.steps;
  return [];
}

const INITIAL_STEPS: DistillStep[] = [
  { id: 'collect', label: '\u91C7\u96C6\u539F\u6599', status: 'pending' },
  { id: 'analyze', label: '\u5206\u6790\u4FE1\u53F7\u6A21\u5F0F', status: 'pending' },
  { id: 'synthesize', label: 'LLM \u7B56\u7565\u5408\u6210', status: 'pending' },
  { id: 'evaluate', label: '\u8D28\u91CF\u8BC4\u4F30', status: 'pending' },
  { id: 'generate', label: 'Gene \u751F\u6210', status: 'pending' },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Flask({ progress, bubbling }: { progress: number; bubbling: boolean }) {
  // Use deterministic bubble positions to avoid hydration issues
  const bubbles = [
    { cx: 45, r: 3, dur: 1.2 },
    { cx: 55, r: 2.5, dur: 1.5 },
    { cx: 65, r: 4, dur: 1.0 },
    { cx: 50, r: 2, dur: 1.8 },
    { cx: 70, r: 3.5, dur: 1.3 },
  ];

  return (
    <svg viewBox="0 0 120 160" className="w-24 h-32 mx-auto" aria-label="Distillation flask">
      <defs>
        <linearGradient id="liquid-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(139, 92, 246, 0.6)" />
          <stop offset="100%" stopColor="rgba(79, 70, 229, 0.8)" />
        </linearGradient>
        <clipPath id="flask-clip">
          <path d="M42,80 L22,140 Q17,153 30,153 L90,153 Q103,153 98,140 L78,80 Z" />
        </clipPath>
      </defs>
      {/* Flask outline */}
      <path
        d="M40,20 L40,80 L20,140 Q15,155 30,155 L90,155 Q105,155 100,140 L80,80 L80,20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-zinc-600"
      />
      {/* Flask top */}
      <rect
        x="35"
        y="10"
        width="50"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-zinc-600"
      />
      {/* Liquid fill */}
      <rect
        x="15"
        y={155 - progress * 75}
        width="90"
        height={progress * 75}
        fill="url(#liquid-gradient)"
        clipPath="url(#flask-clip)"
        style={{ transition: 'y 0.6s ease-out, height 0.6s ease-out' }}
      />
      {/* Bubbles */}
      {bubbling &&
        bubbles.map((b, i) => (
          <circle
            key={i}
            cx={b.cx}
            cy={130 - progress * 60}
            r={b.r}
            fill="rgba(139, 92, 246, 0.4)"
            style={{
              animation: `distill-bubble-rise ${b.dur}s ease-out infinite`,
              animationDelay: `${i * 0.3}s`,
            }}
          />
        ))}
    </svg>
  );
}

function ConditionRow({
  met,
  label,
  detail,
  isDark,
}: {
  met: boolean;
  label: string;
  detail: string;
  isDark: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
          met
            ? 'bg-emerald-500/15 text-emerald-400'
            : isDark
              ? 'bg-zinc-800 text-zinc-500'
              : 'bg-zinc-200 text-zinc-400'
        }`}
      >
        {met ? '\u2713' : '\u25CB'}
      </span>
      <span className={`text-sm flex-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{label}</span>
      <span
        className={`text-xs tabular-nums ${met ? 'text-emerald-400' : isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
        style={!met ? { animation: 'distill-breathe 3s ease-in-out infinite' } : undefined}
      >
        {detail}
      </span>
    </div>
  );
}

function PipelineStep({ step, isDark }: { step: DistillStep; isDark: boolean }) {
  const statusIcon = (() => {
    switch (step.status) {
      case 'done':
        return <Check className="w-4 h-4 text-emerald-400" />;
      case 'running':
        return <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      default:
        return <Circle className={`w-4 h-4 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} />;
    }
  })();

  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="shrink-0 mt-0.5">{statusIcon}</span>
      <div className="flex-1 min-w-0">
        <span
          className={`text-sm font-medium ${
            step.status === 'done'
              ? 'text-emerald-400'
              : step.status === 'running'
                ? isDark
                  ? 'text-white'
                  : 'text-zinc-900'
                : step.status === 'error'
                  ? 'text-red-400'
                  : isDark
                    ? 'text-zinc-500'
                    : 'text-zinc-400'
          }`}
        >
          {step.label}
        </span>
        {step.status === 'done' && (
          <span className={`ml-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{'\u2713'} done</span>
        )}
        {step.description && step.status === 'running' && (
          <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{step.description}</p>
        )}
      </div>
    </div>
  );
}

function SparkleParticle({ index }: { index: number }) {
  const angle = (index / 8) * Math.PI * 2;
  const tx = Math.cos(angle) * (40 + Math.random() * 20);
  const ty = Math.sin(angle) * (40 + Math.random() * 20);
  return (
    <span
      className="absolute w-2 h-2 rounded-full bg-violet-400"
      style={
        {
          top: '50%',
          left: '50%',
          '--tx': `${tx}px`,
          '--ty': `${ty}px`,
          animation: `distill-sparkle 0.8s ease-out forwards`,
          animationDelay: `${index * 0.05}s`,
        } as React.CSSProperties
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function DistillationLab({ isDark, isAuthenticated }: DistillationLabProps) {
  const [phase, setPhase] = useState<Phase>('brewing');
  const [readiness, setReadiness] = useState<ReadinessCheck | null>(null);
  const [selectedCapsules, setSelectedCapsules] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<DistillStep[]>(INITIAL_STEPS);
  const [overallProgress, setOverallProgress] = useState(0);
  const [distillResult, setDistillResult] = useState<DistillResult | null>(null);
  const [dryRunResult, setDryRunResult] = useState<ReadinessCheck | null>(null);
  const [showDryRun, setShowDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [distillHistory, setDistillHistory] = useState<HistoryEntry[]>([]);
  const [typewriterText, setTypewriterText] = useState('');
  const [showGeneCard, setShowGeneCard] = useState(false);
  const [showButtons, setShowButtons] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ---- Fetch readiness on mount ----
  const fetchReadiness = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/im/evolution/distill?dry_run=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = await res.json();
      const check: ReadinessCheck = data.data || data;
      setReadiness(check);

      if (check.ready) {
        setPhase('ready');
        // Auto-select all eligible (success) capsules
        const eligible = (check.eligible_capsules || []).filter((c) => c.outcome === 'success');
        setSelectedCapsules(new Set(eligible.map((c) => c.id)));
      } else {
        setPhase('brewing');
      }
    } catch {
      // Silently handle — show brewing state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchReadiness();
  }, [isAuthenticated, fetchReadiness]);

  // ---- Cleanup ----
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ---- Dry run ----
  const handleDryRun = async () => {
    const token = getToken();
    if (!token) return;
    setShowDryRun(false);
    try {
      const res = await fetch('/api/im/evolution/distill?dry_run=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setDryRunResult(data.data || data);
      setShowDryRun(true);
    } catch {
      setError('Dry run failed. Please try again.');
    }
  };

  // ---- Start distillation ----
  const handleDistill = async () => {
    const token = getToken();
    if (!token) return;

    setPhase('processing');
    setError(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'pending' as const })));
    setOverallProgress(0);
    setDistillResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // Start API call immediately
    const apiPromise = fetch('/api/im/evolution/distill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        capsule_ids: Array.from(selectedCapsules),
      }),
      signal: controller.signal,
    }).then((r) => r.json());

    const sig = controller.signal;

    try {
      // Step 1: Collect
      setSteps((prev) =>
        updateStep(prev, 'collect', 'running', '\u6B63\u5728\u6536\u96C6\u7B26\u5408\u6761\u4EF6\u7684 capsules...'),
      );
      setOverallProgress(5);
      await delay(300, sig);
      setSteps((prev) => updateStep(prev, 'collect', 'done'));
      setOverallProgress(15);

      // Step 2: Analyze
      setSteps((prev) =>
        updateStep(prev, 'analyze', 'running', '\u5206\u6790\u4FE1\u53F7\u5206\u5E03\u548C\u6210\u529F\u6A21\u5F0F...'),
      );
      setOverallProgress(25);
      await delay(1100, sig);
      setSteps((prev) => updateStep(prev, 'analyze', 'done'));
      setOverallProgress(40);

      // Step 3: Synthesize (waits for API)
      setSteps((prev) =>
        updateStep(
          prev,
          'synthesize',
          'running',
          `\u6B63\u5728\u4ECE ${selectedCapsules.size} \u4E2A\u6210\u529F\u6848\u4F8B\u4E2D\u63D0\u53D6\u5171\u6027\u7B56\u7565...`,
        ),
      );
      setOverallProgress(50);

      const result: DistillResult = await apiPromise;

      if (!result.ok && result.error) {
        setSteps((prev) => updateStep(prev, 'synthesize', 'error', result.error));
        setError(result.error);
        setOverallProgress(50);
        return;
      }

      // Step 3 done
      setSteps((prev) => updateStep(prev, 'synthesize', 'done'));
      setOverallProgress(65);

      // Step 4: Evaluate
      await delay(200, sig);
      setSteps((prev) =>
        updateStep(
          prev,
          'evaluate',
          'running',
          '\u8BC4\u4F30\u5408\u6210\u8D28\u91CF\u548C\u4FE1\u53F7\u8986\u76D6\u7387...',
        ),
      );
      setOverallProgress(75);
      await delay(500, sig);
      setSteps((prev) => updateStep(prev, 'evaluate', 'done'));
      setOverallProgress(85);

      // Step 5: Generate
      await delay(200, sig);
      setSteps((prev) =>
        updateStep(prev, 'generate', 'running', '\u751F\u6210 Gene \u5E76\u5199\u5165\u77E5\u8BC6\u5E93...'),
      );
      setOverallProgress(92);
      await delay(600, sig);
      setSteps((prev) => updateStep(prev, 'generate', 'done'));
      setOverallProgress(100);

      // Transition to complete
      await delay(400, sig);
      setDistillResult(result);
      setPhase('complete');

      // Typewriter effect for title
      const title = result.data?.gene?.title || 'New Gene';
      typewriterEffect(title);

      // Stagger the card and buttons (abort-safe)
      if (!sig.aborted) await delay(600, sig).catch(() => {});
      if (!sig.aborted) setShowGeneCard(true);
      if (!sig.aborted) await delay(400, sig).catch(() => {});
      if (!sig.aborted) setShowButtons(true);

      // Add to history
      setDistillHistory((prev) => [
        {
          gene_title: title,
          category: result.data?.gene?.category || 'unknown',
          created_at: new Date().toISOString(),
          status: 'success',
        },
        ...prev.slice(0, 2),
      ]);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError('Distillation failed. Please try again.');
      setSteps((prev) => {
        const running = prev.find((s) => s.status === 'running');
        if (running) return updateStep(prev, running.id, 'error', 'Failed');
        return prev;
      });
    }
  };

  const typewriterEffect = (text: string) => {
    setTypewriterText('');
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setTypewriterText(text.slice(0, i));
      if (i >= text.length) clearInterval(interval);
    }, 50);
  };

  // ---- Reset ----
  const handleReset = () => {
    setPhase('brewing');
    setSteps(INITIAL_STEPS);
    setOverallProgress(0);
    setDistillResult(null);
    setError(null);
    setShowDryRun(false);
    setDryRunResult(null);
    setTypewriterText('');
    setShowGeneCard(false);
    setShowButtons(false);
    fetchReadiness();
  };

  // ---- Computed values ----
  const capsuleCount = readiness?.capsule_count ?? 0;
  const requiredCount = readiness?.required_count ?? 10;
  const successRate = readiness?.success_rate ?? 0;
  const cooldownMs = readiness?.cooldown_remaining_ms ?? 0;
  const capsulesMet = capsuleCount >= requiredCount;
  const rateMet = successRate >= 70;
  const cooldownMet = cooldownMs <= 0;
  const progressRatio = Math.min(capsuleCount / requiredCount, 1);
  const almostReady = capsuleCount >= requiredCount - 2 && !readiness?.ready;

  const eligibleCapsules = (readiness?.eligible_capsules || []).filter((c) => c.outcome === 'success');
  const failedCapsules = (readiness?.eligible_capsules || []).filter((c) => c.outcome !== 'success');

  // ---- Not authenticated ----
  if (!isAuthenticated) {
    return (
      <div className={`rounded-xl p-8 text-center ${glass(isDark)}`}>
        <FlaskConical className={`w-8 h-8 mx-auto mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          Sign in to access the Distillation Lab
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`rounded-xl p-12 flex justify-center ${glass(isDark)}`}>
        <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
      </div>
    );
  }

  return (
    <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
      {/* Inline styles for keyframe animations */}
      <style>{`
        @keyframes distill-shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes distill-pulse-border {
          0%, 100% { box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.15); }
          50% { box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.4); }
        }
        @keyframes distill-breathe {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes distill-bubble-rise {
          0% { transform: translateY(0) scale(1); opacity: 0.7; }
          100% { transform: translateY(-40px) scale(0.3); opacity: 0; }
        }
        @keyframes distill-gene-emerge {
          0% { transform: scale(0) rotate(0deg); opacity: 0; }
          60% { transform: scale(1.2) rotate(360deg); opacity: 1; }
          100% { transform: scale(1) rotate(360deg); }
        }
        @keyframes distill-sparkle {
          0% { transform: translate(0, 0) scale(1); opacity: 1; }
          100% { transform: translate(var(--tx), var(--ty)) scale(0); opacity: 0; }
        }
        @keyframes distill-slide-up {
          0% { transform: translateY(20px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes distill-stagger-in {
          0% { transform: translateY(12px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes distill-dot-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.3); }
        }
      `}</style>

      {/* Header */}
      <div
        className={`px-5 py-3 border-b flex items-center justify-between ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
      >
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-violet-400" />
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Distillation Lab</h3>
          {phase === 'processing' && (
            <span className="text-[10px] uppercase tracking-wider text-violet-400 font-semibold ml-2">Processing</span>
          )}
          {phase === 'complete' && (
            <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-semibold ml-2">Complete</span>
          )}
        </div>
        {(phase === 'complete' || error) && (
          <button
            onClick={handleReset}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${
              isDark
                ? 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                : 'text-zinc-500 hover:text-zinc-700 hover:bg-black/5'
            }`}
          >
            Reset
          </button>
        )}
      </div>

      <div className="p-5">
        {/* ================================================================ */}
        {/* PHASE: BREWING                                                    */}
        {/* ================================================================ */}
        {phase === 'brewing' && (
          <div className="space-y-5">
            {/* Progress dots */}
            <div className="text-center">
              <div className="flex items-center justify-center gap-1.5 mb-3">
                {Array.from({ length: requiredCount }).map((_, i) => (
                  <span
                    key={i}
                    className={`w-3 h-3 rounded-full transition-all duration-300 ${
                      i < capsuleCount ? 'bg-violet-500' : isDark ? 'bg-zinc-700' : 'bg-zinc-200'
                    }`}
                    style={
                      i < capsuleCount
                        ? { animation: `distill-dot-pulse 2s ease-in-out infinite`, animationDelay: `${i * 0.1}s` }
                        : undefined
                    }
                  />
                ))}
              </div>
              <p className={`text-sm font-semibold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                {capsuleCount} / {requiredCount} successful capsules
              </p>
              {/* Progress bar */}
              <div className={`mt-2 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${progressRatio * 100}%`,
                    background: 'linear-gradient(90deg, #8b5cf6, #06b6d4, #8b5cf6)',
                    backgroundSize: '200% 100%',
                    animation: 'distill-shimmer 2s linear infinite',
                    transition: 'width 0.5s ease-out',
                  }}
                />
              </div>
            </div>

            {/* Conditions */}
            <div className={`rounded-lg p-4 space-y-2.5 ${isDark ? 'bg-zinc-900/50' : 'bg-zinc-50'}`}>
              <ConditionRow
                met={capsulesMet}
                label="Successful Capsules"
                detail={
                  capsulesMet
                    ? `${capsuleCount}/${requiredCount} \u2713`
                    : `${requiredCount - capsuleCount} more needed`
                }
                isDark={isDark}
              />
              <ConditionRow
                met={rateMet}
                label="Success Rate"
                detail={`${Math.round(successRate)}% ${rateMet ? '\u2265' : '<'} 70%`}
                isDark={isDark}
              />
              <ConditionRow
                met={cooldownMet}
                label="Cooldown"
                detail={cooldownMet ? 'Ready' : formatCooldown(cooldownMs)}
                isDark={isDark}
              />
            </div>

            {/* Capsule trail (simplified) */}
            {capsuleCount > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {Array.from({ length: Math.min(capsuleCount, 15) }).map((_, i) => (
                  <span key={i} className="inline-flex items-center gap-0.5">
                    <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 text-[9px] font-bold flex items-center justify-center">
                      {'\u2713'}
                    </span>
                    {i < Math.min(capsuleCount, 15) - 1 && (
                      <span className={`w-3 h-px ${isDark ? 'bg-zinc-700' : 'bg-zinc-300'}`} />
                    )}
                  </span>
                ))}
                {capsuleCount < requiredCount &&
                  Array.from({ length: Math.min(requiredCount - capsuleCount, 5) }).map((_, i) => (
                    <span key={`empty-${i}`} className="inline-flex items-center gap-0.5">
                      <span className={`w-3 h-px ${isDark ? 'bg-zinc-700' : 'bg-zinc-300'}`} />
                      <span
                        className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] ${
                          isDark ? 'bg-zinc-800 text-zinc-600' : 'bg-zinc-200 text-zinc-400'
                        }`}
                      >
                        {'\u25CB'}
                      </span>
                    </span>
                  ))}
              </div>
            )}

            {/* Distill button (disabled) */}
            <button
              disabled
              className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all cursor-not-allowed ${
                isDark
                  ? 'bg-violet-500/10 text-violet-400/50 border border-violet-500/20'
                  : 'bg-violet-50 text-violet-300 border border-violet-200'
              }`}
              style={almostReady ? { animation: 'distill-pulse-border 2s ease-in-out infinite' } : undefined}
            >
              <FlaskConical className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
              Distill
              {almostReady && (
                <span
                  className="ml-2 text-xs opacity-70"
                  style={{ animation: 'distill-breathe 3s ease-in-out infinite' }}
                >
                  (almost ready)
                </span>
              )}
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/* PHASE: READY                                                      */}
        {/* ================================================================ */}
        {phase === 'ready' && (
          <div className="space-y-5">
            {/* Status banner */}
            <div
              className={`rounded-lg p-4 ${isDark ? 'bg-emerald-500/5 border border-emerald-500/20' : 'bg-emerald-50 border border-emerald-200'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-emerald-400 text-sm font-bold flex items-center gap-1.5">
                  <Check className="w-4 h-4" /> All conditions met
                </span>
              </div>
              <div className={`flex flex-wrap gap-3 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                <span>
                  {capsuleCount}/{requiredCount} capsules {'\u2713'}
                </span>
                <span>{'\u00B7'}</span>
                <span>
                  {Math.round(successRate)}% success {'\u2713'}
                </span>
                <span>{'\u00B7'}</span>
                <span>Cooldown complete {'\u2713'}</span>
              </div>
            </div>

            {/* Eligible capsule list */}
            <div>
              <h4
                className={`text-xs font-semibold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
              >
                Eligible Capsules ({eligibleCapsules.length})
              </h4>
              <div className={`rounded-lg overflow-hidden border ${isDark ? 'border-white/5' : 'border-zinc-200'}`}>
                {eligibleCapsules.map((capsule) => (
                  <label
                    key={capsule.id}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                      isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'
                    } ${isDark ? 'border-b border-white/[0.03]' : 'border-b border-zinc-100'} last:border-b-0`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedCapsules.has(capsule.id)}
                      onChange={() => {
                        setSelectedCapsules((prev) => {
                          const next = new Set(prev);
                          if (next.has(capsule.id)) next.delete(capsule.id);
                          else next.add(capsule.id);
                          return next;
                        });
                      }}
                      className="accent-violet-500 w-3.5 h-3.5"
                    />
                    <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 text-[9px] font-bold flex items-center justify-center shrink-0">
                      {'\u2713'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        {capsule.signal || capsule.gene_id || capsule.id}
                      </p>
                      <p className={`text-xs truncate ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {capsule.summary || 'No summary'}
                      </p>
                    </div>
                    {capsule.created_at && (
                      <span className={`text-[10px] shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        {new Date(capsule.created_at).toLocaleDateString()}
                      </span>
                    )}
                  </label>
                ))}
                {failedCapsules.length > 0 && (
                  <div
                    className={`px-4 py-2 text-xs ${isDark ? 'text-zinc-600 bg-zinc-900/30' : 'text-zinc-400 bg-zinc-50'}`}
                  >
                    {failedCapsules.length} failed capsule{failedCapsules.length !== 1 ? 's' : ''} excluded
                  </div>
                )}
              </div>
            </div>

            {/* Dry Run Result */}
            {showDryRun && dryRunResult && (
              <div
                className={`rounded-lg p-4 border ${isDark ? 'border-violet-500/20 bg-violet-500/5' : 'border-violet-200 bg-violet-50'}`}
                style={{ animation: 'distill-slide-up 0.3s ease-out' }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-semibold ${isDark ? 'text-violet-300' : 'text-violet-600'}`}>
                    Dry Run Preview (no gene created)
                  </span>
                  <button
                    onClick={() => setShowDryRun(false)}
                    className={`text-xs ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}
                  >
                    Close
                  </button>
                </div>
                <div className={`text-xs space-y-1 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                  <p>Ready: {dryRunResult.ready ? '\u2713' : '\u2717'}</p>
                  <p>Eligible capsules: {dryRunResult.capsule_count || 0}</p>
                  <p>Success rate: {Math.round(dryRunResult.success_rate || 0)}%</p>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3">
              <button
                onClick={handleDryRun}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isDark
                    ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
                    : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 border border-zinc-200'
                }`}
              >
                <FlaskConical className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                Dry Run
              </button>
              <button
                onClick={handleDistill}
                disabled={selectedCapsules.size === 0}
                className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all ${
                  selectedCapsules.size > 0
                    ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500 shadow-lg shadow-violet-500/20'
                    : isDark
                      ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                      : 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
                }`}
              >
                Start Distillation
              </button>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/* PHASE: PROCESSING                                                 */}
        {/* ================================================================ */}
        {phase === 'processing' && (
          <div className="space-y-6">
            {/* Flask animation */}
            <div className="text-center py-4">
              <Flask progress={overallProgress / 100} bubbling={overallProgress > 0 && overallProgress < 100} />
              <p
                className={`text-xs mt-3 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                style={{ animation: 'distill-breathe 3s ease-in-out infinite' }}
              >
                Distilling knowledge from capsules...
              </p>
            </div>

            {/* Pipeline steps */}
            <div className={`rounded-lg p-4 ${isDark ? 'bg-zinc-900/50' : 'bg-zinc-50'}`}>
              {steps.map((step) => (
                <PipelineStep key={step.id} step={step} isDark={isDark} />
              ))}
            </div>

            {/* Overall progress bar */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                  {overallProgress}%
                </span>
                {overallProgress < 100 && (
                  <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    est. {overallProgress < 50 ? '~8s' : overallProgress < 80 ? '~3s' : '<1s'} remaining
                  </span>
                )}
              </div>
              <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${overallProgress}%`,
                    background: 'linear-gradient(90deg, #8b5cf6, #06b6d4, #8b5cf6)',
                    backgroundSize: '200% 100%',
                    animation: 'distill-shimmer 2s linear infinite',
                    transition: 'width 0.4s ease-out',
                  }}
                />
              </div>
            </div>

            {/* Error display */}
            {error && (
              <div
                className={`rounded-lg p-3 text-sm ${isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-600 border border-red-200'}`}
              >
                <AlertCircle className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                {error}
              </div>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/* PHASE: COMPLETE                                                   */}
        {/* ================================================================ */}
        {phase === 'complete' && distillResult && (
          <div className="space-y-5">
            {/* Gene reveal */}
            <div className="text-center py-6 relative">
              {/* Sparkle particles */}
              <div className="relative inline-block">
                {Array.from({ length: 8 }).map((_, i) => (
                  <SparkleParticle key={i} index={i} />
                ))}
                <span
                  className="inline-block text-5xl"
                  style={{ animation: 'distill-gene-emerge 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards' }}
                >
                  <Dna className="w-14 h-14 text-violet-400" />
                </span>
                <Sparkles
                  className="w-5 h-5 text-amber-400 absolute -top-1 -right-2"
                  style={{ animation: 'distill-gene-emerge 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) 0.2s both' }}
                />
              </div>
              <h3 className={`text-lg font-bold mt-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                New Gene Synthesized!
              </h3>
              <p className={`text-base font-semibold mt-1 text-violet-400`}>
                {typewriterText}
                <span
                  className="inline-block w-0.5 h-4 bg-violet-400 ml-0.5 align-middle"
                  style={{ animation: 'distill-breathe 1s step-end infinite' }}
                />
              </p>
              {distillResult.data?.gene?.category && (
                <span
                  className={`inline-block mt-2 text-xs px-2.5 py-0.5 rounded-full ${
                    CAT_COLORS[distillResult.data.gene.category]?.bg || 'bg-violet-500/10'
                  } ${CAT_COLORS[distillResult.data.gene.category]?.text || 'text-violet-400'}`}
                >
                  {distillResult.data.gene.category}
                </span>
              )}
            </div>

            {/* Gene preview card */}
            {showGeneCard && (
              <div
                className={`rounded-lg p-4 border ${isDark ? 'border-white/[0.06] bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}
                style={{ animation: 'distill-slide-up 0.4s ease-out' }}
              >
                <h4
                  className={`text-xs font-semibold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                >
                  Synthesized Gene Preview
                </h4>
                <div className={`space-y-3 text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {/* Title */}
                  <div>
                    <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Title</span>
                    <p className="font-medium">{distillResult.data?.gene?.title || 'Unnamed Gene'}</p>
                  </div>
                  {/* Category */}
                  <div>
                    <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Category</span>
                    <p>{distillResult.data?.gene?.category || 'unknown'}</p>
                  </div>
                  {/* Signals */}
                  {getResultSignals(distillResult.data).length > 0 && (
                    <div>
                      <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Signals</span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {getResultSignals(distillResult.data).map((sig, i) => (
                          <span
                            key={i}
                            className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-violet-500/10 text-violet-300' : 'bg-violet-50 text-violet-600'}`}
                          >
                            {sig}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Strategy steps */}
                  {getResultSteps(distillResult.data).length > 0 && (
                    <div>
                      <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Strategy</span>
                      <ol
                        className={`list-decimal list-inside mt-1 space-y-0.5 text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}
                      >
                        {getResultSteps(distillResult.data).map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {/* Quality */}
                  {distillResult.data?.quality && (
                    <div
                      className={`grid grid-cols-3 gap-3 pt-2 border-t ${isDark ? 'border-white/5' : 'border-zinc-200'}`}
                    >
                      <div className="text-center">
                        <p className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                          {distillResult.data.quality.capsule_count ?? 0}
                        </p>
                        <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Source Capsules</p>
                      </div>
                      <div className="text-center">
                        <p className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                          {distillResult.data.quality.signal_coverage ?? 0}
                        </p>
                        <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Signal Types</p>
                      </div>
                      <div className="text-center">
                        <p className={`text-lg font-bold tabular-nums ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                          {distillResult.data.quality.confidence != null
                            ? (distillResult.data.quality.confidence * 100).toFixed(0) + '%'
                            : '--'}
                        </p>
                        <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Confidence</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* LLM Critique */}
            {showGeneCard && distillResult.data?.critique && (
              <div
                className={`rounded-lg p-4 border ${isDark ? 'border-amber-500/10 bg-amber-500/5' : 'border-amber-200 bg-amber-50'}`}
                style={{ animation: 'distill-slide-up 0.4s ease-out 0.15s both' }}
              >
                <h4
                  className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-amber-400/80' : 'text-amber-600'}`}
                >
                  LLM Critique
                </h4>
                <p className={`text-sm leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                  &ldquo;{distillResult.data.critique}&rdquo;
                </p>
              </div>
            )}

            {/* Action buttons */}
            {showButtons && (
              <div className="grid grid-cols-3 gap-3" style={{ animation: 'distill-slide-up 0.3s ease-out' }}>
                <button
                  className={`py-2.5 rounded-lg text-xs font-semibold transition-colors ${
                    isDark
                      ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 border border-zinc-200'
                  }`}
                  style={{ animation: 'distill-stagger-in 0.3s ease-out both', animationDelay: '0s' }}
                >
                  <ExternalLink className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
                  View in My Genes
                </button>
                <button
                  className="py-2.5 rounded-lg text-xs font-bold bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500 shadow-lg shadow-violet-500/20 transition-all"
                  style={{ animation: 'distill-stagger-in 0.3s ease-out both', animationDelay: '0.1s' }}
                >
                  Publish to Market
                </button>
                <button
                  className={`py-2.5 rounded-lg text-xs font-semibold transition-colors ${
                    isDark
                      ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 border border-zinc-200'
                  }`}
                  style={{ animation: 'distill-stagger-in 0.3s ease-out both', animationDelay: '0.2s' }}
                >
                  <GitFork className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
                  Fork
                </button>
              </div>
            )}

            {/* Distillation history */}
            {distillHistory.length > 0 && showButtons && (
              <div
                className={`rounded-lg p-4 border ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
                style={{ animation: 'distill-slide-up 0.4s ease-out 0.3s both' }}
              >
                <h4
                  className={`text-xs font-semibold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                >
                  Distillation History
                </h4>
                <div className="space-y-2">
                  {distillHistory.map((entry, i) => (
                    <div
                      key={i}
                      className={`flex items-center gap-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                    >
                      <span
                        className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 ${
                          entry.status === 'success'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400'
                        }`}
                      >
                        {entry.status === 'success' ? '\u2713' : '\u2717'}
                      </span>
                      <span className={`flex-1 truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        {entry.gene_title}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          CAT_COLORS[entry.category]?.bg || (isDark ? 'bg-zinc-800' : 'bg-zinc-100')
                        } ${CAT_COLORS[entry.category]?.text || (isDark ? 'text-zinc-400' : 'text-zinc-500')}`}
                      >
                        {entry.category}
                      </span>
                      <span className="shrink-0">{new Date(entry.created_at).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Global error (for non-processing errors) */}
        {error && phase !== 'processing' && (
          <div
            className={`mt-4 rounded-lg p-3 text-sm ${isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-600 border border-red-200'}`}
          >
            <AlertCircle className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
