import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  output: 'standalone', // Enable for Docker deployment

  // Native Node addons that must not be bundled. Keep react-pdf bundled so
  // its CSS imports from app/layout can be processed by Next/Turbopack.
  // `@napi-rs/canvas` is a NATIVE module that pdfjs-dist/pdf-parse load
  // DYNAMICALLY to obtain DOMMatrix/Path2D/ImageData in Node. Without it in
  // serverExternalPackages the standalone trace dropped it → DOMMatrix undefined
  // on prod pods → server-side PDF text extraction crashed (worked LOCALLY only
  // because the transitive copy sat in node_modules). Keep it external + copied.
  serverExternalPackages: ['@resvg/resvg-js', 'pino', 'pino-pretty', 'pdfjs-dist', '@napi-rs/canvas'],

  // Asset blobs are runtime data, not deployable code. Excluding the shard
  // directory keeps standalone output tracing from walking thousands of
  // content-addressed files when src/im/api/assets.ts builds dynamic paths.
  outputFileTracingExcludes: {
    '*': ['./prisma/data/assets/**/*'],
  },

  // pdf-parse's pdfjs worker is loaded by a runtime PATH string (PDFParse.setWorker),
  // not a static import, so the standalone trace never copies it. Force-include it
  // (and the napi canvas binary) so server-side PDF text extraction works on the pods.
  outputFileTracingIncludes: {
    '*': ['./node_modules/pdf-parse/dist/worker/**', './node_modules/@napi-rs/canvas/**'],
  },

  // Turbopack configuration (Next.js 16+)
  turbopack: {},

  // Override default s-maxage for static pages to avoid CDN serving stale
  // content after deployments. JS/CSS chunks use content hashes and are safe
  // to cache long-term. The negative lookahead now also excludes `api/` —
  // before this exclusion, dynamic IM endpoints (e.g. `/api/im/messages/:cid`)
  // inherited `public, s-maxage=60, stale-while-revalidate=300`, and a fresh
  // conversation's first GET (returning `data:[]` because no message had been
  // posted yet) was served from cache to subsequent reads — surfacing as
  // "messages don't persist across page reload" in the /workspace UI.
  async headers() {
    return [
      {
        source: '/:path((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|svg|webp|ico)).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=60, stale-while-revalidate=300',
          },
        ],
      },
    ];
  },

  // Redirect /docs to /docs/en (default locale)
  async redirects() {
    return [
      {
        source: '/docs',
        destination: '/docs/en',
        permanent: true,
      },
    ];
  },

  // URL rewrites for API versioning
  // Allows both /api/v1/* and /api/* to work
  async rewrites() {
    return [
      // Rewrite /api/v1/* to /api/*
      {
        source: '/api/v1/:path*',
        destination: '/api/:path*',
      },
    ];
  },
};

export default nextConfig;
