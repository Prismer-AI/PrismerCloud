import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import RedirectClient from './client';

/**
 * Unified OAuth redirect handler for both GitHub and Google.
 *
 * Redirect URIs configured in OAuth providers should be:
 * - http(s)://<host>/redirect
 *
 * GitHub will redirect with:
 *   GET /redirect?code=...&state=...
 *
 * Google (implicit flow) will redirect with:
 *   GET /redirect#access_token=...&token_type=Bearer&state=...
 */
export default function RedirectPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-6">
          <div className="flex flex-col items-center gap-4 text-zinc-400">
            <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
            <p className="text-sm">Completing OAuth authentication...</p>
          </div>
        </div>
      }
    >
      <RedirectClient />
    </Suspense>
  );
}



