import { NextResponse } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * GET /api/config/oauth
 *
 * Public OAuth configuration used by the frontend:
 * - GitHub OAuth client ID
 * - Google OAuth client ID
 *
 * Values are loaded from:
 * - Nacos (primary, via ensureNacosConfig)
 * - process.env (fallback)
 */
export async function GET() {
  // Ensure Nacos config is loaded so process.env is populated
  await ensureNacosConfig();

  const githubClientId =
    process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ||
    process.env.GITHUB_CLIENT_ID ||
    null;

  const googleClientId =
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID ||
    null;

  return NextResponse.json({
    githubClientId,
    googleClientId,
  });
}










