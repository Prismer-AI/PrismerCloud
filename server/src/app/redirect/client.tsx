'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useApp } from '@/contexts/app-context';

/**
 * Client-side handler for OAuth redirects at /redirect.
 *
 * Logic:
 * - If `code` query param exists → treat as GitHub OAuth and call /api/auth/github/callback
 * - Else if URL hash contains `access_token` → treat as Google OAuth and call /api/auth/google/callback
 */
export default function RedirectClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, addToast } = useApp();

  useEffect(() => {
    const handleGitHub = async (code: string) => {
      try {
        const res = await fetch('/api/auth/github/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error?.msg || 'GitHub authentication failed');
        }

        login(data.user, data.token);
        addToast('GitHub authentication successful!', 'success');
        router.replace('/dashboard');
      } catch (error: any) {
        console.error('GitHub OAuth redirect error:', error);
        addToast(error.message || 'GitHub authentication failed', 'error');
        router.replace('/auth');
      }
    };

    const handleGoogle = async (accessToken: string) => {
      try {
        const res = await fetch('/api/auth/google/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error?.msg || 'Google authentication failed');
        }

        login(data.user, data.token);
        addToast('Google authentication successful!', 'success');
        router.replace('/dashboard');
      } catch (error: any) {
        console.error('Google OAuth redirect error:', error);
        addToast(error.message || 'Google authentication failed', 'error');
        router.replace('/auth');
      }
    };

    (async () => {
      try {
        const code = searchParams.get('code');

        if (code) {
          console.log('[OAuth][Redirect] GitHub code detected:', code);
          await handleGitHub(code);
          return;
        }

        if (typeof window !== 'undefined') {
          const hash = window.location.hash || '';
          const params = new URLSearchParams(hash.replace(/^#/, ''));
          const accessToken = params.get('access_token');

          if (accessToken) {
            console.log('[OAuth][Redirect] Google access_token detected:', accessToken.slice(0, 8) + '...');
            await handleGoogle(accessToken);
            return;
          }
        }

        addToast('Missing OAuth credentials in redirect', 'error');
        router.replace('/auth');
      } catch (e) {
        console.error('OAuth redirect error:', e);
        addToast('OAuth authentication failed', 'error');
        router.replace('/auth');
      }
    })();
  }, [searchParams, router, login, addToast]);

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-zinc-400">
        <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
        <p className="text-sm">Completing OAuth authentication...</p>
      </div>
    </div>
  );
}


