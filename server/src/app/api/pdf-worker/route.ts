/**
 * GET /api/pdf-worker — serve the pdf.js worker module.
 *
 * Background: in Next.js standalone output, `.mjs` files placed under
 * `public/` are not served by the static-asset path (verified 2026-05-19
 * against test env: `/cloud.svg` 200, `/logo-dark.png` 200, but
 * `/pdf.worker.min.mjs` 404 with `x-nextjs-prerender: 1, content-type:
 * text/html`). The runner stage of the Dockerfile copies `/app/public`,
 * so the file IS present in the container — the standalone server just
 * declines to map `.mjs` to a public asset.
 *
 * Rather than rename the worker (the `.mjs` variant of pdf.js is the ESM
 * build and is loaded via `new Worker(url, { type: 'module' })`; the `.js`
 * variant is a separate classic worker), we proxy it through this route.
 * The on-disk path is the same — only the URL changes.
 *
 * Cached aggressively (immutable) because the URL embeds the pdfjs-dist
 * version (`?v=<pdfjs.version>` from `pdf-asset-preview.tsx`), so the next
 * pdfjs-dist bump produces a fresh URL automatically.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-static';
export const revalidate = false;

export async function GET(): Promise<Response> {
  try {
    const filePath = path.join(process.cwd(), 'public', 'pdf.worker.min.mjs');
    const content = await readFile(filePath);
    return new Response(content, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return new Response(
      `pdf-worker: failed to read worker file from public/ (${(err as Error).message})`,
      { status: 500, headers: { 'Content-Type': 'text/plain' } },
    );
  }
}
