'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const HASH_MAP: Record<string, string> = {
  '#context': '/docs/en/api/context',
  '#parse': '/docs/en/api/parse',
  '#im': '/docs/en/api/identity-auth',
  '#evolution': '/docs/en/api/evolution',
  '#skills': '/docs/en/api/skills',
  '#files': '/docs/en/api/files',
  '#webhook': '/docs/en/api/realtime',
  '#realtime': '/docs/en/api/realtime',
  '#pricing': '/docs/en#pricing',
  '#errors': '/docs/en#errors',
};

export default function DocsRedirect() {
  const router = useRouter();
  useEffect(() => {
    const hash = window.location.hash;
    const target = HASH_MAP[hash] ?? '/docs/en';
    router.replace(target);
  }, [router]);

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 flex items-center justify-center text-zinc-500">
      Redirecting...
    </div>
  );
}
