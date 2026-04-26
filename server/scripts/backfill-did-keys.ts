/**
 * Backfill script: Compute didKey + DID Document for existing identity keys.
 *
 * Usage:
 *   DATABASE_URL="file:./prisma/data/dev.db" npx tsx scripts/backfill-did-keys.ts
 *   DATABASE_URL="mysql://..." npx tsx scripts/backfill-did-keys.ts
 *
 * Safe to run multiple times — only processes keys where didKey IS NULL.
 */

import { publicKeyToDIDKey } from '../src/im/crypto';
import { buildDIDDocument, hashDIDDocument } from '../src/im/services/did.service';

// Dynamic Prisma client selection: MySQL client for mysql://, default (SQLite) otherwise
const dbUrl = process.env.DATABASE_URL ?? '';
const { PrismaClient } = dbUrl.startsWith('mysql://')
  ? await import('../prisma/generated/mysql')
  : await import('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // Find all identity keys without a DID
  const keysWithoutDid = await prisma.iMIdentityKey.findMany({
    where: { didKey: null, revokedAt: null },
  });

  console.log(`[Backfill] Found ${keysWithoutDid.length} identity keys without DID`);

  if (keysWithoutDid.length === 0) {
    console.log('[Backfill] Nothing to do — all keys already have DIDs');
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const key of keysWithoutDid) {
    try {
      const didKey = publicKeyToDIDKey(key.publicKey);
      const didDoc = buildDIDDocument({ publicKeyBase64: key.publicKey });
      const didDocJson = JSON.stringify(didDoc);
      const didDocHash = hashDIDDocument(didDoc);

      await prisma.$transaction([
        prisma.iMIdentityKey.update({
          where: { id: key.id },
          data: { didKey, didDocument: didDocJson, didDocumentHash: didDocHash },
        }),
        // Also update user's primaryDid if not set
        prisma.iMUser.updateMany({
          where: { id: key.imUserId, primaryDid: null },
          data: { primaryDid: didKey },
        }),
      ]);

      updated++;
      console.log(`[Backfill] ✅ ${key.imUserId} → ${didKey}`);
    } catch (err) {
      failed++;
      console.error(`[Backfill] ❌ ${key.imUserId}: ${(err as Error).message}`);
    }
  }

  console.log(`\n[Backfill] Complete: ${updated} updated, ${failed} failed, ${keysWithoutDid.length} total`);
}

main()
  .catch((err) => {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
