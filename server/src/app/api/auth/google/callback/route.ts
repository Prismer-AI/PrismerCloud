import { NextResponse } from 'next/server';
import { googleCallback } from '@/lib/auth-api';

/**
 * POST /api/auth/google/callback
 * Google OAuth callback
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { access_token } = body;

    if (!access_token) {
      return NextResponse.json(
        { error: { code: 400, msg: 'access_token is required' } },
        { status: 400 }
      );
    }

    const result = await googleCallback(access_token);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: { code: 500, msg: error.message || 'Google authentication failed' } },
      { status: 500 }
    );
  }
}









