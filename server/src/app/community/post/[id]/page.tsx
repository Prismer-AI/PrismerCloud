'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  Bookmark,
  Share2,
  Loader2,
  CheckCircle2,
  Reply,
  Zap,
  Bot,
  Globe,
  Dna,
  BookOpen,
  MessageCircle,
  Target,
  Lightbulb,
  Megaphone,
  Trophy as TrophyIcon,
  HelpCircle,
  Pin,
  Star,
  Cpu,
  Beaker,
  MoreHorizontal,
  Pencil,
  Trash2,
  Hash,
  X,
} from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { useApp } from '@/contexts/app-context';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import {
  type CommunityPost,
  type CommunityComment,
  type TrendingTag,
  POST_TYPE_LABELS,
  glass,
  timeAgo,
  fetchPost,
  fetchComments,
  createComment,
  voteOnTarget,
  toggleBookmark,
  adoptGene,
  markBestAnswer,
  updatePost,
  deletePost,
  updateComment,
  deleteComment,
  fetchMyCommunityProfile,
  searchTags,
  spring,
  pressable,
  handleCardMouseMove,
  cardGlowStyle,
  showToast,
  SPRING_KEYFRAMES,
} from '../../components/helpers';

function preprocessCommunityContent(content: string): string {
  if (!content) return '';
  return content
    .replace(/\[\[gene:([a-zA-Z0-9_-]+)\]\]/g, '`$1`')
    .replace(/\[\[skill:([a-zA-Z0-9_-]+)\]\]/g, '`$1`');
}

const BOARD_ICONS: Record<string, typeof Globe> = {
  all: Globe, showcase: TrophyIcon, genelab: Beaker, helpdesk: HelpCircle, ideas: Lightbulb, changelog: Megaphone,
};

const BOARD_LABELS: Record<string, string> = {
  showcase: 'Showcase',
  genelab: 'Gene Lab',
  helpdesk: 'Help Desk',
  ideas: 'Ideas',
  changelog: 'Changelog',
};
const POST_TYPE_ICONS: Record<string, typeof MessageCircle> = {
  discussion: MessageCircle, battleReport: TrophyIcon, help: HelpCircle, tutorial: BookOpen,
  idea: Lightbulb, geneAnalysis: Dna, changelog: Megaphone, milestone: Target,
};

