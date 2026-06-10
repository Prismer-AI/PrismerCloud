'use client';

/**
 * /settings — Account & workspace settings root.
 *
 * Wave-7 §30 §2.8.6 / Wave-7 §31 §2.1: surfaces the CEO Authorization
 * panel. Triggering CeoAuthorizationModal from a deliberate Settings
 * entry — NOT auto-popped on Simple Mode completion — is the active
 * trigger path until §31 dispatch lands (after which the dispatch
 * path will simply read `metadata.ceoPermissions`).
 *
 * Future sections (workspace, security, notifications, …) live under
 * the same shell — left rail picks the section, right pane renders it.
 * For now CEO Authorization is the only section, so the rail collapses
 * to a single-item nav (visible so the layout reads as "Settings →
 * CEO Authorization" rather than "single page").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { Crown, Loader2, ShieldCheck, ShieldOff, Upload, UserCircle } from 'lucide-react';

import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { useI18n } from '@/contexts/i18n-context';
import { CeoAuthorizationModal } from '@/app/workspace/components/unified-creation';
import { Button } from '@/components/ui/button';
import { renameSelf, validateSlug } from '@/app/workspace/lib/agent-rename';
import { imFetch } from '@/app/workspace/lib/im-api';
import { uploadAssetWithDirectFallback, type AssetUploadProgress } from '@/app/workspace/lib/asset-upload';
import { AvatarCropper } from '@/app/workspace/components/avatar-cropper';
import type { WorkspaceDTO } from '@/app/workspace/lib/types';
import { avatarGradient, avatarInitials, radius, s, springSnap } from '@/app/workspace/lib/design';

// Public, no-auth avatar byte route (src/im/api/assets.ts — registered before
// the assets router's authMiddleware so a bare <img src> can fetch it).
const AVATAR_PUBLIC_PATH = (assetId: string) => `/api/im/assets/${encodeURIComponent(assetId)}/avatar`;
// Mirror the public route's gate so we fail fast client-side.
const AVATAR_MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

interface CeoPermissions {
  canCreateAgents: boolean;
  canDispatch: boolean;
}

const DEFAULT_PERMS: CeoPermissions = { canCreateAgents: false, canDispatch: false };

async function fetchPermissions(): Promise<CeoPermissions> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const stored = localStorage.getItem('prismer_auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.token) headers['Authorization'] = `Bearer ${parsed.token}`;
    }
  } catch {
    /* ignore — request just runs unauthenticated and the server 401s */
  }
  const resp = await fetch('/api/users/me/ceo-permissions', { headers, cache: 'no-store' });
  if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
  const body = await resp.json();
  if (!body?.success) throw new Error(body?.error?.message ?? 'GET failed');
  return body.data as CeoPermissions;
}

async function patchPermissions(patch: Partial<CeoPermissions>): Promise<CeoPermissions> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const stored = localStorage.getItem('prismer_auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.token) headers['Authorization'] = `Bearer ${parsed.token}`;
    }
  } catch {
    /* ignore */
  }
  const resp = await fetch('/api/users/me/ceo-permissions', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`PATCH failed: ${resp.status}`);
  const body = await resp.json();
  if (!body?.success) throw new Error(body?.error?.message ?? 'PATCH failed');
  return body.data as CeoPermissions;
}

function PermissionToggle({
  isDark,
  label,
  description,
  checked,
  disabled,
  onChange,
  testId,
}: {
  isDark: boolean;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <div
      className={`flex items-start justify-between gap-4 border p-4 ${s(isDark ? 'dark' : 'light', 'inset')} ${radius.card}`}
    >
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{label}</p>
        <p className={`mt-0.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{description}</p>
      </div>
      <motion.button
        type="button"
        role="switch"
        aria-checked={checked}
        data-testid={testId}
        disabled={disabled}
        whileTap={reduce || disabled ? undefined : { scale: 0.96 }}
        transition={springSnap}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          disabled ? 'cursor-not-allowed opacity-60' : ''
        } ${checked ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500' : isDark ? 'bg-zinc-700' : 'bg-zinc-300'}`}
      >
        <motion.span
          layout
          transition={springSnap}
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </motion.button>
    </div>
  );
}

