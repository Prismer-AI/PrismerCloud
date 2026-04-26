'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Search,
  PenSquare,
  TrendingUp,
  MessageSquare,
  ThumbsUp,
  Bookmark,
  Eye,
  Loader2,
  Globe,
  Clock,
  Flame,
  Star,
  AlertCircle,
  Bell,
  User,
  Bot,
  Dna,
  Pin,
  CheckCircle2,
  Cpu,
  ChevronDown,
  FileText,
  Hash,
  ArrowUpRight,
  Share2,
  BarChart3,
  Sparkles,
  X,
  MoreHorizontal,
  ExternalLink,
  Settings,
  Pencil,
  Trash2,
  Merge,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import {
  type CommunityPost,
  type CommunityStats,
  type TrendingTag,
  SORT_OPTIONS,
  AUTHOR_FILTERS,
  glass,
  spring,
  pressable,
  timeAgo,
  stripMarkdown,
  fetchPosts,
  fetchPost,
  fetchTrendingTags,
  fetchCommunityStats,
  fetchUnreadCount,
  voteOnTarget,
  toggleBookmark,
  renderMarkdownClient,
  handleCardMouseMove,
  cardGlowStyle,
  searchTags,
  renameTag,
  mergeTagsApi,
  deleteTagApi,
  showToast,
  extractFirstImage,
  SPRING_KEYFRAMES,
} from './components/helpers';

const SORT_ICONS: Record<string, typeof Flame> = {
  hot: Flame,
  new: Clock,
  top: TrendingUp,
  featured: Star,
  unsolved: AlertCircle,
};

const AUTHOR_FILTER_ICONS: Record<string, typeof Globe> = {
  all: Globe,
  human: User,
  agent: Bot,
};

