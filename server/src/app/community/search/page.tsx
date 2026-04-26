'use client';

import { Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, ArrowLeft, Loader2, MessageSquare, ThumbsUp, Filter, Globe, Trophy, Dna, HelpCircle, Lightbulb, Megaphone, Beaker } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { sanitizeHtml } from '@/lib/sanitize';
import { type SearchResult, glass, timeAgo, searchCommunity, spring, pressable, handleCardMouseMove, cardGlowStyle, SPRING_KEYFRAMES } from '../components/helpers';

const BOARD_ICONS: Record<string, typeof Globe> = {
  all: Globe,
  showcase: Trophy,
  genelab: Beaker,
  helpdesk: HelpCircle,
  ideas: Lightbulb,
  changelog: Megaphone,
};

const BOARD_FILTER_IDS = ['showcase', 'genelab', 'helpdesk', 'ideas', 'changelog'] as const;
const BOARD_LABEL: Record<(typeof BOARD_FILTER_IDS)[number], string> = {
  showcase: 'Showcase',
  genelab: 'Gene Lab',
  helpdesk: 'Help Desk',
  ideas: 'Ideas',
  changelog: 'Changelog',
};

function SearchResultSnippet({ html, className }: { html: string; className?: string }) {
  const safe = useMemo(() => sanitizeHtml(html), [html]);
  return (
    <p
      className={className}
      // Snippet HTML is server-generated highlights; sanitized before render.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

export default function CommunitySearchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
        </div>
      }
    >
      <CommunitySearchPageInner />
    </Suspense>
  );
}

function CommunitySearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const initialQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [boardFilter, setBoardFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState('relevance');

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const doSearch = useCallback(
    async (q: string, cursor?: string) => {
      if (!q.trim()) return;
      const isLoadMore = !!cursor;
      try {
        if (isLoadMore) setLoadingMore(true);
        else { setLoading(true); setSearched(true); }
        const data = await searchCommunity({
          q: q.trim(),
          boardSlug: boardFilter || undefined,
          sort: sortBy,
          limit: 30,
          cursor,
        });
        setResults((prev) => (isLoadMore ? [...prev, ...data.results] : data.results));
        setNextCursor(data.nextCursor);
      } catch (e) {
        console.error('[Community] Search failed:', e);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [boardFilter, sortBy],
  );

  useEffect(() => {
    if (initialQuery) doSearch(initialQuery);
  }, [initialQuery, doSearch]);

  const handleSearch = () => {
    if (query.trim()) {
      router.push(`/community/search?q=${encodeURIComponent(query.trim())}`);
      doSearch(query.trim());
    }
  };

  const displayQuery = query.trim() || initialQuery;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <style>{SPRING_KEYFRAMES}</style>
      <div className="mx-auto max-w-4xl px-4 pt-24 pb-12 sm:px-6 lg:px-8">
        {/* Back */}
        <Link
          href="/community"
          className={`mb-6 flex items-center gap-2 text-sm transition-colors ${
            isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
          }`}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Community
        </Link>

        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative">
            <Search className="absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search community posts and discussions..."
              className={`w-full rounded-xl py-3.5 pr-4 pl-12 text-base outline-none transition-colors ${
                isDark
                  ? 'border border-white/10 bg-white/5 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50'
                  : 'border border-zinc-200 bg-white focus:border-violet-500'
              }`}
              autoFocus
            />
          </div>

          {/* Filters */}
          <div className="mt-4 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-zinc-500" />
              <select
                value={boardFilter}
                onChange={(e) => {
                  setBoardFilter(e.target.value);
                  if (query.trim()) doSearch(query.trim());
                }}
                className={`rounded-lg px-3 py-1.5 text-sm outline-none ${
                  isDark ? 'border border-white/10 bg-white/5 text-zinc-300' : 'border border-zinc-200 bg-white'
                }`}
              >
                <option value="">All boards</option>
                {BOARD_FILTER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {BOARD_LABEL[id]}
                  </option>
                ))}
              </select>
            </div>
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value);
                if (query.trim()) doSearch(query.trim());
              }}
              className={`rounded-lg px-3 py-1.5 text-sm outline-none ${
                isDark ? 'border border-white/10 bg-white/5 text-zinc-300' : 'border border-zinc-200 bg-white'
              }`}
            >
              <option value="relevance">Most Relevant</option>
              <option value="hot">Hot</option>
              <option value="new">Newest</option>
            </select>
          </div>
        </div>

        {/* Results */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
          </div>
        ) : !searched ? (
          <div className={`py-20 text-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            <Search className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p>Enter a search query to find posts</p>
          </div>
        ) : results.length === 0 ? (
          <div className={`py-20 text-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            <p className="mb-2 text-lg">No results found</p>
            <p className="text-sm">Try different keywords or browse the community</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className={`mb-4 text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {results.length} result{results.length !== 1 ? 's' : ''} for &quot;{displayQuery}&quot;
            </p>
            {results.map((result) => {
              const boardLabel = result.boardId
                ? (BOARD_LABEL[result.boardId as keyof typeof BOARD_LABEL] ?? result.boardId)
                : undefined;
              const BoardIcon = result.boardId ? (BOARD_ICONS[result.boardId] || Globe) : Globe;
              const href =
                result.type === 'comment' && result.postId
                  ? `/community/post/${result.postId}#comment-${result.id}`
                  : `/community/post/${result.id}`;
              return (
                <Link key={result.id} href={href}>
                  <div
                    onMouseMove={handleCardMouseMove}
                    style={cardGlowStyle(isDark)}
                    className={`cursor-pointer rounded-xl p-4 ${spring.normal.class} ${pressable} ${glass(isDark, 'subtle')} ${
                      isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white'
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        <BoardIcon className="inline h-3 w-3" />{boardLabel}
                      </span>
                      <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>·</span>
                      <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        @{result.author.name}
                      </span>
                      <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>·</span>
                      <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        {timeAgo(result.createdAt)}
                      </span>
                    </div>
                    {result.title && (
                      <h3 className={`mb-1 font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                        {result.title}
                      </h3>
                    )}
                    <SearchResultSnippet
                      html={result.snippet}
                      className={`line-clamp-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                    />
                    <div className="mt-2 flex items-center gap-3 text-xs">
                      <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
                        <ThumbsUp className="mr-1 inline h-3 w-3" />
                        {result.upvotes}
                      </span>
                      <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
                        <MessageSquare className="mr-1 inline h-3 w-3" />
                        {result.commentCount}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
            {nextCursor && (
              <button
                type="button"
                onClick={() => void doSearch(query.trim(), nextCursor)}
                disabled={loadingMore}
                className={`w-full rounded-xl py-3 text-sm font-medium transition-colors ${glass(isDark, 'subtle')} ${
                  isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {loadingMore ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
