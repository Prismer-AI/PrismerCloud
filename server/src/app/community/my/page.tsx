'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  FileText,
  Bookmark,
  Bell,
  ThumbsUp,
  MessageSquare,
  Eye,
  CheckCircle2,
  Loader2,
  Trophy,
  MessageCircle,
  AtSign,
  UserPlus,
  Dna,
  Target,
  BookOpen,
  Lightbulb,
  Megaphone,
  HelpCircle,
  Award,
  Flame,
  Calendar,
  ExternalLink,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import {
  type CommunityPost,
  type CommunityNotification,
  type CommunityProfile,
  glass,
  timeAgo,
  fetchPosts,
  fetchBookmarkedPosts,
  fetchNotifications,
  markNotificationsRead,
  fetchMyCommunityProfile,
  spring,
  pressable,
  handleCardMouseMove,
  cardGlowStyle,
  SPRING_KEYFRAMES,
  showToast,
} from '../components/helpers';

const POST_TYPE_ICONS: Record<string, typeof MessageCircle> = {
  discussion: MessageCircle,
  battleReport: Trophy,
  help: HelpCircle,
  tutorial: BookOpen,
  idea: Lightbulb,
  geneAnalysis: Dna,
  changelog: Megaphone,
  milestone: Target,
};

type TabKey = 'posts' | 'bookmarks' | 'notifications';

const TABS: { key: TabKey; label: string; icon: typeof FileText }[] = [
  { key: 'posts', label: 'My Posts', icon: FileText },
  { key: 'bookmarks', label: 'Bookmarks', icon: Bookmark },
  { key: 'notifications', label: 'Notifications', icon: Bell },
];

const NOTIFICATION_ICONS: Record<string, typeof MessageCircle> = {
  reply: MessageCircle,
  vote: ThumbsUp,
  best_answer: Trophy,
  mention: AtSign,
  follow: UserPlus,
};

const NOTIFICATION_LABELS: Record<string, string> = {
  reply: 'replied to your post',
  vote: 'upvoted your content',
  best_answer: 'your answer was marked as best',
  mention: 'mentioned you',
  follow: 'started following you',
};

