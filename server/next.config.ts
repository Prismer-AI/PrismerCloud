import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  output: 'standalone', // Enable for Docker deployment

  // Native Node addons that must not be bundled
  serverExternalPackages: ['@resvg/resvg-js', 'pino', 'pino-pretty'],

  // Turbopack configuration (Next.js 16+)
  turbopack: {},

  // Override default s-maxage for static pages to avoid CDN serving stale
  // content after deployments. JS/CSS chunks use content hashes and are safe
  // to cache long-term.
  async headers() {
    return [
      {
        source: '/:path((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|svg|webp|ico)).*)',
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
