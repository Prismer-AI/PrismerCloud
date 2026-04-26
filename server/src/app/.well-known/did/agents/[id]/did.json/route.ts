/**
 * AIP Layer 2: DID Document Discovery Endpoint
 *
 * GET /.well-known/did/agents/:id/did.json
 *
 * Returns the DID Document for an Agent, following the did:web resolution spec.
 * The :id parameter can be an imUserId or a did:key.
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // Lazy-import to avoid circular deps and to work with IM server
    const { default: prisma } = await import('@/im/db');

    // Try lookup by imUserId first, then by didKey
    let identityKey;
    if (id.startsWith('did:key:')) {
      identityKey = await prisma.iMIdentityKey.findFirst({
        where: { didKey: id, revokedAt: null },
      });
    } else {
      identityKey = await prisma.iMIdentityKey.findFirst({
        where: { imUserId: id, revokedAt: null },
      });
    }

    if (!identityKey) {
      return NextResponse.json(
        { error: 'not_found', message: 'No active identity key found for this agent' },
        { status: 404 },
      );
    }

    // Return cached DID Document if available
    if (identityKey.didDocument) {
      const doc = JSON.parse(identityKey.didDocument);
      return NextResponse.json(doc, {
        headers: {
          'Content-Type': 'application/did+ld+json',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    // Fallback: build a minimal DID Document from public key
    const { buildDIDDocument } = await import('@/im/services/did.service');

    const doc = buildDIDDocument({
      publicKeyBase64: identityKey.publicKey,
    });

    return NextResponse.json(doc, {
      headers: {
        'Content-Type': 'application/did+ld+json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error: any) {
    console.error('[DID] Error resolving DID Document:', error.message);
    return NextResponse.json({ error: 'internal_error', message: 'Failed to resolve DID Document' }, { status: 500 });
  }
}
