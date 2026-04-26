'use client';

import { Suspense, useState, useEffect, useMemo, useCallback, useRef, use } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Loader2,
  Calendar,
  Globe,
  Award,
  MessageSquare,
  FileText,
  UserPlus,
  UserMinus,
  Flame,
  Bot,
  User,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import {
  type CommunityProfile,
  type CommunityPost,
  glass,
  timeAgo,
  fetchProfile,
  fetchActivityHeatmap,
  fetchPosts,
  followUser,
  checkIsFollowing,
  fetchBookmarkedPosts,
  springHover,
  springPress,
  showToast,
} from '../../components/helpers';

type ProfileTab = 'posts' | 'bookmarks';

function normalizeProfileTab(raw: string | null, isSelf: boolean): ProfileTab {
  if (raw === 'bookmarks' && isSelf) return 'bookmarks';
  return 'posts';
}

function ProfileSkeleton() {
  return (
    <div className="min-h-screen bg-[#f4f4f7] dark:bg-[#0A0A0F]">
      <div className="mx-auto max-w-3xl px-4 pt-20 pb-12">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-zinc-200 dark:bg-zinc-800/50 animate-pulse" />
          <div className="space-y-2">
            <div className="h-6 w-40 rounded bg-zinc-200 dark:bg-zinc-800/50 animate-pulse" />
            <div className="h-4 w-24 rounded bg-zinc-200/60 dark:bg-zinc-800/30 animate-pulse" />
          </div>
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 rounded-2xl bg-zinc-200/60 dark:bg-zinc-800/30 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function UserProfilePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <UserProfilePageContent params={params} />
    </Suspense>
  );
}

