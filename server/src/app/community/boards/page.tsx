'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Loader2, Users, FileText, Globe, Lock, Unlock } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import {
  type CommunityBoard,
  glass,
  fetchBoards,
  spring,
  pressable,
  SPRING_KEYFRAMES,
} from '../components/helpers';

export default function BoardsListPage() {
  const { resolvedTheme } = useTheme();
  const { isAuthenticated } = useApp();
  const isDark = resolvedTheme === 'dark';

  const [boards, setBoards] = useState<CommunityBoard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBoards()
      .then(setBoards)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const systemBoards = boards.filter((b) => b.isSystem);
  const userBoards = boards.filter((b) => !b.isSystem);

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-[#0A0A0A]' : 'bg-zinc-50'}`}>
        <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <style>{SPRING_KEYFRAMES}</style>
      <div className="mx-auto max-w-4xl px-4 pb-12 pt-24 sm:px-6">
        <Link href="/community" className={`mb-6 inline-flex items-center gap-2 text-sm ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}>
          <ArrowLeft className="h-4 w-4" /> Back to Community
        </Link>

        <div className="flex items-center justify-between mb-8">
          <h1 className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-2xl font-bold text-transparent">
            Boards
          </h1>
          {isAuthenticated && (
            <Link
              href="/community/boards/new"
              className={`flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-violet-500/20 ${spring.normal.class} ${pressable}`}
            >
              <Plus className="h-4 w-4" /> Create Board
            </Link>
          )}
        </div>

        {/* System Boards */}
        <section className="mb-8">
          <h2 className={`mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Lock className="h-3.5 w-3.5" /> System Boards
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {systemBoards.map((b) => (
              <BoardCard key={b.id} board={b} isDark={isDark} />
            ))}
          </div>
        </section>

        {/* User-Created Boards */}
        <section>
          <h2 className={`mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            <Unlock className="h-3.5 w-3.5" /> Community Boards ({userBoards.length})
          </h2>
          {userBoards.length === 0 ? (
            <div className={`rounded-xl py-12 text-center ${glass(isDark, 'subtle')}`}>
              <Globe className={`mx-auto mb-3 h-8 w-8 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} />
              <p className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>No community boards yet. Be the first to create one!</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {userBoards.map((b) => (
                <BoardCard key={b.id} board={b} isDark={isDark} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function BoardCard({ board, isDark }: { board: CommunityBoard; isDark: boolean }) {
  return (
    <Link href={`/community/boards/${board.slug}`}>
      <div className={`rounded-xl p-4 ${spring.normal.class} ${pressable} ${glass(isDark, 'subtle')} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-white'}`}>
        <div className="flex items-start gap-3">
          <span className="text-2xl">{board.icon || '📌'}</span>
          <div className="flex-1 min-w-0">
            <h3 className={`font-semibold truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{board.name}</h3>
            {board.description && (
              <p className={`mt-0.5 text-xs line-clamp-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{board.description}</p>
            )}
            <div className="mt-2 flex items-center gap-3 text-xs">
              <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>
                <FileText className="inline h-3 w-3 mr-0.5" /> {board.postCount} posts
              </span>
              <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>
                <Users className="inline h-3 w-3 mr-0.5" /> {board.subscriberCount} subscribers
              </span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
