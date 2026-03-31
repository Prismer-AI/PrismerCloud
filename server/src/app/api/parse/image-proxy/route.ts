import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_ORIGINS = (process.env.IMAGE_PROXY_ORIGINS || 'localhost').split(',').map(s => s.trim());

/**
 * GET /api/parse/image-proxy?url=<encoded-image-url>
 *
 * Proxies parser/CDN image URLs so the browser can load them same-origin.
 * Avoids CORS or "image cannot be accessed" when Parse result images
 * point to CDN or parser service.
 *
 * Only allows URLs from ALLOWED_ORIGINS. No auth required (URL is opaque).
 */
export async function GET(request: NextRequest) {
  const urlParam = request.nextUrl.searchParams.get('url');
  if (!urlParam) {
    return NextResponse.json(
      { success: false, error: { code: 'MISSING_URL', message: 'Query param url is required' } },
      { status: 400 }
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(decodeURIComponent(urlParam));
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_URL', message: 'Invalid url parameter' } },
      { status: 400 }
    );
  }

  const host = targetUrl.hostname.toLowerCase();
  const allowed = ALLOWED_ORIGINS.some(
    (origin) => host === origin || host.endsWith('.' + origin)
  );
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: { code: 'URL_NOT_ALLOWED', message: 'Image URL must be from allowed parser/CDN host' } },
      { status: 403 }
    );
  }

  try {
    const res = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: { 'Accept': 'image/*' },
      next: { revalidate: 3600 }
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: { code: 'UPSTREAM_ERROR', message: `Upstream returned ${res.status}` } },
        { status: res.status }
      );
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = await res.arrayBuffer();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err) {
    console.error('[Parse image-proxy] Fetch failed:', err);
    return NextResponse.json(
      { success: false, error: { code: 'FETCH_FAILED', message: 'Failed to fetch image' } },
      { status: 502 }
    );
  }
}
