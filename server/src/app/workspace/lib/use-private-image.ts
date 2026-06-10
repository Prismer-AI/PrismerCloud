'use client';

/**
 * `usePrivateImage` — turn an `/api/im/assets/{id}` URL into a browser-
 * usable blob URL.
 *
 * The asset bytes endpoint requires an `Authorization: Bearer …` header,
 * which `<img src=…>` can't attach (browser only sends cookies / no auth
 * for image loads). This hook does the auth fetch, creates a blob URL,
 * and revokes it on unmount.
 *
 * External URLs (CDN, https://…) are passed through unchanged — no fetch,
 * no blob — since the browser can load them directly. `null` input is
 * also passed through (caller decides what to render in the empty case).
 *
 * Each card mount issues its own fetch; no shared cache. That's fine at
 * current scale (≤ a few dozen visible thumbnails per page) but is the
 * obvious extension point if a workspace ever paginates hundreds of PDFs
 * on screen at once.
 */

import { useEffect, useState } from 'react';
import { getWorkspaceToken } from './im-api';

/** True iff the URL hits the private IM bytes endpoint and needs a Bearer token. */
export function isPrivateAssetUrl(url: string): boolean {
  return url.startsWith('/api/im/assets/');
}

export function usePrivateImage(url: string | null | undefined): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    // Reset on dep change so stale blob URLs from a previous asset never
    // leak into the next render.
    setObjectUrl(null);
    if (!url) return;
    if (!isPrivateAssetUrl(url)) return; // external URL → caller uses it as-is

    const token = getWorkspaceToken();
    if (!token) return;

    const controller = new AbortController();
    let activeObjectUrl: string | null = null;

    void (async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const blob = await res.blob();
        // Be defensive: only mint a blob URL when the server actually
        // returned an image. Avoids broken-image icons on edge cases where
        // the endpoint returned JSON / HTML / a redirect.
        if (!blob.type.startsWith('image/')) return;
        const next = URL.createObjectURL(blob);
        if (!controller.signal.aborted) {
          activeObjectUrl = next;
          setObjectUrl(next);
        } else {
          URL.revokeObjectURL(next);
        }
      } catch {
        /* Non-fatal: caller renders a fallback (icon / empty box). */
      }
    })();

    return () => {
      controller.abort();
      if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    };
  }, [url]);

  return objectUrl;
}
