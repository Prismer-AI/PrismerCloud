/**
 * AIP Layer 6: Revocation Registry Endpoint
 *
 * GET /.well-known/revocations/:listId
 *
 * Returns a W3C Bitstring Status List Credential.
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ listId: string }> }) {
  try {
    const { listId } = await params;

    const { RevocationService } = await import('@/im/services/revocation.service');
    const { IdentityService } = await import('@/im/services/identity.service');

    const revocationService = new RevocationService();
    const identityService = new IdentityService();
    const serverDid = identityService.getServerDID();

    const statusList = await revocationService.buildStatusList(listId, serverDid);

    return NextResponse.json(statusList, {
      headers: {
        'Content-Type': 'application/ld+json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error: any) {
    console.error('[Revocation] Error building status list:', error.message);
    return NextResponse.json(
      { error: 'internal_error', message: 'Failed to build revocation status list' },
      { status: 500 },
    );
  }
}
