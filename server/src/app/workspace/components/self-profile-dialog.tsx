'use client';

/**
 * SelfProfileDialog — rename your @handle / displayName / avatar URL.
 *
 * Hangs off the global navbar profile dropdown. Saves call `PATCH /api/im/me`
 * via `renameSelf`. Only the changed fields are sent so a no-op username
 * doesn't trip the server's uniqueness check pointlessly.
 *
 * Surface = workspace glass (surface.modal + radius.card); entrance uses
 * Radix Dialog's built-in zoom+fade.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { renameSelf, validateSlug } from '../lib/agent-rename';
import { imFetch } from '../lib/im-api';
import { avatarGradient, avatarInitials, radius, surface } from '../lib/design';

interface MeResponse {
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    agentType?: string | null;
    avatarUrl: string | null;
    createdAt: string;
  };
}

interface PatchOkResponse {
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

interface OriginalSnapshot {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface SelfProfileDialogProps {
  open: boolean;
  isDark: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after successful save so caller can refresh cached `me` state. */
  onSaved?: (updated: { id: string; username: string; displayName: string; avatarUrl: string | null }) => void;
  /** Optional toast bridge. */
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

function looksLikeUrl(s: string): boolean {
  if (!s) return false;
  return /^https?:\/\//i.test(s.trim());
}

