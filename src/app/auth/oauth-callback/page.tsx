import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import OAuthCallbackClient from './client';

export default function OAuthCallbackPage() {
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
      <OAuthCallbackClient />
    </Suspense>
  );
}



