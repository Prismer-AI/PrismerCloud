// Local TS types for the daemon memory module.
//
// Distinct from envelope.ts: types here can evolve freely (they are
// in-process); envelope.ts schemas are FROZEN as the cross-process wire
// contract per doc 18 §C4. Cloud mirror tables (im_memory_pages etc.) have
// their own Prisma model — bridged via memory.page.upsert envelope on the
// outbox, not via a shared TS type.

export type MemoryPageType = 'hub' | 'leaf' | 'decision' | 'glossary' | 'archive';

export type MemoryVisibility =
  | { kind: 'workspace' }
  | { kind: 'agent'; imUserId: string }
  | { kind: 'private'; imUserId: string };

export type ActorKind = 'human' | 'agent';

export type MemorySyncStatus = 'local-only' | 'pending' | 'acked' | 'remote-conflict';

export interface MemoryPage {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  description: string | null;
  contentHash: string;
  version: number;
  pageType: MemoryPageType;
  visibility: MemoryVisibility;
  encrypted: boolean;
  stale: boolean;
  archivedAt: number | null;
  sourceAssetId: string | null;
  sourceRefs: string[];
  syncStatus: MemorySyncStatus;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPageContent {
  pageId: string;
  version: number;
  content: string;
}

export interface MemoryLink {
  sourceUri: string;
  targetUri: string;
  relation: string;
  weight: number;
  extractedFromPageId: string | null;
}

export interface MemorySearchResult {
  pageId: string;
  path: string;
  title: string | null;
  snippet: string;
  score: number;
  tokenCount: number;
}

export interface MemorySearchOptions {
  topK?: number;
  relevanceThreshold?: number;
  maxBytes?: number;
  pageType?: MemoryPageType[];
}

export interface MemoryWriteInput {
  workspaceId: string;
  path: string;
  content: string;
  pageType?: MemoryPageType;
  title?: string;
  description?: string;
  visibility?: MemoryVisibility;
  sourceAssetId?: string;
  sourceRefs?: string[];
  stale?: boolean;
  actorImUserId: string;
  actorKind: ActorKind;
}

export interface MemoryStats {
  workspaceId: string | null;
  pageCount: number;
  pendingOutbox: number;
  deadLetterCount: number;
  lastSyncAt: number | null;
  dbPath: string;
}
