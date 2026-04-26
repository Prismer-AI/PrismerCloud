'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, PenSquare, AlertCircle } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import { glass, createBoard, spring, pressable, SPRING_KEYFRAMES } from '../../components/helpers';

export default function NewBoardPage() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const { isAuthenticated } = useApp();
  const isDark = resolvedTheme === 'dark';

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSlugChange = (val: string) => {
    setSlug(val.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30));
  };

  const handleSubmit = async () => {
    if (!slug.trim()) { setError('Slug is required'); return; }
    if (!name.trim()) { setError('Name is required'); return; }
    if (!isAuthenticated) { setError('Please log in to create a board'); return; }

    try {
      setSubmitting(true);
      setError('');
      await createBoard({ slug: slug.trim(), name: name.trim(), description: description.trim() || undefined, icon: icon.trim() || undefined });
      router.push(`/community/boards/${slug.trim()}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create board');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = `w-full rounded-lg px-4 py-3 text-sm outline-none transition-colors ${
    isDark ? 'border border-white/10 bg-white/5 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50' : 'border border-zinc-200 bg-white focus:border-violet-500'
  }`;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <style>{SPRING_KEYFRAMES}</style>
      <div className="mx-auto max-w-2xl px-4 pt-24 pb-12 sm:px-6">
        <Link href="/community/boards" className={`mb-6 inline-flex items-center gap-2 text-sm ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}>
          <ArrowLeft className="h-4 w-4" /> Back to Boards
        </Link>

        <h1 className="mb-8 bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-2xl font-bold text-transparent">
          Create New Board
        </h1>

        <div className={`rounded-2xl p-6 space-y-5 ${glass(isDark, 'elevated')}`}>
          <div>
            <label className={`mb-1.5 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Slug (URL identifier)</label>
            <div className="flex items-center gap-2">
              <span className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>#</span>
              <input type="text" value={slug} onChange={(e) => handleSlugChange(e.target.value)} placeholder="my-board" maxLength={30} className={inputClass} />
            </div>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Lowercase letters, numbers, and hyphens only. Max 30 chars.</p>
          </div>

          <div>
            <label className={`mb-1.5 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Display Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Board" maxLength={50} className={inputClass} />
          </div>

          <div>
            <label className={`mb-1.5 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Description (optional)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this board about?" rows={3} maxLength={500} className={`${inputClass} resize-none`} />
          </div>

          <div>
            <label className={`mb-1.5 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Icon Emoji (optional)</label>
            <input type="text" value={icon} onChange={(e) => setIcon(e.target.value.slice(0, 2))} placeholder="🚀" maxLength={2} className={`${inputClass} w-20 text-center text-lg`} />
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <Link href="/community/boards" className={`rounded-lg px-4 py-2 text-sm font-medium ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'}`}>
              Cancel
            </Link>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !slug.trim() || !name.trim()}
              className={`flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-500/20 hover:from-violet-500 hover:to-cyan-500 disabled:cursor-not-allowed disabled:opacity-50 ${spring.normal.class} ${pressable}`}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenSquare className="h-4 w-4" />}
              Create Board
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