function MySkeleton() {
  return (
    <div className="min-h-screen bg-[#f4f4f7] dark:bg-[#0A0A0F]">
      <div className="mx-auto max-w-3xl px-4 pt-20 pb-12">
        <div className="h-8 w-40 rounded-lg bg-zinc-200 dark:bg-zinc-800/50 animate-pulse mb-6" />
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-2xl bg-zinc-200/60 dark:bg-zinc-800/30 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MyPage() {
  return (
    <Suspense fallback={<MySkeleton />}>
      <MyPageContent />
    </Suspense>
  );
}

function MyPageContent() {
  const { resolvedTheme } = useTheme();
  const { isAuthenticated, isAuthLoading, user } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isDark = resolvedTheme === 'dark';

  const initialTab = (searchParams.get('tab') as TabKey) || 'posts';
  const [tab, setTab] = useState<TabKey>(initialTab);

  const [myPosts, setMyPosts] = useState<CommunityPost[]>([]);
  const [myPostsCursor, setMyPostsCursor] = useState<string | null>(null);
  const myPostsCursorRef = useRef<string | null>(null);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);

  const [bookmarks, setBookmarks] = useState<CommunityPost[]>([]);
  const [bookmarksCursor, setBookmarksCursor] = useState<string | null>(null);
  const bookmarksCursorRef = useRef<string | null>(null);
  const [loadingBookmarks, setLoadingBookmarks] = useState(false);
  const [loadingMoreBookmarks, setLoadingMoreBookmarks] = useState(false);

  const [notifications, setNotifications] = useState<CommunityNotification[]>([]);
  const [notificationsTotal, setNotificationsTotal] = useState(0);
  const notificationsRef = useRef<CommunityNotification[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [loadingMoreNotifications, setLoadingMoreNotifications] = useState(false);
  const [profile, setProfile] = useState<CommunityProfile | null>(null);

  useEffect(() => { myPostsCursorRef.current = myPostsCursor; }, [myPostsCursor]);
  useEffect(() => { bookmarksCursorRef.current = bookmarksCursor; }, [bookmarksCursor]);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);

  useEffect(() => {
    if (isAuthLoading) return;
    const params = new URLSearchParams();
    if (tab !== 'posts') params.set('tab', tab);
    const qs = params.toString();
    router.replace(`/community/my${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [tab, router, isAuthLoading]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isAuthenticated) {
      router.replace(`/auth?redirect=${encodeURIComponent('/community/my')}`);
    }
  }, [isAuthenticated, isAuthLoading, router]);

  const loadMyPosts = useCallback(async (reset = false) => {
    if (!user?.id) return;
    try {
      if (reset) setLoadingPosts(true);
      else setLoadingMorePosts(true);
      const cursor = reset ? undefined : (myPostsCursorRef.current ?? undefined);
      const result = await fetchPosts({
        sort: 'new',
        cursor,
        limit: 20,
        authorId: String(user.id),
      });
      setMyPosts((prev) => (reset ? result.posts : [...prev, ...result.posts]));
      setMyPostsCursor(result.nextCursor);
    } catch (e) {
      console.error('[Community] Failed to load my posts:', e);
      showToast('Failed to load your posts', 'error');
    } finally {
      setLoadingPosts(false);
      setLoadingMorePosts(false);
    }
  }, [user?.id]);

  const loadBookmarks = useCallback(async (reset = false) => {
    try {
      if (reset) setLoadingBookmarks(true);
      else setLoadingMoreBookmarks(true);
      const cursor = reset ? undefined : (bookmarksCursorRef.current ?? undefined);
      const result = await fetchBookmarkedPosts({ cursor, limit: 20 });
      setBookmarks((prev) => reset ? result.posts : [...prev, ...result.posts]);
      setBookmarksCursor(result.nextCursor);
    } catch (e) {
      console.error('[Community] Failed to load bookmarks:', e);
      showToast('Failed to load bookmarks', 'error');
    } finally {
      setLoadingBookmarks(false);
      setLoadingMoreBookmarks(false);
    }
  }, []);

  const loadNotifications = useCallback(async (reset = false) => {
    try {
      if (reset) setLoadingNotifications(true);
      else setLoadingMoreNotifications(true);
      const offset = reset ? 0 : notificationsRef.current.length;
      const { notifications: batch, total } = await fetchNotifications({ limit: 20, offset });
      setNotifications((prev) => (reset ? batch : [...prev, ...batch]));
      setNotificationsTotal(total);
    } catch (e) {
      console.error('[Community] Failed to load notifications:', e);
      showToast('Failed to load notifications', 'error');
    } finally {
      setLoadingNotifications(false);
      setLoadingMoreNotifications(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthLoading || !isAuthenticated || !user?.id) return;
    if (!profile) {
      fetchMyCommunityProfile().then(setProfile).catch(() => {
        showToast('Failed to load profile', 'error');
      });
    }
    if (tab === 'posts') void loadMyPosts(true);
    else if (tab === 'bookmarks') void loadBookmarks(true);
    else if (tab === 'notifications') void loadNotifications(true);
  }, [tab, loadMyPosts, loadBookmarks, loadNotifications, isAuthLoading, isAuthenticated, user?.id, profile]);

  const handleMarkAllRead = async () => {
    try {
      await markNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (e) {
      console.error('[Community] Failed to mark all read:', e);
      showToast('Failed to mark notifications as read', 'error');
    }
  };

  const handleMarkRead = async (notifId: string) => {
    try {
      await markNotificationsRead(notifId);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notifId ? { ...n, read: true } : n)),
      );
    } catch (e) {
      console.error('[Community] Failed to mark read:', e);
      showToast('Failed to mark notification as read', 'error');
    }
  };

  if (isAuthLoading || !isAuthenticated) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-[#0A0A0A]' : 'bg-zinc-50'}`}>
        <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
      </div>
    );
  }

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <style>{SPRING_KEYFRAMES}</style>
      <div className="mx-auto max-w-4xl px-4 pb-12 pt-24 sm:px-6 lg:px-8">
        {/* Back nav */}
        <button
          type="button"
          onClick={() => router.push('/community')}
          className={`mb-6 flex items-center gap-2 text-sm transition-colors ${
            isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
          }`}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Community
        </button>

        {/* Profile Header */}
        <div className={`mb-8 rounded-2xl p-6 ${glass(isDark, 'elevated')}`}>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            <div className={`flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold ${
              isDark
                ? 'bg-gradient-to-br from-violet-500/20 to-purple-500/20 text-violet-400 ring-2 ring-violet-400/30'
                : 'bg-gradient-to-br from-violet-500/10 to-purple-500/10 text-violet-500 ring-2 ring-violet-500/20'
            }`}>
              {profile?.user?.avatarUrl ? (
                <img src={profile.user.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
              ) : (
                (user?.email || 'U')[0].toUpperCase()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold truncate">
                @{profile?.user?.displayName || profile?.user?.username || user?.email?.split('@')[0] || 'user'}
              </h1>
              {profile?.bio && (
                <p className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{profile.bio}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                {profile && (
                  <>
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
                  </>
                )}
                {!profile && (
                  <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>
                    Your posts, bookmarks, and notifications
                  </span>
                )}
              </div>
              {profile && (
                <div className="mt-2 flex items-center gap-3 text-sm">
                  <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                    <strong>{profile.followerCount}</strong> followers
                  </span>
                  <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                    <strong>{profile.followingCount}</strong> following
                  </span>
                </div>
              )}
            </div>
          </div>
          {profile?.badges && profile.badges.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2 pt-3 border-t border-white/[0.06]">
              {profile.badges.map((b) => (
                <span key={b.badge} className={`rounded-full px-3 py-1 text-xs font-medium ${isDark ? 'bg-amber-500/10 text-amber-400 border border-amber-400/20' : 'bg-amber-100 text-amber-600'}`}>
                  {b.badge}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className={`mb-6 flex items-center gap-1 rounded-xl p-1 ${glass(isDark, 'subtle')}`}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`relative flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ${spring.normal.class} ${pressable} ${
                  isActive
                    ? isDark
                      ? 'bg-white/10 text-white'
                      : 'bg-white text-zinc-900 shadow-sm'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
                {t.key === 'notifications' && unreadCount > 0 && (
                  <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-violet-500 px-1.5 text-xs font-bold text-white">
                    {unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {tab === 'posts' && (
          <div className="space-y-4">
            {loadingPosts ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
              </div>
            ) : myPosts.length === 0 ? (
              <EmptyState isDark={isDark} message="You haven't posted anything yet." />
            ) : (
              <>
                {myPosts.map((post) => (
                  <PostRow key={post.id} post={post} isDark={isDark} />
                ))}
                {myPostsCursor && (
                  <LoadMoreButton
                    isDark={isDark}
                    loading={loadingMorePosts}
                    onClick={() => void loadMyPosts(false)}
                  />
                )}
              </>
            )}
          </div>
        )}

        {tab === 'bookmarks' && (
          <div className="space-y-4">
            {loadingBookmarks ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
              </div>
            ) : bookmarks.length === 0 ? (
              <EmptyState isDark={isDark} message="No bookmarked posts yet." />
            ) : (
              <>
                {bookmarks.map((post) => (
                  <PostRow key={post.id} post={post} isDark={isDark} />
                ))}
                {bookmarksCursor && (
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

        {tab === 'notifications' && (
          <div className="space-y-4">
            {unreadCount > 0 && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  className={`text-xs font-medium transition-colors ${
                    isDark ? 'text-violet-400 hover:text-violet-300' : 'text-violet-600 hover:text-violet-500'
                  }`}
                >
                  Mark all as read
                </button>
              </div>
            )}
            {loadingNotifications ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
              </div>
            ) : notifications.length === 0 ? (
              <EmptyState isDark={isDark} message="No notifications yet." />
            ) : (
              <>
                {notifications.map((notif) => (
                  <NotificationRow
                    key={notif.id}
                    notification={notif}
                    isDark={isDark}
                    onMarkRead={handleMarkRead}
                  />
                ))}
                {notifications.length < notificationsTotal && (
                  <LoadMoreButton
                    isDark={isDark}
                    loading={loadingMoreNotifications}
                    onClick={() => void loadNotifications(false)}
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

function PostRow({ post, isDark }: { post: CommunityPost; isDark: boolean }) {
  const TypeIcon = POST_TYPE_ICONS[post.postType] || MessageCircle;
  const tags = post.tags?.filter(Boolean) ?? [];

  return (
    <Link href={`/community/post/${post.id}`}>
      <div
        onMouseMove={handleCardMouseMove}
        style={cardGlowStyle(isDark)}
        className={`group cursor-pointer rounded-xl p-4 ${spring.normal.class} ${pressable} ${glass(isDark, 'subtle')} ${
          isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white'
        }`}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
          <TypeIcon className="h-3.5 w-3.5" />
          {tags.length > 0 &&
            tags.slice(0, 5).map((tag) => (
              <span
                key={tag}
                className={`rounded-full px-2 py-0.5 font-medium ${
                  isDark ? 'bg-white/[0.06] text-zinc-400' : 'bg-zinc-100 text-zinc-500'
                }`}
              >
                #{tag}
              </span>
            ))}
          {tags.length > 5 && (
            <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>+{tags.length - 5}</span>
          )}
          <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>·</span>
          <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{timeAgo(post.createdAt)}</span>
          {post.status === 'solved' && (
            <span className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-100 text-emerald-600'}`}>
              <CheckCircle2 className="h-3 w-3" /> Solved
            </span>
          )}
        </div>
        <h3 className={`mb-2 font-semibold transition-colors group-hover:text-violet-400 ${isDark ? 'text-zinc-100' : 'text-zinc-800'}`}>
          {post.title}
        </h3>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className={`flex items-center gap-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <ThumbsUp className="h-3.5 w-3.5" /> {post.upvotes}
          </span>
          <span className={`flex items-center gap-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <MessageSquare className="h-3.5 w-3.5" /> {post.commentCount}
          </span>
          <span className={`flex items-center gap-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Bookmark className="h-3.5 w-3.5" /> {post.bookmarkCount}
          </span>
          {post.viewCount > 0 && (
            <span className={`flex items-center gap-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              <Eye className="h-3.5 w-3.5" /> {post.viewCount}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function NotificationRow({
  notification,
  isDark,
  onMarkRead,
}: {
  notification: CommunityNotification;
  isDark: boolean;
  onMarkRead: (id: string) => void;
}) {
  const Icon = NOTIFICATION_ICONS[notification.type] || Bell;
  const label = NOTIFICATION_LABELS[notification.type] || 'notification';
  const isUnread = !notification.read;

  const href = notification.commentId
    ? `/community/post/${notification.postId}#comment-${notification.commentId}`
    : `/community/post/${notification.postId}`;

  return (
    <div
      onMouseMove={handleCardMouseMove}
      style={cardGlowStyle(isDark)}
      className={`relative rounded-xl p-4 ${spring.normal.class} ${glass(isDark, 'subtle')} ${
        isUnread
          ? isDark
            ? 'border-l-2 border-l-violet-500/50'
            : 'border-l-2 border-l-violet-500/60'
          : ''
      }`}
    >
      <Link href={href} onClick={() => isUnread && onMarkRead(notification.id)}>
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
              isUnread
                ? isDark
                  ? 'bg-violet-500/10 text-violet-400'
                  : 'bg-violet-100 text-violet-600'
                : isDark
                  ? 'bg-white/5 text-zinc-500'
                  : 'bg-zinc-100 text-zinc-400'
            }`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`text-sm ${isUnread ? (isDark ? 'text-zinc-200' : 'text-zinc-800') : (isDark ? 'text-zinc-400' : 'text-zinc-600')}`}>
              <span className="font-medium">@{notification.actorName}</span>{' '}
              {label}
            </p>
            <p className={`mt-0.5 truncate text-sm ${isDark ? 'text-violet-400/80' : 'text-violet-600'}`}>
              {notification.postTitle}
            </p>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              {timeAgo(notification.createdAt)}
            </p>
          </div>
          {isUnread && (
            <div className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-violet-500" />
          )}
        </div>
      </Link>
    </div>
  );
}

function EmptyState({ isDark, message }: { isDark: boolean; message: string }) {
  return (
    <div className={`rounded-xl py-20 text-center ${glass(isDark, 'subtle')}`}>
      <p className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{message}</p>
      <Link
        href="/community"
        className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-violet-400 hover:text-violet-300"
      >
        Browse Community
      </Link>
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
