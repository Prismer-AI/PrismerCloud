import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Returns system health and service configuration status.
 * No authentication required.
 */
export async function GET() {
  const startTime = Date.now();

  const services = {
    search: !!process.env.EXASEARCH_API_KEY,
    compress: !!process.env.OPENAI_API_KEY,
    parse: !!process.env.PARSER_API_URL,
    im: process.env.IM_SERVER_ENABLED !== 'false',
    s3: !!(process.env.AWS_S3_BUCKET && process.env.AWS_S3_ACCESS_KEY_ID),
    smtp: !!process.env.SMTP_HOST,
    oauth_github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    oauth_google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    stripe: !!process.env.STRIPE_SECRET_KEY,
  };

  const unconfigured = Object.entries(services)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  return NextResponse.json({
    status: 'ok',
    version: process.env.npm_package_version || '1.7.2',
    uptime: Math.floor(process.uptime()),
    services,
    hints: unconfigured.length > 0
      ? `Optional services not configured: ${unconfigured.join(', ')}. See docs/SELF-HOST.md`
      : undefined,
    responseTime: Date.now() - startTime,
  });
}
