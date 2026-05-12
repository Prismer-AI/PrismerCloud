'use client';

import { useState, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Loader2, Upload, Sparkles } from 'lucide-react';
import { glass } from './helpers';

/* ─── Types ──────────────────────────────────────────── */

interface SkillUploadSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  onCreated?: (skill: Record<string, unknown>) => void;
}

const SKILL_CATEGORIES = [
  { key: 'development', label: 'Development' },
  { key: 'devops-and-cloud', label: 'DevOps & Cloud' },
  { key: 'ai-and-ml', label: 'AI & ML' },
  { key: 'data', label: 'Data' },
  { key: 'security', label: 'Security' },
  { key: 'productivity', label: 'Productivity' },
  { key: 'communication', label: 'Communication' },
  { key: 'other', label: 'Other' },
] as const;

/* ─── Helpers ────────────────────────────────────────── */

function getToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token ?? null;
  } catch {
    return null;
  }
}

/* ─── Component ──────────────────────────────────────── */

export function SkillUploadSheet({ open, onOpenChange, isDark, onCreated }: SkillUploadSheetProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('development');
  const [tagsInput, setTagsInput] = useState('');
  const [content, setContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [signalsInput, setSignalsInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setName('');
    setDescription('');
    setCategory('development');
    setTagsInput('');
    setContent('');
    setSourceUrl('');
    setSignalsInput('');
    setError(null);
    setSuccessMessage(null);
  }, []);

  const handleClose = useCallback(
    (openState: boolean) => {
      if (!openState) {
        resetForm();
      }
      onOpenChange(openState);
    },
    [onOpenChange, resetForm],
  );

  const isValid = name.trim().length > 0 && description.trim().length > 0 && category.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!isValid || loading) return;
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const token = getToken();
      if (!token) {
        setError('Not authenticated. Please sign in first.');
        setLoading(false);
        return;
      }

      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        category,
      };

      if (tags.length > 0) body.tags = tags;
      if (content.trim()) body.content = content.trim();
      if (sourceUrl.trim()) body.sourceUrl = sourceUrl.trim();

      const signals = signalsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (signals.length > 0) body.signals = signals;

      const res = await fetch('/api/im/skills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok || data.ok === false) {
        setError(data.error?.message || data.error || data.message || `Failed to create skill (${res.status})`);
        return;
      }

      setSuccessMessage('Skill created successfully!');

      if (onCreated) {
        onCreated(data.data || data);
      }

      setTimeout(() => {
        handleClose(false);
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [
    isValid,
    loading,
    name,
    description,
    category,
    tagsInput,
    content,
    sourceUrl,
    signalsInput,
    onCreated,
    handleClose,
  ]);

  const inputClasses = `w-full bg-transparent outline-none text-sm py-2 px-3 rounded-lg transition-colors ${
    isDark
      ? 'text-zinc-200 placeholder:text-zinc-600 border border-zinc-700 focus:border-violet-500'
      : 'text-zinc-800 placeholder:text-zinc-400 border border-zinc-300 focus:border-violet-500'
  }`;

  const labelClasses = `text-xs font-semibold uppercase tracking-wider mb-2 block ${
    isDark ? 'text-zinc-400' : 'text-zinc-600'
  }`;

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent
        side="right"
        className={`sm:max-w-lg w-full overflow-y-auto ${
          isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-zinc-200'
        }`}
        showCloseButton
      >
        <SheetHeader className="pb-2">
          <SheetTitle className={`flex items-center gap-2 text-lg ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            <Sparkles className="w-5 h-5 text-violet-400" />
            Upload Skill
          </SheetTitle>
          <SheetDescription className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>
            Share a skill with the community. Define its name, category, and content.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 px-4 space-y-5 pb-4">
          {/* Name */}
          <div>
            <label className={labelClasses}>Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. HTTP Error Recovery"
              className={inputClasses}
              maxLength={120}
            />
          </div>

          {/* Description */}
          <div>
            <label className={labelClasses}>Description *</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this skill does"
              className={inputClasses}
              maxLength={300}
            />
          </div>

          {/* Category */}
          <div>
            <label className={labelClasses}>Category *</label>
            <div className={`relative ${glass(isDark)} rounded-lg`}>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={`w-full bg-transparent outline-none text-sm py-2 px-3 rounded-lg appearance-none cursor-pointer ${
                  isDark ? 'text-zinc-200' : 'text-zinc-800'
                }`}
              >
                {SKILL_CATEGORIES.map((cat) => (
                  <option
                    key={cat.key}
                    value={cat.key}
                    className={isDark ? 'bg-zinc-900 text-zinc-200' : 'bg-white text-zinc-800'}
                  >
                    {cat.label}
                  </option>
                ))}
              </select>
              <div
                className={`absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-xs ${
                  isDark ? 'text-zinc-500' : 'text-zinc-400'
                }`}
              >
                ▼
              </div>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className={labelClasses}>
              Tags
              <span className={`font-normal ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                (comma-separated)
              </span>
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. http, retry, resilience"
              className={inputClasses}
            />
            {tagsInput.trim() && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tagsInput
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((tag) => (
                    <span
                      key={tag}
                      className={`text-[10px] px-2 py-0.5 rounded-full ${
                        isDark
                          ? 'bg-violet-500/10 text-violet-300 border border-violet-500/20'
                          : 'bg-violet-50 text-violet-600 border border-violet-200'
                      }`}
                    >
                      {tag}
                    </span>
                  ))}
              </div>
            )}
          </div>

          {/* Source URL */}
          <div>
            <label className={labelClasses}>
              Source URL
              <span className={`font-normal ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>(optional)</span>
            </label>
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://github.com/..."
              className={inputClasses}
            />
          </div>

          {/* Signals */}
          <div>
            <label className={labelClasses}>
              Signals
              <span className={`font-normal ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                (comma-separated, for gene auto-conversion)
              </span>
            </label>
            <input
              type="text"
              value={signalsInput}
              onChange={(e) => setSignalsInput(e.target.value)}
              placeholder="e.g. error:timeout, error:429, perf:high_latency"
              className={inputClasses}
            />
            {signalsInput.trim() && (
              <div className="flex flex-wrap gap-1 mt-2">
                {signalsInput
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((sig) => (
                    <span
                      key={sig}
                      className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                        isDark
                          ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                          : 'bg-cyan-50 text-cyan-600 border border-cyan-200'
                      }`}
                    >
                      {sig}
                    </span>
                  ))}
              </div>
            )}
            <p className={`text-[10px] mt-1.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              When an agent installs this skill, matching signals auto-create a private Gene.
            </p>
          </div>

          {/* Content (SKILL.md) */}
          <div>
            <label className={labelClasses}>
              Content
              <span className={`font-normal ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                (SKILL.md markdown, optional)
              </span>
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# My Skill&#10;&#10;## Usage&#10;&#10;Describe how to use this skill..."
              rows={8}
              className={`${inputClasses} resize-y min-h-[120px] font-mono text-xs`}
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Success message */}
          {successMessage && (
            <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              {successMessage}
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <SheetFooter className={`flex-row gap-3 border-t ${isDark ? 'border-zinc-800' : 'border-zinc-200'}`}>
          <Button
            variant="ghost"
            onClick={() => handleClose(false)}
            disabled={loading}
            className={`flex-1 ${isDark ? 'text-zinc-400 hover:text-zinc-200' : ''}`}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || loading}
            className={`flex-1 gap-2 ${isValid && !loading ? 'bg-violet-600 hover:bg-violet-500 text-white' : ''}`}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Upload Skill
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
