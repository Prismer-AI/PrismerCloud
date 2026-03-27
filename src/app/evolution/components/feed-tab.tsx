'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Filter, Clock, Loader2, CircleDot, Diamond, Star, Trophy,
  Download, XCircle,
} from 'lucide-react';
import { type FeedEvent, CAT_COLORS, FEED_ICONS, glass, timeAgo } from './helpers';

interface FeedTabProps {
  isDark: boolean;
  initialFeed?: FeedEvent[];
}

const EVENT_TYPES = [
  { key: '', label: 'All' },
  { key: 'capsule', label: 'Executions' },
  { key: 'publish', label: 'New Genes' },
  { key: 'distill', label: 'Distilled' },
  { key: 'milestone', label: 'Milestones' },
];

const FEED_ICON_MAP: Record<string, typeof CircleDot> = {
  capsule: CircleDot,
  distill: Diamond,
  publish: Star,
  milestone: Trophy,
  import: Download,
};

function TimeAgo({ ts, className }: { ts: string; className?: string }) {
  const [text, setText] = useState('');
  useEffect(() => { setText(timeAgo(ts)); }, [ts]);
  return <span className={className} suppressHydrationWarning>{text}</span>;
}

export function FeedTab({ isDark, initialFeed }: FeedTabProps) {
  const [feed, setFeed] = useState<FeedEvent[]>(initialFeed || []);
  const [loading, setLoading] = useState(!initialFeed);
  const [filter, setFilter] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [newEventCount, setNewEventCount] = useState(0);
  const feedTopRef = useRef<HTMLDivElement>(null);

  // Fetch initial feed
  useEffect(() => {
    if (initialFeed && initialFeed.length > 0) return;
    setLoading(true);
    fetch('/api/im/evolution/public/feed?limit=50')
      .then(r => r.json())
      .then(d => setFeed(d.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE connection for real-time updates
  useEffect(() => {
    let token: string | null = null;
    try {
      token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
    } catch {}
    if (!token) return;

    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/im/sse?token=${token}`);

      es.addEventListener('evolution:capsule', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const newEvent: FeedEvent = {
            type: 'capsule',
            timestamp: new Date().toISOString(),
            agentName: data.agentId?.slice(-8) || 'agent',
            geneTitle: data.geneId || 'Unknown Gene',
            geneCategory: 'repair',
            outcome: data.outcome,
            score: data.score,
            summary: data.summary,
          };
          setFeed(prev => [newEvent, ...prev]);
          setNewEventCount(c => c + 1);
        } catch {}
      });

      es.addEventListener('evolution:achievement', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const newEvent: FeedEvent = {
            type: 'milestone',
            timestamp: new Date().toISOString(),
            agentName: data.agentId?.slice(-8) || 'agent',
            geneTitle: `Unlocked: ${data.badgeKey}`,
            geneCategory: 'innovate',
            detail: data.badgeName,
          };
          setFeed(prev => [newEvent, ...prev]);
          setNewEventCount(c => c + 1);
        } catch {}
      });

      es.onerror = () => {
        // Silently ignore — SSE will auto-reconnect
      };
    } catch {}

    return () => { es?.close(); };
  }, []);

  // Filter feed
  const filtered = feed.filter(e => {
    if (filter && e.type !== filter) return false;
    if (catFilter && e.geneCategory !== catFilter) return false;
    return true;
  });

  // Group by date
  const groups = filtered.reduce<Array<{ date: string; events: FeedEvent[] }>>((acc, event) => {
    const date = new Date(event.timestamp).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const last = acc[acc.length - 1];
    if (last && last.date === date) {
      last.events.push(event);
    } else {
      acc.push({ date, events: [event] });
    }
    return acc;
  }, []);

  return (
    <div>
      {/* New events banner */}
      {newEventCount > 0 && (
        <button
          onClick={() => { setNewEventCount(0); feedTopRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
          className={`w-full mb-4 py-2 px-4 rounded-lg text-xs font-medium text-center transition-all ${
            isDark ? 'bg-violet-500/15 text-violet-300 hover:bg-violet-500/25' : 'bg-violet-100 text-violet-700 hover:bg-violet-200'
          }`}
        >
          {newEventCount} new event{newEventCount > 1 ? 's' : ''} — click to scroll up
        </button>
      )}

      {/* Filters */}
      <div className={`flex flex-wrap gap-2 mb-6 p-3 rounded-xl ${glass(isDark)}`}>
        <span className={`flex items-center gap-1 text-xs font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          <Filter className="w-3 h-3" /> Filter:
        </span>
        {EVENT_TYPES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
              filter === key
                ? (isDark ? 'bg-white/10 text-white' : 'bg-zinc-900 text-white')
                : (isDark ? 'bg-zinc-800/60 text-zinc-500 hover:text-zinc-300' : 'bg-zinc-100 text-zinc-500 hover:text-zinc-900')
            }`}
          >
            {label}
          </button>
        ))}
        <div className="w-px h-5 self-center bg-zinc-700/30" />
        {['', 'repair', 'optimize', 'innovate'].map(cat => (
          <button
            key={cat}
            onClick={() => setCatFilter(cat)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
              catFilter === cat
                ? (isDark ? 'bg-white/10 text-white' : 'bg-zinc-900 text-white')
                : (isDark ? 'bg-zinc-800/60 text-zinc-500 hover:text-zinc-300' : 'bg-zinc-100 text-zinc-500 hover:text-zinc-900')
            }`}
          >
            {cat || 'All categories'}
          </button>
        ))}
      </div>

      <div ref={feedTopRef} />

      {/* Timeline */}
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-violet-400" /></div>
      ) : filtered.length === 0 ? (
        <div className={`text-center py-20 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          <Clock className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No events match the current filters.</p>
        </div>
      ) : (
        <div className="relative">
          <div className={`absolute left-[19px] top-0 bottom-0 w-px ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`} />

          {groups.map(group => (
            <div key={group.date} className="mb-6">
              <div className="flex items-center gap-3 mb-3">
                <div className={`w-10 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-200 text-zinc-600'}`}>
                  {group.date.split(',')[0].split(' ')[1] || group.date.slice(0, 3)}
                </div>
                <span className={`text-xs font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{group.date}</span>
              </div>

              {group.events.map((event, i) => {
                const Icon = FEED_ICON_MAP[event.type] || CircleDot;
                const cfg = FEED_ICONS[event.type] || FEED_ICONS.capsule;
                const catColor = CAT_COLORS[event.geneCategory]?.hex || '#71717a';
                const isFailure = event.type === 'capsule' && event.outcome === 'failure';

                return (
                  <div
                    key={`${group.date}-${i}`}
                    className={`flex items-start gap-3 py-2 pl-0 pr-4 ml-1 transition-all rounded-lg animate-in fade-in slide-in-from-top-1 duration-300 ${
                      isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'
                    }`}
                  >
                    {/* Node */}
                    <div className="relative z-10 shrink-0">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center border-2"
                        style={{
                          borderColor: isFailure ? '#ef4444' : catColor,
                          backgroundColor: isDark ? 'rgb(24,24,27)' : 'white',
                        }}
                      >
                        {isFailure
                          ? <XCircle className="w-3.5 h-3.5 text-red-400" />
                          : <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                        }
                      </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0 pt-1">
                      <p className={`text-sm leading-snug ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        <span className="font-semibold" style={{ color: catColor }}>{event.agentName}</span>
                        {' '}
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
                          {event.type === 'capsule' ? 'executed' : event.type === 'publish' ? 'published' : event.type === 'distill' ? 'distilled' : event.type === 'milestone' ? 'achieved' : 'imported'}
                        </span>
                        {' '}
                        <span className={`font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{event.geneTitle}</span>
                        {event.score != null && (
                          <span className={`ml-1 text-xs ${isFailure ? 'text-red-400' : 'text-emerald-400'}`}>
                            ({Math.round(event.score * 100)}%)
                          </span>
                        )}
                      </p>
                      {event.summary && (
                        <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{event.summary}</p>
                      )}
                      <TimeAgo ts={event.timestamp} className={`text-[10px] mt-0.5 block ${isDark ? 'text-zinc-700' : 'text-zinc-400'}`} />
                    </div>

                    {/* Outcome badge */}
                    {event.type === 'capsule' && (
                      <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full mt-1 ${
                        isFailure
                          ? (isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-100 text-red-600')
                          : (isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-100 text-emerald-600')
                      }`}>
                        {isFailure ? 'Failed' : 'Success'}
                      </span>
                    )}

                    {/* Milestone celebration */}
                    {event.type === 'milestone' && (
                      <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full mt-1 ${
                        isDark ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-100 text-cyan-600'
                      }`}>
                        Milestone
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