export function SelfProfileDialog({ open, isDark, onOpenChange, onSaved, notify }: SelfProfileDialogProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [original, setOriginal] = useState<OriginalSnapshot | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [avatarPreviewBroken, setAvatarPreviewBroken] = useState(false);

  const displayNameId = useId();
  const usernameId = useId();
  const avatarId = useId();
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setUsernameError(null);
    setDisplayNameError(null);
    setUsernameTouched(false);
    setAvatarPreviewBroken(false);
    (async () => {
      const res = await imFetch<MeResponse>('/me');
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setLoadError(res.message || res.error || 'Failed to load profile');
        return;
      }
      const u = res.data?.user;
      if (!u) {
        setLoadError('Profile response missing user');
        return;
      }
      const snap: OriginalSnapshot = {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl ?? '',
      };
      setOriginal(snap);
      setDisplayName(snap.displayName);
      setUsername(snap.username);
      setAvatarUrl(snap.avatarUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open && !loading && original) {
      // Focus the first field once the form is hydrated.
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    }
  }, [open, loading, original]);

  const trimmedDisplayName = displayName.trim();
  const trimmedAvatar = avatarUrl.trim();
  const usernameValidation = validateSlug(username);

  const diffs = computeDiff(original, {
    displayName: trimmedDisplayName,
    username,
    avatarUrl: trimmedAvatar,
  });

  const displayNameInvalid = trimmedDisplayName.length === 0 || trimmedDisplayName.length > 128;
  const canSubmit =
    !!original &&
    !submitting &&
    !loading &&
    !loadError &&
    diffs.hasChanges &&
    !displayNameInvalid &&
    usernameValidation.valid;

  async function handleSubmit() {
    if (!canSubmit || !original) return;
    setSubmitting(true);
    setUsernameError(null);
    setDisplayNameError(null);

    const body: { username?: string; displayName?: string; avatarUrl?: string | null } = {};
    if (diffs.usernameChanged) body.username = username;
    if (diffs.displayNameChanged) body.displayName = trimmedDisplayName;
    if (diffs.avatarChanged) body.avatarUrl = trimmedAvatar.length === 0 ? null : trimmedAvatar;

    const res = await renameSelf(body);
    setSubmitting(false);

    if (!res.ok) {
      if (res.status === 409) {
        setUsernameError(res.message || 'Username already taken');
        return;
      }
      if (res.status === 400) {
        const msg = res.message || 'Invalid input';
        // Best-effort routing: backend mentions which field on 400.
        if (/username/i.test(msg)) setUsernameError(msg);
        else if (/displayName/i.test(msg)) setDisplayNameError(msg);
        else setUsernameError(msg);
        return;
      }
      notify?.(res.message || 'Profile update failed', 'error');
      return;
    }

    const updated = (res.data as PatchOkResponse | undefined)?.user;
    notify?.('Profile updated', 'success');
    onSaved?.({
      id: updated?.id ?? original.id,
      username: updated?.username ?? username,
      displayName: updated?.displayName ?? trimmedDisplayName,
      avatarUrl: updated?.avatarUrl ?? (trimmedAvatar.length === 0 ? null : trimmedAvatar),
    });
    onOpenChange(false);
  }

  const labelClass = `text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`;
  const inputClass = `w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none transition focus:ring-1 ${
    isDark
      ? 'border-white/[0.1] text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/60 focus:ring-violet-500/40'
      : 'border-zinc-300 text-zinc-900 placeholder:text-zinc-400 focus:border-violet-400 focus:ring-violet-400/40'
  }`;
  const errInputClass = isDark
    ? 'border-red-400/60 focus:border-red-400 focus:ring-red-500/40'
    : 'border-red-500 focus:border-red-500 focus:ring-red-400/40';

  const previewSeed = original?.id ?? 'self';
  const previewName = trimmedDisplayName || original?.displayName || username || 'You';
  const grad = avatarGradient(previewSeed);
  const showImgPreview = looksLikeUrl(trimmedAvatar) && !avatarPreviewBroken;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="self-profile-dialog"
        className={`max-w-md border ${surface.modal[isDark ? 'dark' : 'light']} ${radius.card}`}
      >
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading profile…
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className={`my-2 rounded-xl border px-3 py-2 text-xs ${
              isDark ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'
            }`}
          >
            {loadError}
          </div>
        ) : original ? (
          <div
            className="grid gap-4 pt-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && canSubmit) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          >
            {/* Display name */}
            <label className="grid gap-1.5" htmlFor={displayNameId}>
              <span className={labelClass}>Display name</span>
              <input
                ref={firstInputRef}
                id={displayNameId}
                type="text"
                value={displayName}
                maxLength={128}
                disabled={submitting}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setDisplayNameError(null);
                }}
                className={`${inputClass} ${displayNameError ? errInputClass : ''}`}
                placeholder="Your name"
                aria-invalid={displayNameError ? true : undefined}
                aria-describedby={displayNameError ? `${displayNameId}-error` : undefined}
              />
              <div className="flex items-center justify-between">
                {displayNameError ? (
                  <p id={`${displayNameId}-error`} className="text-xs text-red-500" role="alert">
                    {displayNameError}
                  </p>
                ) : (
                  <span />
                )}
                {trimmedDisplayName.length > 100 ? (
                  <span className={`text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {trimmedDisplayName.length}/128
                  </span>
                ) : null}
              </div>
            </label>

            {/* Username */}
            <label className="grid gap-1.5" htmlFor={usernameId}>
              <span className={labelClass}>Username</span>
              <div className="relative">
                <span
                  className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm ${
                    isDark ? 'text-zinc-500' : 'text-zinc-400'
                  }`}
                >
                  @
                </span>
                <input
                  id={usernameId}
                  type="text"
                  value={username}
                  maxLength={31}
                  disabled={submitting}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setUsernameError(null);
                    setUsernameTouched(true);
                  }}
                  onBlur={() => setUsernameTouched(true)}
                  className={`${inputClass} pl-7 font-mono ${
                    (usernameTouched && !usernameValidation.valid) || usernameError ? errInputClass : ''
                  }`}
                  placeholder="your-handle"
                  aria-invalid={usernameError || (usernameTouched && !usernameValidation.valid) ? true : undefined}
                  aria-describedby={`${usernameId}-feedback`}
                />
              </div>
              {usernameError ? (
                <p id={`${usernameId}-feedback`} className="text-xs text-red-500" role="alert">
                  {usernameError}
                </p>
              ) : usernameTouched && !usernameValidation.valid ? (
                <p id={`${usernameId}-feedback`} className="text-xs text-red-500" role="alert">
                  {usernameValidation.reason}
                </p>
              ) : (
                <p
                  id={`${usernameId}-feedback`}
                  className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  3-31 个小写字母 / 数字 / 连字符，以字母开头，全局唯一。
                </p>
              )}
            </label>

            {/* Avatar URL */}
            <label className="grid gap-1.5" htmlFor={avatarId}>
              <span className={labelClass}>Avatar URL</span>
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white shadow-sm"
                  style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
                >
                  {showImgPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={trimmedAvatar}
                      alt=""
                      className="h-full w-full object-cover"
                      onError={() => setAvatarPreviewBroken(true)}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    avatarInitials(previewName)
                  )}
                </span>
                <input
                  id={avatarId}
                  type="url"
                  value={avatarUrl}
                  maxLength={2048}
                  disabled={submitting}
                  onChange={(e) => {
                    setAvatarUrl(e.target.value);
                    // Give the preview <img> a fresh shot at loading after each edit.
                    if (avatarPreviewBroken) setAvatarPreviewBroken(false);
                  }}
                  className={`${inputClass}`}
                  placeholder="https://… or leave blank"
                  aria-describedby={`${avatarId}-help`}
                />
              </div>
              <p id={`${avatarId}-help`} className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                v1: paste an image URL. Upload UI coming soon.
              </p>
            </label>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button data-testid="self-profile-save" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function computeDiff(
  original: OriginalSnapshot | null,
  current: { displayName: string; username: string; avatarUrl: string },
): {
  hasChanges: boolean;
  displayNameChanged: boolean;
  usernameChanged: boolean;
  avatarChanged: boolean;
} {
  if (!original) {
    return { hasChanges: false, displayNameChanged: false, usernameChanged: false, avatarChanged: false };
  }
  const displayNameChanged = current.displayName !== original.displayName.trim();
  const usernameChanged = current.username !== original.username;
  const avatarChanged = current.avatarUrl !== original.avatarUrl.trim();
  return {
    hasChanges: displayNameChanged || usernameChanged || avatarChanged,
    displayNameChanged,
    usernameChanged,
    avatarChanged,
  };
}
