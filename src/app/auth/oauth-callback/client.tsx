'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useApp } from '@/contexts/app-context';

/**
 * Client-side OAuth callback handler for GitHub and Google.
 * Wrapped by a Suspense boundary in `page.tsx`.
 */
export default function OAuthCallbackClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, addToast } = useApp();

  useEffect(() => {
    const provider = searchParams.get('provider');

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
        console.error('GitHub OAuth callback error:', error);
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
        console.error('Google OAuth callback error:', error);
        addToast(error.message || 'Google authentication failed', 'error');
        router.replace('/auth');
      }
    };

    // Kick off processing once on mount
    (async () => {
      try {
        if (!provider) {
          addToast('Missing OAuth provider', 'error');
          router.replace('/auth');
          return;
        }

        if (provider === 'github') {
          const code = searchParams.get('code');
          if (!code) {
            addToast('Missing GitHub code', 'error');
            router.replace('/auth');
            return;
          }
          await handleGitHub(code);
          return;
        }

        if (provider === 'google') {
          // access_token is returned in the URL hash for implicit flow
          let accessToken: string | null = null;
          if (typeof window !== 'undefined') {
            const hash = window.location.hash || '';
            const params = new URLSearchParams(hash.replace(/^#/, ''));
            accessToken = params.get('access_token');
          }

          if (!accessToken) {
            addToast('Missing Google access token', 'error');
            router.replace('/auth');
            return;
          }

          await handleGoogle(accessToken);
          return;
        }

        addToast('Unsupported OAuth provider', 'error');
        router.replace('/auth');
      } catch (e) {
        console.error('OAuth callback error:', e);
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










