/**
 * Prisma Client Singleton
 *
 * Dynamic provider selection:
 * - SQLite (dev): DATABASE_URL starts with "file:" → uses default @prisma/client
 * - MySQL (test/prod): DATABASE_URL starts with "mysql://" → uses prisma/generated/mysql
 *
 * Both clients export the same API surface (same model names).
 */

const globalForPrisma = globalThis as unknown as {
  prisma: any | undefined;
};

function isMySQL(): boolean {
  const url = process.env.DATABASE_URL || '';
  return url.startsWith('mysql://');
}

function createPrismaClient(): any {
  if (isMySQL()) {
    // MySQL client generated from prisma/schema.mysql.prisma

    const { PrismaClient } = require('../../prisma/generated/mysql');
    console.log('[Prisma] Using MySQL client');
    return new PrismaClient({
      log: ['error'],
    });
  }

  // Default SQLite client from @prisma/client

  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient({
    log: ['error', 'warn'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