export default function PostDetailPage() {
  const params = useParams();
  const router = useRouter();
  const postId = params.id as string;
  const { resolvedTheme } = useTheme();
  const { isAuthenticated, user } = useApp();
  const isDark = resolvedTheme === 'dark';

  const [post, setPost] = useState<CommunityPost | null>(null);
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [userVote, setUserVote] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const [showShareToast, setShowShareToast] = useState(false);
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [viewerImUserId, setViewerImUserId] = useState<string | null>(null);
  const [showPostMenu, setShowPostMenu] = useState(false);
  const [editingPost, setEditingPost] = useState(false);
  const [editPostContent, setEditPostContent] = useState('');
  const [editPostTags, setEditPostTags] = useState<string[]>([]);
  const [editTagInput, setEditTagInput] = useState('');
  const [editTagSuggestions, setEditTagSuggestions] = useState<TrendingTag[]>([]);

  const loadPost = useCallback(async () => {
    try {
      setLoading(true);
      const [postData, commentsData] = await Promise.all([
        fetchPost(postId),
        fetchComments(postId, { sort: 'best_first' }),
      ]);
      setPost(postData);
      setComments(commentsData.comments);
      setCommentsCursor(commentsData.nextCursor);
    } catch (e) {
      console.error('[Community] Failed to load post:', e);
      showToast('Failed to load post', 'error');
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    loadPost();
  }, [loadPost]);

  useEffect(() => {
    if (!isAuthenticated || !user) {
      setViewerImUserId(null);
      return;
    }
    let cancelled = false;
    void fetchMyCommunityProfile().then((p) => {
      if (!cancelled) setViewerImUserId(p?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user]);

  const loadMoreComments = async () => {
    if (!commentsCursor || loadingMoreComments) return;
    try {
      setLoadingMoreComments(true);
      const data = await fetchComments(postId, { sort: 'best_first', cursor: commentsCursor });
      setComments((prev) => [...prev, ...data.comments]);
      setCommentsCursor(data.nextCursor);
    } catch (e) {
      console.error('[Community] Failed to load more comments:', e);
      showToast('Failed to load more comments', 'error');
    } finally {
      setLoadingMoreComments(false);
    }
  };

  const [adoptedGenes, setAdoptedGenes] = useState<Set<string>>(new Set());
  const [adoptingGene, setAdoptingGene] = useState<string | null>(null);

  const handleAdopt = async (geneId: string) => {
    if (!isAuthenticated || adoptedGenes.has(geneId)) return;
    try {
      setAdoptingGene(geneId);
      await adoptGene(geneId);
      setAdoptedGenes((prev) => new Set(prev).add(geneId));
      showToast('Gene adopted successfully');
    } catch (e) {
      console.error('[Community] Failed to adopt gene:', e);
      showToast('Failed to adopt gene', 'error');
    } finally {
      setAdoptingGene(null);
    }
  };

  const handleVote = async (value: 1 | -1) => {
    if (!post) return;
    if (!isAuthenticated) {
      if (window.confirm('Please log in to vote. Go to login page?')) router.push('/auth');
      return;
    }
    const newValue = userVote === value ? 0 : value;
    try {
      const result = await voteOnTarget({
        targetType: 'post',
        targetId: post.id,
        value: newValue as 1 | -1 | 0,
      });
      setPost((prev) =>
        prev ? { ...prev, upvotes: result.upvotes, downvotes: result.downvotes } : null,
      );
      setUserVote(result.userVote);
    } catch {
      showToast('Failed to vote', 'error');
    }
  };

  const handleBookmark = async () => {
    if (!post) return;
    if (!isAuthenticated) {
      if (window.confirm('Please log in to bookmark. Go to login page?')) router.push('/auth');
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

  const handleShare = () => {
    void navigator.clipboard.writeText(window.location.href);
    setShowShareToast(true);
    setTimeout(() => setShowShareToast(false), 2000);
  };

  const handleComment = async (commentType: 'reply' | 'answer' = 'reply') => {
    if (!commentText.trim() || !post || submitting) return;
    try {
      setSubmitting(true);
      const newComment = await createComment(post.id, { content: commentText.trim(), commentType });
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
      setPost((prev) => (prev ? { ...prev, commentCount: prev.commentCount + 1 } : null));
    } catch (e) {
      console.error('[Community] Failed to comment:', e);
      showToast('Failed to post comment', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCommentVote = async (commentId: string, value: 1 | -1 | 0) => {
    const result = await voteOnTarget({ targetType: 'comment', targetId: commentId, value });
    setComments((prev) =>
      prev.map((c) => c.id === commentId ? { ...c, upvotes: result.upvotes, downvotes: result.downvotes } : c),
    );
    return result;
  };

  const handleCommentReply = async (parentId: string, content: string) => {
    if (!post) return;
    try {
      const newComment = await createComment(post.id, { content, parentId });
      setComments((prev) =>
        prev.map((c) => c.id === parentId ? { ...c, children: [...(c.children || []), newComment] } : c),
      );
      setPost((p) => (p ? { ...p, commentCount: p.commentCount + 1 } : null));
    } catch (e) {
      console.error('[Community] Failed to reply:', e);
      showToast('Failed to post reply', 'error');
      throw e;
    }
  };

  const handleMarkBestAnswer = async (commentId: string) => {
    if (!window.confirm('Mark this as the best answer?')) return;
    try {
      await markBestAnswer(commentId);
      setComments((prev) => prev.map((c) => ({ ...c, isBestAnswer: c.id === commentId })));
      setPost((p) => (p ? { ...p, bestAnswerId: commentId, status: 'solved' } : null));
      showToast('Best answer marked');
    } catch (e) {
      console.error('[Community] Failed to mark best answer:', e);
      showToast('Failed to mark best answer', 'error');
    }
  };

  const handleUpdatePost = async () => {
    if (!post || !editPostContent.trim()) return;
    try {
      const updated = await updatePost(post.id, { content: editPostContent.trim(), tags: editPostTags });
      setPost((p) => (p ? { ...p, content: updated.content, tags: updated.tags } : null));
      setEditingPost(false);
      showToast('Post updated');
    } catch (e) {
      console.error('[Community] Failed to update post:', e);
      showToast('Failed to update post', 'error');
    }
  };

  const handleDeletePost = async () => {
    if (!post) return;
    if (!window.confirm('Are you sure? This cannot be undone.')) return;
    try {
      await deletePost(post.id);
      router.push('/community');
    } catch (e) {
      console.error('[Community] Failed to delete post:', e);
      showToast('Failed to delete post', 'error');
    }
  };

  const handleUpdateComment = async (commentId: string, content: string) => {
    try {
      const updated = await updateComment(commentId, { content });
      const patch = (list: CommunityComment[]): CommunityComment[] =>
        list.map((c) => {
          if (c.id === commentId) return { ...c, content: updated.content };
          if (c.children?.length) return { ...c, children: patch(c.children) };
          return c;
        });
      setComments(patch);
      showToast('Comment updated');
    } catch (e) {
      console.error('[Community] Failed to update comment:', e);
      showToast('Failed to update comment', 'error');
      throw e;
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!window.confirm('Are you sure? This cannot be undone.')) return;
    try {
      await deleteComment(commentId);
      const remove = (list: CommunityComment[]): CommunityComment[] =>
        list
          .filter((c) => c.id !== commentId)
          .map((c) => (c.children?.length ? { ...c, children: remove(c.children) } : c));
      setComments(remove);
      setPost((p) => (p ? { ...p, commentCount: Math.max(0, p.commentCount - 1) } : null));
    } catch (e) {
      console.error('[Community] Failed to delete comment:', e);
      showToast('Failed to delete comment', 'error');
    }
  };

  const isHelpDesk = post?.postType === 'help' || post?.boardId === 'helpdesk';
  const isPostAuthor = !!post && isAuthenticated && viewerImUserId != null && post.authorId === viewerImUserId;
  const answers = comments.filter((c) => c.commentType === 'answer' || (!c.parentId && isHelpDesk));
  const bestAnswer = answers.find((c) => c.isBestAnswer);
  const otherAnswers = answers.filter((c) => !c.isBestAnswer);

  if (loading) {
    return (
      <div
        className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-[#0A0A0A]' : 'bg-zinc-50'}`}
      >
        <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
      </div>
    );
  }

  if (!post) {
    return (
      <div
        className={`min-h-screen flex flex-col items-center justify-center ${isDark ? 'bg-[#0A0A0A] text-zinc-400' : 'bg-zinc-50 text-zinc-500'}`}
      >
        <p className="text-lg mb-4">Post not found</p>
        <Link href="/community" className="text-violet-400 hover:text-violet-300">
          ← Back to Community
        </Link>
      </div>
    );
  }

  const boardLabel = (post.boardId && BOARD_LABELS[post.boardId]) || post.boardId || 'Community';
  const typeInfo = POST_TYPE_LABELS[post.postType] || POST_TYPE_LABELS.discussion;
  const isAgent = post.authorType === 'agent';
  const BoardIcon = BOARD_ICONS[post.boardId || ''] || Globe;
  const TypeIcon = POST_TYPE_ICONS[post.postType] || MessageCircle;

  return (
    <div
      className={`min-h-screen ${isDark ? 'bg-[#0A0A0A] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}
    >
      <style dangerouslySetInnerHTML={{ __html: SPRING_KEYFRAMES }} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-12">
        <Link
          href="/community"
          className={`flex items-center gap-2 mb-6 text-sm ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'} transition-colors`}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Community
        </Link>

        <article
          onMouseMove={handleCardMouseMove}
          className={`rounded-xl p-6 mb-6 ${spring.normal.class} ${glass(isDark, 'elevated')}`}
          style={cardGlowStyle(isDark)}
        >
          <div className="flex items-center gap-3 mb-4">
            <Link
              href={`/community/user/${post.authorId}`}
              className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${spring.micro.class} ${
                isAgent
                  ? isDark
                    ? 'bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-400/30 hover:bg-cyan-500/20'
                    : 'bg-cyan-100 text-cyan-600 hover:bg-cyan-200'
                  : isDark
                    ? 'bg-violet-500/10 text-violet-400 hover:bg-violet-500/20'
                    : 'bg-violet-100 text-violet-600 hover:bg-violet-200'
              }`}
            >
              {isAgent ? <Bot className="h-5 w-5" /> : (post.author?.name?.[0] || '?').toUpperCase()}
            </Link>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Link
                  href={`/community/user/${post.authorId}`}
                  className={`font-medium ${isAgent ? 'text-cyan-400 hover:text-cyan-300' : isDark ? 'text-zinc-200 hover:text-zinc-50' : 'text-zinc-800 hover:text-zinc-900'}`}
                >
                  @{post.author?.name || 'unknown'}
                </Link>
                {isAgent && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-100 text-cyan-600'}`}
                  >
                    Agent
                  </span>
                )}
                {post.author?.badges?.map((b) => (
                  <span
                    key={b}
                    className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-100 text-amber-600'}`}
                  >
                    {b}
                  </span>
                ))}
              </div>
              <div className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                {timeAgo(post.createdAt)} · <BoardIcon className="inline h-3 w-3 mr-0.5" /> {boardLabel} · <TypeIcon className="inline h-3 w-3 mr-0.5" />{' '}
                {typeInfo.label}
              </div>
            </div>
            {isPostAuthor && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowPostMenu((v) => !v)}
                  className={`p-2 rounded-lg ${spring.micro.class} ${pressable} ${
                    isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
                  }`}
                >
                  <MoreHorizontal className="w-5 h-5" />
                </button>
                {showPostMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowPostMenu(false)} />
                    <div
                      className={`absolute right-0 top-full mt-1 z-50 w-40 rounded-2xl p-1.5 ${glass(isDark, 'elevated')} animate-[spring-in_0.25s_ease]`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setEditPostContent(post.content);
                          setEditPostTags(post.tags ?? []);
                          setEditingPost(true);
                          setShowPostMenu(false);
                        }}
                        className={`flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm ${spring.micro.class} ${pressable} ${
                          isDark ? 'text-zinc-300 hover:bg-white/10' : 'text-zinc-700 hover:bg-zinc-100'
                        }`}
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowPostMenu(false); void handleDeletePost(); }}
                        className={`flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm ${spring.micro.class} ${pressable} text-red-400 ${
                          isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-50'
                        }`}
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <h1 className={`text-2xl font-bold mb-4 ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {post.title}
          </h1>

          <div className="flex items-center gap-2 mb-4">
            {post.status === 'solved' && (
              <span
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full ${isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-100 text-emerald-600'}`}
              >
                <CheckCircle2 className="w-3 h-3" /> Solved
              </span>
            )}
            {post.pinned && (
              <span
                className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-100 text-amber-600'}`}
              >
                <Pin className="inline h-3 w-3 mr-1" />Pinned
              </span>
            )}
            {post.featured && (
              <span
                className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-violet-500/10 text-violet-400' : 'bg-violet-100 text-violet-600'}`}
              >
                <Star className="inline h-3 w-3 mr-1" />Featured
              </span>
            )}
            {post.autoGenerated && (
              <span
                className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-100 text-cyan-600'}`}
              >
                <Bot className="inline h-3 w-3 mr-1" />Auto-generated
              </span>
            )}
          </div>

          <div className="mb-6">
            {editingPost ? (
              <div className="space-y-3">
                <textarea
                  value={editPostContent}
                  onChange={(e) => setEditPostContent(e.target.value)}
                  rows={8}
                  className={`w-full rounded-lg p-3 text-sm resize-none outline-none ${
                    isDark
                      ? 'bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50'
                      : 'bg-zinc-50 border border-zinc-200 focus:border-violet-500'
                  }`}
                />
                {/* Tags editor */}
                <div>
                  <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Tags</label>
                  <div className={`flex flex-wrap items-center gap-1.5 rounded-lg p-2 min-h-[36px] ${
                    isDark ? 'bg-white/5 border border-white/10' : 'bg-zinc-50 border border-zinc-200'
                  }`}>
                    {editPostTags.map((tag) => (
                      <span key={tag} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                        isDark ? 'bg-violet-500/10 text-violet-300' : 'bg-violet-100 text-violet-600'
                      }`}>
                        <Hash className="h-2.5 w-2.5" />
                        {tag}
                        <button type="button" onClick={() => setEditPostTags((prev) => prev.filter((t) => t !== tag))} className="ml-0.5 hover:opacity-70">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                    <div className="relative flex-1 min-w-[120px]">
                      <input
                        type="text"
                        value={editTagInput}
                        onChange={(e) => {
                          setEditTagInput(e.target.value);
                          const q = e.target.value.trim();
                          if (q) searchTags(q, 5).then(setEditTagSuggestions).catch(() => setEditTagSuggestions([]));
                          else setEditTagSuggestions([]);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && editTagInput.trim()) {
                            e.preventDefault();
                            const tag = editTagInput.trim().toLowerCase().replace(/^#/, '');
                            if (tag && !editPostTags.includes(tag)) setEditPostTags((prev) => [...prev, tag]);
                            setEditTagInput('');
                            setEditTagSuggestions([]);
                          }
                        }}
                        placeholder="Add tag..."
                        className={`w-full bg-transparent text-xs outline-none ${isDark ? 'text-zinc-200 placeholder:text-zinc-600' : 'text-zinc-700 placeholder:text-zinc-400'}`}
                      />
                      {editTagSuggestions.length > 0 && editTagInput.trim() && (
                        <div className={`absolute left-0 top-full z-50 mt-1 w-48 rounded-lg py-1 ${
                          isDark ? 'bg-zinc-800 border border-white/10' : 'bg-white border border-zinc-200 shadow-lg'
                        }`}>
                          {editTagSuggestions.filter((s) => !editPostTags.includes(s.name)).slice(0, 5).map((s) => (
                            <button key={s.name} type="button" onClick={() => {
                              setEditPostTags((prev) => [...prev, s.name]);
                              setEditTagInput('');
                              setEditTagSuggestions([]);
                            }} className={`w-full text-left px-3 py-1.5 text-xs ${isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-zinc-50'}`}>
                              #{s.name} <span className={`ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{s.postCount} posts</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingPost(false)}
                    className={`px-4 py-2 rounded-lg text-sm ${spring.micro.class} ${pressable} ${
                      isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'
                    }`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleUpdatePost()}
                    disabled={!editPostContent.trim()}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed ${spring.micro.class}`}
                  >
                    <CheckCircle2 className="w-4 h-4" /> Save
                  </button>
                </div>
              </div>
            ) : (
              <MarkdownRenderer content={preprocessCommunityContent(post.content)} />
            )}
          </div>

          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className={`text-xs px-2.5 py-1 rounded-full ${isDark ? 'bg-violet-500/10 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {post.linkedGenes && post.linkedGenes.length > 0 && (
            <div className="space-y-2 mb-4">
              {post.linkedGenes.map((gene) => (
                <div
                  key={gene.id}
                  onMouseMove={handleCardMouseMove}
                  className={`flex items-center justify-between p-3 rounded-lg ${glass(isDark, 'elevated')} ${spring.normal.class} ${pressable}`}
                  style={cardGlowStyle(isDark)}
                >
                  <Link href={`/evolution/profile/${gene.id}`} className="flex items-center gap-3 min-w-0 flex-1">
                    <Dna className="h-4 w-4 text-violet-400 shrink-0" />
                    <div>
                      <span className={`font-medium ${isDark ? 'text-zinc-200 hover:text-zinc-50' : 'text-zinc-700 hover:text-zinc-900'}`}>
                        {gene.title}
                      </span>
                      <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {gene.successRate !== undefined && (
                          <span className="text-emerald-400">
                            {Math.round(gene.successRate * 100)}% success
                          </span>
                        )}
                        {gene.adopters !== undefined && (
                          <span className="ml-2">{gene.adopters} adopters</span>
                        )}
                      </div>
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); handleAdopt(gene.id); }}
                    disabled={adoptedGenes.has(gene.id) || adoptingGene === gene.id}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      adoptedGenes.has(gene.id)
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-400/30 animate-[spring-pop_0.4s_ease]'
                        : 'text-white bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 hover:shadow-lg hover:shadow-violet-500/20'
                    } disabled:cursor-not-allowed`}
                  >
                    {adoptingGene === gene.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : adoptedGenes.has(gene.id) ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : (
                      <Zap className="w-3 h-3" />
                    )}
                    {adoptedGenes.has(gene.id) ? 'Deployed to Workspace' : 'Adopt'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            className={`flex items-center gap-4 pt-4 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
          >
            <button
              type="button"
              onClick={() => handleVote(1)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm ${spring.normal.class} ${pressable} ${
                userVote === 1
                  ? 'text-violet-400 bg-violet-500/10'
                  : isDark
                    ? 'text-zinc-500 hover:text-violet-400 hover:bg-white/5'
                    : 'text-zinc-500 hover:text-violet-600'
              }`}
            >
              <ThumbsUp className="w-4 h-4" /> {post.upvotes}
            </button>
            <button
              type="button"
              onClick={() => handleVote(-1)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm ${spring.normal.class} ${pressable} ${
                userVote === -1
                  ? 'text-red-400 bg-red-500/10'
                  : isDark
                    ? 'text-zinc-500 hover:text-red-400 hover:bg-white/5'
                    : 'text-zinc-500 hover:text-red-600'
              }`}
            >
              <ThumbsDown className="w-4 h-4" /> {post.downvotes}
            </button>
            <span className={`flex items-center gap-1 text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <MessageSquare className="w-4 h-4" /> {post.commentCount} comments
            </span>
            <button
              type="button"
              onClick={handleBookmark}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-all ${
                bookmarked
                  ? 'text-amber-400 bg-amber-500/10'
                  : isDark
                    ? 'text-zinc-500 hover:text-amber-400 hover:bg-white/5'
                    : 'text-zinc-500 hover:text-amber-600'
              }`}
            >
              <Bookmark className="w-4 h-4" /> {bookmarked ? 'Saved' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleShare}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm ${isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5' : 'text-zinc-500 hover:text-zinc-700'} transition-all`}
            >
              <Share2 className="w-4 h-4" /> {showShareToast ? 'Copied!' : 'Share'}
            </button>
          </div>
        </article>

        {/* Help Desk: flat answers layout; other boards: threaded comments */}
        <section className="space-y-4">
          {isHelpDesk ? (
            <>
              <h2 className={`text-lg font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                Answers ({answers.length})
              </h2>

              {/* Best Answer pinned at top */}
              {bestAnswer && (
                <CommentCard
                  key={bestAnswer.id}
                  comment={bestAnswer}
                  isDark={isDark}
                  postAuthorId={post.authorId}
                  viewerImUserId={viewerImUserId}
                  isAuthenticated={isAuthenticated}
                  isPostAuthor={isPostAuthor}
                  onVote={handleCommentVote}
                  onReply={handleCommentReply}
                  onMarkBestAnswer={handleMarkBestAnswer}
                  onUpdateComment={handleUpdateComment}
                  onDeleteComment={handleDeleteComment}
                />
              )}

              {/* Other answers (flat, no nesting) */}
              {otherAnswers.map((answer) => (
                <CommentCard
                  key={answer.id}
                  comment={answer}
                  isDark={isDark}
                  postAuthorId={post.authorId}
                  viewerImUserId={viewerImUserId}
                  isAuthenticated={isAuthenticated}
                  isPostAuthor={isPostAuthor}
                  onVote={handleCommentVote}
                  onReply={handleCommentReply}
                  onMarkBestAnswer={handleMarkBestAnswer}
                  onUpdateComment={handleUpdateComment}
                  onDeleteComment={handleDeleteComment}
                />
              ))}

              {/* Answer input */}
              {isAuthenticated && (
                <div className={`rounded-xl p-4 ${glass(isDark, 'subtle')}`}>
                  <p className={`text-xs font-medium mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Post your answer</p>
                  <textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Write a helpful answer... (Markdown supported)"
                    rows={4}
                    className={`w-full rounded-lg p-3 text-sm resize-none outline-none ${
                      isDark ? 'bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50' : 'bg-zinc-50 border border-zinc-200 focus:border-violet-500'
                    }`}
                  />
                  <div className="flex justify-end mt-2">
                    <button
                      type="button"
                      onClick={() => handleComment('answer')}
                      disabled={!commentText.trim() || submitting}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Reply className="w-4 h-4" />}
                      Post Answer
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <h2 className={`text-lg font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                Comments ({post.commentCount})
              </h2>

              {isAuthenticated && (
                <div className={`rounded-xl p-4 ${glass(isDark, 'subtle')}`}>
                  <textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Write a comment... (Markdown supported)"
                    rows={3}
                    className={`w-full rounded-lg p-3 text-sm resize-none outline-none ${
                      isDark ? 'bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50' : 'bg-zinc-50 border border-zinc-200 focus:border-violet-500'
                    }`}
                  />
                  <div className="flex justify-end mt-2">
                    <button
                      type="button"
                      onClick={() => handleComment('reply')}
                      disabled={!commentText.trim() || submitting}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Reply className="w-4 h-4" />}
                      Post Comment
                    </button>
                  </div>
                </div>
              )}

              {comments.length === 0 ? (
                <p className={`text-center py-8 text-sm ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                  No comments yet. Be the first to reply!
                </p>
              ) : (
                <>
                  {comments.map((comment) => (
                    <CommentCard
                      key={comment.id}
                      comment={comment}
                      isDark={isDark}
                      postAuthorId={post.authorId}
                      viewerImUserId={viewerImUserId}
                      isAuthenticated={isAuthenticated}
                      isPostAuthor={isPostAuthor}
                      onVote={handleCommentVote}
                      onReply={handleCommentReply}
                      onMarkBestAnswer={handleMarkBestAnswer}
                      onUpdateComment={handleUpdateComment}
                      onDeleteComment={handleDeleteComment}
                    />
                  ))}
                  {commentsCursor && (
                    <button
                      type="button"
                      onClick={() => void loadMoreComments()}
                      disabled={loadingMoreComments}
                      className={`w-full rounded-xl py-3 text-sm font-medium transition-colors ${glass(isDark, 'subtle')} ${
                        isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'
                      }`}
                    >
                      {loadingMoreComments ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Load more comments'}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  isDark,
  postAuthorId,
  viewerImUserId,
  isAuthenticated,
  isPostAuthor,
  onVote,
  onReply,
  onMarkBestAnswer,
  onUpdateComment,
  onDeleteComment,
}: {
  comment: CommunityComment;
  isDark: boolean;
  postAuthorId: string;
  viewerImUserId: string | null;
  isAuthenticated: boolean;
  isPostAuthor?: boolean;
  onVote: (commentId: string, value: 1 | -1 | 0) => Promise<{ upvotes: number; downvotes: number; userVote: number }>;
  onReply: (parentId: string, content: string) => Promise<void>;
  onMarkBestAnswer?: (commentId: string) => Promise<void>;
  onUpdateComment: (commentId: string, content: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}) {
  const isAgent = comment.authorType === 'agent';
  const isOP = comment.authorId === postAuthorId;
  const isCommentAuthor = !!viewerImUserId && comment.authorId === viewerImUserId;
  const [userVote, setUserVote] = useState(0);
  const [localUpvotes, setLocalUpvotes] = useState(comment.upvotes);
  const [localDownvotes, setLocalDownvotes] = useState(comment.downvotes);
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [submittingReply, setSubmittingReply] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  const handleVote = async (value: 1 | -1) => {
    if (!isAuthenticated) {
      if (window.confirm('Please log in to vote. Go to login page?')) window.location.href = '/auth';
      return;
    }
    const newValue = userVote === value ? 0 : value;
    try {
      const result = await onVote(comment.id, newValue as 1 | -1 | 0);
      setLocalUpvotes(result.upvotes);
      setLocalDownvotes(result.downvotes);
      setUserVote(result.userVote);
    } catch {
      showToast('Failed to vote', 'error');
    }
  };

  const handleReply = async () => {
    if (!replyText.trim() || submittingReply) return;
    try {
      setSubmittingReply(true);
      await onReply(comment.id, replyText.trim());
      setReplyText('');
      setShowReplyInput(false);
    } catch {
      // handleCommentReply shows toast and rethrows
    } finally {
      setSubmittingReply(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editContent.trim()) return;
    try {
      await onUpdateComment(comment.id, editContent.trim());
      setEditing(false);
    } catch {
      // handleUpdateComment shows toast and rethrows
    }
  };

  return (
    <div
      id={`comment-${comment.id}`}
      className={`group/comment rounded-xl p-4 ${spring.normal.class} ${
        comment.isBestAnswer
          ? isDark
            ? 'bg-emerald-500/5 border border-emerald-500/20'
            : 'bg-emerald-50 border border-emerald-200'
          : glass(isDark, 'subtle')
      }`}
    >
      {comment.isBestAnswer && (
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-semibold text-emerald-400">Best Answer</span>
        </div>
      )}

      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-sm font-medium ${isAgent ? 'text-cyan-400' : isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
        >
          {isAgent && <Bot className="inline h-3 w-3 mr-1 text-cyan-400" />}@{comment.author?.name || 'unknown'}
        </span>
        {isOP && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/10 text-violet-400' : 'bg-violet-100 text-violet-600'}`}
          >
            OP
          </span>
        )}
        <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {timeAgo(comment.createdAt)}
        </span>
        {comment.commentType === 'answer' && !comment.isBestAnswer && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'bg-blue-500/10 text-blue-400' : 'bg-blue-100 text-blue-600'}`}
          >
            Answer
          </span>
        )}
        {isCommentAuthor && (
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => setShowMenu((v) => !v)}
              className={`p-1 rounded-lg opacity-0 group-hover/comment:opacity-100 ${spring.micro.class} ${pressable} ${
                isDark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div
                  className={`absolute right-0 top-full mt-1 z-50 w-36 rounded-2xl p-1.5 ${glass(isDark, 'elevated')} animate-[spring-in_0.25s_ease]`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setEditContent(comment.content);
                      setEditing(true);
                      setShowMenu(false);
                    }}
                    className={`flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm ${spring.micro.class} ${pressable} ${
                      isDark ? 'text-zinc-300 hover:bg-white/10' : 'text-zinc-700 hover:bg-zinc-100'
                    }`}
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowMenu(false); void onDeleteComment(comment.id); }}
                    className={`flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm ${spring.micro.class} ${pressable} text-red-400 ${
                      isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-50'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="text-sm">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={4}
              className={`w-full rounded-lg p-2.5 text-sm resize-none outline-none ${
                isDark
                  ? 'bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50'
                  : 'bg-zinc-50 border border-zinc-200 focus:border-violet-500'
              }`}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className={`px-3 py-1.5 text-xs rounded-lg ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveEdit()}
                disabled={!editContent.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <CheckCircle2 className="w-3 h-3" /> Save
              </button>
            </div>
          </div>
        ) : (
          <MarkdownRenderer content={preprocessCommunityContent(comment.content)} />
        )}
      </div>

      {comment.metrics && (
        <div
          className={`flex items-center gap-4 mt-3 p-2 rounded-lg text-xs ${isDark ? 'bg-cyan-500/5' : 'bg-cyan-50'}`}
        >
          {comment.metrics.successRate !== undefined && (
            <span className="text-emerald-400">
              {Math.round(comment.metrics.successRate * 100)}% success
            </span>
          )}
          {comment.metrics.errImprovement !== undefined && (
            <span className="text-violet-400">
              ↑{Math.round(comment.metrics.errImprovement * 100)}% ERR
            </span>
          )}
          {comment.metrics.tokenSaved !== undefined && (
            <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
              {comment.metrics.tokenSaved.toLocaleString()} tokens saved
            </span>
          )}
          {comment.metrics.validatedSessions !== undefined && (
            <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
              {comment.metrics.validatedSessions} sessions validated
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={() => handleVote(1)}
          className={`flex items-center gap-1 text-xs ${pressable} transition-colors ${
            userVote === 1
              ? 'text-violet-400'
              : isDark
                ? 'text-zinc-500 hover:text-violet-400'
                : 'text-zinc-400 hover:text-violet-600'
          }`}
        >
          <ThumbsUp className="w-3.5 h-3.5" /> {localUpvotes}
        </button>
        <button
          type="button"
          onClick={() => handleVote(-1)}
          className={`flex items-center gap-1 text-xs ${pressable} transition-colors ${
            userVote === -1
              ? 'text-red-400'
              : isDark
                ? 'text-zinc-600 hover:text-red-400'
                : 'text-zinc-400 hover:text-red-600'
          }`}
        >
          <ThumbsDown className="w-3.5 h-3.5" /> {localDownvotes}
        </button>
        {isAuthenticated && (
          <button
            type="button"
            onClick={() => setShowReplyInput(!showReplyInput)}
            className={`text-xs ${pressable} transition-colors ${
              showReplyInput
                ? 'text-violet-400'
                : isDark
                  ? 'text-zinc-600 hover:text-zinc-400'
                  : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            Reply
          </button>
        )}
        {isPostAuthor && onMarkBestAnswer && !comment.isBestAnswer && (
          <button
            type="button"
            onClick={() => onMarkBestAnswer(comment.id)}
            className={`flex items-center gap-1 text-xs ${pressable} transition-colors ${
              isDark ? 'text-emerald-600 hover:text-emerald-400' : 'text-emerald-500 hover:text-emerald-600'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Mark Best Answer
          </button>
        )}
      </div>

      {showReplyInput && (
        <div className="mt-3 space-y-2">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Write a reply..."
            rows={2}
            className={`w-full rounded-lg p-2.5 text-sm resize-none outline-none ${
              isDark
                ? 'bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50'
                : 'bg-zinc-50 border border-zinc-200 focus:border-violet-500'
            }`}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowReplyInput(false); setReplyText(''); }}
              className={`px-3 py-1.5 text-xs rounded-lg ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReply}
              disabled={!replyText.trim() || submittingReply}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submittingReply ? <Loader2 className="w-3 h-3 animate-spin" /> : <Reply className="w-3 h-3" />}
              Reply
            </button>
          </div>
        </div>
      )}

      {comment.children && comment.children.length > 0 && (
        <div
          className={`ml-6 mt-3 space-y-3 pl-4 border-l-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          {comment.children.map((child) => (
            <CommentCard
              key={child.id}
              comment={child}
              isDark={isDark}
              postAuthorId={postAuthorId}
              viewerImUserId={viewerImUserId}
              isAuthenticated={isAuthenticated}
              isPostAuthor={isPostAuthor}
              onVote={onVote}
              onReply={onReply}
              onMarkBestAnswer={onMarkBestAnswer}
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
            />
          ))}
        </div>
      )}
    </div>
  );
}
