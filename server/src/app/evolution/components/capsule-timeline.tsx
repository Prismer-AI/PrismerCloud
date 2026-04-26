'use client';

interface TimelineStep {
  ts: string;
  event: string;
  detail: string;
  status: 'trigger' | 'gene' | 'step' | 'success' | 'fail';
}

interface CapsuleTimelineProps {
  highlight: {
    capsuleId?: string;
    signalKey: string;
    outcome: string;
    score?: number;
    summary?: string;
    tokenSaved?: number;
    createdAt?: string;
    timeline?: TimelineStep[];
  };
  isDark?: boolean;
  className?: string;
}

const STATUS_COLORS: Record<string, { dot: string; text: string; line: string }> = {
  trigger: { dot: 'bg-red-500', text: 'text-red-400', line: 'border-red-500/30' },
  gene: { dot: 'bg-cyan-500', text: 'text-cyan-400', line: 'border-cyan-500/30' },
  step: { dot: 'bg-zinc-500', text: 'text-zinc-400', line: 'border-zinc-500/30' },
  success: { dot: 'bg-emerald-500', text: 'text-emerald-400', line: 'border-emerald-500/30' },
  fail: { dot: 'bg-red-500', text: 'text-red-400', line: 'border-red-500/30' },
};

export function CapsuleTimeline({ highlight, isDark = true, className = '' }: CapsuleTimelineProps) {
  const steps: TimelineStep[] = highlight.timeline || [
    {
      ts: highlight.createdAt || new Date().toISOString(),
      event: 'signal_triggered',
      detail: highlight.signalKey,
      status: 'trigger',
    },
    {
      ts: highlight.createdAt || new Date().toISOString(),
      event: 'gene_activated',
      detail: 'Gene strategy activated',
      status: 'gene',
    },
    {
      ts: highlight.createdAt || new Date().toISOString(),
      event: highlight.outcome === 'success' ? 'success' : 'failed',
      detail: highlight.summary || (highlight.outcome === 'success' ? 'Completed' : 'Failed'),
      status: highlight.outcome === 'success' ? 'success' : 'fail',
    },
  ];

  return (
    <div className={className}>
      <div className="relative pl-6">
        {/* Vertical line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gradient-to-b from-red-500/40 via-cyan-500/40 to-emerald-500/40" />

        {steps.map((step, i) => {
          const colors = STATUS_COLORS[step.status] || STATUS_COLORS.step;
          return (
            <div
              key={i}
              className="relative pb-4 last:pb-0"
              style={{
                animation: 'timelineStepIn 300ms cubic-bezier(0.22, 1, 0.36, 1) both',
                animationDelay: `${i * 150}ms`,
              }}
            >
              {/* Dot */}
              <div
                className={`absolute left-[-17px] top-1.5 w-[10px] h-[10px] rounded-full ${colors.dot} ring-2 ${isDark ? 'ring-zinc-950' : 'ring-white'}`}
              />

              {/* Content */}
              <div>
                <span className={`text-xs font-medium ${colors.text}`}>
                  {step.event === 'signal_triggered'
                    ? 'Error Triggered'
                    : step.event === 'gene_activated'
                      ? 'Gene Activated'
                      : step.event === 'success'
                        ? 'Success'
                        : step.event === 'failed'
                          ? 'Failed'
                          : step.event}
                </span>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{step.detail}</p>
                {step.status === 'success' && highlight.tokenSaved && (
                  <p className="text-sm font-bold text-emerald-400 mt-1">
                    Saved ~${(((highlight.tokenSaved || 0) / 1000) * 0.009).toFixed(2)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {highlight.score != null && (
        <div className="mt-3 flex items-center gap-2">
          <div className={`h-1.5 flex-1 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full"
              style={{ width: `${Math.round(highlight.score * 100)}%` }}
            />
          </div>
          <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{(highlight.score * 100).toFixed(0)}%</span>
        </div>
      )}

      <style>{`
        @keyframes timelineStepIn {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