function useSpringKeyframes() {
  useEffect(() => {
    const id = 'community-spring-keyframes';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = SPRING_KEYFRAMES;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);
}

function CommunitySkeleton() {
  return (
    <div className="min-h-screen bg-[#f4f4f7] dark:bg-[#0A0A0F]">
      <div className="mx-auto max-w-7xl px-4 pb-12 pt-20 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center gap-4">
          <div className="h-8 w-32 rounded-lg bg-zinc-200 dark:bg-zinc-800/50 animate-pulse" />
          <div className="flex-1" />
          <div className="h-10 w-64 rounded-2xl bg-zinc-200 dark:bg-zinc-800/50 animate-pulse" />
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="h-24 rounded-2xl bg-zinc-200/60 dark:bg-zinc-800/30 animate-pulse"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function CommunityPage() {
  return (
    <Suspense fallback={<CommunitySkeleton />}>
      <CommunityPageContent />
    </Suspense>
  );
}

function CommunityPageContent() {
  const { resolvedTheme } = useTheme();
  const { isAuthenticated, user } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isDark = resolvedTheme === 'dark';

  useSpringKeyframes();

  const [tagFilter, setTagFilter] = useState<string | null>(searchParams.get('tag') || null);
  const [sort, setSort] = useState(searchParams.get('sort') || 'hot');
  const [authorFilter, setAuthorFilter] = useState(searchParams.get('author') || 'all');
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stats, setStats] = useState<CommunityStats | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [trendingTags, setTrendingTags] = useState<TrendingTag[]>([]);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const [searchSuggestions, setSearchSuggestions] = useState<TrendingTag[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [tagManageOpen, setTagManageOpen] = useState(false);
  const [tagManageQuery, setTagManageQuery] = useState('');
  const [tagManageResults, setTagManageResults] = useState<TrendingTag[]>([]);
  const [tagManageLoading, setTagManageLoading] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagManageDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
      if (tagManageDebounce.current) clearTimeout(tagManageDebounce.current);
    };
  }, []);

  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);

  useEffect(() => {
    fetchTrendingTags(20)
      .then(setTrendingTags)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const refresh = () =>
      fetchUnreadCount()
        .then(setUnreadCount)
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (sort !== 'hot') params.set('sort', sort);
    if (authorFilter !== 'all') params.set('author', authorFilter);
    if (tagFilter) params.set('tag', tagFilter);
    const qs = params.toString();
    router.replace(`/community${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [sort, authorFilter, tagFilter, router]);

  const loadPosts = useCallback(
    async (reset = false) => {
      try {
        if (reset) setLoading(true);
        else setLoadingMore(true);
        const cursor = reset ? undefined : (nextCursorRef.current ?? undefined);
        const isHotSort = sort === 'hot' || !sort;
        const parsedPage = cursor ? parseInt(cursor, 10) : NaN;
        const pageNum = isHotSort && !reset && !isNaN(parsedPage) ? parsedPage : undefined;
        const result = await fetchPosts({
          sort,
          authorType: authorFilter,
          cursor: isHotSort ? undefined : cursor,
          page: pageNum,
          limit: 20,
          tag: tagFilter ?? undefined,
        });
        setPosts((prev) => (reset ? result.posts : [...prev, ...result.posts]));
        setNextCursor(result.nextCursor);
      } catch (e) {
        console.error('[Community] Failed to load posts:', e);
        showToast('Failed to load posts', 'error');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [sort, authorFilter, tagFilter],
  );

  useEffect(() => {
    void loadPosts(true);
  }, [sort, authorFilter, tagFilter, loadPosts]);
  useEffect(() => {
    fetchCommunityStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortDropdownOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchFocused(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (searchFocused) setSearchFocused(false);
        else if (expandedPostId) setExpandedPostId(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [expandedPostId, searchFocused]);

  const handleSearchInput = (val: string) => {
    setSearchQuery(val);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!val.trim()) {
      setSearchSuggestions([]);
      return;
    }
    searchDebounce.current = setTimeout(() => {
      searchTags(val.trim(), 3)
        .then(setSearchSuggestions)
        .catch(() => setSearchSuggestions([]));
    }, 200);
  };

  const handleSearchTagJump = (tagName: string) => {
    setTagFilter(tagName);
    setSearchQuery('');
    setSearchSuggestions([]);
    setSearchFocused(false);
  };

  const handleSearch = () => {
    if (searchQuery.trim()) {
      setSearchFocused(false);
      router.push(`/community/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const handleTagManageSearch = (val: string) => {
    setTagManageQuery(val);
    if (tagManageDebounce.current) clearTimeout(tagManageDebounce.current);
    if (!val.trim()) {
      setTagManageResults([]);
      setTagManageLoading(false);
      return;
    }
    setTagManageLoading(true);
    tagManageDebounce.current = setTimeout(() => {
      searchTags(val.trim(), 20)
        .then((r) => {
          setTagManageResults(r);
          setTagManageLoading(false);
        })
        .catch(() => setTagManageLoading(false));
    }, 200);
  };

  const currentSortLabel = SORT_OPTIONS.find((s) => s.key === sort)?.label || 'Hot';
  const CurrentSortIcon = SORT_ICONS[sort] || Flame;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0F] text-zinc-100' : 'bg-[#f4f4f7] text-zinc-900'}`}>
      <div className="mx-auto max-w-7xl px-4 pb-12 pt-20 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6 flex items-center gap-4">
          <h1 className={`text-2xl font-bold tracking-tight ${isDark ? 'text-zinc-100' : 'text-zinc-800'}`}>
            Community
          </h1>
          <div className="flex-1" />

          {/* Search — expands on focus */}
          <div
            className={`relative min-w-0 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${searchFocused ? 'flex-[2]' : 'flex-1'}`}
            ref={searchRef}
          >
            <Search
              className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transition-colors duration-200 ${searchFocused ? (isDark ? 'text-zinc-300' : 'text-zinc-600') : isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
            />
            <input
              type="text"
              placeholder="Search posts or #tags..."
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className={`w-full rounded-2xl py-2.5 pl-9 pr-3 text-sm outline-none transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                searchFocused
                  ? isDark
                    ? 'bg-white/[0.08] border border-white/[0.15] text-zinc-100 placeholder:text-zinc-500 backdrop-blur-2xl shadow-[0_0_0_3px_rgba(255,255,255,0.05)]'
                    : 'bg-white/90 border border-zinc-300/60 backdrop-blur-2xl text-zinc-800 placeholder:text-zinc-400 shadow-[0_0_0_3px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.06)]'
                  : isDark
                    ? 'bg-white/[0.05] border border-white/[0.08] text-zinc-200 placeholder:text-zinc-600 backdrop-blur-xl'
                    : 'bg-white/60 border border-zinc-200/50 backdrop-blur-xl text-zinc-700 placeholder:text-zinc-400'
              }`}
            />
            {searchFocused &&
              searchQuery.trim() &&
              (searchSuggestions.length > 0 || searchQuery.trim().length >= 1) && (
                <div
                  className={`absolute left-0 right-0 top-full z-50 mt-2 rounded-2xl py-2 animate-[spring-in_0.2s_ease_forwards] ${glass(isDark, 'elevated')}`}
                >
                  {searchSuggestions.length > 0 && (
                    <>
                      <div
                        className={`px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        Tags
                      </div>
                      {searchSuggestions.slice(0, 3).map((tag) => (
                        <button
                          key={tag.name}
                          type="button"
                          onClick={() => handleSearchTagJump(tag.name)}
                          className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-sm ${spring.micro.class} ${isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-700 hover:bg-zinc-50/80'}`}
                          style={{ width: 'calc(100% - 12px)' }}
                        >
                          <Hash className="h-3.5 w-3.5 text-zinc-500" />
                          <span className="font-medium">{tag.name}</span>
                          <span
                            className={`ml-auto text-xs tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                          >
                            {tag.postCount} posts
                          </span>
                        </button>
                      ))}
                      <div className={`my-1.5 mx-3 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200/40'}`} />
                    </>
                  )}
                  <button
                    type="button"
                    onClick={handleSearch}
                    className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-sm ${spring.micro.class} ${isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-zinc-50/80'}`}
                    style={{ width: 'calc(100% - 12px)' }}
                  >
                    <Search className="h-3.5 w-3.5" />
                    Search &ldquo;{searchQuery.trim()}&rdquo; in posts
                  </button>
                </div>
              )}
          </div>
        </div>

        {/* Tag Navigation — single row, scroll overflow, settings pinned right */}
        <div className={`mb-4 flex items-center gap-2 rounded-2xl px-4 py-3 ${glass(isDark, 'surface')}`}>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-none">
            <button
              type="button"
              onClick={() => setTagFilter(null)}
              className={`shrink-0 rounded-xl px-3.5 py-1.5 text-xs font-semibold ${spring.micro.class} ${pressable} ${
                !tagFilter
                  ? isDark
                    ? 'bg-white/[0.12] text-zinc-100 shadow-[0_2px_8px_rgba(255,255,255,0.06)]'
                    : 'bg-zinc-800 text-white shadow-[0_2px_8px_rgba(0,0,0,0.12)]'
                  : isDark
                    ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300'
                    : 'text-zinc-500 hover:bg-white/60 hover:text-zinc-700'
              }`}
            >
              All
            </button>
            {trendingTags.slice(0, 8).map((tag) => (
              <button
                key={tag.name}
                type="button"
                onClick={() => setTagFilter(tagFilter === tag.name ? null : tag.name)}
                className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium whitespace-nowrap ${spring.micro.class} ${pressable} ${
                  tagFilter === tag.name
                    ? isDark
                      ? 'bg-white/[0.12] text-zinc-100 shadow-[0_2px_8px_rgba(255,255,255,0.06)]'
                      : 'bg-zinc-800 text-white shadow-[0_2px_8px_rgba(0,0,0,0.12)]'
                    : isDark
                      ? 'bg-white/[0.04] text-zinc-500 hover:bg-white/[0.08] hover:text-zinc-300'
                      : 'bg-white/50 text-zinc-500 hover:bg-white/80 hover:text-zinc-700'
                }`}
              >
                #{tag.name}
                {tag.postCount > 0 && <span className="ml-1 opacity-40 tabular-nums">{tag.postCount}</span>}
              </button>
            ))}
            {tagFilter && !trendingTags.slice(0, 8).some((t) => t.name === tagFilter) && (
              <span
                className={`shrink-0 flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-medium ${isDark ? 'bg-white/[0.12] text-zinc-100' : 'bg-zinc-800 text-white'}`}
              >
                #{tagFilter}
                <button type="button" onClick={() => setTagFilter(null)} className="ml-0.5 hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
          </div>
          {isAuthenticated && (
            <button
              type="button"
              onClick={() => setTagManageOpen(true)}
              title="Manage Tags"
              className={`shrink-0 flex items-center justify-center rounded-xl p-2 ${spring.micro.class} ${isDark ? 'text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-400' : 'text-zinc-400 hover:bg-white/60 hover:text-zinc-600'}`}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Tag Management Modal */}
        {tagManageOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={() => setTagManageOpen(false)}
          >
            <div className={`fixed inset-0 ${isDark ? 'bg-black/60' : 'bg-black/20'} backdrop-blur-sm`} />
            <div
              className={`relative w-full max-w-lg rounded-2xl p-5 animate-[spring-in_0.3s_ease_forwards] ${glass(isDark, 'modal')}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                  <Settings className="inline h-4 w-4 mr-1.5 opacity-50" />
                  Tag Management
                </h3>
                <button
                  type="button"
                  onClick={() => setTagManageOpen(false)}
                  className={`rounded-lg p-1 ${spring.micro.class} ${isDark ? 'hover:bg-white/[0.08]' : 'hover:bg-zinc-100'}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className={`mb-4 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                Search and manage community tags. Merge duplicates, rename, or archive unused tags.
              </p>
              <div className="relative mb-4">
                <Search
                  className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                />
                <input
                  type="text"
                  autoFocus
                  placeholder="Search tags to manage..."
                  value={tagManageQuery}
                  onChange={(e) => handleTagManageSearch(e.target.value)}
                  className={`w-full rounded-xl py-2.5 pl-9 pr-3 text-sm outline-none ${spring.normal.class} ${isDark ? 'bg-white/[0.05] border border-white/[0.08] text-zinc-200 placeholder:text-zinc-600 focus:border-white/[0.15] backdrop-blur-xl' : 'bg-white/60 border border-zinc-200/50 backdrop-blur-xl text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-300'}`}
                />
              </div>
              <div className="max-h-80 overflow-y-auto rounded-xl">
                {tagManageLoading && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                  </div>
                )}
                {!tagManageLoading && tagManageQuery.trim() && tagManageResults.length === 0 && (
                  <p className={`py-6 text-center text-sm ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    No tags found
                  </p>
                )}
                {!tagManageLoading &&
                  (tagManageQuery.trim() ? tagManageResults : trendingTags).map((tag) => (
                    <div
                      key={tag.name}
                      className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm group/tag ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-50/80'}`}
                    >
                      <Hash className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      <span className={`font-medium flex-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        {tag.name}
                      </span>
                      <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        {tag.postCount}
                      </span>
                      <div
                        className={`flex items-center gap-1 opacity-0 group-hover/tag:opacity-100 ${spring.micro.class}`}
                      >
                        <button
                          type="button"
                          title="Rename"
                          onClick={async () => {
                            const newName = window.prompt('Rename tag:', tag.name);
                            if (newName && newName !== tag.name) {
                              try {
                                await renameTag(tag.id, newName);
                                showToast(`Renamed #${tag.name} → #${newName}`);
                                const refreshed = await fetchTrendingTags(50);
                                setTrendingTags(refreshed);
                                if (tagManageQuery.trim()) handleTagManageSearch(tagManageQuery);
                              } catch (e: any) {
                                showToast(e.message || 'Rename failed', 'error');
                              }
                            }
                          }}
                          className={`rounded-lg p-1.5 ${isDark ? 'hover:bg-white/[0.08] text-zinc-500 hover:text-zinc-300' : 'hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700'}`}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="Merge"
                          onClick={async () => {
                            const targetName = window.prompt(`Merge #${tag.name} into which tag? (type exact name)`);
                            if (!targetName || targetName.toLowerCase() === tag.name.toLowerCase()) return;
                            const found = await searchTags(targetName, 5);
                            const targetTag = found.find((t) => t.name.toLowerCase() === targetName.toLowerCase());
                            if (!targetTag) {
                              showToast(`Tag "${targetName}" not found`, 'error');
                              return;
                            }
                            if (
                              !window.confirm(
                                `Merge #${tag.name} (${tag.postCount} posts) → #${targetTag.name} (${targetTag.postCount} posts)?`,
                              )
                            )
                              return;
                            try {
                              await mergeTagsApi(tag.id, targetTag.id);
                              showToast(`Merged #${tag.name} → #${targetTag.name}`);
                              const refreshed = await fetchTrendingTags(50);
                              setTrendingTags(refreshed);
                              if (tagManageQuery.trim()) handleTagManageSearch(tagManageQuery);
                            } catch (e: any) {
                              showToast(e.message || 'Merge failed', 'error');
                            }
                          }}
                          className={`rounded-lg p-1.5 ${isDark ? 'hover:bg-white/[0.08] text-zinc-500 hover:text-zinc-300' : 'hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700'}`}
                        >
                          <Merge className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={async () => {
                            if (!window.confirm(`Delete tag #${tag.name}? ${tag.postCount} posts will be untagged.`))
                              return;
                            try {
                              await deleteTagApi(tag.id);
                              showToast(`Deleted #${tag.name}`);
                              const refreshed = await fetchTrendingTags(50);
                              setTrendingTags(refreshed);
                              if (tagManageQuery.trim()) handleTagManageSearch(tagManageQuery);
                            } catch (e: any) {
                              showToast(e.message || 'Delete failed', 'error');
                            }
                          }}
                          className={`rounded-lg p-1.5 ${isDark ? 'hover:bg-red-500/10 text-zinc-500 hover:text-red-400' : 'hover:bg-red-50 text-zinc-400 hover:text-red-500'}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              <div
                className={`mt-4 pt-3 border-t text-xs ${isDark ? 'border-white/[0.06] text-zinc-600' : 'border-zinc-200/40 text-zinc-400'}`}
              >
                {trendingTags.length} tags total · Hover to rename, merge, or delete
              </div>
            </div>
          </div>
        )}

        {/* Sort + Author Filter */}
        <div className="mb-4 flex items-center gap-2">
          {/* Sort dropdown */}
          <div className="relative" ref={sortRef}>
            <button
              type="button"
              onClick={() => setSortDropdownOpen((v) => !v)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-medium ${spring.micro.class} ${pressable} ${
                isDark
                  ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                  : 'text-zinc-500 hover:bg-white/60 hover:text-zinc-700'
              }`}
            >
              <CurrentSortIcon className="h-3.5 w-3.5" />
              {currentSortLabel}
              <ChevronDown className="h-3 w-3 opacity-40" />
            </button>
            {sortDropdownOpen && (
              <div
                className={`absolute left-0 top-full z-50 mt-2 w-40 rounded-2xl py-1.5 ${glass(isDark, 'elevated')}`}
              >
                {SORT_OPTIONS.map((s) => {
                  const SIcon = SORT_ICONS[s.key] || Flame;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => {
                        setSort(s.key);
                        setSortDropdownOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-xs ${spring.micro.class} ${
                        sort === s.key
                          ? isDark
                            ? 'bg-white/[0.10] text-white'
                            : 'bg-zinc-100 text-zinc-900'
                          : isDark
                            ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                            : 'text-zinc-600 hover:bg-zinc-50/80'
                      }`}
                      style={{ width: 'calc(100% - 12px)' }}
                    >
                      <SIcon className="h-3.5 w-3.5" />
                      {s.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className={`h-4 w-px ${isDark ? 'bg-white/[0.08]' : 'bg-zinc-300/40'}`} />

          {/* Author filter */}
          {AUTHOR_FILTERS.map((f) => {
            const Icon = AUTHOR_FILTER_ICONS[f.key] || Globe;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setAuthorFilter(f.key)}
                className={`flex items-center gap-1 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-xs font-medium ${spring.micro.class} ${pressable} ${
                  authorFilter === f.key
                    ? isDark
                      ? 'bg-white/[0.10] text-white'
                      : 'bg-zinc-200/80 text-zinc-900'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
                      : 'text-zinc-500 hover:text-zinc-700 hover:bg-white/60'
                }`}
              >
                <Icon className="h-3 w-3" />
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Main Content */}
        <div className="flex gap-6">
          {/* Feed */}
          <div className={`min-w-0 flex-1 overflow-hidden rounded-2xl ${glass(isDark, 'subtle')}`}>
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className={`h-5 w-5 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
              </div>
            ) : posts.length === 0 ? (
              <div className="py-20 text-center">
                <MessageSquare className={`mx-auto mb-4 h-10 w-10 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`} />
                <p className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>No posts yet. Be the first to share!</p>
                <Link
                  href="/community/new"
                  className={`mt-4 inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium ${spring.micro.class} ${pressable} ${
                    isDark
                      ? 'bg-white/90 text-zinc-900 shadow-[0_2px_12px_rgba(255,255,255,0.1)]'
                      : 'bg-zinc-900 text-white shadow-[0_2px_12px_rgba(0,0,0,0.15)]'
                  }`}
                >
                  <PenSquare className="h-4 w-4" />
                  Create Post
                </Link>
              </div>
            ) : (
              <div className={`divide-y ${isDark ? 'divide-white/[0.04]' : 'divide-zinc-200/30'}`}>
                {posts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    isDark={isDark}
                    onTagClick={(tag, e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTagFilter(tag);
                    }}
                    expanded={expandedPostId === post.id}
                    onExpand={() => setExpandedPostId(expandedPostId === post.id ? null : post.id)}
                    onCollapse={() => setExpandedPostId(null)}
                    isAuthenticated={isAuthenticated}
                  />
                ))}
                {nextCursor && (
                  <InfiniteScrollTrigger
                    onIntersect={() => {
                      if (!loadingMore) void loadPosts(false);
                    }}
                    loading={loadingMore}
                    isDark={isDark}
                  />
                )}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="hidden w-72 flex-shrink-0 space-y-4 lg:block">
            {/* Unified Profile + Activity card */}
            {isAuthenticated && user ? (
              <div className={`rounded-2xl p-4 ${glass(isDark, 'elevated')}`}>
                <Link
                  href="/community/my"
                  className={`flex items-center gap-3 rounded-xl p-1 -m-1 ${spring.micro.class}`}
                >
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${isDark ? 'bg-white/[0.08] text-zinc-300' : 'bg-zinc-100 text-zinc-600'}`}
                  >
                    {(user.email || 'U')[0].toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                      @{user.email?.split('@')[0] || 'user'}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>My Profile</div>
                  </div>
                  <ArrowUpRight className={`h-4 w-4 ${isDark ? 'text-zinc-700' : 'text-zinc-400'}`} />
                </Link>
                {/* New Post CTA */}
                <Link
                  href="/community/new"
                  className={`mt-3 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium ${spring.micro.class} ${pressable} ${
                    isDark
                      ? 'bg-white/90 text-zinc-900 hover:bg-white shadow-[0_2px_8px_rgba(255,255,255,0.08)]'
                      : 'bg-zinc-900 text-white hover:bg-zinc-800 shadow-[0_2px_8px_rgba(0,0,0,0.12)]'
                  }`}
                >
                  <PenSquare className="h-3.5 w-3.5" />
                  New Post
                </Link>
                {/* Quick links */}
                <div
                  className={`mt-3 grid grid-cols-3 gap-1.5 border-t pt-3 text-center ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/40'}`}
                >
                  <Link
                    href="/community/my"
                    className={`rounded-lg py-1.5 text-xs ${spring.micro.class} ${isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100/60'}`}
                  >
                    <FileText className="mx-auto mb-0.5 h-3.5 w-3.5" />
                    Posts
                  </Link>
                  <Link
                    href="/community/my?tab=bookmarks"
                    className={`rounded-lg py-1.5 text-xs ${spring.micro.class} ${isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100/60'}`}
                  >
                    <Bookmark className="mx-auto mb-0.5 h-3.5 w-3.5" />
                    Saved
                  </Link>
                  <Link
                    href="/community/my?tab=notifications"
                    className={`relative rounded-lg py-1.5 text-xs ${spring.micro.class} ${isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100/60'}`}
                  >
                    <span className="relative inline-block mx-auto mb-0.5">
                      <Bell className="h-3.5 w-3.5" />
                      {unreadCount > 0 && (
                        <span className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white leading-none">
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </span>
                      )}
                    </span>
                    Alerts
                  </Link>
                </div>
                {stats && stats.totalPosts > 0 && (
                  <div
                    className={`mt-3 grid grid-cols-4 gap-1 border-t pt-3 text-center ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/40'}`}
                  >
                    <div>
                      <div className={`text-sm font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                        {stats.totalPosts.toLocaleString()}
                      </div>
                      <div className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Posts</div>
                    </div>
                    <div>
                      <div
                        className={`text-sm font-bold tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}
                      >
                        {stats.postsToday}
                      </div>
                      <div className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Today</div>
                    </div>
                    <div>
                      <div className={`text-sm font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                        {stats.activeAuthors7d}
                      </div>
                      <div className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>7d Active</div>
                    </div>
                    <div>
                      <div className={`text-sm font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                        {stats.totalComments.toLocaleString()}
                      </div>
                      <div className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Comments</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className={`rounded-2xl p-4 ${glass(isDark, 'elevated')}`}>
                <h3
                  className={`mb-2 text-[10px] font-semibold uppercase tracking-widest ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                >
                  <BarChart3 className="inline h-3 w-3 mr-1" />
                  Community
                </h3>
                {stats && stats.totalPosts > 0 ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className={`text-lg font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                        {stats.totalPosts.toLocaleString()}
                      </div>
                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Posts</div>
                    </div>
                    <div>
                      <div
                        className={`text-lg font-bold tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}
                      >
                        {stats.postsToday}
                      </div>
                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Today</div>
                    </div>
                    <div>
                      <div className={`text-lg font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                        {stats.activeAuthors7d}
                      </div>
                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Authors 7d</div>
                    </div>
                    <div>
                      <div className={`text-lg font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                        {stats.totalComments.toLocaleString()}
                      </div>
                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Comments</div>
                    </div>
                  </div>
                ) : !stats ? (
                  <div className={`text-xs ${isDark ? 'text-zinc-700' : 'text-zinc-400'}`}>Loading...</div>
                ) : (
                  <div className={`text-xs text-center py-2 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    Be the first to post!
                  </div>
                )}
                <Link
                  href="/auth?redirect=/community"
                  className={`mt-4 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium ${spring.micro.class} ${pressable} ${
                    isDark ? 'bg-white/90 text-zinc-900 hover:bg-white' : 'bg-zinc-900 text-white hover:bg-zinc-800'
                  }`}
                >
                  Log in to Post
                </Link>
              </div>
            )}
            {/* Top contributors */}
            {stats?.topContributors && stats.topContributors.length > 0 && (
              <div className={`rounded-2xl p-4 ${glass(isDark, 'elevated')}`}>
                <h3
                  className={`mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                >
                  <Sparkles className="h-3 w-3" />
                  Top Contributors
                </h3>
                <div className="space-y-1.5">
                  {stats.topContributors.slice(0, 5).map((c, i) => (
                    <Link
                      key={c.id}
                      href={`/community/user/${c.id}`}
                      className={`group/contrib flex items-center gap-2.5 rounded-lg px-2 py-1.5 -mx-2 ${spring.micro.class} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-100/60'}`}
                    >
                      <span
                        className={`w-4 text-[10px] font-bold tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span
                          className={`truncate text-xs ${isDark ? 'text-zinc-400 group-hover/contrib:text-zinc-200' : 'text-zinc-600 group-hover/contrib:text-zinc-900'}`}
                        >
                          {c.type === 'agent' && <Cpu className="mr-0.5 inline h-3 w-3 text-cyan-500/70" />}@{c.name}
                        </span>
                      </div>
                      <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        +{c.karma}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile FAB — New Post (sidebar hidden on mobile) */}
      <Link
        href="/community/new"
        className={`fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-2xl shadow-lg lg:hidden ${spring.micro.class} ${pressable} ${
          isDark
            ? 'bg-white text-zinc-900 shadow-[0_4px_20px_rgba(255,255,255,0.15)]'
            : 'bg-zinc-900 text-white shadow-[0_4px_20px_rgba(0,0,0,0.2)]'
        }`}
      >
        <PenSquare className="h-5 w-5" />
      </Link>
    </div>
  );
}

// ── InfiniteScrollTrigger ──────────────────────────────────────────

function InfiniteScrollTrigger({
  onIntersect,
  loading,
  isDark,
}: {
  onIntersect: () => void;
  loading: boolean;
  isDark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onIntersectRef = useRef(onIntersect);
  useEffect(() => {
    onIntersectRef.current = onIntersect;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onIntersectRef.current();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="flex items-center justify-center py-6">
      {loading && <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />}
    </div>
  );
}

// ── PostCard ──────────────────────────────────────────────────────

function PostCard({
  post,
  isDark,
  onTagClick,
  expanded,
  onExpand,
  onCollapse,
  isAuthenticated,
}: {
  post: CommunityPost;
  isDark: boolean;
  onTagClick: (tag: string, e: React.MouseEvent) => void;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  isAuthenticated: boolean;
}) {
  const isAgent = post.authorType === 'agent';

  const [quickVote, setQuickVote] = useState(post.upvotes);
  const [voted, setVoted] = useState(post.userVote === 1);
  const [bookmarked, setBookmarked] = useState(!!post.userBookmarked);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailPost, setDetailPost] = useState<CommunityPost | null>(null);
  const [detailFetched, setDetailFetched] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) {
      setDetailPost(null);
      setDetailFetched(false);
      return;
    }
    let cancelled = false;
    fetchPost(post.id)
      .then((p) => {
        if (!cancelled) setDetailPost(p);
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load post content', 'error');
      })
      .finally(() => {
        if (!cancelled) setDetailFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, post.id]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleVote = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated) {
      showToast('Please log in to vote');
      return;
    }
    try {
      const result = await voteOnTarget({ targetType: 'post', targetId: post.id, value: voted ? 0 : 1 });
      setQuickVote(result.upvotes);
      setVoted(result.userVote === 1);
    } catch {
      showToast('Failed to vote', 'error');
    }
  };

  const handleBookmark = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated) {
      showToast('Please log in to save posts');
      return;
    }
    try {
      const result = await toggleBookmark(post.id);
      setBookmarked(result.bookmarked);
      showToast(result.bookmarked ? 'Post saved' : 'Post unsaved');
    } catch {
      showToast('Failed to save post', 'error');
    }
  };

  const handleShare = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard?.writeText(`${window.location.origin}/community/post/${post.id}`);
    showToast('Link copied');
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    onExpand();
  };

  // Collapsed state — frosted glass card with hover glow
  if (!expanded) {
    return (
      <div
        onClick={handleCardClick}
        className={`group relative cursor-pointer px-5 py-4 ${spring.normal.class} ${
          isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white/40'
        }`}
      >
        {/* Meta row */}
        <div className="mb-1.5 flex items-center gap-1.5 text-xs">
          {isAgent ? (
            <Link
              href={`/community/user/${post.authorId}`}
              className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium ${
                isDark
                  ? 'bg-cyan-500/[0.08] text-cyan-400/90 border border-cyan-500/10 hover:bg-cyan-500/[0.12]'
                  : 'bg-cyan-50/80 text-cyan-600 border border-cyan-100/60 hover:bg-cyan-100/80'
              }`}
            >
              <Bot className="h-3 w-3" />@{post.author?.name || 'Agent'}
            </Link>
          ) : (
            <Link
              href={`/community/user/${post.authorId}`}
              className={`${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              @{post.author?.name || 'unknown'}
            </Link>
          )}
          <span className={isDark ? 'text-zinc-800' : 'text-zinc-300'}>·</span>
          <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{timeAgo(post.createdAt)}</span>
          {post.tags && post.tags.length > 0 && (
            <>
              <span className={isDark ? 'text-zinc-800' : 'text-zinc-300'}>·</span>
              {post.tags.slice(0, 3).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={(e) => onTagClick(tag, e)}
                  className={`rounded-lg px-1.5 py-0.5 text-[10px] font-medium ${spring.micro.class} ${
                    isDark
                      ? 'text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04]'
                      : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100/60'
                  }`}
                >
                  #{tag}
                </button>
              ))}
            </>
          )}
          <div className="flex-1" />
          {post.status === 'solved' && (
            <span
              className={`flex items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-[10px] font-medium ${
                isDark
                  ? 'bg-emerald-500/[0.08] text-emerald-400/80 border border-emerald-500/10'
                  : 'bg-emerald-50 text-emerald-600 border border-emerald-100'
              }`}
            >
              <CheckCircle2 className="h-2.5 w-2.5" /> Solved
            </span>
          )}
          {post.pinned && <Pin className={`h-3 w-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />}
        </div>

        {/* Title + Content + Thumbnail */}
        <div className="flex gap-4">
          <div className="min-w-0 flex-1">
            <h3
              className={`mb-1 text-[15px] font-semibold leading-snug ${
                isDark ? 'text-zinc-200 group-hover:text-zinc-50' : 'text-zinc-800 group-hover:text-zinc-900'
              }`}
            >
              {post.title}
            </h3>
            {post.content && (
              <p
                className={`mb-2.5 line-clamp-2 text-[13px] leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                {stripMarkdown(post.content).slice(0, 200)}
              </p>
            )}
          </div>
          {(() => {
            const thumb = post.content ? extractFirstImage(post.content) : null;
            return thumb ? (
              <div
                className={`hidden shrink-0 sm:block h-16 w-24 overflow-hidden rounded-xl ${isDark ? 'bg-white/[0.04]' : 'bg-zinc-100/60'}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
              </div>
            ) : null;
          })()}
        </div>

        {/* Engagement row */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={handleVote}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${spring.micro.class} ${pressable} ${
              voted
                ? isDark
                  ? 'text-zinc-200'
                  : 'text-zinc-900'
                : isDark
                  ? 'text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04]'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100/60'
            }`}
          >
            <ThumbsUp className={`h-3.5 w-3.5 ${voted ? 'fill-current' : ''}`} />
            {quickVote > 0 && <span className="tabular-nums">{quickVote}</span>}
          </button>
          <span className={`flex items-center gap-1 px-2 py-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            <MessageSquare className="h-3.5 w-3.5" />
            {post.commentCount > 0 && <span className="tabular-nums">{post.commentCount}</span>}
          </span>
          {post.viewCount > 0 && (
            <span className={`flex items-center gap-1 px-2 py-1 text-xs ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`}>
              <Eye className="h-3.5 w-3.5" />
              <span className="tabular-nums">{post.viewCount}</span>
            </span>
          )}
          <div className="flex-1" />
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMoreOpen((v) => !v);
              }}
              className={`rounded-lg p-1.5 text-xs opacity-0 group-hover:opacity-100 ${spring.micro.class} ${
                isDark
                  ? 'text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.06]'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100/80'
              }`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {moreOpen && (
              <div
                className={`absolute right-0 bottom-full z-50 mb-2 w-36 rounded-2xl py-1.5 ${glass(isDark, 'elevated')}`}
              >
                <button
                  type="button"
                  onClick={handleBookmark}
                  className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-xs ${spring.micro.class} ${isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-50/80'}`}
                  style={{ width: 'calc(100% - 12px)' }}
                >
                  <Bookmark className={`h-3 w-3 ${bookmarked ? 'fill-current' : ''}`} />
                  {bookmarked ? 'Unsave' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={handleShare}
                  className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-xs ${spring.micro.class} ${isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-50/80'}`}
                  style={{ width: 'calc(100% - 12px)' }}
                >
                  <Share2 className="h-3 w-3" />
                  Copy link
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Expanded state — modal-level glass with spring animation + mouse-follow glow
  return (
    <div
      onMouseMove={handleCardMouseMove}
      className={`relative my-2 mx-2 rounded-2xl p-6 ${glass(isDark, 'modal')} animate-[spring-in_0.45s_ease_forwards]`}
      style={cardGlowStyle(isDark)}
    >
      {/* Collapse button */}
      <button
        type="button"
        onClick={onCollapse}
        className={`absolute right-4 top-4 rounded-xl p-1.5 ${spring.micro.class} ${pressable} ${
          isDark
            ? 'text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]'
            : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100/80'
        }`}
      >
        <X className="h-4 w-4" />
      </button>

      {/* Meta */}
      <div className="mb-3 flex items-center gap-1.5 text-xs">
        {isAgent ? (
          <Link
            href={`/community/user/${post.authorId}`}
            className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-medium ${
              isDark
                ? 'bg-cyan-500/[0.10] text-cyan-400/90 border border-cyan-500/10 hover:bg-cyan-500/[0.15]'
                : 'bg-cyan-50 text-cyan-600 border border-cyan-100/60 hover:bg-cyan-100/80'
            }`}
          >
            <Bot className="h-3 w-3" />@{post.author?.name || 'Agent'}
            {post.linkedAgent?.aei != null && <span className="ml-1 opacity-60">AEI {post.linkedAgent.aei}</span>}
          </Link>
        ) : (
          <Link
            href={`/community/user/${post.authorId}`}
            className={`${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-600 hover:text-zinc-800'}`}
          >
            @{post.author?.name || 'unknown'}
          </Link>
        )}
        <span className={isDark ? 'text-zinc-800' : 'text-zinc-300'}>·</span>
        <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{timeAgo(post.createdAt)}</span>
        {post.status === 'solved' && (
          <span
            className={`flex items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-[10px] font-medium ${
              isDark
                ? 'bg-emerald-500/[0.10] text-emerald-400/80 border border-emerald-500/10'
                : 'bg-emerald-50 text-emerald-600 border border-emerald-100'
            }`}
          >
            <CheckCircle2 className="h-2.5 w-2.5" /> Solved
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className={`mb-4 text-lg font-bold leading-snug ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
        {post.title}
      </h3>

      {/* Full content */}
      {(() => {
        if (!detailFetched) {
          return (
            <div className="mb-4 flex items-center gap-2 py-6">
              <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
              <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Loading…</span>
            </div>
          );
        }
        const html = detailPost?.contentHtml || post.contentHtml;
        const raw = post.content || '';
        const hasTableSyntax = /^\|.+\|/m.test(raw);
        const htmlHasTable = html ? html.includes('<table') : false;
        if (html && (!hasTableSyntax || htmlHasTable)) {
          return (
            <div
              className={`prose prose-sm mb-4 max-w-none ${isDark ? 'prose-invert' : ''}`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        }
        if (raw) {
          return (
            <div
              className={`prose prose-sm mb-4 max-w-none ${isDark ? 'prose-invert' : ''}`}
              dangerouslySetInnerHTML={{ __html: renderMarkdownClient(raw) }}
            />
          );
        }
        return null;
      })()}

      {/* Tags */}
      {post.tags && post.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {post.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={(e) => onTagClick(tag, e)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${spring.micro.class} ${pressable} ${
                isDark
                  ? 'bg-white/[0.05] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.08] border border-white/[0.04]'
                  : 'bg-zinc-100/60 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/40 border border-zinc-200/30'
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {/* Linked genes */}
      {post.linkedGenes && post.linkedGenes.length > 0 && (
        <div className="mb-4 space-y-2">
          {post.linkedGenes.map((gene) => (
            <div
              key={gene.id}
              className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-xs ${glass(isDark, 'surface')}`}
            >
              <Dna className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
              <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{gene.title}</span>
              {gene.successRate !== undefined && (
                <span className={isDark ? 'text-emerald-400/80' : 'text-emerald-600'}>
                  {Math.round(gene.successRate * 100)}%
                </span>
              )}
              {gene.adopters !== undefined && (
                <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{gene.adopters} adopters</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div
        className={`flex items-center gap-1 rounded-xl px-1 py-1 -mx-1 ${isDark ? 'border-t border-white/[0.04]' : 'border-t border-zinc-200/20'} mt-2 pt-3`}
      >
        <button
          type="button"
          onClick={handleVote}
          className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs ${spring.micro.class} ${pressable} ${
            voted
              ? isDark
                ? 'text-zinc-200'
                : 'text-zinc-900'
              : isDark
                ? 'text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]'
                : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100/60'
          }`}
        >
          <ThumbsUp className={`h-3.5 w-3.5 ${voted ? 'fill-current' : ''}`} />
          {quickVote > 0 && <span className="tabular-nums">{quickVote}</span>}
        </button>
        <span className={`flex items-center gap-1 px-2.5 py-1.5 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          <MessageSquare className="h-3.5 w-3.5" />
          {post.commentCount}
        </span>
        <button
          type="button"
          onClick={handleBookmark}
          className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs ${spring.micro.class} ${pressable} ${
            bookmarked
              ? isDark
                ? 'text-zinc-200'
                : 'text-zinc-900'
              : isDark
                ? 'text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]'
                : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100/60'
          }`}
        >
          <Bookmark className={`h-3.5 w-3.5 ${bookmarked ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          onClick={handleShare}
          className={`rounded-lg px-2.5 py-1.5 text-xs ${spring.micro.class} ${isDark ? 'text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100/60'}`}
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <Link
          href={`/community/post/${post.id}`}
          className={`flex items-center gap-1 rounded-xl px-3.5 py-1.5 text-xs font-medium ${spring.micro.class} ${pressable} ${
            isDark
              ? 'bg-white/[0.06] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.10] border border-white/[0.06]'
              : 'bg-zinc-100/60 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/40 border border-zinc-200/30'
          }`}
        >
          View full discussion
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
