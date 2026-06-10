/**
 * Project API client for the workspace surface — release201/09 Phase 1.
 *
 * Phase 1 不接入任何已有资源 list endpoint (im_tasks.project_id 在 Phase 2 才加列).
 * 本文件仅负责 project CRUD + membership 调用.
 */

import { imFetch } from './im-api';

export type ProjectStatus = 'active' | 'archived';
export type ProjectMembershipRole = 'owner' | 'contributor' | 'observer';
export type ProjectPrincipalKind = 'user' | 'agent';
export type ProjectDeleteCascade = 'archive' | 'null' | 'hard';

export interface ProjectDTO {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  ownerUserId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectWithCountsDTO extends ProjectDTO {
  memberCount: number;
}

export interface ProjectMembershipDTO {
  id: string;
  projectId: string;
  principalKind: ProjectPrincipalKind;
  principalId: string;
  role: ProjectMembershipRole;
  joinedAt: string;
}

export interface ProjectListResult {
  items: ProjectWithCountsDTO[];
  total: number;
}

/**
 * Cascade report — service-side count of resources affected by cascade=null.
 * release201/09 §4.4 + §15.1 Phase 4. v2.0.7 only `taskUnscoped` is non-zero
 * (im_tasks.project_id 是唯一已加列的关联表); conversation / asset / memory
 * 列推 v2.0.8 / v2.1+.
 */
export interface ProjectCascadeReport {
  taskUnscoped: number;
  conversationUnscoped: number;
  assetUnscoped: number;
  memoryUnscoped: number;
}

export interface ProjectDeleteResult {
  project: ProjectDTO;
  cascade: ProjectDeleteCascade;
  cascadeReport: ProjectCascadeReport;
}

export async function listProjects(params: {
  workspaceId: string;
  status?: ProjectStatus;
  search?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}) {
  const qs = new URLSearchParams({ workspaceId: params.workspaceId });
  if (params.status) qs.set('status', params.status);
  if (params.search) qs.set('search', params.search);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  return imFetch<ProjectListResult>(`/projects?${qs.toString()}`, { signal: params.signal });
}

export async function createProject(body: {
  workspaceId: string;
  slug: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return imFetch<ProjectDTO>('/projects', { method: 'POST', body: JSON.stringify(body) });
}

export async function getProject(projectId: string, signal?: AbortSignal) {
  return imFetch<ProjectWithCountsDTO>(`/projects/${encodeURIComponent(projectId)}`, { signal });
}

export async function updateProject(
  projectId: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: ProjectStatus;
    metadata?: Record<string, unknown>;
  },
) {
  return imFetch<ProjectDTO>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteProject(projectId: string, opts: { cascade?: ProjectDeleteCascade } = {}) {
  const qs = new URLSearchParams();
  if (opts.cascade) qs.set('cascade', opts.cascade);
  const tail = qs.toString();
  return imFetch<ProjectDeleteResult>(`/projects/${encodeURIComponent(projectId)}${tail ? `?${tail}` : ''}`, {
    method: 'DELETE',
  });
}

export async function listProjectMembers(projectId: string, signal?: AbortSignal) {
  return imFetch<ProjectMembershipDTO[]>(`/projects/${encodeURIComponent(projectId)}/members`, { signal });
}

// release201/09 Phase 4 (S31 C) — single-roundtrip overview payload for the
// project overview drawer (4 tabs: Tasks / Conversations / Agents / Settings).
//
// v2.0.7 only `taskStats` + `recentTasks` + `agentCount` are populated;
// conversationCount is always 0 (IMConversation.projectId arrives in v2.0.8 /
// 09 §10.2 Phase 5). The `deferred` flags surface that gap to the UI without
// forcing the client to hard-code version strings.
export interface ProjectOverviewTaskRow {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  currentPhase: string | null;
  updatedAt: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ProjectOverviewTaskStats {
  open: number;
  running: number;
  review: number;
  completed: number;
  failed: number;
  total: number;
}

export interface ProjectOverviewDTO {
  project: ProjectWithCountsDTO;
  taskStats: ProjectOverviewTaskStats;
  recentTasks: ProjectOverviewTaskRow[];
  memberCount: number;
  agentCount: number;
  conversationCount: number;
  deferred: {
    conversations: boolean;
    assets: boolean;
    memory: boolean;
  };
}

export async function getProjectOverview(projectId: string, signal?: AbortSignal) {
  return imFetch<ProjectOverviewDTO>(`/projects/${encodeURIComponent(projectId)}/overview`, { signal });
}

export async function addProjectMember(
  projectId: string,
  body: { principalKind: ProjectPrincipalKind; principalId: string; role?: ProjectMembershipRole },
) {
  return imFetch<ProjectMembershipDTO>(`/projects/${encodeURIComponent(projectId)}/members`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateProjectMember(
  projectId: string,
  membershipId: string,
  body: { role: ProjectMembershipRole },
) {
  return imFetch<ProjectMembershipDTO>(
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(membershipId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

export async function removeProjectMember(projectId: string, membershipId: string) {
  return imFetch<void>(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(membershipId)}`, {
    method: 'DELETE',
  });
}

// ── ProjectSwitcher sentinels (09 §4.2) ───────────────────────────────────
//
// URL ?project= + localStorage 'prismer_active_project_<wsId>' 三种取值:
//   - undefined / '' / 'all' / null  → "All" (含 NULL projectId + 所有 project)
//   - '__unscoped'                  → "Unscoped" (仅 NULL projectId)
//   - <具体 id>                      → 单 project
//
// 注意: localStorage 把 'all' 持久化, 跨 session 还原选中状态.
export const PROJECT_FILTER_ALL = 'all' as const;
export const PROJECT_FILTER_UNSCOPED = '__unscoped' as const;
export type ProjectFilter = typeof PROJECT_FILTER_ALL | typeof PROJECT_FILTER_UNSCOPED | string;

export function activeProjectStorageKey(workspaceId: string): string {
  return `prismer_active_project_${workspaceId}`;
}

export function readActiveProjectFromStorage(workspaceId: string): ProjectFilter | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(activeProjectStorageKey(workspaceId));
    return v && v.length > 0 ? (v as ProjectFilter) : null;
  } catch {
    return null;
  }
}

export function writeActiveProjectToStorage(workspaceId: string, filter: ProjectFilter): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(activeProjectStorageKey(workspaceId), filter);
  } catch {
    /* localStorage full / disabled — drop silently, will fall back to default on next mount */
  }
}
