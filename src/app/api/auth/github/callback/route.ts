import { NextResponse } from 'next/server';
import { githubCallback } from '@/lib/auth-api';

/**
 * POST /api/auth/github/callback
 * GitHub OAuth callback
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { code } = body;

    if (!code) {
      return NextResponse.json(
        { error: { code: 400, msg: 'code is required' } },
        { status: 400 }
      );
    }

    const result = await githubCallback(code);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: { code: 500, msg: error.message || 'GitHub authentication failed' } },
      { status: 500 }
    );
  }
}









