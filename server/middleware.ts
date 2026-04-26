/**
 * Next.js Edge Middleware — X-Request-Id injection (G3 v1.8.2)
 *
 * Adds a unique request ID to all API route responses for traceability.
 * If the client sends X-Request-Id, it is preserved; otherwise a new UUID is generated.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();

  const response = NextResponse.next();
  response.headers.set('x-request-id', requestId);
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
