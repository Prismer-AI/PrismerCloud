/**
 * Memory API client — wraps the IM router's `/memory/*` endpoints behind a
 * typed surface for the LibrarySurface Memory + Graph views.
 *
 * Cookbook: docs/cookbook/m-library-memory-readonly.md and the proposal /
 * write companions.
 */

import { imFetch, type FetchResult } from './im-api';
import type {
  KnowledgeLinkRowDTO,
  MemoryGraphEdgeDTO,
  MemoryGraphNodeDTO,
  MemoryGraphResponseDTO,
  MemoryHealthItemDTO,
  MemoryHealthResponseDTO,
  MemoryLinkRowDTO,
  MemoryPageDetailDTO,
  MemoryPageLinksDTO,
  MemoryPageSummaryDTO,
  MemoryPageVersionRowDTO,
  MemoryProposalDTO,
  MemorySearchResponseDTO,
  MemorySearchResultDTO,
  RecallTraceEventDTO,
  RecallTraceResponseDTO,
} from './types';

export interface ListMemoryPagesParams {
  workspaceId: string;
  pageType?: string;
  stale?: 'true' | 'false' | 'all';
  visibility?: string;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return entries.length ? `?${entries.join('&')}` : '';
}

export function listMemoryPages(params: ListMemoryPagesParams): Promise<FetchResult<MemoryPageSummaryDTO[]>> {
  const { signal, ...query } = params;
  return imFetch<MemoryPageSummaryDTO[]>(`/memory/pages${qs(query)}`, { signal });
}