function UserProfilePageContent({ params }: { params: Promise<{ id: string }> }) {
  const { id: userId } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const { user: currentUser } = useApp();
  const isDark = resolvedTheme === 'dark';
  const isSelf = String(currentUser?.id) === userId;
  const tabParam = searchParams.get('tab');
  const tab: ProfileTab = normalizeProfileTab(tabParam, isSelf);

  const [profile, setProfile] = useState<CommunityProfile | null>(null);
  const [heatmap, setHeatmap] = useState<Record<string, number>>({});
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [postsNextCursor, setPostsNextCursor] = useState<string | null>(null);
  const postsCursorRef = useRef<string | null>(null);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [bookmarkedPosts, setBookmarkedPosts] = useState<CommunityPost[]>([]);
  const [bookmarksNextCursor, setBookmarksNextCursor] = useState<string | null>(null);
  const bookmarksCursorRef = useRef<string | null>(null);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);
  const [loadingMoreBookmarks, setLoadingMoreBookmarks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);

  useEffect(() => {
    postsCursorRef.current = postsNextCursor;
  }, [postsNextCursor]);
  useEffect(() => {
    bookmarksCursorRef.current = bookmarksNextCursor;
  }, [bookmarksNextCursor]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchProfile(userId),
      fetchActivityHeatmap(userId),
      fetchPosts({ authorId: userId, limit: 20, sort: 'new' }),
    ])
      .then(([p, h, postData]) => {
        if (cancelled) return;
        setProfile(p);
        setHeatmap(h);
        setPosts(postData.posts);
        setPostsNextCursor(postData.nextCursor);
      })
      .catch((e) => {
        console.error(e);
        showToast('Failed to load profile', 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const loadMorePosts = useCallback(async () => {
    const c = postsCursorRef.current;
    if (!c) return;
    try {
      setLoadingMorePosts(true);
      const result = await fetchPosts({
        authorId: userId,
        limit: 20,
        sort: 'new',
        cursor: c,
      });
      setPosts((prev) => [...prev, ...result.posts]);
      setPostsNextCursor(result.nextCursor);
    } catch (e) {
      console.error(e);
      showToast('Failed to load more posts', 'error');
    } finally {
      setLoadingMorePosts(false);
    }
  }, [userId]);

  const loadBookmarks = useCallback(async (reset = false) => {
    try {
      if (reset) setBookmarksLoading(true);
      else setLoadingMoreBookmarks(true);
      const cursor = reset ? undefined : (bookmarksCursorRef.current ?? undefined);
      const data = await fetchBookmarkedPosts({ cursor, limit: 20 });
      setBookmarkedPosts((prev) => (reset ? data.posts : [...prev, ...data.posts]));
      setBookmarksNextCursor(data.nextCursor);
    } catch (e) {
      console.error(e);
      showToast('Failed to load bookmarks', 'error');
    } finally {
      setBookmarksLoading(false);
      setLoadingMoreBookmarks(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser?.id && !isSelf) {
      checkIsFollowing(userId).then(setIsFollowing).catch(() => {});
    }
  }, [currentUser, userId, isSelf]);

  useEffect(() => {
    if (tab !== 'bookmarks' || !isSelf) return;
    void loadBookmarks(true);
  }, [tab, isSelf, loadBookmarks]);

  useEffect(() => {
    if (loading || !profile) return;
    const raw = searchParams.get('tab');
    if (!raw) return;
    const normalized = normalizeProfileTab(raw, isSelf);
    if (normalized !== raw) {
      router.replace(`/community/user/${userId}?tab=${normalized}`, { scroll: false });
    }
  }, [loading, profile, isSelf, userId, searchParams, router]);

  const handleFollow = async () => {
    try {
      const result = await followUser(userId);
      setIsFollowing(result.followed);
      if (profile) {
        setProfile({
          ...profile,
          followerCount: profile.followerCount + (result.followed ? 1 : -1),
        });
      }
    } catch (e) {
      console.error('Follow failed:', e);
      showToast('Failed to update follow', 'error');
    }
  };

  const heatmapWeeks = useMemo(() => {
    const weeks: { date: string; count: number }[][] = [];
    const today = new Date();
    for (let w = 51; w >= 0; w--) {
      const week: { date: string; count: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() - w * 7 - (6 - d));
        const key = date.toISOString().slice(0, 10);
        week.push({ date: key, count: heatmap[key] || 0 });
      }
      weeks.push(week);
    }
    return weeks;
  }, [heatmap]);

  const totalActivity = Object.values(heatmap).reduce((a, b) => a + b, 0);

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-[#0A0A0A]' : 'bg-zinc-50'}`}>
        <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center gap-4 ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
        <User className="h-16 w-16 text-zinc-600" />
        <p className="text-lg">User not found</p>
        <Link href="/community" className="text-violet-400 hover:underline">Back to community</Link>
      </div>
    );
  }

  const isAgent = profile.user?.role === 'agent';

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <div className="mx-auto max-w-4xl px-4 pb-12 pt-24 sm:px-6">
        <Link href="/community" className={`mb-6 inline-flex items-center gap-2 text-sm ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}>
          <ArrowLeft className="h-4 w-4" />
          Back to Community
        </Link>

        {/* Profile Header */}
        <div className={`rounded-2xl p-6 mb-6 ${glass(isDark, 'elevated')}`}>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            <div className={`flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold ${
              isAgent
                ? 'bg-gradient-to-br from-cyan-500/20 to-teal-500/20 text-cyan-400 ring-2 ring-cyan-400/30'
                : 'bg-gradient-to-br from-violet-500/20 to-purple-500/20 text-violet-400 ring-2 ring-violet-400/30'
            }`}>
              {profile.user?.avatarUrl ? (
                <img src={profile.user.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
              ) : isAgent ? (
                <Bot className="h-8 w-8" />
              ) : (
                (profile.user?.displayName || profile.user?.username || '?')[0].toUpperCase()
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold truncate">
                  {isAgent && <Bot className="inline h-5 w-5 text-cyan-400 mr-1" />}
                  @{profile.user?.displayName || profile.user?.username || userId}
                </h1>
                {isAgent && (
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${isDark ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-100 text-cyan-600'}`}>
                    Agent
                  </span>
                )}
              </div>

              {profile.bio && (
                <p className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{profile.bio}</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                <span className={isDark ? 'text-violet-400' : 'text-violet-600'}>
                  <Award className="inline h-3.5 w-3.5 mr-1" />
                  Karma: {profile.karmaTotal}
                </span>
                <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                  <FileText className="inline h-3.5 w-3.5 mr-1" />
                  {profile.postCount} posts
                </span>
                <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                  <MessageSquare className="inline h-3.5 w-3.5 mr-1" />
                  {profile.commentCount} comments
                </span>
                {profile.streakDays > 0 && (
                  <span className="text-orange-400">
                    <Flame className="inline h-3.5 w-3.5 mr-1" />
                    {profile.streakDays}d streak
                  </span>
                )}
              </div>

              <div className="mt-2 flex items-center gap-3 text-sm">
                <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                  <strong>{profile.followerCount}</strong> followers
                </span>
                <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                  <strong>{profile.followingCount}</strong> following
                </span>
              </div>

              {profile.website && (
                <a href={profile.website} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-violet-400 hover:underline">
                  <Globe className="h-3.5 w-3.5" />
                  {profile.website.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>

            {!isSelf && currentUser && (
              <button
                type="button"
                onClick={handleFollow}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${springHover} ${springPress} ${
                  isFollowing
                    ? isDark ? 'border border-white/10 bg-white/5 text-zinc-300 hover:bg-red-500/10 hover:text-red-400 hover:border-red-400/30' : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-red-50 hover:text-red-500'
                    : 'bg-gradient-to-r from-violet-600 to-cyan-600 text-white shadow-lg shadow-violet-500/20'
                }`}
              >
                {isFollowing ? <UserMinus className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
                {isFollowing ? 'Unfollow' : 'Follow'}
              </button>
            )}
          </div>

          {/* Badges */}
          {profile.badges && profile.badges.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {profile.badges.map((b) => (
                <span
                  key={b.badge}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${isDark ? 'bg-amber-500/10 text-amber-400 border border-amber-400/20' : 'bg-amber-100 text-amber-600'}`}
                >
                  {b.badge}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Activity Heatmap */}
        <div className={`rounded-2xl p-5 mb-6 ${glass(isDark, 'subtle')}`}>
          <h3 className={`mb-3 text-sm font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            <Calendar className="inline h-4 w-4 mr-1.5 text-emerald-400" />
            Activity · {totalActivity} actions in the past year
          </h3>
          <div className="overflow-x-auto">
            <div className="flex gap-[3px]">
              {heatmapWeeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-[3px]">
                  {week.map((day) => {
                    const level = day.count === 0 ? 0 : day.count <= 2 ? 1 : day.count <= 5 ? 2 : day.count <= 10 ? 3 : 4;
                    const colors = isDark
                      ? ['bg-white/[0.04]', 'bg-emerald-500/20', 'bg-emerald-500/40', 'bg-emerald-500/60', 'bg-emerald-400']
                      : ['bg-zinc-100', 'bg-emerald-200', 'bg-emerald-300', 'bg-emerald-400', 'bg-emerald-500'];
                    return (
                      <div
                        key={day.date}
                        className={`h-[11px] w-[11px] rounded-[2px] ${colors[level]}`}
                        title={`${day.date}: ${day.count} actions`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Tabs — only tabs backed by real data (followers/following/comments UI not shipped yet) */}
        <div className="mb-6 flex flex-wrap items-center gap-1 border-b border-white/10">
          {(isSelf ? (['posts', 'bookmarks'] as const) : (['posts'] as const)).map((t) => (
            <Link
              key={t}
              href={`/community/user/${userId}?tab=${t}`}
              scroll={false}
              className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? `border-b-2 ${isDark ? 'border-violet-400 text-violet-400' : 'border-violet-500 text-violet-600'}`
                  : isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'
              }`}
            >
              {t}
            </Link>
          ))}
        </div>

        {tab === 'posts' && (
          <div className="space-y-3">
            {posts.length === 0 ? (
              <div className={`rounded-xl py-12 text-center ${glass(isDark, 'subtle')}`}>
                <p className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>No posts yet</p>
              </div>
            ) : (
              <>
                {posts.map((post) => (
                  <Link key={post.id} href={`/community/post/${post.id}`}>
                    <div className={`rounded-xl p-4 ${springHover} ${glass(isDark, 'subtle')} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white'}`}>
                      <h4 className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{post.title}</h4>
                      <div className="mt-1 flex items-center gap-3 text-xs">
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{timeAgo(post.createdAt)}</span>
                        <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>↑{post.upvotes}</span>
                        <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{post.commentCount} comments</span>
                      </div>
                    </div>
                  </Link>
                ))}
                {postsNextCursor && (
                  <LoadMoreButton
                    isDark={isDark}
                    loading={loadingMorePosts}
                    onClick={() => void loadMorePosts()}
                  />
                )}
              </>
            )}
          </div>
        )}

        {tab === 'bookmarks' && isSelf && (
          <div className="space-y-3">
            {bookmarksLoading ? (
              <div className={`flex justify-center py-12 ${glass(isDark, 'subtle')} rounded-xl`}>
                <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
              </div>
            ) : bookmarkedPosts.length === 0 ? (
              <div className={`rounded-xl py-12 text-center ${glass(isDark, 'subtle')}`}>
                <p className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>No bookmarks yet</p>
              </div>
            ) : (
              <>
                {bookmarkedPosts.map((post) => (
                  <Link key={post.id} href={`/community/post/${post.id}`}>
                    <div className={`rounded-xl p-4 ${springHover} ${glass(isDark, 'subtle')} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white'}`}>
                      <h4 className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{post.title}</h4>
                      <div className="mt-1 flex items-center gap-3 text-xs">
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{timeAgo(post.createdAt)}</span>
                        <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>↑{post.upvotes}</span>
                        <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{post.commentCount} comments</span>
                      </div>
                    </div>
                  </Link>
                ))}
                {bookmarksNextCursor && (
                  <LoadMoreButton
                    isDark={isDark}
                    loading={loadingMoreBookmarks}
                    onClick={() => void loadBookmarks(false)}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadMoreButton({
  isDark,
  loading,
  onClick,
}: {
  isDark: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`w-full rounded-xl py-3 text-sm font-medium transition-colors ${glass(isDark, 'subtle')} ${
        isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'
      }`}
    >
      {loading ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Load more'}
    </button>
  );
}
