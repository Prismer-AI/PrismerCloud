'use client';

import { useState, useEffect, useRef } from 'react';
import { Activity, Zap, GitFork, Download, CheckCircle } from 'lucide-react';

interface TickerEvent {
  id: string;
  type: string;
  agentName?: string;
  geneTitle?: string;
  outcome?: string;
  timestamp?: string;
  ts?: string;
}

interface EvolutionTickerProps {
  className?: string;
  maxItems?: number;
  pollInterval?: number; // ms, default 30000
  geneId?: string; // filter by gene if on profile page
}

export function EvolutionTicker({ className = '', maxItems = 5, pollInterval = 30000, geneId }: EvolutionTickerProps) {
  const [events, setEvents] = useState<TickerEvent[]>([]);
  const [newEventId, setNewEventId] = useState<string | null>(null);
  const prevEventsRef = useRef<string[]>([]);

  useEffect(() => {
    let mounted = true;

    async function fetchEvents() {
      try {
        const url = '/api/im/evolution/public/feed?limit=10' + (geneId ? `&geneId=${geneId}` : '');
        const res = await fetch(url);
        const json = await res.json();
        if (!mounted) return;

        const items: TickerEvent[] = (json.ok ? json.data || [] : []).slice(0, maxItems);

        // Detect new events for animation
        const newIds = items.map((e) => e.id || `${e.agentName}-${e.ts}`);
        const prevIds = prevEventsRef.current;
        const brandNew = newIds.find((id) => !prevIds.includes(id));
        if (brandNew) setNewEventId(brandNew);
        prevEventsRef.current = newIds;

        setEvents(items);
      } catch {
        /* silent */
      }
    }

    fetchEvents();
    const interval = setInterval(fetchEvents, pollInterval);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [geneId, maxItems, pollInterval]);

  if (events.length === 0) {
    return (
      <div className={`rounded-xl bg-white/[0.02] border border-white/[0.04] p-4 ${className}`}>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-zinc-600" />
          <span className="text-xs font-medium text-zinc-600">实时动态</span>
        </div>
        <p className="text-xs text-zinc-700 text-center py-4">暂无近期活动</p>
      </div>
    );
  }

  function getIcon(type: string, outcome?: string) {
    if (type === 'capsule' && outcome === 'success') return <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />;
    if (type === 'capsule') return <Zap className="w-3.5 h-3.5 text-amber-400" />;
    if (type === 'import') return <Download className="w-3.5 h-3.5 text-blue-400" />;
    if (type === 'publish') return <GitFork className="w-3.5 h-3.5 text-violet-400" />;
    return <Activity className="w-3.5 h-3.5 text-zinc-500" />;
  }

  function getMessage(e: TickerEvent): string {
    if (e.type === 'capsule' && e.outcome === 'success')
      return `${e.agentName || 'Agent'} 使用 ${e.geneTitle || 'Gene'} 成功修复`;
    if (e.type === 'import') return `${e.agentName || 'Agent'} 采纳了 ${e.geneTitle || 'Gene'}`;
    if (e.type === 'publish') return `${e.agentName || 'Agent'} 发布了 ${e.geneTitle || '新 Gene'}`;
    if (e.type === 'distill') return `${e.agentName || 'Agent'} 蒸馏出新的 Gene`;
    return `${e.agentName || 'Agent'} 触发了 ${e.geneTitle || '进化事件'}`;
  }

  function timeAgo(ts?: string): string {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m}分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}小时前`;
    return `${Math.floor(h / 24)}天前`;
  }

  return (
    <div className={`rounded-xl bg-white/[0.02] border border-white/[0.04] p-4 overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 mb-3">
        <div className="relative">
          <Activity className="w-4 h-4 text-emerald-400" />
          <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
        <span className="text-xs font-medium text-zinc-400">实时动态</span>
      </div>
      <div className="space-y-0">
        {events.map((e, i) => {
          const eventId = e.id || `${e.agentName}-${e.ts}`;
          const isNew = eventId === newEventId;
          return (
            <div
              key={eventId}
              className="flex items-center gap-2.5 py-2 border-b border-white/[0.03] last:border-0"
              style={{
                animation: isNew ? 'tickerSlideIn 400ms cubic-bezier(0.34, 1.56, 0.64, 1) both' : undefined,
                animationDelay: `${i * 50}ms`,
              }}
            >
              {getIcon(e.type, e.outcome)}
              <span className="text-xs text-zinc-400 flex-1 truncate">{getMessage(e)}</span>
              <span className="text-[10px] text-zinc-600 shrink-0">{timeAgo(e.timestamp || e.ts)}</span>
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes tickerSlideIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
