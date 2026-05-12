import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  output: 'standalone', // Enable for Docker deployment

  // Native Node addons that must not be bundled.
  //
  // pdfjs-dist and react-pdf reference DOMMatrix / Path2D at module top
  // level; including them in the server chunk crashes the IM bootstrap
  // on Node (no DOM polyfills, @napi-rs/canvas not installed). They are
  // only used inside workspace-inspector-dialog which is loaded with
  // dynamic({ ssr: false }), so externalize them — Next.js standalone
  // will require() them lazily, and the server never hits the code.
  serverExternalPackages: ['@resvg/resvg-js', 'pino', 'pino-pretty', 'pdfjs-dist', 'react-pdf'],

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