// ─── Profile section ──────────────────────────────────────────────
//
// Mirrors src/app/workspace/components/self-profile-dialog.tsx exactly:
//   - GET  current profile via imFetch<MeResponse>('/me')   (dialog L95)
//   - PATCH changed fields via renameSelf(...)               (dialog L162)
// Same payload shape: only changed fields are sent; avatarUrl '' → null.

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
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
}

interface ProfileSnapshot {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

function looksLikeUrl(value: string): boolean {
  if (!value) return false;
  const v = value.trim();
  // http(s) for pasted URLs; `/api/im/assets/...` for uploaded avatars
  // (the public, no-auth byte path served from our own origin).
  return /^https?:\/\//i.test(v) || v.startsWith('/api/im/assets/');
}

function ProfileSection({
  isDark,
  notify,
}: {
  isDark: boolean;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [original, setOriginal] = useState<ProfileSnapshot | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [avatarPreviewBroken, setAvatarPreviewBroken] = useState(false);

  // Avatar upload (real file → /api/im/assets → public /:id/avatar path).
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadPhase, setUploadPhase] = useState<AssetUploadProgress['phase'] | null>(null);
  // Image picked for cropping (the crop editor opens; its output is uploaded).
  const [cropFile, setCropFile] = useState<File | null>(null);
  // Cache the resolved default workspace id across uploads.
  const workspaceIdRef = useRef<string | null>(null);

  // Resolve (and memoise) the user's default workspace id — same selection
  // rule as workspace/page.tsx L632: prefer isDefault, else the first one.
  const resolveWorkspaceId = useCallback(async (): Promise<string | null> => {
    if (workspaceIdRef.current) return workspaceIdRef.current;
    const res = await imFetch<WorkspaceDTO[]>('/workspaces');
    if (!res.ok || !Array.isArray(res.data)) return null;
    const ws = res.data.find((w) => w.isDefault) ?? res.data[0] ?? null;
    workspaceIdRef.current = ws?.id ?? null;
    return workspaceIdRef.current;
  }, []);

  const handleAvatarFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        notify(t('settings.profile.pickImage'), 'error');
        return;
      }
      if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
        notify(t('settings.profile.imageTooLarge'), 'error');
        return;
      }
      setUploadPhase('hashing');
      try {
        const workspaceId = await resolveWorkspaceId();
        if (!workspaceId) {
          notify(t('settings.profile.noDefaultWorkspace'), 'error');
          return;
        }
        const res = await uploadAssetWithDirectFallback({
          file,
          workspaceId,
          metadata: { title: file.name, source: 'settings_profile_avatar' },
          imFetch,
          onProgress: (p) => setUploadPhase(p.phase),
        });
        if (!res.ok) {
          notify(res.message || res.error || t('settings.profile.uploadFailed'), 'error');
          return;
        }
        if (!res.data?.id) {
          notify(t('settings.profile.uploadMissingId'), 'error');
          return;
        }
        // Point the avatar at the short, public, immutable byte path; the
        // existing 保存 button will PATCH /me with this (≤500 chars).
        setAvatarUrl(AVATAR_PUBLIC_PATH(res.data.id));
        setAvatarPreviewBroken(false);
        notify(t('settings.profile.avatarUploaded'), 'success');
      } catch (err) {
        notify(err instanceof Error ? err.message : t('settings.profile.uploadFailed'), 'error');
      } finally {
        setUploadPhase(null);
      }
    },
    [notify, resolveWorkspaceId, t],
  );

  // Initial load (mirrors dialog L85-121, minus the open-gated focus)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const res = await imFetch<MeResponse>('/me');
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setLoadError(res.message || res.error || t('settings.profile.loadFailed'));
        return;
      }
      const u = res.data?.user;
      if (!u) {
        setLoadError(t('settings.profile.responseMissingUser'));
        return;
      }
      const snap: ProfileSnapshot = {
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
    // `t` only used for error-fallback strings; intentionally load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trimmedDisplayName = displayName.trim();
  const trimmedAvatar = avatarUrl.trim();
  const usernameValidation = validateSlug(username);

  const displayNameChanged = !!original && trimmedDisplayName !== original.displayName.trim();
  const usernameChanged = !!original && username !== original.username;
  const avatarChanged = !!original && trimmedAvatar !== original.avatarUrl.trim();
  const hasChanges = displayNameChanged || usernameChanged || avatarChanged;

  const displayNameInvalid = trimmedDisplayName.length === 0 || trimmedDisplayName.length > 128;
  const canSubmit =
    !!original && !submitting && !loading && !loadError && hasChanges && !displayNameInvalid && usernameValidation.valid;

  async function handleSave() {
    if (!canSubmit || !original) return;
    setSubmitting(true);
    setUsernameError(null);
    setDisplayNameError(null);

    // Same wire shape as dialog L157-160: only changed fields, avatar '' → null.
    const body: { username?: string; displayName?: string; avatarUrl?: string | null } = {};
    if (usernameChanged) body.username = username;
    if (displayNameChanged) body.displayName = trimmedDisplayName;
    if (avatarChanged) body.avatarUrl = trimmedAvatar.length === 0 ? null : trimmedAvatar;

    const res = await renameSelf(body);
    setSubmitting(false);

    if (!res.ok) {
      if (res.status === 409) {
        setUsernameError(res.message || t('settings.profile.usernameTaken'));
        return;
      }
      if (res.status === 400) {
        const msg = res.message || t('settings.profile.invalidInput');
        if (/username/i.test(msg)) setUsernameError(msg);
        else if (/displayName/i.test(msg)) setDisplayNameError(msg);
        else setUsernameError(msg);
        return;
      }
      notify(res.message || t('settings.profile.updateFailed'), 'error');
      return;
    }

    const updated = (res.data as PatchOkResponse | undefined)?.user;
    const nextSnap: ProfileSnapshot = {
      id: updated?.id ?? original.id,
      username: updated?.username ?? username,
      displayName: updated?.displayName ?? trimmedDisplayName,
      avatarUrl: updated?.avatarUrl ?? (trimmedAvatar.length === 0 ? '' : trimmedAvatar),
    };
    setOriginal(nextSnap);
    setDisplayName(nextSnap.displayName);
    setUsername(nextSnap.username);
    setAvatarUrl(nextSnap.avatarUrl);
    notify(t('settings.profile.updated'), 'success');
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
    <section
      data-testid="settings-profile"
      className={`border p-5 sm:p-6 ${s(isDark ? 'dark' : 'light', 'card')} ${radius.pane}`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <span
          aria-hidden
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white"
          style={{ backgroundImage: 'linear-gradient(135deg, #8b5cf6 0%, #06b6d4 100%)' }}
        >
          <UserCircle className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className={`text-base sm:text-lg font-semibold ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}>
            {t('settings.profile.title')}
          </h2>
          <p className={`mt-0.5 text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
            {t('settings.profile.subtitle')}
          </p>
        </div>
      </div>

      <div className="mt-5">
        {loading ? (
          <div
            className={`flex items-center gap-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
            data-testid="settings-profile-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" /> {t('settings.common.loading')}
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className={`rounded-xl border px-3 py-2 text-xs ${
              isDark ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'
            }`}
          >
            {loadError}
          </div>
        ) : original ? (
          <div
            className="grid gap-4"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && canSubmit) {
                e.preventDefault();
                void handleSave();
              }
            }}
          >
            {/* Display name */}
            <label className="grid gap-1.5">
              <span className={labelClass}>{t('settings.profile.displayName')}</span>
              <input
                type="text"
                value={displayName}
                maxLength={128}
                disabled={submitting}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setDisplayNameError(null);
                }}
                className={`${inputClass} ${displayNameError ? errInputClass : ''}`}
                placeholder={t('settings.profile.displayNamePlaceholder')}
                aria-invalid={displayNameError ? true : undefined}
              />
              {displayNameError ? (
                <p className="text-xs text-red-500" role="alert">
                  {displayNameError}
                </p>
              ) : null}
            </label>

            {/* Username */}
            <label className="grid gap-1.5">
              <span className={labelClass}>{t('settings.profile.username')}</span>
              <div className="relative">
                <span
                  className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm ${
                    isDark ? 'text-zinc-500' : 'text-zinc-400'
                  }`}
                >
                  @
                </span>
                <input
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
                  placeholder={t('settings.profile.usernamePlaceholder')}
                  aria-invalid={usernameError || (usernameTouched && !usernameValidation.valid) ? true : undefined}
                />
              </div>
              {usernameError ? (
                <p className="text-xs text-red-500" role="alert">
                  {usernameError}
                </p>
              ) : usernameTouched && !usernameValidation.valid ? (
                <p className="text-xs text-red-500" role="alert">
                  {usernameValidation.reason}
                </p>
              ) : (
                <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {t('settings.profile.usernameHint')}
                </p>
              )}
            </label>

            {/* Avatar */}
            <div className="grid gap-1.5">
              <span className={labelClass}>{t('settings.profile.avatar')}</span>
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
                <div className="flex flex-1 flex-col gap-2 min-w-0">
                  {/* Upload — real file picker → /api/im/assets → public path */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    data-testid="settings-profile-avatar-file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      // reset so re-selecting the same file fires onChange again
                      e.target.value = '';
                      // Open the crop editor first; the cropped blob is what
                      // actually gets uploaded.
                      if (file) setCropFile(file);
                    }}
                  />
                  {cropFile ? (
                    <AvatarCropper
                      file={cropFile}
                      isDark={isDark}
                      busy={uploadPhase !== null}
                      onCancel={() => setCropFile(null)}
                      onConfirm={(blob) => {
                        const cropped = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
                        void handleAvatarFile(cropped).finally(() => setCropFile(null));
                      }}
                    />
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="settings-profile-avatar-upload"
                      disabled={submitting || uploadPhase !== null}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploadPhase !== null ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {uploadPhase !== null ? t('settings.profile.uploading') : t('settings.profile.upload')}
                    </Button>
                    {trimmedAvatar ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid="settings-profile-avatar-clear"
                        disabled={submitting || uploadPhase !== null}
                        onClick={() => {
                          setAvatarUrl('');
                          setAvatarPreviewBroken(false);
                        }}
                      >
                        {t('common.remove')}
                      </Button>
                    ) : null}
                  </div>
                  {/* Manual URL paste — both paths set the same avatarUrl state */}
                  <input
                    type="text"
                    value={avatarUrl}
                    maxLength={2048}
                    disabled={submitting || uploadPhase !== null}
                    onChange={(e) => {
                      setAvatarUrl(e.target.value);
                      if (avatarPreviewBroken) setAvatarPreviewBroken(false);
                    }}
                    className={`${inputClass}`}
                    placeholder={t('settings.profile.avatarUrlPlaceholder')}
                  />
                </div>
              </div>
              <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('settings.profile.avatarHint')}
              </p>
            </div>

            <div className="flex justify-end">
              <Button data-testid="settings-profile-save" onClick={() => void handleSave()} disabled={!canSubmit}>
                {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {t('settings.profile.save')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { isAuthenticated, isAuthLoading, addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();
  const isDark = resolvedTheme === 'dark';

  const [perms, setPerms] = useState<CeoPermissions>(DEFAULT_PERMS);
  const [loading, setLoading] = useState(true);
  const [persisting, setPersisting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Redirect unauthenticated callers — same shape as /dashboard
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      router.push('/auth?redirect=/settings');
    }
  }, [isAuthLoading, isAuthenticated, router]);

  // Initial load
  useEffect(() => {
    if (!isAuthenticated) return;
    let alive = true;
    setLoading(true);
    fetchPermissions()
      .then((data) => {
        if (alive) setPerms(data);
      })
      .catch((err) => {
        console.error('[Settings] Failed to load CEO permissions', err);
        if (alive) addToast(t('settings.ceo.loadStatusFailed'), 'error');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isAuthenticated, addToast, t]);

  const onAuthorize = useCallback(async () => {
    setPersisting(true);
    try {
      const next = await patchPermissions({ canCreateAgents: true, canDispatch: true });
      setPerms(next);
      setModalOpen(false);
      addToast(t('settings.ceo.authorizedToast'), 'success');
    } catch (err) {
      console.error('[Settings] Authorize failed', err);
      addToast(err instanceof Error ? err.message : t('settings.ceo.authorizeFailed'), 'error');
    } finally {
      setPersisting(false);
    }
  }, [addToast, t]);

  const onToggle = useCallback(
    async (key: keyof CeoPermissions, next: boolean) => {
      // Optimistic UX so the switch is responsive; rollback on failure.
      const prev = perms;
      const optimistic = { ...perms, [key]: next };
      setPerms(optimistic);
      try {
        const persisted = await patchPermissions({ [key]: next } as Partial<CeoPermissions>);
        setPerms(persisted);
      } catch (err) {
        console.error('[Settings] Toggle failed', err);
        addToast(err instanceof Error ? err.message : t('settings.ceo.updateFailed'), 'error');
        setPerms(prev);
      }
    },
    [perms, addToast, t],
  );

  if (isAuthLoading || !isAuthenticated) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  const authorized = perms.canCreateAgents || perms.canDispatch;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10 min-h-[calc(100vh-64px)] space-y-6">
      <header>
        <h1 className={`text-2xl sm:text-3xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>{t('settings.page.title')}</h1>
        <p className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{t('settings.page.subtitle')}</p>
      </header>

      {/* Profile section */}
      <ProfileSection isDark={isDark} notify={addToast} />

      {/* CEO Authorization section */}
      <section
        data-testid="settings-ceo-authorization"
        className={`border p-5 sm:p-6 ${s(isDark ? 'dark' : 'light', 'card')} ${radius.pane}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white"
              style={{
                backgroundImage: 'linear-gradient(135deg, #8b5cf6 0%, #d946ef 50%, #22d3ee 100%)',
              }}
            >
              <Crown className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className={`text-base sm:text-lg font-semibold ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}>
                {t('settings.ceo.title')}
              </h2>
              <p className={`mt-0.5 text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                {t('settings.ceo.subtitle')}
              </p>
            </div>
          </div>

          {/* Status pill */}
          <span
            data-testid="settings-ceo-status"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ${radius.chip} ${
              authorized
                ? isDark
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-emerald-100 text-emerald-700'
                : isDark
                  ? 'bg-zinc-700/40 text-zinc-300'
                  : 'bg-zinc-200 text-zinc-700'
            }`}
          >
            {authorized ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
            {authorized ? t('settings.ceo.authorized') : t('settings.ceo.unauthorized')}
          </span>
        </div>

        <div className="mt-5">
          {loading ? (
            <div
              className={`flex items-center gap-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
              data-testid="settings-ceo-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" /> {t('settings.common.loading')}
            </div>
          ) : authorized ? (
            <div className="flex flex-col gap-3" data-testid="settings-ceo-toggles">
              <PermissionToggle
                isDark={isDark}
                checked={perms.canCreateAgents}
                onChange={(next) => void onToggle('canCreateAgents', next)}
                label={t('settings.ceo.toggleCreateLabel')}
                description={t('settings.ceo.toggleCreateDesc')}
                testId="settings-ceo-toggle-canCreateAgents"
              />
              <PermissionToggle
                isDark={isDark}
                checked={perms.canDispatch}
                onChange={(next) => void onToggle('canDispatch', next)}
                label={t('settings.ceo.toggleDispatchLabel')}
                description={t('settings.ceo.toggleDispatchDesc')}
                testId="settings-ceo-toggle-canDispatch"
              />
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('settings.ceo.note')}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3" data-testid="settings-ceo-unauthorized">
              <p className={`text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                {t('settings.ceo.unauthorizedBody')}
              </p>
              <div>
                <motion.button
                  type="button"
                  data-testid="settings-ceo-authorize-button"
                  onClick={() => setModalOpen(true)}
                  whileTap={{ scale: 0.97 }}
                  transition={springSnap}
                  className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white ${radius.button}`}
                  style={{
                    backgroundImage: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #d946ef 100%)',
                    boxShadow: '0 12px 24px -10px rgba(124, 58, 237, 0.55)',
                  }}
                >
                  <Crown className="h-4 w-4" />
                  {t('settings.ceo.authorizeCta')}
                </motion.button>
              </div>
            </div>
          )}
        </div>
      </section>

      <CeoAuthorizationModal
        open={modalOpen}
        onOpenChange={(open) => {
          if (!persisting) setModalOpen(open);
        }}
        isDark={isDark}
        authorizing={persisting}
        onAuthorize={onAuthorize}
      />
    </div>
  );
}
