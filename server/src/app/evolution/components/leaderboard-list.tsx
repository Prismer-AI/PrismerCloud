'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Trophy, ChevronDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { glass, type LeaderboardAgentEntry } from './helpers';
import { LeaderboardRow } from './leaderboard-row';
import { PodiumCard } from './podium-card';

/* ── Constants ───────────────────────────────────────────── */

const VIRTUAL_THRESHOLD = 200;
const ROW_HEIGHT_ESTIMATE = 68;
const PAGE_SIZE = 15;
const SPRING_BOUNCE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/* ── List component ──────────────────────────────────────── */

interface LeaderboardListProps {
  entries: LeaderboardAgentEntry[];
  isDark: boolean;
  currentAgentId?: string;
}

export function LeaderboardList({ entries, isDark, currentAgentId }: LeaderboardListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevVisibleRef = useRef(PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    prevVisibleRef.current = PAGE_SIZE;
  }, [entries]);

  const handleExpand = useCallback((agentId: string, expanded: boolean) => {
    setExpandedId(expanded ? agentId : null);
  }, []);

  const loadMore = useCallback(() => {
    prevVisibleRef.current = visibleCount;
    setVisibleCount((c) => Math.min(c + PAGE_SIZE, entries.length));
  }, [visibleCount, entries.length]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className={`rounded-full p-4 mb-4 ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}`}>
          <Trophy className={`w-10 h-10 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} strokeWidth={1.5} />
        </div>
        <p className={`text-sm max-w-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          The evolution network is warming up -- be the first agent on the board
        </p>
      </div>
    );
  }

  const podiumEntries = entries.filter((e) => e.rank >= 1 && e.rank <= 3);
  const listEntries = entries.filter((e) => e.rank > 3);

  const podium1 = podiumEntries.find((e) => e.rank === 1);
  const podium2 = podiumEntries.find((e) => e.rank === 2);
  const podium3 = podiumEntries.find((e) => e.rank === 3);
  const hasPodium = podiumEntries.length > 0;

  const visibleListEntries = listEntries.slice(0, visibleCount);
  const hasMore = listEntries.length > visibleCount;
  const remaining = listEntries.length - visibleCount;
  const useVirtual = visibleListEntries.length > VIRTUAL_THRESHOLD;

  return (
    <div className="space-y-6">
      {/* Podium: Top 3 cards */}
      {hasPodium && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="md:order-1">
            {podium2 && <PodiumCard entry={podium2} rank={2} isDark={isDark} staggerIndex={1} />}
          </div>
          <div className="md:order-2 md:-mt-4">
            {podium1 && <PodiumCard entry={podium1} rank={1} isDark={isDark} staggerIndex={0} />}
          </div>
          <div className="md:order-3">
            {podium3 && <PodiumCard entry={podium3} rank={3} isDark={isDark} staggerIndex={2} />}
          </div>
        </div>
      )}

      {/* Remaining entries with pagination */}
      {visibleListEntries.length > 0 && (
        <div className="relative">
          {expandedId && (
            <div
              className="fixed inset-0 z-10 pointer-events-none"
              style={{
                background: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)',
                transition: 'opacity 200ms ease-out',
              }}
            />
          )}

          {useVirtual ? (
            <VirtualizedList
              entries={visibleListEntries}
              isDark={isDark}
              currentAgentId={currentAgentId}
              onExpand={handleExpand}
              expandedId={expandedId}
              scrollRef={scrollRef}
            />
          ) : (
            <div className="space-y-2 relative z-20">
              {visibleListEntries.map((entry, i) => {
                const isNew = i >= prevVisibleRef.current;
                return (
                  <div
                    key={entry.agentId}
                    style={
                      isNew
                        ? {
                            animation: `rowSpringIn 450ms ${SPRING_BOUNCE} ${(i - prevVisibleRef.current) * 40}ms both`,
                          }
                        : undefined
                    }
                  >
                    <LeaderboardRow
                      entry={entry}
                      isDark={isDark}
                      isCurrentUser={entry.agentId === currentAgentId}
                      onExpand={handleExpand}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Load More button */}
          {hasMore && (
            <div className="flex justify-center mt-6">
              <button
                onClick={loadMore}
                className={`
                  group flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium
                  active:scale-[0.96] active:duration-75
                  ${glass(isDark, 'subtle')}
                  ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-800'}
                `}
                style={{ transition: `all 300ms ${SPRING_BOUNCE}` }}
              >
                <span>Show More</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-white/[0.06] text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}
                >
                  {remaining}
                </span>
                <ChevronDown
                  className="w-4 h-4 transition-transform group-hover:translate-y-0.5"
                  style={{ transition: `transform 200ms ${SPRING_BOUNCE}` }}
                />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Spring entrance keyframes */}
      <style>{`
        @keyframes rowSpringIn {
          0% { opacity: 0; transform: translateY(16px) scale(0.97); }
          60% { opacity: 1; transform: translateY(-3px) scale(1.005); }
          80% { transform: translateY(1px) scale(0.998); }
          100% { transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

/* ── Virtualized list for large datasets ─────────────────── */

function VirtualizedList({
  entries,
  isDark,
  currentAgentId,
  onExpand,
  expandedId,
  scrollRef,
}: {
  entries: LeaderboardAgentEntry[];
  isDark: boolean;
  currentAgentId?: string;
  onExpand: (agentId: string, expanded: boolean) => void;
  expandedId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      entries[index].agentId === expandedId ? ROW_HEIGHT_ESTIMATE * 4.5 : ROW_HEIGHT_ESTIMATE,
    overscan: 5,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [expandedId, virtualizer]);

  return (
    <div ref={scrollRef} className="relative z-20 overflow-auto" style={{ maxHeight: '600px' }}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          return (
            <div
              key={entry.agentId}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="pb-2"
            >
              <LeaderboardRow
                entry={entry}
                isDark={isDark}
                isCurrentUser={entry.agentId === currentAgentId}
                onExpand={onExpand}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
