/**
 * Evolution Sub-module: Public Genes Cache state.
 *
 * Extracted so that `evolution-lifecycle.ts` can invalidate the cache after
 * publish/unpublish/import/delete WITHOUT importing from `evolution-public.ts`
 * (which would re-create the lifecycle ↔ public circular dependency).
 *
 * `evolution-public.ts` owns the read/write side via `getPublicGenesCache` /
 * `setPublicGenesCache`; `evolution-lifecycle.ts` only needs
 * `invalidatePublicGenesCache`.
 */

import type { PrismerGene } from '../types/index';

export interface PublicGenesCacheEntry {
  genes: PrismerGene[];
  stats: Map<string, { success_count: number; failure_count: number }>;
  ts: number;
}

let _publicGenesCache: PublicGenesCacheEntry | null = null;

export function getPublicGenesCache(): PublicGenesCacheEntry | null {
  return _publicGenesCache;
}

export function setPublicGenesCache(entry: PublicGenesCacheEntry): void {
  _publicGenesCache = entry;
}

/** Invalidate cache — call after publish/unpublish/import/delete */
export function invalidatePublicGenesCache(): void {
  _publicGenesCache = null;
}
