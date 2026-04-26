'use client';

import { Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  PenSquare,
  Loader2,
  Hash,
  AlertCircle,
  Trophy,
  Beaker,
  HelpCircle,
  Lightbulb,
  Megaphone,
  X,
  Dna,
  MessageCircle,
  Target,
  BookOpen,
  Globe,
  Eye,
  Edit3,
  Save,
  FileText,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import {
  POST_TYPE_LABELS,
  glass,
  createPost,
  spring,
  pressable,
  SPRING_KEYFRAMES,
  fetchBoards,
  saveDraft,
  fetchDrafts,
  searchTags,
  searchGenes,
  type CommunityBoard,
  type CommunityDraft,
  type TrendingTag,
  type GeneAutocompleteResult,
  showToast,
} from '../components/helpers';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

const BOARD_ICONS: Record<string, typeof Trophy> = {
  showcase: Trophy,
  genelab: Beaker,
  helpdesk: HelpCircle,
  ideas: Lightbulb,
  changelog: Megaphone,
};

const POST_TYPE_ICONS: Record<string, typeof Trophy> = {
  discussion: MessageCircle,
  battleReport: Trophy,
  help: HelpCircle,
  tutorial: BookOpen,
  idea: Lightbulb,
  geneAnalysis: Dna,
  changelog: Megaphone,
  milestone: Target,
};

const BOARD_POST_TYPES: Record<string, string[]> = {
  showcase: ['battleReport', 'milestone', 'discussion'],
  genelab: ['geneAnalysis', 'tutorial', 'discussion'],
  helpdesk: ['help', 'discussion'],
  ideas: ['idea', 'discussion'],
  changelog: ['changelog', 'discussion'],
};

/** Local fallback when API boards not loaded yet (replaces static BOARDS export). */
const FALLBACK_BOARD_SLUGS = ['showcase', 'genelab', 'helpdesk', 'ideas', 'changelog'] as const;
const FALLBACK_BOARD_NAMES: Record<string, string> = {
  showcase: 'Showcase',
  genelab: 'Gene Lab',
  helpdesk: 'Help Desk',
  ideas: 'Ideas',
  changelog: 'Changelog',
};

function fallbackBoards(): CommunityBoard[] {
  return FALLBACK_BOARD_SLUGS.map((slug) => ({
    id: slug,
    slug,
    name: FALLBACK_BOARD_NAMES[slug] ?? slug,
    isSystem: true,
    postCount: 0,
    subscriberCount: 0,
    status: 'active',
  }));
}

function parseTagsFromQuery(raw: string): string[] {
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean);
  return [...new Set(parsed)].slice(0, 5);
}

export default function NewPostPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
        </div>
      }
    >
      <NewPostPageInner />
    </Suspense>
  );
}

function NewPostPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const { isAuthenticated } = useApp();
  const isDark = resolvedTheme === 'dark';

  const [boardSlug, setBoardSlug] = useState('genelab');
  const [postType, setPostType] = useState('discussion');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [linkedGenes, setLinkedGenes] = useState<GeneAutocompleteResult[]>([]);
  const [geneSearchInput, setGeneSearchInput] = useState('');
  const [geneSuggestions, setGeneSuggestions] = useState<GeneAutocompleteResult[]>([]);
  const [geneDropdownOpen, setGeneDropdownOpen] = useState(false);
  const geneDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geneInputRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dynamicBoards, setDynamicBoards] = useState<CommunityBoard[]>([]);
  const [drafts, setDrafts] = useState<CommunityDraft[]>([]);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<TrendingTag[]>([]);
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagInputRef = useRef<HTMLDivElement>(null);
  const tagsFromUrlApplied = useRef(false);

  const availablePostTypes = BOARD_POST_TYPES[boardSlug] || ['discussion'];

  const DRAFT_KEY = 'community-draft';

  // Restore localStorage draft on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (draft.title && !title) setTitle(draft.title);
      if (draft.content && !content) setContent(draft.content);
      if (draft.tags?.length && tags.length === 0) setTags(draft.tags);
      if (draft.postType) setPostType(draft.postType);
      if (draft.boardSlug) setBoardSlug(draft.boardSlug);
      if (draft.linkedGeneIds?.length && linkedGenes.length === 0) {
        setLinkedGenes(draft.linkedGenes);
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save to localStorage on input change (debounced 2s)
  const localDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!title.trim() && !content.trim()) return;
    if (localDraftTimer.current) clearTimeout(localDraftTimer.current);
    localDraftTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          title, content, tags, postType, boardSlug,
          linkedGenes: linkedGenes.length > 0 ? linkedGenes : undefined,
        }));
      } catch {}
    }, 2000);
    return () => { if (localDraftTimer.current) clearTimeout(localDraftTimer.current); };
  }, [title, content, tags, postType, boardSlug, linkedGenes]);

  useEffect(() => {
    if (tagsFromUrlApplied.current) return;
    tagsFromUrlApplied.current = true;
    const raw = searchParams.get('tags');
    if (!raw?.trim()) return;
    const fromUrl = parseTagsFromQuery(raw);
    if (fromUrl.length > 0) setTags(fromUrl);
  }, [searchParams]);

  useEffect(() => {
    fetchBoards().then(setDynamicBoards).catch(() => {});
    if (isAuthenticated) {
      fetchDrafts().then(setDrafts).catch(() => {
        showToast('Failed to load drafts', 'error');
      });
    }
  }, [isAuthenticated]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tagInputRef.current && !tagInputRef.current.contains(e.target as Node)) setTagDropdownOpen(false);
      if (geneInputRef.current && !geneInputRef.current.contains(e.target as Node)) setGeneDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Auto-save draft every 30s
  useEffect(() => {
    if (!isAuthenticated || (!title.trim() && !content.trim())) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      try {
        const meta = { tags, postType, linkedGeneIds: linkedGenes.map((g) => g.id) };
        const draft = await saveDraft({
          draftId: currentDraftId ?? undefined,
          boardSlug,
          title: title.trim(),
          content: content.trim(),
          contentJson: JSON.stringify(meta),
        });
        setCurrentDraftId(draft.id);
        setDraftSaved(true);
        setTimeout(() => setDraftSaved(false), 2000);
      } catch {
        showToast('Failed to auto-save draft', 'error');
      }
    }, 30000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [title, content, boardSlug, tags, postType, linkedGenes, isAuthenticated, currentDraftId]);

  const loadDraft = (draft: CommunityDraft) => {
    if (draft.title) setTitle(draft.title);
    if (draft.content) setContent(draft.content);
    if (draft.boardSlug) setBoardSlug(draft.boardSlug);
    if (draft.contentJson) {
      try {
        const meta = JSON.parse(draft.contentJson);
        if (Array.isArray(meta.tags)) setTags(meta.tags);
        if (meta.postType) setPostType(meta.postType);
      } catch {}
    }
    setCurrentDraftId(draft.id);
  };

  const handleManualSave = async () => {
    if (!isAuthenticated) return;
    try {
      const meta = { tags, postType, linkedGeneIds: linkedGenes.map((g) => g.id) };
      const draft = await saveDraft({
        draftId: currentDraftId ?? undefined,
        boardSlug,
        title: title.trim(),
        content: content.trim(),
        contentJson: JSON.stringify(meta),
      });
      setCurrentDraftId(draft.id);
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 2000);
    } catch {
      showToast('Failed to save draft', 'error');
    }
  };

  const addTag = useCallback((tagName?: string) => {
    const raw = tagName ?? tagInput;
    const tag = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (tag && !tags.includes(tag) && tags.length < 5) {
      setTags((prev) => [...prev, tag]);
      setTagInput('');
      setTagSuggestions([]);
      setTagDropdownOpen(false);
    }
  }, [tagInput, tags]);

  const handleTagInputChange = (val: string) => {
    setTagInput(val);
    if (tagDebounce.current) clearTimeout(tagDebounce.current);
    if (!val.trim()) { setTagSuggestions([]); setTagDropdownOpen(false); return; }
    tagDebounce.current = setTimeout(() => {
      searchTags(val.trim(), 5).then((results) => {
        setTagSuggestions(results);
        setTagDropdownOpen(true);
      }).catch(() => {});
    }, 150);
  };

  const removeTag = (tag: string) => setTags((prev) => prev.filter((t) => t !== tag));

  const handleGeneSearchChange = (val: string) => {
    setGeneSearchInput(val);
    if (geneDebounce.current) clearTimeout(geneDebounce.current);
    if (!val.trim()) { setGeneSuggestions([]); setGeneDropdownOpen(false); return; }
    geneDebounce.current = setTimeout(() => {
      searchGenes(val.trim(), 8).then((results) => {
        const selectedIds = new Set(linkedGenes.map((g) => g.id));
        setGeneSuggestions(results.filter((r) => !selectedIds.has(r.id)));
        setGeneDropdownOpen(true);
      }).catch(() => {});
    }, 200);
  };

  const addGene = (gene: GeneAutocompleteResult) => {
    if (linkedGenes.some((g) => g.id === gene.id)) return;
    setLinkedGenes((prev) => [...prev, gene]);
    setGeneSearchInput('');
    setGeneSuggestions([]);
    setGeneDropdownOpen(false);
  };

  const removeGene = (geneId: string) => setLinkedGenes((prev) => prev.filter((g) => g.id !== geneId));

  const handleSubmit = async () => {
    if (!isAuthenticated) { router.push('/auth?redirect=/community/new'); return; }
    if (!title.trim()) { setError('Title is required'); return; }
    if (!content.trim()) { setError('Content is required'); return; }

    try {
      setSubmitting(true);
      setError('');
      const geneIds = linkedGenes.map((g) => g.id);
      const post = await createPost({
        boardSlug,
        postType,
        title: title.trim(),
        content: content.trim(),
        tags: tags.length > 0 ? tags : undefined,
        linkedGeneIds: geneIds.length > 0 ? geneIds : undefined,
      });
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      router.push(`/community/post/${post.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create post');
    } finally {
      setSubmitting(false);
    }
  };

  const boardChoices = dynamicBoards.length > 0 ? dynamicBoards : fallbackBoards();

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <style>{SPRING_KEYFRAMES}</style>
      <div className="mx-auto max-w-4xl px-4 pt-24 pb-12 sm:px-6 lg:px-8">
        <Link
          href="/community"
          className={`mb-6 flex items-center gap-2 text-sm transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'}`}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Community
        </Link>

        <div className="flex items-center justify-between mb-8">
          <h1 className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-2xl font-bold text-transparent">
            Create New Post
          </h1>
          <div className="flex items-center gap-2">
            {draftSaved && (
              <span className="flex items-center gap-1 text-xs text-emerald-400 animate-[float-up_0.3s_ease]">
                <Save className="h-3 w-3" /> Saved
              </span>
            )}
            {isAuthenticated && (
              <button
                type="button"
                onClick={handleManualSave}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${spring.normal.class} ${
                  isDark ? 'bg-white/5 text-zinc-400 hover:text-zinc-200' : 'bg-zinc-100 text-zinc-500 hover:text-zinc-700'
                }`}
              >
                <Save className="h-3.5 w-3.5" />
                Save draft
              </button>
            )}
          </div>
        </div>

        {/* Auth banner */}
        {!isAuthenticated && (
          <div className={`mb-6 flex items-center gap-3 rounded-xl px-4 py-3 ${glass(isDark, 'elevated')}`}>
            <AlertCircle className="h-5 w-5 shrink-0 text-amber-400" />
            <p className={`text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
              You need to{' '}
              <Link href="/auth?redirect=/community/new" className="font-medium text-violet-400 hover:text-violet-300 underline underline-offset-2">
                log in
              </Link>{' '}
              to publish a post.
            </p>
          </div>
        )}

        {/* Existing drafts */}
        {drafts.length > 0 && (
          <div className={`mb-6 rounded-xl p-3 ${glass(isDark, 'subtle')}`}>
            <p className={`mb-2 text-xs font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
              <FileText className="inline h-3.5 w-3.5 mr-1" />
              Drafts ({drafts.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {drafts.slice(0, 5).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => loadDraft(d)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium truncate max-w-[200px] ${spring.normal.class} ${pressable} ${
                    currentDraftId === d.id
                      ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-400/30' : 'bg-violet-100 text-violet-600'
                      : isDark ? 'bg-white/5 text-zinc-400 hover:text-zinc-200' : 'bg-white text-zinc-500 hover:text-zinc-700 border border-zinc-200'
                  }`}
                >
                  {d.title || 'Untitled draft'}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-6">
          {/* Board Selection */}
          <div>
            <label className={`mb-2 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Board</label>
            <div className="flex flex-wrap gap-2">
              {boardChoices.map((b) => {
                const slug = 'slug' in b ? b.slug : (b as { id: string }).id;
                const label = 'name' in b ? b.name : (b as { label: string }).label;
                const Icon = BOARD_ICONS[slug] || Globe;
                const isActive = boardSlug === slug;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => {
                      setBoardSlug(slug);
                      const types = BOARD_POST_TYPES[slug] || ['discussion'];
                      if (!types.includes(postType)) setPostType(types[0]);
                    }}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${spring.normal.class} ${pressable} ${
                      isActive
                        ? 'bg-gradient-to-r from-violet-600 to-cyan-600 text-white shadow-lg shadow-violet-500/20'
                        : isDark ? `${glass(isDark, 'subtle')} text-zinc-400 hover:text-zinc-200` : 'border border-zinc-200 bg-white text-zinc-600 hover:border-violet-300'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Post Type */}
          <div>
            <label className={`mb-2 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Post Type</label>
            <div className="flex flex-wrap gap-2">
              {availablePostTypes.map((pt) => {
                const info = POST_TYPE_LABELS[pt] || POST_TYPE_LABELS.discussion;
                const PtIcon = POST_TYPE_ICONS[pt] || MessageCircle;
                const isActive = postType === pt;
                return (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => setPostType(pt)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${spring.normal.class} ${pressable} ${
                      isActive
                        ? isDark ? 'bg-white/10 text-white border border-white/20' : 'bg-violet-100 text-violet-700 border border-violet-200'
                        : isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5' : 'text-zinc-500 hover:text-zinc-700 border border-zinc-200 bg-white'
                    }`}
                  >
                    <PtIcon className="h-3.5 w-3.5" />
                    {info.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className={`mb-2 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's your post about?"
              maxLength={200}
              className={`w-full rounded-lg px-4 py-3 text-base outline-none transition-colors ${
                isDark ? 'border border-white/10 bg-white/5 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50' : 'border border-zinc-200 bg-white focus:border-violet-500'
              }`}
            />
            <p className={`mt-1 text-right text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{title.length}/200</p>
          </div>

          {/* WYSIWYG Markdown Editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Content</label>
              <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                <Edit3 className="h-3 w-3" />
                Markdown · <Eye className="h-3 w-3 ml-1" /> Live Preview
              </span>
            </div>
            <div data-color-mode={isDark ? 'dark' : 'light'} className="rounded-lg overflow-hidden">
              <MDEditor
                value={content}
                onChange={(val) => setContent(val || '')}
                height={400}
                preview="live"
                visibleDragbar={false}
                textareaProps={{
                  placeholder: 'Write your post using Markdown...\n\nTip: Use [[gene:name]] to reference a Gene, [[skill:name]] for a Skill.',
                }}
              />
            </div>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              Supports Markdown, [[gene:name]] / [[skill:name]] references, and live preview
            </p>
          </div>

          {/* Tags with autocomplete */}
          <div>
            <label className={`mb-2 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Tags (up to 5)</label>
            <div className="mb-2 flex flex-wrap gap-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className={`flex items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-medium ${spring.micro.class} ${isDark ? 'bg-white/[0.06] text-zinc-300 border border-white/[0.06]' : 'bg-zinc-100 text-zinc-600 border border-zinc-200/40'}`}
                >
                  #{tag}
                  <button type="button" onClick={() => removeTag(tag)} className={`ml-0.5 ${spring.micro.class} hover:text-red-400`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            {tags.length < 5 && (
              <div className="relative" ref={tagInputRef}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => handleTagInputChange(e.target.value)}
                    onFocus={() => { if (tagInput.trim() && tagSuggestions.length > 0) setTagDropdownOpen(true); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                    placeholder="Type to search or create a tag..."
                    className={`flex-1 rounded-xl px-3 py-2 text-sm outline-none ${spring.normal.class} ${
                      isDark ? 'border border-white/[0.08] bg-white/[0.04] text-zinc-200 placeholder:text-zinc-600 focus:border-white/[0.15] backdrop-blur-xl' : 'border border-zinc-200/50 bg-white/60 backdrop-blur-xl focus:border-zinc-300'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => addTag()}
                    className={`rounded-xl px-3 py-2 text-sm ${spring.micro.class} ${pressable} ${isDark ? 'bg-white/[0.06] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.10]' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}
                  >
                    <Hash className="h-4 w-4" />
                  </button>
                </div>
                {/* Tag autocomplete dropdown */}
                {tagDropdownOpen && tagInput.trim() && (
                  <div className={`absolute left-0 right-12 top-full z-50 mt-2 rounded-2xl py-1.5 ${glass(isDark, 'elevated')}`}>
                    {tagSuggestions.length > 0 && tagSuggestions.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        onClick={() => addTag(s.name)}
                        className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-sm ${spring.micro.class} ${
                          isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-700 hover:bg-zinc-50/80'
                        }`}
                        style={{ width: 'calc(100% - 12px)' }}
                      >
                        <Hash className="h-3.5 w-3.5 text-zinc-500" />
                        <span className="font-medium">{s.name}</span>
                        <span className={`ml-auto text-xs tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{s.postCount}</span>
                      </button>
                    ))}
                    {/* Always show "create new tag" option if input doesn't match any existing tag exactly */}
                    {(() => {
                      const normalized = tagInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
                      const exactMatch = tagSuggestions.some((s) => s.name === normalized);
                      if (normalized && !exactMatch && !tags.includes(normalized)) {
                        return (
                          <>
                            {tagSuggestions.length > 0 && <div className={`my-1 mx-3 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200/40'}`} />}
                            <button
                              type="button"
                              onClick={() => addTag(normalized)}
                              className={`flex w-full items-center gap-2 rounded-xl mx-1.5 px-3 py-2 text-sm ${spring.micro.class} ${
                                isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-zinc-50/80'
                              }`}
                              style={{ width: 'calc(100% - 12px)' }}
                            >
                              <span className={`text-xs font-medium ${isDark ? 'text-emerald-400/80' : 'text-emerald-600'}`}>+ Create</span>
                              <span className="font-medium">#{normalized}</span>
                            </button>
                          </>
                        );
                      }
                      return null;
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Linked Genes with autocomplete */}
          <div>
            <label className={`mb-2 block text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
              <Dna className="inline h-4 w-4 mr-1 -mt-0.5" />
              Linked Genes (optional)
            </label>
            {linkedGenes.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {linkedGenes.map((gene) => (
                  <span
                    key={gene.id}
                    className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium ${spring.micro.class} ${isDark ? 'bg-violet-500/10 text-violet-300 border border-violet-400/20' : 'bg-violet-50 text-violet-600 border border-violet-200/50'}`}
                  >
                    <Dna className="h-3 w-3" />
                    {gene.title}
                    <span className={`${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>({gene.id.slice(0, 8)})</span>
                    <button type="button" onClick={() => removeGene(gene.id)} className={`ml-0.5 ${spring.micro.class} hover:text-red-400`}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative" ref={geneInputRef}>
              <input
                type="text"
                value={geneSearchInput}
                onChange={(e) => handleGeneSearchChange(e.target.value)}
                onFocus={() => { if (geneSearchInput.trim() && geneSuggestions.length > 0) setGeneDropdownOpen(true); }}
                placeholder="Search genes by name..."
                className={`w-full rounded-xl px-3 py-2 text-sm outline-none ${spring.normal.class} ${
                  isDark ? 'border border-white/[0.08] bg-white/[0.04] text-zinc-200 placeholder:text-zinc-600 focus:border-white/[0.15] backdrop-blur-xl' : 'border border-zinc-200/50 bg-white/60 backdrop-blur-xl focus:border-zinc-300'
                }`}
              />
              {geneDropdownOpen && geneSearchInput.trim() && (
                <div className={`absolute left-0 right-0 top-full z-50 mt-2 max-h-60 overflow-y-auto rounded-2xl py-1.5 ${glass(isDark, 'elevated')}`}>
                  {geneSuggestions.length > 0 ? geneSuggestions.map((gene) => (
                    <button
                      key={gene.id}
                      type="button"
                      onClick={() => addGene(gene)}
                      className={`flex w-full items-center gap-3 rounded-xl mx-1.5 px-3 py-2.5 text-sm ${spring.micro.class} ${
                        isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-700 hover:bg-zinc-50/80'
                      }`}
                      style={{ width: 'calc(100% - 12px)' }}
                    >
                      <Dna className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                      <div className="flex-1 text-left min-w-0">
                        <span className="font-medium truncate block">{gene.title}</span>
                        <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{gene.id}</span>
                      </div>
                      {gene.successRate !== undefined && (
                        <span className="text-xs text-emerald-400 shrink-0">{Math.round(gene.successRate * 100)}%</span>
                      )}
                    </button>
                  )) : (
                    <p className={`px-4 py-3 text-xs text-center ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      No genes found for &quot;{geneSearchInput}&quot;
                    </p>
                  )}
                </div>
              )}
            </div>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>Search and select genes to link to this post</p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-4">
            <Link
              href="/community"
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !title.trim() || !content.trim()}
              className={`flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-500/20 hover:from-violet-500 hover:to-cyan-500 disabled:cursor-not-allowed disabled:opacity-50 ${spring.normal.class} ${pressable}`}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenSquare className="h-4 w-4" />}
              Publish Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
