import { NextResponse } from 'next/server';

/**
 * GET /api/config/runtime
 *
 * Public runtime flags the client needs to render correctly.
 *
 * AUTH_DISABLED is the most important: when true, server APIs short-circuit auth
 * and return a synthetic admin user. The client must mirror this — otherwise
 * dashboard / API-key pages still gate on `isAuthenticated` and redirect to /auth.
 *
 * Self-host private deployments rely on this so users don't need to log in.
 */
export async function GET() {
  const authDisabled = process.env.AUTH_DISABLED === 'true';

  return NextResponse.json({
    authDisabled,
    defaultUser: authDisabled
      ? {
          id: 1,
          email: process.env.INIT_ADMIN_EMAIL || 'admin@localhost',
          name: 'Local Admin',
        }
      : null,
  });
}
