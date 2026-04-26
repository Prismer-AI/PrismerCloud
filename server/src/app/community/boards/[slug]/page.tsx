'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Users, FileText, Bell, BellOff, Globe, Shield } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import {
  type CommunityBoard,
  type CommunityPost,
  glass,
  fetchBoard,
  fetchPosts,
  subscribeBoard,
  timeAgo,
  spring,
  pressable,
  SPRING_KEYFRAMES,
} from '../../components/helpers';

export default function BoardDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { resolvedTheme } = useTheme();
  const { isAuthenticated } = useApp();
  const isDark = resolvedTheme === 'dark';

  const [board, setBoard] = useState<CommunityBoard | null>(null);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    Promise.all([fetchBoard(slug), fetchPosts({ boardSlug: slug, limit: 30 })])
      .then(([b, postData]) => {
        setBoard(b);
        setPosts(postData.posts);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [slug]);

  const handleSubscribe = async () => {
    try {
      const result = await subscribeBoard(slug);
      setSubscribed(result.subscribed);
      if (board) {
        setBoard({ ...board, subscriberCount: board.subscriberCount + (result.subscribed ? 1 : -1) });
      }
    } catch (e) {
      console.error('Subscribe failed:', e);
    }
  };

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-[#0A0A0A]' : 'bg-zinc-50'}`}>
        <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
      </div>
    );
  }

  if (!board) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center gap-4 ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
        <Globe className="h-16 w-16 text-zinc-600" />
        <p className="text-lg">Board not found</p>
        <Link href="/community/boards" className="text-violet-400 hover:underline">Back to boards</Link>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <style>{SPRING_KEYFRAMES}</style>
      <div className="mx-auto max-w-4xl px-4 pb-12 pt-24 sm:px-6">
        <Link href="/community/boards" className={`mb-6 inline-flex items-center gap-2 text-sm ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}>
          <ArrowLeft className="h-4 w-4" /> All Boards
        </Link>

        {/* Board Header */}
        <div className={`rounded-2xl p-6 mb-6 ${glass(isDark, 'elevated')}`}>
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <span className="text-4xl">{board.icon || '📌'}</span>
              <div>
                <h1 className="text-2xl font-bold">{board.name}</h1>
                <p className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>#{board.slug}</p>
                {board.description && (
                  <p className={`mt-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{board.description}</p>
                )}
                <div className="mt-3 flex items-center gap-4 text-sm">
                  <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                    <FileText className="inline h-3.5 w-3.5 mr-1" /> {board.postCount} posts
                  </span>
                  <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                    <Users className="inline h-3.5 w-3.5 mr-1" /> {board.subscriberCount} subscribers
                  </span>
                  {board.isSystem && (
                    <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                      <Shield className="h-3 w-3" /> System
                    </span>
                  )}
                </div>
              </div>
            </div>

            {isAuthenticated && (
              <button
                type="button"
                onClick={handleSubscribe}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${spring.normal.class} ${pressable} ${
                  subscribed
                    ? isDark ? 'border border-white/10 bg-white/5 text-zinc-300' : 'border border-zinc-200 bg-white text-zinc-600'
                    : 'bg-gradient-to-r from-violet-600 to-cyan-600 text-white shadow-lg shadow-violet-500/20'
                }`}
              >
                {subscribed ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                {subscribed ? 'Unsubscribe' : 'Subscribe'}
              </button>
            )}
          </div>
        </div>

        {/* Posts */}
        <div className="space-y-3">
          {posts.length === 0 ? (
            <div className={`rounded-xl py-12 text-center ${glass(isDark, 'subtle')}`}>
              <p className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>No posts in this board yet</p>
              <Link href={`/community/new?board=${slug}`} className="mt-2 inline-block text-sm text-violet-400 hover:underline">
                Be the first to post
              </Link>
            </div>
          ) : (
            posts.map((post) => (
              <Link key={post.id} href={`/community/post/${post.id}`}>
                <div className={`rounded-xl p-4 ${spring.normal.class} ${glass(isDark, 'subtle')} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white'}`}>
                  <h4 className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{post.title}</h4>
                  <div className="mt-1 flex items-center gap-3 text-xs">
                    <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
                      @{post.author?.name || 'unknown'}
                    </span>
                    <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{timeAgo(post.createdAt)}</span>
                    <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>↑{post.upvotes}</span>
                    <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{post.commentCount} comments</span>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
