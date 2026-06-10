'use client';

/**
 * Invite landing page — release201/16 Phase 9, reworked as a MAGIC-LINK
 * one-click join (Slack/Notion style).
 *
 * Route: /invite/:token
 *
 * Public preview (no auth). Calls `GET /api/im/invites/:token` to render the
 * workspace name + inviter avatar + role.
 *
 * Logged-out + pending email invite: ONE button "Join <workspace>" →
 * `POST /api/auth/invite-claim { inviteToken }` → server validates the token,
 * finds-or-creates the invitee's passwordless account (email forced to the
 * token's server-resolved inviteeEmail), issues a session, accepts the invite,
 * and returns the session in the same shape /api/auth/register does. We persist
 * it via `login()` (→ localStorage `prismer_auth`) and land in /workspace.
 * NO password form, NO verification code, NO bounce to /auth.
 *
 * We do NOT auto-claim on page load — email-link prefetchers would trigger it.
 * The claim requires the explicit button click.
 *
 * Logged-in + pending invite: "Join <workspace>" → existing
 * `POST /api/im/invites/:token/accept`. If the invite's email differs from the
 * signed-in account, the server's P0.2 guard 403s and we tell the user to sign
 * out and use the invited address.
 *
 * Forbidden patterns (16 §0.2.4) honored: never shows member/asset counts,
 * never leaks workspace owner beyond inviter avatar, never displays the token.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { getWorkspaceToken } from '@/app/workspace/lib/im-api';

type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

interface InvitePreview {
  workspaceName: string;
  inviterDisplayName: string;
  inviterAvatar: string | null;
  role: 'admin' | 'member';
  status: InviteStatus;
  expiresAt: string;
  inviteeEmail: string | null;
}

interface PreviewError {
  code: string;
  message: string;
}

export default function InviteLandingPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const token = params?.token ?? '';
  const { isAuthenticated, isAuthLoading, user, login, addToast } = useApp();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        // Public preview — explicitly NOT sending auth header even when we
        // have a token, so server-side cache keys stay uniform and we don't
        // accidentally couple preview content to identity.
        const res = await fetch(`/api/im/invites/${encodeURIComponent(token)}`, {
          signal: ctrl.signal,
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.ok && body.data) {
          setPreview(body.data as InvitePreview);
        } else {
          const code = body?.meta?.code ?? `HTTP_${res.status}`;
          const message = body?.error ?? `Request failed (${res.status})`;
          setError({ code, message });
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError({ code: 'NETWORK', message: (err as Error).message });
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [token]);

  // Magic-link claim (logged-out): one click → account + session + accept.
  async function joinAsNewUser() {
    setJoining(true);
    setInlineError(null);
    try {
      const res = await fetch('/api/auth/invite-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: token }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.token && body?.user) {
        // Persist EXACTLY how the auth page persists a login session.
        login(body.user, body.token);
        addToast('Joined workspace.', 'success');
        router.push('/workspace');
      } else {
        const msg = body?.error?.msg ?? `Request failed (${res.status})`;
        setInlineError(msg);
        if (res.status === 400 || res.status === 410) {
          setPreview((p) => (p ? { ...p, status: 'expired' } : p));
        }
      }
    } catch (err) {
      setInlineError((err as Error).message);
    } finally {
      setJoining(false);
    }
  }

  // Logged-in accept: existing IM accept endpoint (P0.2 email-match enforced
  // server-side). Surface the mismatch clearly when it 403s.
  async function joinAsCurrentUser() {
    const authToken = getWorkspaceToken();
    if (!authToken) return;
    setJoining(true);
    setInlineError(null);
    try {
      const res = await fetch(`/api/im/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        addToast('Joined workspace.', 'success');
        router.push('/workspace');
      } else if (res.status === 403) {
        const invited = preview?.inviteeEmail ?? 'a different address';
        const current = user?.email ?? 'your current account';
        setInlineError(
          `This invite was sent to ${invited}. You're signed in as ${current} — sign out to join.`,
        );
      } else {
        const message = body?.error ?? `Request failed (${res.status})`;
        setInlineError(message);
        if (res.status === 410) {
          setPreview((p) => (p ? { ...p, status: 'expired' } : p));
        }
      }
    } finally {
      setJoining(false);
    }
  }

  const bg = isDark ? 'bg-zinc-950' : 'bg-zinc-50';
  const cardSurface = isDark ? 'bg-zinc-900 border-white/[0.06]' : 'bg-white border-zinc-200';

  return (
    <div className={`min-h-screen w-full flex items-center justify-center px-4 py-12 ${bg}`}>
      <div className={`w-full max-w-md rounded-2xl border shadow-sm p-8 space-y-6 ${cardSurface}`}>
        {loading ? <LoadingState isDark={isDark} /> : null}
        {!loading && error ? <ErrorState code={error.code} message={error.message} isDark={isDark} /> : null}
        {!loading && preview ? (
          <PreviewBody
            preview={preview}
            isAuthenticated={isAuthenticated}
            isAuthLoading={isAuthLoading}
            joining={joining}
            inlineError={inlineError}
            onJoin={isAuthenticated ? joinAsCurrentUser : joinAsNewUser}
            isDark={isDark}
          />
        ) : null}
      </div>
    </div>
  );
}

function LoadingState({ isDark }: { isDark: boolean }) {
  const muted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  return (
    <div className={`flex flex-col items-center gap-3 py-8 ${muted}`}>
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="text-sm">Looking up invite…</p>
    </div>
  );
}

function ErrorState({ code, message, isDark }: { code: string; message: string; isDark: boolean }) {
  // Map server error codes to user-facing copy. Avoid leaking internal
  // diagnostics; only show developer-y info under the friendly line.
  const friendly = (() => {
    switch (code) {
      case 'INVITE_NOT_FOUND':
        return 'This invite link is no longer valid.';
      case 'INVITE_EXPIRED':
        return 'This invite has expired. Ask the sender for a new link.';
      case 'INVITE_ALREADY_USED':
        return 'This invite has already been used.';
      case 'INVITE_REVOKED':
        return 'This invite was revoked by its sender.';
      default:
        return 'We could not load this invite.';
    }
  })();
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const textFaint = isDark ? 'text-zinc-500' : 'text-zinc-500';
  return (
    <div className="flex flex-col items-center text-center gap-3 py-4">
      <AlertCircle className={`h-8 w-8 ${textMuted}`} />
      <h1 className={`text-lg font-semibold ${textPrimary}`}>{friendly}</h1>
      <p className={`text-xs ${textFaint}`}>
        {code} · {message}
      </p>
      <Button asChild variant="link">
        <Link href="/">Return home</Link>
      </Button>
    </div>
  );
}

function PreviewBody({
  preview,
  isAuthenticated,
  isAuthLoading,
  joining,
  inlineError,
  onJoin,
  isDark,
}: {
  preview: InvitePreview;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  joining: boolean;
  inlineError: string | null;
  onJoin: () => void;
  isDark: boolean;
}) {
  const isTerminal = preview.status !== 'pending';
  const initial = (preview.inviterDisplayName || '?').trim().charAt(0).toUpperCase();
  const expiresMs = new Date(preview.expiresAt).getTime();
  const hoursLeft = Math.max(0, Math.round((expiresMs - Date.now()) / (60 * 60 * 1000)));
  const expiresLine =
    hoursLeft >= 48
      ? `Expires in ${Math.round(hoursLeft / 24)} days`
      : hoursLeft > 1
        ? `Expires in ${hoursLeft} hours`
        : hoursLeft === 1
          ? 'Expires in 1 hour'
          : 'Expires soon';

  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const textFaint = isDark ? 'text-zinc-500' : 'text-zinc-500';
  const subtleBg = isDark ? 'bg-white/[0.04]' : 'bg-zinc-100';

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center text-center gap-3">
        <Avatar src={preview.inviterAvatar} initial={initial} isDark={isDark} />
        <p className={`text-sm ${textMuted}`}>
          <span className={`${textPrimary} font-medium`}>{preview.inviterDisplayName}</span> invited you to join
        </p>
        <h1 className={`text-2xl font-semibold ${textPrimary}`}>{preview.workspaceName}</h1>
        <p className={`text-xs ${textFaint}`}>
          as <span className="font-mono">{preview.role}</span>
          {!isTerminal ? <> · {expiresLine}</> : null}
        </p>
      </div>

      {isTerminal ? (
        <div className={`rounded-lg px-3 py-2 text-sm text-center ${subtleBg} ${textMuted}`}>
          This invite is no longer pending (<span className="font-mono">{preview.status}</span>).
        </div>
      ) : null}

      {!isTerminal ? (
        <>
          {isAuthLoading ? (
            <div className="flex items-center justify-center py-2">
              <Loader2 className={`h-5 w-5 animate-spin ${textFaint}`} />
            </div>
          ) : (
            <Button onClick={onJoin} disabled={joining} className="w-full">
              {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Join {preview.workspaceName}
            </Button>
          )}

          {!isAuthLoading && !isAuthenticated && preview.inviteeEmail ? (
            <p className={`text-xs text-center ${textFaint}`}>
              Joining as <span className="font-medium">{preview.inviteeEmail}</span> — no password needed.
            </p>
          ) : null}

          {inlineError ? (
            <div className="rounded-lg px-3 py-2 text-sm text-center bg-red-500/10 text-red-500 border border-red-500/20">
              {inlineError}
            </div>
          ) : null}
        </>
      ) : null}

      <p className={`text-xs text-center ${textFaint}`}>
        By joining you become a member of this workspace. You can leave at any time from workspace settings.
      </p>
    </div>
  );
}

function Avatar({ src, initial, isDark }: { src: string | null; initial: string; isDark: boolean }) {
  const border = isDark ? 'border-white/10' : 'border-zinc-200';
  if (src) {
    // Using next/image here would require allow-listing every inviter avatar
    // host. <img> is fine for an unauthenticated landing surface.

    return <img src={src} alt="" className={`h-16 w-16 rounded-full object-cover border ${border}`} />;
  }
  const placeholderBg = isDark ? 'bg-violet-500/20 text-violet-200' : 'bg-violet-100 text-violet-700';
  return (
    <div className={`h-16 w-16 rounded-full flex items-center justify-center text-xl font-semibold ${placeholderBg}`}>
      {initial}
    </div>
  );
}