export function getMemoryPage(
  pageId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<FetchResult<MemoryPageDetailDTO>> {
  return imFetch<MemoryPageDetailDTO>(`/memory/pages/${encodeURIComponent(pageId)}${qs({ workspaceId })}`, { signal });
}

export function getMemoryPageLinks(
  pageId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<FetchResult<MemoryPageLinksDTO>> {
  return imFetch<MemoryPageLinksDTO>(`/memory/pages/${encodeURIComponent(pageId)}/links${qs({ workspaceId })}`, {
    signal,
  });
}

export function getMemoryPageVersions(
  pageId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<FetchResult<{ versions: MemoryPageVersionRowDTO[] }>> {
  return imFetch<{ versions: MemoryPageVersionRowDTO[] }>(
    `/memory/pages/${encodeURIComponent(pageId)}/versions${qs({ workspaceId })}`,
    { signal },
  );
}

export function getMemoryPagesBySource(
  workspaceId: string,
  source: { sourceAssetId?: string; sourceRef?: string },
  signal?: AbortSignal,
): Promise<FetchResult<MemoryPageSummaryDTO[]>> {
  return imFetch<MemoryPageSummaryDTO[]>(`/memory/pages/by-source${qs({ workspaceId, ...source })}`, { signal });
}

export interface SearchMemoryParams {
  workspaceId: string;
  q: string;
  kind?: 'memory' | 'files' | 'both';
  pageType?: string;
  stale?: 'true' | 'false' | 'all';
  visibility?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function searchMemory(params: SearchMemoryParams): Promise<FetchResult<MemorySearchResponseDTO>> {
  const { signal, ...query } = params;
  return imFetch<MemorySearchResponseDTO>(`/memory/search${qs(query)}`, { signal });
}

// ── Mutations (B4) ─────────────────────────────────────────────────────────

export interface CreateMemoryPageBody {
  workspaceId: string;
  path: string;
  content: string;
  pageType?: string;
  visibility?: string;
  sourceRefs: string[];
  rationale?: string;
}

export function createMemoryPage(body: CreateMemoryPageBody): Promise<FetchResult<MemoryPageDetailDTO>> {
  return imFetch<MemoryPageDetailDTO>(`/memory/pages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function archiveMemoryPage(pageId: string, workspaceId: string): Promise<FetchResult<MemoryPageSummaryDTO>> {
  return imFetch<MemoryPageSummaryDTO>(`/memory/pages/${encodeURIComponent(pageId)}/archive${qs({ workspaceId })}`, {
    method: 'POST',
  });
}

export function unarchiveMemoryPage(pageId: string, workspaceId: string): Promise<FetchResult<MemoryPageSummaryDTO>> {
  return imFetch<MemoryPageSummaryDTO>(`/memory/pages/${encodeURIComponent(pageId)}/unarchive${qs({ workspaceId })}`, {
    method: 'POST',
  });
}

export function deleteMemoryPage(pageId: string, workspaceId: string): Promise<FetchResult<unknown>> {
  return imFetch(`/memory/pages/${encodeURIComponent(pageId)}${qs({ workspaceId })}`, { method: 'DELETE' });
}

export function changeMemoryVisibility(
  pageId: string,
  body: { workspaceId: string; visibility: string; reason?: string },
  ifMatchVersion?: number,
): Promise<FetchResult<MemoryPageSummaryDTO>> {
  return imFetch<MemoryPageSummaryDTO>(`/memory/pages/${encodeURIComponent(pageId)}/visibility`, {
    method: 'PATCH',
    headers: ifMatchVersion !== undefined ? { 'If-Match': `W/"${ifMatchVersion}"` } : undefined,
    body: JSON.stringify(body),
  });
}

export function promoteMemoryPage(
  pageId: string,
  body: { workspaceId: string; to?: string },
  ifMatchVersion?: number,
): Promise<FetchResult<MemoryPageSummaryDTO>> {
  return imFetch<MemoryPageSummaryDTO>(`/memory/pages/${encodeURIComponent(pageId)}/promote`, {
    method: 'POST',
    headers: ifMatchVersion !== undefined ? { 'If-Match': `W/"${ifMatchVersion}"` } : undefined,
    body: JSON.stringify(body),
  });
}

// ── Graph + Health (B6) ────────────────────────────────────────────────────

export interface GetMemoryGraphParams {
  workspaceId: string;
  rootId?: string;
  depth?: number;
  signal?: AbortSignal;
}

export function getMemoryGraph(params: GetMemoryGraphParams): Promise<FetchResult<MemoryGraphResponseDTO>> {
  const { signal, ...query } = params;
  return imFetch<MemoryGraphResponseDTO>(`/memory/graph${qs(query)}`, { signal });
}

export type MemoryHealthKind = 'broken-links' | 'stale' | 'duplicates' | 'orphans';

export function getMemoryHealth(
  kind: MemoryHealthKind,
  workspaceId: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<FetchResult<MemoryHealthResponseDTO>> {
  return imFetch<MemoryHealthResponseDTO>(`/memory/health/${kind}${qs({ workspaceId, limit })}`, { signal });
}

export function toggleMemoryStale(
  pageId: string,
  body: { workspaceId: string; stale: boolean; reason?: string },
): Promise<FetchResult<MemoryPageSummaryDTO>> {
  return imFetch<MemoryPageSummaryDTO>(`/memory/pages/${encodeURIComponent(pageId)}/stale`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// Re-export the types so callers can import everything memory-related from one
// module without reaching into ./types.
export type {
  KnowledgeLinkRowDTO,
  MemoryGraphEdgeDTO,
  MemoryGraphNodeDTO,
  MemoryGraphResponseDTO,
  MemoryHealthItemDTO,
  MemoryHealthResponseDTO,
  MemoryLinkRowDTO,
  MemoryPageDetailDTO,
  MemoryPageLinksDTO,
  MemoryPageSummaryDTO,
  MemoryPageVersionRowDTO,
  MemoryProposalDTO,
  MemorySearchResponseDTO,
  MemorySearchResultDTO,
  RecallTraceEventDTO,
  RecallTraceResponseDTO,
};

// ── Proposal review (B7) ───────────────────────────────────────────────────

export interface ListProposalsParams {
  workspaceId: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  sessionId?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function listProposals(params: ListProposalsParams): Promise<FetchResult<MemoryProposalDTO[]>> {
  const { signal, ...query } = params;
  return imFetch<MemoryProposalDTO[]>(`/memory/proposals${qs(query)}`, { signal });
}

export function approveProposal(proposalId: string, workspaceId: string): Promise<FetchResult<unknown>> {
  return imFetch(`/memory/proposals/${encodeURIComponent(proposalId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

export function rejectProposal(
  proposalId: string,
  body: { workspaceId: string; reason: string },
): Promise<FetchResult<unknown>> {
  return imFetch(`/memory/proposals/${encodeURIComponent(proposalId)}/reject`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function bulkApproveProposals(body: { workspaceId: string; sessionId?: string }): Promise<
  FetchResult<{
    approved: string[];
    skipped: Array<{ id: string; reason: string; currentVersion?: number }>;
  }>
> {
  return imFetch(`/memory/proposals/bulk-approve`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Recall trace (B7) ──────────────────────────────────────────────────────

export interface RecallTraceParams {
  workspaceId: string;
  sessionId?: string;
  agentImUserId?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function getRecallTrace(params: RecallTraceParams): Promise<FetchResult<RecallTraceResponseDTO>> {
  const { signal, ...query } = params;
  return imFetch<RecallTraceResponseDTO>(`/memory/observability/recall-trace${qs(query)}`, { signal });
}
