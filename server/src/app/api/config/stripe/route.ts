import { NextResponse } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('StripeConfig');

/**
 * GET /api/config/stripe
 * Returns Stripe publishable key for frontend use
 */
export async function GET() {
  try {
    await ensureNacosConfig();

    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

    if (!publishableKey) {
      return NextResponse.json(
        {
          success: false,
          error: { message: 'Stripe not configured' },
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        publishable_key: publishableKey,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Error loading Stripe config');
    return NextResponse.json(
      {
        success: false,
        error: { message: 'Failed to load Stripe config' },
      },
      { status: 500 },
    );
  }
}
